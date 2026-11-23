#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  assertInsideDir,
  atomicWriteJson,
  getTierPaths,
  getTrustedProjectsPath,
  hasProjectMemoryDir,
  isMainModule,
  isProjectEnabled,
  isProjectTrusted,
  isValidId,
  loadConfig,
  projectPathKey,
  resolveProjectRoot,
} from '../core/config.mjs';
import { HOOK_MAX_CHARS, fitOverviewToBudget, resolveHookBudget, sanitizeInline } from '../core/budget.mjs';
import { formatProjectNotApprovedNotice } from '../core/trust.mjs';
import {
  FILE_WRITE_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  cortexToolBaseName,
  isCortexToolName,
} from './tool-names.mjs';
import {
  extractCwd,
  extractSessionId,
  isSubagentPayload,
  isValidSessionId,
  isValidTerminalId,
  recordSession,
  resolveCortexGlobalDir,
} from '../revive/tracker.mjs';
import { deliverInboxForHook } from '../relay/inbox.mjs';
import { formatUnindexedNotice, loadHookOverview, resolveHookSyncOptions } from './overview.mjs';
import {
  RESTORE_FAILURE_NO_TURNS_WITHIN_CAP,
  RESTORE_FAILURE_RECORD_TOO_LARGE,
  extractClaudeRecentTurns,
  formatRecentTurns,
} from './recent-turns.mjs';

export const CLAUDE_HOOK_MAX_CHARS = HOOK_MAX_CHARS;

/**
 * Instruction for the compaction summary. Claude Code takes the plain stdout of a PreCompact hook as
 * instructions for the summarizer; the Antigravity hook injects the same text when the user runs /compact.
 */
export const COMPACT_POINTER_INSTRUCTION =
  '[herdr-cortex] Decisions, baselines and todos that were saved to herdr-cortex memory are re-injected after '
  + 'compaction, so do not restate them at length. Do keep in the summary the progress, findings and context '
  + 'from this conversation that have not been saved to memory.';

/** Added when the user gave compaction instructions of their own. */
export const COMPACT_USER_INSTRUCTIONS_CLAUSE =
  ' The user\'s own compaction instructions take precedence over this note.';

export function buildCompactInstruction({ hasUserInstructions = false } = {}) {
  return hasUserInstructions
    ? `${COMPACT_POINTER_INSTRUCTION}${COMPACT_USER_INSTRUCTIONS_CLAUSE}`
    : COMPACT_POINTER_INSTRUCTION;
}

export const SUBAGENT_CORTEX_WRITE_DENY_REASON =
  'Canonical memory and relay write operations are restricted to the main HEAD conversation; subagents have read-only access.';

export const SUBAGENT_MEMORY_DIR_DENY_REASON =
  '[herdr-cortex] Subagents must not read or change files under a .memory/ folder directly. '
  + 'Hand your results back to the main conversation; it records memory through the memory tools.';

export const SUBAGENT_TRUST_CHANGE_DENY_REASON =
  '[herdr-cortex] Subagents must not change herdr-cortex project approvals or files in the herdr-cortex state folder. '
  + 'Approving a project is the user\'s decision: hand the request back to the main conversation.';

/**
 * Notes injected at session start when the turns before a /clear or a compaction could not be restored.
 */
export const TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE =
  '[herdr-cortex] Recent turns were not restored after /clear: the previous session could not be identified.';
export const TURNS_NOT_RESTORED_TOO_LARGE_NOTE =
  '[herdr-cortex] Recent turns could not be restored: the last transcript record is too large.';
export const TURNS_NOT_RESTORED_NO_TURNS_NOTE =
  '[herdr-cortex] Recent turns could not be restored: no conversation turn was found in the part of the transcript that is read.';

/**
 * Clear records: when a session ends with /clear, the SessionEnd hook writes
 * <globalDir>/state/cleared-sessions/<sessionId>.json so the SessionStart hook of the session that follows
 * can find the transcript that was actually cleared.
 * - CLEAR_RECORD_WINDOW_MS: how long before a SessionStart(clear) a record may have been written to count.
 * - CLEAR_RECORD_STALE_MS: records older than this are deleted whenever the folder is visited.
 */
