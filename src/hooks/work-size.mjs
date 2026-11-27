import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  assertInsideDir,
  atomicWriteJson,
  formatIsoTimestamp,
  getTierPaths,
  projectPathKey,
  resolveProjectRoot,
  resolveWorkSizeConfig,
} from '../core/config.mjs';
import { sanitizeInline } from '../core/budget.mjs';
import {
  isValidSessionId,
  isValidTerminalId,
  resolveCortexGlobalDir,
  validateTerminalId,
} from '../revive/tracker.mjs';

/**
 * Host-independent work-size (S / L) state management, stable project-root resolution,
 * per-folder edit counting, threshold blocking, lock-protected updates, cumulative window
 * clearing (`git commit` / `memory_save`), reviewer verdict extraction, L completion tracking
 * (`ACCEPT` + `memory_save`), stale cleanup, and context notices.
 *
 * Host hooks (Claude Code `claude.mjs`, and later Antigravity `antigravity.mjs`) adapt their
 * tool input shapes and host root hints (`projectDirEnvVar` or `workspacePaths`) and call into
 * this module.
 */

export const WORK_SIZE_DIR_NAME = 'work-size';
export const WORK_SIZE_COMMAND = 'cortex-work';
export const WORK_SIZE_STATE_VERSION = 2;
export const WORK_SIZE_DENY_MAX_CHARS = 500;
export const WORK_SIZE_SESSION_NOTICE_MAX_CHARS = 300;
export const WORK_SIZE_SESSION_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const WORK_SIZE_LOCK_STALE_MS = 5000;
export const WORK_SIZE_LOCK_RETRY_MS = 15;
export const WORK_SIZE_LOCK_MAX_RETRIES = 20;

const LOCK_UNREADABLE_GRACE_MS = 1000;
const LOCK_RECOVERY_STALE_MS = 5000;

export const WORK_SIZE_COMPLETED_NOTICE =
  '[herdr-cortex] L 작업의 완료 조건(독립 검수 ACCEPT·memory_save)이 모두 충족되어 작업 규모가 S로 돌아왔습니다.';

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toEpochMs(now) {
  if (now instanceof Date) {
    const ms = now.getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  const num = Number(typeof now === 'function' ? now() : now);
  return Number.isFinite(num) && num > 0 ? num : Date.now();
}

function toDate(now) {
  return now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date(toEpochMs(now));
}

function getEnvValue(env, varName) {
  if (!env || typeof env !== 'object' || typeof varName !== 'string' || !varName.trim()) return '';
  const wanted = varName.trim();
  if (process.platform !== 'win32') {
    return typeof env[wanted] === 'string' ? env[wanted] : '';
  }
  const lower = wanted.toLowerCase();
  for (const [key, val] of Object.entries(env)) {
    if (key.toLowerCase() === lower && typeof val === 'string') return val;
  }
  return '';
}

function isExistingAbsoluteDirectory(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) return false;
  const trimmed = candidate.trim();
  if (!path.isAbsolute(trimmed)) return false;
  try {
    return fs.statSync(trimmed).isDirectory();
  } catch {
    return false;
  }
}

// Windows ignores trailing dots and spaces in a file name, so ".memory." and ".memory " name the same folder.
function isMemoryDirSegment(segment) {
  return segment.replace(/[. ]+$/, '').toLowerCase() === '.memory';
}

function hasMemoryDirSegment(filePath) {
  return String(filePath).split(/[\\/]+/).some((segment) => isMemoryDirSegment(segment));
}

/**
 * True when `targetPath` (relative paths are resolved against `cwd`) lies in or under a folder named
 * `.memory` (case-insensitive), in any project. Checked on the path as written and on its real path.
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

function resolveRealPathLenient(targetPath) {
  const resolved = path.resolve(String(targetPath));
  const tailSegments = [];
  let cursor = resolved;
  while (true) {
    try {
      const realCursor = fs.realpathSync.native(cursor);
      return tailSegments.length > 0 ? path.join(realCursor, ...tailSegments.reverse()) : realCursor;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const parent = path.dirname(cursor);
        if (parent === cursor) return resolved;
        tailSegments.push(path.basename(cursor));
        cursor = parent;
        continue;
      }
      return resolved;
    }
  }
}

function normalizeWinSegments(filePath) {
  return filePath
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[. ]+$/, '') || segment)
    .join(path.sep);
}

function comparableDirPath(dirPath) {
  const real = resolveRealPathLenient(dirPath);
  const norm = process.platform === 'win32'
    ? normalizeWinSegments(real).toLowerCase()
    : real;
  const root = path.parse(norm).root;
  return norm.length > root.length ? norm.replace(/[\\/]+$/, '') : norm;
}

/**
 * True when `childDir` equals `parentDir` or lies inside `parentDir` (compared by real path).
 */
export function isSameOrSubpath(childDir, parentDir) {
  if (typeof childDir !== 'string' || !childDir.trim() || childDir.includes('\0')) return false;
  if (typeof parentDir !== 'string' || !parentDir.trim() || parentDir.includes('\0')) return false;
  const childCmp = comparableDirPath(childDir.trim());
  const parentCmp = comparableDirPath(parentDir.trim());
  if (childCmp === parentCmp) return true;
  const prefix = parentCmp.endsWith(path.sep) ? parentCmp : `${parentCmp}${path.sep}`;
  return childCmp.startsWith(prefix);
}

function normalizeTrackedFileKey(relPosixPath) {
  if (process.platform !== 'win32') return relPosixPath;
  return relPosixPath
    .split('/')
    .map((segment) => (segment.replace(/[. ]+$/, '') || segment).toLowerCase())
    .join('/');
}

/**
 * Resolve the stable project root directory for work-size operations:
 *   1. Host-supplied project directory (`env[projectDirEnvVar]` when `projectDirEnvVar` is given by the
 *      host adapter, or `workspacePaths`) if it is an existing directory on disk;
 *   2. A folder already recorded in this tab/session's work-size state that contains `cwd` (equal or
 *      ancestor; deepest ancestor wins when multiple match);
 *   3. `cwd` from the hook/CLI input.
 */
export function resolveWorkSizeProjectRoot({
  cwd = process.cwd(),
  env,
  projectDirEnvVar = '',
  workspacePaths,
  scopeState = undefined,
  globalDir,
  scope = null,
} = {}) {
  const safeCwd = typeof cwd === 'string' && cwd.trim() && !cwd.includes('\0')
    ? cwd.trim()
    : process.cwd();
  const baseCwd = resolveProjectRoot(path.resolve(safeCwd));

  if (projectDirEnvVar) {
    const envDir = getEnvValue(env, projectDirEnvVar).trim();
    if (isExistingAbsoluteDirectory(envDir)) {
      return resolveProjectRoot(path.resolve(envDir));
    }
  }

  if (Array.isArray(workspacePaths) && workspacePaths.length > 0) {
    const validWorkspaces = workspacePaths
      .filter((item) => isExistingAbsoluteDirectory(item))
      .map((item) => resolveProjectRoot(path.resolve(item.trim())));
    if (validWorkspaces.length > 0) {
      let bestMatch = null;
      let bestLen = -1;
      for (const ws of validWorkspaces) {
        if (isSameOrSubpath(baseCwd, ws)) {
          const cmpLen = comparableDirPath(ws).length;
          if (cmpLen > bestLen) {
            bestLen = cmpLen;
            bestMatch = ws;
          }
        }
      }
      return bestMatch || validWorkspaces[0];
    }
  }

  const effectiveScopeState = scopeState !== undefined
    ? scopeState
    : (scope ? readWorkSizeScopeState(globalDir, scope) : null);

  if (effectiveScopeState && isPlainObject(effectiveScopeState.projects)) {
    let bestRoot = null;
    let bestLen = -1;
    for (const entry of Object.values(effectiveScopeState.projects)) {
      if (!entry || typeof entry.cwd !== 'string' || !entry.cwd.trim()) continue;
      const candidateRoot = resolveProjectRoot(entry.cwd);
      if (isSameOrSubpath(baseCwd, candidateRoot)) {
        const cmpLen = comparableDirPath(candidateRoot).length;
        if (cmpLen > bestLen) {
          bestLen = cmpLen;
          bestRoot = candidateRoot;
        }
      }
    }
    if (bestRoot) return bestRoot;
  }

  return baseCwd;
}

