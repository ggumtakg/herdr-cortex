#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  assertInsideDir,
  atomicWriteJson,
  expandCortexRootPlaceholder,
  formatLegacyEmbeddingUserNotices,
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
  resolveWorkSizeConfig,
} from '../core/config.mjs';
import {
  HEAD_CORE_MAX_CHARS,
  HOOK_MAX_CHARS,
  fitOverviewToBudget,
  resolveHookBudget,
  sanitizeInline,
} from '../core/budget.mjs';
import { isWorkerSession } from '../core/role.mjs';
import {
  APPROVAL_STATE_FILE_NAMES,
  formatProjectNotApprovedNotice,
  formatProjectNotApprovedUserNotice,
  formatUnapprovedFolderNotice,
  formatUnapprovedFolderUserNotice,
  getAcknowledgedApprovalsPath,
  hasUnapprovedFolderNoticeRecord,
  isHomeOrRootFolder,
  recordUnapprovedFolderNotice,
} from '../core/trust.mjs';
import { checkApprovalsForSession, pruneApprovalCheckRecords } from './approvals-watch.mjs';
import {
  createShellInspectionBudget,
  formatConfirmCommandAskReason,
  formatConfirmCommandDenyReason,
  inspectConfirmableShellCommand,
} from './confirm-commands.mjs';
import {
  READ_ONLY_GIT_SUBCOMMANDS,
  READ_ONLY_SHELL_VERBS,
  isReadOnlyShellCommand,
} from './shell-read-only.mjs';
import {
  executableBaseName,
  extractNestedShellCommands,
  isCandidateCommandWord,
  normalizeShellKind,
  stripExeSuffix,
  tokenizeShellSegments,
} from './shell-tokens.mjs';
import {
  FILE_READ_TOOL_NAMES,
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
import { deliverInboxForHook, hasPendingDelegatedMessage } from '../relay/inbox.mjs';
import {
  EMPTY_MEMORY_NOTICE,
  formatUnindexedNotice,
  formatUnindexedUserNotice,
  loadHookOverview,
  resolveHookSyncOptions,
} from './overview.mjs';
import {
  RESTORE_FAILURE_NO_TURNS_WITHIN_CAP,
  RESTORE_FAILURE_RECORD_TOO_LARGE,
  extractClaudeRecentTurns,
  formatRecentTurns,
  hasClaudeSessionStartMarker,
} from './recent-turns.mjs';
import {
  WORK_SIZE_COMPLETED_NOTICE,
  clearTabDelegation,
  commandRunsGitCommit,
  consumeWorkSizeCompletedNotice,
  evaluateWorkSizeEdit,
  evaluateWorkSizePrompt,
  evaluateWorkSizeRead,
  getTabDelegation,
  getWorkSizeDir,
  getWorkSizeSessionNotice,
  isPathInsideMemoryDir,
  parseReviewVerdict,
  recordGitCommitForWorkSize,
  recordMemorySaveForWorkSize,
  recordReviewVerdict,
  recordShellResultForWorkSize,
  resetWorkSizeTurnCountersOnSessionStart,
  resolveWorkSizeProjectRoot,
  resolveWorkSizeScope,
} from './work-size.mjs';

export const CLAUDE_HOOK_MAX_CHARS = HOOK_MAX_CHARS;
export const CLAUDE_PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR';
export { EMPTY_MEMORY_NOTICE, HEAD_CORE_MAX_CHARS, WORK_SIZE_COMPLETED_NOTICE, isPathInsideMemoryDir };

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

export const WORK_COMMAND_DENY_REASON =
  '[herdr-cortex] Subagents and delegated workers must not release or reset herdr-cortex work-size state (`cortex-work`). '
  + 'Only the user may release or reset work-size limits.';

export const WORK_STATE_SHELL_DENY_REASON =
  '[herdr-cortex] Subagents and delegated workers must not modify or delete files in the herdr-cortex work-size state folder.';

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
/**
 * On /clear the old session's SessionEnd hook (which writes the clear record) runs to completion before the
 * new session's SessionStart hook is launched: measured on Claude Code 2.1.330, in one run. The wait remains
 * as a safety margin for other versions and for a SessionEnd hook that exceeds its time limit: when
 * SessionStart(clear) finds neither a previous session in the tab record nor a clear record, it looks again
 * every CLEAR_RECORD_POLL_MS for up to CLEAR_RECORD_WAIT_MS before it gives up. No other path waits.
 */
export const CLEAR_RECORD_WAIT_MS = 2000;
export const CLEAR_RECORD_POLL_MS = 100;

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

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

const FILE_READ_TOOLS = new Set(FILE_READ_TOOL_NAMES);
const FILE_WRITE_TOOLS = new Set(FILE_WRITE_TOOL_NAMES);
const SHELL_TOOLS = new Set(SHELL_TOOL_NAMES);

export function isWriteProtectedCortexBaseName(baseName, rawInput = {}) {
  if (WRITE_PROTECTED_CORTEX_TOOLS.has(baseName)) return true;
  if (baseName === 'relay_inbox') {
    const action = String(rawInput?.action || 'peek').trim().toLowerCase();
    return action === 'ack';
  }
  return false;
}

export function isWriteProtectedCortexCall(toolName, rawInput = {}) {
  return isWriteProtectedCortexBaseName(cortexToolBaseName(toolName), rawInput);
}

export { isCortexToolName };

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
// The approvals list and the acknowledged list (what a person confirmed in the dialog): a change to either
// one behind the dialog's back has to be seen.
const APPROVAL_FILE_NAMES = APPROVAL_STATE_FILE_NAMES.map((name) => name.toLowerCase());
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

// An approvals file name (`trusted-projects.json`, `trusted-projects.acknowledged.json`) inside a word: not
// part of a longer name on either side ("untrusted-projects.json" and "trusted-projects.jsonl" do not count;
// a ".bak" copy does).
function wordNamesApprovalsFile(word) {
  const lower = word.toLowerCase();
  for (const fileName of APPROVAL_FILE_NAMES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(fileName, from);
      if (at === -1) break;
      const before = at > 0 ? lower[at - 1] : undefined;
      const after = lower[at + fileName.length];
      if (!isNameChar(before) && before !== '.' && !isNameChar(after)) return true;
      from = at + 1;
    }
  }
  return false;
}

