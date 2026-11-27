#!/usr/bin/env node
/**
 * Thin, self-contained CLI entry point for Antigravity `PreToolUse` and `PostToolUse` hooks.
 *
 * Uses ONLY `node:` built-in static imports so syntax errors, missing exports, missing files,
 * or top-level exceptions anywhere in `antigravity.mjs` or its transitive imports are caught
 * here and turned into a valid hook JSON response (`{"decision":"ask"}` for `PreToolUse`,
 * `{}` for `PostToolUse`) on stdout, a single diagnostic line on stderr, and exit code 0.
 */
import fs from 'node:fs';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const DEFAULT_ENTRY_SAFETY_TIMEOUT_MS = 6000;
function resolveEntrySafetyTimeoutMs(env = process.env) {
  const raw = typeof env?.HERDR_CORTEX_ENTRY_TIMEOUT_MS === 'string'
    ? env.HERDR_CORTEX_ENTRY_TIMEOUT_MS.trim()
    : '';
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 60000) {
      return parsed;
    }
  }
  return DEFAULT_ENTRY_SAFETY_TIMEOUT_MS;
}
const ENTRY_SAFETY_TIMEOUT_MS = resolveEntrySafetyTimeoutMs(process.env);
const PRE_TOOL_FALLBACK = '{"decision":"ask"}';
const POST_TOOL_FALLBACK = '{}';

const rawStdoutWrite = process.stdout.write.bind(process.stdout);
// Prevent accidental console.log / stdout writes inside dynamically loaded modules from corrupting JSON output.
process.stdout.write = () => true;
console.log = () => {};
console.info = () => {};
console.debug = () => {};

function detectCliMode(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? '');
    if (arg === '--id' || arg === '--marker') {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) {
      const lower = arg.trim().toLowerCase();
      if (lower === 'post-tool-use' || lower === 'posttooluse') return 'post-tool-use';
      if (lower === 'pre-tool-use' || lower === 'pretooluse') return 'pre-tool-use';
      break;
    }
  }
  return 'pre-tool-use';
}

const mode = detectCliMode(process.argv.slice(2));
const isPreToolUse = mode !== 'post-tool-use';
const fallbackJson = isPreToolUse ? PRE_TOOL_FALLBACK : POST_TOOL_FALLBACK;

function writeStderrLine(err) {
  try {
    const raw = err instanceof Error
      ? `${err.name || 'Error'}: ${err.message || String(err)}`
      : String(err ?? 'unknown error');
    const clean = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
    if (clean) {
      process.stderr.write(`[herdr-cortex] antigravity-tool-entry (${mode}): ${clean}\n`);
    }
  } catch {
    // ignore stderr write errors
  }
}

function serializeOutput(candidate) {
  if (!isPreToolUse) return POST_TOOL_FALLBACK;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    writeStderrLine('invalid PreToolUse return value (non-object)');
    return PRE_TOOL_FALLBACK;
  }
  const decision = typeof candidate.decision === 'string' ? candidate.decision.trim() : '';
  if (decision !== 'ask' && decision !== 'deny' && decision !== 'force_ask') {
    writeStderrLine(`invalid PreToolUse decision "${decision}"`);
    return PRE_TOOL_FALLBACK;
  }
  if (decision === 'ask') {
    return PRE_TOOL_FALLBACK;
  }
  const reason = typeof candidate.reason === 'string' && candidate.reason.trim()
    ? candidate.reason.trim()
    : '[herdr-cortex] Tool call requires review.';
  return JSON.stringify({ decision, reason });
}

let finished = false;
function emitAndExit(jsonLine) {
  if (finished) return;
  finished = true;
  const line = typeof jsonLine === 'string' && jsonLine.startsWith('{') && !jsonLine.includes('\n')
    ? jsonLine
    : fallbackJson;
  try {
    rawStdoutWrite(`${line}\n`);
  } catch {
    // ignore broken stdout pipe
  }
  process.exit(0);
}

process.on('uncaughtException', (err) => {
  writeStderrLine(err);
  emitAndExit(fallbackJson);
});

process.on('unhandledRejection', (reason) => {
  writeStderrLine(reason);
  emitAndExit(fallbackJson);
});

process.on('exit', () => {
  if (finished) return;
  finished = true;
  try {
    fs.writeSync(1, `${fallbackJson}\n`);
  } catch {
    // ignore broken stdout pipe
  }
  process.exitCode = 0;
});

const safetyTimer = setTimeout(() => {
  writeStderrLine(`timed out after ${ENTRY_SAFETY_TIMEOUT_MS}ms`);
  emitAndExit(fallbackJson);
}, ENTRY_SAFETY_TIMEOUT_MS);

function readStdinText() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks = [];
    const onData = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

try {
  const raw = (await readStdinText()).replace(/^\uFEFF/, '');
  let payload = {};
  if (raw && raw.trim()) {
    payload = JSON.parse(raw);
  }
  const mod = await import(new URL('./antigravity.mjs', import.meta.url).href);
  if (typeof mod?.runAntigravityHook !== 'function') {
    throw new Error('runAntigravityHook export is missing from antigravity.mjs');
  }
  const result = await mod.runAntigravityHook(mode, payload, {
    startedAt: Math.round(performance.timeOrigin),
  });
  clearTimeout(safetyTimer);
  emitAndExit(serializeOutput(result));
} catch (err) {
  clearTimeout(safetyTimer);
  writeStderrLine(err);
  emitAndExit(fallbackJson);
}