/**
 * Resolve `targetPath` against `cwd` and verify it points to a file strictly inside `projectRoot`
 * (defaults to `resolveProjectRoot(cwd)`) and NOT inside `.memory/`.
 * Returns `{ projectRoot, realRoot, relPath }` or `null`.
 */
export function resolveTrackedProjectFile(targetPath, cwd = process.cwd(), { projectRoot } = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  if (targetPath.includes('\0') || cwd.includes('\0')) return null;
  if (typeof projectRoot === 'string' && projectRoot.includes('\0')) return null;

  const baseCwd = path.resolve(cwd.trim());
  const effectiveProjectRoot = typeof projectRoot === 'string' && projectRoot.trim()
    ? resolveProjectRoot(path.resolve(projectRoot.trim()))
    : resolveProjectRoot(baseCwd);
  const resolvedTarget = path.resolve(baseCwd, targetPath.trim());

  if (isPathInsideMemoryDir(resolvedTarget, baseCwd)) return null;

  const realRoot = resolveRealPathLenient(effectiveProjectRoot);
  const realTarget = resolveRealPathLenient(resolvedTarget);

  const rootCmp = process.platform === 'win32'
    ? normalizeWinSegments(realRoot).toLowerCase()
    : realRoot;
  const targetCmp = process.platform === 'win32'
    ? normalizeWinSegments(realTarget).toLowerCase()
    : realTarget;

  if (targetCmp === rootCmp) return null;
  const rootPrefix = rootCmp.endsWith(path.sep) ? rootCmp : `${rootCmp}${path.sep}`;
  if (!targetCmp.startsWith(rootPrefix)) return null;

  const rawRel = path.relative(realRoot, realTarget).replace(/\\/g, '/');
  const normalizedRel = path.posix.normalize(rawRel);
  if (
    !normalizedRel
    || normalizedRel === '.'
    || normalizedRel === '..'
    || normalizedRel.startsWith('../')
    || normalizedRel.startsWith('/')
  ) {
    return null;
  }

  if (hasMemoryDirSegment(normalizedRel)) return null;
  return { projectRoot: effectiveProjectRoot, realRoot, relPath: normalizedRel };
}

export function getWorkSizeDir(globalDir) {
  return path.join(getTierPaths(resolveCortexGlobalDir(globalDir)).stateDir, WORK_SIZE_DIR_NAME);
}

/**
 * Identify the persistence scope: `HC_TERMINAL_ID` (`tab-<id>.json`) when valid, otherwise `sessionId`
 * (`session-<id>.json`) for sessions outside Herdr. Returns `null` when neither is usable.
 */
export function resolveWorkSizeScope({ terminalId, sessionId } = {}) {
  if (isValidTerminalId(terminalId)) {
    const id = terminalId.trim();
    return { kind: 'tab', id, fileName: `tab-${id}.json` };
  }
  if (isValidSessionId(sessionId)) {
    const id = sessionId.trim();
    return { kind: 'session', id, fileName: `session-${id}.json` };
  }
  return null;
}

export function tabWorkSizeScope(terminalId) {
  const id = validateTerminalId(terminalId);
  return { kind: 'tab', id, fileName: `tab-${id}.json` };
}

export function getWorkSizeStatePath(globalDir, scope) {
  if (!scope || typeof scope.fileName !== 'string') return '';
  return assertInsideDir(getWorkSizeDir(globalDir), scope.fileName);
}

// ---------------------------------------------------------------------------------------------
// Exclusive lock file for read-modify-write state updates (fail-open if lock cannot be acquired)
// ---------------------------------------------------------------------------------------------

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function removeQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'ENOENT');
  }
}

function createExclusive(filePath, info) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return 'exists';
    if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) return 'unavailable';
    return 'error';
  }
  try {
    fs.writeSync(fd, JSON.stringify(info));
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    removeQuietly(filePath);
    return 'error';
  }
  try {
    fs.closeSync(fd);
  } catch {
    // ignore
  }
  return 'created';
}

function readLockInfo(lockPath) {
  let stat;
  let text;
  try {
    stat = fs.statSync(lockPath);
    if (stat.isDirectory()) return { exists: true, isDirectory: true };
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false };
    return {
      exists: true,
      readable: false,
      mtimeMs: stat ? stat.mtimeMs : Date.now(),
      identity: 'unreadable',
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const pid = Number(parsed?.pid);
  const acquiredAt = Number(parsed?.acquiredAt);
  const token = typeof parsed?.token === 'string' ? parsed.token : '';
  const readable = Number.isInteger(pid) && pid > 0 && Number.isFinite(acquiredAt);
  return {
    exists: true,
    readable,
    pid,
    acquiredAt,
    token,
    mtimeMs: stat.mtimeMs,
    identity: readable ? `${pid}:${acquiredAt}:${token}` : `unreadable:${stat.mtimeMs}:${text.length}`,
  };
}

function isLockStale(info, { staleMs, isPidAlive, nowMs }) {
  if (info.isDirectory) return false;
  if (!info.readable) return nowMs - info.mtimeMs > LOCK_UNREADABLE_GRACE_MS;
  if (!isPidAlive(info.pid)) return true;
  return nowMs - info.acquiredAt > staleMs;
}

function tryAcquireScopeLockOnce(lockPath, { staleMs, isPidAlive, nowMs }) {
  const mine = { pid: process.pid, acquiredAt: nowMs, token: crypto.randomBytes(8).toString('hex') };
  let released = false;
  const handle = {
    release() {
      if (released) return;
      released = true;
      const current = readLockInfo(lockPath);
      if (current.exists && !current.isDirectory && current.token === mine.token) {
        removeQuietly(lockPath);
      }
    },
  };

  const first = createExclusive(lockPath, mine);
  if (first === 'created') return { status: 'acquired', handle };
  if (first === 'error') return { status: 'fatal' };
  if (first === 'unavailable') {
    try {
      const st = fs.statSync(lockPath);
      if (st.isDirectory()) return { status: 'fatal' };
      return { status: 'transient' };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { status: 'unwritable' };
      return { status: 'transient' };
    }
  }

  const seen = readLockInfo(lockPath);
  if (!seen.exists) {
    return createExclusive(lockPath, mine) === 'created'
      ? { status: 'acquired', handle }
      : { status: 'busy' };
  }
  if (seen.isDirectory) return { status: 'fatal' };
  if (!isLockStale(seen, { staleMs, isPidAlive, nowMs })) return { status: 'busy' };

  const recoverPath = `${lockPath}.recover`;
  const recoverInfo = { pid: process.pid, acquiredAt: nowMs, token: mine.token };
  let recovery = createExclusive(recoverPath, recoverInfo);
  if (recovery === 'exists') {
    const leftover = readLockInfo(recoverPath);
    const abandoned = leftover.exists
      && !leftover.isDirectory
      && nowMs - leftover.mtimeMs > LOCK_RECOVERY_STALE_MS
      && !(leftover.readable && isPidAlive(leftover.pid) && nowMs - leftover.acquiredAt <= staleMs);
    if (!abandoned || !removeQuietly(recoverPath)) return { status: 'busy' };
    recovery = createExclusive(recoverPath, recoverInfo);
  }
  if (recovery !== 'created') return { status: 'busy' };

  try {
    const again = readLockInfo(lockPath);
    if (again.exists) {
      if (again.isDirectory || again.identity !== seen.identity || !isLockStale(again, { staleMs, isPidAlive, nowMs })) {
        return { status: 'busy' };
      }
      if (!removeQuietly(lockPath)) return { status: 'busy' };
    }
    return createExclusive(lockPath, mine) === 'created'
      ? { status: 'acquired', handle }
      : { status: 'busy' };
  } finally {
    removeQuietly(recoverPath);
  }
}

/**
 * Execute `fn()` under an exclusive lock for `<scope.fileName>`. Retries briefly on contention and
 * replaces stale locks; if the lock still cannot be obtained, returns `{ locked: false }` without
 * blocking indefinitely (fail-open).
 */
export function withWorkSizeScopeLock(
  globalDir,
  scope,
  fn,
  {
    staleMs = WORK_SIZE_LOCK_STALE_MS,
    retryMs = WORK_SIZE_LOCK_RETRY_MS,
    maxRetries = WORK_SIZE_LOCK_MAX_RETRIES,
    isPidAlive = defaultIsPidAlive,
    sleep = sleepSync,
  } = {},
) {
  let statePath;
  try {
    statePath = getWorkSizeStatePath(globalDir, scope);
  } catch {
    return { locked: false };
  }
  if (!statePath) return { locked: false };

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  } catch {
    return { locked: false };
  }

  const lockPath = `${statePath}.lock`;
  let unwritableCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = tryAcquireScopeLockOnce(lockPath, {
      staleMs,
      isPidAlive,
      nowMs: Date.now(),
    });
    if (res.status === 'acquired') {
      try {
        return { locked: true, value: fn() };
      } finally {
        res.handle.release();
      }
    }
    if (res.status === 'fatal') return { locked: false };
    if (res.status === 'unwritable') {
      unwritableCount++;
      if (unwritableCount >= 2) return { locked: false };
    }
    if (attempt < maxRetries) {
      sleep(retryMs);
    }
  }

  return { locked: false };
}

