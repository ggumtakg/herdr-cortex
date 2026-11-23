import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWriteJson,
  formatIsoTimestamp,
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
 * (`src/core/trust-cli.mjs`, wrapped by the `cortex-trust` shell command) and are deliberately not
 * available as an MCP tool. The read side (`isProjectTrusted`) lives in `config.mjs`.
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
 * Approve exactly one project folder (never its subfolders or its parent). The folder must exist; its real
 * path is what gets recorded, so approving through a junction approves the folder the junction points to.
 * Returns { path, approvedAt, alreadyApproved, filePath }.
 */
export function approveProject(projectDir = process.cwd(), { globalDir, now = new Date() } = {}) {
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
