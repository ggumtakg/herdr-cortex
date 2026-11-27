#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  assertInsideDir,
  atomicWriteJson,
  expandCortexRootPlaceholder,
  formatLegacyEmbeddingContextNotice,
  getProjectMemoryDir,
  getTierPaths,
  hasProjectMemoryDir,
  isMainModule,
  isProjectEnabled,
  isProjectTrusted,
  loadConfig,
  projectPathKey,
  resolveProjectRoot,
  resolveWorkSizeConfig,
} from '../core/config.mjs';
import { HEAD_CORE_MAX_CHARS, fitOverviewToBudget, resolveHookBudget } from '../core/budget.mjs';
import { isWorkerSession } from '../core/role.mjs';
import {
  formatProjectNotApprovedNotice,
  formatUnapprovedFolderNotice,
  hasUnapprovedFolderNoticeRecord,
  isHomeOrRootFolder,
  recordUnapprovedFolderNotice,
} from '../core/trust.mjs';
import {
  extractCwd,
  extractSessionId,
  isSubagentPayload,
  isValidTerminalId,
  recordSession,
  resolveCortexGlobalDir,
} from '../revive/tracker.mjs';
import { deliverInboxForHook, hasPendingDelegatedMessage } from '../relay/inbox.mjs';
import { EMPTY_MEMORY_NOTICE, formatUnindexedNotice, loadHookOverview, resolveHookSyncOptions } from './overview.mjs';
import { checkApprovalsForSession, pruneApprovalCheckRecords } from './approvals-watch.mjs';
import {
  createShellInspectionBudget,
  formatConfirmCommandAskReason,
  formatConfirmCommandDenyReason,
  inspectConfirmableShellCommand,
} from './confirm-commands.mjs';
import {
  DEFAULT_MAX_TAIL_BYTES,
  extractAntigravityState,
  formatRecentTurns,
  resolveAntigravityTranscriptPath,
} from './recent-turns.mjs';
import {
  ANTIGRAVITY_FILE_READ_TOOL_NAMES,
  ANTIGRAVITY_FILE_WRITE_TOOL_NAMES,
  ANTIGRAVITY_SHELL_TOOL_NAMES,
  resolveAntigravityCortexTool,
} from './tool-names.mjs';
import {
  clearTabDelegation,
  consumeWorkSizePendingNotices,
  evaluateWorkSizeEdit,
  evaluateWorkSizePrompt,
  evaluateWorkSizeRead,
  getTabDelegation,
  getWorkSizeSessionNotice,
  isPathInsideMemoryDir,
  recordMemorySaveForWorkSize,
  recordShellResultForWorkSize,
  resetWorkSizeTurnCountersOnSessionStart,
  resolveWorkSizeProjectRoot,
  resolveWorkSizeScope,
} from './work-size.mjs';
import {
  SUBAGENT_CORTEX_WRITE_DENY_REASON,
  SUBAGENT_MEMORY_DIR_DENY_REASON,
  SUBAGENT_TRUST_CHANGE_DENY_REASON,
  WORK_COMMAND_DENY_REASON,
  WORK_STATE_SHELL_DENY_REASON,
  buildCompactInstruction,
  classifyTrustCommand,
  classifyWorkCommand,
  commandReferencesMemoryDir,
  commandReferencesWorkSizeState,
  formatOtherProjectWriteReason,
  formatStateFileWriteAskReason,
  formatTrustCommandAskReason,
  formatWorkCommandAskReason,
  formatWorkSizeStateShellAskReason,
  inspectStateFilePath,
  isShellGuardReadOnly,
  isWriteProtectedCortexBaseName,
  otherProjectWriteTargetByBaseName,
  restoreFailureNote,
} from './claude.mjs';

export { EMPTY_MEMORY_NOTICE, HEAD_CORE_MAX_CHARS };

const ANTIGRAVITY_FILE_WRITE_TOOLS = new Set(ANTIGRAVITY_FILE_WRITE_TOOL_NAMES);
const ANTIGRAVITY_SHELL_TOOLS = new Set(ANTIGRAVITY_SHELL_TOOL_NAMES);
const ANTIGRAVITY_FILE_READ_TOOLS = new Set(ANTIGRAVITY_FILE_READ_TOOL_NAMES);
export const ANTIGRAVITY_PRE_TOOL_SAFE_DECISION = Object.freeze({ decision: 'ask' });
export const ANTIGRAVITY_MAX_TOOL_PATH_CHARS = 1024;
const VALID_PRE_TOOL_DECISIONS = new Set(['ask', 'deny', 'force_ask']);

function isUncOrOverlongToolPath(rawPath) {
  if (typeof rawPath !== 'string') return false;
  if (rawPath.length > ANTIGRAVITY_MAX_TOOL_PATH_CHARS) return true;
  const trimmed = rawPath.trimStart();
  if (trimmed.startsWith('\\\\')) return true;
  if (process.platform === 'win32' && /^[\\/]{2}/.test(trimmed)) return true;
  return false;
}

const SAFE_CONV_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const ROLE_PROBE_BYTES = 16 * 1024;
const SUBAGENT_MSG_RE = /\[Message\]\s+timestamp=[^\n]+\ssender=[0-9a-zA-Z_-]{8,}/i;
// Most characters one hook call spends on relay messages. The inbox belongs to the terminal and lives in the
// global store, so it is delivered whether or not the current project is approved (an excluded project
// returns before any delivery). Only messages injected in full are acknowledged; a message too long for a
// block of this size is announced once and then left for relay_inbox.
const ANTIGRAVITY_INBOX_MAX_CHARS = 2500;
const USER_STEP_FALLBACK_RE = /"(?:type|stepType|step_type|kind)"\s*:\s*"(?:[A-Z_]*_)?(?:USER_INPUT|USER_EXPLICIT)"/i;