/**
 * Does a shell command line run the project-approval CLI (`cortex-trust`, `trust-cli.mjs`, `npm run trust`)
 * or name an approvals file (`trusted-projects.json`, `trusted-projects.acknowledged.json`)? Returns:
 * - 'approvals-file' : it names an approvals file and is not recognizably read-only, so it may change the
 *                      approvals behind the confirmation dialog's back;
 * - 'runs-cli'       : it runs the approval CLI in a way that may change approvals (or that cannot be told
 *                      apart from one that does). The CLI itself asks a person in a dialog before it approves;
 * - 'read-only'      : it only reads: a single plain `status` / `list` call of the CLI, or a command line
 *                      made of read-only programs only (`isReadOnlyShellCommand`: `cat`, `type`, `grep`,
 *                      `git diff`, ... without redirection), even though it names an approvals file or the
 *                      CLI's source file;
 * - ''               : neither.
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
  if (isReadOnlyShellCommand(command)) return 'read-only';
  if (namesApprovalsFile) return 'approvals-file';
  if (complex || invocations.length !== 1) return 'runs-cli';

  // One plain call: read-only only when the CLI's first argument is `status` or `list`.
  const args = words.slice(invocations[0] + 1).filter((w) => w !== '--' && w.toLowerCase() !== '--json');
  return args.length > 0 && TRUST_READ_ONLY_SUBCOMMANDS.has(args[0].toLowerCase()) ? 'read-only' : 'runs-cli';
}

function clipForReason(value, maxChars = 300) {
  const text = sanitizeInline(value);
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

export function formatTrustCommandAskReason(command) {
  return `[herdr-cortex] herdr-cortex project approvals are about to be changed by this command: "${clipForReason(command)}". `
    + 'Approvals decide which project folders\' .memory/ is read and written. Allow it only if you want that change.';
}

const WORK_COMMAND_NAMES = new Set([
  'cortex-work',
  'cortex-work.ps1',
  'cortex-work.cmd',
  'cortex-work.bat',
  'cortex-work.exe',
]);
const WORK_CLI_SCRIPT_NAME = 'cortex-work.mjs';

const NODE_OPTIONS_WITH_VALUE = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--input-type',
  '--env-file',
  '--env-file-if-exists',
  '--watch-path',
  '--redirect-warnings',
  '--diagnostic-dir',
  '--heapsnapshot-dir',
  '--cpu-prof-dir',
  '--heap-prof-dir',
  '--title',
  '--openssl-config',
  '--icu-data-dir',
]);

const NPM_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NPM_OPTS_WITH_VALUE = new Set(['--prefix', '-C', '--workspace', '-w', '--userconfig', '--globalconfig']);
const CORTEX_WORK_MENTION_RE = /(?:^|[^A-Za-z0-9_-])cortex-work(?=$|[^A-Za-z0-9_-])/i;

const READ_ONLY_UNSAFE_PREFIXES = Object.freeze({
  git: ['--output', '-O', '--open-files-in-pager', '--ext-diff'],
  rg: ['--pre', '--hostname-bin'],
  less: ['-o', '-O', '--log-file', '-k', '--lesskey', '+'],
  more: ['+'],
});

function wordNamesWorkCli(text) {
  const base = executableBaseName(text);
  return WORK_COMMAND_NAMES.has(base) || base === WORK_CLI_SCRIPT_NAME;
}

function segmentHasSubstitutionsOrRedirection(words) {
  for (const tok of words) {
    if (Array.isArray(tok.substitutions) && tok.substitutions.length > 0) return true;
    if (!tok.quoted && /[<>]/.test(tok.text)) return true;
  }
  return false;
}

function isReadOnlyWorkSegment(words) {
  if (words.length < 2 || segmentHasSubstitutionsOrRedirection(words)) return false;
  const first = words[0].text;
  if (!first || /[\\/]/.test(first)) return false;
  const verb = first.toLowerCase().replace(/\.exe$/, '');
  const args = words.slice(1).map((w) => w.text);
  const unsafe = READ_ONLY_UNSAFE_PREFIXES[verb] || [];
  if (args.some((arg) => unsafe.some((prefix) => arg.startsWith(prefix)))) return false;
  if (verb === 'git') {
    return args.length > 0 && SHELL_GUARD_READ_ONLY_GIT.has(args[0].toLowerCase())
      && !args.some((a) => /=.*cortex-work/i.test(a));
  }
  return SHELL_GUARD_READ_ONLY_VERBS.has(verb);
}

function classifyWorkCliArgs(rawArgs) {
  const subcommands = [];
  let sawHelp = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const tok = rawArgs[i];
    const arg = tok.text;
    if ((Array.isArray(tok.substitutions) && tok.substitutions.length > 0) || /[$%<>]/.test(arg)) {
      return 'runs-cli';
    }
    const lower = arg.toLowerCase();
    if (arg === '--' || lower === '--json' || lower === '--all') continue;
    if (lower === '--help' || lower === '-h') {
      sawHelp = true;
      continue;
    }
    if (lower === '--tab') {
      if (i + 1 >= rawArgs.length) return 'runs-cli';
      const tabTok = rawArgs[++i];
      if ((Array.isArray(tabTok.substitutions) && tabTok.substitutions.length > 0) || /[$%<>]/.test(tabTok.text)) {
        return 'runs-cli';
      }
      continue;
    }
    if (lower.startsWith('--tab=')) continue;
    if (arg.startsWith('-')) return 'runs-cli';
    subcommands.push(lower);
  }

  if (sawHelp && (subcommands.length === 0 || (subcommands.length === 1 && subcommands[0] === 'status'))) {
    return 'read-only';
  }
  return subcommands.length === 1 && subcommands[0] === 'status' ? 'read-only' : 'runs-cli';
}

function findNpmWorkArgs(words, runnerIdx) {
  const runnerBare = stripExeSuffix(executableBaseName(words[runnerIdx].text));
  let idx = runnerIdx + 1;
  while (idx < words.length) {
    const arg = words[idx].text;
    if (NPM_OPTS_WITH_VALUE.has(arg)) {
      idx += 2;
      continue;
    }
    if (arg.startsWith('-')) {
      idx++;
      continue;
    }
    break;
  }
  if (idx >= words.length) return null;
  const sub = words[idx].text.toLowerCase();
  if ((sub === 'run' || sub === 'run-script') && words[idx + 1]?.text.toLowerCase() === 'work') {
    return words.slice(idx + 2);
  }
  if ((runnerBare === 'yarn' || runnerBare === 'pnpm') && sub === 'work') {
    return words.slice(idx + 1);
  }
  return null;
}

function isNonExecutingFileArgSegment(words, workWordIndices) {
  if (words.length < 2 || segmentHasSubstitutionsOrRedirection(words)) return false;
  if (workWordIndices.some((idx) => idx === 0)) return false;
  if (!isCandidateCommandWord(words, 0)) return false;

  const headBase = executableBaseName(words[0].text);
  const headBare = stripExeSuffix(headBase);

  // 1. Any `git` subcommand (`git add scripts/cortex-work.mjs`, `git rm --cached ...`, etc.)
  if (headBase === 'git' || headBase === 'git.exe') {
    for (let i = 1; i < words.length; i++) {
      const t = words[i].text;
      if (t === '-c' || t === '--exec' || t.startsWith('--exec=')) {
        if (CORTEX_WORK_MENTION_RE.test(t) || CORTEX_WORK_MENTION_RE.test(words[i + 1]?.text || '')) return false;
      }
      if (/=.*cortex-work/i.test(t)) return false;
    }
    return workWordIndices.every((idx) => !words[idx].text.startsWith('-'));
  }

  // 2. Syntax check only: `node --check scripts/cortex-work.mjs` / `node -c scripts/cortex-work.mjs`
  if (headBare === 'node') {
    let sawCheck = false;
    for (let i = 1; i < words.length; i++) {
      const tok = words[i];
      const arg = tok.text;
      if (!tok.quoted && arg === '--') break;
      if (arg === '--check' || arg === '-c') {
        sawCheck = true;
        continue;
      }
      if (
        arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print'
        || arg.startsWith('--eval=') || arg.startsWith('--print=')
        || NODE_OPTIONS_WITH_VALUE.has(arg)
        || arg.startsWith('--require=') || arg.startsWith('--import=') || arg.startsWith('--loader=')
      ) {
        return false;
      }
      if (arg.startsWith('-')) continue;
      break;
    }
    return sawCheck && workWordIndices.every((idx) => !words[idx].text.startsWith('-'));
  }

  // 3. Editor open: `code scripts/cortex-work.mjs`
  if (headBare === 'code' || headBare === 'code-insiders') {
    return workWordIndices.every((idx) => !words[idx].text.startsWith('-'));
  }

  return false;
}

function classifyPlainWorkStatusSegment(words, workWordIndices) {
  if (segmentHasSubstitutionsOrRedirection(words)) return '';
  let headIdx = 0;
  if (words[0] && !words[0].quoted && words[0].text === '&') headIdx = 1;
  if (headIdx >= words.length || !isCandidateCommandWord(words, headIdx)) return '';

  const headBase = executableBaseName(words[headIdx].text);
  const headBare = stripExeSuffix(headBase);

  // Direct `cortex-work status` / `cortex-work --help`
  if (workWordIndices.length === 1 && workWordIndices[0] === headIdx && wordNamesWorkCli(words[headIdx].text)) {
    return classifyWorkCliArgs(words.slice(headIdx + 1));
  }

  // `node [--no-warnings ...] scripts/cortex-work.mjs status` / `bun scripts/cortex-work.mjs status`
  if (workWordIndices.length === 1 && (headBare === 'node' || headBare === 'bun')) {
    let idx = headIdx + 1;
    while (idx < words.length) {
      const tok = words[idx];
      const arg = tok.text;
      if (!tok.quoted && arg === '--') {
        idx++;
        break;
      }
      if (
        arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print'
        || arg.startsWith('--eval=') || arg.startsWith('--print=')
        || NODE_OPTIONS_WITH_VALUE.has(arg)
        || arg.startsWith('--require=') || arg.startsWith('--import=') || arg.startsWith('--loader=')
      ) {
        return 'runs-cli';
      }
      if (arg.startsWith('-')) {
        idx++;
        continue;
      }
      break;
    }
    if (idx === workWordIndices[0] && executableBaseName(words[idx].text) === WORK_CLI_SCRIPT_NAME) {
      return classifyWorkCliArgs(words.slice(idx + 1));
    }
  }

  return '';
}

function inspectSegmentWorkInvocation(words) {
  if (words.length === 0) return '';

  // Inline JS evaluation (`node -e "import('./scripts/cortex-work.mjs')"`) or `Start-Process` arg list
  for (let i = 0; i < words.length; i++) {
    if (!isCandidateCommandWord(words, i)) continue;
    const bare = stripExeSuffix(executableBaseName(words[i].text));
    if (bare === 'node' || bare === 'bun') {
      for (let j = i + 1; j < words.length; j++) {
        const a = words[j].text;
        if (!words[j].quoted && a === '--') break;
        if ((a === '-e' || a === '--eval' || a === '-p' || a === '--print' || NODE_OPTIONS_WITH_VALUE.has(a))
          && CORTEX_WORK_MENTION_RE.test(words[j + 1]?.text || '')) {
          return 'runs-cli';
        }
        if ((a.startsWith('--eval=') || a.startsWith('--print=') || a.startsWith('--require=') || a.startsWith('--import=') || a.startsWith('--loader='))
          && CORTEX_WORK_MENTION_RE.test(a)) {
          return 'runs-cli';
        }
      }
    }
    if (bare === 'start-process' || bare === 'saps') {
      const restText = words.slice(i + 1).map((w) => w.text).join(' ');
      if (CORTEX_WORK_MENTION_RE.test(restText)) return 'runs-cli';
    }
  }

  // `npm run work` / `pnpm work` / `yarn work` / `bun run work` anywhere in the segment
  let npmWorkResult = '';
  for (let i = 0; i < words.length; i++) {
    if (!isCandidateCommandWord(words, i)) continue;
    const bare = stripExeSuffix(executableBaseName(words[i].text));
    if (!NPM_RUNNERS.has(bare)) continue;
    const workArgs = findNpmWorkArgs(words, i);
    if (!workArgs) continue;
    const headOnly = i === 0 || (i === 1 && !words[0].quoted && words[0].text === '&');
    if (!headOnly || segmentHasSubstitutionsOrRedirection(words)) return 'runs-cli';
    const res = classifyWorkCliArgs(workArgs);
    if (res === 'runs-cli') return 'runs-cli';
    npmWorkResult = res;
  }

  // Find every word in the segment that names `cortex-work` / `cortex-work.mjs`
  const hasReleaseOrReset = words.some((w) => !w.quoted && /^(?:release|reset)$/i.test(w.text));
  const headBare0 = words[0] ? stripExeSuffix(executableBaseName(words[0].text)) : '';
  const workWordIndices = [];
  for (let i = 0; i < words.length; i++) {
    if (!wordNamesWorkCli(words[i].text)) continue;
    // Wholly-quoted literal argument (`echo "cortex-work"`, `git commit -m "cortex-work"`) when not at
    // command position, not passed as script to `node`/`bun`, and without `release`/`reset` in segment
    if (
      words[i].whollyQuoted
      && !isCandidateCommandWord(words, i)
      && !hasReleaseOrReset
      && headBare0 !== 'node'
      && headBare0 !== 'bun'
    ) {
      continue;
    }
    // Partial-quote obfuscation (`cortex-wo''rk`) is outside unquoted-word matching (known limitation)
    if (words[i].quoted && !words[i].whollyQuoted) {
      continue;
    }
    workWordIndices.push(i);
  }

  if (workWordIndices.length === 0) {
    return npmWorkResult;
  }

  // Exception: read-only command inspecting the file (`cat`, `Get-Content`, `git diff`, `grep`, ...)
  if (isReadOnlyWorkSegment(words)) {
    return 'read-only';
  }

  // `release` / `reset` in the same segment always triggers regardless of leading words
  if (hasReleaseOrReset) {
    return 'runs-cli';
  }

  // Exception: file-path argument to a known non-executing command (`git` subcommands, `node --check`, `code`)
  if (isNonExecutingFileArgSegment(words, workWordIndices)) {
    return npmWorkResult;
  }

  // Exception: plain `status` / `--help` invocation
  const plainStatus = classifyPlainWorkStatusSegment(words, workWordIndices);
  if (plainStatus === 'read-only') {
    return 'read-only';
  }

  // Default (HEAD baseline): any other non-read-only mention of `cortex-work` triggers `runs-cli`
  return 'runs-cli';
}

function consumeHookShellStep(budget, count = 1) {
  if (!budget) return false;
  if (budget.exceeded) return true;
  budget.steps += count;
  if (budget.steps > budget.maxSteps) {
    budget.exceeded = true;
    return true;
  }
  return false;
}

function classifyWorkCommandRecursive(command, { shell = '', depth = 0, budget = null } = {}) {
  if (typeof command !== 'string' || !command.trim()) return '';
  if (depth > 4 || consumeHookShellStep(budget)) {
    return CORTEX_WORK_MENTION_RE.test(command) ? 'runs-cli' : '';
  }

  let sawReadOnly = false;
  const segments = tokenizeShellSegments(command, { shell, budget });
  if (budget?.exceeded) {
    return CORTEX_WORK_MENTION_RE.test(command) ? 'runs-cli' : '';
  }

  for (const words of segments) {
    let candidateCount = 0;
    for (let i = 0; i < words.length; i++) {
      if (isCandidateCommandWord(words, i)) candidateCount++;
    }
    if (candidateCount > 0 && consumeHookShellStep(budget, candidateCount)) {
      return CORTEX_WORK_MENTION_RE.test(command) ? 'runs-cli' : '';
    }

    const direct = inspectSegmentWorkInvocation(words);
    if (direct === 'runs-cli') return 'runs-cli';
    if (direct === 'read-only') sawReadOnly = true;

    for (const nested of extractNestedShellCommands(words, shell)) {
      const nestedRes = classifyWorkCommandRecursive(nested.command, {
        shell: nested.shell,
        depth: depth + 1,
        budget,
      });
      if (nestedRes === 'runs-cli') return 'runs-cli';
      if (nestedRes === 'read-only') sawReadOnly = true;
      if (budget?.exceeded) {
        return CORTEX_WORK_MENTION_RE.test(command) ? 'runs-cli' : '';
      }
    }
  }
  return sawReadOnly ? 'read-only' : '';
}

const SHELL_GUARD_READ_ONLY_VERBS = new Set(READ_ONLY_SHELL_VERBS);
const SHELL_GUARD_READ_ONLY_GIT = new Set(READ_ONLY_GIT_SUBCOMMANDS);

export function isShellGuardReadOnly(command, shell = '') {
  if (!isReadOnlyShellCommand(command)) return false;
  const shellKind = normalizeShellKind(shell);
  // `splitPlainCommands` does not interpret Bash unquoted `\'` / `\"` or ANSI-C `$'...'` escapes;
  // verify every tokenized segment still starts with a read-only verb when those forms appear.
  if ((shellKind === 'bash' || !shellKind) && /\\['"]|\$'/.test(command)) {
    const segments = tokenizeShellSegments(command, { shell: 'bash' });
    if (segments.length === 0) return false;
    for (const words of segments) {
      if (words.some((w) => Array.isArray(w.substitutions) && w.substitutions.length > 0)) return false;
      const first = words[0]?.text || '';
      if (!first || /[\\/]/.test(first)) return false;
      const verb = first.toLowerCase().replace(/\.exe$/, '');
      if (verb === 'git') {
        const sub = words[1]?.text.toLowerCase() || '';
        if (!SHELL_GUARD_READ_ONLY_GIT.has(sub)) return false;
      } else if (!SHELL_GUARD_READ_ONLY_VERBS.has(verb)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Classify a shell command line that invokes `cortex-work` (`scripts/cortex-work.mjs`):
 * - 'runs-cli'  : non-read-only mention or execution of `cortex-work` not covered by the explicit safe
 *                 exceptions below (`ask` for main, `deny` for subagent/worker);
 * - 'read-only' : plain `cortex-work status` / `--help`, or read-only inspection (`cat`, `Get-Content`, `git diff`, ...);
 * - ''          : does not invoke `cortex-work` (quoted text, or file-path argument to `git` / `node --check` / `code`).
 */
