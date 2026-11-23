import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertInsideDir,
  atomicWriteJson,
  getGlobalDir,
  getTierPaths,
} from '../core/config.mjs';

const TERMINAL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const RESERVED_WIN_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

export const MAX_SESSION_HISTORY = 5;

export function isValidSessionId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!SESSION_ID_RE.test(trimmed)) return false;
  if (trimmed.includes('..')) return false;
  return true;
}

export function isValidTerminalId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!TERMINAL_ID_RE.test(trimmed)) return false;
  if (RESERVED_WIN_NAMES.has(trimmed.toLowerCase())) return false;
  return true;
}

export function validateTerminalId(id) {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!isValidTerminalId(trimmed)) {
    throw new Error(`Invalid terminalId "${String(id)}": must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ and not be a reserved name`);
  }
  return trimmed;
}

export function resolveEffectiveHome(overrideHome) {
  if (overrideHome) return path.resolve(overrideHome);
  if (process.env.HERDR_CORTEX_TEST_HOME) return path.resolve(process.env.HERDR_CORTEX_TEST_HOME);
  if (process.env.HERDR_REVIVE_TEST_HOME) return path.resolve(process.env.HERDR_REVIVE_TEST_HOME);
  return os.homedir();
}

export function resolveCortexGlobalDir(overrideGlobalDir) {
  if (overrideGlobalDir) return path.resolve(overrideGlobalDir);
  if (process.env.HERDR_CORTEX_HOME) return path.resolve(process.env.HERDR_CORTEX_HOME);
  const testHome = process.env.HERDR_CORTEX_TEST_HOME || process.env.HERDR_REVIVE_TEST_HOME;
  if (testHome) return path.join(path.resolve(testHome), '.herdr-cortex');
  return getGlobalDir();
}

export function getSessionsDir(overrideGlobalDir) {
  return getTierPaths(resolveCortexGlobalDir(overrideGlobalDir)).sessionsDir;
}

export function getLegacySessionsDir(overrideHome) {
  return path.join(resolveEffectiveHome(overrideHome), '.herdr-revive', 'sessions');
}

/**
 * CRITICAL SUBAGENT GUARD:
 * Detect if a hook payload originates from a subagent so subagents NEVER
 * overwrite the parent tab's saved session ID.
 */
export function isSubagentPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;

  const agentId = payload.agent_id || payload.agentId;
  if (agentId && String(agentId).trim() !== '') return true;
  if (payload.is_subagent === true || payload.isSubagent === true) return true;

  const parentId =
    payload.parentConversationId
    || payload.parent_conversation_id
    || payload.parentSessionId
    || payload.parent_session_id;
  if (parentId && String(parentId).trim() !== '') return true;

  const convId = payload.conversationId || payload.conversation_id;
  const rootConvId = payload.rootConversationId || payload.root_conversation_id;
  if (convId && rootConvId && String(convId).trim() !== String(rootConvId).trim()) {
    return true;
  }

  return false;
}

export function extractSessionId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidate =
    payload.conversationId
    || payload.conversation_id
    || payload.session_id
    || payload.sessionId
    || '';
  if (typeof candidate !== 'string') return '';
  const trimmed = candidate.trim();
  return isValidSessionId(trimmed) ? trimmed : '';
}

export function extractCwd(payload, fallbackCwd = process.cwd()) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.cwd === 'string' && payload.cwd.trim()) {
      return payload.cwd.trim();
    }
    if (Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === 'string' && payload.workspacePaths[0].trim()) {
      return payload.workspacePaths[0].trim();
    }
    if (typeof payload.workspacePath === 'string' && payload.workspacePath.trim()) {
      return payload.workspacePath.trim();
    }
  }
  return typeof fallbackCwd === 'string' ? fallbackCwd : '';
}

