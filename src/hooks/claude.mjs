#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  assertInsideDir,
  getProjectMemoryDir,
  hasProjectMemoryDir,
  isMainModule,
  isProjectEnabled,
  isProjectTrusted,
  isValidId,
  loadConfig,
  projectPathKey,
  resolveProjectRoot,
} from '../core/config.mjs';
import { CortexStore } from '../core/store.mjs';
import { fitOverviewToBudget, sanitizeInline } from '../core/budget.mjs';
import { formatProjectNotApprovedNotice } from '../core/trust.mjs';
import {
  FILE_WRITE_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  cortexToolBaseName,
  isCortexToolName,
} from './tool-names.mjs';
import {
  extractCwd,
  isSubagentPayload,
  isValidTerminalId,
  recordSession,
  resolveCortexGlobalDir,
} from '../revive/tracker.mjs';
import { drainInbox, formatInboxForHookDetailed } from '../relay/inbox.mjs';
import { extractClaudeRecentTurns } from './recent-turns.mjs';

export const CLAUDE_HOOK_MAX_CHARS = 9000;

export const COMPACT_POINTER_INSTRUCTION =
  '[herdr-cortex] Compaction pointer: do not write a long lossy summary; active decisions, todos, and the last 5 verbatim turns will be restored automatically on SessionStart via cortex memory.';

export const SUBAGENT_CORTEX_WRITE_DENY_REASON =
  'Canonical memory and relay write operations are restricted to the main HEAD conversation; subagents have read-only access.';

export const SUBAGENT_MEMORY_DIR_DENY_REASON =
  '[herdr-cortex] Subagents must not read or change files under a .memory/ folder directly. '
  + 'Hand your results back to the main conversation; it records memory through the memory tools.';

const WRITE_PROTECTED_CORTEX_TOOLS = new Set([
  'memory_save',
  'memory_update',
  'relay_send',
]);

// Tools that write documents into a project tier and accept `project_dir`.
const PROJECT_WRITE_CORTEX_TOOLS = new Set([
  'memory_save',
  'memory_update',
]);

const FILE_WRITE_TOOLS = new Set(FILE_WRITE_TOOL_NAMES);
const SHELL_TOOLS = new Set(SHELL_TOOL_NAMES);

function isWriteProtectedCortexCall(toolName, rawInput = {}) {
  const base = cortexToolBaseName(toolName);
  if (WRITE_PROTECTED_CORTEX_TOOLS.has(base)) return true;
  if (base === 'relay_inbox') {
    const action = String(rawInput?.action || 'peek').trim().toLowerCase();
    return action === 'ack';
  }
  return false;
}

export { isCortexToolName };

// Windows ignores trailing dots and spaces in a file name, so ".memory." and ".memory " name the same folder.
function isMemoryDirSegment(segment) {
  return segment.replace(/[. ]+$/, '').toLowerCase() === '.memory';
}

function hasMemoryDirSegment(filePath) {
  return String(filePath).split(/[\\/]+/).some((segment) => isMemoryDirSegment(segment));
}

/**
 * True when `targetPath` (relative paths are resolved against `cwd`) lies in or under a folder named
 * `.memory` (case-insensitive), in any project. Checked on the path as written and on its real path,
 * so a junction or symlink pointing into `.memory/` counts as well.
 */
export function isPathInsideMemoryDir(targetPath, cwd = process.cwd()) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return false;
  const resolved = path.resolve(cwd || process.cwd(), targetPath.trim());
  if (hasMemoryDirSegment(resolved)) return true;
  try {
    return hasMemoryDirSegment(projectPathKey(resolved));
  } catch {
    return false;
  }
}

