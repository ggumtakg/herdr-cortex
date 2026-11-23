import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assertInsideDir,
  atomicWriteJson,
  getProjectMemoryDir,
  getTierPaths,
  isProjectEnabled,
  isProjectTrusted,
  loadConfig,
  resolveProjectRoot,
} from '../core/config.mjs';
import { UNTRUSTED_MEMORY_PREAMBLE, sanitizeInline } from '../core/budget.mjs';
import { resolveCortexGlobalDir, validateTerminalId } from '../revive/tracker.mjs';

/**
 * Relay inbox: messages waiting for a terminal are files in the user's global store,
 *
 *   <globalDir>/state/inbox/<terminalId>/
 *     <15-digit epoch ms>-<8 hex>.json   one pending message (see `enqueueMessage` for the fields)
 *     .lock                              held by the one consumer that is delivering or acknowledging right now
 *     .lock.recover                      exists only while a stale `.lock` is being replaced
 *     .broken/                           files that were not valid message JSON
 *
 * never inside a project folder, so a cloned repository cannot ship "messages from another tab".
 * Versions before this layout kept them in `<project>/.memory/state/inbox/<terminalId>/`; what is still there
 * is moved over once (`projectDir` option of `drainInbox` / `peekInbox` / `ackMessage`), and only for a project
 * the user approved and did not exclude.
 */

const TAKING_DIR_RE = /^\.taking-(\d+)-([a-zA-Z0-9_-]+)$/;
const SAFE_MSG_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export const INBOX_LOCK_FILE = '.lock';
const LOCK_RECOVERY_FILE = '.lock.recover';
const BROKEN_DIR = '.broken';

// A lock file whose content cannot be read yet belongs to a consumer that is just writing it; after this
// long it is treated as left behind by a process that died between creating and writing it.
const LOCK_UNREADABLE_GRACE_MS = 2000;
// A `.lock.recover` file lives for a few file operations; an older one was left behind by a crash.
const LOCK_RECOVERY_STALE_MS = 10_000;
const LOCK_RETRY_INTERVAL_MS = 20;

/** A lock (or an old claim directory) older than this is taken over even if its process id is still in use. */
export const DEFAULT_INBOX_STALE_MS = 600_000;

/** Longest beginning of an over-long message that the hooks show when they announce it. */
export const INBOX_PREVIEW_MAX_CHARS = 600;

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function renameSyncWithRetry(srcPath, dstPath, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      fs.renameSync(srcPath, dstPath);
      return;
    } catch (err) {
      const retryable = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!retryable || attempt === maxRetries) {
        throw err;
      }
      sleepSync(15 * (attempt + 1));
    }
  }
}

export function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * `<globalDir>/state/inbox`: the folder that holds one inbox directory per terminal.
 */
export function getInboxRootDir(globalDir) {
  return getTierPaths(resolveCortexGlobalDir(globalDir)).inboxDir;
}

/**
 * `<globalDir>/state/inbox/<terminalId>` (not created by this call).
 */
export function getTerminalInboxDir(terminalId, { globalDir } = {}) {
  const cleanId = validateTerminalId(terminalId);
  return assertInsideDir(getInboxRootDir(globalDir), cleanId);
}

/**
 * Where a project kept a terminal's inbox before the inbox moved to the global store:
 * `<project>/.memory/state/inbox/<terminalId>`. Only a path; nothing is read.
 */
export function getLegacyProjectInboxDir(projectDir, terminalId) {
  const cleanId = validateTerminalId(terminalId);
  const { inboxDir } = getTierPaths(getProjectMemoryDir(resolveProjectRoot(projectDir)));
  return path.join(inboxDir, cleanId);
}

// Names of the pending message files of a directory, oldest first. They come from readdir and are regular
// files (a link is not a file here), so joining one to `dirPath` cannot lead out of the directory.
function listPendingJsonFiles(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((ent) => ent.isFile() && ent.name.endsWith('.json') && !ent.name.startsWith('.'))
    .map((ent) => ent.name)
    .sort();
}

