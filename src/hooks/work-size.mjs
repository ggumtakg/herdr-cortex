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
import {
  formatContractFileDenyReason,
  formatFileDependencyNotice,
  lookupFileDependencyDocs,
  matchContractFilePattern,
} from './file-dependencies.mjs';
import { isReadOnlyShellCommand } from './shell-read-only.mjs';
import {
  executableBaseName,
  extractNestedShellCommands,
  isCandidateCommandWord,
  normalizeShellKind,
  tokenizeShellSegments,
} from './shell-tokens.mjs';

/**
 * Host-independent work-size (S / L) state management, stable project-root resolution,
 * per-folder edit counting, threshold blocking, repeated failed-edit blocking, contract-file
 * and memory-graph dependency notices, read-volume notices, unsaved/periodic reminders,
 * lock-protected updates, cumulative window clearing (`git commit` / `memory_save`),
 * reviewer verdict extraction, L completion tracking (`ACCEPT` + `memory_save`), and stale cleanup.
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
export const WORK_SIZE_NOTICE_MAX_CHARS = 300;
export const WORK_SIZE_SESSION_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const WORK_SIZE_DELEGATION_TTL_MS = 24 * 60 * 60 * 1000;
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

  if (Array.isArray(workspacePaths) && workspacePaths.length > 0 && isExistingAbsoluteDirectory(workspacePaths[0])) {
    return resolveProjectRoot(path.resolve(workspacePaths[0].trim()));
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

function parseStoredFailedRetries(rawRetries) {
  if (rawRetries === undefined || rawRetries === null) return {};
  if (!isPlainObject(rawRetries)) return null;
  const clean = {};
  for (const [key, val] of Object.entries(rawRetries)) {
    if (typeof key !== 'string' || !key.trim()) return null;
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return null;
    const count = Math.floor(val);
    if (count > 0) clean[key.trim()] = count;
  }
  return clean;
}

function parseStoredStringList(rawList) {
  if (rawList === undefined || rawList === null) return [];
  if (!Array.isArray(rawList)) return null;
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const norm = normalizeTrackedFileKey(trimmed);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(trimmed);
  }
  return out;
}

function parseOptionalNonNegInt(rawVal) {
  if (rawVal === undefined || rawVal === null) return 0;
  if (typeof rawVal !== 'number' || !Number.isFinite(rawVal) || rawVal < 0) return null;
  return Math.floor(rawVal);
}

function parsePendingNotices(rawList) {
  if (rawList === undefined || rawList === null) return [];
  if (!Array.isArray(rawList)) return null;
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function parseDelegatedState(rawDelegated) {
  if (rawDelegated === undefined || rawDelegated === null) return null;
  if (!isPlainObject(rawDelegated)) return null;
  const rawFrom = typeof rawDelegated.fromTerminalId === 'string' ? rawDelegated.fromTerminalId.trim() : '';
  if (rawFrom && !isValidTerminalId(rawFrom)) return null;
  const delegatedAt = typeof rawDelegated.delegatedAt === 'string' ? rawDelegated.delegatedAt.trim() : '';
  let delegatedAtMs = Number(rawDelegated.delegatedAtMs);
  if (!Number.isFinite(delegatedAtMs) || delegatedAtMs <= 0) {
    const parsedMs = delegatedAt ? Date.parse(delegatedAt) : NaN;
    if (!Number.isFinite(parsedMs) || parsedMs <= 0) return null;
    delegatedAtMs = parsedMs;
  }
  return {
    fromTerminalId: rawFrom,
    delegatedAt: delegatedAt || formatIsoTimestamp(new Date(delegatedAtMs)),
    delegatedAtMs,
  };
}

export function isDelegationActive(delegated, nowMs = Date.now()) {
  if (!delegated || !Number.isFinite(delegated.delegatedAtMs)) return false;
  return nowMs - delegated.delegatedAtMs < WORK_SIZE_DELEGATION_TTL_MS;
}

function parseFolderEntry(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.size !== 'S' && raw.size !== 'L') return null;
  if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) return null;
  if (typeof raw.cwdKey !== 'string' || !raw.cwdKey.trim()) return null;

  const files = parseStoredFiles(raw.files);
  if (!files) return null;

  const failedRetries = parseStoredFailedRetries(raw.failedRetries);
  if (!failedRetries) return null;

  const editedSinceShell = parseStoredStringList(raw.editedSinceShell);
  if (!editedSinceShell) return null;

  const unsavedFiles = parseStoredStringList(raw.unsavedFiles);
  if (!unsavedFiles) return null;

  const pendingNotices = parsePendingNotices(raw.pendingNotices);
  if (!pendingNotices) return null;

  const promptTurns = parseOptionalNonNegInt(raw.promptTurns);
  const turnReads = parseOptionalNonNegInt(raw.turnReads);
  if (promptTurns === null || turnReads === null) return null;

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
    failedRetries,
    editedSinceShell,
    unsavedFiles,
    unsavedCommitted: Boolean(raw.unsavedCommitted),
    unsavedReminded: Boolean(raw.unsavedReminded),
    promptTurns,
    turnReads,
    turnReadNotified: Boolean(raw.turnReadNotified),
    reviewAccepted: isL ? Boolean(raw.reviewAccepted) : false,
    reviewAcceptedAt: isL && typeof raw.reviewAcceptedAt === 'string' && raw.reviewAcceptedAt.trim()
      ? raw.reviewAcceptedAt.trim()
      : null,
    memorySaved: isL ? Boolean(raw.memorySaved) : false,
    memorySavedAt: isL && typeof raw.memorySavedAt === 'string' && raw.memorySavedAt.trim()
      ? raw.memorySavedAt.trim()
      : null,
    completedNoticePending: Boolean(raw.completedNoticePending),
    pendingNotices,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

function isCleanEmptyFolderEntry(entry) {
  return Boolean(entry)
    && entry.size === 'S'
    && Object.keys(entry.files || {}).length === 0
    && Object.keys(entry.failedRetries || {}).length === 0
    && (entry.editedSinceShell?.length || 0) === 0
    && (entry.unsavedFiles?.length || 0) === 0
    && !entry.unsavedCommitted
    && (entry.promptTurns || 0) === 0
    && (entry.turnReads || 0) === 0
    && !entry.completedNoticePending
    && (entry.pendingNotices?.length || 0) === 0;
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
      delegated: null,
      projects: {
        [single.cwdKey]: single,
      },
    };
  }

  if (parsed.version !== WORK_SIZE_STATE_VERSION || !isPlainObject(parsed.projects)) {
    return null;
  }

  const delegated = parsed.delegated !== undefined ? parseDelegatedState(parsed.delegated) : null;
  if (parsed.delegated !== undefined && parsed.delegated !== null && !delegated) {
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
    delegated,
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
export function writeWorkSizeScopeState(
  globalDir,
  scope,
  scopeState,
  { now = new Date(), skipPruneSessions = false } = {},
) {
  const filePath = getWorkSizeStatePath(globalDir, scope);
  const nowDate = toDate(now);
  const nowMs = nowDate.getTime();

  const cleanProjects = {};
  if (scopeState && isPlainObject(scopeState.projects)) {
    for (const [key, entry] of Object.entries(scopeState.projects)) {
      if (!entry || isCleanEmptyFolderEntry(entry)) continue;
      const cleanKey = typeof entry.cwdKey === 'string' && entry.cwdKey.trim() ? entry.cwdKey.trim() : key;
      const cleanEntry = { ...entry };
      if (!Array.isArray(cleanEntry.pendingNotices) || cleanEntry.pendingNotices.length === 0) {
        delete cleanEntry.pendingNotices;
      }
      cleanProjects[cleanKey] = cleanEntry;
    }
  }

  const parsedDelegated = scope.kind === 'tab' && scopeState?.delegated
    ? parseDelegatedState(scopeState.delegated)
    : null;
  const activeDelegated = parsedDelegated && isDelegationActive(parsedDelegated, nowMs)
    ? parsedDelegated
    : null;

  const hasEntries = Object.keys(cleanProjects).length > 0 || Boolean(activeDelegated);
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
      ...(activeDelegated ? { delegated: activeDelegated } : {}),
      projects: cleanProjects,
    });
  }

  if (!skipPruneSessions) {
    pruneStaleWorkSizeSessions(globalDir, nowMs, {
      keepFileName: hasEntries ? scope.fileName : '',
    });
  }
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
      delegated: existing?.delegated || null,
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
    failedRetries: {},
    editedSinceShell: [],
    unsavedFiles: [],
    unsavedCommitted: false,
    unsavedReminded: false,
    promptTurns: 0,
    turnReads: 0,
    turnReadNotified: false,
    reviewAccepted: false,
    reviewAcceptedAt: null,
    memorySaved: false,
    memorySavedAt: null,
    completedNoticePending: false,
    pendingNotices: [],
    updatedAt: '',
  };
}

function appendUniqueNotice(list, notice) {
  const trimmed = typeof notice === 'string' ? notice.trim() : '';
  const existing = Array.isArray(list) ? list : [];
  if (!trimmed || existing.includes(trimmed)) return existing;
  return [...existing, trimmed];
}

function appendTrackedFileOnce(list, relPath) {
  const norm = normalizeTrackedFileKey(relPath);
  const existing = Array.isArray(list) ? list : [];
  if (existing.some((item) => normalizeTrackedFileKey(item) === norm)) {
    return existing;
  }
  return [...existing, relPath];
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

/**
 * One-line unsaved-work reminder for `UserPromptSubmit` (2-1, <= 300 chars).
 */