export function classifyWorkCommand(command, { shell = '', budget = null } = {}) {
  if (typeof command !== 'string' || !command.trim()) return '';
  if (!/cortex-work|\b(?:npm|pnpm|yarn|bun)\b/i.test(command) && !/['"\\`^]/.test(command)) return '';

  const effectiveBudget = budget || createShellInspectionBudget();
  const shellKind = normalizeShellKind(shell);
  let invocation = classifyWorkCommandRecursive(command, { shell: shellKind, depth: 0, budget: effectiveBudget });
  if (
    invocation !== 'runs-cli'
    && !effectiveBudget.exceeded
    && !shellKind
    && /[`\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u2013\u2014\u2015]/.test(command)
  ) {
    const pwshInvocation = classifyWorkCommandRecursive(command, { shell: 'powershell', depth: 0, budget: effectiveBudget });
    if (pwshInvocation === 'runs-cli') return 'runs-cli';
    if (!invocation && pwshInvocation) invocation = pwshInvocation;
  }
  if (invocation) return invocation;
  if (CORTEX_WORK_MENTION_RE.test(command) && isShellGuardReadOnly(command, shellKind)) return 'read-only';
  return '';
}

export function formatWorkCommandAskReason(command) {
  return `[herdr-cortex] 작업 규모(S/L) 상태를 바꾸는 명령입니다: "${clipForReason(command)}". `
    + '사용자가 직접 풀려는 경우에만 허용하세요.';
}

const SHELL_WORK_SIZE_DIR_RE = /(?:^|[^A-Za-z0-9_-])state\.*[\\/]+work-size\.*(?=$|[^A-Za-z0-9_-])/i;

function rawTextReferencesWorkSizeState(text, dirForms) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (SHELL_WORK_SIZE_DIR_RE.test(text)) return true;

  const haystack = process.platform === 'win32' ? text.toLowerCase() : text;
  for (const rawForm of dirForms) {
    const variants = [rawForm, rawForm.replace(/\\/g, '/'), rawForm.replace(/\//g, '\\')];
    for (const candidate of variants) {
      if (!candidate) continue;
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(candidate, from);
        if (at === -1) break;
        const after = haystack[at + candidate.length];
        if (!isNameChar(after)) return true;
        from = at + 1;
      }
    }
  }
  return false;
}

function segmentsReferenceWorkSizeState(command, dirForms, shellKind, depth = 0, budget = null) {
  if (depth > 4 || typeof command !== 'string' || !command.trim()) return false;
  if (consumeHookShellStep(budget)) return false;
  for (const words of tokenizeShellSegments(command, { shell: shellKind, budget })) {
    for (const tok of words) {
      if (rawTextReferencesWorkSizeState(tok.text, dirForms)) return true;
      if (Array.isArray(tok.substitutions)) {
        for (const sub of tok.substitutions) {
          if (
            rawTextReferencesWorkSizeState(sub, dirForms)
            || segmentsReferenceWorkSizeState(sub, dirForms, shellKind || 'bash', depth + 1, budget)
          ) {
            return true;
          }
        }
      }
    }
    if (budget?.exceeded) return false;
  }
  return false;
}

/**
 * Heuristic: does a shell command line reference the work-size state folder (either by `state/work-size` /
 * `state\work-size` notation or by `<globalDir>/state/work-size` real/written path)?
 */
export function commandReferencesWorkSizeState(command, globalDir, { shell = '', budget = null } = {}) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const dirForms = comparablePaths(getWorkSizeDir(globalDir));
  if (rawTextReferencesWorkSizeState(command, dirForms)) return true;

  // When quotes, backslashes, or backticks are present, also inspect unescaped token text and substitutions
  // so inline escapes or line continuations inside the path cannot hide `state/work-size`.
  if (/['"\\`]/.test(command)) {
    const effectiveBudget = budget || createShellInspectionBudget();
    const shellKind = normalizeShellKind(shell);
    if (segmentsReferenceWorkSizeState(command, dirForms, shellKind || 'bash', 0, effectiveBudget)) return true;
    if (
      !effectiveBudget.exceeded
      && !shellKind
      && command.includes('`')
      && segmentsReferenceWorkSizeState(command, dirForms, 'powershell', 0, effectiveBudget)
    ) {
      return true;
    }
  }
  return false;
}

export function formatWorkSizeStateShellAskReason(command) {
  return `[herdr-cortex] 작업 규모(S/L) 상태 폴더를 건드리는 명령입니다: "${clipForReason(command)}". `
    + '사용자가 직접 상태를 정리하려는 경우에만 허용하세요.';
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

export function inspectStateFilePath(targetPath, cwd, globalDir) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;
  const resolved = path.resolve(cwd || process.cwd(), targetPath.trim());
  const stateForms = comparablePaths(getTierPaths(globalDir).stateDir);
  const approvalsForms = new Set([
    ...comparablePaths(getTrustedProjectsPath(globalDir)),
    ...comparablePaths(getAcknowledgedApprovalsPath(globalDir)),
  ]);
  const forms = comparablePaths(resolved);
  const approvalsFile = forms.some((form) => approvalsForms.has(form));
  const insideState = forms.some((form) => stateForms.some((dir) => form === dir || form.startsWith(`${dir}${path.sep}`)));
  return approvalsFile || insideState ? { path: resolved, approvalsFile } : null;
}

/**
 * The file a Write / Edit / MultiEdit / NotebookEdit call targets when it lies in <globalDir>/state/
 * ({ path, approvalsFile }), or null. Compared as written and by real path.
 */
function stateFileWriteTarget(toolName, rawInput, cwd, globalDir) {
  if (!FILE_WRITE_TOOLS.has(typeof toolName === 'string' ? toolName.trim() : '')) return null;
  for (const target of [rawInput.file_path, rawInput.notebook_path]) {
    const hit = inspectStateFilePath(target, cwd, globalDir);
    if (hit) return hit;
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
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    now = Date.now,
  } = {},
) {
  if (isSubagentPayload(payload) || isWorkerSession({ env })) return {};
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

function readHeadCore(promptsDir, config, repoRoot = REPO_ROOT) {
  if (config.headCoreEnabled === false) return '';
  const corePath = path.join(promptsDir, 'HEAD_CORE.md');
  try {
    if (!fs.existsSync(corePath)) return '';
    return expandCortexRootPlaceholder(fs.readFileSync(corePath, 'utf8'), repoRoot).trim();
  } catch {
    return '';
  }
}

function extractHeadCoreMarker(headCore) {
  if (typeof headCore !== 'string') return '';
  for (const rawLine of headCore.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line) return line;
  }
  return '';
}

function trimLinesToBudget(text, budget) {
  if (!text || budget <= 0) return '';
  if (text.length <= budget) return text;
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

/** Most characters of one hook's `systemMessage` (Claude Code caps the field at 10,000). */
export const USER_NOTICE_MAX_CHARS = 2000;

// One line per notice; a notice never brings line breaks of its own.
function joinUserNotices(notices) {
  const text = notices
    .map((notice) => String(notice || '').replace(/\s*[\r\n]+\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return text.length > USER_NOTICE_MAX_CHARS ? `${text.slice(0, USER_NOTICE_MAX_CHARS - 3)}...` : text;
}

function resolveClaudeNotApprovedNotice(projectDir, { projectTrusted, part, worker, globalDir, homeDir, env }) {
  if (projectTrusted || part === 'core') {
    return { contextText: '', userText: '', recordOnce: false };
  }
  if (hasProjectMemoryDir(projectDir)) {
    return {
      contextText: formatProjectNotApprovedNotice(projectDir),
      userText: formatProjectNotApprovedUserNotice(projectDir),
      recordOnce: false,
    };
  }
  if (
    !worker
    && !isHomeOrRootFolder(projectDir, { homeDir, env })
    && !hasUnapprovedFolderNoticeRecord(projectDir, { globalDir })
  ) {
    return {
      contextText: formatUnapprovedFolderNotice(projectDir),
      userText: formatUnapprovedFolderUserNotice(projectDir),
      recordOnce: true,
    };
  }
  return { contextText: '', userText: '', recordOnce: false };
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
 * `now` and `sleep` are the clock and the wait used while looking for a clear record (see
 * CLEAR_RECORD_WAIT_MS); `clearRecordWaitMs` / `clearRecordPollMs` override the two constants.
 *
 * Besides `hookSpecificOutput.additionalContext` (read by the model, not shown to the user) the result can
 * carry a top-level `systemMessage`, which Claude Code shows to the user: one compact line for each thing
 * the user should know about - project memory not loaded (folder not approved), documents not indexed yet,
 * recent turns not restored, approvals changed without the confirmation dialog. Routine output never goes
 * there.
 */
export function handleClaudeSessionStart(
  payload = {},
  {
    part = 'all',
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    homeDir,
    legacyHome,
    repoRoot = REPO_ROOT,
    promptsDir = path.join(repoRoot, 'prompts'),
    startedAt,
    indexBudget,
    turnOptions,
    now = Date.now,
    sleep = sleepSync,
    clearRecordWaitMs = CLEAR_RECORD_WAIT_MS,
    clearRecordPollMs = CLEAR_RECORD_POLL_MS,
  } = {},
) {
  if (isSubagentPayload(payload)) {
    return {};
  }

  const worker = isWorkerSession({ env });
  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const effectiveHomeDir = homeDir || ((env?.HERDR_CORTEX_TEST_HOME || env?.HERDR_REVIVE_TEST_HOME) ? '' : legacyHome);
  const projectDir = extractCwd(payload, process.cwd());
  const config = loadConfig({ projectDir, globalDir: effectiveGlobalDir });
  const maxChars = resolveHookBudget(config);
  const source = String(payload.source || '').trim().toLowerCase();

  // Record revive session once (skip on worker sessions and split part="core", which runs in parallel with "context")
  const sessionRec = !worker && part !== 'core'
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

  // `part === 'core'` emits ONLY `HEAD_CORE` under its own `HEAD_CORE_MAX_CHARS` cap, with zero side effects
  // (session recording, index sync, relay inbox, approval checks, or `systemMessage` all belong to `context`).
  if (part === 'core') {
    if (worker) return {};
    const headCore = readHeadCore(promptsDir, config, repoRoot);
    if (!headCore) return {};
    const marker = extractHeadCoreMarker(headCore);
    const transcriptPath = payload.transcript_path || payload.transcriptPath;
    const skipDuplicateHeadCore = (source === 'resume' || source === 'fork')
      && Boolean(marker)
      && hasClaudeSessionStartMarker(
        transcriptPath,
        marker,
        turnOptions && typeof turnOptions === 'object' ? turnOptions : undefined,
      );
    if (skipDuplicateHeadCore) return {};
    const trimmed = trimLinesToBudget(headCore, HEAD_CORE_MAX_CHARS);
    if (!trimmed) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: trimmed,
      },
    };
  }

  // Nothing from the project's .memory/ is read, injected or created until the user approved the folder.
  // When .memory/ exists, every session says so; without .memory/, non-worker sessions say so once per folder.
  const projectTrusted = isProjectTrusted(projectDir, { globalDir: effectiveGlobalDir });
  const notApproved = resolveClaudeNotApprovedNotice(projectDir, {
    projectTrusted,
    part,
    worker,
    globalDir: effectiveGlobalDir,
    homeDir: effectiveHomeDir,
    env,
  });
  const mandatoryNotApproved = !notApproved.recordOnce ? notApproved.contextText : '';
  const oneTimeCandidate = notApproved.recordOnce ? notApproved.contextText : '';

  // Lines for the user's own screen (`systemMessage`); see the function comment.
  const userNotices = [];
  if (mandatoryNotApproved) userNotices.push(notApproved.userText);

  // Approvals changed without the confirmation dialog: announced once per session and change.
  pruneApprovalCheckRecords(effectiveGlobalDir);
  const approvalsNotice = checkApprovalsForSession({ globalDir: effectiveGlobalDir, sessionId: extractSessionId(payload) });
  const approvalsContext = approvalsNotice ? approvalsNotice.contextText : '';

  const sections = [];
  let used = 0;

  const pushSection = (text) => {
    if (!text || !text.trim()) return;
    const sep = sections.length > 0 ? 2 : 0;
    sections.push(text.trim());
    used += sep + text.trim().length;
  };

  const mandatoryReserve = (mandatoryNotApproved ? mandatoryNotApproved.length + 2 : 0)
    + (approvalsContext ? approvalsContext.length + 2 : 0);

  let headCoreToInject = '';
  let headCoreReinjectedOnStart = false;
  if (!worker) {
    const headCore = readHeadCore(promptsDir, config, repoRoot);
    if (headCore) {
      const marker = extractHeadCoreMarker(headCore);
      const transcriptPath = payload.transcript_path || payload.transcriptPath;
      const skipDuplicateHeadCore = (source === 'resume' || source === 'fork')
        && Boolean(marker)
        && hasClaudeSessionStartMarker(
          transcriptPath,
          marker,
          turnOptions && typeof turnOptions === 'object' ? turnOptions : undefined,
        );
      if (!skipDuplicateHeadCore) {
        headCoreReinjectedOnStart = true;
        if (part === 'all') {
          headCoreToInject = headCore;
        }
      }
    }
  }

  let includeOneTimeNotice = false;
  if (oneTimeCandidate) {
    const neededWithMandatory = oneTimeCandidate.length + (approvalsContext ? 2 + approvalsContext.length : 0);
    if (neededWithMandatory <= maxChars) {
      if (!headCoreToInject) {
        includeOneTimeNotice = true;
      } else {
        const baseTrimmed = trimLinesToBudget(headCoreToInject, maxChars - mandatoryReserve);
        const withNoticeTrimmed = trimLinesToBudget(
          headCoreToInject,
          maxChars - mandatoryReserve - (oneTimeCandidate.length + 2),
        );
        includeOneTimeNotice = !baseTrimmed || Boolean(withNoticeTrimmed);
      }
    }
  }

  // 1. HEAD_CORE.md (in legacy unified 'all' mode); skipped in worker sessions and on resume/fork when already injected
  if (part === 'all' && headCoreToInject) {
    const noticeReserve = mandatoryReserve + (includeOneTimeNotice ? oneTimeCandidate.length + 2 : 0);
    pushSection(trimLinesToBudget(headCoreToInject, maxChars - noticeReserve));
  }

  if (mandatoryNotApproved) {
    pushSection(mandatoryNotApproved);
  } else if (includeOneTimeNotice) {
    pushSection(oneTimeCandidate);
    userNotices.push(notApproved.userText);
    try {
      recordUnapprovedFolderNotice(projectDir, { globalDir: effectiveGlobalDir });
    } catch {
      // ignore state write errors in hook
    }
  }
  if (approvalsNotice) {
    userNotices.push(approvalsNotice.userText);
  }
  if (approvalsContext) {
    pushSection(approvalsContext);
  }
  userNotices.push(...formatLegacyEmbeddingUserNotices(config));

  const sepCost = (n) => (sections.length + n > 0 ? 2 : 0);
  // A one-line note is added only when it fits; it is counted like every other section.
  const pushNote = (text) => {
    if (text && used + sepCost(0) + text.length <= maxChars) pushSection(text);
  };

  const sessionNowMs = Number(typeof now === 'function' ? now() : now) || Date.now();
  const sessionNowDate = new Date(sessionNowMs);
  if (!worker && isValidTerminalId(terminalId) && (source === 'startup' || source === 'clear')) {
    try {
      clearTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: sessionNowDate });
    } catch {
      // Never block SessionStart on work-size state errors.
    }
  }

  const delegatedForStart = !worker && isValidTerminalId(terminalId)
    ? (
        Boolean(getTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: sessionNowDate }))
        || hasPendingDelegatedMessage(terminalId, { globalDir: effectiveGlobalDir })
      )
    : false;

  if (!worker && !delegatedForStart) {
    try {
      const sessionId = extractSessionId(payload);
      const loadConfigForRoot = (root) => (
        projectPathKey(root) === projectPathKey(resolveProjectRoot(projectDir))
          ? config
          : loadConfig({ projectDir: root, globalDir: effectiveGlobalDir })
      );
      if (headCoreReinjectedOnStart) {
        resetWorkSizeTurnCountersOnSessionStart({
          cwd: projectDir,
          env,
          projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
          globalDir: effectiveGlobalDir,
          terminalId,
          sessionId,
          config,
          loadConfigForRoot,
          isEnabledForRoot: isProjectEnabled,
          now: sessionNowDate,
        });
      }
      const workSizeNotice = getWorkSizeSessionNotice({
        cwd: projectDir,
        env,
        projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
        globalDir: effectiveGlobalDir,
        terminalId,
        sessionId,
        config,
        loadConfigForRoot,
        isEnabledForRoot: isProjectEnabled,
      });
      pushNote(workSizeNotice);
    } catch {
      // Never block SessionStart on work-size state read/write errors.
    }
  }

  const wantsRecentTurns = !worker && (source === 'compact' || source === 'clear') && Boolean(payload.transcript_path || payload.transcriptPath);

  // The index is synced under a time budget: documents that do not fit are left to the MCP server and
  // named in a short notice, everything else is injected as usual.
  const { overview, unindexed, syncFailed } = loadHookOverview({
    projectDir,
    globalDir: effectiveGlobalDir,
    config,
    projectTrusted,
    syncOptions: resolveHookSyncOptions({ startedAt, indexBudget }),
  });
  if (unindexed.length > 0) {
    pushSection(formatUnindexedNotice(unindexed, { maxChars: maxChars - used - sepCost(0) }));
    userNotices.push(formatUnindexedUserNotice(unindexed));
  }
  const wantsEmptyMemoryNotice = !overview && unindexed.length === 0 && !syncFailed && !worker && projectTrusted;

  // 2. Budget-first relay inbox delivery. The inbox belongs to the terminal and lives in the global store,
  // so it is delivered whether or not the current project is approved (an excluded project returned above).
  // Only messages injected in full are acknowledged; one that is too long for any hook block is announced once.
  if (!worker && isValidTerminalId(terminalId)) {
    const remaining = maxChars - used - sepCost(0);
    if (remaining >= 120) {
      try {
        let inboxBudget = remaining;
        if (overview || wantsRecentTurns) {
          inboxBudget = Math.min(2000, Math.max(300, Math.floor(remaining * 0.35)));
        } else if (wantsEmptyMemoryNotice && remaining >= 120 + EMPTY_MEMORY_NOTICE.length + 2) {
          inboxBudget = remaining - (EMPTY_MEMORY_NOTICE.length + 2);
        }
        const delivered = deliverInboxForHook(terminalId, {
          globalDir: effectiveGlobalDir,
          projectDir,
          maxChars: Math.min(inboxBudget, remaining),
          // UserPromptSubmit gives the inbox the whole hook budget: what fits there waits for it.
          fullBlockChars: maxChars,
          nowMs: sessionNowMs,
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
        : Math.min(4500, remaining - (wantsEmptyMemoryNotice && remaining >= 400 + EMPTY_MEMORY_NOTICE.length + 2 ? EMPTY_MEMORY_NOTICE.length + 2 : 0));
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
          const readClock = () => Number(typeof now === 'function' ? now() : now) || Date.now();
          const lookForRecord = () => findClearedSession({
            globalDir: effectiveGlobalDir,
            projectDir,
            terminalId,
            newSessionId: extractSessionId(payload),
            currentTranscript: resolvedCurrent,
            nowMs: readClock(),
          });
          let found = lookForRecord();
          // The SessionEnd hook of the cleared session may still be writing its record: look again for a
          // short while. Only this path waits (no previous session known, no record yet).
          // The wait is counted in time slept, so it ends after the limit whatever clock was injected.
          const waitLimitMs = Math.max(0, Number(clearRecordWaitMs) || 0);
          const pollMs = Math.max(1, Number(clearRecordPollMs) || CLEAR_RECORD_POLL_MS);
          let waitedMs = 0;
          while (found.status === 'none' && typeof sleep === 'function' && waitedMs < waitLimitMs) {
            const step = Math.min(pollMs, waitLimitMs - waitedMs);
            sleep(step);
            waitedMs += step;
            found = lookForRecord();
          }
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
    if (turnsNote) userNotices.push(turnsNote);
  }

  // 4. Non-truncating FIT_STEPS memory overview (or one-line empty-memory notice in approved projects)
  if (overview) {
    const reserveForRecent = recentTurnsText ? recentTurnsText.length + 2 : 0;
    const overviewBudget = maxChars - used - sepCost(0) - reserveForRecent;
    if (overviewBudget >= 120) {
      const fitted = fitOverviewToBudget(overview, overviewBudget);
      if (fitted.text) {
        pushSection(fitted.text);
      }
    }
  } else if (wantsEmptyMemoryNotice) {
    const reserveForRecent = recentTurnsText ? recentTurnsText.length + 2 : 0;
    if (used + sepCost(0) + EMPTY_MEMORY_NOTICE.length + reserveForRecent <= maxChars) {
      pushSection(EMPTY_MEMORY_NOTICE);
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

  const output = {};
  if (sections.length > 0) {
    output.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: sections.join('\n\n'),
    };
  }
  if (userNotices.length > 0) {
    output.systemMessage = joinUserNotices(userNotices);
  }
  return output;
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
 * Claude Code UserPromptSubmit handler:
 * - checks whether the approvals list was changed without the confirmation dialog since this session last
 *   looked (two `stat` calls and one small read on an ordinary prompt). A new change is announced once: to
 *   the user through `systemMessage`, to the model through `additionalContext`;
 * - delivers the relay inbox of HC_TERMINAL_ID. The inbox is the terminal's (global store), so delivery does
 *   not depend on the current project having a `.memory/` or being approved.
 * A project excluded by the configuration gets nothing.
 */
export function handleClaudeUserPrompt(
  payload = {},
  {
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    now = Date.now,
  } = {},
) {
  if (isSubagentPayload(payload)) {
    return {};
  }

  const worker = isWorkerSession({ env });
  const projectDir = extractCwd(payload, process.cwd());
  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const config = loadConfig({ projectDir, globalDir: effectiveGlobalDir });
  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }
  const maxChars = resolveHookBudget(config);

  const sessionId = extractSessionId(payload);
  const approvalsNotice = checkApprovalsForSession({
    globalDir: effectiveGlobalDir,
    sessionId,
  });
  const contextParts = [];
  let used = 0;
  const pushContextPart = (text) => {
    if (!text) return;
    const sep = contextParts.length > 0 ? 2 : 0;
    if (used + sep + text.length > maxChars) return;
    contextParts.push(text);
    used += sep + text.length;
  };
  if (approvalsNotice) pushContextPart(approvalsNotice.contextText);

  const promptNowMs = Number(typeof now === 'function' ? now() : now) || Date.now();
  const promptNowDate = new Date(promptNowMs);
  const delegatedForPrompt = !worker && isValidTerminalId(terminalId)
    ? (
        Boolean(getTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: promptNowDate }))
        || hasPendingDelegatedMessage(terminalId, { globalDir: effectiveGlobalDir })
      )
    : false;

  if (!worker && !delegatedForPrompt) {
    try {
      const promptEval = evaluateWorkSizePrompt({
        cwd: projectDir,
        env,
        projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
        globalDir: effectiveGlobalDir,
        terminalId,
        sessionId,
        config,
        loadConfigForRoot: (root) => (
          projectPathKey(root) === projectPathKey(resolveProjectRoot(projectDir))
            ? config
            : loadConfig({ projectDir: root, globalDir: effectiveGlobalDir })
        ),
        isEnabledForRoot: isProjectEnabled,
        now: promptNowDate,
      });
      if (promptEval.completedNotice) pushContextPart(promptEval.completedNotice);
      if (promptEval.unsavedNotice) pushContextPart(promptEval.unsavedNotice);
      if (promptEval.periodicNotice) pushContextPart(promptEval.periodicNotice);
    } catch {
      // ignore work-size state errors in hook
    }
  }

  if (!worker && isValidTerminalId(terminalId)) {
    const inboxBudget = contextParts.length > 0 ? maxChars - used - 2 : maxChars;
    if (inboxBudget >= 120 || contextParts.length === 0) {
      // One consumer at a time: when another process is delivering this terminal's messages right now,
      // nothing is injected and the messages stay for the next prompt.
      const delivered = deliverInboxForHook(terminalId, {
        globalDir: effectiveGlobalDir,
        projectDir,
        maxChars: inboxBudget,
        // A message that fits an ordinary prompt waits for one instead of being announced as too long.
        fullBlockChars: maxChars,
        nowMs: promptNowMs,
      });
      if (delivered.text) pushContextPart(delivered.text);
    }
  }

  const output = {};
  if (contextParts.length > 0) {
    output.hookSpecificOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: contextParts.join('\n\n'),
    };
  }
  if (approvalsNotice) {
    output.systemMessage = joinUserNotices([approvalsNotice.userText]);
  }
  return output;
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
 * What a file or shell tool call means for the project approvals: { askReason, subagentDenied }.
 * `askReason` is the reason to put the call to the user of the main conversation ('' = no question);
 * `subagentDenied` is true when a subagent may not make the call at all.
 * - A shell command that names an approvals file (and is not read-only), and a file tool that writes into
 *   <globalDir>/state/: the main conversation is asked, a subagent is denied.
 * - A shell command that merely runs the approval CLI: no question for the main conversation (the CLI shows
 *   its own confirmation dialog to a person), still denied for a subagent.
 */
function inspectTrustChange(toolName, rawInput, cwd, globalDir) {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  if (SHELL_TOOLS.has(name)) {
    const kind = classifyTrustCommand(rawInput.command);
    if (kind === 'approvals-file') {
      return { askReason: formatTrustCommandAskReason(rawInput.command), subagentDenied: true };
    }
    return { askReason: '', subagentDenied: kind === 'runs-cli' };
  }
  if (FILE_WRITE_TOOLS.has(name)) {
    const target = stateFileWriteTarget(name, rawInput, cwd, globalDir);
    if (target) {
      return {
        askReason: formatStateFileWriteAskReason(target.path, { approvalsFile: target.approvalsFile }),
        subagentDenied: true,
      };
    }
  }
  return { askReason: '', subagentDenied: false };
}

/**
 * Folder a `memory_save` / `memory_update` call would write to when its `project_dir` names a different
 * project than the one this session runs in (compared by real path), or '' when it stays in this project.
 */
export function otherProjectWriteTargetByBaseName(baseName, rawInput, cwd) {
  if (!PROJECT_WRITE_CORTEX_TOOLS.has(baseName)) return '';
  const requested = typeof rawInput?.project_dir === 'string' ? rawInput.project_dir.trim() : '';
  if (!requested) return '';
  const currentRoot = resolveProjectRoot(path.resolve(cwd || process.cwd()));
  const targetRoot = resolveProjectRoot(path.resolve(currentRoot, requested));
  return projectPathKey(targetRoot) === projectPathKey(currentRoot) ? '' : targetRoot;
}

function otherProjectWriteTarget(toolName, rawInput, cwd) {
  return otherProjectWriteTargetByBaseName(cortexToolBaseName(toolName), rawInput, cwd);
}

export function formatOtherProjectWriteReason(targetDir) {
  return `[herdr-cortex] This call writes memory into a different project folder: "${sanitizeInline(targetDir)}". `
    + 'Allow it only if you want that project\'s memory changed from this session.';
}

/**
 * Claude Code PreToolUse handler. In order:
 * - A subagent's Write / Edit / MultiEdit / NotebookEdit into a `.memory/` folder, or Bash / PowerShell
 *   command that mentions one, is denied (subagents hand results back to the main conversation).
 * - A Bash / PowerShell command that names an approvals file (unless it only reads, see
 *   `isReadOnlyShellCommand`), and a Write / Edit / MultiEdit / NotebookEdit into <globalDir>/state/, returns
 *   permissionDecision: 'ask' for the main conversation and 'deny' for a subagent, so the approvals are not
 *   changed behind the confirmation dialog's back without the user seeing it.
 * - A Bash / PowerShell command that runs the project-approval CLI (`cortex-trust`, `trust-cli.mjs`,
 *   `npm run trust`) is denied for a subagent. The main conversation is not asked: the CLI itself shows a
 *   confirmation dialog to a person before it approves anything. A plain `status` / `list` call passes.
 * - For subagents calling write-protected cortex tools (memory_save, memory_update,
 *   relay_send, relay_inbox(action="ack")), directly return permissionDecision: 'deny'.
 * - A memory_save / memory_update whose `project_dir` is another project returns permissionDecision: 'ask',
 *   so the user confirms a write that leaves the current project.
 * - For subagents calling read-only cortex tools, inject real host agent_id via updatedInput
 *   and NEVER return permissionDecision: 'allow'.
 * - For HEAD, strip any LLM-spoofed `_caller_agent_id`.
 * Any other tool call returns {} right away (the hook prints nothing).
 */
function extractClaudeEditInput(toolName, rawInput) {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  if (!FILE_WRITE_TOOLS.has(name)) return null;

  if (name === 'Write') {
    const filePath = typeof rawInput.file_path === 'string' ? rawInput.file_path : '';
    const addedChars = typeof rawInput.content === 'string' ? rawInput.content.length : 0;
    return filePath.trim() ? { filePath, addedChars } : null;
  }

  if (name === 'Edit') {
    const filePath = typeof rawInput.file_path === 'string' ? rawInput.file_path : '';
    const addedChars = typeof rawInput.new_string === 'string' ? rawInput.new_string.length : 0;
    return filePath.trim() ? { filePath, addedChars } : null;
  }

  if (name === 'MultiEdit') {
    const filePath = typeof rawInput.file_path === 'string' ? rawInput.file_path : '';
    if (!filePath.trim()) return null;
    let addedChars = 0;
    if (Array.isArray(rawInput.edits)) {
      for (const edit of rawInput.edits) {
        if (edit && typeof edit === 'object') {
          if (typeof edit.new_string === 'string') addedChars += edit.new_string.length;
          else if (typeof edit.content === 'string') addedChars += edit.content.length;
        }
      }
    }
    return { filePath, addedChars };
  }

  if (name === 'NotebookEdit') {
    const filePath = typeof rawInput.notebook_path === 'string' && rawInput.notebook_path.trim()
      ? rawInput.notebook_path
      : (typeof rawInput.file_path === 'string' ? rawInput.file_path : '');
    if (!filePath.trim()) return null;
    let addedChars = 0;
    if (typeof rawInput.new_source === 'string') addedChars = rawInput.new_source.length;
    else if (typeof rawInput.content === 'string') addedChars = rawInput.content.length;
    else if (typeof rawInput.new_string === 'string') addedChars = rawInput.new_string.length;
    return { filePath, addedChars };
  }

  return null;
}

export function handleClaudePreToolUse(
  payload = {},
  {
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    now = Date.now,
  } = {},
) {
  const toolName = payload.tool_name || payload.toolName || '';
  const rawInput = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
    ? payload.tool_input
    : {};

  const hostAgentId = String(payload.agent_id || payload.agentId || '').trim();
  const callerIsSubagent = Boolean(hostAgentId) || isSubagentPayload(payload);
  const worker = isWorkerSession({ env });

  if (!isCortexToolName(toolName)) {
    const cwd = extractCwd(payload, process.cwd());
    const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
    if (callerIsSubagent && subagentTouchesMemoryDir(toolName, rawInput, cwd)) {
      return preToolUseDecision('deny', SUBAGENT_MEMORY_DIR_DENY_REASON);
    }
    const trustChange = inspectTrustChange(toolName, rawInput, cwd, effectiveGlobalDir);
    if (callerIsSubagent && trustChange.subagentDenied) {
      return preToolUseDecision('deny', SUBAGENT_TRUST_CHANGE_DENY_REASON);
    }
    if (!callerIsSubagent && trustChange.askReason) {
      return preToolUseDecision('ask', trustChange.askReason);
    }

    const trimmedTool = typeof toolName === 'string' ? toolName.trim() : '';
    const nowDate = new Date(Number(typeof now === 'function' ? now() : now) || Date.now());
    const delegated = !callerIsSubagent && !worker && isValidTerminalId(terminalId)
      ? Boolean(getTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: nowDate }))
      : false;
    const actsAsWorker = worker || delegated;

    if (SHELL_TOOLS.has(trimmedTool)) {
      const shellBudget = createShellInspectionBudget();
      if (
        commandReferencesWorkSizeState(rawInput.command, effectiveGlobalDir, {
          shell: trimmedTool,
          budget: shellBudget,
        })
        && !isShellGuardReadOnly(rawInput.command, trimmedTool)
      ) {
        if (callerIsSubagent || actsAsWorker) {
          return preToolUseDecision('deny', WORK_STATE_SHELL_DENY_REASON);
        }
        return preToolUseDecision('ask', formatWorkSizeStateShellAskReason(rawInput.command));
      }

      const workCmdKind = classifyWorkCommand(rawInput.command, {
        shell: trimmedTool,
        budget: shellBudget,
      });
      if (workCmdKind === 'runs-cli') {
        if (callerIsSubagent || actsAsWorker) {
          return preToolUseDecision('deny', WORK_COMMAND_DENY_REASON);
        }
        return preToolUseDecision('ask', formatWorkCommandAskReason(rawInput.command));
      }

      try {
        const scope = resolveWorkSizeScope({ terminalId, sessionId: extractSessionId(payload) });
        const rootDir = resolveWorkSizeProjectRoot({
          cwd,
          env,
          projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
          globalDir: effectiveGlobalDir,
          scope,
        });
        const cfg = loadConfig({ projectDir: rootDir, globalDir: effectiveGlobalDir });
        if (isProjectEnabled(rootDir, cfg)) {
          const wsCfg = resolveWorkSizeConfig(cfg);
          if (wsCfg.confirmCommands) {
            const confirmMatch = inspectConfirmableShellCommand(rawInput.command, {
              confirmCommands: wsCfg.confirmCommands,
              confirmCommandPatterns: wsCfg.confirmCommandPatterns,
              env,
              shell: trimmedTool,
              config: cfg,
              budget: shellBudget,
            });
            if (confirmMatch.matched) {
              if (callerIsSubagent || actsAsWorker) {
                return preToolUseDecision('deny', formatConfirmCommandDenyReason(confirmMatch));
              }
              return preToolUseDecision('ask', formatConfirmCommandAskReason(confirmMatch, rawInput.command));
            }
          }
        }
      } catch {
        // State/config errors never block shell calls.
      }
      return {};
    }

    if (!callerIsSubagent && !actsAsWorker && FILE_READ_TOOLS.has(trimmedTool)) {
      try {
        const readEval = evaluateWorkSizeRead({
          cwd,
          env,
          projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
          globalDir: effectiveGlobalDir,
          terminalId,
          sessionId: extractSessionId(payload),
          loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
          isEnabledForRoot: isProjectEnabled,
          now: nowDate,
        });
        if (readEval.additionalContext) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: readEval.additionalContext,
            },
          };
        }
      } catch {
        // State read/write errors never block tool calls.
      }
      return {};
    }

    if (!callerIsSubagent && !actsAsWorker && FILE_WRITE_TOOLS.has(trimmedTool)) {
      try {
        const editInput = extractClaudeEditInput(trimmedTool, rawInput);
        if (editInput) {
          const evaluated = evaluateWorkSizeEdit({
            filePath: editInput.filePath,
            addedChars: editInput.addedChars,
            cwd,
            env,
            projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
            globalDir: effectiveGlobalDir,
            terminalId,
            sessionId: extractSessionId(payload),
            loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
            isEnabledForRoot: isProjectEnabled,
            now: nowDate,
          });
          if (evaluated.action === 'deny') {
            return preToolUseDecision('deny', evaluated.denyReason);
          }
          if (evaluated.action === 'allow' && evaluated.additionalContext) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext: evaluated.additionalContext,
              },
            };
          }
        }
      } catch {
        // State read/write errors never block tool calls.
      }
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