// ---------------------------------------------------------------------------------------------
// Per-folder state persistence & stale cleanup
// ---------------------------------------------------------------------------------------------

function readJsonWithRetry(filePath) {
  const maxRetries = 6;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : null;
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

function parseStoredFiles(rawFiles) {
  if (!isPlainObject(rawFiles)) return null;
  const clean = {};
  for (const [key, val] of Object.entries(rawFiles)) {
    if (typeof key !== 'string' || !key.trim()) return null;
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return null;
    clean[key.trim()] = Math.floor(val);
  }
  return clean;
}

function parseFolderEntry(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.size !== 'S' && raw.size !== 'L') return null;
  if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) return null;
  if (typeof raw.cwdKey !== 'string' || !raw.cwdKey.trim()) return null;

  const files = parseStoredFiles(raw.files);
  if (!files) return null;

  const isL = raw.size === 'L';
  return {
    cwd: raw.cwd.trim(),
    cwdKey: raw.cwdKey.trim(),
    size: raw.size,
    escalatedAt: isL && typeof raw.escalatedAt === 'string' && raw.escalatedAt.trim()
      ? raw.escalatedAt.trim()
      : null,
    escalationReason: isL && isPlainObject(raw.escalationReason) ? raw.escalationReason : null,
    files,
    reviewAccepted: isL ? Boolean(raw.reviewAccepted) : false,
    reviewAcceptedAt: isL && typeof raw.reviewAcceptedAt === 'string' && raw.reviewAcceptedAt.trim()
      ? raw.reviewAcceptedAt.trim()
      : null,
    memorySaved: isL ? Boolean(raw.memorySaved) : false,
    memorySavedAt: isL && typeof raw.memorySavedAt === 'string' && raw.memorySavedAt.trim()
      ? raw.memorySavedAt.trim()
      : null,
    completedNoticePending: Boolean(raw.completedNoticePending),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

function isCleanEmptyFolderEntry(entry) {
  return Boolean(entry)
    && entry.size === 'S'
    && Object.keys(entry.files || {}).length === 0
    && !entry.completedNoticePending;
}

/**
 * Read and validate a persisted scope state file (`tab-<id>.json` or `session-<id>.json`).
 * Supports `version: 2` (`projects` map) and migrates valid `version: 1` single-folder files into
 * the `version: 2` shape on read. Missing or malformed files return `null`.
 */
export function readWorkSizeScopeState(globalDir, scope) {
  if (!scope) return null;
  let filePath;
  try {
    filePath = getWorkSizeStatePath(globalDir, scope);
  } catch {
    return null;
  }
  const parsed = readJsonWithRetry(filePath);
  if (!parsed) return null;

  const scopeKind = parsed.scopeKind === 'session' ? 'session' : (scope.kind === 'session' ? 'session' : 'tab');
  const scopeId = typeof parsed.scopeId === 'string' && parsed.scopeId.trim() ? parsed.scopeId.trim() : scope.id;
  const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '';

  if (parsed.version === 1) {
    const single = parseFolderEntry(parsed);
    if (!single) return null;
    return {
      version: WORK_SIZE_STATE_VERSION,
      scopeKind,
      scopeId,
      updatedAt,
      projects: {
        [single.cwdKey]: single,
      },
    };
  }

  if (parsed.version !== WORK_SIZE_STATE_VERSION || !isPlainObject(parsed.projects)) {
    return null;
  }

  const projects = {};
  for (const rawEntry of Object.values(parsed.projects)) {
    const entry = parseFolderEntry(rawEntry);
    if (!entry) return null;
    projects[entry.cwdKey] = entry;
  }

  return {
    version: WORK_SIZE_STATE_VERSION,
    scopeKind,
    scopeId,
    updatedAt,
    projects,
  };
}

/**
 * Read the work-size state of a specific project folder (resolved from `cwd` / host root hints)
 * within `scope`, or `null` when that folder has no recorded state.
 */
export function readWorkSizeState(
  globalDir,
  scope,
  {
    cwd = process.cwd(),
    env,
    projectDirEnvVar = '',
    workspacePaths,
  } = {},
) {
  const scopeState = readWorkSizeScopeState(globalDir, scope);
  if (!scopeState) return null;
  const projectRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState,
  });
  const entry = scopeState.projects[projectPathKey(projectRoot)];
  if (!entry) return null;
  return {
    version: WORK_SIZE_STATE_VERSION,
    scopeKind: scopeState.scopeKind,
    scopeId: scopeState.scopeId,
    ...entry,
  };
}

/**
 * Delete `session-*.json` files untouched for more than 30 days (`WORK_SIZE_SESSION_STALE_MS`).
 * Best effort; all errors are ignored.
 */
export function pruneStaleWorkSizeSessions(
  globalDir,
  nowMs = Date.now(),
  { keepFileName = '' } = {},
) {
  let removed = 0;
  try {
    const dir = getWorkSizeDir(globalDir);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.startsWith('session-') || !ent.name.endsWith('.json')) continue;
      if (ent.name === keepFileName) continue;
      try {
        const filePath = assertInsideDir(dir, ent.name);
        const stat = fs.statSync(filePath);
        if (nowMs - stat.mtimeMs > WORK_SIZE_SESSION_STALE_MS) {
          if (removeQuietly(filePath)) removed++;
          removeQuietly(`${filePath}.lock`);
          removeQuietly(`${filePath}.lock.recover`);
        }
      } catch {
        // ignore per-file errors
      }
    }
  } catch {
    // ignore directory read errors
  }
  return removed;
}

/**
 * Persist `scopeState` after pruning clean empty `S` folder entries (no files in window and no
 * pending notice) and pruning stale `session-*.json` files older than 30 days.
 */
export function writeWorkSizeScopeState(globalDir, scope, scopeState, { now = new Date() } = {}) {
  const filePath = getWorkSizeStatePath(globalDir, scope);
  const nowDate = toDate(now);
  const nowMs = nowDate.getTime();

  const cleanProjects = {};
  if (scopeState && isPlainObject(scopeState.projects)) {
    for (const [key, entry] of Object.entries(scopeState.projects)) {
      if (!entry || isCleanEmptyFolderEntry(entry)) continue;
      const cleanKey = typeof entry.cwdKey === 'string' && entry.cwdKey.trim() ? entry.cwdKey.trim() : key;
      cleanProjects[cleanKey] = entry;
    }
  }

  const hasEntries = Object.keys(cleanProjects).length > 0;
  if (!hasEntries) {
    removeQuietly(filePath);
  } else {
    atomicWriteJson(filePath, {
      version: WORK_SIZE_STATE_VERSION,
      scopeKind: scope.kind,
      scopeId: scope.id,
      updatedAt: (scopeState && typeof scopeState.updatedAt === 'string' && scopeState.updatedAt)
        ? scopeState.updatedAt
        : formatIsoTimestamp(nowDate),
      projects: cleanProjects,
    });
  }

  pruneStaleWorkSizeSessions(globalDir, nowMs, {
    keepFileName: hasEntries ? scope.fileName : '',
  });
  return filePath;
}

/**
 * Write or update one folder's entry inside `scope`'s state file (retaining other folders' entries).
 */
export function writeWorkSizeState(globalDir, scope, folderState, { now = new Date() } = {}) {
  const existing = readWorkSizeScopeState(globalDir, scope);
  const projects = existing ? { ...existing.projects } : {};
  if (folderState && typeof folderState.cwdKey === 'string' && folderState.cwdKey.trim()) {
    const { version: _v, scopeKind: _sk, scopeId: _sid, ...entry } = folderState;
    projects[entry.cwdKey.trim()] = entry;
  }
  return writeWorkSizeScopeState(
    globalDir,
    scope,
    {
      version: WORK_SIZE_STATE_VERSION,
      scopeKind: scope.kind,
      scopeId: scope.id,
      updatedAt: folderState?.updatedAt || formatIsoTimestamp(toDate(now)),
      projects,
    },
    { now },
  );
}