export function formatUnsavedReminder({ editedFileCount = 0, committed = false } = {}) {
  const count = Math.max(0, Math.floor(Number(editedFileCount) || 0));
  if (count === 0 && !committed) return '';
  const text =
    `[herdr-cortex] 미저장 활동(편집 파일 ${formatNumber(count)}개, 커밋 ${committed ? '있음' : '없음'}): `
    + '결정·작업 결과가 생겼다면 이번 응답 전에 `memory_save`로 남기세요.';
  return clipText(text, WORK_SIZE_NOTICE_MAX_CHARS);
}

/**
 * Two-line periodic reminder for `UserPromptSubmit` every `reminderEveryTurns` prompts (2-2, <= 300 chars).
 */
export function formatPeriodicReminder(state) {
  const isL = state?.size === 'L';
  let statusText = 'S';
  if (isL) {
    const remaining = [];
    if (!state.reviewAccepted) remaining.push('검수 ACCEPT');
    if (!state.memorySaved) remaining.push('memory_save');
    statusText = `L(남은 조건: ${remaining.length > 0 ? remaining.join(', ') : '없음'})`;
  }
  const line1 = clipText(
    `[herdr-cortex] 작업 규모(2파일+·위치 미상·의존 변경·파일당 1,000자 초과면 L, L은 위임) — 지금 상태: ${statusText}.`,
    190,
  );
  const line2 = '기억 저장: 결정 합의·커밋·선호 확인 뒤, 그 턴의 최종 응답 전에 `memory_save`를 부른다.';
  const combined = `${line1}\n${line2}`;
  return combined.length <= WORK_SIZE_NOTICE_MAX_CHARS
    ? combined
    : `${combined.slice(0, WORK_SIZE_NOTICE_MAX_CHARS - 3)}...`;
}

/**
 * One-time per-turn PreToolUse notice when `Read`/`Grep`/`Glob` calls exceed `readNoticeThreshold` (2-3, <= 300 chars).
 */
export function formatReadVolumeNotice({ readCount, threshold } = {}) {
  const text =
    `[herdr-cortex] 이번 입력에서 읽기·검색 도구를 ${formatNumber(readCount)}회 호출했습니다(기준 ${formatNumber(threshold)}회 초과). `
    + '무엇을 찾는지 정해지지 않은 탐색이면 `researcher` 워커에게 맡기는 것을 고려하고, 원래 목적을 다시 확인하세요.';
  return clipText(text, WORK_SIZE_NOTICE_MAX_CHARS);
}

/**
 * PreToolUse deny reason when editing a file that already reached `maxFailedRetries` failed shell runs (2-4, <= 300 chars).
 */
export function formatFailedRetryDenyReason({ file, failedCount, escalated = true } = {}) {
  const shortFile = clipText(file || '대상 파일', 45);
  const actionClause = escalated ? '편집을 막고 L로 올렸습니다' : '편집을 막았습니다(현재 L)';
  const text =
    `[herdr-cortex] "${shortFile}" 수정 후 명령 실패가 ${formatNumber(failedCount)}회 되풀이되어 ${actionClause}. `
    + '세부를 덧대지 말고 원래 문제로 올라가 원인을 다시 보세요. '
    + '원인을 말할 수 없으면 조사를 `researcher`에게 맡기고(`start-job` 2번), 원인이 정해지면 구현을 위임하세요. '
    + `잘못 걸렸으면 사용자에게 알리세요(\`${WORK_SIZE_COMMAND}\`).`;
  return clipText(text, WORK_SIZE_NOTICE_MAX_CHARS);
}

export { formatContractFileDenyReason, formatFileDependencyNotice };

/**
 * One-line Korean notice appended to a delivered relay message when `delegate: true` marks the
 * recipient tab as a delegated worker.
 */
export function formatDelegatedRelayNotice(fromTerminalId) {
  const cleanFrom = sanitizeInline(fromTerminalId);
  if (cleanFrom) {
    return `[herdr-cortex] 이 탭은 지금 탭 ${cleanFrom}에서 위임받은 워커입니다. 작업이 끝나면 relay_send(to_terminal_id="${cleanFrom}")로 결과를 돌려주세요.`;
  }
  return '[herdr-cortex] 이 탭은 지금 릴레이로 위임받은 워커입니다. 작업이 끝나면 맡긴 탭으로 relay_send를 호출해 결과를 돌려주세요.';
}

function findMatchingFileKey(files, relPath) {
  const targetKey = normalizeTrackedFileKey(relPath);
  for (const existingKey of Object.keys(files || {})) {
    if (normalizeTrackedFileKey(existingKey) === targetKey) return existingKey;
  }
  return null;
}

function evaluateConfigForRoot(rootDir, { preRoot, preConfig, loadConfigForRoot, isEnabledForRoot, fallbackConfig }) {
  const cfg = preConfig && preRoot && projectPathKey(rootDir) === projectPathKey(preRoot)
    ? preConfig
    : (typeof loadConfigForRoot === 'function' ? loadConfigForRoot(rootDir) : fallbackConfig);
  if (typeof isEnabledForRoot === 'function' && !isEnabledForRoot(rootDir, cfg)) {
    return { enabled: false, workSize: null, cfg };
  }
  const workSize = resolveWorkSizeConfig(cfg);
  return { enabled: workSize.enabled, workSize, cfg };
}