export const CLEAR_RECORD_DIR_NAME = 'cleared-sessions';
export const CLEAR_RECORD_WINDOW_MS = 60 * 1000;
export const CLEAR_RECORD_STALE_MS = 10 * 60 * 1000;
// A record written "in the future" by this much is still accepted (clock steps between two processes).
const CLEAR_RECORD_FUTURE_SLACK_MS = 5 * 1000;

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

// ---------------------------------------------------------------------------------------------
// Project approvals: an agent must not approve projects for itself without the user seeing it
// ---------------------------------------------------------------------------------------------

const TRUST_COMMAND_NAMES = new Set([
  'cortex-trust',
  'cortex-trust.ps1',
  'cortex-trust.cmd',
  'cortex-trust.bat',
  'cortex-trust.exe',
]);
const TRUST_CLI_SCRIPT_NAME = 'trust-cli.mjs';
const TRUSTED_PROJECTS_FILE_NAME = 'trusted-projects.json';
const NPM_COMMAND_NAMES = new Set(['npm', 'npm.cmd', 'npm.ps1', 'npm.exe']);
const TRUST_READ_ONLY_SUBCOMMANDS = new Set(['status', 'list']);

// Characters that end a simple command or start a nested one; a command line that has any of them (or a
// redirection or a substitution) is never taken for a plain read-only call.
const SHELL_SEPARATOR_CHARS = new Set([';', '&', '|', '(', ')', '{', '}', '`', '\n', '\r']);
const SHELL_COMPLEX_CHARS = new Set(['<', '>', '$']);

// One forward pass: words (quotes dropped, split at whitespace) with a `null` entry wherever a simple
// command ends. `complex` is set when the line has redirections, substitutions or several commands.
function splitShellWords(command) {
  const words = [];
  let current = '';
  let complex = false;
  const flush = () => {
    if (current) words.push(current);
    current = '';
  };
  for (const ch of command) {
    if (ch === '"' || ch === '\'') continue;
    if (SHELL_SEPARATOR_CHARS.has(ch)) {
      flush();
      words.push(null);
      complex = true;
    } else if (ch === ' ' || ch === '\t') {
      flush();
    } else {
      if (SHELL_COMPLEX_CHARS.has(ch)) complex = true;
      current += ch;
    }
  }
  flush();
  return { words, complex };
}

function shellWordBaseName(word) {
  const cut = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'));
  return word.slice(cut + 1).toLowerCase();
}

function isNameChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
}

// `trusted-projects.json` as a file name inside a word: not part of a longer name on either side
// ("untrusted-projects.json" and "trusted-projects.jsonl" do not count; a ".bak" copy does).
function wordNamesApprovalsFile(word) {
  const lower = word.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(TRUSTED_PROJECTS_FILE_NAME, from);
    if (at === -1) return false;
    const before = at > 0 ? lower[at - 1] : undefined;
    const after = lower[at + TRUSTED_PROJECTS_FILE_NAME.length];
    if (!isNameChar(before) && before !== '.' && !isNameChar(after)) return true;
    from = at + 1;
  }
}

/**
 * Does a shell command line run the project-approval CLI (`cortex-trust`, `trust-cli.mjs`, `npm run trust`)
 * or name the approvals file? Returns:
 * - 'change'    : it does, and it may change approvals (or it cannot be told apart from one that does);
 * - 'read-only' : a single plain `status` / `list` call of the CLI, nothing else on the line;
 * - ''          : neither.
 * It is a string heuristic like `commandReferencesMemoryDir`: a name that is assembled at run time is not seen.
 */
export function classifyTrustCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return '';
  const { words, complex } = splitShellWords(command);

  const invocations = []; // index of the word after which the CLI's own arguments start
  let namesApprovalsFile = false;
  let npmSeen = false;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === null) {
      npmSeen = false;
      continue;
    }
    if (wordNamesApprovalsFile(word)) namesApprovalsFile = true;
    const base = shellWordBaseName(word);
    if (TRUST_COMMAND_NAMES.has(base) || base === TRUST_CLI_SCRIPT_NAME) {
      invocations.push(i);
    } else if (NPM_COMMAND_NAMES.has(base)) {
      npmSeen = true;
    } else if (npmSeen && (base === 'run' || base === 'run-script') && words[i + 1] && words[i + 1].toLowerCase() === 'trust') {
      invocations.push(i + 1);
    }
  }

  if (invocations.length === 0 && !namesApprovalsFile) return '';
  if (namesApprovalsFile || complex || invocations.length !== 1) return 'change';

  // One plain call: read-only only when the CLI's first argument is `status` or `list`.
  const args = words.slice(invocations[0] + 1).filter((w) => w !== '--' && w.toLowerCase() !== '--json');
  return args.length > 0 && TRUST_READ_ONLY_SUBCOMMANDS.has(args[0].toLowerCase()) ? 'read-only' : 'change';
}