function createFreshFolderState(projectRoot, cwdKey) {
  return {
    cwd: projectRoot,
    cwdKey,
    size: 'S',
    escalatedAt: null,
    escalationReason: null,
    files: {},
    reviewAccepted: false,
    reviewAcceptedAt: null,
    memorySaved: false,
    memorySavedAt: null,
    completedNoticePending: false,
    updatedAt: '',
  };
}

function clipText(value, maxChars) {
  const clean = sanitizeInline(value);
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 3) return clean.slice(0, Math.max(0, maxChars));
  return `${clean.slice(0, maxChars - 3)}...`;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function buildViolation({
  file,
  addedChars,
  previousChars,
  projectedChars,
  maxCharsPerFile,
  projectedFileCount,
  maxFilesPerWindow,
  exceedsFiles,
  exceedsChars,
}) {
  const shortFile = clipText(file, 72);
  let rule = 'max_chars_per_file';
  let summary = '';
  if (exceedsFiles && exceedsChars) {
    rule = 'max_files_and_chars';
    summary = `수정 파일 ${projectedFileCount}개 > 한도 ${maxFilesPerWindow}개 및 ${shortFile} 누적 ${formatNumber(projectedChars)}자 > 한도 ${formatNumber(maxCharsPerFile)}자`;
  } else if (exceedsFiles) {
    rule = 'max_files';
    summary = `수정 파일 ${projectedFileCount}개 > 한도 ${maxFilesPerWindow}개 (${shortFile}, 이번 ${formatNumber(addedChars)}자)`;
  } else {
    rule = 'max_chars_per_file';
    summary = `${shortFile} 누적 ${formatNumber(projectedChars)}자 > 한도 ${formatNumber(maxCharsPerFile)}자 (기존 ${formatNumber(previousChars)}자 + 이번 ${formatNumber(addedChars)}자)`;
  }
  return {
    rule,
    file,
    addedChars,
    previousChars,
    projectedChars,
    maxCharsPerFile,
    projectedFileCount,
    maxFilesPerWindow,
    exceedsFiles,
    exceedsChars,
    summary,
  };
}

/**
 * Build the Korean PreToolUse deny reason read by the HEAD model (`[herdr-cortex]` prefix, <= 500 chars).
 * Deliberately does NOT mention `git commit` window clearing.
 */
export function formatWorkSizeDenyReason(violation) {
  const detail = clipText(violation?.summary || '작업 규모 한도 초과', 160);
  const text =
    `[herdr-cortex] 편집 한도 초과(${detail}). `
    + '이 작업은 L이므로 HEAD는 직접 고치지 않고 워커에게 맡긴다. '
    + '`cortex_prompt(kind: "skill", name: "start-job")`를 읽고 따라라. '
    + `잘못 걸렸다고 보면 사용자에게 알려라(사용자가 \`${WORK_SIZE_COMMAND}\`로 풀 수 있다). `
    + '스스로 상태 파일을 고치거나 다른 도구로 돌아가지 않는다.';
  return text.length <= WORK_SIZE_DENY_MAX_CHARS
    ? text
    : `${text.slice(0, WORK_SIZE_DENY_MAX_CHARS - 3)}...`;
}

/**
 * Build the SessionStart (`context`) reminder for an unfinished L job in the same project folder (<= 300 chars).
 */
export function formatWorkSizeSessionNotice(state) {
  if (!state || state.size !== 'L') return '';
  const timeText = clipText(state.escalatedAt || '알 수 없음', 32);
  const reasonText = clipText(state.escalationReason?.summary || '편집 한도 초과', 80);
  const remaining = [];
  if (!state.reviewAccepted) remaining.push('검수 ACCEPT');
  if (!state.memorySaved) remaining.push('memory_save');
  const remainingText = remaining.length > 0 ? remaining.join(', ') : '없음';

  const text =
    `[herdr-cortex] 진행 중인 L 작업(시각: ${timeText}, 이유: ${reasonText}). `
    + `남은 조건: ${remainingText}. `
    + 'HEAD는 직접 고치지 말고 `cortex_prompt(kind: "skill", name: "start-job")`를 읽고 따라라.';
  return text.length <= WORK_SIZE_SESSION_NOTICE_MAX_CHARS
    ? text
    : `${text.slice(0, WORK_SIZE_SESSION_NOTICE_MAX_CHARS - 3)}...`;
}

function findMatchingFileKey(files, relPath) {
  const targetKey = normalizeTrackedFileKey(relPath);
  for (const existingKey of Object.keys(files)) {
    if (normalizeTrackedFileKey(existingKey) === targetKey) return existingKey;
  }
  return null;
}

function evaluateConfigForRoot(rootDir, { preRoot, preConfig, loadConfigForRoot, isEnabledForRoot, fallbackConfig }) {
  const cfg = preConfig && preRoot && projectPathKey(rootDir) === projectPathKey(preRoot)
    ? preConfig
    : (typeof loadConfigForRoot === 'function' ? loadConfigForRoot(rootDir) : fallbackConfig);
  if (typeof isEnabledForRoot === 'function' && !isEnabledForRoot(rootDir, cfg)) {
    return { enabled: false, workSize: null };
  }
  const workSize = resolveWorkSizeConfig(cfg);
  return { enabled: workSize.enabled, workSize };
}

/**
 * Evaluate one file-edit tool call against the tab/session work-size window and update state on disk
 * under an exclusive lock. Returns `{ action: 'pass' | 'allow' | 'deny', denyReason?, violation?, state? }`.
 */
export function evaluateWorkSizeEdit({
  filePath,
  addedChars = 0,
  cwd = process.cwd(),
  env,
  projectDirEnvVar = '',
  workspacePaths,
  globalDir,
  terminalId,
  sessionId,
  config = DEFAULT_CONFIG,
  loadConfigForRoot,
  isEnabledForRoot,
  lockOptions,
  now = new Date(),
} = {}) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return { action: 'pass', reason: 'invalid_path' };
  }
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) {
    return { action: 'pass', reason: 'invalid_cwd' };
  }
  if (isPathInsideMemoryDir(filePath, cwd)) {
    return { action: 'pass', reason: 'outside_or_memory' };
  }

  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return { action: 'pass', reason: 'no_scope' };

  // Pre-check before touching disk or creating lock/state directories: disabled/excluded projects and
  // outside-project paths return immediately without creating any state directory or lock file.
  const preScopeState = readWorkSizeScopeState(globalDir, scope);
  const preRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState: preScopeState,
  });
  const preCfg = typeof loadConfigForRoot === 'function' ? loadConfigForRoot(preRoot) : config;
  const preEval = evaluateConfigForRoot(preRoot, {
    preRoot,
    preConfig: preCfg,
    loadConfigForRoot,
    isEnabledForRoot,
    fallbackConfig: config,
  });
  if (!preEval.enabled) return { action: 'pass', reason: 'disabled' };

  const preTracked = resolveTrackedProjectFile(filePath, cwd, { projectRoot: preRoot });
  if (!preTracked) return { action: 'pass', reason: 'outside_or_memory' };

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      const projectRoot = resolveWorkSizeProjectRoot({
        cwd,
        env,
        projectDirEnvVar,
        workspacePaths,
        scopeState: existingScope,
      });
      const sameAsPre = projectPathKey(projectRoot) === projectPathKey(preRoot);
      const evalCfg = sameAsPre
        ? preEval
        : evaluateConfigForRoot(projectRoot, {
            preRoot,
            preConfig: preCfg,
            loadConfigForRoot,
            isEnabledForRoot,
            fallbackConfig: config,
          });
      if (!evalCfg.enabled) return { action: 'pass', reason: 'disabled' };

      const tracked = sameAsPre
        ? preTracked
        : resolveTrackedProjectFile(filePath, cwd, { projectRoot });
      if (!tracked) return { action: 'pass', reason: 'outside_or_memory' };

      const workSize = evalCfg.workSize;
      const cwdKey = projectPathKey(tracked.projectRoot);
      const existingProjects = existingScope ? existingScope.projects : {};
      const state = existingProjects[cwdKey] || createFreshFolderState(tracked.projectRoot, cwdKey);

      const safeAdded = typeof addedChars === 'number' && Number.isFinite(addedChars) && addedChars > 0
        ? Math.floor(addedChars)
        : 0;
      const matchedKey = findMatchingFileKey(state.files, tracked.relPath);
      const fileKey = matchedKey || tracked.relPath;
      const previousChars = matchedKey ? state.files[matchedKey] : 0;
      const currentFileCount = Object.keys(state.files).length;
      const projectedFileCount = matchedKey ? currentFileCount : currentFileCount + 1;
      const projectedChars = previousChars + safeAdded;

      const exceedsFiles = projectedFileCount > workSize.maxFilesPerWindow;
      const exceedsChars = projectedChars > workSize.maxCharsPerFile;
      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);

      if (!exceedsFiles && !exceedsChars) {
        const nextFolder = {
          ...state,
          files: {
            ...state.files,
            [fileKey]: projectedChars,
          },
          updatedAt: stamp,
        };
        writeWorkSizeScopeState(
          globalDir,
          scope,
          {
            version: WORK_SIZE_STATE_VERSION,
            scopeKind: scope.kind,
            scopeId: scope.id,
            updatedAt: stamp,
            projects: { ...existingProjects, [cwdKey]: nextFolder },
          },
          { now: nowDate },
        );
        return {
          action: 'allow',
          state: { version: WORK_SIZE_STATE_VERSION, scopeKind: scope.kind, scopeId: scope.id, ...nextFolder },
        };
      }

      const violation = buildViolation({
        file: fileKey,
        addedChars: safeAdded,
        previousChars,
        projectedChars,
        maxCharsPerFile: workSize.maxCharsPerFile,
        projectedFileCount,
        maxFilesPerWindow: workSize.maxFilesPerWindow,
        exceedsFiles,
        exceedsChars,
      });

      let nextFolder = state;
      if (state.size === 'S') {
        nextFolder = {
          ...state,
          size: 'L',
          escalatedAt: stamp,
          escalationReason: violation,
          reviewAccepted: false,
          reviewAcceptedAt: null,
          memorySaved: false,
          memorySavedAt: null,
          completedNoticePending: false,
          updatedAt: stamp,
        };
        writeWorkSizeScopeState(
          globalDir,
          scope,
          {
            version: WORK_SIZE_STATE_VERSION,
            scopeKind: scope.kind,
            scopeId: scope.id,
            updatedAt: stamp,
            projects: { ...existingProjects, [cwdKey]: nextFolder },
          },
          { now: nowDate },
        );
      }

      return {
        action: 'deny',
        denyReason: formatWorkSizeDenyReason(violation),
        violation,
        state: { version: WORK_SIZE_STATE_VERSION, scopeKind: scope.kind, scopeId: scope.id, ...nextFolder },
      };
    },
    lockOptions,
  );

  if (!lockedResult.locked) {
    return { action: 'pass', reason: 'lock_unavailable' };
  }
  return lockedResult.value;
}