/**
 * Evaluate one file-edit tool call against the tab/session work-size window (including repeated
 * failed-edit blocking, contract-file blocking in S, file/char limits, and one-time memory-graph
 * dependency notice per cumulative window) and update state on disk under an exclusive lock.
 * Returns `{ action: 'pass' | 'allow' | 'deny', denyReason?, additionalContext?, dependencyDocs?, violation?, state? }`.
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
  dependencyLookupOptions,
  queueNotice = false,
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

  const escalateIfS = (state, existingScope, existingProjects, cwdKey, violation, stamp, nowDate) => {
    if (state.size !== 'S') return state;
    const escalated = {
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
        delegated: existingScope?.delegated || null,
        projects: { ...existingProjects, [cwdKey]: escalated },
      },
      { now: nowDate },
    );
    return escalated;
  };

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
      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);

      // 1. Repeated edit-after-shell-failure guard (2-4)
      const matchedFailKey = findMatchingFileKey(state.failedRetries, tracked.relPath);
      const failedCount = matchedFailKey ? state.failedRetries[matchedFailKey] : 0;
      if (workSize.maxFailedRetries > 0 && failedCount >= workSize.maxFailedRetries) {
        const wasS = state.size === 'S';
        const violation = {
          rule: 'max_failed_retries',
          file: fileKey,
          failedCount,
          maxFailedRetries: workSize.maxFailedRetries,
          summary: `${clipText(fileKey, 64)} 수정 실패 ${formatNumber(failedCount)}회 되풀이`,
        };
        const nextFolder = escalateIfS(state, existingScope, existingProjects, cwdKey, violation, stamp, nowDate);
        return {
          action: 'deny',
          denyReason: formatFailedRetryDenyReason({ file: fileKey, failedCount, escalated: wasS }),
          violation,
          state: { version: WORK_SIZE_STATE_VERSION, scopeKind: scope.kind, scopeId: scope.id, ...nextFolder },
        };
      }

      // 2. Contract file glob guard while in S (2-6a; already-L applies ordinary limits below)
      if (state.size === 'S' && workSize.contractFiles.length > 0) {
        const matchedPattern = matchContractFilePattern(tracked.relPath, workSize.contractFiles);
        if (matchedPattern) {
          const violation = {
            rule: 'contract_file',
            file: fileKey,
            pattern: matchedPattern,
            summary: `계약 파일(${clipText(fileKey, 48)}, 패턴: ${clipText(matchedPattern, 40)})`,
          };
          const nextFolder = escalateIfS(state, existingScope, existingProjects, cwdKey, violation, stamp, nowDate);
          return {
            action: 'deny',
            denyReason: formatContractFileDenyReason({
              file: fileKey,
              pattern: matchedPattern,
              commandName: WORK_SIZE_COMMAND,
            }),
            violation,
            state: { version: WORK_SIZE_STATE_VERSION, scopeKind: scope.kind, scopeId: scope.id, ...nextFolder },
          };
        }
      }

      // 3. Cumulative file count & per-file character limit (6a)
      const previousChars = matchedKey ? state.files[matchedKey] : 0;
      const currentFileCount = Object.keys(state.files).length;
      const projectedFileCount = matchedKey ? currentFileCount : currentFileCount + 1;
      const projectedChars = previousChars + safeAdded;

      const exceedsFiles = projectedFileCount > workSize.maxFilesPerWindow;
      const exceedsChars = projectedChars > workSize.maxCharsPerFile;

      if (!exceedsFiles && !exceedsChars) {
        const nextFolder = {
          ...state,
          files: {
            ...state.files,
            [fileKey]: projectedChars,
          },
          editedSinceShell:
            workSize.maxFailedRetries > 0
              ? appendTrackedFileOnce(state.editedSinceShell, fileKey)
              : [],
          unsavedFiles: appendTrackedFileOnce(state.unsavedFiles, fileKey),
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
            delegated: existingScope?.delegated || null,
            projects: { ...existingProjects, [cwdKey]: nextFolder },
          },
          { now: nowDate },
        );
        return {
          action: 'allow',
          isFirstEditInWindow: matchedKey === null,
          trackedRoot: tracked.projectRoot,
          trackedRelPath: tracked.relPath,
          evalConfig: evalCfg.cfg,
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

      const nextFolder = escalateIfS(state, existingScope, existingProjects, cwdKey, violation, stamp, nowDate);
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

  const outcome = lockedResult.value;
  if (outcome.action !== 'allow') {
    return outcome;
  }

  const {
    isFirstEditInWindow,
    trackedRoot,
    trackedRelPath,
    evalConfig,
    ...publicOutcome
  } = outcome;

  // 4. Memory-graph dependency notice once per file per cumulative window (2-6b; runs outside scope lock)
  if (isFirstEditInWindow) {
    const depDocs = lookupFileDependencyDocs(trackedRoot, trackedRelPath, {
      globalDir,
      config: evalConfig,
      ...(isPlainObject(dependencyLookupOptions) ? dependencyLookupOptions : {}),
    });
    if (depDocs.length > 0) {
      const additionalContext = formatFileDependencyNotice(depDocs);
      if (additionalContext) {
        if (queueNotice) {
          queueWorkSizePendingNotice(globalDir, scope, trackedRoot, additionalContext, { lockOptions, now });
        }
        return {
          ...publicOutcome,
          additionalContext,
          dependencyDocs: depDocs,
        };
      }
    }
  }

  return publicOutcome;
}

/**
 * Lightweight PreToolUse counter for `Read`, `Grep`, and `Glob` calls within the current user prompt
 * turn (2-3). When `readNoticeThreshold` is `0` (or work-size is disabled/excluded), returns immediately
 * without reading, locking, or writing any state file.
 */
export function evaluateWorkSizeRead({
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
  queueNotice = false,
  lockOptions,
  now = new Date(),
} = {}) {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) {
    return { action: 'pass', reason: 'invalid_cwd' };
  }

  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return { action: 'pass', reason: 'no_scope' };

  // Fast exit before touching the state file when threshold is 0 or project/work-size is disabled.
  const hostHintRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState: null,
  });
  const initialCfg = typeof loadConfigForRoot === 'function' ? loadConfigForRoot(hostHintRoot) : config;
  const initialEval = evaluateConfigForRoot(hostHintRoot, {
    preRoot: hostHintRoot,
    preConfig: initialCfg,
    loadConfigForRoot,
    isEnabledForRoot,
    fallbackConfig: config,
  });
  const hasPerProjectOverrides = isPlainObject(initialCfg?.projects) && Object.keys(initialCfg.projects).length > 0;
  const hasExplicitHostRoot = Boolean(
    (projectDirEnvVar && getEnvValue(env, projectDirEnvVar).trim())
    || (Array.isArray(workspacePaths) && workspacePaths.length > 0 && isExistingAbsoluteDirectory(workspacePaths[0])),
  );
  if (
    (!initialEval.enabled || initialEval.workSize.readNoticeThreshold <= 0)
    && (hasExplicitHostRoot || !hasPerProjectOverrides)
  ) {
    return { action: 'pass', reason: 'disabled' };
  }

  if (!hasExplicitHostRoot && hasPerProjectOverrides) {
    const preScope = readWorkSizeScopeState(globalDir, scope);
    const resolvedPreRoot = resolveWorkSizeProjectRoot({
      cwd,
      env,
      projectDirEnvVar,
      workspacePaths,
      scopeState: preScope,
    });
    const preEval = evaluateConfigForRoot(resolvedPreRoot, {
      preRoot: hostHintRoot,
      preConfig: initialCfg,
      loadConfigForRoot,
      isEnabledForRoot,
      fallbackConfig: config,
    });
    if (!preEval.enabled || preEval.workSize.readNoticeThreshold <= 0) {
      return { action: 'pass', reason: 'disabled' };
    }
  }

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
      const evalCfg = evaluateConfigForRoot(projectRoot, {
        preRoot: hostHintRoot,
        preConfig: initialCfg,
        loadConfigForRoot,
        isEnabledForRoot,
        fallbackConfig: config,
      });
      if (!evalCfg.enabled || evalCfg.workSize.readNoticeThreshold <= 0) {
        return { action: 'pass', reason: 'disabled' };
      }

      const threshold = evalCfg.workSize.readNoticeThreshold;
      const cwdKey = projectPathKey(projectRoot);
      const existingProjects = existingScope ? existingScope.projects : {};
      const state = existingProjects[cwdKey] || createFreshFolderState(projectRoot, cwdKey);

      const readCount = (state.turnReads || 0) + 1;
      const shouldNotify = readCount > threshold && !state.turnReadNotified;
      const noticeText = shouldNotify ? formatReadVolumeNotice({ readCount, threshold }) : '';
      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);
      const nextFolder = {
        ...state,
        turnReads: readCount,
        turnReadNotified: state.turnReadNotified || shouldNotify,
        pendingNotices: queueNotice && noticeText
          ? appendUniqueNotice(state.pendingNotices, noticeText)
          : (state.pendingNotices || []),
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
          delegated: existingScope?.delegated || null,
          projects: { ...existingProjects, [cwdKey]: nextFolder },
        },
        { now: nowDate, skipPruneSessions: true },
      );

      return {
        action: 'allow',
        readCount,
        notified: shouldNotify,
        additionalContext: noticeText,
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
    failedRetries: {},
    editedSinceShell: [],
    reviewAccepted: false,
    reviewAcceptedAt: null,
    memorySaved: false,
    memorySavedAt: null,
    completedNoticePending: true,
    updatedAt: stamp,
  };
}

