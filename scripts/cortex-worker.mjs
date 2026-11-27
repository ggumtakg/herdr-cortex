#!/usr/bin/env node
/**
 * Headless worker launcher behind the `cortex-worker` shell command.
 * Usage:
 *   node --no-warnings scripts/cortex-worker.mjs --role <developer|coder|reviewer|researcher> --agent <antigravity|claude> --model <모델 이름> --brief <지시 파일 경로> [--out <결과 파일 경로>] [--timeout <분>] [--allow <허용 규칙>]... [--cwd <폴더>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isMainModule } from '../src/core/config.mjs';

export const VALID_ROLES = Object.freeze(['developer', 'coder', 'reviewer', 'researcher']);
export const DEFAULT_TIMEOUT_MINUTES = 40;

export const WORKER_USAGE = [
  'Usage: node --no-warnings scripts/cortex-worker.mjs \\',
  '  --role <developer|coder|reviewer|researcher> --agent <antigravity|claude> \\',
  '  --model <모델 이름> --brief <지시 파일 경로> \\',
  '  [--out <결과 파일 경로>] [--timeout <분>] [--allow <허용 규칙>]... [--cwd <폴더>]',
].join('\n');

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_TIMEOUT = 124;
const EXIT_NOT_FOUND = 127;

/** Format a positive minute count as a Go duration string for `agy --print-timeout`. */
export function formatAgyTimeout(minutes) {
  if (Number.isInteger(minutes)) return `${minutes}m`;
  const totalMs = Math.max(1, Math.round(minutes * 60_000));
  if (totalMs % 1000 === 0) return `${totalMs / 1000}s`;
  return `${totalMs}ms`;
}

function resolveRealOrAbs(targetPath) {
  const abs = path.resolve(targetPath);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function isPathInsideDir(filePath, dirPath, platform = process.platform) {
  const fileNorm = resolveRealOrAbs(filePath);
  const dirNorm = resolveRealOrAbs(dirPath);
  const a = platform === 'win32' ? fileNorm.toLowerCase() : fileNorm;
  const b = platform === 'win32' ? dirNorm.toLowerCase() : dirNorm;
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function createTempAgySettings(allow, { tempRoot = os.tmpdir() } = {}) {
  const tempDir = fs.mkdtempSync(path.join(tempRoot, 'cortex-worker-'));
  const settingsPath = path.join(tempDir, 'settings.json');
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({ permissions: { allow } })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return {
    settingsPath,
    cleanup() {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Best-effort cleanup of session-only temporary settings directory.
      }
    },
  };
}

/**
 * Single table of host-specific CLI differences (binary name, default MCP permission rule,
 * external brief access, model flag, session-only permission flag, and print-mode timeout flag).
 * Verified against `agy --help` and `claude --help`.
 */
export const HOST_SPECS = Object.freeze({
  antigravity: Object.freeze({
    bin: 'agy',
    defaultAllow: Object.freeze(['mcp(herdr-cortex/*)']),
    briefAccessArgs: () => [],
    modelArgs: (model) => ['--model', model],
    prepareAllow: (rules, options) => createTempAgySettings(rules, options),
    allowArgs: (_rules, settingsPath) => {
      if (!settingsPath) {
        throw new Error('antigravity allowArgs requires a temporary settings file path.');
      }
      return ['--settings', settingsPath];
    },
    timeoutArgs: (minutes) => ['--print-timeout', formatAgyTimeout(minutes)],
    buildArgs({ prompt, model, allow, settingsPath, timeoutMinutes, briefPath, cwd, platform }) {
      return [
        '-p',
        prompt,
        ...this.briefAccessArgs(briefPath, cwd, platform),
        ...this.modelArgs(model),
        ...this.allowArgs(allow, settingsPath),
        ...this.timeoutArgs(timeoutMinutes),
      ];
    },
  }),
  claude: Object.freeze({
    bin: 'claude',
    defaultAllow: Object.freeze(['mcp__herdr-cortex__*']),
    briefAccessArgs: (briefPath, cwd, platform) => (
      briefPath && cwd && !isPathInsideDir(briefPath, cwd, platform)
        ? ['--add-dir', path.dirname(briefPath)]
        : []
    ),
    modelArgs: (model) => ['--model', model],
    prepareAllow: () => ({ settingsPath: '', cleanup() {} }),
    allowArgs: (rules) => ['--allowedTools', ...rules],
    timeoutArgs: () => [],
    buildArgs({ prompt, model, allow, timeoutMinutes, briefPath, cwd, platform }) {
      return [
        '-p',
        prompt,
        ...this.briefAccessArgs(briefPath, cwd, platform),
        ...this.modelArgs(model),
        ...this.allowArgs(allow),
        ...this.timeoutArgs(timeoutMinutes),
      ];
    },
  }),
});

const KNOWN_FLAGS = new Set([
  '--role',
  '--agent',
  '--model',
  '--brief',
  '--out',
  '--timeout',
  '--allow',
  '--cwd',
]);

/**
 * Inherit the caller's environment, strip `HC_TERMINAL_ID` (case-insensitively on Windows),
 * and mark the child session with `HERDR_CORTEX_ROLE=worker`.
 */
export function buildWorkerEnv(baseEnv = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (value === undefined) continue;
    if (/^(HC_TERMINAL_ID|HERDR_CORTEX_ROLE)$/i.test(key)) continue;
    out[key] = value;
  }
  out.HERDR_CORTEX_ROLE = 'worker';
  return out;
}

