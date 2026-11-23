import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWriteJson,
  formatIsoTimestamp,
  getGlobalDir,
  getTierPaths,
  getTrustedProjectsPath,
  isProjectTrusted,
  readTrustedProjects,
  resolveProjectRoot,
  trustedPathKey,
} from './config.mjs';

export { getTrustedProjectsPath, isProjectTrusted };

/**
 * Project approval ("trust"): a project's `.memory/` is only read, injected or written after the user
 * approved that exact folder. Approvals are the user's decision, so they are made with the CLI
 * (`src/core/trust-cli.mjs`, wrapped by the `cortex-trust` shell command), which asks a person in a
 * confirmation dialog before it approves anything, and are deliberately not available as an MCP tool.
 * The read side (`isProjectTrusted`) lives in `config.mjs`.
 *
 * The approvals file can still be edited directly. To make that visible, the CLI keeps a second file, the
 * "acknowledged" list: what a person confirmed in the dialog (or revoked). The hooks and `cortex-status`
 * compare the two and tell the user when they differ (`describeApprovalsChange`).
 */

export const TRUST_COMMAND = 'cortex-trust';

/**
 * The one place the "how to approve" wording comes from (hook notice, tool errors, CLI output).
 */
export const PROJECT_APPROVAL_INSTRUCTION =
  `To approve a folder, the user runs \`${TRUST_COMMAND} approve\` inside it from their own terminal `
  + `(or \`${TRUST_COMMAND} approve "<folder>"\`). Approval is the user's decision: ask them, do not run it for them.`;

export const PROJECT_NOT_APPROVED_CODE = 'PROJECT_NOT_APPROVED';

// One line, no control characters: the folder name ends up inside notices and error messages.
function displayPath(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Message of the `PROJECT_NOT_APPROVED` tool error and of the store's refusal to open the project tier.
 */
export function formatProjectNotApprovedMessage(projectDir) {
  return `Project folder "${displayPath(projectDir)}" is not approved for herdr-cortex, `
    + `so its .memory/ is neither read nor written (global memory still works). ${PROJECT_APPROVAL_INSTRUCTION}`;
}

/**
 * Notice the hooks inject when the working folder has a `.memory/` directory that was not loaded.
 */
export function formatProjectNotApprovedNotice(projectDir) {
  return `[herdr-cortex] Project memory was not loaded: "${displayPath(projectDir)}" contains a .memory/ directory, `
    + `but this folder is not approved. ${PROJECT_APPROVAL_INSTRUCTION}`;
}

/**
 * The same fact as one compact line for the user's own screen (the hooks' `systemMessage`).
 */
export function formatProjectNotApprovedUserNotice(projectDir) {
  return `[herdr-cortex] Project memory was not loaded: "${displayPath(projectDir)}" has a .memory/ folder but is not approved. `
    + `To approve it, run: ${TRUST_COMMAND} approve`;
}

export class ProjectNotApprovedError extends Error {
  constructor(projectDir) {
    super(formatProjectNotApprovedMessage(projectDir));
    this.name = 'ProjectNotApprovedError';
    this.code = PROJECT_NOT_APPROVED_CODE;
    this.projectDir = String(projectDir ?? '');
  }
}

function writeTrustedProjects(globalDir, entries) {
  const filePath = getTrustedProjectsPath(globalDir);
  atomicWriteJson(filePath, { version: 1, projects: entries });
  return filePath;
}

// A list file that exists but cannot be used is kept beside the new one instead of being silently replaced.
function preserveUnreadableList(globalDir) {
  const filePath = getTrustedProjectsPath(globalDir);
  try {
    if (!fs.existsSync(filePath)) return;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.projects)) return;
  } catch {
    // fall through: unreadable or not JSON
  }
  try {
    fs.copyFileSync(filePath, `${filePath}.unreadable-${Date.now()}`);
  } catch {
    // best effort
  }
}

/**
 * Approved project folders: [{ path, approvedAt }], in the order they were approved.
 */
export function listTrustedProjects({ globalDir } = {}) {
  return readTrustedProjects(globalDir);
}

/**
 * The folder an approval of `projectDir` would record: the real path of the project root. Throws when the
 * folder does not exist or is not a folder.
 */
export function resolveApprovalTarget(projectDir = process.cwd()) {
  if (typeof projectDir !== 'string' || !projectDir.trim()) {
    throw new Error('approveProject requires a project folder');
  }
  const root = resolveProjectRoot(projectDir.trim());
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    throw new Error(`Cannot approve "${root}": the folder does not exist.`);
  }
  if (!fs.statSync(realRoot).isDirectory()) {
    throw new Error(`Cannot approve "${root}": not a folder.`);
  }
  return realRoot;
}

/**
 * Approve exactly one project folder (never its subfolders or its parent). The folder must exist; its real
 * path is what gets recorded, so approving through a junction approves the folder the junction points to.
 * Returns { path, approvedAt, alreadyApproved, filePath }.
 */