// `.memory` as a whole path segment: preceded by the start of the string, whitespace, a quote, a path
// separator or shell punctuation, and followed by the end of the string or one of the same (trailing dots
// are tolerated, see isMemoryDirSegment). "my.memory.txt" and "notes.memory.md" do not match.
const SHELL_MEMORY_DIR_RE = /(?:^|[\s"'`\\/=:;|&<>(){}[\],])\.memory\.*(?=$|[\s"'`\\/:;|&<>(){}[\],*])/i;

/**
 * Heuristic: does a shell command line mention a `.memory` folder? It is a string match, so it cannot tell
 * reading from writing and can be defeated by building the name at run time.
 */
export function commandReferencesMemoryDir(command) {
  return typeof command === 'string' && SHELL_MEMORY_DIR_RE.test(command);
}

function readHeadCore(promptsDir, config) {
  if (config.headCoreEnabled === false) return '';
  const corePath = path.join(promptsDir, 'HEAD_CORE.md');
  try {
    if (!fs.existsSync(corePath)) return '';
    return fs.readFileSync(corePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function hasAnyOverviewItems(ov) {
  if (!ov) return false;
  return (
    (ov.p0Baselines?.length || 0) > 0
    || (ov.sessions?.length || 0) > 0
    || (ov.todos?.length || 0) > 0
    || (ov.decisions?.length || 0) > 0
    || (ov.recentWork?.length || 0) > 0
    || (ov.globalPreferences?.length || 0) > 0
  );
}

// An unapproved project is treated like a folder without `.memory/`: only the global tier is read.
function loadOverviewSafely({ projectDir, globalDir, config, projectTrusted }) {
  const projectMemExists = projectTrusted && fs.existsSync(getProjectMemoryDir(projectDir));
  const globalDocsExists = fs.existsSync(path.join(globalDir, 'docs'));
  if (!projectMemExists && !globalDocsExists) {
    return null;
  }

  const store = new CortexStore({
    projectDir,
    globalDir,
    config,
    disableVec: true,
  });

  try {
    if (projectMemExists) {
      const ov = store.getOverview({ includeGlobal: globalDocsExists });
      return hasAnyOverviewItems(ov) ? ov : null;
    }

    // Avoid creating <project>/.memory in directories that don't use cortex yet
    const globalTier = store.getTier('global');
    store.sync('global');
    const globalPrefs = globalTier.db
      .prepare(`
        SELECT id, path, type, title, summary, tags, updated_at
        FROM docs
        WHERE status = 'active'
        ORDER BY CASE WHEN path LIKE 'docs/preferences/%' THEN 0 ELSE 1 END, updated_at DESC
        LIMIT 25
      `)
      .all()
      .map((r) => {
        let tags = [];
        try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
        return {
          id: r.id,
          type: r.type,
          category: r.path.startsWith('docs/preferences/') ? 'preferences' : 'knowledge',
          title: r.title,
          summary: r.summary,
          tags,
          updated_at: r.updated_at,
        };
      });

    if (globalPrefs.length === 0) return null;
    return {
      sessionFilter: null,
      sessions: [],
      todos: [],
      decisions: [],
      recentWork: [],
      globalPreferences: globalPrefs,
    };
  } catch {
    return null;
  } finally {
    store.close();
  }
}

function trimLinesToBudget(text, budget) {
  if (!text || text.length <= budget) return text;
  const lines = text.split('\n');
  const out = [];
  let len = 0;
  for (const line of lines) {
    const add = out.length === 0 ? line.length : 1 + line.length;
    if (len + add > budget) break;
    out.push(line);
    len += add;
  }
  return out.join('\n').trimEnd();
}

/**
 * Claude Code SessionStart handler.
 * Supports optional part: 'all' (default) | 'core' | 'context'.
 */
export function handleClaudeSessionStart(
  payload = {},
  {
    part = 'all',
    terminalId = process.env.HC_TERMINAL_ID,
    globalDir,
    legacyHome,
    promptsDir = path.join(REPO_ROOT, 'prompts'),
  } = {},
) {
  if (isSubagentPayload(payload)) {
    return {};
  }

  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const projectDir = extractCwd(payload, process.cwd());
  const config = loadConfig({ projectDir, globalDir: effectiveGlobalDir });
  const maxChars = Math.max(256, Math.min(Number(config.hookBudget) || CLAUDE_HOOK_MAX_CHARS, CLAUDE_HOOK_MAX_CHARS));
  const source = String(payload.source || '').trim().toLowerCase();

  // Record revive session once (skip on legacy split part="core" to avoid parallel race)
  const sessionRec = part !== 'core'
    ? recordSession({
        terminalId,
        agent: 'claude',
        payload,
        cwd: projectDir,
        globalDir: effectiveGlobalDir,
        legacyHome,
      })
    : null;

  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }

  // Nothing from the project's .memory/ is read, injected or created until the user approved the folder.
  // If such a folder is there, one short notice says so; global memory and HEAD_CORE are unaffected.
  const projectTrusted = isProjectTrusted(projectDir, { globalDir: effectiveGlobalDir });
  const notApprovedNotice = !projectTrusted && part !== 'core' && hasProjectMemoryDir(projectDir)
    ? formatProjectNotApprovedNotice(projectDir)
    : '';

  const sections = [];
  let used = 0;

  const pushSection = (text) => {
    if (!text || !text.trim()) return;
    const sep = sections.length > 0 ? 2 : 0;
    sections.push(text.trim());
    used += sep + text.trim().length;
  };

  // 1. HEAD_CORE.md (in 'all' or 'core'); skip duplicate on resume/fork where conversation already has it
  const skipDuplicateHeadCore = source === 'resume' || source === 'fork';
  if ((part === 'all' || part === 'core') && !skipDuplicateHeadCore) {
    const headCore = readHeadCore(promptsDir, config);
    if (headCore) {
      const noticeReserve = notApprovedNotice ? notApprovedNotice.length + 2 : 0;
      pushSection(trimLinesToBudget(headCore, maxChars - noticeReserve));
    }
    if (part === 'core') {
      if (sections.length === 0) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: sections.join('\n\n'),
        },
      };
    }
  } else if (part === 'core') {
    return {};
  }

  if (notApprovedNotice) {
    pushSection(notApprovedNotice);
  }

  const wantsRecentTurns = (source === 'compact' || source === 'clear') && Boolean(payload.transcript_path || payload.transcriptPath);
  const overview = loadOverviewSafely({ projectDir, globalDir: effectiveGlobalDir, config, projectTrusted });

  const sepCost = (n) => (sections.length + n > 0 ? 2 : 0);

  // 2. Budget-first relay inbox drain + partial ACK (only ack fully delivered non-truncated messages)
  if (projectTrusted && isValidTerminalId(terminalId) && fs.existsSync(getProjectMemoryDir(projectDir))) {
    const remaining = maxChars - used - sepCost(0);
    if (remaining >= 120) {
      try {
        const drainedInbox = drainInbox(projectDir, terminalId);
        if (drainedInbox && drainedInbox.messages.length > 0) {
          const inboxBudget = (overview || wantsRecentTurns)
            ? Math.min(2000, Math.max(300, Math.floor(remaining * 0.35)))
            : remaining;
          const detailed = formatInboxForHookDetailed(drainedInbox.messages, {
            maxChars: Math.min(inboxBudget, remaining),
          });
          if (detailed.text) {
            pushSection(detailed.text);
          }
          drainedInbox.ack(detailed.includedIds);
        }
      } catch {
        // ignore inbox errors in hook
      }
    }
  }

  // 3. Recent 5 turns on compact / clear (prioritized cleanly alongside overview)
  let recentTurnsText = '';
  let resolvedTurnsTranscript = '';
  if (wantsRecentTurns) {
    const remaining = maxChars - used - sepCost(0);
    if (remaining >= 200) {
      const recentBudget = overview
        ? Math.min(4500, Math.max(400, Math.floor(remaining * 0.55)))
        : Math.min(4500, remaining);
      const maxRecentChars = Math.min(recentBudget, remaining);
      const transcriptPath = payload.transcript_path || payload.transcriptPath;
      resolvedTurnsTranscript = transcriptPath;

      let extracted = extractClaudeRecentTurns(transcriptPath, {
        maxTurns: 5,
        maxChars: maxRecentChars,
      });

      // On /clear, Claude Code often opens a brand-new empty <newSessionId>.jsonl;
      // fall back safely to sibling <previousSessionId>.jsonl, or (for non-Herdr terminals
      // without HC_TERMINAL_ID) the most recently modified sibling *.jsonl in the same directory.
      if (source === 'clear' && extracted.turns.length === 0) {
        const resolvedCurrent = path.resolve(transcriptPath);
        const transcriptDir = path.dirname(resolvedCurrent);
        const prevSessionId = sessionRec?.record?.previousSessionId;
        if (prevSessionId && isValidId(prevSessionId)) {
          try {
            const siblingPath = assertInsideDir(transcriptDir, `${prevSessionId}.jsonl`);
            if (fs.existsSync(siblingPath)) {
              const prevExtracted = extractClaudeRecentTurns(siblingPath, {
                maxTurns: 5,
                maxChars: maxRecentChars,
              });
              if (prevExtracted.turns.length > 0) {
                extracted = prevExtracted;
                resolvedTurnsTranscript = siblingPath;
              }
            }
          } catch {
            // ignore invalid or escaped sibling path
          }
        }

        if (extracted.turns.length === 0 && fs.existsSync(transcriptDir)) {
          try {
            const candidates = fs.readdirSync(transcriptDir, { withFileTypes: true })
              .filter((ent) => ent.isFile() && ent.name.endsWith('.jsonl') && !ent.name.startsWith('agent-'))
              .map((ent) => {
                try {
                  const abs = assertInsideDir(transcriptDir, ent.name);
                  if (abs.toLowerCase() === resolvedCurrent.toLowerCase()) return null;
                  const st = fs.statSync(abs);
                  if (st.size === 0) return null;
                  return { abs, mtimeMs: st.mtimeMs };
                } catch {
                  return null;
                }
              })
              .filter(Boolean)
              .sort((a, b) => b.mtimeMs - a.mtimeMs);

            for (const cand of candidates.slice(0, 5)) {
              const candExtracted = extractClaudeRecentTurns(cand.abs, {
                maxTurns: 5,
                maxChars: maxRecentChars,
              });
              if (candExtracted.turns.length > 0) {
                extracted = candExtracted;
                resolvedTurnsTranscript = cand.abs;
                break;
              }
            }
          } catch {
            // ignore directory scan errors
          }
        }
      }

      if (extracted.text) {
        recentTurnsText = extracted.text;
      }
    }
  }

  // 4. Non-truncating FIT_STEPS memory overview
  if (overview) {
    const reserveForRecent = recentTurnsText ? recentTurnsText.length + 2 : 0;
    const overviewBudget = maxChars - used - sepCost(0) - reserveForRecent;
    if (overviewBudget >= 120) {
      const fitted = fitOverviewToBudget(overview, overviewBudget);
      if (fitted.text) {
        pushSection(fitted.text);
      }
    }
  }

  if (recentTurnsText) {
    const remaining = maxChars - used - sepCost(0);
    if (recentTurnsText.length <= remaining) {
      pushSection(recentTurnsText);
    } else if (remaining >= 160) {
      const reExtracted = extractClaudeRecentTurns(resolvedTurnsTranscript, {
        maxTurns: 5,
        maxChars: remaining,
      });
      if (reExtracted.text) {
        pushSection(reExtracted.text);
      }
    }
  }

  if (sections.length === 0) {
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: sections.join('\n\n'),
    },
  };
}

/**
 * Claude Code PreCompact handler: 1-line pointer instruction suppressing long lossy summaries.
 * Note: Claude Code rejects `hookSpecificOutput` on PreCompact; emit top-level `continue` + `systemMessage`.
 */
export function handleClaudePreCompact(payload = {}, { globalDir } = {}) {
  if (isSubagentPayload(payload)) {
    return {};
  }
  const projectDir = extractCwd(payload, process.cwd());
  const config = loadConfig({ projectDir, globalDir: resolveCortexGlobalDir(globalDir) });
  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }
  return {
    continue: true,
    systemMessage: COMPACT_POINTER_INSTRUCTION,
  };
}