function readJsonFileSafe(filePath) {
  const maxRetries = 6;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      const retryable = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (retryable && attempt < maxRetries) {
        sleepSync(15 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Read a saved session record for terminalId.
 * Checks <globalDir>/sessions/<terminalId>.json first, then falls back to
 * legacy ~/.herdr-revive/sessions/<terminalId>.json if not yet migrated.
 */
export function readSavedSession(terminalId, { globalDir, legacyHome } = {}) {
  if (!isValidTerminalId(terminalId)) return null;
  const cleanId = terminalId.trim();

  try {
    const primaryDir = getSessionsDir(globalDir);
    const primaryPath = assertInsideDir(primaryDir, `${cleanId}.json`);
    const primary = readJsonFileSafe(primaryPath);
    if (primary) {
      return {
        ...primary,
        terminalId: primary.terminalId || cleanId,
        source: 'cortex',
      };
    }
  } catch (err) {
    if (!err || (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'ENOENT')) {
      throw err;
    }
  }

  try {
    const legacyDir = getLegacySessionsDir(legacyHome);
    const legacyPath = assertInsideDir(legacyDir, `${cleanId}.json`);
    const legacy = readJsonFileSafe(legacyPath);
    if (legacy) {
      return {
        ...legacy,
        terminalId: legacy.terminalId || cleanId,
        source: 'legacy',
      };
    }
  } catch (err) {
    if (!err || (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'ENOENT')) {
      throw err;
    }
  }

  return null;
}

/**
 * List all saved sessions from cortex sessionsDir merged with any unmigrated legacy sessions.
 */
export function listSavedSessions({ globalDir, legacyHome } = {}) {
  const byId = new Map();

  const readDirInto = (dir, source, overwrite) => {
    let entries;
    try {
      if (!fs.existsSync(dir)) return;
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const tid = ent.name.slice(0, -5);
      if (!isValidTerminalId(tid)) continue;
      if (!overwrite && byId.has(tid)) continue;
      let filePath;
      try {
        filePath = assertInsideDir(dir, ent.name);
      } catch {
        continue;
      }
      const parsed = readJsonFileSafe(filePath);
      if (!parsed) continue;
      byId.set(tid, {
        ...parsed,
        terminalId: parsed.terminalId || tid,
        source,
      });
    }
  };

  readDirInto(getLegacySessionsDir(legacyHome), 'legacy', true);
  readDirInto(getSessionsDir(globalDir), 'cortex', true);

  return [...byId.values()].sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  );
}

/**
 * Atomically record HC_TERMINAL_ID -> { terminalId, agent, sessionId, previousSessionId, history, cwd, updatedAt }.
 * Skips recording when caller is a subagent.
 * Preserves previousSessionId and capped history (last 5 IDs) when sessionId changes.
 */
export function recordSession({
  terminalId = process.env.HC_TERMINAL_ID,
  agent,
  payload = {},
  sessionId: explicitSessionId,
  cwd: explicitCwd,
  globalDir,
  legacyHome,
  now = new Date(),
} = {}) {
  if (isSubagentPayload(payload)) {
    return { recorded: false, reason: 'subagent' };
  }

  const cleanTerminalId = typeof terminalId === 'string' ? terminalId.trim() : '';
  if (!isValidTerminalId(cleanTerminalId)) {
    return { recorded: false, reason: 'invalid_terminal_id' };
  }

  const rawSessionId = typeof explicitSessionId === 'string' && explicitSessionId.trim()
    ? explicitSessionId.trim()
    : (
        typeof (payload.conversationId || payload.conversation_id || payload.session_id || payload.sessionId) === 'string'
          ? String(payload.conversationId || payload.conversation_id || payload.session_id || payload.sessionId).trim()
          : ''
      );

  if (!rawSessionId) {
    return { recorded: false, reason: 'missing_session_id' };
  }
  if (!isValidSessionId(rawSessionId)) {
    return { recorded: false, reason: 'invalid_session_id' };
  }
  const sessionId = rawSessionId;

  const normalizedAgent = String(agent || '').trim().toLowerCase() === 'antigravity'
    ? 'antigravity'
    : 'claude';
  const cwd = typeof explicitCwd === 'string' && explicitCwd.trim()
    ? explicitCwd.trim()
    : extractCwd(payload);

  const sessionsDir = getSessionsDir(globalDir);
  const targetFile = assertInsideDir(sessionsDir, `${cleanTerminalId}.json`);
  const existing = readJsonFileSafe(targetFile) || readSavedSession(cleanTerminalId, { globalDir, legacyHome });

  // Fast no-op when already persisted identically in primary store
  if (
    existing
    && fs.existsSync(targetFile)
    && existing.agent === normalizedAgent
    && existing.sessionId === sessionId
    && existing.cwd === cwd
  ) {
    return { recorded: false, reason: 'unchanged', record: existing };
  }

  let previousSessionId = existing?.previousSessionId || null;
  let history = Array.isArray(existing?.history)
    ? existing.history.filter((x) => typeof x === 'string' && x.trim() !== '')
    : [];

  if (existing?.sessionId && existing.sessionId !== sessionId) {
    previousSessionId = existing.sessionId;
    history = [
      existing.sessionId,
      ...history.filter((id) => id !== existing.sessionId && id !== sessionId),
    ].slice(0, MAX_SESSION_HISTORY);
  } else {
    history = history.filter((id) => id !== sessionId).slice(0, MAX_SESSION_HISTORY);
  }

  const record = {
    terminalId: cleanTerminalId,
    agent: normalizedAgent,
    sessionId,
    previousSessionId,
    history,
    cwd,
    updatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };

  atomicWriteJson(targetFile, record);
  return { recorded: true, reason: 'saved', filePath: targetFile, record };
}