/**
 * Build the short fixed prompt passed on the command line.
 * Never embeds the contents of the brief file and avoids `"` and `%` so `.ps1` and `.cmd`
 * wrappers do not alter script-generated prompt text.
 */
export function buildWorkerPrompt({ role, briefPath }) {
  return (
    `너는 ${role} 워커다. `
    + `먼저 cortex_prompt(kind: 'agent', name: '${role}')로 역할을 읽고, `
    + `지시 파일 <${briefPath}>을 읽고 그대로 수행해라. `
    + '마지막 메시지로 결과를 돌려줘라.'
  );
}

/** Parse and validate `cortex-worker` CLI arguments. */
export function parseWorkerArgs(argv, { cwd = process.cwd() } = {}) {
  const raw = {
    role: undefined,
    agent: undefined,
    model: undefined,
    brief: undefined,
    out: undefined,
    timeout: undefined,
    allow: [],
    cwd: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i] ?? '');
    if (token.includes('\0')) {
      return { ok: false, error: 'CLI arguments cannot contain NUL characters.' };
    }
    if (!token.startsWith('--')) {
      return { ok: false, error: `Unexpected argument "${token}".` };
    }

    let flag = token;
    let value;
    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      flag = token.slice(0, eqIndex);
      value = token.slice(eqIndex + 1);
    }

    if (!KNOWN_FLAGS.has(flag)) {
      return { ok: false, error: `Unknown option "${flag}".` };
    }

    if (value === undefined) {
      if (i + 1 >= argv.length || KNOWN_FLAGS.has(String(argv[i + 1] ?? ''))) {
        return { ok: false, error: `Missing value for ${flag}.` };
      }
      value = String(argv[++i]);
      if (value.includes('\0')) {
        return { ok: false, error: `Option ${flag} cannot contain NUL characters.` };
      }
    }

    switch (flag) {
      case '--role':
        raw.role = value;
        break;
      case '--agent':
        raw.agent = value;
        break;
      case '--model':
        raw.model = value;
        break;
      case '--brief':
        raw.brief = value;
        break;
      case '--out':
        raw.out = value;
        break;
      case '--timeout':
        raw.timeout = value;
        break;
      case '--allow':
        raw.allow.push(value);
        break;
      case '--cwd':
        raw.cwd = value;
        break;
    }
  }

  if (typeof raw.role === 'string' && /[\r\n]/.test(raw.role)) {
    return { ok: false, error: 'Invalid --role: value cannot contain line breaks.' };
  }
  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  if (!role) return { ok: false, error: 'Missing required option --role.' };
  if (!VALID_ROLES.includes(role)) {
    return { ok: false, error: `Invalid --role "${raw.role}" (expected one of: ${VALID_ROLES.join(', ')}).` };
  }

  if (typeof raw.agent === 'string' && /[\r\n]/.test(raw.agent)) {
    return { ok: false, error: 'Invalid --agent: value cannot contain line breaks.' };
  }
  const agent = typeof raw.agent === 'string' ? raw.agent.trim() : '';
  if (!agent) return { ok: false, error: 'Missing required option --agent.' };
  if (!Object.prototype.hasOwnProperty.call(HOST_SPECS, agent)) {
    return { ok: false, error: `Invalid --agent "${raw.agent}" (expected one of: ${Object.keys(HOST_SPECS).join(', ')}).` };
  }

  if (typeof raw.model === 'string' && /[\r\n]/.test(raw.model)) {
    return { ok: false, error: 'Invalid --model: model name cannot contain line breaks.' };
  }
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) return { ok: false, error: 'Missing required option --model.' };

  if (typeof raw.brief === 'string' && /[\r\n]/.test(raw.brief)) {
    return { ok: false, error: 'Invalid --brief: file path cannot contain line breaks.' };
  }
  const briefRaw = typeof raw.brief === 'string' ? raw.brief.trim() : '';
  if (!briefRaw) return { ok: false, error: 'Missing required option --brief.' };

  let outPath = '';
  if (raw.out !== undefined) {
    if (/[\r\n]/.test(raw.out)) {
      return { ok: false, error: 'Invalid --out: file path cannot contain line breaks.' };
    }
    const outRaw = raw.out.trim();
    if (!outRaw) return { ok: false, error: 'Option --out requires a non-empty file path.' };
    outPath = path.resolve(cwd, outRaw);
  }

  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  if (raw.timeout !== undefined) {
    if (/[\r\n]/.test(raw.timeout)) {
      return { ok: false, error: 'Invalid --timeout: value cannot contain line breaks.' };
    }
    const timeoutRaw = raw.timeout.trim();
    const parsed = timeoutRaw ? Number(timeoutRaw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { ok: false, error: `Invalid --timeout "${raw.timeout}" (expected a positive number of minutes).` };
    }
    timeoutMinutes = parsed;
  }

  const allow = [];
  for (const rule of raw.allow) {
    const ruleStr = String(rule);
    const trimmed = ruleStr.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!trimmed.trim()) return { ok: false, error: 'Option --allow requires a non-empty rule.' };
    if (trimmed.trimStart().startsWith('-')) {
      return { ok: false, error: `Invalid --allow "${ruleStr}" (permission rule cannot start with "-").` };
    }
    allow.push(trimmed);
  }

  let targetCwd = path.resolve(cwd);
  if (raw.cwd !== undefined) {
    if (/[\r\n]/.test(raw.cwd)) {
      return { ok: false, error: 'Invalid --cwd: directory path cannot contain line breaks.' };
    }
    const cwdRaw = raw.cwd.trim();
    if (!cwdRaw) return { ok: false, error: 'Option --cwd requires a non-empty directory path.' };
    targetCwd = path.resolve(cwd, cwdRaw);
  }

  return {
    ok: true,
    options: {
      role,
      agent,
      model,
      briefPath: path.resolve(cwd, briefRaw),
      outPath,
      timeoutMinutes,
      allow,
      cwd: targetCwd,
    },
  };
}