function wrapAntigravityInjectSteps(sections) {
  const clean = (Array.isArray(sections) ? sections : [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  if (clean.length === 0) return {};
  return {
    injectSteps: clean.map((text) => ({
      systemMessage: {
        systemMessage: text,
      },
    })),
  };
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

// Notice injected when the folder has a .memory/ directory that was not loaded (every startup/restore).
function resolveNotApprovedNotice(projectDir, projectTrusted) {
  return !projectTrusted && hasProjectMemoryDir(projectDir) ? formatProjectNotApprovedNotice(projectDir) : '';
}

// Startup notice: every session when .memory/ exists; once per folder (non-worker, non-home/root) when .memory/ is absent.
function resolveStartupNotApproved(projectDir, { projectTrusted, worker, globalDir, homeDir, env }) {
  if (projectTrusted) return { contextText: '', recordOnce: false };
  if (hasProjectMemoryDir(projectDir)) {
    return { contextText: formatProjectNotApprovedNotice(projectDir), recordOnce: false };
  }
  if (
    !worker
    && !isHomeOrRootFolder(projectDir, { homeDir, env })
    && !hasUnapprovedFolderNoticeRecord(projectDir, { globalDir })
  ) {
    return { contextText: formatUnapprovedFolderNotice(projectDir), recordOnce: true };
  }
  return { contextText: '', recordOnce: false };
}

function pushStartupHeadAndNotices({
  pushHeadCore,
  pushSection,
  availableBudget,
  worker,
  promptsDir,
  repoRoot,
  config,
  notApproved,
  legacyEmbeddingNotice,
  projectDir,
  globalDir,
}) {
  const headCore = !worker ? readHeadCore(promptsDir, config, repoRoot) : '';
  const mandatoryNotApproved = !notApproved.recordOnce ? notApproved.contextText : '';
  const oneTimeCandidate = notApproved.recordOnce ? notApproved.contextText : '';

  if (headCore) {
    pushHeadCore(headCore);
  }
  if (mandatoryNotApproved) {
    pushSection(mandatoryNotApproved);
  } else if (oneTimeCandidate && oneTimeCandidate.length <= availableBudget() && pushSection(oneTimeCandidate)) {
    try {
      recordUnapprovedFolderNotice(projectDir, { globalDir });
    } catch {
      // ignore state write errors in hook
    }
  }
  if (legacyEmbeddingNotice && legacyEmbeddingNotice.length <= availableBudget()) {
    pushSection(legacyEmbeddingNotice);
  }
}

/**
 * The "approvals changed without the confirmation dialog" warning for this conversation, or ''. Checked on
 * every hook call (cheap, see `approvals-watch.mjs`) and announced once per conversation and change.
 * Antigravity hooks have one output channel, `injectSteps`, which the model reads; no field is known that
 * is shown to the user directly, so the warning asks the model to pass it on.
 */
function resolveApprovalsWarning(globalDir, convId) {
  const notice = checkApprovalsForSession({ globalDir, sessionId: convId });
  return notice ? notice.contextText : '';
}

/**
 * Inspect only the first 16KB of an Antigravity transcript to classify the conversation role:
 * - 'root'     : contains a USER_INPUT / USER_EXPLICIT step
 * - 'subagent' : contains `[Message] timestamp=... sender=<id>` and NO USER_INPUT/USER_EXPLICIT step
 * - 'unknown'  : missing, empty, or not yet populated (e.g. brand-new SessionStart)
 */
export function detectAntigravityTranscriptRole(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return 'unknown';
  const resolved = resolveAntigravityTranscriptPath(transcriptPath)
    || (fs.existsSync(transcriptPath) ? path.resolve(transcriptPath) : '');
  if (!resolved) return 'unknown';

  let stat;
  try {
    stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size === 0) return 'unknown';
  } catch {
    return 'unknown';
  }

  const readLen = Math.min(stat.size, ROLE_PROBE_BYTES);
  let chunk = '';
  let fd;
  try {
    fd = fs.openSync(resolved, 'r');
    const buf = Buffer.allocUnsafe(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, 0);
    chunk = buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return 'unknown';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  if (!chunk.trim()) return 'unknown';

  let hasUserStep = false;
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const stepType = String(
          parsed.type || parsed.stepType || parsed.step_type || parsed.kind || '',
        ).toUpperCase();
        if (
          stepType === 'USER_INPUT'
          || stepType === 'USER_EXPLICIT'
          || stepType.endsWith('_USER_INPUT')
          || stepType.endsWith('_USER_EXPLICIT')
          || Boolean(parsed.userInput || parsed.user_input)
        ) {
          hasUserStep = true;
          break;
        }
      }
    } catch {
      if (USER_STEP_FALLBACK_RE.test(trimmed)) {
        hasUserStep = true;
        break;
      }
    }
  }

  if (hasUserStep) return 'root';
  if (SUBAGENT_MSG_RE.test(chunk)) return 'subagent';
  return 'unknown';
}

/**
 * Resolve per-conversation state file path.
 * Uses <project>/.memory/state/checkpoints/<convId>.json when <project>/.memory exists and the user
 * approved the project folder, otherwise stores under <globalDir>/state/checkpoints/<convId>.json so
 * uninitialized projects NEVER get a .memory/ folder created automatically and nothing is read from or
 * written into the .memory/ of an unapproved folder.
 */
function resolveCheckpointFile(projectDir, globalDir, convId, projectTrusted) {
  const cleanConv = String(convId || '').trim();
  if (!SAFE_CONV_ID_RE.test(cleanConv) || cleanConv.includes('..')) return null;

  const projectMemDir = getProjectMemoryDir(projectDir);
  const tierRoot = projectTrusted && fs.existsSync(projectMemDir) ? projectMemDir : globalDir;
  const { checkpointsDir } = getTierPaths(tierRoot);
  return {
    jsonPath: assertInsideDir(checkpointsDir, `${cleanConv}.json`),
    legacyTxtPath: assertInsideDir(checkpointsDir, `${cleanConv}.txt`),
  };
}

function readCheckpointState(cpPaths) {
  if (!cpPaths) return { started: false, checkpoint: '', lastTurnSig: '' };
  try {
    if (fs.existsSync(cpPaths.jsonPath)) {
      const raw = fs.readFileSync(cpPaths.jsonPath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          started: Boolean(parsed.started),
          checkpoint: typeof parsed.checkpoint === 'string' ? parsed.checkpoint : '',
          transcriptPath: typeof parsed.transcriptPath === 'string' ? parsed.transcriptPath : '',
          transcriptMtimeMs: typeof parsed.transcriptMtimeMs === 'number' ? parsed.transcriptMtimeMs : 0,
          transcriptSize: typeof parsed.transcriptSize === 'number' ? parsed.transcriptSize : 0,
          lastTurnSig: typeof parsed.lastTurnSig === 'string' ? parsed.lastTurnSig : '',
        };
      }
    }
    if (fs.existsSync(cpPaths.legacyTxtPath)) {
      const legacyKey = fs.readFileSync(cpPaths.legacyTxtPath, 'utf8').trim();
      return { started: true, checkpoint: legacyKey, lastTurnSig: '' };
    }
  } catch {
    // ignore corrupt checkpoint state
  }
  return { started: false, checkpoint: '', lastTurnSig: '' };
}

