#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT,
  assertInsideDir,
  getProjectMemoryDir,
  isProjectEnabled,
  isValidId,
  loadConfig,
} from '../core/config.mjs';
import { CortexStore } from '../core/store.mjs';
import { fitOverviewToBudget } from '../core/budget.mjs';
import {
  extractCwd,
  isSubagentPayload,
  isValidTerminalId,
  recordSession,
  resolveCortexGlobalDir,
} from '../revive/tracker.mjs';
import { drainInbox, formatInboxForHook } from '../relay/inbox.mjs';
import { extractClaudeRecentTurns } from './recent-turns.mjs';

export const CLAUDE_HOOK_MAX_CHARS = 9000;

export const COMPACT_POINTER_INSTRUCTION =
  '[herdr-cortex] Compaction pointer: do not write a long lossy summary; active decisions, todos, and the last 5 verbatim turns will be restored automatically on SessionStart via cortex memory.';

const CORTEX_DIRECT_TOOLS = new Set([
  'memory_search',
  'memory_read',
  'memory_save',
  'memory_update',
  'memory_graph',
  'memory_overview',
  'relay_tabs',
  'relay_send',
  'relay_inbox',
  'cortex_prompt',
]);

export function isCortexToolName(toolName) {
  if (typeof toolName !== 'string') return false;
  const trimmed = toolName.trim();
  if (!trimmed) return false;
  if (CORTEX_DIRECT_TOOLS.has(trimmed)) return true;
  if (/^(mcp__)?cortex__/i.test(trimmed)) return true;
  return false;
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
    (ov.sessions?.length || 0) > 0
    || (ov.todos?.length || 0) > 0
    || (ov.decisions?.length || 0) > 0
    || (ov.recentWork?.length || 0) > 0
    || (ov.globalPreferences?.length || 0) > 0
  );
}

function loadOverviewSafely({ projectDir, globalDir, config }) {
  const projectMemExists = fs.existsSync(getProjectMemoryDir(projectDir));
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

  // Record revive session on 'all' or 'core' (and on 'context' returns existing record with previousSessionId)
  const sessionRec = recordSession({
    terminalId,
    agent: 'claude',
    payload,
    cwd: projectDir,
    globalDir: effectiveGlobalDir,
    legacyHome,
  });

  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }

  const sections = [];
  let used = 0;

  const pushSection = (text) => {
    if (!text || !text.trim()) return;
    const sep = sections.length > 0 ? 2 : 0;
    sections.push(text.trim());
    used += sep + text.trim().length;
  };

  // 1. HEAD_CORE.md (in 'all' or 'core')
  if (part === 'all' || part === 'core') {
    const headCore = readHeadCore(promptsDir, config);
    if (headCore) {
      pushSection(trimLinesToBudget(headCore, maxChars));
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
  }

  // 2. Drain relay inbox (urgent peer messages)
  let drainedInbox = null;
  if (isValidTerminalId(terminalId) && fs.existsSync(getProjectMemoryDir(projectDir))) {
    try {
      drainedInbox = drainInbox(projectDir, terminalId);
    } catch {
      drainedInbox = null;
    }
  }

  const source = String(payload.source || '').trim().toLowerCase();
  const wantsRecentTurns = (source === 'compact' || source === 'clear') && Boolean(payload.transcript_path || payload.transcriptPath);
  const overview = loadOverviewSafely({ projectDir, globalDir: effectiveGlobalDir, config });

  const sepCost = (n) => (sections.length + n > 0 ? 2 : 0);

  if (drainedInbox && drainedInbox.messages.length > 0) {
    const remaining = maxChars - used - sepCost(0);
    if (remaining >= 120) {
      const inboxBudget = (overview || wantsRecentTurns)
        ? Math.min(2000, Math.max(300, Math.floor(remaining * 0.35)))
        : remaining;
      const inboxText = formatInboxForHook(drainedInbox.messages, { maxChars: Math.min(inboxBudget, remaining) });
      if (inboxText) {
        pushSection(inboxText);
        drainedInbox.ack();
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
      // fall back safely to sibling <previousSessionId>.jsonl when 0 turns exist.
      if (source === 'clear' && extracted.turns.length === 0) {
        const prevSessionId = sessionRec?.record?.previousSessionId;
        if (prevSessionId && isValidId(prevSessionId)) {
          try {
            const transcriptDir = path.dirname(path.resolve(transcriptPath));
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

  const config = loadConfig({ projectDir, globalDir: resolveCortexGlobalDir(globalDir) });
  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }
  const maxChars = Math.max(256, Math.min(Number(config.hookBudget) || CLAUDE_HOOK_MAX_CHARS, CLAUDE_HOOK_MAX_CHARS));

  const drained = drainInbox(projectDir, terminalId);
  if (drained.messages.length === 0) {
    return {};
  }

  const text = formatInboxForHook(drained.messages, { maxChars });
  drained.ack();

  if (!text) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  };
}

/**
 * Claude Code PreToolUse handler:
 * For cortex MCP tools, ALWAYS strip any LLM-supplied `_caller_agent_id` and
 * inject the real host `agent_id` (if caller is a subagent) via `updatedInput`
 * so Canon Protection cannot be spoofed.
 */
export function handleClaudePreToolUse(payload = {}) {
  const toolName = payload.tool_name || payload.toolName || '';
  if (!isCortexToolName(toolName)) {
    return {};
  }

  const rawInput = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
    ? payload.tool_input
    : {};

  const hadSpoofedKey = Object.prototype.hasOwnProperty.call(rawInput, '_caller_agent_id');
  const hostAgentId = String(payload.agent_id || payload.agentId || '').trim();

  if (!hadSpoofedKey && !hostAgentId) {
    return {};
  }

  const updatedInput = { ...rawInput };
  delete updatedInput._caller_agent_id;

  if (hostAgentId) {
    updatedInput._caller_agent_id = hostAgentId;
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...(hostAgentId ? { permissionDecision: 'allow' } : {}),
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { event, part } = parseCliArgs(process.argv.slice(2));
    const raw = fs.readFileSync(0, 'utf8');
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