function getEnvValueCaseInsensitive(env, targetName) {
  const lower = targetName.toLowerCase();
  for (const [key, value] of Object.entries(env || {})) {
    if (key.toLowerCase() === lower && typeof value === 'string') return value;
  }
  return '';
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveTempRoot(env) {
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
    const candidate = getEnvValueCaseInsensitive(env, key);
    if (candidate) {
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        // Fall through to next candidate.
      }
    }
  }
  return os.tmpdir();
}

/**
 * Locate `binName` on `env.PATH`. On Windows, checks `.exe`, `.cmd`, `.bat`, and `.ps1`
 * in each PATH directory so native binaries, npm `.cmd` shims, and `.ps1` scripts all work
 * without matching extensionless POSIX shims.
 */
export function resolveExecutable(binName, { env = process.env, platform = process.platform } = {}) {
  if (!binName) return '';
  if (path.isAbsolute(binName)) return isRegularFile(binName) ? binName : '';

  const pathVar = getEnvValueCaseInsensitive(env, 'PATH');
  if (!pathVar) return '';
  const separator = platform === 'win32' ? ';' : ':';
  const dirs = pathVar
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  const hasExt = Boolean(path.extname(binName));
  const candidates = platform === 'win32'
    ? (hasExt ? [binName] : [`${binName}.exe`, `${binName}.cmd`, `${binName}.bat`, `${binName}.ps1`])
    : [binName];

  for (const dir of dirs) {
    for (const name of candidates) {
      const fullPath = path.join(dir, name);
      if (isRegularFile(fullPath)) return fullPath;
    }
  }
  return '';
}