/**
 * Process a shell tool execution result (`PostToolUse` when `ok === true`, `PostToolUseFailure` when
 * `ok === false`):
 * - Ignores user-interrupted runs (`isInterrupt === true`) and recognizably read-only shell commands
 *   (`isReadOnlyShellCommand(command) === true`, so `grep` with exit 1 does not count as a failed edit
 *   retry and `git diff` / `ls` with exit 0 does not reset prior failed-retry counts).
 * - When `ok === false`: if `maxFailedRetries > 0` and at least one project file was edited since the
 *   previous non-read-only shell result (`editedSinceShell`), increments each such file's `failedRetries`
 *   by 1 and clears `editedSinceShell`. Shell failures with no preceding file edits are ignored.
 * - When `ok === true`: resets `failedRetries` and `editedSinceShell`; if `command` also ran an
 *   in-project `git commit`, clears cumulative `files` and marks `unsavedCommitted = true` (2-1).
 */
export function recordShellResultForWorkSize({
  ok = true,
  isInterrupt = false,
  command,
  shell = '',
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
  if (isInterrupt) return { changed: false };
  if (typeof command === 'string' && isReadOnlyShellCommand(command)) {
    return { changed: false };
  }

  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return { changed: false };

  const maybeGitCommit = Boolean(ok) && commandRunsGitCommit(command, { shell });
  let stateExists = false;
  try {
    const statePath = getWorkSizeStatePath(globalDir, scope);
    stateExists = Boolean(statePath) && fs.existsSync(statePath);
  } catch {
    return { changed: false };
  }

  // Only an in-project `git commit` can record new state (`unsavedCommitted: true`) without prior state.
  if (!stateExists && !maybeGitCommit) {
    return { changed: false };
  }

  // Quick pre-check before acquiring the lock so ordinary shell calls in clean tabs do zero lock/write I/O.
  const preScope = stateExists ? readWorkSizeScopeState(globalDir, scope) : null;
  const preRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState: preScope,
  });
  const preCfg = typeof loadConfigForRoot === 'function' ? loadConfigForRoot(preRoot) : config;
  const preEval = evaluateConfigForRoot(preRoot, {
    preRoot,
    preConfig: preCfg,
    loadConfigForRoot,
    isEnabledForRoot,
    fallbackConfig: config,
  });
  if (!preEval.enabled) return { changed: false };

  if (!maybeGitCommit) {
    const preEntry = preScope?.projects?.[projectPathKey(preRoot)];
    if (!preEntry) return { changed: false };
    if (!ok) {
      if (preEval.workSize.maxFailedRetries <= 0 || preEntry.editedSinceShell.length === 0) {
        return { changed: false };
      }
    } else if (
      Object.keys(preEntry.failedRetries).length === 0
      && preEntry.editedSinceShell.length === 0
    ) {
      return { changed: false };
    }
  } else if (!stateExists && !commandRunsGitCommit(command, { cwd, projectRoot: preRoot, shell })) {
    return { changed: false };
  }

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
      const evalCfg = evaluateConfigForRoot(projectRoot, {
        preRoot,
        preConfig: preCfg,
        loadConfigForRoot,
        isEnabledForRoot,
        fallbackConfig: config,
      });
      if (!evalCfg.enabled) return { changed: false };

      const cwdKey = projectPathKey(projectRoot);
      const existingProjects = existingScope ? existingScope.projects : {};
      const existing = existingProjects[cwdKey] || null;
      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);

      if (!ok) {
        if (!existing || existing.editedSinceShell.length === 0) {
          return { changed: false };
        }
        if (evalCfg.workSize.maxFailedRetries <= 0) {
          const clearedEntry = {
            ...existing,
            editedSinceShell: [],
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
              delegated: existingScope?.delegated || null,
              projects: { ...existingProjects, [cwdKey]: clearedEntry },
            },
            { now: nowDate },
          );
          return { changed: true, state: clearedEntry };
        }

        const nextRetries = { ...existing.failedRetries };
        for (const editedFile of existing.editedSinceShell) {
          const matchKey = findMatchingFileKey(nextRetries, editedFile) || editedFile;
          nextRetries[matchKey] = (nextRetries[matchKey] || 0) + 1;
        }
        const nextEntry = {
          ...existing,
          failedRetries: nextRetries,
          editedSinceShell: [],
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
            delegated: existingScope?.delegated || null,
            projects: { ...existingProjects, [cwdKey]: nextEntry },
          },
          { now: nowDate },
        );
        return { changed: true, state: nextEntry };
      }

      const isInProjectCommit = maybeGitCommit && commandRunsGitCommit(command, { cwd, projectRoot, shell });
      if (isInProjectCommit) {
        const base = existing || createFreshFolderState(projectRoot, cwdKey);
        const nextEntry = {
          ...base,
          files: {},
          failedRetries: {},
          editedSinceShell: [],
          unsavedCommitted: true,
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
            delegated: existingScope?.delegated || null,
            projects: { ...existingProjects, [cwdKey]: nextEntry },
          },
          { now: nowDate },
        );
        return { changed: true, committed: true, state: nextEntry };
      }

      if (
        !existing
        || (Object.keys(existing.failedRetries).length === 0 && existing.editedSinceShell.length === 0)
      ) {
        return { changed: false, ...(existing ? { state: existing } : {}) };
      }

      const nextEntry = {
        ...existing,
        failedRetries: {},
        editedSinceShell: [],
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
          delegated: existingScope?.delegated || null,
          projects: { ...existingProjects, [cwdKey]: nextEntry },
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
 * Clear cumulative per-file edit counts and failed-edit retries after a successful `git commit` inside
 * the project root, and mark `unsavedCommitted = true` until `memory_save` runs. Keeps `size: 'L'` intact.
 */
export function recordGitCommitForWorkSize({
  command,
  shell = '',
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
  if (command !== undefined) {
    if (!commandRunsGitCommit(command, { shell })) return { changed: false };
    return recordShellResultForWorkSize({
      ok: true,
      isInterrupt: false,
      command,
      shell,
      cwd,
      env,
      projectDirEnvVar,
      workspacePaths,
      globalDir,
      terminalId,
      sessionId,
      config,
      loadConfigForRoot,
      isEnabledForRoot,
      lockOptions,
      now,
    });
  }

  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return { changed: false };

  const preScope = readWorkSizeScopeState(globalDir, scope);
  const preRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState: preScope,
  });
  const preCfg = typeof loadConfigForRoot === 'function' ? loadConfigForRoot(preRoot) : config;
  const preEval = evaluateConfigForRoot(preRoot, {
    preRoot,
    preConfig: preCfg,
    loadConfigForRoot,
    isEnabledForRoot,
    fallbackConfig: config,
  });
  if (!preEval.enabled || !isSameOrSubpath(cwd, preRoot)) return { changed: false };

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
      const evalCfg = evaluateConfigForRoot(projectRoot, {
        preRoot,
        preConfig: preCfg,
        loadConfigForRoot,
        isEnabledForRoot,
        fallbackConfig: config,
      });
      if (!evalCfg.enabled || !isSameOrSubpath(cwd, projectRoot)) return { changed: false };

      const cwdKey = projectPathKey(projectRoot);
      const existingProjects = existingScope ? existingScope.projects : {};
      const base = existingProjects[cwdKey] || createFreshFolderState(projectRoot, cwdKey);
      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);
      const nextEntry = {
        ...base,
        files: {},
        failedRetries: {},
        editedSinceShell: [],
        unsavedCommitted: true,
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
          delegated: existingScope?.delegated || null,
          projects: { ...existingProjects, [cwdKey]: nextEntry },
        },
        { now: nowDate },
      );
      return { changed: true, committed: true, state: nextEntry };
    },
    lockOptions,
  );

  return lockedResult.locked ? lockedResult.value : { changed: false };
}

