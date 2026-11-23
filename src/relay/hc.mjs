import fs from 'node:fs';
import path from 'node:path';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { projectPathKey } from '../core/config.mjs';
import { validateTerminalId } from '../revive/tracker.mjs';

const BARE_SHELLS = new Set([
  'powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'nu.exe',
  'powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh',
]);

const BUSY_STATES = new Set([
  'busy', 'running', 'working', 'thinking', 'active', 'streaming', 'executing',
]);

const BLOCKED_STATES = new Set([
  'blocked', 'waiting_permission', 'permission', 'stuck', 'approval',
]);

const ERROR_STATES = new Set([
  'error', 'errored', 'failed', 'crashed',
]);

const IDLE_STATES = new Set([
  'idle', 'waiting', 'ready', 'input', 'prompt', 'paused', 'done',
]);

export const MAX_WAKE_TRIGGER_CHARS = 240;

/**
 * Sanitize a wake trigger to a single safe line so raw multiline bodies
 * are NEVER passed through `hc send`.
 */
export function sanitizeSingleLineTrigger(text, maxChars = MAX_WAKE_TRIGGER_CHARS) {
  const cleaned = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trimEnd();
}

// `hc` addresses a tab on another machine as "<machine>/<terminal>" (for example "pc2/t3").
const REMOTE_ADDRESS_RE = /^([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/;

/**
 * Split a terminal address as printed by `hc ls`: { remote, machine, terminalId }.
 * "t3" -> { remote: false, machine: '', terminalId: 't3' }; "pc2/t3" -> { remote: true, machine: 'pc2', terminalId: 't3' }.
 * Relay works only between tabs of this machine (the inbox is a local file), so a remote address is
 * recognized here and refused by the callers; it is never turned into a file path.
 */
export function parseTerminalAddress(address) {
  const raw = typeof address === 'string' ? address.trim() : '';
  const match = REMOTE_ADDRESS_RE.exec(raw);
  if (match) return { remote: true, machine: match[1], terminalId: match[2] };
  return { remote: false, machine: '', terminalId: raw };
}

// `status` as hc 0.1.21 prints it: a plain string in `hc ls` rows ("idle" / "working", absent for a bare
// shell), an object { app, state, msg? } in `hc get` ("status": null for a bare shell).
function readStatus(status) {
  if (typeof status === 'string') {
    return { state: status.trim().toLowerCase(), app: '' };
  }
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    return {
      state: typeof status.state === 'string' ? status.state.trim().toLowerCase() : '',
      app: typeof status.app === 'string' ? status.app.trim() : '',
    };
  }
  return { state: '', app: '' };
}

/**
 * Normalize one terminal from `hc ls --json` (a row) or `hc get <id> --json` into
 * { terminalId, remote, machine, state, live, activity, idle, busy, blocked, error, unknown,
 *   agentName, isBareShell, cwd, where }.
 *
 * `activity` is exactly one of:
 *   'not_live' - the tab's `state` is not "live"
 *   'shell'    - a bare shell (program name is a shell and hc reports no agent status)
 *   'idle' | 'working' | 'blocked' | 'error' - what the agent's status says ('error' also when the tab's
 *                own `state` is an error state)
 *   'unknown'  - a live agent tab whose status is missing or not understood. Unknown is NOT busy:
 *                callers must not report it as "busy", and must not treat it as idle either.
 * `idle`, `busy`, `blocked`, `error` and `unknown` are the matching booleans (at most one is true).
 */
export function detectTerminalActivity(terminal) {
  if (!terminal || typeof terminal !== 'object') {
    return {
      terminalId: '',
      remote: false,
      machine: '',
      state: 'unknown',
      live: false,
      activity: 'not_live',
      idle: false,
      busy: false,
      blocked: false,
      error: false,
      unknown: false,
      agentName: '',
      isBareShell: false,
      cwd: '',
      where: '',
    };
  }

  const terminalId = String(terminal.address || terminal.id || terminal.terminalId || '').trim();
  const address = parseTerminalAddress(terminalId);
  const stateRaw = String(terminal.state || '').trim().toLowerCase();
  const live = stateRaw ? stateRaw === 'live' : true;

  const status = readStatus(terminal.status);
  const programName = String(terminal.foreground?.name || terminal.agent || '').trim();
  // A shell program without an agent status is a bare shell; when hc names an agent app for the tab
  // (status.app), the tab is that agent even if its foreground program is a shell.
  const isBareShell = Boolean(programName) && BARE_SHELLS.has(programName.toLowerCase()) && !status.app;
  const agentName = status.app || programName;

  const cwd = String(terminal.foreground?.cwd || terminal.cwd || '').trim();
  const where = String(terminal.labels?.where || terminal.where || '').trim();

  let activity;
  if (ERROR_STATES.has(stateRaw)) activity = 'error';
  else if (!live) activity = 'not_live';
  else if (isBareShell) activity = 'shell';
  else if (ERROR_STATES.has(status.state)) activity = 'error';
  else if (BLOCKED_STATES.has(status.state)) activity = 'blocked';
  else if (BUSY_STATES.has(status.state)) activity = 'working';
  else if (IDLE_STATES.has(status.state)) activity = 'idle';
  else activity = 'unknown';

  return {
    terminalId,
    remote: address.remote,
    machine: address.machine,
    state: stateRaw || (live ? 'live' : 'unknown'),
    live,
    activity,
    idle: activity === 'idle',
    busy: activity === 'working',
    blocked: activity === 'blocked',
    error: activity === 'error',
    unknown: activity === 'unknown',
    agentName,
    isBareShell,
    cwd,
    where,
  };
}

function classifyExecError(err, hcBin) {
  if (err && err.code === 'ENOENT') {
    return {
      ok: false,
      code: 'HC_NOT_FOUND',
      error: `Herdr CLI "${hcBin}" was not found on PATH.`,
    };
  }
  if (err && (err.code === 'ETIMEDOUT' || err.killed)) {
    return {
      ok: false,
      code: 'HC_TIMEOUT',
      error: `Herdr CLI "${hcBin}" timed out.`,
    };
  }
  const stderr = typeof err?.stderr === 'string'
    ? err.stderr.trim()
    : Buffer.isBuffer(err?.stderr)
      ? err.stderr.toString('utf8').trim()
      : '';
  return {
    ok: false,
    code: 'HC_EXEC_ERROR',
    error: stderr || err?.message || `Failed to run "${hcBin}"`,
  };
}

// Extensions `execFile` can start on Windows without a shell (a .cmd/.bat file cannot be started that way).
const WINDOWS_EXECUTABLE_EXTENSIONS = Object.freeze(['.exe', '.com']);

function readPathVariable(env) {
  if (!env || typeof env !== 'object') return '';
  if (typeof env.PATH === 'string') return env.PATH;
  // `process.env` is case-insensitive on Windows; a plain object (tests, copies) is not.
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key && typeof env[key] === 'string' ? env[key] : '';
}

// A PATH entry is used only when it names one fixed directory: on Windows a drive-letter or UNC path
// ("\dir" and "C:dir" depend on the current drive or directory and are skipped like relative entries).
function isFullyQualifiedDir(entry, platform) {
  if (platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(entry) || /^[\\/]{2}[^\\/]/.test(entry);
  }
  return path.isAbsolute(entry);
}

function isExecutableFile(candidate, platform) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the Herdr CLI found through PATH, or '' when there is none.
 *
 * Starting a program by bare name on Windows looks in the current directory before PATH, and the MCP
 * server's current directory is the project folder, so a repository could ship its own `hc.exe`.
 * This search therefore uses PATH only: entries that are relative, or that resolve to the current directory,
 * are skipped, and on Windows only `.exe` / `.com` files are considered.
 */
export function resolveHcExecutable({
  name = 'hc',
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
} = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName || /[\\/]/.test(cleanName)) return '';

  const extension = path.extname(cleanName).toLowerCase();
  const fileNames = platform !== 'win32' || WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension)
    ? [cleanName]
    : WINDOWS_EXECUTABLE_EXTENSIONS.map((ext) => `${cleanName}${ext}`);

  let cwdKey = '';
  try {
    cwdKey = cwd ? projectPathKey(cwd) : '';
  } catch {
    cwdKey = '';
  }

  const delimiter = platform === 'win32' ? ';' : ':';
  for (const rawEntry of readPathVariable(env).split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!entry || !isFullyQualifiedDir(entry, platform)) continue;

    let entryKey;
    try {
      entryKey = projectPathKey(entry);
    } catch {
      continue;
    }
    if (cwdKey && entryKey === cwdKey) continue;

    for (const fileName of fileNames) {
      const candidate = path.join(entry, fileName);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return '';
}