function quoteMsvcrtArg(arg) {
  const s = String(arg);
  if (s.length > 0 && !/[\s"&|<>()^%!*=,;?]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2)}""`;
      backslashes = 0;
    } else {
      out += `${'\\'.repeat(backslashes)}${ch}`;
      backslashes = 0;
    }
  }
  out += `${'\\'.repeat(backslashes * 2)}"`;
  return out;
}

function inferArgOptionLabels(args) {
  const labels = new Array(args.length).fill('인자');
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i]);
    if ((token === '-p' || token === '--print' || token === '--prompt' || token === '--add-dir') && i + 1 < args.length) {
      labels[++i] = '--brief';
    } else if (token === '--model' && i + 1 < args.length) {
      labels[++i] = '--model';
    } else if (token === '--settings' && i + 1 < args.length) {
      labels[++i] = '--settings 임시 설정 파일 경로';
    } else if (token === '--print-timeout' && i + 1 < args.length) {
      labels[++i] = '--timeout';
    } else if (token === '--allowedTools') {
      while (i + 1 < args.length && !String(args[i + 1]).startsWith('-')) {
        labels[++i] = '--allow';
      }
    }
  }
  return labels;
}

/**
 * Quote one argument for `cmd.exe /v:off /d /s /c ""script.cmd" ..."` using MSVCRT `""` quoting.
 * Rejects `%` and line breaks rather than attempting `%^` escaping (which leaves literal `^` inside quotes).
 */
