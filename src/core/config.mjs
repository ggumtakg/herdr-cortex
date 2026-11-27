import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const CORTEX_ROOT_PLACEHOLDER = '{{HERDR_CORTEX_ROOT}}';

/**
 * Replace every `{{HERDR_CORTEX_ROOT}}` placeholder in a prompt asset with the installed repository root
 * using forward slashes (`/`), leaving text that does not contain the placeholder untouched to the character.
 */
export function expandCortexRootPlaceholder(text, repoRoot = REPO_ROOT) {
  if (typeof text !== 'string' || !text.includes(CORTEX_ROOT_PLACEHOLDER)) return text;
  const resolved = path.resolve(String(repoRoot || REPO_ROOT)).replace(/\\/g, '/');
  const normalizedRoot = /^(?:\/|[A-Za-z]:\/)$/.test(resolved) ? resolved : resolved.replace(/\/+$/, '');
  return text.split(CORTEX_ROOT_PLACEHOLDER).join(normalizedRoot);
}

export const DEFAULT_WORK_SIZE = Object.freeze({
  enabled: true,
  maxFilesPerWindow: 1,
  maxCharsPerFile: 1000,
});

export const WORK_SIZE_KEYS = Object.freeze(['enabled', 'maxFilesPerWindow', 'maxCharsPerFile']);

