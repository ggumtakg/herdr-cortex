#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import {
  CORTEX_ROOT_PLACEHOLDER,
  DEFAULT_CONFIG,
  EMBEDDING_PROVIDER_NAMES,
  LEGACY_EMBEDDING_KEY_TARGETS,
  REPO_ROOT,
  assertInsideDir,
  atomicWriteJson,
  atomicWriteText,
  expandCortexRootPlaceholder,
  findLegacyEmbeddingKeys,
  getConfigProblems,
  isMainModule,
  loadConfig,
  projectPathKey,
  resolveGlobalDir,
  resolveHomeDir,
} from '../core/config.mjs';
import { describeEmbeddingStatus, formatEmbeddingStatus } from '../embeddings/resolve.mjs';
import { CLAUDE_PRE_TOOL_USE_MATCHER, LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME } from './tool-names.mjs';

export const AGY_HOOK_KEY = 'herdr-cortex';
export const LEGACY_AGY_HOOK_KEY = 'herdr-revive-tracker';
/** Name the MCP server is registered under (Claude Code names its tools `mcp__herdr-cortex__<tool>`). */
export const MCP_SERVER_KEY = MCP_SERVER_NAME;
/** Name installations before the rename used; removed on install when the entry is ours. */
export const LEGACY_MCP_SERVER_KEY = LEGACY_MCP_SERVER_NAME;
/** Every hook this installer writes ends with the two arguments `--id herdr-cortex`. */
export const HOOK_ID_FLAG = '--id';
export const CLAUDE_HOOK_MARKER = 'herdr-cortex';
export const SKILL_MANAGED_MARKER = '.herdr-cortex-managed';

/** `<file>.herdr-cortex.<YYYYMMDD-HHmmss>.bak` is written before every change to an existing file. */
export const BACKUP_INFIX = '.herdr-cortex.';
/** The one fixed backup name earlier versions used (created once, never refreshed). */
export const LEGACY_BACKUP_SUFFIX = '.herdr-cortex.bak';

/** `<global>/state/install.json`: what the last install recorded (Node path, repository folder). */
export const INSTALL_RECORD_FILE = 'install.json';

/** How long the installer waits before it reads `~/.claude.json` back to see whether the registration survived. */
export const CLAUDE_MCP_VERIFY_DELAY_MS = 1500;

const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'UserPromptSubmit',
  'PreToolUse',
];

// Seconds. Claude Code gives a SessionEnd hook 1.5 s unless the registration says otherwise; the handler
// only writes one small record, the margin is for starting node.
export const CLAUDE_SESSION_END_TIMEOUT_SECONDS = 5;

/** The Claude Code hooks this installer registers: event, argument(s) of `src/hooks/claude.mjs`, matcher, timeout. */
export const CLAUDE_HOOK_SPECS = Object.freeze([
  // Two parallel SessionStart hooks: `core` emits HEAD_CORE under HEAD_CORE_MAX_CHARS, `context` emits the rest under hookBudget.
  { event: 'SessionStart', arg: 'session-start core', matcher: '', timeout: 10 },
  { event: 'SessionStart', arg: 'session-start context', matcher: '', timeout: 10 },
  // Records which session a /clear ended, so the next SessionStart restores turns from that session only.
  // The handler ignores every other end reason.
  { event: 'SessionEnd', arg: 'session-end', matcher: '', timeout: CLAUDE_SESSION_END_TIMEOUT_SECONDS },
  { event: 'PreCompact', arg: 'pre-compact', matcher: '', timeout: 10 },
  { event: 'UserPromptSubmit', arg: 'user-prompt', matcher: '', timeout: 10 },
  // One entry for this server's tools and for the file and shell tools whose calls the subagent
  // `.memory/` guard inspects.
  { event: 'PreToolUse', arg: 'pre-tool-use', matcher: CLAUDE_PRE_TOOL_USE_MATCHER, timeout: 10 },
]);

/** The Antigravity hooks this installer registers under the `herdr-cortex` group of `hooks.json`. */
export const ANTIGRAVITY_HOOK_SPECS = Object.freeze([
  { event: 'SessionStart', arg: 'session-start', timeout: 10 },
  { event: 'PreInvocation', arg: 'pre-invocation', timeout: 10 },
]);

// `embedding` blocks of the `config.json` files earlier installers wrote by default.
const OLD_DEFAULT_EMBEDDINGS = [
  // first release
  { provider: 'auto', model: '', dimensions: 0, baseUrl: '', apiKeyEnv: '', chunkMaxChars: 800, chunkOverlap: 100, timeoutMs: 15000 },
  // hardening release (added onnxEnabled)
  { provider: 'auto', model: '', dimensions: 0, baseUrl: '', apiKeyEnv: '', onnxEnabled: false, chunkMaxChars: 800, chunkOverlap: 100, timeoutMs: 15000 },
];

/**
 * The complete `config.json` contents earlier installers wrote by default. A global config that still equals
 * one of these (the user never edited it) is replaced by the current default on install.
 */
export const OLD_DEFAULT_CONFIGS = Object.freeze(OLD_DEFAULT_EMBEDDINGS.map((embedding) => Object.freeze({
  mode: 'all',
  enabledProjects: [],
  excludedProjects: [],
  headCoreEnabled: true,
  hookBudget: 9000,
  embedding,
})));

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------------------------
// Hook commands: how they are written and how ours are recognized
// ---------------------------------------------------------------------------------------------

/**
 * A Claude Code command hook in exec form: `command` is the Node executable (absolute path), `args` its
 * argument vector. Claude Code starts it directly, with no shell in between, so the same entry works whether
 * Claude Code would otherwise use Git Bash or PowerShell on Windows, the paths may contain spaces or any
 * other character, and nothing depends on `node` being on PATH.
 */
export function buildClaudeHookHandler({ nodePath, scriptPath, arg, timeout }) {
  const argParts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
  return {
    type: 'command',
    command: nodePath,
    args: ['--no-warnings', scriptPath, ...argParts, HOOK_ID_FLAG, CLAUDE_HOOK_MARKER],
    timeout,
  };
}