function transitionToCompletedS(state, nowDate) {
  const stamp = formatIsoTimestamp(nowDate);
  return {
    ...state,
    size: 'S',
    escalatedAt: null,
    escalationReason: null,
    files: {},
    reviewAccepted: false,
    reviewAcceptedAt: null,
    memorySaved: false,
    memorySavedAt: null,
    completedNoticePending: true,
    updatedAt: stamp,
  };
}

/**
 * Clear cumulative per-file edit counts after a successful `git commit` inside the project root.
 * Keeps `size: 'L'` intact when the folder is in L.
 */
export function recordGitCommitForWorkSize({
  command,
  cwd = process.cwd(),
  env,
  projectDirEnvVar = '',
  workspacePaths,
  globalDir,
  terminalId,
  sessionId,
  config = DEFAULT_CONFIG,
  loadConfigForRoot,
  isEnabledForRoot,
  lockOptions,
  now = new Date(),
} = {}) {
  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return { changed: false };
  if (command !== undefined && !commandRunsGitCommit(command)) return { changed: false };

  let statePath;
  try {
    statePath = getWorkSizeStatePath(globalDir, scope);
    if (!fs.existsSync(statePath)) return { changed: false };
  } catch {
    return { changed: false };
  }

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      if (!existingScope) return { changed: false };

      const projectRoot = resolveWorkSizeProjectRoot({
        cwd,
        env,
        projectDirEnvVar,
        workspacePaths,
        scopeState: existingScope,
      });
      const evalCfg = evaluateConfigForRoot(projectRoot, {
        loadConfigForRoot,
        isEnabledForRoot,
        fallbackConfig: config,
      });
      if (!evalCfg.enabled) return { changed: false };

      const commitInProject = command !== undefined
        ? commandRunsGitCommit(command, { cwd, projectRoot })
        : isSameOrSubpath(cwd, projectRoot);
      if (!commitInProject) return { changed: false };

      const cwdKey = projectPathKey(projectRoot);
      const existing = existingScope.projects[cwdKey];
      if (!existing) return { changed: false };
      if (Object.keys(existing.files).length === 0) return { changed: false, state: existing };

      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);
      const nextEntry = {
        ...existing,
        files: {},
        updatedAt: stamp,
      };
      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          ...existingScope,
          updatedAt: stamp,
          projects: { ...existingScope.projects, [cwdKey]: nextEntry },
        },
        { now: nowDate },
      );
      return { changed: true, state: nextEntry };
    },
    lockOptions,
  );

  return lockedResult.locked ? lockedResult.value : { changed: false };
}

/**
 * Clear cumulative per-file edit counts after a successful `memory_save`, and when the folder is in `L`,
 * record `memorySaved = true` (completing `L` -> `S` if `reviewAccepted` is also recorded).
 */
export function recordMemorySaveForWorkSize({
  cwd = process.cwd(),
  env,
  projectDirEnvVar = '',
  workspacePaths,
  globalDir,
  terminalId,
  sessionId,
  config = DEFAULT_CONFIG,
  loadConfigForRoot,
  isEnabledForRoot,
  lockOptions,
  now = new Date(),
} = {}) {
  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return { changed: false, completed: false };

  try {
    const statePath = getWorkSizeStatePath(globalDir, scope);
    if (!fs.existsSync(statePath)) return { changed: false, completed: false };
  } catch {
    return { changed: false, completed: false };
  }

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      if (!existingScope) return { changed: false, completed: false };

      const projectRoot = resolveWorkSizeProjectRoot({
        cwd,
        env,
        projectDirEnvVar,
        workspacePaths,
        scopeState: existingScope,
      });
      const evalCfg = evaluateConfigForRoot(projectRoot, {
        loadConfigForRoot,
        isEnabledForRoot,
        fallbackConfig: config,
      });
      if (!evalCfg.enabled) return { changed: false, completed: false };

      const cwdKey = projectPathKey(projectRoot);
      const existing = existingScope.projects[cwdKey];
      if (!existing) return { changed: false, completed: false };

      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);
      const hadFiles = Object.keys(existing.files).length > 0;
      if (existing.size !== 'L') {
        if (!hadFiles) return { changed: false, completed: false, state: existing };
        const nextEntry = {
          ...existing,
          files: {},
          updatedAt: stamp,
        };
        writeWorkSizeScopeState(
          globalDir,
          scope,
          {
            ...existingScope,
            updatedAt: stamp,
            projects: { ...existingScope.projects, [cwdKey]: nextEntry },
          },
          { now: nowDate },
        );
        return { changed: true, completed: false, state: nextEntry };
      }

      let nextEntry = {
        ...existing,
        files: {},
        memorySaved: true,
        memorySavedAt: stamp,
        updatedAt: stamp,
      };
      let completed = false;
      if (nextEntry.reviewAccepted && nextEntry.memorySaved) {
        nextEntry = transitionToCompletedS(nextEntry, nowDate);
        completed = true;
      }
      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          ...existingScope,
          updatedAt: stamp,
          projects: { ...existingScope.projects, [cwdKey]: nextEntry },
        },
        { now: nowDate },
      );
      return { changed: true, completed, state: nextEntry };
    },
    lockOptions,
  );

  return lockedResult.locked ? lockedResult.value : { changed: false, completed: false };
}

/**
 * Record an independent review verdict (`ACCEPT` or `NEEDS_FIX`) when the tab/session is currently in `L`
 * for the resolved project folder. Ignored when not in `L`. `NEEDS_FIX` clears a prior `ACCEPT`.
 */