function isPostToolResponseFailure(toolResponse, { isShell = false } = {}) {
  if (!toolResponse || typeof toolResponse !== 'object') return false;
  if (Array.isArray(toolResponse)) {
    if (isShell) return false;
    const texts = toolResponse
      .filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
      .map((item) => item.text.trim())
      .filter(Boolean);
    if (texts.length === 0) return false;
    return texts.every((text) => {
      if (/^Error:/i.test(text)) return true;
      try {
        const parsed = JSON.parse(text);
        return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error && !parsed.id);
      } catch {
        return false;
      }
    });
  }
  if (toolResponse.isError === true || toolResponse.is_error === true || toolResponse.interrupted === true) {
    return true;
  }
  if (isShell) {
    for (const key of ['exit_code', 'exitCode', 'returnCode']) {
      if (typeof toolResponse[key] === 'number' && toolResponse[key] !== 0) return true;
    }
    return false;
  }
  if (typeof toolResponse.error === 'string' && toolResponse.error && !toolResponse.id) {
    return true;
  }
  return false;
}

/**
 * Claude Code PostToolUse handler (runs after a tool succeeds; opens no SQLite database):
 * - Bash / PowerShell running `git commit` inside the project root (excluding `--dry-run` / `--allow-empty` /
 *   outside `-C` / quoted text) clears the cumulative edit window;
 * - `memory_save` clears the cumulative edit window and, when in `L`, records `memorySaved` (finishing `L` if
 *   `reviewAccepted` was already recorded).
 */
