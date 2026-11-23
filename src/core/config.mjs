import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const DEFAULT_CONFIG = Object.freeze({
  mode: 'all', // 'all' | 'opt-in'
  enabledProjects: [],
  excludedProjects: [],
  headCoreEnabled: true,
  hookBudget: 9000,
  embedding: {
    // none | auto | gemini | openai | ollama | onnx. Nothing is embedded (and nothing leaves this machine)
    // until the user picks a provider; "auto" is an explicit choice, not the default.
    provider: 'none',
    chunkMaxChars: 800,
    chunkOverlap: 100,
    timeoutMs: 15000, // per request while embedding documents
    queryTimeoutMs: 3000, // per search query embedding (single attempt, no retries)
    circuitBreakMs: 300000, // pause after a service-side failure before embeddings are attempted again
    // Each provider reads only its own block plus the shared keys above.
    gemini: { model: '', dimensions: 0, apiKeyEnv: '', apiKey: '', baseUrl: '' },
    openai: { model: '', dimensions: 0, apiKeyEnv: '', apiKey: '', baseUrl: '' },
    ollama: { baseUrl: '', model: '', dimensions: 0 },
    onnx: { enabled: false, model: '' },
  },
  // Per-project settings owned by the user, keyed by absolute project path:
  //   { "C:\\work\\proj-a": { "embedding": { "provider": "ollama", "ollama": { "model": "bge-m3" } } } }
  projects: {},
});

export const EMBEDDING_PROVIDER_NAMES = Object.freeze(['gemini', 'openai', 'ollama', 'onnx']);

/**
 * Flat `embedding.*` keys of the previous config format. They are ignored wherever they appear;
 * the settings now live in the per-provider blocks (`embedding.<provider>.*`).
 */
export const LEGACY_EMBEDDING_KEYS = Object.freeze(['baseUrl', 'model', 'dimensions', 'apiKey', 'apiKeyEnv', 'onnxEnabled']);

const DOC_ID_RE = /^[a-zA-Z0-9가-힣._-]+$/;
const RESERVED_WIN_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function realPathOrResolved(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * True when the module at `importMetaUrl` is the script Node was started with.
 * Node loads the main module from its real path while `process.argv[1]` keeps the path as typed,
 * so a launch through a junction or symlink only matches when both sides are compared as real paths.
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!importMetaUrl || !argv1) return false;
  let modulePath;
  try {
    modulePath = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }
  const a = realPathOrResolved(modulePath);
  const b = realPathOrResolved(argv1);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Resolve global cortex home directory.
 * Respects process.env.HERDR_CORTEX_HOME for test isolation.
 */
export function getGlobalDir(overrideGlobalDir) {
  if (overrideGlobalDir) return path.resolve(overrideGlobalDir);
  if (process.env.HERDR_CORTEX_HOME) return path.resolve(process.env.HERDR_CORTEX_HOME);
  return path.join(os.homedir(), '.herdr-cortex');
}

/**
 * Resolve project .memory directory.
 */
export function getProjectMemoryDir(projectDir = process.cwd()) {
  const resolved = path.resolve(projectDir);
  if (path.basename(resolved) === '.memory') return resolved;
  return path.join(resolved, '.memory');
}

/**
 * Resolve standard subdirectories and file paths for a storage tier.
 */
export function getTierPaths(tierDir) {
  const root = path.resolve(tierDir);
  const docsDir = path.join(root, 'docs');
  const stateDir = path.join(root, 'state');
  return {
    root,
    docsDir,
    stateDir,
    dbPath: path.join(root, 'index.sqlite'),
    indexMetaPath: path.join(stateDir, 'index-meta.json'),
    inboxDir: path.join(stateDir, 'inbox'),
    checkpointsDir: path.join(stateDir, 'checkpoints'),
    sessionsDir: path.join(root, 'sessions'),
    configPath: path.join(root, 'config.json'),
  };
}

/**
 * Ensure core tier directories exist.
 */