const SHELL_UNSAFE_RE = /["$`%\r\n]/;
const SHELL_BARE_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Write a file path so that cmd.exe, PowerShell and bash all read it as the same single word, also in
 * command position: forward slashes, and every segment that is not plain ASCII letters, digits, `_`, `.`
 * or `-` wrapped in double quotes (`C:/"Program Files"/nodejs/node.exe`). A quoted string at the very start
 * of a command line is a string expression to PowerShell (it needs `& "..."`, which bash and cmd.exe
 * reject); a word that merely contains quoted parts is a command name to all three.
 * Throws for a path containing `"`, `$`, a backtick, `%` or a line break: no spelling of those is read
 * the same way by all three shells.
 */
export function quotePathForShells(filePath) {
  const text = String(filePath ?? '');
  const forward = process.platform === 'win32' ? text.replace(/\\/g, '/') : text;
  if (!text || SHELL_UNSAFE_RE.test(forward) || forward.includes('\\')) {
    throw new Error(
      `the path "${text}" contains a character (", $, \`, %, a backslash or a line break) that cannot be written `
      + 'into a hook command so that every shell reads it the same way',
    );
  }
  return forward
    .split('/')
    .map((segment, index) => {
      if (segment === '' || SHELL_BARE_SEGMENT_RE.test(segment)) return segment;
      if (index === 0 && /^[A-Za-z]:$/.test(segment)) return segment;
      return `"${segment}"`;
    })
    .join('/');
}

/**
 * A hook command as one string, for a host that hands it to a shell we do not know (Antigravity documents
 * neither the shell nor an argument-vector form): valid in cmd.exe, PowerShell and bash alike.
 */
export function buildShellHookCommand({ nodePath, scriptPath, arg }) {
  return `${quotePathForShells(nodePath)} --no-warnings ${quotePathForShells(scriptPath)} ${arg} ${HOOK_ID_FLAG} ${CLAUDE_HOOK_MARKER}`;
}

/**
 * Split a shell-form command into words: white space separates, single and double quotes group (also in
 * the middle of a word) and are removed. Enough to read the commands this installer and its predecessors
 * wrote; it does not interpret escapes or variables.
 */
export function splitCommandLine(command) {
  const words = [];
  let current = '';
  let started = false;
  let quote = '';
  for (const ch of String(command ?? '')) {
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

// The argument vector of a hook entry: exec form (`command` + `args`) as it is, shell form split into words.
// A leading PowerShell call operator (`& "node.exe" ...`) is not part of it.
function hookArgv(hook) {
  if (!isPlainObject(hook) || typeof hook.command !== 'string') return [];
  if (Array.isArray(hook.args)) {
    return [hook.command, ...hook.args.map((arg) => String(arg))];
  }
  const words = splitCommandLine(hook.command);
  return words[0] === '&' ? words.slice(1) : words;
}

function baseName(filePath) {
  return String(filePath ?? '').split(/[\\/]/).pop() || '';
}

function isNodeExecutable(word) {
  const base = baseName(word).toLowerCase();
  return base === 'node' || base === 'node.exe';
}

/**
 * True when a hook entry was written by this installer: its arguments contain the pair `--id herdr-cortex`
 * (or `--marker herdr-cortex` from an earlier version). Nothing else makes a hook ours: not the word
 * "herdr-cortex" somewhere in the command, not a script name.
 */
export function isOwnHook(hook) {
  const argv = hookArgv(hook);
  for (let i = 1; i < argv.length - 1; i++) {
    if ((argv[i] === HOOK_ID_FLAG || argv[i] === '--marker') && argv[i + 1] === CLAUDE_HOOK_MARKER) {
      return true;
    }
  }
  return false;
}

/**
 * True when a hook entry is exactly what the predecessor tool (herdr-revive) registered:
 * `node [--flags] <...>/record-session.mjs <claude|antigravity>` and nothing else.
 */
export function isLegacyReviveHook(hook) {
  if (isPlainObject(hook) && Array.isArray(hook.args)) return false; // the predecessor never wrote exec form
  const argv = hookArgv(hook);
  if (argv.length < 3) return false;
  const agent = argv[argv.length - 1];
  const script = argv[argv.length - 2];
  if (!isNodeExecutable(argv[0])) return false;
  if (agent !== 'claude' && agent !== 'antigravity') return false;
  if (baseName(script) !== 'record-session.mjs') return false;
  return argv.slice(1, -2).every((word) => word.startsWith('--'));
}

/**
 * What one of our hook entries runs: { form: 'exec' | 'shell', nodePath, scriptPath, arg }.
 * `nodePath` is the first word (a bare `node` in entries written before the absolute path was recorded).
 */
export function describeOwnHook(hook) {
  const argv = hookArgv(hook);
  const scriptIndex = argv.findIndex((word, index) => index > 0 && /\.mjs$/i.test(word));
  const argTokens = [];
  if (scriptIndex > 0) {
    for (let i = scriptIndex + 1; i < argv.length; i++) {
      if (argv[i] === HOOK_ID_FLAG || argv[i] === '--marker') {
        i++;
        continue;
      }
      if (!argv[i].startsWith('-')) {
        argTokens.push(argv[i]);
      }
    }
  }
  return {
    form: isPlainObject(hook) && Array.isArray(hook.args) ? 'exec' : 'shell',
    nodePath: argv[0] || '',
    scriptPath: scriptIndex > 0 ? argv[scriptIndex] : '',
    arg: argTokens.join(' '),
  };
}

// Remove our own and the predecessor's hook entries from a list of hook handlers. Returns the handlers
// that stay and how many were removed.
function stripManagedHandlers(handlers) {
  const kept = [];
  let removed = 0;
  for (const handler of handlers) {
    if (isOwnHook(handler) || isLegacyReviveHook(handler)) removed++;
    else kept.push(handler);
  }
  return { kept, removed };
}

// ---------------------------------------------------------------------------------------------
// MCP entries: which ones are ours
// ---------------------------------------------------------------------------------------------

function pathKey(filePath) {
  try {
    return projectPathKey(filePath);
  } catch {
    return String(filePath);
  }
}

/**
 * Look at one `mcpServers` entry: { ours, thisRepo, nodePath, scriptPath }.
 * An entry is ours when it starts Node with the absolute path of a `src/mcp/server.mjs` that belongs to
 * herdr-cortex: this repository's, or one whose package.json is named "herdr-cortex", or (when that folder
 * no longer exists) one inside a folder named herdr-cortex. The name the entry is registered under plays no part.
 */
export function describeMcpEntry(entry, { repoRoot = REPO_ROOT } = {}) {
  const none = { ours: false, thisRepo: false, nodePath: '', scriptPath: '' };
  if (!isPlainObject(entry) || typeof entry.command !== 'string' || !Array.isArray(entry.args)) return none;
  const scriptPath = entry.args.find(
    (arg) => typeof arg === 'string' && /[\\/]src[\\/]mcp[\\/]server\.mjs$/i.test(arg),
  );
  const described = { ...none, nodePath: entry.command, scriptPath: scriptPath || '' };
  if (!scriptPath || !path.isAbsolute(scriptPath) || !isNodeExecutable(entry.command)) return described;

  if (pathKey(scriptPath) === pathKey(path.join(repoRoot, 'src', 'mcp', 'server.mjs'))) {
    return { ...described, ours: true, thisRepo: true };
  }
  const otherRoot = path.resolve(scriptPath, '..', '..', '..');
  const packagePath = path.join(otherRoot, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8').replace(/^\uFEFF/, ''));
      return { ...described, ours: pkg?.name === 'herdr-cortex' };
    } catch {
      return described;
    }
  }
  // The folder is gone (moved or deleted): only its name is left to go by.
  return { ...described, ours: !fs.existsSync(scriptPath) && /^herdr-cortex/i.test(path.basename(otherRoot)) };
}

function buildMcpServerEntry(repoRoot, nodePath, { claudeShape = false } = {}) {
  const entry = {
    command: nodePath,
    args: ['--no-warnings', path.join(repoRoot, 'src', 'mcp', 'server.mjs')],
  };
  // The fields `claude mcp add --transport stdio` itself writes for a user-scope server.
  return claudeShape ? { type: 'stdio', ...entry, env: {} } : entry;
}

function sameMcpCommand(a, b) {
  return isPlainObject(a) && isPlainObject(b)
    && a.command === b.command
    && Array.isArray(a.args) && Array.isArray(b.args)
    && a.args.length === b.args.length
    && a.args.every((arg, index) => arg === b.args[index]);
}

// ---------------------------------------------------------------------------------------------
// Reading, planning and writing JSON files
// ---------------------------------------------------------------------------------------------

class InstallProblem extends Error {
  constructor(file, message) {
    super(message);
    this.file = file;
  }
}

// { existed, data }. Throws InstallProblem when the file exists and is not a JSON object.
function readJsonStrict(filePath) {
  if (!fs.existsSync(filePath)) {
    return { existed: false, data: {} };
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    throw new InstallProblem(filePath, `cannot be read (${err?.code || err?.message || err})`);
  }
  if (!raw.trim()) {
    return { existed: true, data: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InstallProblem(filePath, `is not valid JSON (${err.message})`);
  }
  if (!isPlainObject(parsed)) {
    throw new InstallProblem(filePath, 'must contain a JSON object');
  }
  return { existed: true, data: parsed };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** `YYYYMMDD-HHmmss` in local time, the stamp of a backup file name. */
export function formatBackupStamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

/**
 * Copy `filePath` to `<filePath>.herdr-cortex.<stamp>.bak` (a counter is appended when that name is taken,
 * so no backup is ever overwritten). Returns the backup path, or '' when the file does not exist.
 */
export function createDatedBackup(filePath, now = new Date()) {
  if (!fs.existsSync(filePath)) return '';
  const stamp = formatBackupStamp(now);
  let backupPath = `${filePath}${BACKUP_INFIX}${stamp}.bak`;
  for (let counter = 2; fs.existsSync(backupPath); counter++) {
    backupPath = `${filePath}${BACKUP_INFIX}${stamp}-${counter}.bak`;
  }
  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

/**
 * The backups this tool created next to `filePath`: the dated ones and the fixed name of earlier versions.
 */
export function findBackups(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const dated = /^\d{8}-\d{6}(?:-\d+)?\.bak$/;
  return names
    .filter((name) => {
      if (name === `${base}${LEGACY_BACKUP_SUFFIX}`) return true;
      if (!name.startsWith(`${base}${BACKUP_INFIX}`)) return false;
      return dated.test(name.slice(base.length + BACKUP_INFIX.length));
    })
    .sort()
    .map((name) => path.join(dir, name));
}

// One planned change to a JSON file. `transform(data)` edits a copy of the parsed content in place and may
// return { notes: [...] }; it throws InstallProblem to stop the whole run. Nothing is written here.
function planJsonFile(filePath, { createIfMissing = true, transform }) {
  const { existed, data } = readJsonStrict(filePath);
  if (!existed && !createIfMissing) {
    return { path: filePath, existed, changed: false, missing: true, notes: [] };
  }
  const next = clone(data);
  const info = transform(next) || {};
  const changed = JSON.stringify(next) !== JSON.stringify(data);
  return { path: filePath, existed, changed, missing: false, next, notes: info.notes || [] };
}

// Write a planned change (after a dated backup of the existing file). Returns the backup path or ''.
function applyJsonPlan(plan, now) {
  if (!plan.changed) return '';
  fs.mkdirSync(path.dirname(plan.path), { recursive: true });
  const backupPath = plan.existed ? createDatedBackup(plan.path, now) : '';
  atomicWriteJson(plan.path, plan.next);
  return backupPath;
}

// ---------------------------------------------------------------------------------------------
// The individual files
// ---------------------------------------------------------------------------------------------

function claudeSettingsPath(homeDir) {
  return path.join(homeDir, '.claude', 'settings.json');
}

function claudeJsonPath(homeDir) {
  return path.join(homeDir, '.claude.json');
}

function antigravityPaths(homeDir) {
  return {
    hooks: path.join(homeDir, '.gemini', 'config', 'hooks.json'),
    mcpPrimary: path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp_config.json'),
    mcpSecondary: path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
  };
}

// Claude Code settings.json: remove our own (and the predecessor's) hook entries one by one, keep every
// other hook and every group that still has one, then (install) append ours.
function transformClaudeSettings(filePath, data, { repoRoot, nodePath, isInstall }) {
  if (data.hooks !== undefined && !isPlainObject(data.hooks)) {
    if (isInstall) throw new InstallProblem(filePath, '"hooks" must be a JSON object');
    return {};
  }
  const hooks = isPlainObject(data.hooks) ? data.hooks : {};
  let removedAny = false;

  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) {
      if (isInstall && CLAUDE_HOOK_EVENTS.includes(event)) {
        throw new InstallProblem(filePath, `"hooks.${event}" must be a JSON array`);
      }
      continue;
    }
    const keptGroups = [];
    let removedHere = 0;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const { kept, removed } = stripManagedHandlers(group.hooks);
      removedHere += removed;
      if (removed === 0) keptGroups.push(group);
      else if (kept.length > 0) keptGroups.push({ ...group, hooks: kept }); // the user's other hooks stay
    }
    if (removedHere === 0) continue;
    removedAny = true;
    if (keptGroups.length > 0 || isInstall) hooks[event] = keptGroups;
    else delete hooks[event];
  }

  if (isInstall) {
    const scriptPath = path.join(repoRoot, 'src', 'hooks', 'claude.mjs');
    for (const spec of CLAUDE_HOOK_SPECS) {
      if (!Array.isArray(hooks[spec.event])) hooks[spec.event] = [];
      hooks[spec.event].push({
        matcher: spec.matcher,
        hooks: [buildClaudeHookHandler({ nodePath, scriptPath, arg: spec.arg, timeout: spec.timeout })],
      });
    }
    data.hooks = hooks;
  } else if (removedAny && isPlainObject(data.hooks) && Object.keys(data.hooks).length === 0) {
    delete data.hooks;
  }

  // The first release also wrote an `mcpServers` entry into settings.json; remove it when it is ours.
  if (isPlainObject(data.mcpServers)) {
    for (const key of [MCP_SERVER_KEY, LEGACY_MCP_SERVER_KEY]) {
      if (Object.prototype.hasOwnProperty.call(data.mcpServers, key)
        && describeMcpEntry(data.mcpServers[key], { repoRoot }).ours) {
        delete data.mcpServers[key];
      }
    }
  }
  return {};
}

// Antigravity hooks.json: { "<group>": { "<Event>": [handler, ...] } }. Only handlers carrying our marker
// are replaced or removed in the `herdr-cortex` group; of the predecessor's group only its own handlers go.
function transformAntigravityHooks(filePath, data, { repoRoot, nodePath, isInstall }) {
  const stripGroup = (key) => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) return;
    const group = data[key];
    if (!isPlainObject(group)) {
      if (isInstall && key === AGY_HOOK_KEY) {
        throw new InstallProblem(filePath, `"${key}" must be a JSON object`);
      }
      return;
    }
    let removedAny = false;
    for (const event of Object.keys(group)) {
      if (!Array.isArray(group[event])) {
        if (isInstall && key === AGY_HOOK_KEY && ANTIGRAVITY_HOOK_SPECS.some((spec) => spec.event === event)) {
          throw new InstallProblem(filePath, `"${key}.${event}" must be a JSON array`);
        }
        continue;
      }
      const { kept, removed } = stripManagedHandlers(group[event]);
      if (removed === 0) continue;
      removedAny = true;
      if (kept.length > 0) group[event] = kept;
      else delete group[event];
    }
    if (removedAny && Object.keys(group).length === 0) delete data[key];
  };

  stripGroup(LEGACY_AGY_HOOK_KEY);
  stripGroup(AGY_HOOK_KEY);

  if (isInstall) {
    const scriptPath = path.join(repoRoot, 'src', 'hooks', 'antigravity.mjs');
    const group = isPlainObject(data[AGY_HOOK_KEY]) ? data[AGY_HOOK_KEY] : {};
    for (const spec of ANTIGRAVITY_HOOK_SPECS) {
      let command;
      try {
        command = buildShellHookCommand({ nodePath, scriptPath, arg: spec.arg });
      } catch (err) {
        throw new InstallProblem(filePath, `cannot write the Antigravity hook command: ${err.message}`);
      }
      const list = Array.isArray(group[spec.event]) ? group[spec.event] : [];
      list.push({ type: 'command', command, timeout: spec.timeout });
      group[spec.event] = list;
    }
    data[AGY_HOOK_KEY] = group;
  }
  return {};
}