export function handleClaudePostToolUse(
  payload = {},
  {
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    now = Date.now,
  } = {},
) {
  if (isSubagentPayload(payload) || isWorkerSession({ env })) return {};

  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const nowDate = new Date(Number(typeof now === 'function' ? now() : now) || Date.now());
  if (isValidTerminalId(terminalId) && getTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: nowDate })) {
    return {};
  }

  const toolName = String(payload.tool_name || payload.toolName || '').trim();
  const rawInput = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
    ? payload.tool_input
    : {};
  const toolResponse = payload.tool_response ?? payload.toolResponse;

  if (SHELL_TOOLS.has(toolName)) {
    const isInterrupt = Boolean(toolResponse?.interrupted || payload.is_interrupt || payload.isInterrupt);
    if (isInterrupt) return {};
    const failed = isPostToolResponseFailure(toolResponse, { isShell: true });
    try {
      const cwd = extractCwd(payload, process.cwd());
      recordShellResultForWorkSize({
        ok: !failed,
        isInterrupt: false,
        command: rawInput.command,
        shell: toolName,
        cwd,
        env,
        projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
        globalDir: effectiveGlobalDir,
        terminalId,
        sessionId: extractSessionId(payload),
        loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
        isEnabledForRoot: isProjectEnabled,
        now: nowDate,
      });
    } catch {
      // ignore state errors in hook
    }
    return {};
  }

  if (cortexToolBaseName(toolName) === 'memory_save') {
    if (isPostToolResponseFailure(toolResponse, { isShell: false })) return {};
    try {
      const cwd = extractCwd(payload, process.cwd());
      const sessionId = extractSessionId(payload);
      const scope = resolveWorkSizeScope({ terminalId, sessionId });
      const wsRoot = resolveWorkSizeProjectRoot({
        cwd,
        env,
        projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
        globalDir: effectiveGlobalDir,
        scope,
      });
      if (otherProjectWriteTarget(toolName, rawInput, wsRoot)) return {};
      recordMemorySaveForWorkSize({
        cwd,
        env,
        projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
        globalDir: effectiveGlobalDir,
        terminalId,
        sessionId,
        loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
        isEnabledForRoot: isProjectEnabled,
        now: nowDate,
      });
    } catch {
      // ignore state errors in hook
    }
  }

  return {};
}