export function ensureTierDirs(tierDir) {
  const paths = getTierPaths(tierDir);
  fs.mkdirSync(paths.docsDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}

function readJsonSafe(filePath, { warnOnError = false } = {}) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (warnOnError) {
        console.error(`[herdr-cortex] Warning: config at "${filePath}" must be a JSON object; ignoring.`);
      }
      return null;
    }
    return parsed;
  } catch (err) {
    if (warnOnError) {
      console.error(`[herdr-cortex] Warning: failed to parse config at "${filePath}": ${err?.message || err}`);
    }
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keep only the keys a project's own `.memory/config.json` may set: `headCoreEnabled`, `hookBudget`,
 * and `enabled: false`. That file lives inside the repository, so whoever authored the repository controls it;
 * it must not be able to choose where documents are sent (`embedding`), which projects are enabled
 * (`mode`, `enabledProjects`, `excludedProjects`, `projects`), or switch a project on (`enabled: true`).
 * Per-project embedding settings belong in the user's global config under `projects["<project path>"]`.
 */
export function sanitizeProjectConfig(raw) {
  if (!isPlainObject(raw)) return null;
  const safe = {};

  if (typeof raw.headCoreEnabled === 'boolean') {
    safe.headCoreEnabled = raw.headCoreEnabled;
  }
  if (typeof raw.hookBudget === 'number' && Number.isFinite(raw.hookBudget)) {
    safe.hookBudget = raw.hookBudget;
  }
  if (raw.enabled === false) {
    safe.enabled = false;
  }

  return safe;
}

function mergeEmbedding(base, override) {
  const from = isPlainObject(base) ? base : {};
  const over = isPlainObject(override) ? override : {};
  const out = { ...from, ...over };
  // Provider blocks merge key by key, so an override of `ollama.model` keeps the inherited `ollama.baseUrl`.
  for (const name of EMBEDDING_PROVIDER_NAMES) {
    out[name] = {
      ...(isPlainObject(from[name]) ? from[name] : {}),
      ...(isPlainObject(over[name]) ? over[name] : {}),
    };
  }
  return out;
}

function mergeConfig(base, override) {
  const over = isPlainObject(override) ? override : {};
  return {
    ...base,
    ...over,
    embedding: mergeEmbedding(base.embedding, over.embedding),
  };
}

const configProblems = new WeakMap(); // merged config object -> problems found while loading it
const warnedConfigProblems = new Set();

function warnConfigOnce(key, message) {
  if (warnedConfigProblems.has(key)) return;
  warnedConfigProblems.add(key);
  console.error(`[herdr-cortex] Warning: ${message}`);
}

/**
 * Configuration problems recorded by `loadConfig` for the config object it returned:
 * [{ code, message, source, ... }] with code `legacy_embedding_keys` or `project_embedding_ignored`.
 * Empty for objects that did not come from `loadConfig`.
 */
export function getConfigProblems(config) {
  const found = config && typeof config === 'object' ? configProblems.get(config) : null;
  return found ? found.map((item) => ({ ...item })) : [];
}

/**
 * Names of old-format flat keys present in an `embedding` object (see `LEGACY_EMBEDDING_KEYS`).
 */
export function findLegacyEmbeddingKeys(embedding) {
  if (!isPlainObject(embedding)) return [];
  return LEGACY_EMBEDDING_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(embedding, key));
}

export function describeLegacyEmbeddingKeys(keys, location = 'embedding') {
  const named = keys.map((key) => `${location}.${key}`).join(', ');
  return `${named} ${keys.length === 1 ? 'is' : 'are'} from the old config format and ignored. `
    + `Move provider settings into ${location}.<provider> `
    + `(for example ${location}.ollama.baseUrl, ${location}.gemini.model, ${location}.openai.apiKeyEnv, ${location}.onnx.enabled).`;
}

// Returns a copy of `embedding` without the old flat keys and records a problem when any were present.
function dropLegacyEmbeddingKeys(embedding, { source, location, problems }) {
  if (!isPlainObject(embedding)) return undefined;
  const legacyKeys = findLegacyEmbeddingKeys(embedding);
  if (legacyKeys.length === 0) return embedding;

  const clean = { ...embedding };
  for (const key of legacyKeys) delete clean[key];

  const message = `${describeLegacyEmbeddingKeys(legacyKeys, location)} (in "${source}")`;
  problems.push({ code: 'legacy_embedding_keys', keys: legacyKeys, location, source, message });
  warnConfigOnce(`legacy\0${source}\0${location}\0${legacyKeys.join(',')}`, message);
  return clean;
}