function computeTurnSignature(payload, lastInput) {
  if (!lastInput) return '';
  const rawInitial = payload?.initialNumSteps ?? payload?.initial_num_steps;
  const numInitial = typeof rawInitial === 'number' && Number.isFinite(rawInitial) ? Math.floor(rawInitial) : null;
  return numInitial !== null ? `${numInitial}\0${lastInput}` : `\0${lastInput}`;
}

function ensureValidPreToolDecision(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { decision: 'ask' };
  }
  const decision = typeof candidate.decision === 'string' ? candidate.decision.trim() : '';
  if (!VALID_PRE_TOOL_DECISIONS.has(decision)) {
    return { decision: 'ask' };
  }
  if (decision === 'ask') {
    return { decision: 'ask' };
  }
  const reason = typeof candidate.reason === 'string' && candidate.reason.trim()
    ? candidate.reason.trim()
    : '[herdr-cortex] Tool call requires review.';
  return { decision, reason };
}

function classifyAntigravityCaller(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'unknown', convId: '', lastInput: '', transcriptPath: '' };
  }
  if (isSubagentPayload(payload)) {
    return { kind: 'subagent', convId: extractSessionId(payload), lastInput: '', transcriptPath: '' };
  }
  const transcriptPath = extractTranscriptPath(payload);
  const role = detectAntigravityTranscriptRole(transcriptPath);
  if (role === 'subagent') {
    return { kind: 'subagent', convId: extractSessionId(payload), lastInput: '', transcriptPath };
  }
  const lastInput = String(payload.lastUserInput ?? payload.userInput ?? '').trim();
  if (SUBAGENT_MSG_RE.test(lastInput)) {
    return { kind: 'subagent', convId: extractSessionId(payload), lastInput, transcriptPath };
  }
  const convId = extractSessionId(payload);
  const explicitRoot = isExplicitRootPayload(payload, convId);
  const isConfirmedRoot =
    role === 'root'
    || explicitRoot
    || (role === 'unknown' && lastInput.length > 0 && !SUBAGENT_MSG_RE.test(lastInput));
  return {
    kind: isConfirmedRoot ? 'root' : 'unknown',
    convId,
    lastInput,
    transcriptPath,
  };
}