// `mcpServers` of an MCP configuration file: drop the old `cortex` entry when it is ours, then (install)
// set `herdr-cortex`, refusing to overwrite an entry of that name that is not ours.
function transformMcpServers(filePath, data, { repoRoot, nodePath, isInstall, claudeShape = false }) {
  const notes = [];
  if (data.mcpServers !== undefined && !isPlainObject(data.mcpServers)) {
    if (isInstall) throw new InstallProblem(filePath, '"mcpServers" must be a JSON object');
    return { notes };
  }
  const servers = isPlainObject(data.mcpServers) ? data.mcpServers : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(servers, key);

  if (has(LEGACY_MCP_SERVER_KEY)) {
    if (describeMcpEntry(servers[LEGACY_MCP_SERVER_KEY], { repoRoot }).ours) {
      delete servers[LEGACY_MCP_SERVER_KEY];
      notes.push(`the entry under the old name "${LEGACY_MCP_SERVER_KEY}" was removed`);
    } else {
      notes.push(`an MCP server named "${LEGACY_MCP_SERVER_KEY}" that is not herdr-cortex was left untouched`);
    }
  }

  if (has(MCP_SERVER_KEY) && !describeMcpEntry(servers[MCP_SERVER_KEY], { repoRoot }).ours) {
    if (isInstall) {
      throw new InstallProblem(
        filePath,
        `already has an MCP server named "${MCP_SERVER_KEY}" that does not start herdr-cortex's src/mcp/server.mjs. `
        + 'It was not overwritten: remove or rename that entry, then run the installer again',
      );
    }
    notes.push(`an MCP server named "${MCP_SERVER_KEY}" that is not herdr-cortex was left untouched`);
    return { notes };
  }

  if (isInstall) {
    const wanted = buildMcpServerEntry(repoRoot, nodePath, { claudeShape });
    if (!has(MCP_SERVER_KEY) || !sameMcpCommand(servers[MCP_SERVER_KEY], wanted)) {
      servers[MCP_SERVER_KEY] = wanted;
    }
    data.mcpServers = servers;
  } else if (has(MCP_SERVER_KEY)) {
    delete servers[MCP_SERVER_KEY];
  }
  return { notes };
}

// ---------------------------------------------------------------------------------------------
// Claude Code MCP registration through the `claude` CLI
// ---------------------------------------------------------------------------------------------