// Move a file into `destDir` under `preferredName` (or a unique variant of it). Works across volumes:
// a project and the global store may be on different drives, where a rename is refused (EXDEV).
function moveFileUnique(srcPath, destDir, preferredName) {
  fs.mkdirSync(destDir, { recursive: true });
  let candidate = assertInsideDir(destDir, preferredName);
  if (fs.existsSync(candidate)) {
    const ext = path.extname(preferredName);
    const stem = preferredName.slice(0, preferredName.length - ext.length);
    const suffix = crypto.randomBytes(3).toString('hex');
    candidate = assertInsideDir(destDir, `${stem}-${suffix}${ext}`);
  }
  try {
    renameSyncWithRetry(srcPath, candidate);
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
    const tmpPath = path.join(
      destDir,
      `.${path.basename(candidate)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
    );
    try {
      fs.copyFileSync(srcPath, tmpPath, fs.constants.COPYFILE_EXCL);
      renameSyncWithRetry(tmpPath, candidate);
    } catch (copyErr) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // nothing to clean up
      }
      throw copyErr;
    }
    fs.unlinkSync(srcPath);
  }
  return candidate;
}

function parseInboxText(rawText, fileName) {
  const parsed = JSON.parse(String(rawText).replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Inbox payload must be a JSON object');
  }
  if (typeof parsed.message !== 'string') {
    throw new Error('Inbox payload missing string "message" field');
  }
  const fallbackId = fileName.replace(/\.json$/, '');
  const announcedAt = typeof parsed.announced_at === 'string' ? parsed.announced_at.trim() : '';
  const record = {
    id: typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : fallbackId,
    from_terminal_id: typeof parsed.from_terminal_id === 'string' ? parsed.from_terminal_id : '',
    to_terminal_id: typeof parsed.to_terminal_id === 'string' ? parsed.to_terminal_id : '',
    message: parsed.message,
    context_docs: Array.isArray(parsed.context_docs)
      ? parsed.context_docs.map((d) => String(d).trim()).filter(Boolean)
      : [],
    created_at: typeof parsed.created_at === 'string' ? parsed.created_at : '',
    // True once a hook has announced this message instead of injecting it (it was too long for the hook
    // budget). An announced message is never injected again; it waits for relay_inbox(peek) + ack.
    announced: Boolean(announcedAt),
    ...(announcedAt ? { announced_at: announcedAt } : {}),
    ...(parsed.meta && typeof parsed.meta === 'object' ? { meta: parsed.meta } : {}),
  };
  return { record, raw: parsed };
}

/**
 * Atomically enqueue a relay message into `<globalDir>/state/inbox/<terminalId>/`.
 * Stored fields: id, from_terminal_id, to_terminal_id, message, context_docs, created_at, optional meta;
 * `announced_at` is added later by a hook that announced the message instead of injecting it.
 */
export function enqueueMessage(terminalId, msg = {}, { globalDir } = {}) {
  const cleanTerminalId = validateTerminalId(terminalId);
  const targetDir = getTerminalInboxDir(cleanTerminalId, { globalDir });
  fs.mkdirSync(targetDir, { recursive: true });

  const nowMs = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  const fileStem = `${String(nowMs).padStart(15, '0')}-${rand}`;
  const id = typeof msg.id === 'string' && SAFE_MSG_ID_RE.test(msg.id.trim())
    ? msg.id.trim()
    : fileStem;

  const record = {
    id,
    from_terminal_id: typeof msg.from_terminal_id === 'string'
      ? msg.from_terminal_id.trim()
      : (process.env.HC_TERMINAL_ID || '').trim(),
    to_terminal_id: cleanTerminalId,
    message: String(msg.message ?? ''),
    context_docs: Array.isArray(msg.context_docs)
      ? [...new Set(msg.context_docs.map((d) => String(d).trim()).filter(Boolean))]
      : [],
    created_at: typeof msg.created_at === 'string' && msg.created_at.trim()
      ? msg.created_at.trim()
      : new Date(nowMs).toISOString(),
    ...(msg.meta && typeof msg.meta === 'object' ? { meta: msg.meta } : {}),
  };

  const fileName = `${fileStem}.json`;
  const filePath = assertInsideDir(targetDir, fileName);
  atomicWriteJson(filePath, record);

  return {
    id: record.id,
    fileName,
    filePath,
    message: record,
  };
}

/**
 * Number of messages waiting for a terminal. Looks at file names only: no lock, no migration, no parsing.
 */
export function countPendingMessages(terminalId, { globalDir } = {}) {
  return listPendingJsonFiles(getTerminalInboxDir(terminalId, { globalDir })).length;
}

// ---------------------------------------------------------------------------------------------
// Per-terminal lock
// ---------------------------------------------------------------------------------------------

// Create `filePath` only if it does not exist (exclusive create) and write `info` into it.
// Returns 'created', 'exists', or 'unavailable' (the name cannot be created at this moment, e.g. a lock
// that was just deleted while another process still had it open on Windows).
function createExclusive(filePath, info) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return 'exists';
    if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) return 'unavailable';
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify(info));
  } finally {
    fs.closeSync(fd);
  }
  return 'created';
}

function readLockInfo(lockPath) {
  let stat;
  let text;
  try {
    stat = fs.statSync(lockPath);
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false };
    // It is there but cannot be read right now: held, as far as this caller can tell.
    return { exists: true, readable: false, mtimeMs: stat ? stat.mtimeMs : Date.now(), identity: 'unreadable' };
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
  if (!info.readable) return nowMs - info.mtimeMs > LOCK_UNREADABLE_GRACE_MS;
  if (!isPidAlive(info.pid)) return true;
  return nowMs - info.acquiredAt > staleMs;
}

// True when the file is gone afterwards.
function removeQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'ENOENT');
  }
}

/**
 * Try once to become the only consumer of a terminal's inbox. Never waits.
 * The lock is the file `.lock`, created with exclusive-create semantics and holding { pid, acquiredAt, token }.
 * A lock whose process is gone, or that is older than `staleMs`, is replaced; replacing is itself serialized
 * through `.lock.recover` (also exclusive-create), so two consumers that find the same stale lock cannot both
 * end up holding a fresh one.
 * Returns { release() } or null when another consumer holds the lock.
 */
function tryAcquireInboxLock(targetDir, { staleMs, isPidAlive, nowMs }) {
  const lockPath = path.join(targetDir, INBOX_LOCK_FILE);
  const mine = { pid: process.pid, acquiredAt: Date.now(), token: crypto.randomBytes(8).toString('hex') };

  let released = false;
  const handle = {
    release() {
      if (released) return;
      released = true;
      // Only remove the lock if it is still ours (it may have been replaced as stale while we were slow).
      const current = readLockInfo(lockPath);
      if (current.exists && current.token === mine.token) removeQuietly(lockPath);
    },
  };

  const first = createExclusive(lockPath, mine);
  if (first === 'created') return handle;
  if (first !== 'exists') return null;

  const seen = readLockInfo(lockPath);
  if (!seen.exists) {
    // Released between the two calls: one more attempt, then give up for now.
    return createExclusive(lockPath, mine) === 'created' ? handle : null;
  }
  if (!isLockStale(seen, { staleMs, isPidAlive, nowMs })) return null;

  const recoverPath = path.join(targetDir, LOCK_RECOVERY_FILE);
  const recoverInfo = { pid: process.pid, acquiredAt: Date.now(), token: mine.token };
  let recovery = createExclusive(recoverPath, recoverInfo);
  if (recovery === 'exists') {
    const leftover = readLockInfo(recoverPath);
    const abandoned = leftover.exists
      && nowMs - leftover.mtimeMs > LOCK_RECOVERY_STALE_MS
      && !(leftover.readable && isPidAlive(leftover.pid) && nowMs - leftover.acquiredAt <= staleMs);
    if (!abandoned || !removeQuietly(recoverPath)) return null;
    recovery = createExclusive(recoverPath, recoverInfo);
  }
  if (recovery !== 'created') return null;

  try {
    const again = readLockInfo(lockPath);
    if (again.exists) {
      // Somebody replaced it in the meantime: it is theirs.
      if (again.identity !== seen.identity || !isLockStale(again, { staleMs, isPidAlive, nowMs })) return null;
      if (!removeQuietly(lockPath)) return null;
    }
    return createExclusive(lockPath, mine) === 'created' ? handle : null;
  } finally {
    removeQuietly(recoverPath);
  }
}

// `waitMs` > 0 retries for at most that long (explicit tool calls); hooks pass 0 and never wait.
function acquireInboxLock(targetDir, { staleMs, isPidAlive, nowMs, waitMs = 0 }) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    const lock = tryAcquireInboxLock(targetDir, { staleMs, isPidAlive, nowMs });
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    sleepSync(LOCK_RETRY_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// One-time move of a project's old inbox
// ---------------------------------------------------------------------------------------------

/**
 * Recover stale .taking-<pid>-<rand> directories (the claim directories of the previous inbox layout) whose
 * owner PID is dead or whose age exceeds staleMs: their files go back into `targetDir`.
 */
function recoverStaleTakingDirs(targetDir, { staleMs, isPidAlive, nowMs }) {
  const notices = [];
  let entries;
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return notices;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const match = TAKING_DIR_RE.exec(ent.name);
    if (!match) continue;

    const ownerPid = Number(match[1]);
    const takingDir = assertInsideDir(targetDir, ent.name);

    let stat;
    try {
      stat = fs.statSync(takingDir);
    } catch {
      continue;
    }

    const pidDead = !isPidAlive(ownerPid);
    const expired = nowMs - stat.mtimeMs > staleMs;
    if (!pidDead && !expired) continue;

    let innerFiles = [];
    try {
      innerFiles = fs.readdirSync(takingDir, { withFileTypes: true });
    } catch {
      continue;
    }

    let recoveredFiles = 0;
    for (const inner of innerFiles) {
      if (!inner.isFile()) continue;
      const src = assertInsideDir(takingDir, inner.name);
      try {
        moveFileUnique(src, targetDir, inner.name);
        recoveredFiles++;
      } catch {
        // leave the file where it is
      }
    }

    try {
      fs.rmSync(takingDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }

    notices.push(
      `Recovered ${recoveredFiles} message(s) from stale claim dir ${ent.name} (${pidDead ? `dead pid ${ownerPid}` : `older than ${staleMs}ms`}).`,
    );
  }

  return notices;
}

function listDirEntries(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
}

// Is there anything in the old directory that a migration would move or remove?
function legacyInboxHasWork(legacyDir) {
  const entries = listDirEntries(legacyDir);
  if (!entries) return false;
  if (entries.length === 0) return true; // an empty leftover directory: remove it
  if (listPendingJsonFiles(legacyDir).length > 0) return true;
  if (entries.some((ent) => ent.isDirectory() && TAKING_DIR_RE.test(ent.name))) return true;
  const broken = listDirEntries(path.join(legacyDir, BROKEN_DIR));
  return Boolean(broken) && (broken.length === 0 || broken.some((ent) => ent.isFile()));
}

/**
 * The project's old inbox directory for this terminal when there is something to move out of it, else ''.
 * A project the user has not approved, or that the configuration excludes, always yields '': its folder is
 * not looked at. The directory must really lie inside the project (not behind a link that leads elsewhere).
 */
function findLegacyInboxDir(projectDir, cleanTerminalId, { globalDir } = {}) {
  if (typeof projectDir !== 'string' || !projectDir.trim()) return '';
  try {
    const root = resolveProjectRoot(projectDir.trim());
    const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
    if (!isProjectTrusted(root, { globalDir: effectiveGlobalDir })) return '';
    if (!isProjectEnabled(root, loadConfig({ projectDir: root, globalDir: effectiveGlobalDir }))) return '';

    const legacyDir = getLegacyProjectInboxDir(root, cleanTerminalId);
    if (!fs.statSync(legacyDir).isDirectory()) return '';
    assertInsideDir(root, legacyDir);
    return legacyInboxHasWork(legacyDir) ? legacyDir : '';
  } catch {
    return '';
  }
}

// Call only while holding the lock of `targetDir`.
function migrateLegacyInbox(legacyDir, targetDir, { staleMs, isPidAlive, nowMs }) {
  const notices = recoverStaleTakingDirs(legacyDir, { staleMs, isPidAlive, nowMs });

  let moved = 0;
  for (const fileName of listPendingJsonFiles(legacyDir)) {
    try {
      moveFileUnique(path.join(legacyDir, fileName), targetDir, fileName);
      moved++;
    } catch {
      // stays in the old place; the next drain tries again
    }
  }

  // Quarantined files travel along so the old directory can go away.
  const legacyBroken = path.join(legacyDir, BROKEN_DIR);
  for (const ent of listDirEntries(legacyBroken) || []) {
    if (!ent.isFile()) continue;
    try {
      moveFileUnique(path.join(legacyBroken, ent.name), path.join(targetDir, BROKEN_DIR), ent.name);
    } catch {
      // leave it
    }
  }

  // Remove what is now empty: .broken, the terminal's old directory, then the old `inbox` directory itself.
  for (const dir of [legacyBroken, legacyDir, path.dirname(legacyDir)]) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // missing or not empty (a live claim directory, other terminals' messages): keep
    }
  }

  if (moved > 0) {
    notices.push(`Moved ${moved} message(s) from the project's old inbox into the global inbox.`);
  }
  return notices;
}

// ---------------------------------------------------------------------------------------------
// Drain / peek / ack
// ---------------------------------------------------------------------------------------------

function emptyDrain(extra = {}) {
  return {
    messages: [],
    notices: [],
    busy: false,
    markAnnounced() {
      return 0;
    },
    ack() {
      return { acked: 0, kept: 0 };
    },
    release() {},
    ...extra,
  };
}

// Read the pending files of a locked inbox. Files that are not valid message JSON go to .broken/;
// a file that merely cannot be read right now is left alone and tried again on the next drain.
function readPendingEntries(targetDir, notices) {
  const entries = [];
  for (const fileName of listPendingJsonFiles(targetDir)) {
    const filePath = path.join(targetDir, fileName);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        notices.push(
          `Inbox file ${fileName} could not be read now (${err?.code || err?.message || 'error'}); it stays in the inbox.`,
        );
      }
      continue;
    }
    try {
      const { record, raw } = parseInboxText(text, fileName);
      entries.push({ fileName, filePath, record, raw });
    } catch (err) {
      try {
        moveFileUnique(filePath, assertInsideDir(targetDir, BROKEN_DIR), fileName);
      } catch {
        // ignore quarantine error
      }
      notices.push(`Quarantined corrupt inbox file ${fileName} into ${BROKEN_DIR}/: ${err.message}`);
    }
  }
  return entries;
}