function withCleanEmbedding(raw, context) {
  if (!isPlainObject(raw) || raw.embedding === undefined) return raw;
  const { embedding, ...rest } = raw;
  const clean = dropLegacyEmbeddingKeys(embedding, context);
  return clean === undefined ? rest : { ...rest, embedding: clean };
}

/**
 * Canonical form of a project path for exact-match comparison: absolute, junctions/symlinks resolved,
 * lower-cased on Windows. A path that does not exist yet is resolved through its deepest existing ancestor.
 */
export function projectPathKey(projectPath) {
  const resolved = path.resolve(String(projectPath));
  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    try {
      real = resolveRealPathWithFallback(resolved);
    } catch {
      real = resolved;
    }
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function resolveProjectRoot(projectDir) {
  const resolved = path.resolve(projectDir);
  return path.basename(resolved) === '.memory' ? path.dirname(resolved) : resolved;
}

// Entries of the global `projects` map whose key is exactly this project root (never a parent or a folder name).
function findProjectEntries(projects, projectRoot) {
  if (!isPlainObject(projects)) return [];
  const wanted = projectPathKey(projectRoot);
  const matches = [];
  for (const [key, entry] of Object.entries(projects)) {
    if (typeof key !== 'string' || !path.isAbsolute(key.trim()) || !isPlainObject(entry)) continue;
    if (projectPathKey(key.trim()) === wanted) matches.push({ key, entry });
  }
  return matches;
}

/**
 * Load the merged config. Later sources override earlier ones:
 *   1. `DEFAULT_CONFIG`
 *   2. global `config.json`
 *   3. `projects["<this project's path>"].embedding` of the global `config.json` (exact project root, real path)
 *   4. the project's own `.memory/config.json`, reduced by `sanitizeProjectConfig`
 *   5. `overrides` (programmatic, e.g. CLI flags)
 * Old-format flat `embedding.*` keys and an `embedding` block in the project file are ignored; each is reported
 * once per process on stderr and through `getConfigProblems(config)`.
 */
export function loadConfig({ projectDir, globalDir, overrides } = {}) {
  const problems = [];
  const gPaths = getTierPaths(getGlobalDir(globalDir));
  const globalRaw = readJsonSafe(gPaths.configPath, { warnOnError: true });
  let cfg = mergeConfig(
    DEFAULT_CONFIG,
    withCleanEmbedding(globalRaw, { source: gPaths.configPath, location: 'embedding', problems }),
  );

  if (projectDir) {
    const projectRoot = resolveProjectRoot(projectDir);
    for (const { key, entry } of findProjectEntries(globalRaw?.projects, projectRoot)) {
      const embedding = dropLegacyEmbeddingKeys(entry.embedding, {
        source: gPaths.configPath,
        location: `projects[${JSON.stringify(key)}].embedding`,
        problems,
      });
      if (embedding) cfg = mergeConfig(cfg, { embedding });
    }

    const pPaths = getTierPaths(getProjectMemoryDir(projectDir));
    const projectRaw = readJsonSafe(pPaths.configPath);
    if (isPlainObject(projectRaw) && projectRaw.embedding !== undefined) {
      const message = `"embedding" in the project file "${pPaths.configPath}" is ignored: a repository cannot choose `
        + 'where documents are sent. Put per-project embedding settings in the global config.json under '
        + `projects[${JSON.stringify(projectRoot)}].embedding.`;
      problems.push({ code: 'project_embedding_ignored', source: pPaths.configPath, message });
      warnConfigOnce(`project-embedding\0${pPaths.configPath}`, message);
    }
    cfg = mergeConfig(cfg, sanitizeProjectConfig(projectRaw));
  }

  if (overrides) {
    cfg = mergeConfig(cfg, withCleanEmbedding(overrides, { source: 'overrides', location: 'embedding', problems }));
  }

  configProblems.set(cfg, problems);
  return cfg;
}

function normalizeMatchPath(p) {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function matchesProjectRule(normPath, segments, rule) {
  if (typeof rule !== 'string') return false;
  const clean = rule.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!clean) return false;
  if (clean.includes('/') || /^[a-z]:/i.test(clean)) {
    return normPath === clean || normPath.startsWith(`${clean}/`);
  }
  return segments.includes(clean);
}

/**
 * Determine whether cortex context/memory is enabled for `projectDir`.
 * Note: `revive` session-ID tracking still runs independently so reboot recovery stays intact.
 * Precedence:
 *   1) Explicit opt-out `enabled: false`
 *   2) `excludedProjects` (exact/ancestor path OR folder name segment, case-insensitive) — cannot be bypassed
 *   3) `mode === 'opt-in'` -> requires match in `enabledProjects` — cannot be bypassed by project `enabled: true`
 *   4) Otherwise enabled (`mode === 'all'`)
 */
export function isProjectEnabled(projectDir, config = DEFAULT_CONFIG) {
  if (!config || typeof config !== 'object') return true;
  if (config.enabled === false) return false;

  const normPath = normalizeMatchPath(projectDir || process.cwd());
  const segments = normPath.split('/').filter(Boolean);

  const excluded = Array.isArray(config.excludedProjects) ? config.excludedProjects : [];
  if (excluded.some((rule) => matchesProjectRule(normPath, segments, rule))) {
    return false;
  }

  if (String(config.mode || 'all').trim().toLowerCase() === 'opt-in') {
    const enabled = Array.isArray(config.enabledProjects) ? config.enabledProjects : [];
    return enabled.some((rule) => matchesProjectRule(normPath, segments, rule));
  }

  return true;
}

/**
 * Validate a document or terminal ID against path traversal and Windows reserved names.
 */
export function isValidId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 128) return false;
  if (!DOC_ID_RE.test(id)) return false;
  if (id.includes('..') || id.startsWith('.') || id.endsWith('.')) return false;
  const baseName = id.split('.')[0].toLowerCase();
  if (RESERVED_WIN_NAMES.has(baseName)) return false;
  return true;
}