function extractTranscriptPath(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.transcriptFullPath,
    payload.transcript_full_path,
    payload.transcriptPath,
    payload.transcript_path,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function isExplicitRootPayload(payload, convId) {
  if (!convId || !payload || typeof payload !== 'object') return false;
  const rootId = payload.rootConversationId || payload.root_conversation_id;
  return typeof rootId === 'string' && rootId.trim() !== '' && rootId.trim() === convId;
}

/**
 * Push the memory overview of an injection (or the one-line empty-memory notice when `allowEmptyNotice` is true
 * and there are 0 active documents). The index is synced under the hook's limits first; documents that sync
 * left out are named in a one-line notice of their own, which is counted in the budget like every other
 * section. `remaining()` is the budget that is left, `reserve` keeps room for text that follows.
 */
function pushOverviewSections({ pushSection, remaining, reserve = 0, allowEmptyNotice = false, ...overviewArgs }) {
  const { overview, unindexed, syncFailed } = loadHookOverview(overviewArgs);
  if (unindexed.length > 0) {
    pushSection(formatUnindexedNotice(unindexed, { maxChars: remaining() }));
  }
  if (!overview) {
    if (allowEmptyNotice && unindexed.length === 0 && !syncFailed) {
      const availableForEmpty = remaining() - reserve;
      if (EMPTY_MEMORY_NOTICE.length <= availableForEmpty) {
        pushSection(EMPTY_MEMORY_NOTICE);
      }
    }
    return;
  }
  const overviewBudget = remaining() - reserve;
  if (overviewBudget >= 120) {
    const fitted = fitOverviewToBudget(overview, overviewBudget);
    if (fitted.text) {
      pushSection(fitted.text);
    }
  }
}

/**
 * Antigravity SessionStart handler.
 * Defers startup injection and session recording to PreInvocation when transcript role
 * is 'unknown' and rootConversationId is not explicitly equal to conversationId (real
 * Antigravity CLI behavior where root vs subagent cannot yet be distinguished at SessionStart).
 * `startedAt` (epoch ms the hook process started) and `indexBudget` set the index sync limits, see
 * `resolveHookSyncOptions`.
 */
export function handleAntigravitySessionStart(
  payload = {},
  {
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    homeDir,
    legacyHome,
    repoRoot = REPO_ROOT,
    promptsDir = path.join(repoRoot, 'prompts'),
    startedAt,
    indexBudget,
    now = Date.now,
  } = {},
) {
  if (isSubagentPayload(payload)) {
    return {};
  }

  const transcriptPath = extractTranscriptPath(payload);
  const role = detectAntigravityTranscriptRole(transcriptPath);
  if (role === 'subagent') {
    return {};
  }

  const convId = extractSessionId(payload);
  const explicitRoot = isExplicitRootPayload(payload, convId);
  if (role === 'unknown' && !explicitRoot) {
    // Defer to PreInvocation once step 0 reveals root vs subagent
    return {};
  }

  const worker = isWorkerSession({ env });
  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const effectiveHomeDir = homeDir || ((env?.HERDR_CORTEX_TEST_HOME || env?.HERDR_REVIVE_TEST_HOME) ? '' : legacyHome);
  const projectDir = extractCwd(payload, process.cwd());
  const config = loadConfig({ projectDir, globalDir: effectiveGlobalDir });
  const budget = resolveHookBudget(config);

  if (!worker) {
    recordSession({
      terminalId,
      agent: 'antigravity',
      payload,
      cwd: projectDir,
      globalDir: effectiveGlobalDir,
      legacyHome,
    });
  }

  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }

  // Nothing from the project's .memory/ is read, injected or created until the user approved the folder.
  const projectTrusted = isProjectTrusted(projectDir, { globalDir: effectiveGlobalDir });
  const notApproved = resolveStartupNotApproved(projectDir, {
    projectTrusted,
    worker,
    globalDir: effectiveGlobalDir,
    homeDir: effectiveHomeDir,
    env,
  });
  const legacyEmbeddingNotice = formatLegacyEmbeddingContextNotice(config);

  const sections = [];
  let used = 0;

  // `HEAD_CORE` is emitted as its own step capped at `HEAD_CORE_MAX_CHARS`, excluded from `hookBudget`.
  const pushHeadCore = (rawHeadCore) => {
    const trimmed = trimLinesToBudget(rawHeadCore, HEAD_CORE_MAX_CHARS);
    const clean = typeof trimmed === 'string' ? trimmed.trim() : '';
    if (!clean) return false;
    sections.push(clean);
    return true;
  };

  const pushSection = (text) => {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean) return false;
    if (used + clean.length <= budget) {
      sections.push(clean);
      used += clean.length;
      return true;
    }
    return false;
  };

  pruneApprovalCheckRecords(effectiveGlobalDir);
  pushSection(resolveApprovalsWarning(effectiveGlobalDir, convId));

  const startNowMs = Number(typeof now === 'function' ? now() : now) || Date.now();
  const startNowDate = new Date(startNowMs);
  const workspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : undefined;
  const cpPaths = convId ? resolveCheckpointFile(projectDir, effectiveGlobalDir, convId, projectTrusted) : null;
  const existingCp = readCheckpointState(cpPaths);

  if (!worker && cpPaths && !existingCp.started && isValidTerminalId(terminalId)) {
    try {
      clearTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: startNowDate });
    } catch {
      // ignore work-size state errors in hook
    }
  }

  const delegatedForStart = !worker && isValidTerminalId(terminalId)
    ? (
        Boolean(getTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: startNowDate }))
        || hasPendingDelegatedMessage(terminalId, { globalDir: effectiveGlobalDir })
      )
    : false;

  pushStartupHeadAndNotices({
    pushHeadCore,
    pushSection,
    availableBudget: () => budget - used,
    worker,
    promptsDir,
    repoRoot,
    config,
    notApproved,
    legacyEmbeddingNotice,
    projectDir,
    globalDir: effectiveGlobalDir,
  });

  if (!worker && !delegatedForStart) {
    try {
      const loadConfigForRoot = (root) => (
        projectPathKey(root) === projectPathKey(resolveProjectRoot(projectDir))
          ? config
          : loadConfig({ projectDir: root, globalDir: effectiveGlobalDir })
      );
      resetWorkSizeTurnCountersOnSessionStart({
        cwd: projectDir,
        env,
        workspacePaths,
        globalDir: effectiveGlobalDir,
        terminalId,
        sessionId: convId,
        config,
        loadConfigForRoot,
        isEnabledForRoot: isProjectEnabled,
        now: startNowDate,
      });
      pushSection(getWorkSizeSessionNotice({
        cwd: projectDir,
        env,
        workspacePaths,
        globalDir: effectiveGlobalDir,
        terminalId,
        sessionId: convId,
        config,
        loadConfigForRoot,
        isEnabledForRoot: isProjectEnabled,
      }));
    } catch {
      // ignore work-size state errors in hook
    }
  }

  pushOverviewSections({
    pushSection,
    remaining: () => budget - used,
    allowEmptyNotice: !worker && projectTrusted,
    projectDir,
    globalDir: effectiveGlobalDir,
    config,
    projectTrusted,
    syncOptions: resolveHookSyncOptions({ startedAt, indexBudget }),
  });

  // Budget-first relay inbox delivery (see ANTIGRAVITY_INBOX_MAX_CHARS)
  if (!worker && isValidTerminalId(terminalId)) {
    const remaining = budget - used;
    if (remaining >= 120) {
      try {
        const delivered = deliverInboxForHook(terminalId, {
          globalDir: effectiveGlobalDir,
          projectDir,
          maxChars: Math.min(ANTIGRAVITY_INBOX_MAX_CHARS, remaining),
          fullBlockChars: Math.min(ANTIGRAVITY_INBOX_MAX_CHARS, budget),
          nowMs: startNowMs,
        });
        if (delivered.text) {
          pushSection(delivered.text);
        }
      } catch {
        // ignore inbox errors in hook
      }
    }
  }

  if (convId && cpPaths && sections.length > 0) {
    atomicWriteJson(cpPaths.jsonPath, {
      ...existingCp,
      started: true,
    });
  }

  return wrapAntigravityInjectSteps(sections);
}

/**
 * Antigravity PreInvocation handler:
 *  1) Rejects subagents via payload fields OR 16KB transcript role probe (NEVER overwrites parent session!).
 *  2) Records revive session ONLY when confirmed root conversation.
 *  3) On first root PreInvocation (!state.started), injects HEAD_CORE + overview once.
 *  4) If lastUserInput starts with '/compact', injects the one-paragraph compaction instruction.
 *  5) Fast (mtime, size) check before reading transcript; on new CHECKPOINT (DONE),
 *     re-injects HEAD_CORE + overview + last 5 turns once within combined hookBudget.
 *  6) Budget-first relay inbox drain with partial ACK.
 */
