import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assertInsideDir,
  atomicWriteJson,
  getProjectMemoryDir,
  getTierPaths,
} from '../core/config.mjs';
import { validateTerminalId } from '../revive/tracker.mjs';

const TAKING_DIR_RE = /^\.taking-(\d+)-([a-zA-Z0-9_-]+)$/;
const SAFE_MSG_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

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

export function getTerminalInboxDir(projectDir, terminalId) {
  const cleanId = validateTerminalId(terminalId);
  const { inboxDir } = getTierPaths(getProjectMemoryDir(projectDir));
  return assertInsideDir(inboxDir, cleanId);
}

function listPendingJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
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

function moveFileUnique(srcPath, destDir, preferredName) {
  fs.mkdirSync(destDir, { recursive: true });
  let candidate = assertInsideDir(destDir, preferredName);
  if (fs.existsSync(candidate)) {
    const ext = path.extname(preferredName);
    const stem = preferredName.slice(0, preferredName.length - ext.length);
    const suffix = crypto.randomBytes(3).toString('hex');
    candidate = assertInsideDir(destDir, `${stem}-${suffix}${ext}`);
  }
  fs.renameSync(srcPath, candidate);
  return candidate;
}

function parseInboxRecord(filePath, fileName) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Inbox payload must be a JSON object');
  }
  if (typeof parsed.message !== 'string') {
    throw new Error('Inbox payload missing string "message" field');
  }
  const fallbackId = fileName.replace(/\.json$/, '');
  return {
    id: typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : fallbackId,
    from_terminal_id: typeof parsed.from_terminal_id === 'string' ? parsed.from_terminal_id : '',
    to_terminal_id: typeof parsed.to_terminal_id === 'string' ? parsed.to_terminal_id : '',
    message: parsed.message,
    context_docs: Array.isArray(parsed.context_docs)
      ? parsed.context_docs.map((d) => String(d).trim()).filter(Boolean)
      : [],
    created_at: typeof parsed.created_at === 'string' ? parsed.created_at : '',
    ...(parsed.meta && typeof parsed.meta === 'object' ? { meta: parsed.meta } : {}),
  };
}

/**
 * Atomically enqueue a relay message into <project>/.memory/state/inbox/<terminalId>/.
 */
export function enqueueMessage(projectDir, terminalId, msg = {}) {
  const cleanTerminalId = validateTerminalId(terminalId);
  const targetDir = getTerminalInboxDir(projectDir, cleanTerminalId);
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
 * Recover stale .taking-<pid>-<rand> directories whose owner PID is dead
 * or whose age exceeds staleMs.
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
        // leave file untouched if concurrently moved
      }
    }

    try {
      fs.rmSync(takingDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error if concurrently removed
    }

    notices.push(
      `Recovered ${recoveredFiles} message(s) from stale claim dir ${ent.name} (${pidDead ? `dead pid ${ownerPid}` : `older than ${staleMs}ms`}).`,
    );
  }

  return notices;
}

/**
 * Crash-safe inbox drain:
 *  1) Recovers stale .taking-<pid>-<rand>/ dirs (dead PID or older than staleMs).
 *  2) Moves pending .json files into .taking-<pid>-<rand>/ via renameSync.
 *  3) Quarantines corrupt JSON into .broken/.
 *  4) Returns { messages, ack(), notices }. Calling ack() deletes the claimed batch.
 */