/**
 * Clear cumulative per-file edit counts, failed-edit retries, and unsaved-work markers after a
 * successful `memory_save`, and when the folder is in `L`, record `memorySaved = true` (completing
 * `L` -> `S` if `reviewAccepted` is also recorded).
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
      const hadClearable =
        Object.keys(existing.files).length > 0
        || Object.keys(existing.failedRetries).length > 0
        || existing.editedSinceShell.length > 0
        || existing.unsavedFiles.length > 0
        || existing.unsavedCommitted
        || existing.unsavedReminded;

      if (existing.size !== 'L') {
        if (!hadClearable) return { changed: false, completed: false, state: existing };
        const nextEntry = {
          ...existing,
          files: {},
          failedRetries: {},
          editedSinceShell: [],
          unsavedFiles: [],
          unsavedCommitted: false,
          unsavedReminded: false,
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
        failedRetries: {},
        editedSinceShell: [],
        unsavedFiles: [],
        unsavedCommitted: false,
        unsavedReminded: false,
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
 * Reset per-folder `promptTurns` (and per-turn read counters) to `0` on `SessionStart` whenever
 * `HEAD_CORE` is freshly injected (new session, `/clear`, `compact`, or `resume`/`fork` without
 * duplicate `HEAD_CORE`). Never creates a state file if none exists.
 */
export function resetWorkSizeTurnCountersOnSessionStart({
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

  try {
    const statePath = getWorkSizeStatePath(globalDir, scope);
    if (!fs.existsSync(statePath)) return { changed: false };
  } catch {
    return { changed: false };
  }

  const quickScope = readWorkSizeScopeState(globalDir, scope);
  if (!quickScope) return { changed: false };
  const quickRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState: quickScope,
  });
  const quickEntry = quickScope.projects[projectPathKey(quickRoot)];
  if (!quickEntry || (quickEntry.promptTurns === 0 && quickEntry.turnReads === 0 && !quickEntry.turnReadNotified)) {
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

      const cwdKey = projectPathKey(projectRoot);
      const existing = existingScope.projects[cwdKey];
      if (!existing || (existing.promptTurns === 0 && existing.turnReads === 0 && !existing.turnReadNotified)) {
        return { changed: false };
      }

      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);
      const nextEntry = {
        ...existing,
        promptTurns: 0,
        turnReads: 0,
        turnReadNotified: false,
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
 * Evaluate `UserPromptSubmit` for a main-conversation prompt:
 * - Consumes `completedNoticePending` once;
 * - Resets the per-turn read counter (`turnReads = 0`, `turnReadNotified = false`);
 * - Increments `promptTurns` (when `reminderEveryTurns > 0`, or when folder state already exists so
 *   `cortex-work status` reflects prompt count without writing files when reminders are off and clean);
 * - Emits `unsavedNotice` (2-1) once per unsaved span, and repeats it alongside `periodicNotice` (2-2)
 *   while unsaved work remains;
 * - Emits two-line `periodicNotice` (2-2) every `reminderEveryTurns` prompts.
 */
export function evaluateWorkSizePrompt({
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
  const empty = { completedNotice: '', unsavedNotice: '', periodicNotice: '' };
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) return empty;

  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return empty;

  const preScope = readWorkSizeScopeState(globalDir, scope);
  const preRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState: preScope,
  });
  const preCfg = typeof loadConfigForRoot === 'function' ? loadConfigForRoot(preRoot) : config;
  const preEval = evaluateConfigForRoot(preRoot, {
    preRoot,
    preConfig: preCfg,
    loadConfigForRoot,
    isEnabledForRoot,
    fallbackConfig: config,
  });
  if (!preEval.enabled) return empty;

  // When `reminderEveryTurns === 0` and no state exists for this folder yet, there is nothing to consume,
  // reset, or remind — skip creating any state file or lock!
  if (preEval.workSize.reminderEveryTurns <= 0 && !preScope?.projects?.[projectPathKey(preRoot)]) {
    return empty;
  }

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
      const evalCfg = evaluateConfigForRoot(projectRoot, {
        preRoot,
        preConfig: preCfg,
        loadConfigForRoot,
        isEnabledForRoot,
        fallbackConfig: config,
      });
      if (!evalCfg.enabled) return empty;

      const reminderEvery = evalCfg.workSize.reminderEveryTurns;
      const cwdKey = projectPathKey(projectRoot);
      const existingProjects = existingScope ? existingScope.projects : {};
      const existing = existingProjects[cwdKey] || null;
      if (reminderEvery <= 0 && !existing) {
        return empty;
      }

      const state = existing || createFreshFolderState(projectRoot, cwdKey);
      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);

      const completedNotice = state.completedNoticePending ? WORK_SIZE_COMPLETED_NOTICE : '';
      const nextPromptTurns = reminderEvery > 0 ? (state.promptTurns || 0) + 1 : 0;
      const isPeriodicTurn = reminderEvery > 0 && nextPromptTurns > 0 && nextPromptTurns % reminderEvery === 0;

      const hasUnsaved = state.unsavedFiles.length > 0 || state.unsavedCommitted;
      const shouldEmitUnsaved = hasUnsaved && (!state.unsavedReminded || isPeriodicTurn);
      const unsavedNotice = shouldEmitUnsaved
        ? formatUnsavedReminder({
            editedFileCount: state.unsavedFiles.length,
            committed: state.unsavedCommitted,
          })
        : '';

      const stateAfterConsume = {
        ...state,
        completedNoticePending: false,
        promptTurns: nextPromptTurns,
        turnReads: 0,
        turnReadNotified: false,
        unsavedReminded: hasUnsaved ? (state.unsavedReminded || shouldEmitUnsaved) : false,
        updatedAt: stamp,
      };
      const periodicNotice = isPeriodicTurn ? formatPeriodicReminder(stateAfterConsume) : '';

      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          version: WORK_SIZE_STATE_VERSION,
          scopeKind: scope.kind,
          scopeId: scope.id,
          updatedAt: stamp,
          delegated: existingScope?.delegated || null,
          projects: { ...existingProjects, [cwdKey]: stateAfterConsume },
        },
        { now: nowDate },
      );

      return {
        completedNotice,
        unsavedNotice,
        periodicNotice,
        promptTurns: nextPromptTurns,
        state: { version: WORK_SIZE_STATE_VERSION, scopeKind: scope.kind, scopeId: scope.id, ...stateAfterConsume },
      };
    },
    lockOptions,
  );

  return lockedResult.locked ? lockedResult.value : empty;
}