function pathEntries(env) {
  const key = Object.keys(env || {}).find((name) => name.toLowerCase() === 'path');
  const value = key ? String(env[key] || '') : '';
  return value.split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

/**
 * Absolute path of the first `name` + one of `extensions` found in the PATH of `env`, or ''.
 * Only absolute PATH entries are considered.
 */
export function findOnPath(name, { env = process.env, extensions } = {}) {
  const exts = extensions || (process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : ['']);
  for (const dir of pathEntries(env)) {
    if (!path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return '';
}

/**
 * Locate the Claude Code CLI: PATH first (`claude.exe`, then the `claude.cmd` shim of an npm installation),
 * then the native installer's default location `~/.local/bin`. Returns { path, viaCmd } or null.
 */
export function resolveClaudeCli({ env = process.env, homeDir = os.homedir() } = {}) {
  const exe = findOnPath('claude', { env, extensions: process.platform === 'win32' ? ['.exe'] : [''] });
  if (exe) return { path: exe, viaCmd: false };
  if (process.platform === 'win32') {
    const shim = findOnPath('claude', { env, extensions: ['.cmd'] });
    if (shim) return { path: shim, viaCmd: true };
  }
  const fallback = path.join(homeDir, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  try {
    if (fs.statSync(fallback).isFile()) return { path: fallback, viaCmd: false };
  } catch {
    // not installed there
  }
  return null;
}

/**
 * Run the Claude CLI with `args` and return { status, stdout, stderr } (`status` null when it could not be
 * started). Arguments are passed as an argument vector; a `.cmd` shim is started through cmd.exe with every
 * argument quoted, and refused when an argument contains a character cmd.exe would interpret.
 */
export function runClaudeCli(cli, args, { timeoutMs = 30000 } = {}) {
  const options = { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] };
  let res;
  if (cli.viaCmd) {
    const words = [cli.path, ...args];
    if (words.some((word) => /["%\r\n]/.test(word))) {
      return { status: null, stdout: '', stderr: 'an argument cannot be passed safely through cmd.exe' };
    }
    const line = `"${words.map((word) => `"${word}"`).join(' ')}"`;
    res = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { ...options, windowsVerbatimArguments: true });
  } else {
    res = spawnSync(cli.path, args, options);
  }
  return {
    status: res.error ? null : res.status,
    stdout: String(res.stdout || ''),
    stderr: res.error ? String(res.error.message || res.error) : String(res.stderr || ''),
  };
}

/** Arguments of `claude mcp add` for our server: user scope, stdio, then the command after `--`. */
export function claudeMcpAddArgs(repoRoot, nodePath) {
  const entry = buildMcpServerEntry(repoRoot, nodePath);
  return ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', MCP_SERVER_KEY, '--', entry.command, ...entry.args];
}

export function claudeMcpRemoveArgs(name) {
  return ['mcp', 'remove', name, '--scope', 'user'];
}

/**
 * Read the user-scope registration back from `~/.claude.json`:
 * { configPath, readable, error, registered, ours, thisRepo, upToDate, nodePath, nodeExists, scriptPath,
 *   scriptExists, legacyRegistered }.
 * `registered` - an entry named `herdr-cortex` exists; `ours` - it starts herdr-cortex's server;
 * `upToDate` (only with `nodePath` given) - it is exactly what the installer would write now;
 * `legacyRegistered` - an entry of ours under the old name `cortex` is still there.
 */
export function checkClaudeMcpRegistration({ homeDir, repoRoot = REPO_ROOT, nodePath = '' } = {}) {
  const configPath = claudeJsonPath(resolveHomeDir(homeDir));
  const result = {
    configPath,
    readable: true,
    error: '',
    registered: false,
    ours: false,
    thisRepo: false,
    upToDate: false,
    nodePath: '',
    nodeExists: false,
    scriptPath: '',
    scriptExists: false,
    legacyRegistered: false,
  };
  let data;
  try {
    data = readJsonStrict(configPath).data;
  } catch (err) {
    return { ...result, readable: false, error: err.message };
  }
  const servers = isPlainObject(data.mcpServers) ? data.mcpServers : {};
  const legacy = servers[LEGACY_MCP_SERVER_KEY];
  result.legacyRegistered = Boolean(legacy) && describeMcpEntry(legacy, { repoRoot }).ours;
  const entry = servers[MCP_SERVER_KEY];
  if (!entry) return result;

  const described = describeMcpEntry(entry, { repoRoot });
  result.registered = true;
  result.ours = described.ours;
  result.thisRepo = described.thisRepo;
  result.nodePath = described.nodePath;
  result.scriptPath = described.scriptPath;
  result.nodeExists = Boolean(described.nodePath) && path.isAbsolute(described.nodePath) && fs.existsSync(described.nodePath);
  result.scriptExists = Boolean(described.scriptPath) && fs.existsSync(described.scriptPath);
  result.upToDate = Boolean(nodePath) && sameMcpCommand(entry, buildMcpServerEntry(repoRoot, nodePath));
  return result;
}

// What has to happen to the user-scope registration. Throws InstallProblem for an unreadable file or
// (install) an entry named `herdr-cortex` that is not ours. Nothing is written here.
function planClaudeMcp(homeDir, { repoRoot, nodePath, isInstall }) {
  const filePath = claudeJsonPath(homeDir);
  const filePlan = planJsonFile(filePath, {
    createIfMissing: isInstall,
    transform: (data) => transformMcpServers(filePath, data, { repoRoot, nodePath, isInstall, claudeShape: true }),
  });
  const before = readJsonStrict(filePath).data;
  const servers = isPlainObject(before.mcpServers) ? before.mcpServers : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(servers, key);
  const ours = (key) => has(key) && describeMcpEntry(servers[key], { repoRoot }).ours;
  const upToDate = isInstall && has(MCP_SERVER_KEY)
    && sameMcpCommand(servers[MCP_SERVER_KEY], buildMcpServerEntry(repoRoot, nodePath));
  return {
    filePlan,
    removeLegacy: ours(LEGACY_MCP_SERVER_KEY),
    removeCurrent: ours(MCP_SERVER_KEY) && !upToDate,
    add: isInstall && !upToDate,
  };
}

// Carry out a planned registration change: through the CLI when there is one, otherwise (or when the CLI
// fails) by editing the file. Returns { method: 'cli' | 'file' | 'none', changed, backupPath, notes }.
function applyClaudeMcp(homeDir, plan, { repoRoot, nodePath, isInstall, cli, runCli, now }) {
  const filePath = claudeJsonPath(homeDir);
  const notes = [...plan.filePlan.notes];
  if (!plan.removeLegacy && !plan.removeCurrent && !plan.add) {
    return { method: 'none', changed: false, backupPath: '', notes };
  }

  if (cli) {
    const backupPath = createDatedBackup(filePath, now);
    const steps = [];
    if (plan.removeLegacy) steps.push(claudeMcpRemoveArgs(LEGACY_MCP_SERVER_KEY));
    if (plan.removeCurrent) steps.push(claudeMcpRemoveArgs(MCP_SERVER_KEY));
    if (plan.add) steps.push(claudeMcpAddArgs(repoRoot, nodePath));
    let failure = '';
    for (const args of steps) {
      const res = runCli(cli, args);
      if (res.status !== 0) {
        const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/)[0] || `exit code ${res.status}`;
        failure = `"claude ${args.slice(0, 2).join(' ')}" failed (${detail})`;
        break;
      }
    }
    if (!failure) {
      return { method: 'cli', changed: true, backupPath, notes };
    }
    notes.push(`${failure}; the file was edited directly instead`);
    // Plan again from what the file contains now: the CLI may have done part of the work.
    const again = planClaudeMcp(homeDir, { repoRoot, nodePath, isInstall });
    const secondBackup = applyJsonPlan(again.filePlan, now);
    return { method: 'file', changed: true, backupPath: backupPath || secondBackup, notes };
  }

  const backupPath = applyJsonPlan(plan.filePlan, now);
  return { method: 'file', changed: plan.filePlan.changed, backupPath, notes };
}

// ---------------------------------------------------------------------------------------------
// Skills, global store, install record
// ---------------------------------------------------------------------------------------------

function syncClaudeSkills(homeDir, repoRoot, isInstall) {
  const skillsDestRoot = path.join(homeDir, '.claude', 'skills');
  const skillsSrcRoot = path.join(repoRoot, 'prompts', 'skills');

  if (!isInstall) {
    const removed = [];
    if (!fs.existsSync(skillsDestRoot)) {
      return { path: skillsDestRoot, action: 'skipped', skills: removed };
    }
    const entries = fs.readdirSync(skillsDestRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith('cortex-')) continue;
      const targetDir = assertInsideDir(skillsDestRoot, ent.name);
      const markerPath = path.join(targetDir, SKILL_MANAGED_MARKER);
      if (fs.existsSync(markerPath)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        removed.push(ent.name);
      }
    }
    return {
      path: skillsDestRoot,
      action: removed.length > 0 ? 'removed' : 'skipped',
      skills: removed,
    };
  }

  if (!fs.existsSync(skillsSrcRoot)) {
    return { path: skillsDestRoot, action: 'skipped', skills: [] };
  }

  const srcEntries = fs.readdirSync(skillsSrcRoot, { withFileTypes: true })
    .filter((ent) => ent.isDirectory());
  if (srcEntries.length === 0) {
    return { path: skillsDestRoot, action: 'skipped', skills: [] };
  }

  fs.mkdirSync(skillsDestRoot, { recursive: true });
  const installed = [];

  for (const ent of srcEntries) {
    const srcDir = assertInsideDir(skillsSrcRoot, ent.name);
    const destName = ent.name.startsWith('cortex-') ? ent.name : `cortex-${ent.name}`;
    const destDir = assertInsideDir(skillsDestRoot, destName);

    if (fs.existsSync(destDir)) {
      const markerPath = path.join(destDir, SKILL_MANAGED_MARKER);
      if (fs.existsSync(markerPath)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      } else {
        // Do not clobber a non-cortex user-authored skill directory
        continue;
      }
    }

    fs.cpSync(srcDir, destDir, { recursive: true });
    // Sync SKILL.md frontmatter `name:` to match the installed cortex-<skill> directory name, and expand
    // `{{HERDR_CORTEX_ROOT}}` in SKILL.md and every nested file (leaving files without changes untouched).
    const skillMdPath = path.join(destDir, 'SKILL.md');
    if (fs.existsSync(skillMdPath) && fs.statSync(skillMdPath).isFile()) {
      const rawFile = fs.readFileSync(skillMdPath, 'utf8');
      const rawSkill = rawFile.replace(/^\uFEFF/, '');
      const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(rawSkill);
      let nextSkill = rawFile;
      if (fmMatch) {
        const fmBody = fmMatch[1];
        const eol = rawSkill.includes('\r\n') ? '\r\n' : '\n';
        const updatedFmBody = /^name\s*:\s*.*$/m.test(fmBody)
          ? fmBody.replace(/^name\s*:\s*.*$/m, `name: ${destName}`)
          : `name: ${destName}${eol}${fmBody}`;
        nextSkill = `---${eol}${updatedFmBody}${eol}---${rawSkill.slice(fmMatch[0].length)}`;
      }
      nextSkill = expandCortexRootPlaceholder(nextSkill, repoRoot);
      if (nextSkill !== rawFile) {
        atomicWriteText(skillMdPath, nextSkill);
      }
    }

    const expandSubtreePlaceholders = (dir) => {
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
        const childPath = assertInsideDir(destDir, path.join(dir, child.name));
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          expandSubtreePlaceholders(childPath);
          continue;
        }
        if (!child.isFile()) continue;
        if (childPath === skillMdPath || child.name === SKILL_MANAGED_MARKER) continue;
        const buf = fs.readFileSync(childPath);
        if (!buf.includes(CORTEX_ROOT_PLACEHOLDER)) continue;
        const rawText = buf.toString('utf8');
        const expanded = expandCortexRootPlaceholder(rawText, repoRoot);
        if (expanded !== rawText) {
          atomicWriteText(childPath, expanded);
        }
      }
    };
    expandSubtreePlaceholders(destDir);

    atomicWriteText(path.join(destDir, SKILL_MANAGED_MARKER), `managed-by=herdr-cortex\nsource=${srcDir}\n`);
    installed.push(destName);
  }

  return {
    path: skillsDestRoot,
    action: installed.length > 0 ? 'installed' : 'skipped',
    skills: installed,
  };
}