export function approveProject(projectDir = process.cwd(), { globalDir, now = new Date() } = {}) {
  const realRoot = resolveApprovalTarget(projectDir);

  const entries = readTrustedProjects(globalDir);
  const key = trustedPathKey(realRoot);
  const existing = entries.find((entry) => trustedPathKey(entry.path) === key);
  if (existing) {
    return {
      path: existing.path,
      approvedAt: existing.approvedAt,
      alreadyApproved: true,
      filePath: getTrustedProjectsPath(globalDir),
    };
  }

  preserveUnreadableList(globalDir);
  const entry = { path: realRoot, approvedAt: formatIsoTimestamp(now) };
  const filePath = writeTrustedProjects(globalDir, [...entries, entry]);
  return { ...entry, alreadyApproved: false, filePath };
}

/**
 * Withdraw the approval of one project folder. Works for a folder that no longer exists.
 * Returns { path, revoked, filePath }.
 */
export function revokeProject(projectDir = process.cwd(), { globalDir } = {}) {
  if (typeof projectDir !== 'string' || !projectDir.trim()) {
    throw new Error('revokeProject requires a project folder');
  }
  const root = resolveProjectRoot(projectDir.trim());
  // Match the folder's real path, and also the path exactly as recorded (the folder may be gone by now).
  let realRoot = root;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    realRoot = root;
  }
  const keys = new Set([trustedPathKey(realRoot), trustedPathKey(root)]);

  const entries = readTrustedProjects(globalDir);
  const kept = entries.filter((entry) => !keys.has(trustedPathKey(entry.path)));
  const filePath = getTrustedProjectsPath(globalDir);
  if (kept.length === entries.length) {
    return { path: realRoot, revoked: false, filePath };
  }
  writeTrustedProjects(globalDir, kept);
  return { path: realRoot, revoked: true, filePath };
}

/**
 * Approval state of one folder, for the CLI and status displays:
 * { path, approved, approvedAt, hasMemoryDir }.
 */
export function describeProjectTrust(projectDir = process.cwd(), { globalDir } = {}) {
  const root = resolveProjectRoot(String(projectDir || process.cwd()).trim());
  let realRoot = root;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    realRoot = root;
  }
  const key = trustedPathKey(realRoot);
  const entry = readTrustedProjects(globalDir).find((item) => trustedPathKey(item.path) === key) || null;
  let hasMemoryDir = false;
  try {
    hasMemoryDir = fs.statSync(path.join(realRoot, '.memory')).isDirectory();
  } catch {
    hasMemoryDir = false;
  }
  return {
    path: realRoot,
    approved: Boolean(entry) && isProjectTrusted(root, { globalDir }),
    approvedAt: entry?.approvedAt || '',
    hasMemoryDir,
  };
}

// ---------------------------------------------------------------------------------------------
// The acknowledged list: what a person confirmed
// ---------------------------------------------------------------------------------------------

/**
 * <globalDir>/state/trusted-projects.acknowledged.json: the approvals a person confirmed in the dialog.
 *   { "version": 1, "updatedAt": "<timestamp>", "projects": [ { "path": "...", "approvedAt": "..." } ] }
 * Only the command line writes it, and only for what the person saw: a confirmed `approve` adds that one
 * folder, a `revoke` removes that one folder, a confirmed `acknowledge` copies the whole current list.
 * A missing file means "nothing acknowledged yet", so approvals made before this file existed are reported
 * until the user runs `cortex-trust acknowledge` once.
 */
export const ACKNOWLEDGED_APPROVALS_FILE = 'trusted-projects.acknowledged.json';

/** File names (in <globalDir>/state/) that decide which folders are approved or count as acknowledged. */
export const APPROVAL_STATE_FILE_NAMES = Object.freeze(['trusted-projects.json', ACKNOWLEDGED_APPROVALS_FILE]);

export const ACKNOWLEDGE_COMMAND = `${TRUST_COMMAND} acknowledge`;

export function getAcknowledgedApprovalsPath(globalDir) {
  return path.join(getTierPaths(getGlobalDir(globalDir)).stateDir, ACKNOWLEDGED_APPROVALS_FILE);
}

/**
 * Entries of the acknowledged list: [{ path, approvedAt }]. A missing or unreadable file means none.
 */
export function readAcknowledgedApprovals(globalDir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(getAcknowledgedApprovalsPath(globalDir), 'utf8').replace(/^﻿/, ''));
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) return [];
  const entries = [];
  for (const item of data.projects) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string') continue;
    const storedPath = item.path.trim();
    if (!storedPath || !path.isAbsolute(storedPath)) continue;
    entries.push({ path: storedPath, approvedAt: typeof item.approvedAt === 'string' ? item.approvedAt : '' });
  }
  return entries;
}

function writeAcknowledgedApprovals(globalDir, entries, now = new Date()) {
  const filePath = getAcknowledgedApprovalsPath(globalDir);
  atomicWriteJson(filePath, { version: 1, updatedAt: formatIsoTimestamp(now), projects: entries });
  return filePath;
}

/**
 * Record that a person confirmed the approval of one folder (call it after the dialog said yes and the
 * folder was approved). Only that folder is added: anything else that differs stays unacknowledged.
 */