/**
 * Claude Code PostToolUseFailure handler: tracks failed shell runs (`Bash` / `PowerShell`) after project
 * file edits so repeated failed edits on the same file are blocked and escalated to `L` (2-4).
 * Ignores user-interrupted commands (`is_interrupt: true`), subagents, and worker sessions.
 */
export function handleClaudePostToolUseFailure(
  payload = {},
  {
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    now = Date.now,
  } = {},
) {
  if (isSubagentPayload(payload) || isWorkerSession({ env })) return {};

  const toolName = String(payload.tool_name || payload.toolName || '').trim();
  if (!SHELL_TOOLS.has(toolName)) return {};

  const isInterrupt = Boolean(payload.is_interrupt ?? payload.isInterrupt);
  if (isInterrupt) return {};

  const rawInput = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
    ? payload.tool_input
    : {};

  try {
    const cwd = extractCwd(payload, process.cwd());
    const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
    const nowDate = new Date(Number(typeof now === 'function' ? now() : now) || Date.now());
    if (isValidTerminalId(terminalId) && getTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: nowDate })) {
      return {};
    }
    recordShellResultForWorkSize({
      ok: false,
      isInterrupt: false,
      command: rawInput.command,
      shell: toolName,
      cwd,
      env,
      projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
      globalDir: effectiveGlobalDir,
      terminalId,
      sessionId: extractSessionId(payload),
      loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
      isEnabledForRoot: isProjectEnabled,
      now: nowDate,
    });
  } catch {
    // ignore state errors in hook
  }

  return {};
}