export function handleAntigravityPreInvocation(
  payload = {},
  {
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
  } = {},
) {
  if (isSubagentPayload(payload)) {
    return {};
  }

  const transcriptPath = extractTranscriptPath(payload);
  const role = detectAntigravityTranscriptRole(transcriptPath);
  if (role === 'subagent') {
    return {};
  }

  const lastInput = String(payload.lastUserInput ?? payload.userInput ?? '').trim();
  if (SUBAGENT_MSG_RE.test(lastInput)) {
    return {};
  }

  const convId = extractSessionId(payload);
  const explicitRoot = isExplicitRootPayload(payload, convId);
  const isConfirmedRoot =
    role === 'root'
    || explicitRoot
    || (role === 'unknown' && lastInput.length > 0 && !SUBAGENT_MSG_RE.test(lastInput));

  const worker = isWorkerSession({ env });
  const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
  const effectiveHomeDir = homeDir || ((env?.HERDR_CORTEX_TEST_HOME || env?.HERDR_REVIVE_TEST_HOME) ? '' : legacyHome);
  const projectDir = extractCwd(payload, process.cwd());
  const config = loadConfig({ projectDir, globalDir: effectiveGlobalDir });
  const budget = resolveHookBudget(config);

  if (!worker && isConfirmedRoot) {
    recordSession({
      terminalId,
      agent: 'antigravity',
      payload,
      cwd: projectDir,
      globalDir: effectiveGlobalDir,
      legacyHome,
    });
  }

  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }

  if (!isConfirmedRoot) {
    return {};
  }

  const projectTrusted = isProjectTrusted(projectDir, { globalDir: effectiveGlobalDir });
  const notApprovedNotice = resolveNotApprovedNotice(projectDir, projectTrusted);

  const cpPaths = convId ? resolveCheckpointFile(projectDir, effectiveGlobalDir, convId, projectTrusted) : null;
  const cpState = readCheckpointState(cpPaths);
  let stateDirty = false;

  const invokeNowMs = Number(typeof now === 'function' ? now() : now) || Date.now();
  const invokeNowDate = new Date(invokeNowMs);
  const workspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : undefined;

  if (!worker && cpPaths && !cpState.started && isValidTerminalId(terminalId)) {
    try {
      clearTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: invokeNowDate });
    } catch {
      // ignore work-size state errors in hook
    }
  }

  const delegatedForTurn = !worker && isValidTerminalId(terminalId)
    ? (
        Boolean(getTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: invokeNowDate }))
        || hasPendingDelegatedMessage(terminalId, { globalDir: effectiveGlobalDir })
      )
    : false;

  const turnSig = computeTurnSignature(payload, lastInput);
  const isNewUserTurn = Boolean(turnSig) && turnSig !== cpState.lastTurnSig;
  if (isNewUserTurn) {
    cpState.lastTurnSig = turnSig;
    stateDirty = true;
  }

  const sections = [];
  let used = 0;

  // `HEAD_CORE` is emitted as its own step capped at `HEAD_CORE_MAX_CHARS`, excluded from `hookBudget`.
  const pushHeadCore = (rawHeadCore) => {
    const trimmed = trimLinesToBudget(rawHeadCore, HEAD_CORE_MAX_CHARS);
    const clean = typeof trimmed === 'string' ? trimmed.trim() : '';
    if (!clean) return false;
    sections.push(clean);
    return true;
  };

  const pushSection = (text) => {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean) return false;
    if (used + clean.length <= budget) {
      sections.push(clean);
      used += clean.length;
      return true;
    }
    return false;
  };

  const loadConfigForRoot = (root) => (
    projectPathKey(root) === projectPathKey(resolveProjectRoot(projectDir))
      ? config
      : loadConfig({ projectDir: root, globalDir: effectiveGlobalDir })
  );

  // 0. Approvals changed without the confirmation dialog (first, so it always fits)
  pushSection(resolveApprovalsWarning(effectiveGlobalDir, convId));

  // 1. Detect /compact command (with or without trailing arguments)
  // The softened instruction: what is saved in memory need not be restated, what is not saved must be kept.
  if (/^\/compact(?:\s|$)/i.test(lastInput)) {
    pushSection(buildCompactInstruction({ hasUserInstructions: /^\/compact\s+\S/i.test(lastInput) }));
  }

  const overviewArgs = {
    allowEmptyNotice: !worker && projectTrusted,
    projectDir,
    globalDir: effectiveGlobalDir,
    config,
    projectTrusted,
    syncOptions: resolveHookSyncOptions({ startedAt, indexBudget }),
  };

  // 2. First root PreInvocation startup injection (deferred from SessionStart)
  let injectedStartupThisTurn = false;
  if (!cpState.started) {
    const startupNotApproved = resolveStartupNotApproved(projectDir, {
      projectTrusted,
      worker,
      globalDir: effectiveGlobalDir,
      homeDir: effectiveHomeDir,
      env,
    });
    const legacyEmbeddingNotice = formatLegacyEmbeddingContextNotice(config);
    pushStartupHeadAndNotices({
      pushHeadCore,
      pushSection,
      availableBudget: () => budget - used,
      worker,
      promptsDir,
      repoRoot,
      config,
      notApproved: startupNotApproved,
      legacyEmbeddingNotice,
      projectDir,
      globalDir: effectiveGlobalDir,
    });
    if (!worker && !delegatedForTurn) {
      try {
        resetWorkSizeTurnCountersOnSessionStart({
          cwd: projectDir,
          env,
          workspacePaths,
          globalDir: effectiveGlobalDir,
          terminalId,
          sessionId: convId,
          config,
          loadConfigForRoot,
          isEnabledForRoot: isProjectEnabled,
          now: invokeNowDate,
        });
        pushSection(getWorkSizeSessionNotice({
          cwd: projectDir,
          env,
          workspacePaths,
          globalDir: effectiveGlobalDir,
          terminalId,
          sessionId: convId,
          config,
          loadConfigForRoot,
          isEnabledForRoot: isProjectEnabled,
        }));
      } catch {
        // ignore work-size state errors in hook
      }
    }
    pushOverviewSections({ pushSection, remaining: () => budget - used, ...overviewArgs });
    cpState.started = true;
    stateDirty = true;
    injectedStartupThisTurn = true;
  }

  // 3. Fast (mtime, size) transcript check + CHECKPOINT (DONE) restore
  if (transcriptPath && convId) {
    const actualTranscript = resolveAntigravityTranscriptPath(transcriptPath);
    let stat = null;
    if (actualTranscript) {
      try {
        stat = fs.statSync(actualTranscript);
      } catch {
        stat = null;
      }
    }

    const transcriptChanged = Boolean(
      stat
      && stat.isFile()
      && stat.size > 0
      && (
        cpState.transcriptPath !== actualTranscript
        || cpState.transcriptMtimeMs !== stat.mtimeMs
        || cpState.transcriptSize !== stat.size
      ),
    );

    if (transcriptChanged) {
      const readerOptions = {
        ...(turnOptions && typeof turnOptions === 'object' ? turnOptions : {}),
        maxTurns: 5,
        maxChars: Math.min(4500, Math.max(300, Math.floor(budget * 0.5))),
      };
      // This probe runs on every prompt, so it only looks at the first tail window. The window grows (see
      // `extractRecentTurns`) only when a new checkpoint means the turns are actually restored.
      const state = extractAntigravityState(actualTranscript, {
        ...readerOptions,
        maxTailBytesCap: readerOptions.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES,
      });

      cpState.transcriptPath = actualTranscript;
      cpState.transcriptMtimeMs = stat.mtimeMs;
      cpState.transcriptSize = stat.size;
      stateDirty = true;

      if (state.latestCheckpoint?.key && state.latestCheckpoint.key !== cpState.checkpoint) {
        const turns = worker
          ? null
          : (state.candidateTurns.filter((t) => t.user).length >= readerOptions.maxTurns
              ? state
              : extractAntigravityState(actualTranscript, readerOptions));

        if (!injectedStartupThisTurn) {
          if (!worker) {
            const headCore = readHeadCore(promptsDir, config, repoRoot);
            if (headCore) {
              pushHeadCore(headCore);
            }
          }
          pushSection(notApprovedNotice);

          pushOverviewSections({
            pushSection,
            remaining: () => budget - used,
            reserve: turns?.text ? Math.min(turns.text.length, Math.floor((budget - used) * 0.5)) : 0,
            ...overviewArgs,
          });
        }

        if (!worker && turns) {
          if (turns.text) {
            const remaining = budget - used;
            if (turns.text.length <= remaining) {
              pushSection(turns.text);
            } else if (remaining >= 160) {
              const refit = formatRecentTurns(turns.candidateTurns, { maxChars: remaining });
              if (refit.text) {
                pushSection(refit.text);
              }
            }
          } else {
            pushSection(restoreFailureNote(turns.restoreFailure));
          }
        }

        cpState.checkpoint = state.latestCheckpoint.key;
        stateDirty = true;
      }
    }
  }

  if (cpPaths && stateDirty) {
    atomicWriteJson(cpPaths.jsonPath, cpState);
  }

  // 4. Work-size non-blocking notices (per-user-input reminders + queued PreToolUse/PostToolUse notices)
  if (!worker && !delegatedForTurn) {
    try {
      if (isNewUserTurn) {
        const promptEval = evaluateWorkSizePrompt({
          cwd: projectDir,
          env,
          workspacePaths,
          globalDir: effectiveGlobalDir,
          terminalId,
          sessionId: convId,
          config,
          loadConfigForRoot,
          isEnabledForRoot: isProjectEnabled,
          now: invokeNowDate,
        });
        if (promptEval.completedNotice) pushSection(promptEval.completedNotice);
        if (promptEval.unsavedNotice) pushSection(promptEval.unsavedNotice);
        if (promptEval.periodicNotice) pushSection(promptEval.periodicNotice);
      }

      const queuedNotices = consumeWorkSizePendingNotices({
        cwd: projectDir,
        env,
        workspacePaths,
        globalDir: effectiveGlobalDir,
        terminalId,
        sessionId: convId,
        config,
        loadConfigForRoot,
        isEnabledForRoot: isProjectEnabled,
        maxChars: budget - used,
        now: invokeNowDate,
      });
      for (const notice of queuedNotices) {
        pushSection(notice);
      }
    } catch {
      // ignore work-size state errors in hook
    }
  }

  // 5. Budget-first relay inbox delivery
  if (!worker && isValidTerminalId(terminalId)) {
    const remaining = budget - used;
    if (remaining >= 120) {
      try {
        const delivered = deliverInboxForHook(terminalId, {
          globalDir: effectiveGlobalDir,
          projectDir,
          maxChars: Math.min(ANTIGRAVITY_INBOX_MAX_CHARS, remaining),
          fullBlockChars: Math.min(ANTIGRAVITY_INBOX_MAX_CHARS, budget),
          nowMs: invokeNowMs,
        });
        if (delivered.text) {
          pushSection(delivered.text);
        }
      } catch {
        // ignore inbox errors in hook
      }
    }
  }

  return wrapAntigravityInjectSteps(sections);
}