/**
 * Claude Code UserPromptSubmit handler: drain relay inbox for HC_TERMINAL_ID.
 */
export function handleClaudeUserPrompt(
  payload = {},
  {
    terminalId = process.env.HC_TERMINAL_ID,
    globalDir,
  } = {},
) {
  if (isSubagentPayload(payload)) {
    return {};
  }
  if (!isValidTerminalId(terminalId)) {
    return {};
  }

  const projectDir = extractCwd(payload, process.cwd());
  if (!fs.existsSync(getProjectMemoryDir(projectDir))) {
    return {};
  }

  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const config = loadConfig({ projectDir, globalDir: effectiveGlobalDir });
  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }
  // The inbox is part of the project's .memory/: an unapproved folder's inbox is neither read nor changed.
  if (!isProjectTrusted(projectDir, { globalDir: effectiveGlobalDir })) {
    return {};
  }
  const maxChars = Math.max(256, Math.min(Number(config.hookBudget) || CLAUDE_HOOK_MAX_CHARS, CLAUDE_HOOK_MAX_CHARS));

  const drained = drainInbox(projectDir, terminalId);
  if (drained.messages.length === 0) {
    return {};
  }

  const detailed = formatInboxForHookDetailed(drained.messages, { maxChars });
  drained.ack(detailed.includedIds);

  if (!detailed.text) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: detailed.text,
    },
  };
}