/**
 * Claude Code SubagentStop handler: reads `last_assistant_message` for a structured reviewer verdict
 * (`ACCEPT` or `NEEDS_FIX`) and records it against an active `L` job of the parent tab/session.
 * Note: SubagentStop payloads naturally carry `agent_id` of the stopped subagent, so `isSubagentPayload`
 * is NOT used to skip here.
 */
export function handleClaudeSubagentStop(
  payload = {},
  {
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    now = Date.now,
  } = {},
) {
  if (isWorkerSession({ env })) return {};

  const lastMessage = payload.last_assistant_message ?? payload.lastAssistantMessage;
  const verdict = parseReviewVerdict(lastMessage);
  if (!verdict) return {};

  try {
    const cwd = extractCwd(payload, process.cwd());
    const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
    const nowDate = new Date(Number(typeof now === 'function' ? now() : now) || Date.now());
    recordReviewVerdict({
      verdict,
      cwd,
      env,
      projectDirEnvVar: CLAUDE_PROJECT_DIR_ENV,
      globalDir: effectiveGlobalDir,
      terminalId,
      sessionId: extractSessionId(payload),
      loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
      isEnabledForRoot: isProjectEnabled,
      now: nowDate,
    });
  } catch {
    // ignore state errors in hook
  }

  return {};
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
    case 'post-tool-use':
      return handleClaudePostToolUse(payload, options);
    case 'post-tool-use-failure':
      return handleClaudePostToolUseFailure(payload, options);
    case 'subagent-stop':
      return handleClaudeSubagentStop(payload, options);
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