export function acknowledgeApproval(approvedPath, { globalDir, now = new Date() } = {}) {
  const key = trustedPathKey(approvedPath);
  const current = readTrustedProjects(globalDir).find((entry) => trustedPathKey(entry.path) === key);
  if (!current) return { acknowledged: false, filePath: getAcknowledgedApprovalsPath(globalDir) };
  const kept = readAcknowledgedApprovals(globalDir).filter((entry) => trustedPathKey(entry.path) !== key);
  const filePath = writeAcknowledgedApprovals(globalDir, [...kept, { ...current }], now);
  return { acknowledged: true, filePath };
}

/**
 * Record that a person revoked one folder: it leaves the acknowledged list as well (whether or not it was
 * still in the approvals list). Nothing else in the acknowledged list changes.
 */
export function acknowledgeRevocation(projectDir, { globalDir, now = new Date() } = {}) {
  const root = resolveProjectRoot(String(projectDir || process.cwd()).trim());
  let realRoot = root;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    realRoot = root;
  }
  const keys = new Set([trustedPathKey(realRoot), trustedPathKey(root)]);
  const entries = readAcknowledgedApprovals(globalDir);
  const kept = entries.filter((entry) => !keys.has(trustedPathKey(entry.path)));
  const filePath = getAcknowledgedApprovalsPath(globalDir);
  if (kept.length === entries.length) return { changed: false, filePath };
  writeAcknowledgedApprovals(globalDir, kept, now);
  return { changed: true, filePath };
}

/**
 * Record the whole current approvals list as acknowledged (the `acknowledge` command, after its dialog).
 */
export function acknowledgeCurrentApprovals({ globalDir, now = new Date() } = {}) {
  const projects = readTrustedProjects(globalDir);
  const filePath = writeAcknowledgedApprovals(globalDir, projects.map((entry) => ({ ...entry })), now);
  return { filePath, projects };
}

/**
 * How the approvals list differs from the acknowledged list:
 * { changed, added: [{ path, approvedAt }], removed: [{ path, approvedAt }], key }.
 * `added` are approved folders nobody confirmed, `removed` are confirmed folders that are no longer approved.
 * `key` identifies this particular difference ('' when there is none), so a notice can be shown once per change.
 */
export function describeApprovalsChange({ globalDir } = {}) {
  const current = readTrustedProjects(globalDir);
  const acknowledged = readAcknowledgedApprovals(globalDir);
  const currentKeys = new Set(current.map((entry) => trustedPathKey(entry.path)));
  const acknowledgedKeys = new Set(acknowledged.map((entry) => trustedPathKey(entry.path)));

  const added = current.filter((entry) => !acknowledgedKeys.has(trustedPathKey(entry.path)));
  const removed = acknowledged.filter((entry) => !currentKeys.has(trustedPathKey(entry.path)));
  const changed = added.length > 0 || removed.length > 0;

  let key = '';
  if (changed) {
    const parts = [
      ...added.map((entry) => `+${trustedPathKey(entry.path)}`),
      ...removed.map((entry) => `-${trustedPathKey(entry.path)}`),
    ].sort();
    key = crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
  }
  return { changed, added, removed, key };
}

/** Most folders one "approvals changed" notice names per group. */
export const APPROVALS_CHANGE_MAX_FOLDERS = 5;

function describeChangedFolders(entries, dateLabel) {
  const shown = entries
    .slice(0, APPROVALS_CHANGE_MAX_FOLDERS)
    .map((entry) => `"${displayPath(entry.path)}" (${entry.approvedAt ? `${dateLabel} ${displayPath(entry.approvedAt)}` : 'no date'})`);
  if (entries.length > shown.length) shown.push(`+${entries.length - shown.length} more`);
  return shown.join('; ');
}

/**
 * One compact line for the user's screen: which folders were added to or removed from the approvals list
 * without the confirmation dialog, how to undo that, and how to accept it. '' when nothing differs.
 */
export function formatApprovalsChangedWarning(change) {
  if (!change || !change.changed) return '';
  const parts = [
    `[herdr-cortex] WARNING: the list of approved project folders was changed without the ${TRUST_COMMAND} confirmation dialog.`,
  ];
  if (change.added.length > 0) parts.push(`Added: ${describeChangedFolders(change.added, 'approved at')}.`);
  if (change.removed.length > 0) parts.push(`Removed: ${describeChangedFolders(change.removed, 'was approved at')}.`);
  parts.push(
    `If you did not make this change, undo it: ${TRUST_COMMAND} revoke "<folder>" for an added folder, `
    + `${TRUST_COMMAND} approve "<folder>" for a removed one. To accept the list as it is now: ${ACKNOWLEDGE_COMMAND}.`,
  );
  return parts.join(' ');
}

/** Appended to the warning where an agent reads it (hook context), so that it reaches the user as well. */
export const APPROVALS_CHANGED_AGENT_NOTE =
  ' Tell the user about this notice. These commands are for the user to run: do not run them yourself.';

export function formatApprovalsChangedContext(change) {
  const warning = formatApprovalsChangedWarning(change);
  return warning ? `${warning}${APPROVALS_CHANGED_AGENT_NOTE}` : '';
}