function queueWorkSizePendingNotice(
  globalDir,
  scope,
  projectRoot,
  noticeText,
  { lockOptions, now = new Date() } = {},
) {
  const cleanNotice = typeof noticeText === 'string' ? noticeText.trim() : '';
  if (!scope || !cleanNotice) return false;
  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      const cwdKey = projectPathKey(projectRoot);
      const existingProjects = existingScope ? existingScope.projects : {};
      const base = existingProjects[cwdKey] || createFreshFolderState(projectRoot, cwdKey);
      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);
      const nextEntry = {
        ...base,
        pendingNotices: appendUniqueNotice(base.pendingNotices, cleanNotice),
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
          delegated: existingScope?.delegated || null,
          projects: { ...existingProjects, [cwdKey]: nextEntry },
        },
        { now: nowDate, skipPruneSessions: true },
      );
      return true;
    },
    lockOptions,
  );
  return Boolean(lockedResult.locked && lockedResult.value);
}

/**
 * Consume pending non-blocking notices queued during tool calls (read-volume notice, file-dependency
 * notice, and any pending L-completion notice not yet consumed) for hosts like Antigravity whose
 * `PreToolUse` output cannot attach model-only context. Returns the notices that fit within `maxChars`
 * and clears them from disk.
 */
export function consumeWorkSizePendingNotices({
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
  maxChars = Infinity,
  includeCompleted = true,
  lockOptions,
  now = new Date(),
} = {}) {
  if (maxChars <= 0) return [];
  const scope = resolveWorkSizeScope({ terminalId, sessionId });
  if (!scope) return [];

  try {
    const statePath = getWorkSizeStatePath(globalDir, scope);
    if (!fs.existsSync(statePath)) return [];
  } catch {
    return [];
  }

  const quickScope = readWorkSizeScopeState(globalDir, scope);
  if (!quickScope) return [];
  const quickRoot = resolveWorkSizeProjectRoot({
    cwd,
    env,
    projectDirEnvVar,
    workspacePaths,
    scopeState: quickScope,
  });
  const quickEntry = quickScope.projects[projectPathKey(quickRoot)];
  if (!quickEntry) return [];
  const hasQueued = (quickEntry.pendingNotices?.length || 0) > 0
    || (includeCompleted && quickEntry.completedNoticePending);
  if (!hasQueued) return [];

  const evalCfg = evaluateConfigForRoot(quickRoot, {
    loadConfigForRoot,
    isEnabledForRoot,
    fallbackConfig: config,
  });
  if (!evalCfg.enabled) return [];

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      if (!existingScope) return [];
      const projectRoot = resolveWorkSizeProjectRoot({
        cwd,
        env,
        projectDirEnvVar,
        workspacePaths,
        scopeState: existingScope,
      });
      const cwdKey = projectPathKey(projectRoot);
      const existing = existingScope.projects[cwdKey];
      if (!existing) return [];

      const candidates = [];
      if (includeCompleted && existing.completedNoticePending) {
        candidates.push({ kind: 'completed', text: WORK_SIZE_COMPLETED_NOTICE });
      }
      for (const item of existing.pendingNotices || []) {
        candidates.push({ kind: 'pending', text: item });
      }
      if (candidates.length === 0) return [];

      const emitted = [];
      const remainingPending = [];
      let keepCompleted = Boolean(existing.completedNoticePending);
      let used = 0;

      for (const item of candidates) {
        if (used + item.text.length <= maxChars) {
          emitted.push(item.text);
          used += item.text.length;
          if (item.kind === 'completed') keepCompleted = false;
        } else if (item.kind === 'pending') {
          remainingPending.push(item.text);
        }
      }

      if (emitted.length === 0) return [];

      const nowDate = toDate(now);
      const stamp = formatIsoTimestamp(nowDate);
      const nextEntry = {
        ...existing,
        completedNoticePending: keepCompleted,
        pendingNotices: remainingPending,
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
        { now: nowDate, skipPruneSessions: true },
      );
      return emitted;
    },
    lockOptions,
  );

  return lockedResult.locked ? lockedResult.value : [];
}

// ---------------------------------------------------------------------------------------------
// Relay delegation state (2-2: tab-scoped delegated worker marker)
// ---------------------------------------------------------------------------------------------

/**
 * Return the active delegation info for `terminalId` (`{ fromTerminalId, delegatedAt, delegatedAtMs, remainingMs }`),
 * or `null` when not delegated or when the 24-hour TTL has elapsed.
 */
export function getTabDelegation(terminalId, { globalDir, now = new Date() } = {}) {
  if (!isValidTerminalId(terminalId)) return null;
  const scope = tabWorkSizeScope(terminalId);
  const scopeState = readWorkSizeScopeState(globalDir, scope);
  if (!scopeState?.delegated) return null;
  if (scopeState.delegated.fromTerminalId && scopeState.delegated.fromTerminalId === scope.id) return null;
  const nowMs = toEpochMs(now);
  if (!isDelegationActive(scopeState.delegated, nowMs)) return null;
  const elapsed = Math.max(0, nowMs - scopeState.delegated.delegatedAtMs);
  return {
    fromTerminalId: scopeState.delegated.fromTerminalId,
    delegatedAt: scopeState.delegated.delegatedAt,
    delegatedAtMs: scopeState.delegated.delegatedAtMs,
    remainingMs: Math.max(0, WORK_SIZE_DELEGATION_TTL_MS - elapsed),
  };
}

/**
 * Record that `terminalId` received a `delegate: true` relay message from `fromTerminalId`.
 * Refuses self-delegation (`fromTerminalId === terminalId`) and preserves all existing per-folder
 * `projects` state (including any pre-existing `L` state and counts).
 */
export function recordTabDelegation(
  terminalId,
  {
    fromTerminalId = '',
    globalDir,
    lockOptions,
    now = new Date(),
  } = {},
) {
  if (!isValidTerminalId(terminalId)) return { changed: false, delegated: null };
  const scope = tabWorkSizeScope(terminalId);
  const cleanFrom = typeof fromTerminalId === 'string' && isValidTerminalId(fromTerminalId.trim())
    ? fromTerminalId.trim()
    : '';
  if (cleanFrom && cleanFrom === scope.id) {
    return { changed: false, delegated: null };
  }
  const nowDate = toDate(now);
  const nowMs = nowDate.getTime();
  const stamp = formatIsoTimestamp(nowDate);
  const delegated = {
    fromTerminalId: cleanFrom,
    delegatedAt: stamp,
    delegatedAtMs: nowMs,
  };

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          version: WORK_SIZE_STATE_VERSION,
          scopeKind: scope.kind,
          scopeId: scope.id,
          updatedAt: stamp,
          delegated,
          projects: existingScope ? existingScope.projects : {},
        },
        { now: nowDate, skipPruneSessions: true },
      );
      return { changed: true, delegated };
    },
    lockOptions,
  );

  return lockedResult.locked ? lockedResult.value : { changed: false, delegated: null };
}

/**
 * Clear relay delegation on `terminalId` while preserving all per-folder `projects` state (existing `L`
 * state and cumulative edit counts stay intact and take effect again immediately).
 * When `onlyFromTerminalId` is given (e.g. `relay_send` to `to_terminal_id`), clears delegation only if
 * `delegated.fromTerminalId` matches `onlyFromTerminalId` (or was empty).
 */