export function validateDocId(id) {
  if (!isValidId(id)) {
    throw new Error(`Invalid ID "${String(id)}": must match ^[a-zA-Z0-9가-힣._-]+$ without ".." or reserved names`);
  }
  return id;
}

function isInsideResolved(baseResolved, targetResolved) {
  const rel = path.relative(baseResolved, targetResolved);
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Find deepest existing ancestor so realpathSync can detect symlink escapes
 * even when the final file does not yet exist.
 */
function resolveRealPathWithFallback(targetPath) {
  const resolved = path.resolve(targetPath);
  const tailSegments = [];
  let cursor = resolved;

  while (true) {
    try {
      const realCursor = fs.realpathSync(cursor);
      return tailSegments.length > 0 ? path.join(realCursor, ...tailSegments.reverse()) : realCursor;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const parent = path.dirname(cursor);
        if (parent === cursor) return resolved;
        tailSegments.push(path.basename(cursor));
        cursor = parent;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Guard against path traversal and symlink escapes out of baseDir.
 * Returns the resolved target path if safe; throws otherwise.
 */
export function assertInsideDir(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);

  if (!isInsideResolved(resolvedBase, resolvedTarget)) {
    throw new Error(`Path traversal denied: "${targetPath}" escapes "${resolvedBase}"`);
  }

  const realBase = resolveRealPathWithFallback(resolvedBase);
  const realTarget = resolveRealPathWithFallback(resolvedTarget);

  if (!isInsideResolved(realBase, realTarget)) {
    throw new Error(`Symlink traversal denied: "${targetPath}" resolves outside "${realBase}"`);
  }

  return resolvedTarget;
}

/**
 * Windows-safe atomic UTF-8 file write:
 * writes to a unique temp file with exclusive creation ('wx') and renames into place
 * with retry backoff for Windows EBUSY/EPERM transient file locks.
 */
export function atomicWriteText(filePath, content) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(resolved)}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
  );

  try {
    fs.writeFileSync(tmpPath, String(content), { encoding: 'utf8', flag: 'wx' });

    const maxRetries = 8;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        fs.renameSync(tmpPath, resolved);
        return resolved;
      } catch (err) {
        const retryable = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
        if (!retryable || attempt === maxRetries) {
          throw err;
        }
        sleepSync(15 * (attempt + 1));
      }
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
  return resolved;
}

