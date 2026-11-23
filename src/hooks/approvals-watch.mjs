import fs from 'node:fs';
import path from 'node:path';
import { assertInsideDir, atomicWriteJson, getTierPaths, getTrustedProjectsPath } from '../core/config.mjs';
import {
  describeApprovalsChange,
  formatApprovalsChangedContext,
  formatApprovalsChangedWarning,
  getAcknowledgedApprovalsPath,
} from '../core/trust.mjs';
import { isValidSessionId, resolveCortexGlobalDir } from '../revive/tracker.mjs';

/**
 * Telling the user when the approvals list was changed without the confirmation dialog.
 *
 * `cortex-trust approve` asks a person in a dialog, but the approvals file itself can still be edited by
 * anything that can write files. The command line therefore keeps the "acknowledged" list (what a person
 * confirmed), and the hooks compare the two at every session start and on every prompt.
 *
 * The check runs on every prompt, so it is cheap: both files are only `stat`ed, and they are read only when
 * a modification time or a size differs from what this session saw at its previous check. What a session
 * saw is kept in <globalDir>/state/approval-checks/<sessionId>.json together with the key of the change it
 * already announced: one distinct change is announced once per session, and every new session announces it
 * again until it is acknowledged (`cortex-trust acknowledge`) or undone.
 */

export const APPROVAL_CHECK_DIR_NAME = 'approval-checks';
/** Check records of sessions that have not checked for this long are deleted when a session starts. */
export const APPROVAL_CHECK_STALE_MS = 30 * 24 * 60 * 60 * 1000;

export function getApprovalChecksDir(globalDir) {
  return path.join(getTierPaths(resolveCortexGlobalDir(globalDir)).stateDir, APPROVAL_CHECK_DIR_NAME);
}

function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '-';
  }
}

function recordPath(globalDir, sessionId) {
  if (!isValidSessionId(sessionId)) return '';
  try {
    return assertInsideDir(getApprovalChecksDir(globalDir), `${sessionId.trim()}.json`);
  } catch {
    return '';
  }
}

function readRecord(filePath) {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.signature !== 'string') return null;
    return { signature: parsed.signature, changeKey: typeof parsed.changeKey === 'string' ? parsed.changeKey : '' };
  } catch {
    return null;
  }
}

/**
 * Delete check records no session has touched for APPROVAL_CHECK_STALE_MS. Best effort.
 */
export function pruneApprovalCheckRecords(globalDir, nowMs = Date.now()) {
  const dir = getApprovalChecksDir(globalDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    try {
      const filePath = assertInsideDir(dir, ent.name);
      if (nowMs - fs.statSync(filePath).mtimeMs > APPROVAL_CHECK_STALE_MS) {
        fs.unlinkSync(filePath);
        removed += 1;
      }
    } catch {
      // ignore: another process may have removed it
    }
  }
  return removed;
}

/**
 * One check for one session. Returns null when there is nothing new to announce, otherwise
 * { userText, contextText, change }: `userText` is the one-line warning for the user's screen, `contextText`
 * the same warning for the agent's context (with the request to pass it on).
 * `stats` (optional, for tests) receives { listsRead } so a test can see that an unchanged pair of files is
 * not read again. Never throws.
 */
export function checkApprovalsForSession({ globalDir, sessionId, stats = null } = {}) {
  try {
    const effectiveGlobalDir = resolveCortexGlobalDir(globalDir);
    const signature = `${fileSignature(getTrustedProjectsPath(effectiveGlobalDir))}|${fileSignature(getAcknowledgedApprovalsPath(effectiveGlobalDir))}`;
    const cleanSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const filePath = recordPath(effectiveGlobalDir, cleanSessionId);
    const record = readRecord(filePath);

    // Nothing changed on disk since this session's previous check: whatever differs was announced then.
    if (record && record.signature === signature) {
      if (stats) stats.listsRead = false;
      return null;
    }
    // Neither file exists and this session has no record: nothing is approved, nothing to compare.
    if (!record && signature === '-|-') {
      if (stats) stats.listsRead = false;
      return null;
    }

    if (stats) stats.listsRead = true;
    const change = describeApprovalsChange({ globalDir: effectiveGlobalDir });
    const announce = change.changed && (!record || record.changeKey !== change.key);

    if (filePath) {
      try {
        atomicWriteJson(filePath, {
          version: 1,
          signature,
          changeKey: change.key,
          checkedAt: new Date().toISOString(),
        });
      } catch {
        // Without the record the next check simply reads the lists again.
      }
    }

    if (!announce) return null;
    return {
      userText: formatApprovalsChangedWarning(change),
      contextText: formatApprovalsChangedContext(change),
      change,
    };
  } catch {
    return null;
  }
}
