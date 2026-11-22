#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT,
  assertInsideDir,
  atomicWriteText,
  getProjectMemoryDir,
  getTierPaths,
  isProjectEnabled,
  loadConfig,
} from '../core/config.mjs';
import { CortexStore } from '../core/store.mjs';
import { fitOverviewToBudget } from '../core/budget.mjs';
import {
  extractCwd,
  extractSessionId,
  isSubagentPayload,
  isValidTerminalId,
  recordSession,
  resolveCortexGlobalDir,
} from '../revive/tracker.mjs';
import { drainInbox, formatInboxForHook } from '../relay/inbox.mjs';
import { extractAntigravityState } from './recent-turns.mjs';
import { COMPACT_POINTER_INSTRUCTION } from './claude.mjs';

const SAFE_CONV_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

function wrapAntigravityInject(text) {
  if (!text || !text.trim()) return {};
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: text.trim(),
        },
      },
    ],
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

function resolveCheckpointFile(projectDir, convId) {
  const cleanConv = String(convId || '').trim();
  if (!SAFE_CONV_ID_RE.test(cleanConv) || cleanConv.includes('..')) return null;
  const { checkpointsDir } = getTierPaths(getProjectMemoryDir(projectDir));
  return assertInsideDir(checkpointsDir, `${cleanConv}.txt`);
}

function readCheckpointKey(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
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

/**
 * Antigravity SessionStart handler.
 */
export function handleAntigravitySessionStart(
  payload = {},
  {
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
  const budget = Math.max(256, Number(config.hookBudget) || 9000);

  recordSession({
    terminalId,
    agent: 'antigravity',
    payload,
    cwd: projectDir,
    globalDir: effectiveGlobalDir,
    legacyHome,
  });

  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }

  const parts = [];
  let used = 0;

  const headCore = readHeadCore(promptsDir, config);
  if (headCore) {
    parts.push(headCore);
    used += headCore.length;
  }

  const overview = loadOverviewSafely({ projectDir, globalDir: effectiveGlobalDir, config });
  if (overview) {
    const overviewBudget = Math.max(256, budget - used - (parts.length > 0 ? 2 : 0));
    const fitted = fitOverviewToBudget(overview, overviewBudget);
    if (fitted.text) {
      parts.push(fitted.text);
      used += (parts.length > 1 ? 2 : 0) + fitted.text.length;
    }
  }

  if (isValidTerminalId(terminalId) && fs.existsSync(getProjectMemoryDir(projectDir))) {
    try {
      const drained = drainInbox(projectDir, terminalId);
      if (drained.messages.length > 0) {
        const inboxText = formatInboxForHook(drained.messages, { maxChars: 2500 });
        if (inboxText) {
          parts.push(inboxText);
          drained.ack();
        }
      }
    } catch {
      // ignore inbox errors in hook
    }
  }

  return wrapAntigravityInject(parts.join('\n\n'));
}

/**
 * Antigravity PreInvocation handler:
 *  1) Updates revive session if root conversation.
 *  2) If lastUserInput === '/compact', injects 1-line compact pointer.
 *  3) Detects new CHECKPOINT (DONE) in transcript_full.jsonl compared to
 *     .memory/state/checkpoints/<convId>.txt; on change, re-injects
 *     HEAD_CORE.md + fitted overview + last 5 turns once and persists new key.
 *  4) Drains relay inbox for HC_TERMINAL_ID.
 */
export function handleAntigravityPreInvocation(
  payload = {},
  {
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
  const budget = Math.max(256, Number(config.hookBudget) || 9000);

  recordSession({
    terminalId,
    agent: 'antigravity',
    payload,
    cwd: projectDir,
    globalDir: effectiveGlobalDir,
    legacyHome,
  });

  if (!isProjectEnabled(projectDir, config)) {
    return {};
  }

  const parts = [];

  // 1. Detect /compact command (with or without trailing arguments)
  const lastInput = String(payload.lastUserInput ?? payload.userInput ?? '').trim();
  if (/^\/compact(?:\s|$)/i.test(lastInput)) {
    parts.push(COMPACT_POINTER_INSTRUCTION);
  }

  // 2. Detect new CHECKPOINT (DONE) in transcript_full.jsonl
  const transcriptPath = extractTranscriptPath(payload);
  const convId = extractSessionId(payload);
  if (transcriptPath && convId) {
    const state = extractAntigravityState(transcriptPath, {
      maxTurns: 5,
      maxChars: Math.min(4500, Math.max(500, Math.floor(budget * 0.5))),
    });

    if (state.latestCheckpoint?.key) {
      const cpFile = resolveCheckpointFile(projectDir, convId);
      const prevKey = readCheckpointKey(cpFile);
      if (cpFile && prevKey !== state.latestCheckpoint.key) {
        const restoreParts = [];
        let restoreUsed = 0;

        const headCore = readHeadCore(promptsDir, config);
        if (headCore) {
          restoreParts.push(headCore);
          restoreUsed += headCore.length;
        }

        const overview = loadOverviewSafely({ projectDir, globalDir: effectiveGlobalDir, config });
        if (overview) {
          const turnsReserve = state.text ? state.text.length + 2 : 0;
          const ovBudget = Math.max(256, budget - restoreUsed - turnsReserve - 4);
          const fitted = fitOverviewToBudget(overview, ovBudget);
          if (fitted.text) {
            restoreParts.push(fitted.text);
          }
        }

        if (state.text) {
          restoreParts.push(state.text);
        }

        if (restoreParts.length > 0) {
          parts.push(restoreParts.join('\n\n'));
        }

        if (state.latestCheckpoint.key) {
          atomicWriteText(cpFile, `${state.latestCheckpoint.key}\n`);
        }
      }
    }
  }

  // 3. Drain relay inbox
  if (isValidTerminalId(terminalId) && fs.existsSync(getProjectMemoryDir(projectDir))) {
    try {
      const drained = drainInbox(projectDir, terminalId);
      if (drained.messages.length > 0) {
        const inboxText = formatInboxForHook(drained.messages, { maxChars: 2500 });
        if (inboxText) {
          parts.push(inboxText);
          drained.ack();
        }
      }
    } catch {
      // ignore inbox errors in hook
    }
  }

  return wrapAntigravityInject(parts.join('\n\n'));
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let output = {};
  try {
    const { event } = parseCliArgs(process.argv.slice(2));
    const raw = fs.readFileSync(0, 'utf8');
    let payload = {};
    if (raw && raw.trim()) {
      payload = JSON.parse(raw);
    }
    output = runAntigravityHook(event, payload);
  } catch {
    output = {};
  }
  process.stdout.write(`${JSON.stringify(output || {})}\n`);
  process.exit(0);
}