export function clearTabDelegation(
  terminalId,
  {
    onlyFromTerminalId = undefined,
    globalDir,
    lockOptions,
    now = new Date(),
  } = {},
) {
  if (!isValidTerminalId(terminalId)) return { changed: false };
  const scope = tabWorkSizeScope(terminalId);
  try {
    const filePath = getWorkSizeStatePath(globalDir, scope);
    if (!fs.existsSync(filePath)) return { changed: false };
  } catch {
    return { changed: false };
  }

  const quickScope = readWorkSizeScopeState(globalDir, scope);
  if (!quickScope?.delegated) return { changed: false };
  if (
    typeof onlyFromTerminalId === 'string'
    && quickScope.delegated.fromTerminalId
    && quickScope.delegated.fromTerminalId !== onlyFromTerminalId.trim()
  ) {
    return { changed: false };
  }

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      if (!existingScope?.delegated) return { changed: false };
      if (
        typeof onlyFromTerminalId === 'string'
        && existingScope.delegated.fromTerminalId
        && existingScope.delegated.fromTerminalId !== onlyFromTerminalId.trim()
      ) {
        return { changed: false };
      }
      const nowDate = toDate(now);
      const nowMs = nowDate.getTime();
      const wasActive = isDelegationActive(existingScope.delegated, nowMs);
      const stamp = formatIsoTimestamp(nowDate);
      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          ...existingScope,
          updatedAt: stamp,
          delegated: null,
        },
        { now: nowDate, skipPruneSessions: true },
      );
      return { changed: wasActive, clearedFrom: existingScope.delegated.fromTerminalId };
    },
    lockOptions,
  );

  return lockedResult.locked ? lockedResult.value : { changed: false };
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
      releasedDelegation: false,
      releasedFolders: [],
      otherLFolders: [],
      state: null,
    };
  }

  const lockedResult = withWorkSizeScopeLock(
    globalDir,
    scope,
    () => {
      const existingScope = readWorkSizeScopeState(globalDir, scope);
      const nowDate = toDate(now);
      const nowMs = nowDate.getTime();
      const stamp = formatIsoTimestamp(nowDate);
      const hadRawDelegated = Boolean(existingScope?.delegated);
      const hadActiveDelegated = Boolean(existingScope?.delegated && isDelegationActive(existingScope.delegated, nowMs));

      if (all) {
        const entries = existingScope ? Object.values(existingScope.projects) : [];
        if (entries.length === 0 && !hadRawDelegated) {
          return {
            terminalId: scope.id,
            filePath,
            all: true,
            cwd: null,
            previousSize: 'S',
            size: 'S',
            changed: false,
            releasedDelegation: false,
            releasedFolders: [],
            otherLFolders: [],
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
            delegated: null,
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
          changed: entries.length > 0 || hadActiveDelegated,
          releasedDelegation: hadActiveDelegated,
          releasedFolders,
          otherLFolders: [],
          state: null,
        };
      }

      const targetRoot = resolveWorkSizeProjectRoot({ cwd, scopeState: existingScope });
      const targetKey = projectPathKey(targetRoot);
      const existing = existingScope?.projects?.[targetKey] || null;
      const otherLFolders = existingScope
        ? Object.values(existingScope.projects)
            .filter((entry) => entry.cwdKey !== targetKey && entry.size === 'L')
            .map((entry) => entry.cwd)
            .sort((a, b) => a.localeCompare(b))
        : [];
      if (!existing && !hadRawDelegated) {
        return {
          terminalId: scope.id,
          filePath,
          all: false,
          cwd: targetRoot,
          previousSize: 'S',
          size: 'S',
          changed: false,
          releasedDelegation: false,
          releasedFolders: [],
          otherLFolders,
          state: null,
        };
      }

      const nextProjects = existingScope ? { ...existingScope.projects } : {};
      if (existing) delete nextProjects[targetKey];
      writeWorkSizeScopeState(
        globalDir,
        scope,
        {
          ...(existingScope || { version: WORK_SIZE_STATE_VERSION, scopeKind: scope.kind, scopeId: scope.id }),
          updatedAt: stamp,
          delegated: null,
          projects: nextProjects,
        },
        { now: nowDate },
      );

      return {
        terminalId: scope.id,
        filePath,
        all: false,
        cwd: existing ? existing.cwd : targetRoot,
        previousSize: existing ? existing.size : 'S',
        size: 'S',
        changed: Boolean(existing) || hadActiveDelegated,
        releasedDelegation: hadActiveDelegated,
        releasedFolders: existing ? [existing.cwd] : [],
        otherLFolders,
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
 * User CLI operation: keep current size (`S` or `L`) and completion records, clearing cumulative
 * per-file counts and per-file failed-retry counts. Defaults to the current shell folder (or recorded
 * containing folder); `--all` resets every recorded folder in the tab.
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
      clearedFailures: 0,
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
        let clearedFailures = 0;
        const resetFolders = [];
        const nextProjects = {};
        let hasL = false;

        for (const entry of entries) {
          if (entry.size === 'L') hasL = true;
          const fileCount = Object.keys(entry.files).length;
          const failCount = Object.keys(entry.failedRetries).length;
          const hasPendingShellEdits = entry.editedSinceShell.length > 0;
          if (fileCount > 0 || failCount > 0 || hasPendingShellEdits) {
            clearedFiles += fileCount;
            clearedFailures += failCount;
            resetFolders.push(entry.cwd);
            nextProjects[entry.cwdKey] = {
              ...entry,
              files: {},
              failedRetries: {},
              editedSinceShell: [],
              updatedAt: stamp,
            };
          } else {
            nextProjects[entry.cwdKey] = entry;
          }
        }

        if (resetFolders.length === 0) {
          return {
            terminalId: scope.id,
            filePath,
            all: true,
            cwd: null,
            size: hasL ? 'L' : 'S',
            clearedFiles: 0,
            clearedFailures: 0,
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
          clearedFailures,
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
          clearedFailures: 0,
          resetFolders: [],
          changed: false,
          state: null,
        };
      }

      const clearedFiles = Object.keys(existing.files).length;
      const clearedFailures = Object.keys(existing.failedRetries).length;
      if (clearedFiles === 0 && clearedFailures === 0 && existing.editedSinceShell.length === 0) {
        return {
          terminalId: scope.id,
          filePath,
          all: false,
          cwd: existing.cwd,
          size: existing.size,
          clearedFiles: 0,
          clearedFailures: 0,
          resetFolders: [],
          changed: false,
          state: existing,
        };
      }

      const nextEntry = {
        ...existing,
        files: {},
        failedRetries: {},
        editedSinceShell: [],
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
        clearedFailures,
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

export function listTabWorkSizeStates(globalDir, { now = new Date() } = {}) {
  const dir = getWorkSizeDir(globalDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nowMs = toEpochMs(now);
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.startsWith('tab-') || !ent.name.endsWith('.json')) continue;
    const tid = ent.name.slice(4, -5);
    if (!isValidTerminalId(tid)) continue;
    const scopeState = readWorkSizeScopeState(globalDir, { kind: 'tab', id: tid, fileName: ent.name });
    if (!scopeState) continue;
    const hasActiveDelegation = Boolean(scopeState.delegated && isDelegationActive(scopeState.delegated, nowMs));
    if (Object.keys(scopeState.projects).length > 0 || hasActiveDelegation) {
      out.push({
        ...scopeState,
        delegated: hasActiveDelegation ? scopeState.delegated : null,
      });
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

// Rubric choice list separators (`ACCEPT | NEEDS_FIX`, `ACCEPT / NEEDS_FIX`, `ACCEPT or NEEDS_FIX`, `ACCEPT 또는 NEEDS_FIX`).
// Comma `,` is NOT treated as a rubric separator so `Verdict: NEEDS_FIX, ACCEPT after fix` reads `NEEDS_FIX`.
const RUBRIC_ALTERNATIVE_RE = /^\s*(?:\||\/|\bor\b|또는|혹은)\s*(?:\*\*|__|`)*\s*(?:ACCEPT|NEEDS_FIX)(?![A-Za-z0-9_])/iu;

// Affirmative Korean declarative copula endings glued directly to the verdict (`판정: NEEDS_FIX입니다`, `ACCEPT임`, `ACCEPT다`).
const AFFIRMATIVE_KOREAN_COPULA_RE = /^(?:입니다|임|이다|다|예요|이에요)(?=$|[\s.,!?;:()（）[\]—–\-/])/u;

// Negation words directly following the verdict (`판정: ACCEPT 불가`, `ACCEPT 하지 않음`, `ACCEPT 할 수 없습니다`, `ACCEPT 어렵다`, `ACCEPT 아님`).
const TRAILING_NEGATION_RE =
  /^\s*(?:불가\S*|불충분\S*|하지\s*않\S*|할\s*수\s*없\S*|(?:하기\s*)?어렵\S*|어려움|아님|아닙니다|아니(?:다|며|라|고|므로)?(?=$|[\s.,!?;:()（）[\]—–\-/])|안\s*(?:됨|됩니다|된다|함|합니다|한다)(?=$|[\s.,!?;:()（）[\]—–\-/])|못\s*(?:함|합니다|한다|됨|됩니다)(?=$|[\s.,!?;:()（）[\]—–\-/])|(?:보류|거부|거절)(?:합니다|함|됨|다)?(?=$|[\s.,!?;:()（）[\]—–\-/])|\bis\s+not\b|\bcannot\b|\bcan\s+not\b|\bcan't\b|\bnot\b)/iu;

function extractSingleVerdictToken(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  // Strip leading list marker and markdown emphasis/code wrappers (`**`, `__`, `` ` ``).
  // Leading negations (`not ACCEPT`) do not start with a verdict token and return `null`.
  const withoutBullet = trimmed.replace(/^(?:[-*+]\s+)/, '');
  const wrapperMatch = /^(?:\*\*|__|`)+/.exec(withoutBullet);
  const unwrapped = withoutBullet.slice(wrapperMatch ? wrapperMatch[0].length : 0).trimStart();

  // Reject ASCII word continuations (`ACCEPTED`, `ACCEPTABLE`, `ACCEPT_LATER`)
  const match = /^(ACCEPT|NEEDS_FIX)(?![A-Za-z0-9_])/.exec(unwrapped);
  if (!match) return null;

  const verdict = match[1];
  let rest = unwrapped.slice(verdict.length);

  if (wrapperMatch) {
    const closingMatch = /^(?:\*\*|__|`)+/.exec(rest);
    if (closingMatch) {
      rest = rest.slice(closingMatch[0].length);
    }
  }

  // When a Unicode letter/digit is glued immediately after the verdict (or its closing wrapper),
  // accept affirmative Korean declarative copula endings (`입니다`, `임`, `이다`, `다`, `예요`, `이에요`)
  // and reject glued negations (`ACCEPT하지 않음`) or non-final particles (`NEEDS_FIX이나 ...`).
  if (/^[\p{L}\p{N}_]/u.test(rest)) {
    const copulaMatch = AFFIRMATIVE_KOREAN_COPULA_RE.exec(rest);
    if (!copulaMatch) return null;
    rest = rest.slice(copulaMatch[0].length);
  }

  rest = rest.replace(/^(?:\*\*|__|`)+/, '');

  if (TRAILING_NEGATION_RE.test(rest)) return null;
  if (/^\s*[(（]\s*(?:불가\S*|불충분\S*|아님|아닙니다|아니다|안\s*됨|안됨|안\s*함|안함|못\s*함|못함|보류|거부|거절|하지\s*않\S*|할\s*수\s*없\S*|(?:하기\s*)?어렵\S*|어려움)\s*[)）]/u.test(rest)) return null;

  // Strip optional short parenthetical tag that does not mention a verdict (`(Clean Evaluation)`, `（조건부）`)
  // and closing markdown wrappers, then reject rubric choice lists (`ACCEPT | NEEDS_FIX`, `ACCEPT 또는 NEEDS_FIX`)
  // while keeping commentary that mentions the other verdict (`NEEDS_FIX (ACCEPT 불가)`, `NEEDS_FIX, ACCEPT after fix`).
  const tagMatch = /^\s*(?:\([^()\r\n]*\)|（[^（）\r\n]*）)/.exec(rest);
  if (tagMatch && !/(?:^|[^A-Za-z0-9_])(?:ACCEPT|NEEDS_FIX)(?![A-Za-z0-9_])/.test(tagMatch[0])) {
    rest = rest.slice(tagMatch[0].length);
  }
  rest = rest.replace(/^\s*(?:\*\*|__|`)+/, '');
  if (RUBRIC_ALTERNATIVE_RE.test(rest)) return null;

  return verdict;
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

function inspectGitCommitArgs(args, baseCwd) {
  let idx = 0;
  let effectiveDir = baseCwd;
  let invalidDirOption = false;

  // Walk global git options before the subcommand
  let subcommand = '';
  while (idx < args.length) {
    const arg = args[idx].text;
    if (arg === '--') return { isCommit: false, targetDir: '' };
    if (arg === '-h' || arg === '--help' || arg === '--version') return { isCommit: false, targetDir: '' };
    if (arg === '-C') {
      if (idx + 1 >= args.length || !args[idx + 1].text.trim() || args[idx + 1].text.includes('\0')) {
        return { isCommit: false, targetDir: '' };
      }
      if (effectiveDir) {
        effectiveDir = path.resolve(effectiveDir, args[idx + 1].text.trim());
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
  while (idx < args.length) {
    const token = args[idx];
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

const MAX_COMMIT_SUBSTITUTION_DEPTH = 4;

function commandRunsGitCommitInShell(
  command,
  { baseCwd, rootDir, hasProjectBound, shellKind, depth = 0 },
) {
  if (depth > MAX_COMMIT_SUBSTITUTION_DEPTH || typeof command !== 'string' || !command.trim()) {
    return false;
  }
  for (const words of tokenizeShellSegments(command, { shell: shellKind })) {
    for (let i = 0; i < words.length; i++) {
      if (!isCandidateCommandWord(words, i)) continue;
      const bin = executableBaseName(words[i].text);
      if (bin !== 'git' && bin !== 'git.exe') continue;
      const info = inspectGitCommitArgs(words.slice(i + 1), baseCwd);
      if (info.isCommit && (!hasProjectBound || isSameOrSubpath(info.targetDir, rootDir))) {
        return true;
      }
    }
    for (const nested of extractNestedShellCommands(words, shellKind)) {
      if (
        commandRunsGitCommitInShell(nested.command, {
          baseCwd,
          rootDir,
          hasProjectBound,
          shellKind: nested.shell,
          depth: depth + 1,
        })
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when `command` executes a real `git commit` (including inside `$(...)`, backtick command
 * substitutions, and nested shells, while excluding `--dry-run`, `--allow-empty`, `--short`,
 * `--porcelain`, `--long`, `--help`, and quoted strings). When `projectRoot` is given, also verifies
 * that the commit's target folder (`git -C <dir>` if present, otherwise `cwd`) lies inside `projectRoot`.
 */
export function commandRunsGitCommit(command, { cwd, projectRoot, shell = '' } = {}) {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (!/\bcommit\b/i.test(command) && !/['"\\`^]/.test(command)) return false;

  const hasProjectBound = typeof projectRoot === 'string' && projectRoot.trim().length > 0;
  const baseCwd = hasProjectBound
    ? path.resolve(typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd())
    : '';
  const rootDir = hasProjectBound ? resolveProjectRoot(path.resolve(projectRoot.trim())) : '';

  const shellKind = normalizeShellKind(shell);
  const primaryShell = !shellKind && /[A-Za-z]:\\/.test(command) ? 'powershell' : shellKind;
  if (
    commandRunsGitCommitInShell(command, {
      baseCwd,
      rootDir,
      hasProjectBound,
      shellKind: primaryShell,
      depth: 0,
    })
  ) {
    return true;
  }
  if (!shellKind && primaryShell !== 'powershell' && /[`\u2018\u2019\u201a\u201b\u201c\u201d\u201e]/.test(command)) {
    return commandRunsGitCommitInShell(command, {
      baseCwd,
      rootDir,
      hasProjectBound,
      shellKind: 'powershell',
      depth: 0,
    });
  }
  return false;
}