function clipForReason(value, maxChars = 300) {
  const text = sanitizeInline(value);
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

export function formatTrustCommandAskReason(command) {
  return `[herdr-cortex] herdr-cortex project approvals are about to be changed by this command: "${clipForReason(command)}". `
    + 'Approvals decide which project folders\' .memory/ is read and written. Allow it only if you want that change.';
}

export function formatStateFileWriteAskReason(targetPath, { approvalsFile = false } = {}) {
  if (approvalsFile) {
    return `[herdr-cortex] herdr-cortex project approvals are about to be changed: this call writes the approvals file "${clipForReason(targetPath)}". `
      + 'Approvals decide which project folders\' .memory/ is read and written. Allow it only if you want that change.';
  }
  return `[herdr-cortex] This call writes a file in the herdr-cortex state folder: "${clipForReason(targetPath)}". `
    + 'That folder holds the project approvals and other internal records. Allow it only if you want the agent to change it.';
}

// Path form used to compare locations: real path where it exists, lower-cased on Windows, and without the
// trailing dots and spaces Windows ignores in every segment.
function comparablePaths(targetPath) {
  const forms = new Set();
  const normalize = (value) => {
    let out = process.platform === 'win32' ? value.toLowerCase() : value;
    if (process.platform === 'win32') {
      out = out.split(/[\\/]+/).map((segment) => segment.replace(/[. ]+$/, '') || segment).join(path.sep);
    }
    return out;
  };
  forms.add(normalize(path.resolve(targetPath)));
  try {
    forms.add(normalize(projectPathKey(targetPath)));
  } catch {
    // keep the form as written
  }
  return [...forms];
}

/**
 * The file a Write / Edit / MultiEdit / NotebookEdit call targets when it lies in <globalDir>/state/
 * ({ path, approvalsFile }), or null. Compared as written and by real path.
 */
function stateFileWriteTarget(toolName, rawInput, cwd, globalDir) {
  if (!FILE_WRITE_TOOLS.has(typeof toolName === 'string' ? toolName.trim() : '')) return null;
  const stateForms = comparablePaths(getTierPaths(globalDir).stateDir);
  const approvalsForms = new Set(comparablePaths(getTrustedProjectsPath(globalDir)));

  for (const target of [rawInput.file_path, rawInput.notebook_path]) {
    if (typeof target !== 'string' || !target.trim()) continue;
    const resolved = path.resolve(cwd || process.cwd(), target.trim());
    const forms = comparablePaths(resolved);
    const approvalsFile = forms.some((form) => approvalsForms.has(form));
    const insideState = forms.some((form) => stateForms.some((dir) => form === dir || form.startsWith(`${dir}${path.sep}`)));
    if (approvalsFile || insideState) return { path: resolved, approvalsFile };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Clear records
// ---------------------------------------------------------------------------------------------

export function getClearRecordsDir(globalDir) {
  return path.join(getTierPaths(resolveCortexGlobalDir(globalDir)).stateDir, CLEAR_RECORD_DIR_NAME);
}

function readClearRecord(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!isValidSessionId(parsed.sessionId) || typeof parsed.transcriptPath !== 'string') return null;
    if (typeof parsed.cwdKey !== 'string' || !Number.isFinite(Number(parsed.clearedAtMs))) return null;
    return {
      sessionId: parsed.sessionId,
      transcriptPath: parsed.transcriptPath,
      cwdKey: parsed.cwdKey,
      terminalId: typeof parsed.terminalId === 'string' ? parsed.terminalId : '',
      clearedAtMs: Number(parsed.clearedAtMs),
      filePath,
    };
  } catch {
    return null;
  }
}

function removeFileQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone, or not removable right now
  }
}