/**
 * Antigravity PreToolUse handler:
 * - Always returns a valid `decision` (`"ask"`, `"deny"`, or `"force_ask"`), NEVER `{}` or `"allow"`.
 * - Wraps the entire body so any exception, malformed payload, or unwritable state directory falls back
 *   to `{"decision":"ask"}`.
 * - Counts and enforces work-size limits on `write_file` (`Content`) and `edit_file` (`Replacement`),
 *   counts per-turn reads on `read_file` (queuing non-blocking notices for the next `PreInvocation`),
 *   and enforces hard-to-reverse command confirmation (`force_ask` in main, `deny` in worker/subagent)
 *   on `run_command` with unknown shell kind (`shell: ''`).
 */
export function handleAntigravityPreToolUse(
  payload = {},
  {
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    now = Date.now,
    dependencyLookupOptions,
    lockOptions,
  } = {},
) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { decision: 'ask' };
    }
    const toolCall = payload.toolCall && typeof payload.toolCall === 'object' && !Array.isArray(payload.toolCall)
      ? payload.toolCall
      : null;
    if (!toolCall) {
      return { decision: 'ask' };
    }
    const toolName = typeof toolCall.name === 'string' ? toolCall.name.trim() : '';
    if (!toolName) {
      return { decision: 'ask' };
    }
    const rawArgs = toolCall.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)
      ? toolCall.args
      : {};

    // Fast-fail UNC (`\\...`) and overlong (>1,024 chars) `Path` inputs before any filesystem/realpath lookup
    // so Windows SMB network timeouts and deep parent walks cannot stall synchronous `PreToolUse` execution.
    if (isUncOrOverlongToolPath(rawArgs.Path)) {
      return { decision: 'ask' };
    }
    const cwd = extractCwd(payload, process.cwd());
    if (typeof rawArgs.Path === 'string' && !path.isAbsolute(rawArgs.Path)) {
      if (
        typeof cwd === 'string'
        && (isUncOrOverlongToolPath(cwd) || path.join(cwd, rawArgs.Path).length > ANTIGRAVITY_MAX_TOOL_PATH_CHARS)
      ) {
        return { decision: 'ask' };
      }
    }

    const caller = classifyAntigravityCaller(payload);
    const callerIsSubagent = caller.kind === 'subagent';
    const isConfirmedRoot = caller.kind === 'root';
    const worker = isWorkerSession({ env });
    const workspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : undefined;
    const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
    const nowDate = new Date(Number(typeof now === 'function' ? now() : now) || Date.now());
    const delegated = !callerIsSubagent && !worker && isValidTerminalId(terminalId)
      ? Boolean(getTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: nowDate }))
      : false;
    const actsAsWorker = worker || delegated;

    // 1. This server's MCP tools (direct or via Antigravity `call_mcp_tool`)
    const cortexCall = resolveAntigravityCortexTool(toolName, rawArgs);
    if (cortexCall.isCortex) {
      if (callerIsSubagent && isWriteProtectedCortexBaseName(cortexCall.baseName, cortexCall.args)) {
        return ensureValidPreToolDecision({ decision: 'deny', reason: SUBAGENT_CORTEX_WRITE_DENY_REASON });
      }
      if (isConfirmedRoot) {
        const scope = resolveWorkSizeScope({ terminalId, sessionId: caller.convId });
        const wsRoot = resolveWorkSizeProjectRoot({
          cwd,
          env,
          workspacePaths,
          globalDir: effectiveGlobalDir,
          scope,
        });
        const otherDir = otherProjectWriteTargetByBaseName(cortexCall.baseName, cortexCall.args, wsRoot);
        if (otherDir) {
          return ensureValidPreToolDecision({
            decision: 'force_ask',
            reason: formatOtherProjectWriteReason(otherDir),
          });
        }
      }
      return { decision: 'ask' };
    }

    // 2. File-edit tools (`write_file`, `edit_file`)
    if (ANTIGRAVITY_FILE_WRITE_TOOLS.has(toolName)) {
      const filePath = typeof rawArgs.Path === 'string' ? rawArgs.Path : '';
      if (callerIsSubagent && isPathInsideMemoryDir(filePath, cwd)) {
        return ensureValidPreToolDecision({ decision: 'deny', reason: SUBAGENT_MEMORY_DIR_DENY_REASON });
      }

      const stateTarget = inspectStateFilePath(filePath, cwd, effectiveGlobalDir);
      if (stateTarget) {
        if (callerIsSubagent) {
          return ensureValidPreToolDecision({ decision: 'deny', reason: SUBAGENT_TRUST_CHANGE_DENY_REASON });
        }
        if (actsAsWorker && commandReferencesWorkSizeState(stateTarget.path, effectiveGlobalDir)) {
          return ensureValidPreToolDecision({ decision: 'deny', reason: WORK_STATE_SHELL_DENY_REASON });
        }
        if (isConfirmedRoot) {
          return ensureValidPreToolDecision({
            decision: 'force_ask',
            reason: formatStateFileWriteAskReason(stateTarget.path, { approvalsFile: stateTarget.approvalsFile }),
          });
        }
      }

      if (!isConfirmedRoot || actsAsWorker) {
        return { decision: 'ask' };
      }

      if (filePath.trim()) {
        const addedChars = toolName === 'write_file'
          ? (typeof rawArgs.Content === 'string' ? rawArgs.Content.length : 0)
          : (typeof rawArgs.Replacement === 'string' ? rawArgs.Replacement.length : 0);
        const evaluated = evaluateWorkSizeEdit({
          filePath,
          addedChars,
          cwd,
          env,
          workspacePaths,
          globalDir: effectiveGlobalDir,
          terminalId,
          sessionId: caller.convId,
          loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
          isEnabledForRoot: isProjectEnabled,
          dependencyLookupOptions,
          queueNotice: true,
          lockOptions,
          now: nowDate,
        });
        if (evaluated.action === 'deny') {
          return ensureValidPreToolDecision({ decision: 'deny', reason: evaluated.denyReason });
        }
      }
      return { decision: 'ask' };
    }

    // 3. Shell tool (`run_command`, shell kind unknown -> `shell: ''` inspects both interpretations)
    if (ANTIGRAVITY_SHELL_TOOLS.has(toolName)) {
      const command = typeof rawArgs.CommandLine === 'string' ? rawArgs.CommandLine : '';
      if (callerIsSubagent && commandReferencesMemoryDir(command)) {
        return ensureValidPreToolDecision({ decision: 'deny', reason: SUBAGENT_MEMORY_DIR_DENY_REASON });
      }

      const trustKind = classifyTrustCommand(command);
      if (callerIsSubagent && (trustKind === 'approvals-file' || trustKind === 'runs-cli')) {
        return ensureValidPreToolDecision({ decision: 'deny', reason: SUBAGENT_TRUST_CHANGE_DENY_REASON });
      }
      if (isConfirmedRoot && trustKind === 'approvals-file') {
        return ensureValidPreToolDecision({ decision: 'force_ask', reason: formatTrustCommandAskReason(command) });
      }

      const shellBudget = createShellInspectionBudget();
      if (
        commandReferencesWorkSizeState(command, effectiveGlobalDir, { shell: '', budget: shellBudget })
        && !isShellGuardReadOnly(command, '')
      ) {
        if (callerIsSubagent || actsAsWorker) {
          return ensureValidPreToolDecision({ decision: 'deny', reason: WORK_STATE_SHELL_DENY_REASON });
        }
        if (isConfirmedRoot) {
          return ensureValidPreToolDecision({
            decision: 'force_ask',
            reason: formatWorkSizeStateShellAskReason(command),
          });
        }
      }

      const workCmdKind = classifyWorkCommand(command, { shell: '', budget: shellBudget });
      if (workCmdKind === 'runs-cli') {
        if (callerIsSubagent || actsAsWorker) {
          return ensureValidPreToolDecision({ decision: 'deny', reason: WORK_COMMAND_DENY_REASON });
        }
        if (isConfirmedRoot) {
          return ensureValidPreToolDecision({
            decision: 'force_ask',
            reason: formatWorkCommandAskReason(command),
          });
        }
      }

      const scope = resolveWorkSizeScope({ terminalId, sessionId: caller.convId });
      const rootDir = resolveWorkSizeProjectRoot({
        cwd,
        env,
        workspacePaths,
        globalDir: effectiveGlobalDir,
        scope,
      });
      const cfg = loadConfig({ projectDir: rootDir, globalDir: effectiveGlobalDir });
      if (isProjectEnabled(rootDir, cfg)) {
        const wsCfg = resolveWorkSizeConfig(cfg);
        if (wsCfg.confirmCommands) {
          const confirmMatch = inspectConfirmableShellCommand(command, {
            confirmCommands: wsCfg.confirmCommands,
            confirmCommandPatterns: wsCfg.confirmCommandPatterns,
            env,
            shell: '',
            config: cfg,
            budget: shellBudget,
          });
          if (confirmMatch.matched) {
            if (callerIsSubagent || actsAsWorker) {
              return ensureValidPreToolDecision({
                decision: 'deny',
                reason: formatConfirmCommandDenyReason(confirmMatch),
              });
            }
            if (isConfirmedRoot) {
              return ensureValidPreToolDecision({
                decision: 'force_ask',
                reason: formatConfirmCommandAskReason(confirmMatch, command),
              });
            }
          }
        }
      }

      return { decision: 'ask' };
    }

    // 4. File-read tool (`read_file`; queues non-blocking notice for the next `PreInvocation`)
    if (ANTIGRAVITY_FILE_READ_TOOLS.has(toolName)) {
      if (isConfirmedRoot && !actsAsWorker) {
        evaluateWorkSizeRead({
          cwd,
          env,
          workspacePaths,
          globalDir: effectiveGlobalDir,
          terminalId,
          sessionId: caller.convId,
          loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
          isEnabledForRoot: isProjectEnabled,
          queueNotice: true,
          lockOptions,
          now: nowDate,
        });
      }
      return { decision: 'ask' };
    }

    return { decision: 'ask' };
  } catch {
    return { decision: 'ask' };
  }
}