/**
 * Take a terminal's pending messages for delivery. Only one consumer at a time:
 *  1) Takes the terminal's lock without waiting (`lockWaitMs` lets an explicit tool call retry briefly).
 *     When another consumer holds it the result is `{ busy: true, messages: [] }`: nothing is delivered
 *     now and every message stays for the next attempt.
 *  2) With `projectDir`: moves what an approved, enabled project still has in its old inbox location.
 *  3) Reads the pending files in place (oldest first) and quarantines corrupt JSON into .broken/.
 *  4) Returns { messages, notices, busy, markAnnounced(ids), ack(onlyIds), release() }, still holding the lock.
 *     `markAnnounced(ids)` records `announced_at` on those messages (they stay in the inbox),
 *     `ack(onlyIds)` deletes the messages with those ids (all of them when called without argument) and
 *     releases the lock; messages that were not acknowledged stay. `release()` only releases the lock.
 *     With no pending message the lock is already released when this returns.
 * Message files are never renamed to claim them, so a consumer that dies while holding the lock leaves every
 * message in place; its lock is replaced once its process is gone or the lock is older than `staleMs`.
 * Messages already announced are included (`announced: true`); hooks skip them, `ack()` removes them.
 */
export function drainInbox(
  terminalId,
  {
    globalDir,
    projectDir,
    staleMs = DEFAULT_INBOX_STALE_MS,
    isPidAlive = defaultIsPidAlive,
    nowMs = Date.now(),
    lockWaitMs = 0,
  } = {},
) {
  const cleanId = validateTerminalId(terminalId);
  const targetDir = getTerminalInboxDir(cleanId, { globalDir });
  const legacyDir = findLegacyInboxDir(projectDir, cleanId, { globalDir });

  // Nothing waiting: no lock, and no directory is created.
  if (!legacyDir && listPendingJsonFiles(targetDir).length === 0) {
    return emptyDrain();
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const lock = acquireInboxLock(targetDir, { staleMs, isPidAlive, nowMs, waitMs: lockWaitMs });
  if (!lock) {
    return emptyDrain({ busy: true });
  }

  const notices = [];
  let entries;
  try {
    if (legacyDir) {
      notices.push(...migrateLegacyInbox(legacyDir, targetDir, { staleMs, isPidAlive, nowMs }));
    }
    entries = readPendingEntries(targetDir, notices);
  } catch (err) {
    lock.release();
    throw err;
  }

  if (entries.length === 0) {
    lock.release();
    return emptyDrain({ notices });
  }

  let finished = false;

  const markAnnounced = (ids, announcedAt = new Date().toISOString()) => {
    if (finished || !Array.isArray(ids) || ids.length === 0) return 0;
    const idSet = new Set(ids.map((id) => String(id)));
    let marked = 0;
    for (const entry of entries) {
      if (!idSet.has(entry.record.id) || entry.record.announced) continue;
      try {
        atomicWriteJson(entry.filePath, { ...entry.raw, announced_at: announcedAt });
        entry.record.announced = true;
        entry.record.announced_at = announcedAt;
        marked++;
      } catch {
        // could not be recorded: the message will be announced again next time
      }
    }
    return marked;
  };

  const ack = (onlyIds) => {
    if (finished) return { acked: 0, kept: 0, alreadyAcked: true };
    finished = true;
    const idSet = Array.isArray(onlyIds) ? new Set(onlyIds.map((id) => String(id))) : null;
    let acked = 0;
    let kept = 0;
    try {
      for (const entry of entries) {
        if (idSet && !idSet.has(entry.record.id)) {
          kept++;
          continue;
        }
        try {
          fs.unlinkSync(entry.filePath);
          acked++;
        } catch (err) {
          if (!err || err.code !== 'ENOENT') kept++;
        }
      }
    } finally {
      lock.release();
    }
    return { acked, kept };
  };

  const release = () => {
    if (finished) return;
    finished = true;
    lock.release();
  };

  return {
    messages: entries.map((e) => e.record),
    notices,
    busy: false,
    markAnnounced,
    ack,
    release,
  };
}

/**
 * Non-destructively list a terminal's pending messages with their full bodies; each has `announced`
 * (true once a hook announced it instead of injecting it) and, then, `announced_at`.
 * With `projectDir` it also moves what an approved, enabled project still has in its old inbox location
 * (skipped when another consumer holds the lock at that moment).
 */
export function peekInbox(
  terminalId,
  {
    globalDir,
    projectDir,
    staleMs = DEFAULT_INBOX_STALE_MS,
    isPidAlive = defaultIsPidAlive,
    nowMs = Date.now(),
  } = {},
) {
  const cleanId = validateTerminalId(terminalId);
  const targetDir = getTerminalInboxDir(cleanId, { globalDir });
  const notices = [];

  const legacyDir = findLegacyInboxDir(projectDir, cleanId, { globalDir });
  if (legacyDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    const lock = acquireInboxLock(targetDir, { staleMs, isPidAlive, nowMs });
    if (lock) {
      try {
        notices.push(...migrateLegacyInbox(legacyDir, targetDir, { staleMs, isPidAlive, nowMs }));
      } finally {
        lock.release();
      }
    }
  }

  const messages = [];
  for (const fileName of listPendingJsonFiles(targetDir)) {
    const filePath = path.join(targetDir, fileName);
    try {
      messages.push(parseInboxText(fs.readFileSync(filePath, 'utf8'), fileName).record);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue; // acknowledged while we were listing
      notices.push(`Unreadable inbox file ${fileName}: ${err.message}`);
    }
  }

  return {
    terminalId: cleanId,
    messages,
    count: messages.length,
    notices,
  };
}

/**
 * Acknowledge and delete one pending message by messageId (or file stem), under the terminal's lock.
 * Returns { acked, terminalId, messageId, fileName? }; with `busy: true` another consumer holds the lock
 * and nothing was changed (call again).
 */
export function ackMessage(
  terminalId,
  messageId,
  {
    globalDir,
    projectDir,
    staleMs = DEFAULT_INBOX_STALE_MS,
    isPidAlive = defaultIsPidAlive,
    nowMs = Date.now(),
    lockWaitMs = 0,
  } = {},
) {
  const cleanTerminalId = validateTerminalId(terminalId);
  const cleanMsgId = typeof messageId === 'string' ? messageId.trim() : '';
  if (!cleanMsgId || !SAFE_MSG_ID_RE.test(cleanMsgId)) {
    throw new Error(`Invalid messageId "${String(messageId)}"`);
  }

  const targetDir = getTerminalInboxDir(cleanTerminalId, { globalDir });
  const legacyDir = findLegacyInboxDir(projectDir, cleanTerminalId, { globalDir });
  const notFound = { acked: false, terminalId: cleanTerminalId, messageId: cleanMsgId };
  if (!legacyDir && listPendingJsonFiles(targetDir).length === 0) {
    return notFound;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const lock = acquireInboxLock(targetDir, { staleMs, isPidAlive, nowMs, waitMs: lockWaitMs });
  if (!lock) {
    return { ...notFound, busy: true };
  }

  try {
    if (legacyDir) migrateLegacyInbox(legacyDir, targetDir, { staleMs, isPidAlive, nowMs });

    for (const fileName of listPendingJsonFiles(targetDir)) {
      const filePath = path.join(targetDir, fileName);
      let matches = fileName.replace(/\.json$/, '') === cleanMsgId;
      if (!matches) {
        try {
          matches = parseInboxText(fs.readFileSync(filePath, 'utf8'), fileName).record.id === cleanMsgId;
        } catch {
          matches = false;
        }
      }
      if (matches) {
        fs.unlinkSync(filePath);
        return { acked: true, terminalId: cleanTerminalId, messageId: cleanMsgId, fileName };
      }
    }
    return notFound;
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting for hook injection
// ---------------------------------------------------------------------------------------------

const BODY_LINE_BREAK_RE = /\r\n|[\r\n\u2028\u2029]/;
const BODY_CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g;

// A message body may span several lines, but every line is quoted ("> ") so that nothing inside it can
// pass for a heading, another entry, or text outside the entry it belongs to.
function quoteMessageBody(message) {
  return String(message ?? '')
    .trim()
    .split(BODY_LINE_BREAK_RE)
    .map((line) => {
      const clean = line.replace(BODY_CONTROL_CHARS_RE, ' ').trimEnd();
      return clean ? `> ${clean}` : '>';
    })
    .join('\n');
}

// The entry's own lines: "### [id] from <sender> @ <time>" and, when present, "Context docs: ...".
function buildEntryHead(m) {
  const from = sanitizeInline(m.from_terminal_id) || 'peer';
  const createdAt = sanitizeInline(m.created_at);
  const ts = createdAt ? ` @ ${createdAt}` : '';
  const docIds = (Array.isArray(m.context_docs) ? m.context_docs : [])
    .map((d) => sanitizeInline(d))
    .filter(Boolean);
  const docs = docIds.length > 0
    ? `\nContext docs: ${docIds.map((d) => `[[${d}]]`).join(', ')}`
    : '';
  return `### [${sanitizeInline(m.id)}] from ${from}${ts}${docs}`;
}

/**
 * The line that stands in for the body of a message that is too long to inject. `shownChars` is how much of
 * the beginning follows it as a quoted preview (0 = none).
 */
export function formatLongMessageNotice(messageId, totalChars, shownChars) {
  const shown = shownChars > 0
    ? `only the first ${shownChars} are shown below`
    : 'its text is not shown here';
  return `[long message: ${totalChars} characters; ${shown}, and this notice is not repeated. `
    + 'Read the full text with relay_inbox(action="peek"), then acknowledge it with '
    + `relay_inbox(action="ack", message_id="${sanitizeInline(messageId)}").]`;
}

// The announcement of an over-long message in at most `avail` characters, or '' when not even the entry's
// own lines and the notice fit. The preview shrinks to what `avail` allows.
function formatAnnouncement(m, entryHead, avail) {
  const full = String(m.message ?? '');
  const body = full.trim();
  let shown = Math.min(INBOX_PREVIEW_MAX_CHARS, body.length);

  while (shown > 0) {
    let slice = body.slice(0, shown);
    // Never end the preview in the middle of a surrogate pair.
    const last = slice.charCodeAt(slice.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
    if (!slice.trim()) break;
    const text = `${entryHead}\n${formatLongMessageNotice(m.id, full.length, slice.length)}\n${quoteMessageBody(slice)}`;
    if (text.length <= avail) return text;
    shown = slice.length - Math.max(1, text.length - avail);
  }

  const bare = `${entryHead}\n${formatLongMessageNotice(m.id, full.length, 0)}`;
  return bare.length <= avail ? bare : '';
}

/**
 * Format relay messages for hook injection and report what happened to each one, so the caller can
 * acknowledge exactly the messages that were delivered in full:
 *   includedIds  - injected in full; acknowledge these.
 *   announcedIds - too long for a block of `fullBlockChars` even on their own: a short entry was injected instead
 *                  (the entry's own lines, `formatLongMessageNotice`, and a quoted preview of the beginning of
 *                  at most INBOX_PREVIEW_MAX_CHARS characters). Record them as announced and do not pass
 *                  them in again; the full text stays in the inbox until relay_inbox(action="ack").
 *                  They do not hold up the messages after them.
 *   omittedIds   - not mentioned individually this time (no room left); they stay for the next prompt.
 * Messages are taken in order. A message that would fit a block of its own but not the room that is left
 * waits for the next prompt, together with everything after it.
 * `fullBlockChars` (default: `maxChars`) is the largest block this host's hooks ever give the inbox; a hook
 * that has less room at the moment passes it so that a message which fits the larger block is left for it
 * instead of being announced.
 * The block starts with its heading and `UNTRUSTED_MEMORY_PREAMBLE` (counted against maxChars; when the two
 * do not fit, nothing is emitted). Message metadata is printed as single sanitized lines, bodies are quoted,
 * and an entry's own lines are printed whole or not at all.
 * Strictly guarantees returned text.length <= maxChars.
 */
export function formatInboxForHookDetailed(messages, { maxChars = 2500, fullBlockChars } = {}) {
  if (!Array.isArray(messages) || messages.length === 0 || maxChars <= 0) {
    return { text: '', includedIds: [], announcedIds: [], omittedIds: [] };
  }

  const allIds = messages.map((m) => m.id);
  const header = `## Incoming Herdr Relay Messages (${messages.length})\n${UNTRUSTED_MEMORY_PREAMBLE}`;
  if (header.length >= maxChars) {
    return { text: '', includedIds: [], announcedIds: [], omittedIds: allIds };
  }

  const footer = '(+remaining relay messages available via relay_inbox)';
  const largestBlock = Math.max(maxChars, Number(fullBlockChars) || 0);
  const blocks = [header];
  const includedIds = [];
  const announcedIds = [];
  const omittedIds = [];
  let total = header.length;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const entryHead = buildEntryHead(m);
    const entry = `${entryHead}\n${quoteMessageBody(m.message)}`;
    const avail = maxChars - total - 2;

    if (entry.length <= avail) {
      blocks.push(entry);
      includedIds.push(m.id);
      total += 2 + entry.length;
      continue;
    }

    // Too long for any block of this size: announce it once and go on with the next message.
    const fitsBlockOfItsOwn = header.length + 2 + entry.length <= largestBlock;
    const announcement = fitsBlockOfItsOwn ? '' : formatAnnouncement(m, entryHead, avail);
    if (announcement) {
      blocks.push(announcement);
      announcedIds.push(m.id);
      total += 2 + announcement.length;
      continue;
    }

    // No room left this time: this message and the ones after it wait for the next prompt.
    for (let j = i; j < messages.length; j++) {
      omittedIds.push(messages[j].id);
    }
    break;
  }

  if (omittedIds.length > 0) {
    if (total + 2 + footer.length <= maxChars) {
      blocks.push(footer);
    } else if (blocks.length === 1) {
      // Not even the pointer fits next to the heading: emit nothing.
      return { text: '', includedIds, announcedIds, omittedIds };
    }
  }

  const joined = blocks.join('\n\n');
  const text = joined.length <= maxChars ? joined : joined.slice(0, maxChars).trimEnd();
  return { text, includedIds, announcedIds, omittedIds };
}

/**
 * Format relay messages concisely for hook injection.
 * Strictly guarantees returned length <= maxChars (including any footer).
 */
export function formatInboxForHook(messages, options = {}) {
  return formatInboxForHookDetailed(messages, options).text;
}

/**
 * What a hook does with a terminal's inbox, as one locked sequence: take the pending messages, format the
 * ones not announced before into at most `maxChars` characters, delete the ones injected in full, record the
 * over-long ones as announced, and release the lock.
 * Returns { text, deliveredIds, announcedIds, waitingIds, busy, notices }:
 *   text ''      - nothing to inject (no new message, no room, or `busy`: another consumer is delivering
 *                  this terminal's messages right now; they stay for the next prompt).
 *   waitingIds   - messages still in the inbox that were not injected in full by this call.
 * `projectDir` is the session's current project; it is used only to move an approved, enabled project's old
 * inbox location (see `drainInbox`). Delivery itself does not depend on the project.
 * `fullBlockChars`: see `formatInboxForHookDetailed`.
 */
export function deliverInboxForHook(
  terminalId,
  {
    globalDir,
    projectDir,
    maxChars = 2500,
    fullBlockChars,
    staleMs = DEFAULT_INBOX_STALE_MS,
    isPidAlive = defaultIsPidAlive,
    nowMs = Date.now(),
  } = {},
) {
  const drained = drainInbox(terminalId, { globalDir, projectDir, staleMs, isPidAlive, nowMs });
  const result = {
    text: '',
    deliveredIds: [],
    announcedIds: [],
    waitingIds: drained.messages.map((m) => m.id),
    busy: Boolean(drained.busy),
    notices: drained.notices,
  };
  if (drained.messages.length === 0) return result;

  try {
    const fresh = drained.messages.filter((m) => !m.announced);
    const detailed = formatInboxForHookDetailed(fresh, { maxChars, fullBlockChars });
    if (detailed.text) {
      drained.markAnnounced(detailed.announcedIds);
      drained.ack(detailed.includedIds);
      const delivered = new Set(detailed.includedIds);
      result.text = detailed.text;
      result.deliveredIds = detailed.includedIds;
      result.announcedIds = detailed.announcedIds;
      result.waitingIds = result.waitingIds.filter((id) => !delivered.has(id));
    }
  } finally {
    drained.release();
  }
  return result;
}