// Run `fn` without the warnings `loadConfig` prints on stderr (the caller reports the problems itself).
function withoutConsoleWarnings(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

/**
 * The problems of the global configuration as the status reporting describes them (old-format keys, unknown
 * provider, missing key, ...): a list of message strings. No network request is made.
 */
export function describeGlobalConfigProblems(globalDir) {
  return withoutConsoleWarnings(() => {
    const config = loadConfig({ globalDir });
    const messages = [
      ...getConfigProblems(config).map((problem) => problem.message),
      ...describeEmbeddingStatus(config).problems.map((problem) => problem.message),
    ];
    return [...new Set(messages)];
  });
}

/**
 * Inspect a parsed global `config.json` object and migrate flat `embedding.*` legacy keys into
 * `embedding.<provider>.*` when `embedding.provider` names a specific provider (`gemini`, `openai`,
 * `ollama`, `onnx`). Existing keys inside `embedding.<provider>` are never overwritten (the legacy key
 * is dropped); legacy keys with no equivalent in that provider's block (unused by that provider) are
 * also deleted and reported under `removedUnused`.
 */
export function migrateGlobalEmbeddingConfig(rawConfig) {
  const base = {
    changed: false,
    legacyKeys: [],
    provider: '',
    providerDisplay: 'not set',
    providerValid: false,
    moved: [],
    keptExisting: [],
    removedUnused: [],
    skipReason: '',
  };
  if (!isPlainObject(rawConfig) || !isPlainObject(rawConfig.embedding)) {
    return base;
  }
  const legacyKeys = findLegacyEmbeddingKeys(rawConfig.embedding);
  if (legacyKeys.length === 0) {
    return base;
  }

  const rawProvider = rawConfig.embedding.provider;
  const provider = typeof rawProvider === 'string' ? rawProvider.trim().toLowerCase() : '';
  let providerDisplay = 'not set';
  if (typeof rawProvider === 'string' && rawProvider.trim() !== '') {
    providerDisplay = JSON.stringify(rawProvider.trim());
  } else if (rawProvider !== undefined && rawProvider !== null && rawProvider !== '') {
    providerDisplay = JSON.stringify(rawProvider);
  }

  if (!EMBEDDING_PROVIDER_NAMES.includes(provider)) {
    return {
      ...base,
      legacyKeys,
      provider,
      providerDisplay,
      skipReason: 'no_specific_provider',
    };
  }

  const existingProviderVal = rawConfig.embedding[provider];
  if (existingProviderVal !== undefined && !isPlainObject(existingProviderVal)) {
    return {
      ...base,
      legacyKeys,
      provider,
      providerDisplay,
      providerValid: true,
      skipReason: 'invalid_provider_block',
    };
  }

  const targets = LEGACY_EMBEDDING_KEY_TARGETS[provider] || {};
  const existingBlock = isPlainObject(existingProviderVal) ? existingProviderVal : null;
  const next = clone(rawConfig);
  const moved = [];
  const keptExisting = [];
  const removedUnused = [];

  for (const key of legacyKeys) {
    const targetKey = targets[key];
    if (!targetKey) {
      delete next.embedding[key];
      removedUnused.push({ from: `embedding.${key}`, key });
      continue;
    }
    if (existingBlock && Object.prototype.hasOwnProperty.call(existingBlock, targetKey)) {
      delete next.embedding[key];
      keptExisting.push({ from: `embedding.${key}`, to: `embedding.${provider}.${targetKey}`, key, targetKey });
      continue;
    }
    if (!isPlainObject(next.embedding[provider])) next.embedding[provider] = {};
    next.embedding[provider][targetKey] = next.embedding[key];
    delete next.embedding[key];
    moved.push({ from: `embedding.${key}`, to: `embedding.${provider}.${targetKey}`, key, targetKey });
  }

  const changed = moved.length > 0 || keptExisting.length > 0 || removedUnused.length > 0;
  return {
    changed,
    ...(changed ? { next } : {}),
    legacyKeys,
    provider,
    providerDisplay,
    providerValid: true,
    moved,
    keptExisting,
    removedUnused,
    skipReason: '',
  };
}

// What to do with the global config.json: create it, replace an untouched old default, migrate legacy keys, or leave it.
function planGlobalConfig(globalDir) {
  const configPath = path.join(globalDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { configPath, action: 'created', problems: [], migration: null };
  }
  let parsed;
  try {
    parsed = readJsonStrict(configPath).data;
  } catch (err) {
    return { configPath, action: 'kept', problems: [`${err.message}; it is ignored until it is fixed`], migration: null };
  }
  if (OLD_DEFAULT_CONFIGS.some((oldDefault) => isDeepStrictEqual(parsed, oldDefault))) {
    return { configPath, action: 'replaced', problems: [], migration: null };
  }
  const migration = migrateGlobalEmbeddingConfig(parsed);
  if (migration.changed) {
    return { configPath, action: 'migrated', next: migration.next, problems: [], migration };
  }
  return {
    configPath,
    action: 'kept',
    problems: describeGlobalConfigProblems(globalDir),
    migration: migration.legacyKeys.length > 0 ? migration : null,
  };
}

function applyGlobalConfig(globalDir, plan, now) {
  fs.mkdirSync(path.join(globalDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(globalDir, 'docs'), { recursive: true });
  let backupPath = '';
  let problems = plan.problems;
  if (plan.action === 'replaced') {
    backupPath = createDatedBackup(plan.configPath, now);
    atomicWriteJson(plan.configPath, DEFAULT_CONFIG);
  } else if (plan.action === 'migrated') {
    backupPath = createDatedBackup(plan.configPath, now);
    atomicWriteJson(plan.configPath, plan.next);
    problems = describeGlobalConfigProblems(globalDir);
  } else if (plan.action === 'created') {
    atomicWriteJson(plan.configPath, DEFAULT_CONFIG);
  }
  return {
    globalDir,
    configPath: plan.configPath,
    configAction: plan.action,
    configProblems: problems,
    migration: plan.migration || null,
    backupPath,
  };
}

export function getInstallRecordPath(globalDir) {
  return path.join(globalDir, 'state', INSTALL_RECORD_FILE);
}

/** The record of the last install ({ nodePath, repoRoot, installedAt, ... }) or null. */
export function readInstallRecord(globalDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getInstallRecordPath(globalDir), 'utf8').replace(/^\uFEFF/, ''));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Antigravity counts as present when its configuration folder `~/.gemini` exists or `agy` is on PATH.
 * Returns 'config-dir', 'path' or ''.
 */
export function detectAntigravity({ homeDir, env = process.env, findCommand = findOnPath } = {}) {
  if (fs.existsSync(path.join(homeDir, '.gemini'))) return 'config-dir';
  return findCommand('agy', { env }) ? 'path' : '';
}

// ---------------------------------------------------------------------------------------------
// Checks for status displays (read-only)
// ---------------------------------------------------------------------------------------------

function sameFile(a, b) {
  return Boolean(a) && Boolean(b) && pathKey(a) === pathKey(b);
}

// Problems of one of our hook entries: [{ code, message }]. `expectedScript` is the hook script of this repository.
function checkOwnHookEntry(hook, { expectedScript, expectedArgs }) {
  const problems = [];
  const info = describeOwnHook(hook);
  if (!path.isAbsolute(info.nodePath)) {
    problems.push({ code: 'node_on_path', message: `starts "${info.nodePath || 'node'}" by name, which only works while node is on PATH` });
  } else if (!fs.existsSync(info.nodePath)) {
    problems.push({ code: 'node_missing', message: `the recorded Node path does not exist: ${info.nodePath}` });
  }
  if (!info.scriptPath || !fs.existsSync(info.scriptPath)) {
    problems.push({ code: 'script_missing', message: `the hook script does not exist: ${info.scriptPath || '(none)'}` });
  } else if (!sameFile(info.scriptPath, expectedScript)) {
    problems.push({ code: 'other_repo', message: `points at another folder: ${info.scriptPath}` });
  }
  if (Array.isArray(expectedArgs) && expectedArgs.length > 0 && !expectedArgs.includes(info.arg)) {
    const target = expectedArgs.map((arg) => `"${arg}"`).join(' / ');
    problems.push({ code: 'other_event', message: `runs "${info.arg}" instead of ${target}` });
  }
  return { info, problems };
}

function summarizeHookEvent(found, { expectedScript, expectedArg, expectedArgs: expectedArgsOption, expectedMatcher }) {
  if (found.length === 0) {
    return { state: 'missing', count: 0, problems: [{ code: 'missing', message: 'not registered' }] };
  }
  const expectedArgs = Array.isArray(expectedArgsOption)
    ? expectedArgsOption
    : (expectedArg ? [expectedArg] : []);
  const rawProblems = [];

  if (expectedArgs.length <= 1 && found.length > 1) {
    rawProblems.push({ code: 'duplicate', message: `registered ${found.length} times` });
  }

  const checked = found.map((item) => ({
    matcher: item.matcher,
    ...checkOwnHookEntry(item.hook, { expectedScript, expectedArgs }),
  }));

  if (expectedArgs.length > 1) {
    const counts = new Map(expectedArgs.map((arg) => [arg, 0]));
    for (const item of checked) {
      if (counts.has(item.info.arg)) counts.set(item.info.arg, counts.get(item.info.arg) + 1);
    }
    if ([...counts.values()].some((count) => count > 1) || found.length > expectedArgs.length) {
      rawProblems.push({ code: 'duplicate', message: `registered ${found.length} times` });
    }
  }

  for (const item of checked) {
    rawProblems.push(...item.problems);
    if (expectedMatcher !== undefined && item.matcher !== expectedMatcher) {
      rawProblems.push({ code: 'matcher', message: `matcher is "${item.matcher}" instead of "${expectedMatcher}"` });
    }
  }

  if (expectedArgs.length > 1) {
    const seenArgs = new Set(checked.map((item) => item.info.arg));
    for (const reqArg of expectedArgs) {
      if (!seenArgs.has(reqArg)) {
        rawProblems.push({ code: 'missing', message: `missing "${reqArg}" hook` });
      }
    }
  }

  const seenMessages = new Set();
  const problems = [];
  for (const problem of rawProblems) {
    const key = `${problem.code}\0${problem.message}`;
    if (seenMessages.has(key)) continue;
    seenMessages.add(key);
    problems.push(problem);
  }

  const first = checked[0];
  return {
    state: problems.length === 0 ? 'ok' : problems[0].code,
    count: found.length,
    form: first.info.form,
    nodePath: first.info.nodePath,
    scriptPath: first.info.scriptPath,
    problems,
  };
}

/**
 * Check the Claude Code hook registration, event by event, counting only entries that carry our marker
 * (`isOwnHook`): { settingsPath, readable, error, ok, events: { <Event>: { state, count, form, nodePath,
 * scriptPath, problems: [{ code, message }] } } }.
 * `state` is 'ok' or the code of the first problem: missing | duplicate | node_on_path | node_missing |
 * script_missing | other_repo | other_event | matcher.
 */
export function checkClaudeHooks({ homeDir, repoRoot = REPO_ROOT } = {}) {
  const settingsPath = claudeSettingsPath(resolveHomeDir(homeDir));
  const result = { settingsPath, readable: true, error: '', ok: false, events: {} };
  let data;
  try {
    data = readJsonStrict(settingsPath).data;
  } catch (err) {
    return { ...result, readable: false, error: err.message };
  }
  const hooks = isPlainObject(data.hooks) ? data.hooks : {};
  const expectedScript = path.join(path.resolve(repoRoot), 'src', 'hooks', 'claude.mjs');
  for (const event of CLAUDE_HOOK_EVENTS) {
    const specs = CLAUDE_HOOK_SPECS.filter((spec) => spec.event === event);
    if (specs.length === 0) continue;
    const found = [];
    for (const group of Array.isArray(hooks[event]) ? hooks[event] : []) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (isOwnHook(hook)) found.push({ hook, matcher: typeof group.matcher === 'string' ? group.matcher : '' });
      }
    }
    result.events[event] = summarizeHookEvent(found, {
      expectedScript,
      expectedArgs: specs.map((spec) => spec.arg),
      expectedMatcher: event === 'PreToolUse' ? specs[0].matcher : undefined,
    });
  }
  result.ok = Object.values(result.events).every((event) => event.state === 'ok');
  return result;
}