export function atomicWriteJson(filePath, data) {
  return atomicWriteText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Normalize a relative file path to POSIX forward slashes without leading "./".
 */
export function normalizeRelPath(filePath) {
  if (typeof filePath !== 'string') return '';
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

/**
 * Strictly validate and normalize a relative file path.
 * When `projectRoot` is provided, an absolute path strictly inside `projectRoot`
 * is automatically converted into a project-relative POSIX path.
 * Rejects NUL bytes, URLs, paths outside `projectRoot`, drive-relative paths, and traversal escapes.
 * Returns normalized POSIX relative path or null if invalid.
 */
export function sanitizeRelFilePath(raw, projectRoot = null) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return null;

  const isWinDrive = /^[a-zA-Z]:/.test(trimmed);
  const isLeadingSlash = trimmed.startsWith('/') || trimmed.startsWith('\\');

  if (isWinDrive || isLeadingSlash) {
    if (!projectRoot) return null;
    // Reject Windows drive-relative paths like "C:foo" (require "C:/" or "C:\")
    if (isWinDrive && !/^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
    // Reject UNC paths like "\\server\share"
    if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) return null;

    const resolvedRoot = path.resolve(projectRoot);
    const resolvedTarget = path.resolve(trimmed);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../') || path.isAbsolute(rel)) {
      return null;
    }

    try {
      const realRoot = resolveRealPathWithFallback(resolvedRoot);
      const realTarget = resolveRealPathWithFallback(resolvedTarget);
      const realRel = path.relative(realRoot, realTarget);
      if (!realRel || realRel === '.' || realRel === '..' || realRel.startsWith(`..${path.sep}`) || realRel.startsWith('../') || path.isAbsolute(realRel)) {
        return null;
      }
    } catch {
      return null;
    }

    const posixFromAbs = rel.replace(/\\/g, '/');
    const normalizedAbs = path.posix.normalize(posixFromAbs);
    if (
      !normalizedAbs
      || normalizedAbs === '.'
      || normalizedAbs === '..'
      || normalizedAbs.startsWith('../')
      || normalizedAbs.startsWith('/')
    ) {
      return null;
    }
    return normalizedAbs;
  }

  const posixRaw = trimmed.replace(/\\/g, '/');
  const normalized = path.posix.normalize(posixRaw);
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.startsWith('/')
  ) {
    return null;
  }
  return normalized;
}

const TYPE_PREFIX = {
  decision: 'dec',
  worklog: 'work',
  knowledge: 'know',
  todo: 'todo',
  baseline: 'base',
};

/**
 * Format local ISO-8601 timestamp with millisecond precision and timezone offset
 * (e.g. 2026-11-22T21:15:00.042+09:00). Millisecond precision keeps documents saved
 * within the same second in creation order.
 */
export function formatIsoTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offH = pad(Math.floor(absMin / 60));
  const offM = pad(absMin % 60);
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}${sign}${offH}:${offM}`
  );
}

const TIMESTAMP_PARTS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * Parse a document timestamp into epoch milliseconds.
 * Accepts the current millisecond format, the older second-precision format, date-only values,
 * and timestamps with or without a timezone offset (no offset = local time).
 * Returns NaN when the value is not a recognizable timestamp.
 */
export function parseTimestampMs(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return NaN;
  const m = TIMESTAMP_PARTS_RE.exec(raw);
  if (!m) {
    return Date.parse(raw);
  }
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone = ''] = m;
  const fracMs = frac ? Number(`0.${frac}`) * 1000 : 0;
  if (!zone) {
    const local = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
    return local + fracMs;
  }
  let offsetMin = 0;
  if (zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    offsetMin = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * (zone[0] === '-' ? -1 : 1);
  }
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return utc - offsetMin * 60000 + fracMs;
}

/**
 * Chronological comparator for document timestamps of mixed precision or format.
 * Values that cannot be parsed sort before parseable ones, and among themselves as plain strings.
 */
export function compareTimestamps(a, b) {
  const ta = parseTimestampMs(a);
  const tb = parseTimestampMs(b);
  const aOk = Number.isFinite(ta);
  const bOk = Number.isFinite(tb);
  if (aOk && bOk) return ta < tb ? -1 : ta > tb ? 1 : 0;
  if (aOk !== bOk) return aOk ? 1 : -1;
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Generate a safe document ID from type + date + title slug.
 */
export function generateDocId(type, title, now = new Date()) {
  const prefix = TYPE_PREFIX[type] || 'doc';
  const d = now instanceof Date ? now : new Date(now);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const slug = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const rand = crypto.randomBytes(2).toString('hex');
  const candidate = slug ? `${prefix}-${ymd}-${slug}-${rand}` : `${prefix}-${ymd}-${rand}`;
  return validateDocId(candidate);
}