function preToolUseDecision(permissionDecision, permissionDecisionReason, extra = {}) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
      ...extra,
    },
  };
}

// Does a file or shell tool call made by a subagent reach into a `.memory/` folder?
function subagentTouchesMemoryDir(toolName, rawInput, cwd) {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  if (FILE_WRITE_TOOLS.has(name)) {
    return [rawInput.file_path, rawInput.notebook_path].some((target) => isPathInsideMemoryDir(target, cwd));
  }
  if (SHELL_TOOLS.has(name)) {
    return commandReferencesMemoryDir(rawInput.command);
  }
  return false;
}

/**
 * Folder a `memory_save` / `memory_update` call would write to when its `project_dir` names a different
 * project than the one this session runs in (compared by real path), or '' when it stays in this project.
 */
function otherProjectWriteTarget(toolName, rawInput, cwd) {
  if (!PROJECT_WRITE_CORTEX_TOOLS.has(cortexToolBaseName(toolName))) return '';
  const requested = typeof rawInput.project_dir === 'string' ? rawInput.project_dir.trim() : '';
  if (!requested) return '';
  const currentRoot = resolveProjectRoot(path.resolve(cwd || process.cwd()));
  const targetRoot = resolveProjectRoot(path.resolve(currentRoot, requested));
  return projectPathKey(targetRoot) === projectPathKey(currentRoot) ? '' : targetRoot;
}