/**
 * Check the Antigravity registration: { present, detectedBy, hooksPath, readable, error, ok, events: {
 * SessionStart, PreInvocation }, mcp: { path, state } } with `events` as in `checkClaudeHooks` and mcp.state
 * one of ok | missing | not_ours | node_on_path | node_missing | script_missing | unreadable.
 * Antigravity is looked for the way the installer does (`detectAntigravity`, with the same `env` and
 * `findCommand`): `detectedBy` is 'config-dir' (the `~/.gemini` folder exists), 'path' (`agy` is on PATH) or
 * ''. `present` is false when neither was found (nothing else is filled in then); with 'path' alone the
 * files do not exist yet, so the events and the MCP entry read as missing.
 */
export function checkAntigravity({ homeDir, repoRoot = REPO_ROOT, env = process.env, findCommand = findOnPath } = {}) {
  const resolvedHome = resolveHomeDir(homeDir);
  const agyPaths = antigravityPaths(resolvedHome);
  const detectedBy = detectAntigravity({ homeDir: resolvedHome, env, findCommand });
  const result = {
    present: Boolean(detectedBy),
    detectedBy,
    hooksPath: agyPaths.hooks,
    readable: true,
    error: '',
    ok: false,
    events: {},
    mcp: { path: agyPaths.mcpPrimary, state: 'missing' },
  };
  if (!result.present) return result;

  let data;
  try {
    data = readJsonStrict(agyPaths.hooks).data;
  } catch (err) {
    result.readable = false;
    result.error = err.message;
    data = {};
  }
  const group = isPlainObject(data[AGY_HOOK_KEY]) ? data[AGY_HOOK_KEY] : {};
  const expectedScript = path.join(path.resolve(repoRoot), 'src', 'hooks', 'antigravity.mjs');
  for (const spec of ANTIGRAVITY_HOOK_SPECS) {
    const found = (Array.isArray(group[spec.event]) ? group[spec.event] : [])
      .filter((hook) => isOwnHook(hook))
      .map((hook) => ({ hook, matcher: '' }));
    result.events[spec.event] = summarizeHookEvent(found, { expectedScript, expectedArg: spec.arg });
  }

  try {
    const servers = readJsonStrict(agyPaths.mcpPrimary).data.mcpServers;
    const entry = isPlainObject(servers) ? servers[MCP_SERVER_KEY] : null;
    if (entry) {
      const described = describeMcpEntry(entry, { repoRoot });
      if (!described.ours) result.mcp.state = 'not_ours';
      else if (!path.isAbsolute(described.nodePath)) result.mcp.state = 'node_on_path';
      else if (!fs.existsSync(described.nodePath)) result.mcp.state = 'node_missing';
      else if (!fs.existsSync(described.scriptPath)) result.mcp.state = 'script_missing';
      else result.mcp.state = 'ok';
      result.mcp.nodePath = described.nodePath;
    }
  } catch {
    result.mcp.state = 'unreadable';
  }

  result.ok = result.readable
    && Object.values(result.events).every((event) => event.state === 'ok')
    && result.mcp.state === 'ok';
  return result;
}

