#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  assertInsideDir,
  atomicWriteJson,
  getProjectMemoryDir,
  getTierPaths,
  hasProjectMemoryDir,
  isMainModule,
  isProjectEnabled,
  isProjectTrusted,
  loadConfig,
} from '../core/config.mjs';
import { fitOverviewToBudget, resolveHookBudget } from '../core/budget.mjs';
import { isWorkerSession } from '../core/role.mjs';
import { formatProjectNotApprovedNotice } from '../core/trust.mjs';
import {
  extractCwd,
  extractSessionId,
  isSubagentPayload,
  isValidTerminalId,
  recordSession,
  resolveCortexGlobalDir,
} from '../revive/tracker.mjs';
import { deliverInboxForHook } from '../relay/inbox.mjs';
import { formatUnindexedNotice, loadHookOverview, resolveHookSyncOptions } from './overview.mjs';
import { checkApprovalsForSession, pruneApprovalCheckRecords } from './approvals-watch.mjs';
import {
  DEFAULT_MAX_TAIL_BYTES,
  extractAntigravityState,
  formatRecentTurns,
  resolveAntigravityTranscriptPath,
} from './recent-turns.mjs';
import { buildCompactInstruction, restoreFailureNote } from './claude.mjs';

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

// Notice injected with the startup context when the folder has a .memory/ directory that was not loaded.
function resolveNotApprovedNotice(projectDir, projectTrusted) {
  return !projectTrusted && hasProjectMemoryDir(projectDir) ? formatProjectNotApprovedNotice(projectDir) : '';
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
  if (!cpPaths) return { started: false, checkpoint: '' };
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
        };
      }
    }
    if (fs.existsSync(cpPaths.legacyTxtPath)) {
      const legacyKey = fs.readFileSync(cpPaths.legacyTxtPath, 'utf8').trim();
      return { started: true, checkpoint: legacyKey };
    }
  } catch {
    // ignore corrupt checkpoint state
  }
  return { started: false, checkpoint: '' };
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
 * Push the memory overview of an injection. The index is synced under the hook's limits first; documents
 * that sync left out are named in a one-line notice of their own, which is counted in the budget like every
 * other section. `remaining()` is the budget that is left, `reserve` keeps room for text that follows.
 */
function pushOverviewSections({ pushSection, remaining, reserve = 0, ...overviewArgs }) {
  const { overview, unindexed } = loadHookOverview(overviewArgs);
  if (unindexed.length > 0) {
    pushSection(formatUnindexedNotice(unindexed, { maxChars: remaining() }));
  }
  if (!overview) return;
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
    legacyHome,
    promptsDir = path.join(REPO_ROOT, 'prompts'),
    startedAt,
    indexBudget,
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
  const notApprovedNotice = resolveNotApprovedNotice(projectDir, projectTrusted);

  const sections = [];
  let used = 0;

  const pushSection = (text) => {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean) return;
    if (used + clean.length <= budget) {
      sections.push(clean);
      used += clean.length;
    }
  };

  pruneApprovalCheckRecords(effectiveGlobalDir);
  pushSection(resolveApprovalsWarning(effectiveGlobalDir, convId));

  if (!worker) {
    const headCore = readHeadCore(promptsDir, config);
    if (headCore) {
      pushSection(trimLinesToBudget(headCore, budget - used - notApprovedNotice.length));
    }
  }
  pushSection(notApprovedNotice);

  pushOverviewSections({
    pushSection,
    remaining: () => budget - used,
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
        });
        if (delivered.text) {
          pushSection(delivered.text);
        }
      } catch {
        // ignore inbox errors in hook
      }
    }
  }

  if (convId && sections.length > 0) {
    const cpPaths = resolveCheckpointFile(projectDir, effectiveGlobalDir, convId, projectTrusted);
    if (cpPaths) {
      const existing = readCheckpointState(cpPaths);
      atomicWriteJson(cpPaths.jsonPath, {
        ...existing,
        started: true,
      });
    }
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
    legacyHome,
    promptsDir = path.join(REPO_ROOT, 'prompts'),
    startedAt,
    indexBudget,
    turnOptions,
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

  const sections = [];
  let used = 0;

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

  // 0. Approvals changed without the confirmation dialog (first, so it always fits)
  pushSection(resolveApprovalsWarning(effectiveGlobalDir, convId));

  // 1. Detect /compact command (with or without trailing arguments)
  // The softened instruction: what is saved in memory need not be restated, what is not saved must be kept.
  if (/^\/compact(?:\s|$)/i.test(lastInput)) {
    pushSection(buildCompactInstruction({ hasUserInstructions: /^\/compact\s+\S/i.test(lastInput) }));
  }

  const overviewArgs = {
    projectDir,
    globalDir: effectiveGlobalDir,
    config,
    projectTrusted,
    syncOptions: resolveHookSyncOptions({ startedAt, indexBudget }),
  };

  // 2. First root PreInvocation startup injection (deferred from SessionStart)
  let injectedStartupThisTurn = false;
  if (!cpState.started) {
    if (!worker) {
      const headCore = readHeadCore(promptsDir, config);
      if (headCore) {
        pushSection(trimLinesToBudget(headCore, budget - used - notApprovedNotice.length));
      }
    }
    pushSection(notApprovedNotice);
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
            const headCore = readHeadCore(promptsDir, config);
            if (headCore) {
              pushSection(trimLinesToBudget(headCore, budget - used - notApprovedNotice.length));
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

  // 4. Budget-first relay inbox delivery
  if (!worker && isValidTerminalId(terminalId)) {
    const remaining = budget - used;
    if (remaining >= 120) {
      try {
        const delivered = deliverInboxForHook(terminalId, {
          globalDir: effectiveGlobalDir,
          projectDir,
          maxChars: Math.min(ANTIGRAVITY_INBOX_MAX_CHARS, remaining),
          fullBlockChars: Math.min(ANTIGRAVITY_INBOX_MAX_CHARS, budget),
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

export function runAntigravityHook(eventName, payload = {}, options = {}) {
  const event = String(eventName || '').trim().toLowerCase();
  switch (event) {
    case 'session-start':
      return handleAntigravitySessionStart(payload, options);
    case 'pre-invocation':
      return handleAntigravityPreInvocation(payload, options);
    default:
      return {};
  }
}

function parseCliArgs(argv) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
  let output = {};
  try {
    const { event } = parseCliArgs(process.argv.slice(2));
    const raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
    let payload = {};
    if (raw && raw.trim()) {
      payload = JSON.parse(raw);
    }
    // The index sync budget counts from the start of this process, not from here.
    output = runAntigravityHook(event, payload, { startedAt: Math.round(performance.timeOrigin) });
  } catch {
    output = {};
  }
  process.stdout.write(`${JSON.stringify(output || {})}\n`);
  process.exit(0);
}