export const DEFAULT_CONFIG = Object.freeze({
  mode: 'all', // 'all' | 'opt-in'
  enabledProjects: [],
  excludedProjects: [],
  headCoreEnabled: true,
  hookBudget: 9000,
  workSize: DEFAULT_WORK_SIZE,
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

/**
 * Mapping of each legacy flat `embedding.<key>` to its per-provider `embedding.<provider>.<target>` key.
 * Keys omitted for a provider have no equivalent in that provider's block.
 */
export const LEGACY_EMBEDDING_KEY_TARGETS = Object.freeze({
  gemini: Object.freeze({
    baseUrl: 'baseUrl',
    model: 'model',
    dimensions: 'dimensions',
    apiKey: 'apiKey',
    apiKeyEnv: 'apiKeyEnv',
  }),
  openai: Object.freeze({
    baseUrl: 'baseUrl',
    model: 'model',
    dimensions: 'dimensions',
    apiKey: 'apiKey',
    apiKeyEnv: 'apiKeyEnv',
  }),
  ollama: Object.freeze({
    baseUrl: 'baseUrl',
    model: 'model',
    dimensions: 'dimensions',
  }),
  onnx: Object.freeze({
    model: 'model',
    dimensions: 'dimensions',
    onnxEnabled: 'enabled',
  }),
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

/** Folder name of the global store inside a home directory. */
export const GLOBAL_DIR_NAME = '.herdr-cortex';

function envText(env, name) {
  const value = env && typeof env === 'object' ? env[name] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * The home directory herdr-cortex works against (Claude Code and Antigravity settings, the predecessor's
 * `.herdr-revive` store, and the default place of the global store):
 *   1. `homeDir` when given,
 *   2. `HERDR_CORTEX_TEST_HOME` (`HERDR_REVIVE_TEST_HOME` is the predecessor's name for the same thing),
 *   3. the user's home directory.
 */
export function resolveHomeDir(homeDir, { env = process.env } = {}) {
  if (typeof homeDir === 'string' && homeDir.trim()) return path.resolve(homeDir.trim());
  const testHome = envText(env, 'HERDR_CORTEX_TEST_HOME') || envText(env, 'HERDR_REVIVE_TEST_HOME');
  if (testHome) return path.resolve(testHome);
  return os.homedir();
}

/**
 * The one place the location of the global store is decided. The runtime (store, hooks, MCP server, relay,
 * session tracker), the command lines and the installer all go through it; the PowerShell scripts apply the
 * same order in `scripts/store-location.ps1`. Precedence:
 *   1. an explicit argument: `globalDir`, else `homeDir` (the store is then `<homeDir>/.herdr-cortex`),
 *   2. `HERDR_CORTEX_HOME`,
 *   3. `<HERDR_CORTEX_TEST_HOME>/.herdr-cortex` (`HERDR_REVIVE_TEST_HOME` counts as the same variable),
 *   4. `<user home>/.herdr-cortex`.
 * `env` is injectable for tests.
 */
export function resolveGlobalDir({ globalDir, homeDir, env = process.env } = {}) {
  if (typeof globalDir === 'string' && globalDir.trim()) return path.resolve(globalDir.trim());
  if (typeof homeDir === 'string' && homeDir.trim()) return path.join(path.resolve(homeDir.trim()), GLOBAL_DIR_NAME);
  const fromEnv = envText(env, 'HERDR_CORTEX_HOME');
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(resolveHomeDir('', { env }), GLOBAL_DIR_NAME);
}

/**
 * The global store directory: `overrideGlobalDir` when given, otherwise what `resolveGlobalDir` finds.
 */
export function getGlobalDir(overrideGlobalDir) {
  return resolveGlobalDir({ globalDir: overrideGlobalDir });
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

export const MEMORY_GITIGNORE_CONTENT = '*\n';

/**
 * Keep a project's `.memory/` out of git: create `<memoryDir>/.gitignore` containing a single `*` line
 * unless a `.gitignore` is already there (an existing file is never touched). Only write paths call this,
 * so read-only operations still create nothing. Returns true when the file was created.
 */
export function ensureMemoryGitignore(memoryDir) {
  try {
    fs.writeFileSync(path.join(path.resolve(memoryDir), '.gitignore'), MEMORY_GITIGNORE_CONTENT, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return true;
  } catch {
    // Already present (EEXIST) or not writable: never overwrite, and never fail the write that triggered this.
    return false;
  }
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

function mergeWorkSize(base, override) {
  const from = isPlainObject(base) ? base : DEFAULT_WORK_SIZE;
  const over = isPlainObject(override) ? override : {};
  return { ...from, ...over };
}

function mergeConfig(base, override) {
  const over = isPlainObject(override) ? override : {};
  return {
    ...base,
    ...over,
    workSize: mergeWorkSize(base.workSize, over.workSize),
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

function singleLineConfigText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function describeRawProvider(rawProvider) {
  const provider = typeof rawProvider === 'string' ? rawProvider.trim().toLowerCase() : '';
  let providerDisplay = 'not set';
  if (typeof rawProvider === 'string' && rawProvider.trim() !== '') {
    providerDisplay = JSON.stringify(rawProvider.trim());
  } else if (rawProvider !== undefined && rawProvider !== null && rawProvider !== '') {
    providerDisplay = JSON.stringify(rawProvider);
  }
  return { provider, providerDisplay };
}

/**
 * One-line notices for the user's screen when `loadConfig` found ignored old-format `embedding.*` keys.
 * Global top-level settings advise re-running `install.ps1` immediately only when `embedding.provider`
 * already names a valid provider (with a valid provider block); otherwise they explain why `install.ps1`
 * cannot migrate them automatically and what to change or delete. Per-project settings advise moving
 * supported settings and deleting unused keys directly.
 */
export function formatLegacyEmbeddingUserNotices(config) {
  const notices = [];
  for (const problem of getConfigProblems(config)) {
    if (problem.code === 'legacy_embedding_keys') {
      if (!problem.source || problem.source === 'overrides') continue;
      const location = singleLineConfigText(problem.location || 'embedding');
      const keys = Array.isArray(problem.keys) ? problem.keys : [];
      if (keys.length === 0) continue;
      const named = keys.map((key) => `${location}.${key}`).join(', ');
      const source = singleLineConfigText(problem.source);
      if (location === 'embedding') {
        if (problem.providerValid && problem.providerBlockOk) {
          notices.push(
            `[herdr-cortex] Ignored old-format setting(s) in "${source}": ${named}. `
            + `Re-run install.ps1 to migrate supported settings into embedding.${problem.provider} and remove unused ones `
            + `(or move supported settings into embedding.${problem.provider} and delete unused flat keys manually).`,
          );
        } else if (problem.providerValid && !problem.providerBlockOk) {
          notices.push(
            `[herdr-cortex] Ignored old-format setting(s) in "${source}": ${named}. `
            + `install.ps1 cannot migrate them automatically because embedding.${problem.provider} is not a JSON object; `
            + `fix embedding.${problem.provider} and re-run install.ps1, or delete unused flat keys manually.`,
          );
        } else {
          const provText = singleLineConfigText(problem.providerDisplay || 'not set');
          notices.push(
            `[herdr-cortex] Ignored old-format setting(s) in "${source}": ${named}. `
            + `install.ps1 cannot migrate them automatically because embedding.provider is ${provText} (not gemini, openai, ollama or onnx); `
            + 'set embedding.provider to a specific provider and re-run install.ps1, or move needed settings into embedding.<provider> and delete unused flat keys.',
          );
        }
      } else if (problem.providerValid) {
        const targets = LEGACY_EMBEDDING_KEY_TARGETS[problem.provider] || {};
        const mapped = keys.filter((key) => Boolean(targets[key]));
        const unmapped = keys.filter((key) => !targets[key]);
        if (mapped.length > 0 && unmapped.length === 0) {
          notices.push(
            `[herdr-cortex] Ignored old-format per-project setting(s) in "${source}": ${named}. `
            + `Move them into ${location}.${problem.provider} manually, or delete them if unused (install.ps1 does not edit per-project settings).`,
          );
        } else if (mapped.length === 0) {
          notices.push(
            `[herdr-cortex] Ignored old-format per-project setting(s) in "${source}": ${named}. `
            + `Delete ${unmapped.length === 1 ? 'it' : 'them'} from ${location} manually — not used by ${problem.provider} (install.ps1 does not edit per-project settings).`,
          );
        } else {
          notices.push(
            `[herdr-cortex] Ignored old-format per-project setting(s) in "${source}": ${named}. `
            + `Move supported settings into ${location}.${problem.provider} and delete unused flat key(s) `
            + `(${unmapped.map((key) => `${location}.${key}`).join(', ')}) manually (install.ps1 does not edit per-project settings).`,
          );
        }
      } else {
        notices.push(
          `[herdr-cortex] Ignored old-format per-project setting(s) in "${source}": ${named}. `
          + `Move needed settings into ${location}.<provider> and delete unused or unsupported flat keys manually (install.ps1 does not edit per-project settings).`,
        );
      }
    } else if (problem.code === 'project_embedding_ignored' && Array.isArray(problem.legacyKeys) && problem.legacyKeys.length > 0) {
      const named = problem.legacyKeys.map((key) => `embedding.${key}`).join(', ');
      const source = singleLineConfigText(problem.source);
      const targetRoot = singleLineConfigText(problem.projectRoot || path.dirname(path.dirname(problem.source || '')));
      notices.push(
        `[herdr-cortex] Ignored old-format project setting(s) in "${source}": ${named}. `
        + 'Project .memory/config.json cannot set embedding; move needed supported settings manually into global config.json under '
        + `projects[${JSON.stringify(targetRoot)}].embedding.<provider> and remove "embedding" (including unused keys) from "${source}".`,
      );
    }
  }
  return notices;
}

/**
 * Same notices formatted for a host that only has a model-context channel (Antigravity `injectSteps`).
 */
export function formatLegacyEmbeddingContextNotice(config) {
  const notices = formatLegacyEmbeddingUserNotices(config);
  if (notices.length === 0) return '';
  return notices.map((line) => `${line} Tell the user about this notice.`).join('\n');
}

// Returns a copy of `embedding` without the old flat keys and records a problem when any were present.
function dropLegacyEmbeddingKeys(embedding, { source, location, problems }) {
  if (!isPlainObject(embedding)) return undefined;
  const legacyKeys = findLegacyEmbeddingKeys(embedding);
  if (legacyKeys.length === 0) return embedding;

  const clean = { ...embedding };
  for (const key of legacyKeys) delete clean[key];

  const { provider, providerDisplay } = describeRawProvider(embedding.provider);
  const providerValid = EMBEDDING_PROVIDER_NAMES.includes(provider);
  const providerBlockOk = providerValid && (embedding[provider] === undefined || isPlainObject(embedding[provider]));

  const message = `${describeLegacyEmbeddingKeys(legacyKeys, location)} (in "${source}")`;
  problems.push({
    code: 'legacy_embedding_keys',
    keys: legacyKeys,
    location,
    source,
    provider,
    providerDisplay,
    providerValid,
    providerBlockOk,
    message,
  });
  warnConfigOnce(`legacy\0${source}\0${location}\0${legacyKeys.join(',')}`, message);
  return clean;
}

function sanitizeWorkSize(workSize, { source, location, problems }) {
  if (workSize === undefined) return undefined;
  const sourceNote = source && source !== 'overrides' ? ` (in "${source}")` : '';
  const recordProblem = (subKey, detail) => {
    const fullLocation = subKey ? `${location}.${subKey}` : location;
    const message = `${detail}${sourceNote}`;
    problems.push({
      code: 'invalid_work_size',
      ...(subKey ? { key: subKey } : {}),
      location: fullLocation,
      source,
      message,
    });
    warnConfigOnce(`worksize\0${source}\0${fullLocation}\0${detail}`, message);
  };

  if (!isPlainObject(workSize)) {
    recordProblem('', `${location} must be a JSON object; using defaults.`);
    return { ...DEFAULT_WORK_SIZE };
  }

  const clean = {};
  for (const key of Object.keys(workSize)) {
    if (!WORK_SIZE_KEYS.includes(key)) {
      recordProblem(key, `Unknown setting ${location}.${key} is ignored.`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(workSize, 'enabled')) {
    if (typeof workSize.enabled === 'boolean') {
      clean.enabled = workSize.enabled;
    } else {
      recordProblem('enabled', `${location}.enabled must be a boolean; using default (${DEFAULT_WORK_SIZE.enabled}).`);
      clean.enabled = DEFAULT_WORK_SIZE.enabled;
    }
  }

  if (Object.prototype.hasOwnProperty.call(workSize, 'maxFilesPerWindow')) {
    const val = workSize.maxFilesPerWindow;
    if (typeof val === 'number' && Number.isInteger(val) && val >= 1) {
      clean.maxFilesPerWindow = val;
    } else {
      recordProblem(
        'maxFilesPerWindow',
        `${location}.maxFilesPerWindow must be an integer >= 1; using default (${DEFAULT_WORK_SIZE.maxFilesPerWindow}).`,
      );
      clean.maxFilesPerWindow = DEFAULT_WORK_SIZE.maxFilesPerWindow;
    }
  }

  if (Object.prototype.hasOwnProperty.call(workSize, 'maxCharsPerFile')) {
    const val = workSize.maxCharsPerFile;
    if (typeof val === 'number' && Number.isInteger(val) && val >= 1) {
      clean.maxCharsPerFile = val;
    } else {
      recordProblem(
        'maxCharsPerFile',
        `${location}.maxCharsPerFile must be an integer >= 1; using default (${DEFAULT_WORK_SIZE.maxCharsPerFile}).`,
      );
      clean.maxCharsPerFile = DEFAULT_WORK_SIZE.maxCharsPerFile;
    }
  }

  return clean;
}

function withCleanSections(raw, { source, problems }) {
  if (!isPlainObject(raw)) return raw;
  let next = raw;
  if (raw.embedding !== undefined) {
    const { embedding, ...rest } = next;
    const clean = dropLegacyEmbeddingKeys(embedding, { source, location: 'embedding', problems });
    next = clean === undefined ? rest : { ...rest, embedding: clean };
  }
  if (raw.workSize !== undefined) {
    const { workSize, ...rest } = next;
    const clean = sanitizeWorkSize(workSize, { source, location: 'workSize', problems });
    next = clean === undefined ? rest : { ...rest, workSize: clean };
  }
  return next;
}

/**
 * Normalize a `config.workSize` block (whether loaded via `loadConfig` or constructed in-memory),
 * returning `{ enabled, maxFilesPerWindow, maxCharsPerFile }` with valid defaults for any bad/missing field.
 */
export function resolveWorkSizeConfig(config = DEFAULT_CONFIG) {
  const raw = isPlainObject(config?.workSize) ? config.workSize : {};
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_WORK_SIZE.enabled,
    maxFilesPerWindow: typeof raw.maxFilesPerWindow === 'number' && Number.isInteger(raw.maxFilesPerWindow) && raw.maxFilesPerWindow >= 1
      ? raw.maxFilesPerWindow
      : DEFAULT_WORK_SIZE.maxFilesPerWindow,
    maxCharsPerFile: typeof raw.maxCharsPerFile === 'number' && Number.isInteger(raw.maxCharsPerFile) && raw.maxCharsPerFile >= 1
      ? raw.maxCharsPerFile
      : DEFAULT_WORK_SIZE.maxCharsPerFile,
  };
}

/**
 * Canonical form of a project path for exact-match comparison: absolute, junctions/symlinks resolved,
 * lower-cased on Windows. A path that does not exist yet is resolved through its deepest existing ancestor.
 */
export function projectPathKey(projectPath) {
  const real = realPathLenient(projectPath);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

// Real path of `targetPath`; a path that does not exist is resolved through its deepest existing ancestor.
function realPathLenient(targetPath) {
  const resolved = path.resolve(String(targetPath));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return resolveRealPathWithFallback(resolved);
    } catch {
      return resolved;
    }
  }
}

/**
 * The project root a directory argument refers to: the directory itself, or its parent when the
 * argument is the `.memory` folder (the same rule `getProjectMemoryDir` applies).
 */
export function resolveProjectRoot(projectDir) {
  const resolved = path.resolve(projectDir);
  return path.basename(resolved) === '.memory' ? path.dirname(resolved) : resolved;
}

/**
 * State file listing the project folders the user approved (`src/core/trust.mjs` holds the write side).
 * It lives in the user's global store, apart from the user-edited `config.json`:
 *   { "version": 1, "projects": [ { "path": "<real path of the project root>", "approvedAt": "<timestamp>" } ] }
 */
export function getTrustedProjectsPath(globalDir) {
  return path.join(getTierPaths(getGlobalDir(globalDir)).stateDir, 'trusted-projects.json');
}

/**
 * Comparison key of a path stored in the approval list. The stored value already is a real path, so it is
 * NOT resolved again: if that location later becomes a junction to some other folder, the other folder
 * does not inherit the approval.
 */
export function trustedPathKey(storedPath) {
  const resolved = path.resolve(String(storedPath));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Valid entries of the approval list: [{ path, approvedAt }]. A missing or unreadable file means no approvals.
 */
export function readTrustedProjects(globalDir) {
  const data = readJsonSafe(getTrustedProjectsPath(globalDir));
  if (!data || !Array.isArray(data.projects)) return [];
  const entries = [];
  for (const item of data.projects) {
    if (!isPlainObject(item) || typeof item.path !== 'string') continue;
    const storedPath = item.path.trim();
    if (!storedPath || !path.isAbsolute(storedPath)) continue;
    entries.push({ path: storedPath, approvedAt: typeof item.approvedAt === 'string' ? item.approvedAt : '' });
  }
  return entries;
}

/**
 * True when the user approved exactly this project folder. Nothing in a project's `.memory/` is read,
 * injected or written before that. The folder is compared by its real path (junctions and symlinks
 * resolved, case-insensitive on Windows) and must match exactly: a parent folder, a subfolder or a folder
 * of the same name elsewhere does not count. Independent of `isProjectEnabled`; callers check both.
 */
export function isProjectTrusted(projectDir = process.cwd(), { globalDir } = {}) {
  if (typeof projectDir !== 'string' || !projectDir.trim()) return false;
  const wanted = projectPathKey(resolveProjectRoot(projectDir.trim()));
  return readTrustedProjects(globalDir).some((entry) => trustedPathKey(entry.path) === wanted);
}

/**
 * True when the project folder contains a `.memory/` directory (whether or not it may be used).
 */
export function hasProjectMemoryDir(projectDir = process.cwd()) {
  try {
    return fs.statSync(getProjectMemoryDir(projectDir)).isDirectory();
  } catch {
    return false;
  }
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
 *   4. the project's own `.memory/config.json`, reduced by `sanitizeProjectConfig` — only when the user
 *      approved the project folder (`isProjectTrusted`); the file of an unapproved folder is not read at all
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
    withCleanSections(globalRaw, { source: gPaths.configPath, problems }),
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
      const workSize = sanitizeWorkSize(entry.workSize, {
        source: gPaths.configPath,
        location: `projects[${JSON.stringify(key)}].workSize`,
        problems,
      });
      if (workSize) cfg = mergeConfig(cfg, { workSize });
    }

    const pPaths = getTierPaths(getProjectMemoryDir(projectDir));
    const projectRaw = isProjectTrusted(projectRoot, { globalDir }) ? readJsonSafe(pPaths.configPath) : null;
    if (isPlainObject(projectRaw) && projectRaw.embedding !== undefined) {
      const legacyKeys = findLegacyEmbeddingKeys(projectRaw.embedding);
      const message = `"embedding" in the project file "${pPaths.configPath}" is ignored: a repository cannot choose `
        + 'where documents are sent. Put per-project embedding settings in the global config.json under '
        + `projects[${JSON.stringify(projectRoot)}].embedding.`;
      problems.push({
        code: 'project_embedding_ignored',
        source: pPaths.configPath,
        projectRoot,
        ...(legacyKeys.length > 0 ? { legacyKeys } : {}),
        message,
      });
      warnConfigOnce(`project-embedding\0${pPaths.configPath}`, message);
    }
    cfg = mergeConfig(cfg, sanitizeProjectConfig(projectRaw));
  }

  if (overrides) {
    cfg = mergeConfig(cfg, withCleanSections(overrides, { source: 'overrides', problems }));
  }

  configProblems.set(cfg, problems);
  return cfg;
}

function normalizeMatchString(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// The project path in the forms rules are matched against: as given, and with junctions/symlinks resolved.
function describeProjectForMatch(projectDir) {
  const given = normalizeMatchString(path.resolve(projectDir));
  const real = normalizeMatchString(realPathLenient(projectDir));
  const forms = given === real ? [given] : [given, real];
  return { forms, segments: new Set(forms.flatMap((form) => form.split('/').filter(Boolean))) };
}

function matchesProjectRule(project, rule) {
  if (typeof rule !== 'string') return false;
  const raw = rule.trim();
  const clean = normalizeMatchString(raw);
  if (!clean) return false;
  if (clean.includes('/') || /^[a-z]:/i.test(clean)) {
    // Path rule: compared as written and, when absolute, by its real path, so the rule and the project match
    // no matter which of the two is reached through a junction, a symlink or a short (8.3) name.
    const ruleForms = new Set([clean]);
    if (path.isAbsolute(raw)) ruleForms.add(normalizeMatchString(realPathLenient(raw)));
    for (const ruleForm of ruleForms) {
      if (!ruleForm) continue;
      if (project.forms.some((form) => form === ruleForm || form.startsWith(`${ruleForm}/`))) return true;
    }
    return false;
  }
  return project.segments.has(clean);
}

/**
 * Determine whether cortex context/memory is enabled for `projectDir`.
 * Note: `revive` session-ID tracking still runs independently so reboot recovery stays intact.
 * Precedence:
 *   1) Explicit opt-out `enabled: false`
 *   2) `excludedProjects` (exact/ancestor path OR folder name segment, case-insensitive) — cannot be bypassed,
 *      including through a path alias: the project and each path rule are compared by real path as well as
 *      by the path as written
 *   3) `mode === 'opt-in'` -> requires match in `enabledProjects` — cannot be bypassed by project `enabled: true`
 *   4) Otherwise enabled (`mode === 'all'`)
 */
export function isProjectEnabled(projectDir, config = DEFAULT_CONFIG) {
  if (!config || typeof config !== 'object') return true;
  if (config.enabled === false) return false;

  const project = describeProjectForMatch(projectDir || process.cwd());

  const excluded = Array.isArray(config.excludedProjects) ? config.excludedProjects : [];
  if (excluded.some((rule) => matchesProjectRule(project, rule))) {
    return false;
  }

  if (String(config.mode || 'all').trim().toLowerCase() === 'opt-in') {
    const enabled = Array.isArray(config.enabledProjects) ? config.enabledProjects : [];
    return enabled.some((rule) => matchesProjectRule(project, rule));
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
