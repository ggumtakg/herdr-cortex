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
    provider: 'auto', // auto | gemini | openai | ollama | onnx | none
    model: '',
    dimensions: 0,
    baseUrl: '',
    apiKeyEnv: '',
    onnxEnabled: false,
    chunkMaxChars: 800,
    chunkOverlap: 100,
    timeoutMs: 15000,
  },
});

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

const ALLOWED_PROJECT_EMBEDDING_KEYS = [
  'provider',
  'model',
  'dimensions',
  'chunkMaxChars',
  'chunkOverlap',
  'timeoutMs',
];

/**
 * Whitelist only safe non-network, non-secret, non-global-scoping keys from project `.memory/config.json`.
 * Strips `embedding.baseUrl`, `embedding.apiKey`, `embedding.apiKeyEnv`, `embedding.onnxEnabled`,
 * `mode`, `enabledProjects`, `excludedProjects`, and `enabled: true` (only `enabled: false` is permitted).
 */
export function sanitizeProjectConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
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

  if (raw.embedding && typeof raw.embedding === 'object' && !Array.isArray(raw.embedding)) {
    const safeEmb = {};
    for (const key of ALLOWED_PROJECT_EMBEDDING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(raw.embedding, key) && raw.embedding[key] !== undefined) {
        safeEmb[key] = raw.embedding[key];
      }
    }
    if (Object.keys(safeEmb).length > 0) {
      safe.embedding = safeEmb;
    }
  }

  return safe;
}

function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return base;
  return {
    ...base,
    ...override,
    embedding: {
      ...base.embedding,
      ...(override.embedding && typeof override.embedding === 'object' ? override.embedding : {}),
    },
  };
}

/**
 * Load merged config from defaults -> global config.json -> whitelisted project .memory/config.json.
 */
export function loadConfig({ projectDir, globalDir, overrides } = {}) {
  const gPaths = getTierPaths(getGlobalDir(globalDir));
  let cfg = mergeConfig(DEFAULT_CONFIG, readJsonSafe(gPaths.configPath, { warnOnError: true }));

  if (projectDir) {
    const pPaths = getTierPaths(getProjectMemoryDir(projectDir));
    const projectRaw = readJsonSafe(pPaths.configPath);
    const projectSafe = sanitizeProjectConfig(projectRaw);
    cfg = mergeConfig(cfg, projectSafe);
  }

  if (overrides) {
    cfg = mergeConfig(cfg, overrides);
  }

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
 * Format local ISO-8601 timestamp with timezone offset (e.g. 2026-11-22T21:15:00+09:00).
 */
export function formatIsoTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offH = pad(Math.floor(absMin / 60));
  const offM = pad(absMin % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${offH}:${offM}`
  );
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