export function formatOtherProjectWriteReason(targetDir) {
  return `[herdr-cortex] This call writes memory into a different project folder: "${sanitizeInline(targetDir)}". `
    + 'Allow it only if you want that project\'s memory changed from this session.';
}

/**
 * Claude Code PreToolUse handler. In order:
 * - A subagent's Write / Edit / MultiEdit / NotebookEdit into a `.memory/` folder, or Bash / PowerShell
 *   command that mentions one, is denied (subagents hand results back to the main conversation).
 * - For subagents calling write-protected cortex tools (memory_save, memory_update,
 *   relay_send, relay_inbox(action="ack")), directly return permissionDecision: 'deny'.
 * - A memory_save / memory_update whose `project_dir` is another project returns permissionDecision: 'ask',
 *   so the user confirms a write that leaves the current project.
 * - For subagents calling read-only cortex tools, inject real host agent_id via updatedInput
 *   and NEVER return permissionDecision: 'allow'.
 * - For HEAD, strip any LLM-spoofed `_caller_agent_id`.
 * Any other tool call returns {} right away (the hook prints nothing).
 */
export function handleClaudePreToolUse(payload = {}) {
  const toolName = payload.tool_name || payload.toolName || '';
  const rawInput = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
    ? payload.tool_input
    : {};

  const hostAgentId = String(payload.agent_id || payload.agentId || '').trim();
  const callerIsSubagent = Boolean(hostAgentId) || isSubagentPayload(payload);

  if (!isCortexToolName(toolName)) {
    if (callerIsSubagent && subagentTouchesMemoryDir(toolName, rawInput, extractCwd(payload, process.cwd()))) {
      return preToolUseDecision('deny', SUBAGENT_MEMORY_DIR_DENY_REASON);
    }
    return {};
  }

  const hadSpoofedKey = Object.prototype.hasOwnProperty.call(rawInput, '_caller_agent_id');

  if (callerIsSubagent && isWriteProtectedCortexCall(toolName, rawInput)) {
    return preToolUseDecision('deny', SUBAGENT_CORTEX_WRITE_DENY_REASON);
  }

  const updatedInput = { ...rawInput };
  delete updatedInput._caller_agent_id;
  if (hostAgentId) {
    updatedInput._caller_agent_id = hostAgentId;
  }
  const inputChanged = hadSpoofedKey || Boolean(hostAgentId);

  const otherProjectDir = otherProjectWriteTarget(toolName, rawInput, extractCwd(payload, process.cwd()));
  if (otherProjectDir) {
    return preToolUseDecision(
      'ask',
      formatOtherProjectWriteReason(otherProjectDir),
      inputChanged ? { updatedInput } : {},
    );
  }

  if (!inputChanged) {
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
    },
  };
}

export function runClaudeHook(eventName, payload = {}, options = {}) {
  const event = String(eventName || '').trim().toLowerCase();
  switch (event) {
    case 'session-start':
      return handleClaudeSessionStart(payload, options);
    case 'pre-compact':
      return handleClaudePreCompact(payload, options);
    case 'user-prompt':
      return handleClaudeUserPrompt(payload, options);
    case 'pre-tool-use':
      return handleClaudePreToolUse(payload, options);
    default:
      return {};
  }
}

function parseCliArgs(argv) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--id' || arg === '--marker') {
      i++; // skip marker value
      continue;
    }
    if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }
  return {
    event: positional[0] || '',
    part: positional[1] || 'all',
  };
}

if (isMainModule(import.meta.url)) {
  try {
    const { event, part } = parseCliArgs(process.argv.slice(2));
    const raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
    let payload = {};
    if (raw && raw.trim()) {
      payload = JSON.parse(raw);
    }
    const output = runClaudeHook(event, payload, { part });
    if (output && Object.keys(output).length > 0) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    // Never block Claude Code CLI on hook error
  }
  process.exit(0);
}