/**
 * Antigravity PostToolUse handler:
 * - Always returns `{}`.
 * - On `run_command`, counts failure ONLY when `payload.error` is a non-empty string; on success, resets
 *   failed-retry counts and clears the cumulative window when `CommandLine` ran an in-project `git commit`.
 * - On this server's `memory_save` (without non-empty `error`), clears the cumulative window and records
 *   `memorySaved` for active `L` jobs.
 */
export function handleAntigravityPostToolUse(
  payload = {},
  {
    env = process.env,
    terminalId = env?.HC_TERMINAL_ID,
    globalDir,
    now = Date.now,
    lockOptions,
  } = {},
) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }
    const caller = classifyAntigravityCaller(payload);
    if (caller.kind !== 'root' || isWorkerSession({ env })) {
      return {};
    }

    const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
    const nowDate = new Date(Number(typeof now === 'function' ? now() : now) || Date.now());
    if (isValidTerminalId(terminalId) && getTabDelegation(terminalId, { globalDir: effectiveGlobalDir, now: nowDate })) {
      return {};
    }

    const toolCall = payload.toolCall && typeof payload.toolCall === 'object' && !Array.isArray(payload.toolCall)
      ? payload.toolCall
      : null;
    if (!toolCall) return {};
    const toolName = typeof toolCall.name === 'string' ? toolCall.name.trim() : '';
    if (!toolName) return {};
    const rawArgs = toolCall.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)
      ? toolCall.args
      : {};

    const cwd = extractCwd(payload, process.cwd());
    const workspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : undefined;
    const hasError = typeof payload.error === 'string' && payload.error.trim().length > 0;

    if (ANTIGRAVITY_SHELL_TOOLS.has(toolName)) {
      const command = typeof rawArgs.CommandLine === 'string' ? rawArgs.CommandLine : '';
      recordShellResultForWorkSize({
        ok: !hasError,
        isInterrupt: false,
        command,
        shell: '',
        cwd,
        env,
        workspacePaths,
        globalDir: effectiveGlobalDir,
        terminalId,
        sessionId: caller.convId,
        loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
        isEnabledForRoot: isProjectEnabled,
        lockOptions,
        now: nowDate,
      });
      return {};
    }

    const cortexCall = resolveAntigravityCortexTool(toolName, rawArgs, { allowMemorySaveSuffix: true });
    if (cortexCall.isCortex && cortexCall.baseName === 'memory_save') {
      if (hasError) return {};
      const scope = resolveWorkSizeScope({ terminalId, sessionId: caller.convId });
      const wsRoot = resolveWorkSizeProjectRoot({
        cwd,
        env,
        workspacePaths,
        globalDir: effectiveGlobalDir,
        scope,
      });
      if (otherProjectWriteTargetByBaseName('memory_save', cortexCall.args, wsRoot)) {
        return {};
      }
      recordMemorySaveForWorkSize({
        cwd,
        env,
        workspacePaths,
        globalDir: effectiveGlobalDir,
        terminalId,
        sessionId: caller.convId,
        loadConfigForRoot: (root) => loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }),
        isEnabledForRoot: isProjectEnabled,
        lockOptions,
        now: nowDate,
      });
    }

    return {};
  } catch {
    return {};
  }
}

