import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assertInsideDir,
  atomicWriteJson,
  ensureMemoryGitignore,
  getProjectMemoryDir,
  getTierPaths,
} from '../core/config.mjs';
import { UNTRUSTED_MEMORY_PREAMBLE, sanitizeInline } from '../core/budget.mjs';
import { validateTerminalId } from '../revive/tracker.mjs';

const TAKING_DIR_RE = /^\.taking-(\d+)-([a-zA-Z0-9_-]+)$/;
const SAFE_MSG_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

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
  renameSyncWithRetry(srcPath, candidate);
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
  // The inbox lives under the project's .memory/, which this call may just have created: keep it out of git.
  ensureMemoryGitignore(getProjectMemoryDir(projectDir));

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
      renameSyncWithRetry(srcPath, dstPath, 3);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
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
  const ack = (onlyIds) => {
    if (acked) return { acked: 0, restored: 0, alreadyAcked: true };
    acked = true;
    const isPartial = Array.isArray(onlyIds);
    const idSet = isPartial ? new Set(onlyIds.map((id) => String(id))) : null;
    let removed = 0;
    let restored = 0;
    let restoreFailed = 0;
    for (const entry of claimedEntries) {
      if (isPartial && !idSet.has(entry.record.id)) {
        try {
          if (fs.existsSync(entry.filePath)) {
            moveFileUnique(entry.filePath, targetDir, entry.fileName);
            restored++;
          }
        } catch {
          // leave file in claim dir for stale recovery if move fails
          restoreFailed++;
        }
        continue;
      }
      try {
        if (fs.existsSync(entry.filePath)) {
          fs.unlinkSync(entry.filePath);
          removed++;
        }
      } catch {
        // ignore
      }
    }
    if (restoreFailed === 0) {
      try {
        fs.rmSync(claimDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    return { acked: removed, restored, restoreFailed };
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

/**
 * Format drained relay messages concisely for hook injection and report exactly
 * which message IDs were fully included vs omitted or truncated so hooks only ACK
 * messages delivered intact.
 * The block starts with its heading and `UNTRUSTED_MEMORY_PREAMBLE` (counted against maxChars; when the two
 * do not fit, nothing is emitted). Message metadata is printed as single sanitized lines, bodies are quoted.
 * Strictly guarantees returned text.length <= maxChars.
 */
export function formatInboxForHookDetailed(messages, { maxChars = 2500 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0 || maxChars <= 0) {
    return { text: '', includedIds: [], omittedIds: [], truncatedIds: [] };
  }

  const allIds = messages.map((m) => m.id);
  const header = `## Incoming Herdr Relay Messages (${messages.length})\n${UNTRUSTED_MEMORY_PREAMBLE}`;
  if (header.length >= maxChars) {
    return {
      text: '',
      includedIds: [],
      omittedIds: allIds,
      truncatedIds: [],
    };
  }

  const footer = '(+remaining relay messages available via relay_inbox)';
  const trimSuffix = '\n[...trimmed, inspect via relay_inbox]';
  const blocks = [header];
  const includedIds = [];
  const omittedIds = [];
  const truncatedIds = [];
  let total = header.length;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const from = sanitizeInline(m.from_terminal_id) || 'peer';
    const createdAt = sanitizeInline(m.created_at);
    const ts = createdAt ? ` @ ${createdAt}` : '';
    const docIds = (Array.isArray(m.context_docs) ? m.context_docs : [])
      .map((d) => sanitizeInline(d))
      .filter(Boolean);
    const docs = docIds.length > 0
      ? `\nContext docs: ${docIds.map((d) => `[[${d}]]`).join(', ')}`
      : '';
    const entryHead = `### [${sanitizeInline(m.id)}] from ${from}${ts}${docs}`;
    const entry = `${entryHead}\n${quoteMessageBody(m.message)}`;

    if (total + 2 + entry.length <= maxChars) {
      blocks.push(entry);
      includedIds.push(m.id);
      total += 2 + entry.length;
      continue;
    }

    if (blocks.length > 1) {
      for (let j = i; j < messages.length; j++) {
        omittedIds.push(messages[j].id);
      }
      if (total + 2 + footer.length <= maxChars) {
        blocks.push(footer);
      }
      break;
    }

    // First message alone exceeds remaining budget -> trim cleanly inside maxChars
    // and mark as truncated (NOT includedIds) so it remains in inbox for relay_inbox.
    // The cut may only fall inside the quoted body: the entry's own header lines are printed whole or not at all.
    const avail = maxChars - total - 2;
    if (avail > entryHead.length + trimSuffix.length) {
      const bodyLimit = avail - trimSuffix.length;
      const clipped = entry.slice(0, bodyLimit).trimEnd();
      blocks.push(`${clipped}${trimSuffix}`);
      truncatedIds.push(m.id);
    } else {
      omittedIds.push(m.id);
    }
    for (let j = i + 1; j < messages.length; j++) {
      omittedIds.push(messages[j].id);
    }
    break;
  }

  // No entry fits at all: point to relay_inbox when there is room for that, otherwise emit nothing.
  if (blocks.length === 1) {
    if (total + 2 + footer.length > maxChars) {
      return { text: '', includedIds, omittedIds, truncatedIds };
    }
    blocks.push(footer);
  }

  const joined = blocks.join('\n\n');
  const text = joined.length <= maxChars ? joined : joined.slice(0, maxChars).trimEnd();
  return { text, includedIds, omittedIds, truncatedIds };
}

/**
 * Format drained relay messages concisely for hook injection.
 * Strictly guarantees returned length <= maxChars (including any footer/trim notice).
 */
export function formatInboxForHook(messages, options = {}) {
  return formatInboxForHookDetailed(messages, options).text;
}