export function drainInbox(
  projectDir,
  terminalId,
  {
    staleMs = 600_000,
    isPidAlive = defaultIsPidAlive,
    nowMs = Date.now(),
  } = {},
) {
  const targetDir = getTerminalInboxDir(projectDir, terminalId);
  if (!fs.existsSync(targetDir)) {
    return {
      messages: [],
      notices: [],
      ack() {
        return { acked: 0 };
      },
    };
  }

  const notices = recoverStaleTakingDirs(targetDir, { staleMs, isPidAlive, nowMs });
  const pendingFiles = listPendingJsonFiles(targetDir);
  if (pendingFiles.length === 0) {
    return {
      messages: [],
      notices,
      ack() {
        return { acked: 0 };
      },
    };
  }

  const claimName = `.taking-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const claimDir = assertInsideDir(targetDir, claimName);
  fs.mkdirSync(claimDir, { recursive: true });

  const brokenDir = assertInsideDir(targetDir, '.broken');
  const claimedEntries = [];

  for (const fileName of pendingFiles) {
    const srcPath = assertInsideDir(targetDir, fileName);
    const dstPath = assertInsideDir(claimDir, fileName);
    try {
      fs.renameSync(srcPath, dstPath);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EBUSY' || err.code === 'EPERM')) {
        continue; // claimed or transiently locked by another reader
      }
      throw err;
    }

    try {
      const record = parseInboxRecord(dstPath, fileName);
      claimedEntries.push({ fileName, filePath: dstPath, record });
    } catch (err) {
      try {
        moveFileUnique(dstPath, brokenDir, fileName);
      } catch {
        // ignore quarantine error
      }
      notices.push(`Quarantined corrupt inbox file ${fileName} into .broken/: ${err.message}`);
    }
  }

  if (claimedEntries.length === 0) {
    try {
      fs.rmSync(claimDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return {
      messages: [],
      notices,
      ack() {
        return { acked: 0 };
      },
    };
  }

  let acked = false;
  const ack = () => {
    if (acked) return { acked: 0, alreadyAcked: true };
    acked = true;
    let removed = 0;
    for (const entry of claimedEntries) {
      try {
        if (fs.existsSync(entry.filePath)) {
          fs.unlinkSync(entry.filePath);
          removed++;
        }
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(claimDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return { acked: removed };
  };

  return {
    messages: claimedEntries.map((e) => e.record),
    claimDir,
    notices,
    ack,
  };
}

/**
 * Non-destructively inspect pending messages in a terminal's inbox
 * (also recovers stale .taking-* directories left by crashed consumers).
 */
export function peekInbox(
  projectDir,
  terminalId,
  {
    staleMs = 600_000,
    isPidAlive = defaultIsPidAlive,
    nowMs = Date.now(),
  } = {},
) {
  const cleanId = validateTerminalId(terminalId);
  const targetDir = getTerminalInboxDir(projectDir, cleanId);
  if (!fs.existsSync(targetDir)) {
    return { terminalId: cleanId, messages: [], count: 0, notices: [] };
  }

  const notices = recoverStaleTakingDirs(targetDir, { staleMs, isPidAlive, nowMs });
  const files = listPendingJsonFiles(targetDir);
  const messages = [];

  for (const fileName of files) {
    const filePath = assertInsideDir(targetDir, fileName);
    try {
      messages.push(parseInboxRecord(filePath, fileName));
    } catch (err) {
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
 * Acknowledge and delete a specific pending message by messageId (or file stem).
 */
export function ackMessage(projectDir, terminalId, messageId) {
  const cleanTerminalId = validateTerminalId(terminalId);
  const cleanMsgId = typeof messageId === 'string' ? messageId.trim() : '';
  if (!cleanMsgId || !SAFE_MSG_ID_RE.test(cleanMsgId)) {
    throw new Error(`Invalid messageId "${String(messageId)}"`);
  }

  const targetDir = getTerminalInboxDir(projectDir, cleanTerminalId);
  if (!fs.existsSync(targetDir)) {
    return { acked: false, terminalId: cleanTerminalId, messageId: cleanMsgId };
  }

  const files = listPendingJsonFiles(targetDir);
  for (const fileName of files) {
    const filePath = assertInsideDir(targetDir, fileName);
    const stem = fileName.replace(/\.json$/, '');
    let matches = stem === cleanMsgId;
    if (!matches) {
      try {
        const parsed = parseInboxRecord(filePath, fileName);
        matches = parsed.id === cleanMsgId;
      } catch {
        matches = false;
      }
    }
    if (matches) {
      fs.unlinkSync(filePath);
      return { acked: true, terminalId: cleanTerminalId, messageId: cleanMsgId, fileName };
    }
  }

  return { acked: false, terminalId: cleanTerminalId, messageId: cleanMsgId };
}

/**
 * Format drained relay messages concisely for hook injection.
 * Strictly guarantees returned length <= maxChars (including any footer/trim notice).
 */
export function formatInboxForHook(messages, { maxChars = 2500 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0 || maxChars <= 0) return '';

  const header = `## Incoming Herdr Relay Messages (${messages.length})`;
  if (header.length >= maxChars) {
    return header.slice(0, maxChars).trimEnd();
  }

  const footer = '(+remaining relay messages available via relay_inbox)';
  const trimSuffix = '\n[...trimmed, inspect via relay_inbox]';
  const blocks = [header];
  let total = header.length;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const from = m.from_terminal_id || 'peer';
    const ts = m.created_at ? ` @ ${m.created_at}` : '';
    const docs = Array.isArray(m.context_docs) && m.context_docs.length > 0
      ? `\nContext docs: ${m.context_docs.map((d) => `[[${d}]]`).join(', ')}`
      : '';
    const entry = `### [${m.id}] from ${from}${ts}${docs}\n${m.message.trim()}`;

    if (total + 2 + entry.length <= maxChars) {
      blocks.push(entry);
      total += 2 + entry.length;
      continue;
    }

    if (blocks.length > 1) {
      if (total + 2 + footer.length <= maxChars) {
        blocks.push(footer);
      }
      break;
    }

    // First message alone exceeds remaining budget -> trim cleanly inside maxChars
    const avail = maxChars - total - 2;
    if (avail > trimSuffix.length) {
      const bodyLimit = avail - trimSuffix.length;
      const clipped = entry.slice(0, bodyLimit).trimEnd();
      blocks.push(`${clipped}${trimSuffix}`);
    } else if (avail > 0) {
      blocks.push(entry.slice(0, avail).trimEnd());
    }
    break;
  }

  const out = blocks.join('\n\n');
  return out.length <= maxChars ? out : out.slice(0, maxChars).trimEnd();
}