/**
 * Readable clear records, after deleting the stale ones (and unreadable files that are just as old).
 */
function loadClearRecords(globalDir, nowMs) {
  const dir = getClearRecordsDir(globalDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    let filePath;
    try {
      filePath = assertInsideDir(dir, ent.name);
    } catch {
      continue;
    }
    const record = readClearRecord(filePath);
    if (record) {
      if (nowMs - record.clearedAtMs > CLEAR_RECORD_STALE_MS) removeFileQuietly(filePath);
      else records.push(record);
      continue;
    }
    try {
      if (nowMs - fs.statSync(filePath).mtimeMs > CLEAR_RECORD_STALE_MS) removeFileQuietly(filePath);
    } catch {
      // ignore
    }
  }
  return records;
}

function consumeClearRecord(globalDir, sessionId) {
  if (!isValidSessionId(sessionId)) return;
  try {
    removeFileQuietly(assertInsideDir(getClearRecordsDir(globalDir), `${sessionId}.json`));
  } catch {
    // ignore
  }
}

/**
 * The session that was cleared right before this SessionStart, from the clear records:
 * { status: 'one', record, transcript } when exactly one record fits (same folder by real path, same
 * terminal, written within CLEAR_RECORD_WINDOW_MS, transcript in the directory of the new transcript),
 * otherwise { status: 'none' } or { status: 'ambiguous' }.
 */
function findClearedSession({ globalDir, projectDir, terminalId, newSessionId, currentTranscript, nowMs }) {
  const transcriptDir = path.dirname(currentTranscript);
  const transcriptDirKey = projectPathKey(transcriptDir);
  const cwdKey = projectPathKey(projectDir);
  const ownTerminal = isValidTerminalId(terminalId) ? terminalId.trim() : '';

  const candidates = [];
  for (const record of loadClearRecords(globalDir, nowMs)) {
    if (record.cwdKey !== cwdKey) continue;
    if (record.sessionId === newSessionId) continue;
    if (record.terminalId !== ownTerminal) continue;
    const age = nowMs - record.clearedAtMs;
    if (age > CLEAR_RECORD_WINDOW_MS || age < -CLEAR_RECORD_FUTURE_SLACK_MS) continue;

    // Only a transcript that sits next to the new session's transcript is ever read.
    const recorded = path.resolve(record.transcriptPath);
    if (!recorded.toLowerCase().endsWith('.jsonl')) continue;
    let transcript;
    try {
      if (projectPathKey(path.dirname(recorded)) !== transcriptDirKey) continue;
      transcript = assertInsideDir(transcriptDir, path.basename(recorded));
    } catch {
      continue;
    }
    if (transcript.toLowerCase() === currentTranscript.toLowerCase()) continue;
    candidates.push({ record, transcript });
  }

  if (candidates.length === 1) return { status: 'one', ...candidates[0] };
  return { status: candidates.length === 0 ? 'none' : 'ambiguous' };
}

/**
 * Claude Code SessionEnd handler. When the session ends with /clear it writes a clear record (session id,
 * transcript path, folder, terminal id, time); every other reason is ignored. It only reads the
 * configuration and writes one small file: no index sync, no database (SessionEnd has 1.5 s by default).
 * The hook's output is ignored by Claude Code, so nothing is returned.
 */