export function recordReviewVerdict({
  verdict,
  cwd = process.cwd(),
  env,
  projectDirEnvVar = '',
  workspacePaths,
  globalDir,
  terminalId,
  sessionId,
  config = DEFAULT_CONFIG,
  loadConfigForRoot,
  isEnabledForRoot,
  lockOptions,
  now = new Date(),
} = {}) {
  if (verdict !== 'ACCEPT' && verdict !== 'NEEDS_FIX') return { changed: false, completed: false };

  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return { changed: false, completed: false };

  try {
    const statePath = getWorkSizeStatePath(globalDir, scope);
    if (!fs.existsSync(statePath)) return { changed: false, completed: false };
  } catch {
    return { changed: false, completed: false };
  }

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      if (!existingScope) return { changed: false, completed: false };

      const projectRoot = resolveWorkSizeProjectRoot({
        cwd,
        env,
        projectDirEnvVar,
        workspacePaths,
        scopeState: existingScope,
      });
      const evalCfg = evaluateConfigForRoot(projectRoot, {
        loadConfigForRoot,
        isEnabledForRoot,
        fallbackConfig: config,
      });
      if (!evalCfg.enabled) return { changed: false, completed: false };

      const cwdKey = projectPathKey(projectRoot);
      const existing = existingScope.projects[cwdKey];
      if (!existing || existing.size !== 'L') {
        return { changed: false, completed: false };
      }

      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);
      if (verdict === 'NEEDS_FIX') {
        if (!existing.reviewAccepted) return { changed: false, completed: false, state: existing };
        const nextEntry = {
          ...existing,
          reviewAccepted: false,
          reviewAcceptedAt: null,
          updatedAt: stamp,
        };
        writeWorkSizeScopeState(
          globalDir,
          scope,
          {
            ...existingScope,
            updatedAt: stamp,
            projects: { ...existingScope.projects, [cwdKey]: nextEntry },
          },
          { now: nowDate },
        );
        return { changed: true, completed: false, state: nextEntry };
      }

      let nextEntry = {
        ...existing,
        reviewAccepted: true,
        reviewAcceptedAt: stamp,
        updatedAt: stamp,
      };
      let completed = false;
      if (nextEntry.reviewAccepted && nextEntry.memorySaved) {
        nextEntry = transitionToCompletedS(nextEntry, nowDate);
        completed = true;
      }
      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          ...existingScope,
          updatedAt: stamp,
          projects: { ...existingScope.projects, [cwdKey]: nextEntry },
        },
        { now: nowDate },
      );
      return { changed: true, completed, state: nextEntry };
    },
    lockOptions,
  );

  return lockedResult.locked ? lockedResult.value : { changed: false, completed: false };
}

/**
 * Read the SessionStart (`context`) notice when the tab/session has an unfinished `L` job in the
 * resolved project root.
 */
export function getWorkSizeSessionNotice({
  cwd = process.cwd(),
  env,
  projectDirEnvVar = '',
  workspacePaths,
  globalDir,
  terminalId,
  sessionId,
  config = DEFAULT_CONFIG,
  loadConfigForRoot,
  isEnabledForRoot,
} = {}) {
  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return '';

  const scopeState = readWorkSizeScopeState(globalDir, scope);
  if (!scopeState) return '';

  const projectRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState,
  });
  const evalCfg = evaluateConfigForRoot(projectRoot, {
    loadConfigForRoot,
    isEnabledForRoot,
    fallbackConfig: config,
  });
  if (!evalCfg.enabled) return '';

  const entry = scopeState.projects[projectPathKey(projectRoot)];
  if (!entry || entry.size !== 'L') return '';

  return formatWorkSizeSessionNotice(entry);
}

/**
 * Consume and return the one-time L-completion notice (`WORK_SIZE_COMPLETED_NOTICE`) on the next
 * user prompt in the same project folder, or `''` if none is pending. Once consumed, the clean `S`
 * folder entry is removed during state write.
 */
export function consumeWorkSizeCompletedNotice({
  cwd = process.cwd(),
  env,
  projectDirEnvVar = '',
  workspacePaths,
  globalDir,
  terminalId,
  sessionId,
  config = DEFAULT_CONFIG,
  loadConfigForRoot,
  isEnabledForRoot,
  lockOptions,
  now = new Date(),
} = {}) {
  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return '';

  const quickScope = readWorkSizeScopeState(globalDir, scope);
  if (!quickScope) return '';

  const quickRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState: quickScope,
  });
  const quickEntry = quickScope.projects[projectPathKey(quickRoot)];
  if (!quickEntry || !quickEntry.completedNoticePending) return '';

  const evalCfg = evaluateConfigForRoot(quickRoot, {
    loadConfigForRoot,
    isEnabledForRoot,
    fallbackConfig: config,
  });
  if (!evalCfg.enabled) return '';

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      if (!existingScope) return '';

      const projectRoot = resolveWorkSizeProjectRoot({
        cwd,
        env,
        projectDirEnvVar,
        workspacePaths,
        scopeState: existingScope,
      });
      const cwdKey = projectPathKey(projectRoot);
      const existing = existingScope.projects[cwdKey];
      if (!existing || !existing.completedNoticePending) return '';

      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);
      const nextEntry = {
        ...existing,
        completedNoticePending: false,
        updatedAt: stamp,
      };
      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          ...existingScope,
          updatedAt: stamp,
          projects: { ...existingScope.projects, [cwdKey]: nextEntry },
        },
        { now: nowDate },
      );
      return WORK_SIZE_COMPLETED_NOTICE;
    },
    lockOptions,
  );

  return lockedResult.locked ? lockedResult.value : '';
}

/**
 * User CLI operation: release `L` back to `S` and clear cumulative files and completion records.
 * Defaults to the current shell folder (or recorded containing folder); `--all` releases every
 * recorded folder in the tab.
 */
export function releaseWorkSizeForTab(
  terminalId,
  {
    globalDir,
    cwd = process.cwd(),
    all = false,
    lockOptions,
    now = new Date(),
  } = {},
) {
  const scope = tabWorkSizeScope(terminalId);
  const filePath = getWorkSizeStatePath(globalDir, scope);

  if (!fs.existsSync(filePath)) {
    const targetRoot = resolveProjectRoot(path.resolve(cwd || process.cwd()));
    return {
      terminalId: scope.id,
      filePath,
      all: Boolean(all),
      cwd: all ? null : targetRoot,
      previousSize: 'S',
      size: 'S',
      changed: false,
      releasedFolders: [],
      state: null,
    };
  }

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);

      if (all) {
        const entries = existingScope ? Object.values(existingScope.projects) : [];
        if (entries.length === 0) {
          return {
            terminalId: scope.id,
            filePath,
            all: true,
            cwd: null,
            previousSize: 'S',
            size: 'S',
            changed: false,
            releasedFolders: [],
            state: null,
          };
        }
        const hadL = entries.some((entry) => entry.size === 'L');
        const releasedFolders = entries.map((entry) => entry.cwd);
        writeWorkSizeScopeState(
          globalDir,
          scope,
          {
            version: WORK_SIZE_STATE_VERSION,
            scopeKind: scope.kind,
            scopeId: scope.id,
            updatedAt: stamp,
            projects: {},
          },
          { now: nowDate },
        );
        return {
          terminalId: scope.id,
          filePath,
          all: true,
          cwd: null,
          previousSize: hadL ? 'L' : 'S',
          size: 'S',
          changed: true,
          releasedFolders,
          state: null,
        };
      }

      const targetRoot = resolveWorkSizeProjectRoot({ cwd, scopeState: existingScope });
      const targetKey = projectPathKey(targetRoot);
      const existing = existingScope?.projects?.[targetKey] || null;
      if (!existing) {
        return {
          terminalId: scope.id,
          filePath,
          all: false,
          cwd: targetRoot,
          previousSize: 'S',
          size: 'S',
          changed: false,
          releasedFolders: [],
          state: null,
        };
      }

      const nextProjects = { ...existingScope.projects };
      delete nextProjects[targetKey];
      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          ...existingScope,
          updatedAt: stamp,
          projects: nextProjects,
        },
        { now: nowDate },
      );

      return {
        terminalId: scope.id,
        filePath,
        all: false,
        cwd: existing.cwd,
        previousSize: existing.size,
        size: 'S',
        changed: true,
        releasedFolders: [existing.cwd],
        state: null,
      };
    },
    lockOptions,
  );

  if (!lockedResult.locked) {
    throw new Error(`Work-size state file for tab "${scope.id}" is currently locked.`);
  }
  return lockedResult.value;
}

/**
 * User CLI operation: keep current size (`S` or `L`) and completion records, clearing only
 * cumulative per-file counts. Defaults to the current shell folder (or recorded containing folder);
 * `--all` resets every recorded folder in the tab.
 */
