import { execFileSync as nodeExecFileSync } from 'node:child_process';
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

/**
 * Normalize terminal activity metadata from `hc get` / `hc ls` output
 * to distinguish live vs dead and idle vs busy cleanly.
 */
export function detectTerminalActivity(terminal) {
  if (!terminal || typeof terminal !== 'object') {
    return {
      terminalId: '',
      state: 'unknown',
      live: false,
      busy: false,
      blocked: false,
      error: false,
      idle: false,
      agentName: '',
      isBareShell: false,
      cwd: '',
      where: '',
    };
  }

  const terminalId = String(terminal.address || terminal.id || terminal.terminalId || '').trim();
  const stateRaw = String(terminal.state || '').trim().toLowerCase();
  const live = stateRaw ? stateRaw === 'live' : true;

  const agentName = String(
    terminal.foreground?.name
    || terminal.agent
    || '',
  ).trim();
  const isBareShell = agentName ? BARE_SHELLS.has(agentName.toLowerCase()) : false;

  const cwd = String(terminal.foreground?.cwd || terminal.cwd || '').trim();
  const where = String(terminal.labels?.where || terminal.where || '').trim();

  const candidateStatuses = [
    terminal.activity,
    terminal.status,
    terminal.foreground?.status,
    terminal.foreground?.state,
    terminal.labels?.status,
    terminal.labels?.activity,
  ]
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim().toLowerCase());

  let busy = false;
  let blocked = false;
  let error = false;
  let explicitIdle = false;

  if (terminal.error === true || terminal.foreground?.error === true || candidateStatuses.some((s) => ERROR_STATES.has(s))) {
    error = true;
  }
  if (terminal.blocked === true || terminal.foreground?.blocked === true || candidateStatuses.some((s) => BLOCKED_STATES.has(s))) {
    blocked = true;
  }

  if (terminal.busy === true || terminal.foreground?.busy === true) {
    busy = true;
  } else if (terminal.idle === false || terminal.foreground?.idle === false) {
    busy = true;
  } else if (candidateStatuses.some((s) => BUSY_STATES.has(s))) {
    busy = true;
  } else if (
    terminal.idle === true
    || terminal.foreground?.idle === true
    || candidateStatuses.some((s) => IDLE_STATES.has(s))
  ) {
    explicitIdle = true;
  }

  const idle = live && !busy && !blocked && !error && !isBareShell && explicitIdle;

  return {
    terminalId,
    state: stateRaw || (live ? 'live' : 'unknown'),
    live,
    busy: live && busy,
    blocked: live && blocked,
    error: live && error,
    idle,
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

/**
 * Create a Herdr CLI (`hc`) client wrapper with injectable execFileSync for deterministic tests.
 */
export function createHcClient({
  execFileSync = nodeExecFileSync,
  hcBin = 'hc',
  timeoutMs = 5000,
} = {}) {
  function runHc(args) {
    try {
      const stdout = execFileSync(hcBin, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout: typeof stdout === 'string' ? stdout : String(stdout ?? '') };
    } catch (err) {
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