export function runAntigravityHook(eventName, payload = {}, options = {}) {
  const event = String(eventName || '').trim().toLowerCase();
  switch (event) {
    case 'session-start':
      return handleAntigravitySessionStart(payload, options);
    case 'pre-invocation':
      return handleAntigravityPreInvocation(payload, options);
    case 'pre-tool-use':
      try {
        return ensureValidPreToolDecision(handleAntigravityPreToolUse(payload, options));
      } catch {
        return { decision: 'ask' };
      }
    case 'post-tool-use':
      try {
        handleAntigravityPostToolUse(payload, options);
      } catch {
        // ignore
      }
      return {};
    default:
      return {};
  }
}

function parseCliArgs(argv) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? '');
    if (arg === '--id' || arg === '--marker') {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }
  return { event: positional[0] || '' };
}

if (isMainModule(import.meta.url)) {
  let cliEvent = '';
  try {
    cliEvent = String(parseCliArgs(process.argv.slice(2)).event || '').trim().toLowerCase();
  } catch {
    cliEvent = process.argv.slice(2).some((a) => String(a).trim().toLowerCase() === 'pre-tool-use')
      ? 'pre-tool-use'
      : '';
  }
  const isPreToolUse = cliEvent === 'pre-tool-use';
  let emitted = false;
  const emitAndExit = (candidate) => {
    if (emitted) return;
    emitted = true;
    let body = '{}';
    try {
      const normalized = isPreToolUse
        ? ensureValidPreToolDecision(candidate)
        : (candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {});
      body = JSON.stringify(normalized);
    } catch {
      body = isPreToolUse ? '{"decision":"ask"}' : '{}';
    }
    try {
      process.stdout.write(`${body}\n`);
    } catch {
      // ignore broken pipe
    }
    process.exit(0);
  };

  process.on('uncaughtException', () => emitAndExit(isPreToolUse ? { decision: 'ask' } : {}));
  process.on('unhandledRejection', () => emitAndExit(isPreToolUse ? { decision: 'ask' } : {}));

  let output = isPreToolUse ? { decision: 'ask' } : {};
  try {
    const raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
    let payload = {};
    if (raw && raw.trim()) {
      payload = JSON.parse(raw);
    }
    // The index sync budget counts from the start of this process, not from here.
    output = runAntigravityHook(cliEvent, payload, { startedAt: Math.round(performance.timeOrigin) });
  } catch {
    output = isPreToolUse ? { decision: 'ask' } : {};
  }
  emitAndExit(output);
}