export function resetWorkSizeWindowForTab(
  terminalId,
  {
    globalDir,
    cwd = process.cwd(),
    all = false,
    lockOptions,
    now = new Date(),
  } = {},
) {
  const scope = tabWorkSizeScope(terminalId);
  const filePath = getWorkSizeStatePath(globalDir, scope);

  if (!fs.existsSync(filePath)) {
    const targetRoot = resolveProjectRoot(path.resolve(cwd || process.cwd()));
    return {
      terminalId: scope.id,
      filePath,
      all: Boolean(all),
      cwd: all ? null : targetRoot,
      size: 'S',
      clearedFiles: 0,
      resetFolders: [],
      changed: false,
      state: null,
    };
  }

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);

      if (all) {
        const entries = existingScope ? Object.values(existingScope.projects) : [];
        let clearedFiles = 0;
        const resetFolders = [];
        const nextProjects = {};
        let hasL = false;

        for (const entry of entries) {
          if (entry.size === 'L') hasL = true;
          const count = Object.keys(entry.files).length;
          if (count > 0) {
            clearedFiles += count;
            resetFolders.push(entry.cwd);
            nextProjects[entry.cwdKey] = { ...entry, files: {}, updatedAt: stamp };
          } else {
            nextProjects[entry.cwdKey] = entry;
          }
        }

        if (clearedFiles === 0) {
          return {
            terminalId: scope.id,
            filePath,
            all: true,
            cwd: null,
            size: hasL ? 'L' : 'S',
            clearedFiles: 0,
            resetFolders: [],
            changed: false,
            state: null,
          };
        }

        writeWorkSizeScopeState(
          globalDir,
          scope,
          {
            ...existingScope,
            updatedAt: stamp,
            projects: nextProjects,
          },
          { now: nowDate },
        );
        return {
          terminalId: scope.id,
          filePath,
          all: true,
          cwd: null,
          size: hasL ? 'L' : 'S',
          clearedFiles,
          resetFolders,
          changed: true,
          state: null,
        };
      }

      const targetRoot = resolveWorkSizeProjectRoot({ cwd, scopeState: existingScope });
      const targetKey = projectPathKey(targetRoot);
      const existing = existingScope?.projects?.[targetKey] || null;
      if (!existing) {
        return {
          terminalId: scope.id,
          filePath,
          all: false,
          cwd: targetRoot,
          size: 'S',
          clearedFiles: 0,
          resetFolders: [],
          changed: false,
          state: null,
        };
      }

      const clearedFiles = Object.keys(existing.files).length;
      if (clearedFiles === 0) {
        return {
          terminalId: scope.id,
          filePath,
          all: false,
          cwd: existing.cwd,
          size: existing.size,
          clearedFiles: 0,
          resetFolders: [],
          changed: false,
          state: existing,
        };
      }

      const nextEntry = {
        ...existing,
        files: {},
        updatedAt: stamp,
      };
      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          ...existingScope,
          updatedAt: stamp,
          projects: { ...existingScope.projects, [targetKey]: nextEntry },
        },
        { now: nowDate },
      );

      return {
        terminalId: scope.id,
        filePath,
        all: false,
        cwd: nextEntry.cwd,
        size: nextEntry.size,
        clearedFiles,
        resetFolders: [nextEntry.cwd],
        changed: true,
        state: isCleanEmptyFolderEntry(nextEntry) ? null : nextEntry,
      };
    },
    lockOptions,
  );

  if (!lockedResult.locked) {
    throw new Error(`Work-size state file for tab "${scope.id}" is currently locked.`);
  }
  return lockedResult.value;
}

export function listTabWorkSizeStates(globalDir) {
  const dir = getWorkSizeDir(globalDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.startsWith('tab-') || !ent.name.endsWith('.json')) continue;
    const tid = ent.name.slice(4, -5);
    if (!isValidTerminalId(tid)) continue;
    const scopeState = readWorkSizeScopeState(globalDir, { kind: 'tab', id: tid, fileName: ent.name });
    if (scopeState && Object.keys(scopeState.projects).length > 0) {
      out.push(scopeState);
    }
  }
  return out.sort((a, b) => a.scopeId.localeCompare(b.scopeId));
}

// ---------------------------------------------------------------------------------------------
// Review verdict parser (shared by SubagentStop hook and `cortex-worker --role reviewer`)
// ---------------------------------------------------------------------------------------------

const VERDICT_LABEL_SRC =
  '(?:(?:Final\\s+)?Verdict(?:\\s*\\([^)\\r\\n]*\\))?|(?:최종\\s*)?판정(?:\\s*\\([^)\\r\\n]*\\))?)';

// Matches a Verdict / Final verdict / 판정 / 최종 판정 label at the start of a line (optional markdown
// heading, bullet, or numbering), capturing whatever follows the colon on the same line.
const VERDICT_INLINE_RE = new RegExp(
  `^\\s*(?:#{1,6}\\s+|(?:[-*+]|\\d+[.)])\\s+)?(?:\\*\\*|__)?(?:\\d+[.)]\\s*)?${VERDICT_LABEL_SRC}(?:\\*\\*|__)?\\s*(?::|：)\\s*(.*)$`,
  'i',
);

const VERDICT_HEADING_ONLY_RE = new RegExp(
  `^\\s*(?:#{1,6}\\s+|(?:[-*+]|\\d+[.)])\\s+)?(?:\\*\\*|__)?(?:\\d+[.)]\\s*)?${VERDICT_LABEL_SRC}(?:\\*\\*|__)?\\s*$`,
  'i',
);

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