// The real CLI is used only for the real home directory: never when a home directory was passed in or one
// of the test-home variables is set (those runs edit the files of that home directly).
function isRealHomeRun(homeDirOption) {
  return !homeDirOption && !process.env.HERDR_CORTEX_TEST_HOME && !process.env.HERDR_REVIVE_TEST_HOME;
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------------------------

/**
 * Install the herdr-cortex hooks, the MCP registration, the global store and the Claude skills.
 *
 * Every file that will be touched is read and checked first; when any of them has a problem (not valid JSON,
 * an unexpected structure, an MCP server named `herdr-cortex` that is not ours) nothing at all is changed
 * and the result is `{ ok: false, problems: [{ file, message }] }`.
 * A file is rewritten only when its content changes, after a copy `<file>.herdr-cortex.<stamp>.bak`.
 *
 * Options: `repoRoot`; `homeDir` (a home directory other than the real one; its files are edited directly);
 * `globalDir` (the global store; default: `resolveGlobalDir`, i.e. `<homeDir>/.herdr-cortex` for a given
 * `homeDir`, otherwise HERDR_CORTEX_HOME, the test home, the user's home, in that order);
 * `nodePath` (default: the Node running this; recorded as an absolute path in every hook and MCP entry);
 * `claudeCli` ({ path, viaCmd }, `null` = never use the CLI; default: located, but only when installing into
 * the real home); `runCli`; `antigravityPresent` (default: detected); `verifyDelayMs`; `sleep`; `now`; `env`.
 */
export function installCortex({
  repoRoot = REPO_ROOT,
  homeDir,
  globalDir: globalDirOption,
  nodePath = process.execPath,
  claudeCli,
  runCli = runClaudeCli,
  antigravityPresent,
  verifyDelayMs,
  sleep = sleepSync,
  now = new Date(),
  env = process.env,
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedHome = resolveHomeDir(homeDir);
  const realRun = isRealHomeRun(homeDir);
  const globalDir = resolveGlobalDir({ globalDir: globalDirOption, homeDir });
  const agyPaths = antigravityPaths(resolvedHome);
  const context = { repoRoot: resolvedRoot, nodePath, isInstall: true };
  const base = { action: 'install', homeDir: resolvedHome, repoRoot: resolvedRoot, nodePath };

  const antigravity = antigravityPresent === undefined
    ? detectAntigravity({ homeDir: resolvedHome, env })
    : (antigravityPresent ? 'given' : '');

  // 1. Read and check everything. Nothing is written in this block.
  const problems = [];
  const attempt = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (!(err instanceof InstallProblem)) throw err;
      problems.push({ file: err.file, message: err.message });
      return null;
    }
  };
  if (typeof nodePath !== 'string' || !path.isAbsolute(nodePath) || !fs.existsSync(nodePath)) {
    problems.push({ file: String(nodePath), message: 'is not the absolute path of an existing Node executable' });
  }
  const settingsFile = claudeSettingsPath(resolvedHome);
  const settingsPlan = attempt(() => planJsonFile(settingsFile, {
    transform: (data) => transformClaudeSettings(settingsFile, data, context),
  }));
  const claudeMcpPlan = attempt(() => planClaudeMcp(resolvedHome, context));
  const agyPlans = antigravity
    ? {
        hooks: attempt(() => planJsonFile(agyPaths.hooks, {
          transform: (data) => transformAntigravityHooks(agyPaths.hooks, data, context),
        })),
        mcpPrimary: attempt(() => planJsonFile(agyPaths.mcpPrimary, {
          transform: (data) => transformMcpServers(agyPaths.mcpPrimary, data, context),
        })),
        // Updated only when it already exists.
        mcpSecondary: attempt(() => planJsonFile(agyPaths.mcpSecondary, {
          createIfMissing: false,
          transform: (data) => transformMcpServers(agyPaths.mcpSecondary, data, context),
        })),
      }
    : null;
  const configPlan = planGlobalConfig(globalDir);

  if (problems.length > 0) {
    return { ...base, ok: false, problems, backups: [], notes: [] };
  }

  // 2. Apply.
  const backups = [];
  const notes = [];
  const fileResult = (plan, label) => {
    if (plan.missing) return { path: plan.path, action: 'skipped', changed: false, backupPath: '' };
    const backupPath = applyJsonPlan(plan, now);
    if (backupPath) backups.push(backupPath);
    for (const note of plan.notes) notes.push(`${label}: ${note}`);
    return { path: plan.path, action: 'installed', changed: plan.changed, backupPath };
  };
  const untouched = (filePath) => ({ path: filePath, action: 'skipped', changed: false, backupPath: '' });

  const globalInit = applyGlobalConfig(globalDir, configPlan, now);
  if (globalInit.backupPath) backups.push(globalInit.backupPath);

  const antigravityHooks = agyPlans ? fileResult(agyPlans.hooks, 'Antigravity hooks') : untouched(agyPaths.hooks);
  const antigravityMcp = agyPlans
    ? [fileResult(agyPlans.mcpPrimary, 'Antigravity MCP'), fileResult(agyPlans.mcpSecondary, 'Antigravity MCP')]
    : [untouched(agyPaths.mcpPrimary), untouched(agyPaths.mcpSecondary)];

  const claudeSettings = fileResult(settingsPlan, 'Claude Code hooks');

  const cli = claudeCli === undefined ? (realRun ? resolveClaudeCli({ env }) : null) : claudeCli;
  const mcpApplied = applyClaudeMcp(resolvedHome, claudeMcpPlan, { ...context, cli, runCli, now });
  if (mcpApplied.backupPath) backups.push(mcpApplied.backupPath);
  for (const note of mcpApplied.notes) notes.push(`Claude Code MCP: ${note}`);

  const skills = syncClaudeSkills(resolvedHome, resolvedRoot, true);

  const installRecordPath = getInstallRecordPath(globalDir);
  atomicWriteJson(installRecordPath, {
    version: 1,
    installedAt: now.toISOString(),
    repoRoot: resolvedRoot,
    nodePath,
    nodeVersion: process.version,
    antigravity: Boolean(antigravity),
  });

  // 3. A running Claude Code rewrites ~/.claude.json from memory and can drop the entry again: look once more.
  sleep(verifyDelayMs === undefined ? (realRun ? CLAUDE_MCP_VERIFY_DELAY_MS : 0) : verifyDelayMs);
  const registration = checkClaudeMcpRegistration({ homeDir: resolvedHome, repoRoot: resolvedRoot, nodePath });

  return {
    ...base,
    ok: true,
    problems: [],
    notes,
    backups,
    antigravityPresent: Boolean(antigravity),
    antigravityDetectedBy: antigravity,
    globalInit,
    antigravityHooks,
    antigravityMcp,
    claudeSettings,
    claudeMcp: {
      path: claudeJsonPath(resolvedHome),
      action: 'installed',
      changed: mcpApplied.changed,
      backupPath: mcpApplied.backupPath,
      method: mcpApplied.method,
      cliAvailable: Boolean(cli),
      verified: registration.registered && registration.upToDate,
      registration,
    },
    skills,
    installRecordPath,
  };
}

/**
 * Remove what `installCortex` registered: our hook entries (one by one; the user's own hooks and every
 * group that still has one stay), MCP entries that are ours, the managed skills and the install record.
 * A file that cannot be read is skipped and reported in `problems`; the others are still cleaned.
 * Antigravity files are cleaned whenever they exist.
 */