export function handleClaudeSessionEnd(
  payload = {},
  {
    terminalId = process.env.HC_TERMINAL_ID,
    globalDir,
    now = Date.now,
  } = {},
) {
  if (isSubagentPayload(payload)) return {};
  if (String(payload.reason || '').trim().toLowerCase() !== 'clear') return {};

  const sessionId = extractSessionId(payload);
  const transcriptPath = payload.transcript_path || payload.transcriptPath;
  if (!sessionId || typeof transcriptPath !== 'string' || !transcriptPath.trim()) return {};

  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const projectDir = extractCwd(payload, process.cwd());
  const config = loadConfig({ projectDir, globalDir: effectiveGlobalDir });
  if (!isProjectEnabled(projectDir, config)) return {};

  const nowMs = Number(typeof now === 'function' ? now() : now) || Date.now();
  try {
    const filePath = assertInsideDir(getClearRecordsDir(effectiveGlobalDir), `${sessionId}.json`);
    atomicWriteJson(filePath, {
      version: 1,
      sessionId,
      transcriptPath: path.resolve(transcriptPath.trim()),
      cwd: projectDir,
      cwdKey: projectPathKey(projectDir),
      terminalId: isValidTerminalId(terminalId) ? terminalId.trim() : null,
      clearedAt: new Date(nowMs).toISOString(),
      clearedAtMs: nowMs,
    });
    // Opportunistic cleanup of records nobody picked up.
    loadClearRecords(effectiveGlobalDir, nowMs);
  } catch {
    // Never fail the hook: without a record the next session simply restores no turns.
  }
  return {};
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

export function restoreFailureNote(restoreFailure) {
  if (restoreFailure === RESTORE_FAILURE_RECORD_TOO_LARGE) return TURNS_NOT_RESTORED_TOO_LARGE_NOTE;
  if (restoreFailure === RESTORE_FAILURE_NO_TURNS_WITHIN_CAP) return TURNS_NOT_RESTORED_NO_TURNS_NOTE;
  return '';
}

/**
 * Claude Code SessionStart handler.
 * Supports optional part: 'all' (default) | 'core' | 'context'.
 * `startedAt` (epoch ms the hook process started) and `indexBudget` set the index sync limits, see
 * `resolveHookSyncOptions`; `turnOptions` is passed to the transcript reader (window sizes, for tests).
 */
export function handleClaudeSessionStart(
  payload = {},
  {
    part = 'all',
    terminalId = process.env.HC_TERMINAL_ID,
    globalDir,
    legacyHome,
    promptsDir = path.join(REPO_ROOT, 'prompts'),
    startedAt,
    indexBudget,
    turnOptions,
    now = Date.now,
  } = {},
) {
  if (isSubagentPayload(payload)) {
    return {};
  }

  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const projectDir = extractCwd(payload, process.cwd());
  const config = loadConfig({ projectDir, globalDir: effectiveGlobalDir });
  const maxChars = resolveHookBudget(config);
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

  const sepCost = (n) => (sections.length + n > 0 ? 2 : 0);
  // A one-line note is added only when it fits; it is counted like every other section.
  const pushNote = (text) => {
    if (text && used + sepCost(0) + text.length <= maxChars) pushSection(text);
  };

  const wantsRecentTurns = (source === 'compact' || source === 'clear') && Boolean(payload.transcript_path || payload.transcriptPath);

  // The index is synced under a time budget: documents that do not fit are left to the MCP server and
  // named in a short notice, everything else is injected as usual.
  const { overview, unindexed } = loadHookOverview({
    projectDir,
    globalDir: effectiveGlobalDir,
    config,
    projectTrusted,
    syncOptions: resolveHookSyncOptions({ startedAt, indexBudget }),
  });
  if (unindexed.length > 0) {
    pushSection(formatUnindexedNotice(unindexed, { maxChars: maxChars - used - sepCost(0) }));
  }

  // 2. Budget-first relay inbox delivery. The inbox belongs to the terminal and lives in the global store,
  // so it is delivered whether or not the current project is approved (an excluded project returned above).
  // Only messages injected in full are acknowledged; one that is too long for any hook block is announced once.
  if (isValidTerminalId(terminalId)) {
    const remaining = maxChars - used - sepCost(0);
    if (remaining >= 120) {
      try {
        const inboxBudget = (overview || wantsRecentTurns)
          ? Math.min(2000, Math.max(300, Math.floor(remaining * 0.35)))
          : remaining;
        const delivered = deliverInboxForHook(terminalId, {
          globalDir: effectiveGlobalDir,
          projectDir,
          maxChars: Math.min(inboxBudget, remaining),
          // UserPromptSubmit gives the inbox the whole hook budget: what fits there waits for it.
          fullBlockChars: maxChars,
        });
        if (delivered.text) {
          pushSection(delivered.text);
        }
      } catch {
        // ignore inbox errors in hook
      }
    }
  }

  // 3. Recent 5 turns on compact / clear (prioritized cleanly alongside overview)
  let recentTurnsText = '';
  let candidateTurns = [];
  if (wantsRecentTurns) {
    let turnsNote = '';
    const remaining = maxChars - used - sepCost(0);
    if (remaining >= 200) {
      const recentBudget = overview
        ? Math.min(4500, Math.max(400, Math.floor(remaining * 0.55)))
        : Math.min(4500, remaining);
      const maxRecentChars = Math.min(recentBudget, remaining);
      const transcriptPath = payload.transcript_path || payload.transcriptPath;
      const readTurns = (file) => extractClaudeRecentTurns(file, {
        ...(turnOptions && typeof turnOptions === 'object' ? turnOptions : {}),
        maxTurns: 5,
        maxChars: maxRecentChars,
      });

      let extracted = readTurns(transcriptPath);

      // On /clear, Claude Code opens a brand-new <newSessionId>.jsonl. The turns are restored from the
      // session that was actually cleared: the one this tab ran before (saved `previousSessionId`), else the
      // one the SessionEnd hook recorded for this folder a moment ago. A session that cannot be identified
      // is not guessed: nothing is restored and a note says so.
      if (source === 'clear' && extracted.turns.length === 0) {
        const resolvedCurrent = path.resolve(transcriptPath);
        const transcriptDir = path.dirname(resolvedCurrent);
        let identified = false;

        const prevSessionId = sessionRec?.record?.previousSessionId;
        if (prevSessionId && isValidId(prevSessionId)) {
          try {
            const siblingPath = assertInsideDir(transcriptDir, `${prevSessionId}.jsonl`);
            if (fs.existsSync(siblingPath)) {
              identified = true;
              extracted = readTurns(siblingPath);
              consumeClearRecord(effectiveGlobalDir, prevSessionId);
            }
          } catch {
            // ignore invalid or escaped sibling path
          }
        }

        if (!identified) {
          const nowMs = Number(typeof now === 'function' ? now() : now) || Date.now();
          const found = findClearedSession({
            globalDir: effectiveGlobalDir,
            projectDir,
            terminalId,
            newSessionId: extractSessionId(payload),
            currentTranscript: resolvedCurrent,
            nowMs,
          });
          if (found.status === 'one') {
            identified = true;
            extracted = readTurns(found.transcript);
            consumeClearRecord(effectiveGlobalDir, found.record.sessionId);
          }
        }

        if (!identified) turnsNote = TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE;
      }

      if (extracted.text) {
        recentTurnsText = extracted.text;
        candidateTurns = extracted.candidateTurns;
      } else if (!turnsNote) {
        turnsNote = restoreFailureNote(extracted.restoreFailure);
      }
    }
    pushNote(turnsNote);
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
      const refitted = formatRecentTurns(candidateTurns, { maxChars: remaining });
      if (refitted.text) {
        pushSection(refitted.text);
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
 * Claude Code PreCompact handler. Returns `{ instructions }`: one paragraph for the compaction summarizer.
 * Claude Code uses the plain stdout of this hook as summary instructions and discards JSON fields such as
 * `systemMessage`, so the CLI entry prints the text as it is (see `renderClaudeHookStdout`).
 * Returns {} (nothing is printed) for subagents and for projects that are excluded or disabled.
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
  const customInstructions = payload.custom_instructions ?? payload.customInstructions;
  return {
    instructions: buildCompactInstruction({
      hasUserInstructions: typeof customInstructions === 'string' && customInstructions.trim() !== '',
    }),
  };
}

/**
 * Claude Code UserPromptSubmit handler: deliver the relay inbox of HC_TERMINAL_ID.
 * The inbox is the terminal's (global store), so delivery does not depend on the current project having a
 * `.memory/` or being approved; a project excluded by the configuration gets nothing.
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
  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const config = loadConfig({ projectDir, globalDir: effectiveGlobalDir });
  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }
  const maxChars = resolveHookBudget(config);

  // One consumer at a time: when another process is delivering this terminal's messages right now,
  // nothing is injected and the messages stay for the next prompt.
  const delivered = deliverInboxForHook(terminalId, {
    globalDir: effectiveGlobalDir,
    projectDir,
    maxChars,
  });

  if (!delivered.text) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: delivered.text,
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
 * Reason to put a file or shell tool call to the user because it would change project approvals or the
 * state folder they live in, or '' when the call does neither.
 */
function trustChangeAskReason(toolName, rawInput, cwd, globalDir) {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  if (SHELL_TOOLS.has(name)) {
    return classifyTrustCommand(rawInput.command) === 'change' ? formatTrustCommandAskReason(rawInput.command) : '';
  }
  if (FILE_WRITE_TOOLS.has(name)) {
    const target = stateFileWriteTarget(name, rawInput, cwd, globalDir);
    return target ? formatStateFileWriteAskReason(target.path, { approvalsFile: target.approvalsFile }) : '';
  }
  return '';
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
 * - A Bash / PowerShell command that runs the project-approval CLI (`cortex-trust`, `trust-cli.mjs`,
 *   `npm run trust`) or names the approvals file, and a Write / Edit / MultiEdit / NotebookEdit into
 *   <globalDir>/state/, returns permissionDecision: 'ask' for the main conversation and 'deny' for a
 *   subagent, so an agent cannot approve a project without the user seeing it. A plain `status` / `list`
 *   call of the CLI is not put to the user.
 * - For subagents calling write-protected cortex tools (memory_save, memory_update,
 *   relay_send, relay_inbox(action="ack")), directly return permissionDecision: 'deny'.
 * - A memory_save / memory_update whose `project_dir` is another project returns permissionDecision: 'ask',
 *   so the user confirms a write that leaves the current project.
 * - For subagents calling read-only cortex tools, inject real host agent_id via updatedInput
 *   and NEVER return permissionDecision: 'allow'.
 * - For HEAD, strip any LLM-spoofed `_caller_agent_id`.
 * Any other tool call returns {} right away (the hook prints nothing).
 */
export function handleClaudePreToolUse(payload = {}, { globalDir } = {}) {
  const toolName = payload.tool_name || payload.toolName || '';
  const rawInput = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
    ? payload.tool_input
    : {};

  const hostAgentId = String(payload.agent_id || payload.agentId || '').trim();
  const callerIsSubagent = Boolean(hostAgentId) || isSubagentPayload(payload);

  if (!isCortexToolName(toolName)) {
    const cwd = extractCwd(payload, process.cwd());
    if (callerIsSubagent && subagentTouchesMemoryDir(toolName, rawInput, cwd)) {
      return preToolUseDecision('deny', SUBAGENT_MEMORY_DIR_DENY_REASON);
    }
    const askReason = trustChangeAskReason(toolName, rawInput, cwd, resolveCortexGlobalDir(globalDir));
    if (askReason) {
      return callerIsSubagent
        ? preToolUseDecision('deny', SUBAGENT_TRUST_CHANGE_DENY_REASON)
        : preToolUseDecision('ask', askReason);
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

function normalizeEventName(eventName) {
  return String(eventName || '').trim().toLowerCase();
}

export function runClaudeHook(eventName, payload = {}, options = {}) {
  switch (normalizeEventName(eventName)) {
    case 'session-start':
      return handleClaudeSessionStart(payload, options);
    case 'session-end':
      return handleClaudeSessionEnd(payload, options);
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

/**
 * What the hook process prints for a handler result:
 * - pre-compact: the instruction text itself (Claude Code reads plain stdout, not JSON), or nothing;
 * - session-end: nothing (the output of that event is ignored);
 * - every other event: the result as one line of JSON, or nothing when it is empty.
 */
export function renderClaudeHookStdout(eventName, output) {
  if (!output || typeof output !== 'object') return '';
  const event = normalizeEventName(eventName);
  if (event === 'pre-compact') {
    return typeof output.instructions === 'string' && output.instructions ? `${output.instructions}\n` : '';
  }
  if (event === 'session-end') return '';
  return Object.keys(output).length > 0 ? `${JSON.stringify(output)}\n` : '';
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
    // The index sync budget counts from the start of this process, not from here.
    const output = runClaudeHook(event, payload, { part, startedAt: Math.round(performance.timeOrigin) });
    const text = renderClaudeHookStdout(event, output);
    if (text) {
      process.stdout.write(text);
    }
  } catch {
    // Never block Claude Code CLI on hook error
  }
  process.exit(0);
}