function extractSingleVerdictToken(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  // Reject rubric/template lines that list both choices (e.g. "`ACCEPT` | `NEEDS_FIX`" or "`ACCEPT` 또는 `NEEDS_FIX`")
  const hasAccept = /(?:^|[^A-Za-z0-9_])ACCEPT(?![A-Za-z0-9_])/.test(trimmed);
  const hasNeedsFix = /(?:^|[^A-Za-z0-9_])NEEDS_FIX(?![A-Za-z0-9_])/.test(trimmed);
  if (hasAccept && hasNeedsFix) return null;

  // Strip leading list marker and markdown emphasis/code wrappers (`**`, `__`, `` ` ``)
  const unwrapped = trimmed
    .replace(/^(?:[-*+]\s+)/, '')
    .replace(/^(?:\*\*|__|`)+/, '')
    .trimStart();

  const match = /^(ACCEPT|NEEDS_FIX)(?![A-Za-z0-9_])/.exec(unwrapped);
  return match ? match[1] : null;
}

/**
 * Extract `'ACCEPT'` or `'NEEDS_FIX'` from a reviewer's final response text, or `null` when no structured
 * verdict section is present. Recognizes `Verdict`, `Final verdict`, `판정`, and `최종 판정` headings,
 * inline lines, and list items (`- **Verdict (판정)**: ...`). Ignores fenced code blocks, blockquotes, and
 * prose that merely mentions `ACCEPT` or `NEEDS_FIX` outside a verdict section. When multiple verdict
 * sections appear, the last one wins.
 */
export function parseReviewVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.split(/\r?\n/);
  let fenceMarker = '';
  let found = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!fenceMarker) {
        fenceMarker = char;
      } else if (char === fenceMarker && fenceMatch[1].length >= 3) {
        fenceMarker = '';
      }
      continue;
    }
    if (fenceMarker) continue;
    if (/^\s*>/.test(line)) continue; // ignore blockquotes

    const inlineMatch = VERDICT_INLINE_RE.exec(line);
    if (inlineMatch) {
      const rest = inlineMatch[1];
      if (rest.trim()) {
        const token = extractSingleVerdictToken(rest);
        if (token) found = token;
        continue;
      }
      // Empty after colon (`- **Verdict (판정)**:\n  - ACCEPT`): inspect next non-empty line
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const nextLine = lines[j];
        if (!nextLine.trim()) continue;
        if (FENCE_RE.test(nextLine) || /^\s*(?:#{1,6}\s|>)/.test(nextLine)) break;
        const token = extractSingleVerdictToken(nextLine);
        if (token) found = token;
        break;
      }
      continue;
    }

    if (VERDICT_HEADING_ONLY_RE.test(line)) {
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const nextLine = lines[j];
        if (!nextLine.trim()) continue;
        if (FENCE_RE.test(nextLine) || /^\s*(?:#{1,6}\s|>)/.test(nextLine)) break;
        const token = extractSingleVerdictToken(nextLine);
        if (token) found = token;
        break;
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------------------------
// Shell command detector for `git commit` (PostToolUse)
// ---------------------------------------------------------------------------------------------

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
]);

const GIT_COMMIT_OPTIONS_WITH_VALUE = new Set([
  '-m',
  '--message',
  '-F',
  '--file',
  '-C',
  '--reuse-message',
  '-c',
  '--reedit-message',
  '--fixup',
  '--squash',
  '--author',
  '--date',
  '--cleanup',
  '--trailer',
  '--pathspec-from-file',
]);

const GIT_COMMIT_NON_CLEARING_FLAGS = new Set([
  '--dry-run',
  '--allow-empty',
  '--short',
  '--porcelain',
  '--long',
  '-h',
  '--help',
]);

function skipCommandSubstitution(command, startIndex) {
  // Assumes `command.slice(startIndex, startIndex + 2) === '$('`
  let depth = 1;
  let quote = '';
  let i = startIndex + 2;
  while (i < command.length && depth > 0) {
    const ch = command[i];
    if (quote === '\'') {
      if (ch === '\'') quote = '';
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        i += 2;
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        depth++;
        i += 2;
        continue;
      }
      if (ch === '"') quote = '';
      i++;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  return i;
}

/**
 * Split a shell command into top-level command segments (`[{ text, quoted }, ...]`), keeping quoted
 * arguments (including `"$(cat <<'EOF' ... EOF)"` commit messages) intact as single tokens and skipping
 * comments and unquoted heredoc bodies.
 */
function tokenizeShellSegments(command) {
  const segments = [];
  let words = [];
  let text = '';
  let hasToken = false;
  let wasQuoted = false;
  let quote = '';
  const pendingHeredocs = [];

  const flushWord = () => {
    if (hasToken) words.push({ text, quoted: wasQuoted });
    text = '';
    hasToken = false;
    wasQuoted = false;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];

    if (quote === '\'') {
      if (ch === '\'') quote = '';
      else text += ch;
      i++;
      continue;
    }

    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length && (command[i + 1] === '"' || command[i + 1] === '\\' || command[i + 1] === '$')) {
        text += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        const end = skipCommandSubstitution(command, i);
        text += command.slice(i, end);
        i = end;
        continue;
      }
      if (ch === '"') {
        quote = '';
      } else {
        text += ch;
      }
      i++;
      continue;
    }

    // Unquoted heredoc operator `<<` or `<<-` (not `<<<` here-string)
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      flushWord();
      i += 2;
      let stripTabs = false;
      if (command[i] === '-') {
        stripTabs = true;
        i++;
      }
      while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i++;
      let delim = '';
      let delimQuote = '';
      while (i < command.length) {
        const dc = command[i];
        if (delimQuote) {
          if (dc === delimQuote) delimQuote = '';
          else delim += dc;
          i++;
          continue;
        }
        if (dc === '\'' || dc === '"') {
          delimQuote = dc;
          i++;
          continue;
        }
        if (/[\s;|&<>()\r\n]/.test(dc)) break;
        if (dc === '\\' && i + 1 < command.length) {
          delim += command[i + 1];
          i += 2;
          continue;
        }
        delim += dc;
        i++;
      }
      if (delim) pendingHeredocs.push({ delim, stripTabs });
      continue;
    }

    if (ch === '\'' || ch === '"') {
      quote = ch;
      hasToken = true;
      wasQuoted = true;
      i++;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      flushWord();
      i++;
      continue;
    }

    if (ch === '#' && !hasToken) {
      while (i < command.length && command[i] !== '\n') i++;
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      flushSegment();
      if (ch === '\r' && command[i + 1] === '\n') i += 2;
      else i++;
      // Skip heredoc bodies queued on the line that just ended
      while (pendingHeredocs.length > 0 && i < command.length) {
        const { delim, stripTabs } = pendingHeredocs.shift();
        while (i < command.length) {
          const lineEnd = command.indexOf('\n', i);
          const rawLine = (lineEnd === -1 ? command.slice(i) : command.slice(i, lineEnd)).replace(/\r$/, '');
          i = lineEnd === -1 ? command.length : lineEnd + 1;
          const candidate = stripTabs ? rawLine.replace(/^\t+/, '') : rawLine;
          if (candidate === delim) break;
        }
      }
      continue;
    }

    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      flushSegment();
      i++;
      continue;
    }

    if (ch === '\\' && i + 1 < command.length && (command[i + 1] === '\n' || command[i + 1] === '\r')) {
      // Line continuation
      i += command[i + 1] === '\r' && command[i + 2] === '\n' ? 3 : 2;
      continue;
    }

    text += ch;
    hasToken = true;
    i++;
  }

  flushSegment();
  return segments;
}

function executableBaseName(word) {
  const cut = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'));
  return word.slice(cut + 1).toLowerCase();
}

function inspectGitCommitSegment(words, baseCwd) {
  let idx = 0;
  // Skip PowerShell call operator `&` or leading POSIX `KEY=VALUE` assignments
  while (idx < words.length) {
    const token = words[idx];
    if (!token.quoted && token.text === '&') {
      idx++;
      continue;
    }
    if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) {
      idx++;
      continue;
    }
    break;
  }
  if (idx >= words.length) return { isCommit: false, targetDir: '' };

  const bin = executableBaseName(words[idx].text);
  if (bin !== 'git' && bin !== 'git.exe') return { isCommit: false, targetDir: '' };
  idx++;

  let effectiveDir = baseCwd;
  let invalidDirOption = false;

  // Walk global git options before the subcommand
  let subcommand = '';
  while (idx < words.length) {
    const arg = words[idx].text;
    if (arg === '--') return { isCommit: false, targetDir: '' };
    if (arg === '-h' || arg === '--help' || arg === '--version') return { isCommit: false, targetDir: '' };
    if (arg === '-C') {
      if (idx + 1 >= words.length || !words[idx + 1].text.trim() || words[idx + 1].text.includes('\0')) {
        return { isCommit: false, targetDir: '' };
      }
      if (effectiveDir) {
        effectiveDir = path.resolve(effectiveDir, words[idx + 1].text.trim());
      }
      idx += 2;
      continue;
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      const attachedDir = arg.slice(2).trim();
      if (!attachedDir || attachedDir.includes('\0')) {
        invalidDirOption = true;
      } else if (effectiveDir) {
        effectiveDir = path.resolve(effectiveDir, attachedDir);
      }
      idx++;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      idx += 2;
      continue;
    }
    if (arg.startsWith('-')) {
      idx++;
      continue;
    }
    subcommand = arg;
    idx++;
    break;
  }

  if (invalidDirOption || subcommand !== 'commit') return { isCommit: false, targetDir: '' };

  // Inspect `git commit` options (ignoring option values like `-m "--dry-run"` or `-m "--allow-empty"`)
  while (idx < words.length) {
    const token = words[idx];
    const arg = token.text;
    if (!token.quoted && arg === '--') break;
    if (
      GIT_COMMIT_NON_CLEARING_FLAGS.has(arg)
      || arg.startsWith('--dry-run=')
    ) {
      return { isCommit: false, targetDir: '' };
    }
    if (GIT_COMMIT_OPTIONS_WITH_VALUE.has(arg) || /^-[apionvsqe]+[mFcC]$/.test(arg)) {
      idx += 2;
      continue;
    }
    idx++;
  }

  return { isCommit: true, targetDir: effectiveDir };
}

/**
 * True when `command` executes a real `git commit` (excluding `--dry-run`, `--allow-empty`, `--short`,
 * `--porcelain`, `--long`, `--help`, and quoted strings). When `projectRoot` is given, also verifies
 * that the commit's target folder (`git -C <dir>` if present, otherwise `cwd`) lies inside `projectRoot`.
 */
export function commandRunsGitCommit(command, { cwd, projectRoot } = {}) {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (!/\bcommit\b/i.test(command)) return false;

  const hasProjectBound = typeof projectRoot === 'string' && projectRoot.trim().length > 0;
  const baseCwd = hasProjectBound
    ? path.resolve(typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd())
    : '';
  const rootDir = hasProjectBound ? resolveProjectRoot(path.resolve(projectRoot.trim())) : '';

  const segments = tokenizeShellSegments(command);
  return segments.some((words) => {
    const info = inspectGitCommitSegment(words, baseCwd);
    if (!info.isCommit) return false;
    if (!hasProjectBound) return true;
    return isSameOrSubpath(info.targetDir, rootDir);
  });
}