/**
 * Create a Herdr CLI (`hc`) client wrapper.
 * `hc` is located once through PATH (`resolveHcExecutable`) and always started by that absolute path, with
 * the working directory set to the folder containing it (a folder that certainly exists), never by bare name
 * and never from the caller's current directory. A located path that disappears is looked up again.
 * An `hcBin` that already is an absolute path is used as is.
 * `execFileSync`, `resolveHc` and `fileExists` are injectable for deterministic tests.
 */
export function createHcClient({
  execFileSync = nodeExecFileSync,
  hcBin = 'hc',
  timeoutMs = 5000,
  resolveHc = resolveHcExecutable,
  fileExists = (filePath) => fs.existsSync(filePath),
} = {}) {
  const explicitPath = typeof hcBin === 'string' && path.isAbsolute(hcBin) ? hcBin : '';
  let locatedPath = '';

  function locateHc() {
    if (explicitPath) return explicitPath;
    if (locatedPath && fileExists(locatedPath)) return locatedPath;
    let found = '';
    try {
      found = resolveHc({ name: hcBin });
    } catch {
      found = '';
    }
    // Only an absolute path is ever executed; anything else counts as "not found".
    locatedPath = typeof found === 'string' && path.isAbsolute(found) ? found : '';
    return locatedPath;
  }

  function runHc(args) {
    const hcPath = locateHc();
    if (!hcPath) {
      return {
        ok: false,
        code: 'HC_NOT_FOUND',
        error: `Herdr CLI "${hcBin}" was not found on PATH.`,
      };
    }
    try {
      const stdout = execFileSync(hcPath, args, {
        cwd: path.dirname(hcPath),
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout: typeof stdout === 'string' ? stdout : String(stdout ?? '') };
    } catch (err) {
      if (err && err.code === 'ENOENT') locatedPath = '';
      return classifyExecError(err, hcBin);
    }
  }

  function listTerminals() {
    const res = runHc(['ls', '--json']);
    if (!res.ok) return res;
    try {
      const parsed = JSON.parse(res.stdout.trim() || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
        return {
          ok: false,
          code: 'HC_API_ERROR',
          error: typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error),
        };
      }
      const rawList = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.terminals)
          ? parsed.terminals
          : [];
      const terminals = rawList.map((t) => ({
        raw: t,
        ...detectTerminalActivity(t),
      }));
      return { ok: true, terminals };
    } catch (err) {
      return {
        ok: false,
        code: 'HC_PARSE_ERROR',
        error: `Failed to parse "hc ls --json" output: ${err.message}`,
      };
    }
  }

  function getTerminal(terminalId) {
    const cleanId = validateTerminalId(terminalId);
    const res = runHc(['get', cleanId, '--json']);
    if (!res.ok) return res;
    try {
      const parsed = JSON.parse(res.stdout.trim() || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
        return {
          ok: false,
          code: 'HC_API_ERROR',
          error: typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error),
        };
      }
      const terminal = parsed?.terminal && typeof parsed.terminal === 'object'
        ? parsed.terminal
        : parsed;
      return {
        ok: true,
        terminal,
        status: detectTerminalActivity({ address: cleanId, ...terminal }),
      };
    } catch (err) {
      return {
        ok: false,
        code: 'HC_PARSE_ERROR',
        error: `Failed to parse "hc get ${cleanId} --json" output: ${err.message}`,
      };
    }
  }

  function sendTrigger(terminalId, text, { ifIdle = false } = {}) {
    const cleanId = validateTerminalId(terminalId);
    const singleLine = sanitizeSingleLineTrigger(text);
    if (!singleLine) {
      return {
        ok: false,
        code: 'EMPTY_TRIGGER',
        error: 'Wake trigger text must be non-empty after single-line sanitization.',
      };
    }
    let res;
    if (ifIdle) {
      res = runHc(['send', '--if', 'idle', cleanId, singleLine]);
      if (!res.ok && /unknown flag|unrecognized|invalid option|unexpected argument/i.test(String(res.error || ''))) {
        res = runHc(['send', cleanId, singleLine]);
      }
    } else {
      res = runHc(['send', cleanId, singleLine]);
    }
    if (!res.ok) return res;
    return {
      ok: true,
      terminalId: cleanId,
      sent: singleLine,
    };
  }

  return {
    listTerminals,
    getTerminal,
    sendTrigger,
    detectTerminalActivity,
  };
}