export function uninstallCortex({
  repoRoot = REPO_ROOT,
  homeDir,
  globalDir: globalDirOption,
  claudeCli,
  runCli = runClaudeCli,
  now = new Date(),
  env = process.env,
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedHome = resolveHomeDir(homeDir);
  const realRun = isRealHomeRun(homeDir);
  const globalDir = resolveGlobalDir({ globalDir: globalDirOption, homeDir });
  const agyPaths = antigravityPaths(resolvedHome);
  const context = { repoRoot: resolvedRoot, nodePath: '', isInstall: false };

  const problems = [];
  const backups = [];
  const notes = [];
  const cleanFile = (filePath, transform, label) => {
    const skipped = { path: filePath, action: 'skipped', changed: false, backupPath: '' };
    let plan;
    try {
      plan = planJsonFile(filePath, { createIfMissing: false, transform: (data) => transform(filePath, data, context) });
    } catch (err) {
      if (!(err instanceof InstallProblem)) throw err;
      problems.push({ file: err.file, message: `${err.message}; it was left as it is` });
      return skipped;
    }
    for (const note of plan.notes) notes.push(`${label}: ${note}`);
    if (plan.missing || !plan.changed) return skipped;
    const backupPath = applyJsonPlan(plan, now);
    if (backupPath) backups.push(backupPath);
    return { path: filePath, action: 'removed', changed: true, backupPath };
  };

  const antigravityHooks = cleanFile(agyPaths.hooks, transformAntigravityHooks, 'Antigravity hooks');
  const antigravityMcp = [
    cleanFile(agyPaths.mcpPrimary, transformMcpServers, 'Antigravity MCP'),
    cleanFile(agyPaths.mcpSecondary, transformMcpServers, 'Antigravity MCP'),
  ];
  const claudeSettings = cleanFile(claudeSettingsPath(resolvedHome), transformClaudeSettings, 'Claude Code hooks');

  let claudeMcp = { path: claudeJsonPath(resolvedHome), action: 'skipped', changed: false, backupPath: '', method: 'none' };
  try {
    const plan = planClaudeMcp(resolvedHome, context);
    const cli = claudeCli === undefined ? (realRun ? resolveClaudeCli({ env }) : null) : claudeCli;
    const applied = applyClaudeMcp(resolvedHome, plan, { ...context, cli, runCli, now });
    if (applied.backupPath) backups.push(applied.backupPath);
    for (const note of applied.notes) notes.push(`Claude Code MCP: ${note}`);
    claudeMcp = {
      path: claudeJsonPath(resolvedHome),
      action: applied.changed ? 'removed' : 'skipped',
      changed: applied.changed,
      backupPath: applied.backupPath,
      method: applied.method,
    };
  } catch (err) {
    if (!(err instanceof InstallProblem)) throw err;
    problems.push({ file: err.file, message: `${err.message}; it was left as it is` });
  }

  const skills = syncClaudeSkills(resolvedHome, resolvedRoot, false);

  try {
    fs.unlinkSync(getInstallRecordPath(globalDir));
  } catch {
    // no record
  }

  return {
    action: 'uninstall',
    ok: problems.length === 0,
    homeDir: resolvedHome,
    repoRoot: resolvedRoot,
    problems,
    notes,
    backups,
    antigravityHooks,
    antigravityMcp,
    claudeSettings,
    claudeMcp,
    skills,
  };
}

/**
 * Every backup file this tool created for the configuration files of `homeDir`, plus those next to the
 * `extraFiles` (the PowerShell profiles, which the PowerShell scripts back up under the same naming).
 */
export function listBackups({ homeDir, globalDir, extraFiles = [] } = {}) {
  const resolvedHome = resolveHomeDir(homeDir);
  const agyPaths = antigravityPaths(resolvedHome);
  const files = [
    claudeSettingsPath(resolvedHome),
    claudeJsonPath(resolvedHome),
    agyPaths.hooks,
    agyPaths.mcpPrimary,
    agyPaths.mcpSecondary,
    path.join(resolveGlobalDir({ globalDir, homeDir }), 'config.json'),
    ...extraFiles.map((file) => path.resolve(file)),
  ];
  return [...new Set(files.flatMap((file) => findBackups(file)))];
}

/** Delete the files `listBackups` finds. Returns { removed: [...], failed: [{ path, error }] }. */
export function removeBackups(options = {}) {
  const removed = [];
  const failed = [];
  for (const backupPath of listBackups(options)) {
    try {
      fs.unlinkSync(backupPath);
      removed.push(backupPath);
    } catch (err) {
      failed.push({ path: backupPath, error: String(err?.code || err?.message || err) });
    }
  }
  return { removed, failed };
}

/** The embedding status lines of the global configuration (where documents would be sent, or that it is off). */
export function describeInstalledEmbedding({ homeDir, globalDir: globalDirOption } = {}) {
  const globalDir = resolveGlobalDir({ globalDir: globalDirOption, homeDir });
  return withoutConsoleWarnings(() => formatEmbeddingStatus(describeEmbeddingStatus(loadConfig({ globalDir }))));
}

/** The lines the command line prints for an install or uninstall result. */
export function formatInstallSummary(res) {
  const lines = [];
  const tag = (action) => (action === 'skipped' ? '[SKIP]' : '[OK]');
  const isInstall = res.action === 'install';

  if (isInstall) {
    lines.push(`[OK] Node for hooks and MCP server: ${res.nodePath}`);
    const init = res.globalInit;
    if (init.configAction === 'created') {
      lines.push(`[OK] Global store: ${init.globalDir} (config.json created)`);
    } else if (init.configAction === 'replaced') {
      lines.push(`[OK] Global store: ${init.globalDir}`);
      lines.push('[OK] config.json was still the default of an older version (embedding provider "auto"); '
        + 'it was replaced by the current default (embedding off).');
    } else if (init.configAction === 'migrated') {
      const mig = init.migration;
      const backupNote = init.backupPath ? ` (backup: ${init.backupPath})` : '';
      lines.push(`[OK] Global store: ${init.globalDir}`);
      if (mig?.moved?.length > 0) {
        lines.push(
          `[OK] Migrated legacy embedding setting(s) in ${init.configPath}: `
          + `${mig.moved.map((m) => `${m.from} -> ${m.to}`).join(', ')}`
          + backupNote,
        );
      }
      if (mig?.keptExisting?.length > 0) {
        lines.push(
          `[OK] Removed legacy embedding key(s) in ${init.configPath} because the target key(s) already existed (existing values kept): `
          + `${mig.keptExisting.map((m) => `${m.from} (kept ${m.to})`).join(', ')}`
          + backupNote,
        );
      }
      if (mig?.removedUnused?.length > 0) {
        const names = mig.removedUnused.map((u) => u.from).join(', ');
        lines.push(
          `[OK] Removed unused legacy embedding key(s) in ${init.configPath} (not used by embedding.${mig.provider}): `
          + `${names}`
          + backupNote,
        );
      }
      for (const problem of init.configProblems) lines.push(`[WARN] ${init.configPath}: ${problem}`);
    } else {
      lines.push(`[OK] Global store: ${init.globalDir} (config.json kept as it is)`);
      const mig = init.migration;
      if (mig?.skipReason === 'no_specific_provider') {
        lines.push(
          `[WARN] ${init.configPath}: legacy embedding key(s) (${mig.legacyKeys.map((k) => `embedding.${k}`).join(', ')}) `
          + `were not migrated because embedding.provider is ${mig.providerDisplay}, not a specific provider name `
          + '(set embedding.provider to gemini, openai, ollama or onnx and re-run install.ps1, or move needed settings into embedding.<provider> and delete unused flat keys).',
        );
      } else if (mig?.skipReason === 'invalid_provider_block') {
        lines.push(
          `[WARN] ${init.configPath}: legacy embedding key(s) were not migrated because embedding.${mig.provider} is not a JSON object.`,
        );
      }
      for (const problem of init.configProblems) lines.push(`[WARN] ${init.configPath}: ${problem}`);
    }
    if (!res.antigravityPresent) {
      lines.push('[SKIP] Antigravity: no "agy" on PATH and no ~/.gemini folder; its configuration was not touched.');
    }
  }

  if (!isInstall || res.antigravityPresent) {
    lines.push(`${tag(res.antigravityHooks.action)} Antigravity hooks (${res.antigravityHooks.action}): ${res.antigravityHooks.path}`);
    for (const m of res.antigravityMcp) {
      if (m.action !== 'skipped') lines.push(`[OK] Antigravity MCP (${m.action}): ${m.path}`);
    }
  }
  lines.push(`${tag(res.claudeSettings.action)} Claude Code hooks (${res.claudeSettings.action}): ${res.claudeSettings.path}`);

  const mcp = res.claudeMcp;
  let how = 'nothing to change';
  if (mcp.method === 'cli') how = 'through the claude CLI';
  else if (mcp.method === 'file') how = `by editing ${mcp.path}`;
  lines.push(`${tag(mcp.action)} Claude Code MCP server "${MCP_SERVER_KEY}" (${mcp.action}; ${how})`);
  if (isInstall && mcp.method === 'file' && !mcp.cliAvailable) {
    lines.push('[NOTE] The claude CLI was not used (not found, or this is a test home), so the registration was '
      + 'written into the file directly. A running Claude Code can overwrite that file.');
  }
  if (res.skills.skills.length > 0) {
    lines.push(`[OK] Claude Code skills (${res.skills.action}): ${res.skills.skills.join(', ')}`);
  }
  for (const note of res.notes) lines.push(`[NOTE] ${note}`);
  for (const backupPath of res.backups) lines.push(`[OK] Backup: ${backupPath}`);
  for (const problem of res.problems) lines.push(`[WARN] ${problem.file}: ${problem.message}`);

  if (isInstall && !mcp.verified) {
    lines.push(`[WARN] The MCP server "${MCP_SERVER_KEY}" is missing from ${mcp.path} again: a running Claude Code `
      + 'rewrote the file. Close every Claude Code window, then run the installer again.');
  }
  return lines;
}

function parseExtraFiles(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--also' && argv[i + 1]) files.push(argv[++i]);
  }
  return files;
}

const USAGE = [
  'Usage: node --no-warnings src/hooks/installer.mjs <command>',
  '  install [repoRoot]                    register hooks, MCP server and skills; create the global store',
  '  uninstall [repoRoot]                  remove what install registered',
  '  backups [--remove] [--also <file>]... list (or delete) the backup files this tool created',
  '  embedding-status                      print where documents would be sent for embedding',
].join('\n');

if (isMainModule(import.meta.url)) {
  const action = (process.argv[2] || '').trim().toLowerCase();
  const rest = process.argv.slice(3);

  if (action === 'install' || action === 'uninstall') {
    const repoRoot = rest[0] ? path.resolve(rest[0]) : REPO_ROOT;
    const result = action === 'install' ? installCortex({ repoRoot }) : uninstallCortex({ repoRoot });
    if (action === 'install' && !result.ok) {
      for (const problem of result.problems) console.error(`[ERROR] ${problem.file}: ${problem.message}`);
      console.error('[ERROR] Nothing was changed. Fix what is named above, then run the installer again.');
      process.exitCode = 1;
    } else {
      for (const line of formatInstallSummary(result)) console.log(line);
      if (!result.ok) process.exitCode = 1;
    }
  } else if (action === 'backups') {
    const extraFiles = parseExtraFiles(rest);
    if (rest.includes('--remove')) {
      const { removed, failed } = removeBackups({ extraFiles });
      for (const backupPath of removed) console.log(`[OK] Removed backup: ${backupPath}`);
      for (const item of failed) console.log(`[WARN] Could not remove backup: ${item.path} (${item.error})`);
      if (failed.length > 0) process.exitCode = 1;
    } else {
      for (const backupPath of listBackups({ extraFiles })) console.log(backupPath);
    }
  } else if (action === 'embedding-status') {
    for (const line of describeInstalledEmbedding()) console.log(`[herdr-cortex] ${line}`);
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}