export function quoteCmdArg(arg, { optionName = '인자', hostLabel = '.cmd/.bat' } = {}) {
  const s = String(arg);
  if (s.includes('\r') || s.includes('\n')) {
    throw new Error(
      `${optionName} 값에 줄바꿈(\\r/\\n) 문자가 들어 있어 전달할 수 없습니다 `
      + `(호스트 ${hostLabel}가 .cmd/.bat 배치 파일로 설치되어 있어 cmd.exe가 줄바꿈이 든 인자를 온전히 전달하지 못합니다).`,
    );
  }
  if (s.includes('%')) {
    throw new Error(
      `${optionName} 값에 "%" 문자가 들어 있어 전달할 수 없습니다 `
      + `(호스트 ${hostLabel}가 .cmd/.bat 배치 파일로 설치되어 있어 cmd.exe가 "%"를 환경 변수·배치 인자로 치환하므로 값을 온전히 전달하지 못합니다).`,
    );
  }
  return quoteMsvcrtArg(s);
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveWindowsPowerShell(env) {
  const sysRoot = getEnvValueCaseInsensitive(env, 'SystemRoot')
    || getEnvValueCaseInsensitive(env, 'windir')
    || 'C:\\Windows';
  const candidate = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (isRegularFile(candidate)) return candidate;
  return resolveExecutable('powershell', { env, platform: 'win32' })
    || resolveExecutable('pwsh', { env, platform: 'win32' })
    || 'powershell.exe';
}

function resolveCmdExe(env) {
  const comSpec = getEnvValueCaseInsensitive(env, 'ComSpec');
  if (comSpec && isRegularFile(comSpec)) return comSpec;
  const sysRoot = getEnvValueCaseInsensitive(env, 'SystemRoot')
    || getEnvValueCaseInsensitive(env, 'windir')
    || 'C:\\Windows';
  const candidate = path.join(sysRoot, 'System32', 'cmd.exe');
  return isRegularFile(candidate) ? candidate : 'cmd.exe';
}

/**
 * Build the `child_process.spawn` invocation for a resolved executable path.
 * - `.exe` (and POSIX binaries): direct exec with `shell: false`
 * - `.cmd` / `.bat`: `cmd.exe /v:off /d /s /c` with MSVCRT quoting; rejects `%` and line breaks
 * - `.ps1`: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` with single-quoted array;
 *   rejects `"` (and whitespace + trailing `\`) because Windows PowerShell 5.1 corrupts them on native hops
 */
export function buildSpawnSpec(
  resolvedBin,
  args,
  { env = process.env, platform = process.platform, argLabels } = {},
) {
  if (platform !== 'win32') {
    return { command: resolvedBin, args: [...args], options: { shell: false } };
  }

  const ext = path.extname(resolvedBin).toLowerCase();
  const binLabel = path.basename(resolvedBin) || resolvedBin;
  const labels = argLabels || inferArgOptionLabels(args);

  if (ext === '.cmd' || ext === '.bat') {
    if (resolvedBin.includes('\r') || resolvedBin.includes('\n')) {
      throw new Error(
        `실행 파일 경로(${resolvedBin})에 줄바꿈(\\r/\\n) 문자가 들어 있어 실행할 수 없습니다 `
        + `(호스트 ${binLabel}가 ${ext} 파일로 설치되어 있어 cmd.exe로 경로를 온전히 전달할 수 없습니다).`,
      );
    }
    if (resolvedBin.includes('"')) {
      throw new Error(
        `실행 파일 경로(${resolvedBin})에 큰따옴표(") 문자가 들어 있어 실행할 수 없습니다 `
        + `(호스트 ${binLabel}가 ${ext} 파일로 설치되어 있어 cmd.exe로 경로를 온전히 전달할 수 없습니다).`,
      );
    }
    if (resolvedBin.includes('%')) {
      throw new Error(
        `실행 파일 경로(${resolvedBin})에 "%" 문자가 들어 있어 실행할 수 없습니다 `
        + `(호스트 ${binLabel}가 ${ext} 파일로 설치되어 있어 cmd.exe가 "%"를 환경 변수·배치 인자로 치환하므로 경로를 온전히 전달하지 못합니다).`,
      );
    }
    const cmdExe = resolveCmdExe(env);
    const escapedBin = `"${resolvedBin}"`;
    const quotedArgs = args.map((arg, idx) => quoteCmdArg(arg, {
      optionName: labels[idx] || '인자',
      hostLabel: `${binLabel}(${ext})`,
    }));
    const inner = quotedArgs.length > 0
      ? `${escapedBin} ${quotedArgs.join(' ')}`
      : escapedBin;
    return {
      command: cmdExe,
      args: ['/v:off', '/d', '/s', '/c', `"${inner}"`],
      options: { shell: false, windowsVerbatimArguments: true },
    };
  }

  if (ext === '.ps1') {
    if (resolvedBin.includes('\r') || resolvedBin.includes('\n')) {
      throw new Error(
        `실행 파일 경로(${resolvedBin})에 줄바꿈(\\r/\\n) 문자가 들어 있어 실행할 수 없습니다 `
        + `(호스트 ${binLabel}가 .ps1 파일로 설치되어 있어 경로를 온전히 전달할 수 없습니다).`,
      );
    }
    if (resolvedBin.includes('"')) {
      throw new Error(
        `실행 파일 경로(${resolvedBin})에 큰따옴표(") 문자가 들어 있어 실행할 수 없습니다 `
        + `(호스트 ${binLabel}가 .ps1 파일로 설치되어 있어 Windows PowerShell 5.1이 큰따옴표를 지우므로 경로를 온전히 전달하지 못합니다).`,
      );
    }
    for (let i = 0; i < args.length; i++) {
      const s = String(args[i]);
      const optionName = labels[i] || '인자';
      if (s.includes('"')) {
        throw new Error(
          `${optionName} 값에 큰따옴표(") 문자가 들어 있어 전달할 수 없습니다 `
          + `(호스트 ${binLabel}가 .ps1 파일로 설치되어 있어 Windows PowerShell 5.1이 네이티브 실행 파일을 호출할 때 인자 안의 큰따옴표를 지우므로 값을 온전히 전달하지 못합니다).`,
        );
      }
      if (/\s/.test(s) && s.endsWith('\\')) {
        throw new Error(
          `${optionName} 값에 공백과 끝 역슬래시(\\)가 함께 들어 있어 전달할 수 없습니다 `
          + `(호스트 ${binLabel}가 .ps1 파일로 설치되어 있어 Windows PowerShell 5.1이 네이티브 실행 파일을 호출할 때 끝 역슬래시가 따옴표 경계를 깨뜨리므로 값을 온전히 전달하지 못합니다).`,
        );
      }
    }
    const psExe = resolveWindowsPowerShell(env);
    const psScript = [
      '$prevEnc = [Console]::OutputEncoding',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      '$global:LASTEXITCODE = 0',
      'try {',
      `  $hcArgs = @(${args.map(psSingleQuote).join(', ')})`,
      `  & ${psSingleQuote(resolvedBin)} @hcArgs`,
      '  exit $LASTEXITCODE',
      '} finally {',
      '  [Console]::OutputEncoding = $prevEnc',
      '}',
    ].join('; ');
    return {
      command: psExe,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      options: { shell: false },
    };
  }

  return { command: resolvedBin, args: [...args], options: { shell: false } };
}

function killProcessTree(child, { env = process.env, platform = process.platform } = {}) {
  if (!child || typeof child.pid !== 'number') return;
  // A child that already exited no longer owns its PID: Windows may have given the number to an unrelated
  // process, and taskkill would end that one instead.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    const sysRoot = getEnvValueCaseInsensitive(env, 'SystemRoot')
      || getEnvValueCaseInsensitive(env, 'windir')
      || 'C:\\Windows';
    const taskkillCandidate = path.join(sysRoot, 'System32', 'taskkill.exe');
    const taskkillExe = isRegularFile(taskkillCandidate) ? taskkillCandidate : 'taskkill';
    try {
      spawnSync(taskkillExe, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // The direct kill below still ends the child itself.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}

/**
 * Run a headless worker according to `argv`, streaming its stdout to `stdout` (and `--out` if requested)
 * and writing a one-line summary to `stderr`. Returns the process exit code.
 */
export async function runWorker(
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    env = process.env,
    platform = process.platform,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const parsed = parseWorkerArgs(argv, { cwd });
  if (!parsed.ok) {
    stderr.write(`[cortex-worker] ${parsed.error}\n${WORKER_USAGE}\n`);
    return EXIT_USAGE;
  }

  const opts = parsed.options;

  let cwdStat;
  try {
    cwdStat = fs.statSync(opts.cwd);
  } catch {
    cwdStat = null;
  }
  if (!cwdStat || !cwdStat.isDirectory()) {
    stderr.write(`[cortex-worker] 작업 폴더(--cwd)를 찾을 수 없습니다: ${opts.cwd}\n`);
    return EXIT_USAGE;
  }

  let briefStat;
  try {
    briefStat = fs.statSync(opts.briefPath);
  } catch {
    briefStat = null;
  }
  if (!briefStat || !briefStat.isFile()) {
    stderr.write(`[cortex-worker] 지시 파일(--brief)을 찾을 수 없습니다: ${opts.briefPath}\n`);
    return EXIT_USAGE;
  }

  let briefContent = '';
  try {
    briefContent = fs.readFileSync(opts.briefPath, 'utf8');
  } catch (err) {
    stderr.write(`[cortex-worker] 지시 파일을 읽을 수 없습니다 (${opts.briefPath}): ${err?.message || err}\n`);
    return EXIT_USAGE;
  }
  if (briefContent.replace(/^\uFEFF/, '').trim().length === 0) {
    stderr.write(`[cortex-worker] 지시 파일이 비어 있습니다: ${opts.briefPath}\n`);
    return EXIT_USAGE;
  }

  if (opts.outPath) {
    try {
      if (fs.existsSync(opts.outPath) && fs.statSync(opts.outPath).isDirectory()) {
        stderr.write(`[cortex-worker] 결과 파일 경로(--out)가 폴더입니다: ${opts.outPath}\n`);
        return EXIT_USAGE;
      }
    } catch {
      // Non-existent path is normal; parent directory is created before writing.
    }
  }

  const hostSpec = HOST_SPECS[opts.agent];
  const childEnv = buildWorkerEnv(env);
  const resolvedBin = resolveExecutable(hostSpec.bin, { env: childEnv, platform });
  if (!resolvedBin) {
    stderr.write(`[cortex-worker] PATH에서 "${hostSpec.bin}" 실행 파일을 찾을 수 없습니다.\n`);
    return EXIT_NOT_FOUND;
  }

  const allowRules = [...new Set([...hostSpec.defaultAllow, ...opts.allow])];
  const prompt = buildWorkerPrompt({ role: opts.role, briefPath: opts.briefPath });
  const tempRoot = resolveTempRoot(childEnv);

  let preparedAllow;
  try {
    preparedAllow = hostSpec.prepareAllow(allowRules, { tempRoot });
  } catch (err) {
    stderr.write(`[cortex-worker] 임시 설정 파일 생성 실패: ${err?.message || err}\n`);
    return EXIT_ERROR;
  }

  try {
    const hostArgs = hostSpec.buildArgs({
      prompt,
      model: opts.model,
      allow: allowRules,
      settingsPath: preparedAllow.settingsPath,
      timeoutMinutes: opts.timeoutMinutes,
      briefPath: opts.briefPath,
      cwd: opts.cwd,
      platform,
    });

    let spawnSpec;
    try {
      spawnSpec = buildSpawnSpec(resolvedBin, hostArgs, { env: childEnv, platform });
    } catch (err) {
      stderr.write(`[cortex-worker] ${err?.message || err}\n`);
      return EXIT_USAGE;
    }

    const startedAt = Date.now();
    const timeoutMs = Math.max(1, Math.round(opts.timeoutMinutes * 60_000));
    const stdoutChunks = [];
    let hadChildStderr = false;
    let stderrEndedWithNewline = true;
    let timedOut = false;

    return await new Promise((resolve) => {
      let settled = false;
      let timeoutTimer = null;
      let forceCloseTimer = null;

      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: opts.cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...spawnSpec.options,
      });

      const finish = ({ code = null, spawnError = null }) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (forceCloseTimer) clearTimeout(forceCloseTimer);

        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');

        let outWriteError = null;
        if (opts.outPath) {
          try {
            fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
            fs.writeFileSync(opts.outPath, stdoutText, 'utf8');
          } catch (err) {
            outWriteError = err;
          }
        }

        if (hadChildStderr && !stderrEndedWithNewline) {
          stderr.write('\n');
        }

        let exitCode;
        if (spawnError) {
          stderr.write(`[cortex-worker] 워커 실행 실패: ${spawnError?.message || spawnError}\n`);
          exitCode = EXIT_ERROR;
        } else if (timedOut) {
          stderr.write(`[cortex-worker] 시간 제한(${opts.timeoutMinutes}m)을 초과하여 워커 프로세스를 종료했습니다.\n`);
          exitCode = EXIT_TIMEOUT;
        } else if (stdoutText.trim().length === 0) {
          stderr.write(
            '[cortex-worker] 워커가 아무 출력 없이 종료되었습니다. '
            + '헤드리스 권한 거부(permission denied)일 가능성이 있으니 --allow 규칙을 확인하세요.\n',
          );
          exitCode = typeof code === 'number' && code !== 0 ? code : EXIT_ERROR;
        } else {
          exitCode = typeof code === 'number' ? code : EXIT_ERROR;
        }

        if (outWriteError) {
          stderr.write(`[cortex-worker] 결과 파일(--out) 쓰기 실패 (${opts.outPath}): ${outWriteError?.message || outWriteError}\n`);
          if (exitCode === 0) exitCode = EXIT_ERROR;
        }

        stderr.write(
          `[cortex-worker] role=${opts.role} agent=${opts.agent} model=${opts.model} elapsed=${elapsedSeconds}s exit=${exitCode}\n`,
        );
        resolve(exitCode);
      };

      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          stdoutChunks.push(buf);
          stdout.write(buf);
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (buf.length > 0) {
            hadChildStderr = true;
            stderrEndedWithNewline = buf[buf.length - 1] === 0x0a;
            stderr.write(buf);
          }
        });
      }

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child, { env: childEnv, platform });
        forceCloseTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ code: EXIT_TIMEOUT });
        }, 500);
      }, timeoutMs);

      child.on('error', (err) => finish({ spawnError: err }));
      child.on('close', (code) => finish({ code }));
    });
  } finally {
    preparedAllow.cleanup();
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runWorker(process.argv.slice(2));
}
