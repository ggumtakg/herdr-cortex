import {
  EMBEDDING_PROVIDER_NAMES,
  describeLegacyEmbeddingKeys,
  findLegacyEmbeddingKeys,
  getConfigProblems,
} from '../core/config.mjs';
import { getSharedEmbeddingBreaker } from './breaker.mjs';
import { listFailedEmbeddings } from './failed.mjs';
import { resolveApiKey } from './provider-util.mjs';
import {
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_MODEL,
  GEMINI_KEY_ENV_NAMES,
  createGeminiProvider,
} from './gemini.mjs';
import {
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENAI_KEY_ENV_NAMES,
  createOpenAIProvider,
} from './openai.mjs';
import { OLLAMA_DEFAULT_MODEL, createOllamaProvider, resolveOllamaBaseUrl } from './ollama.mjs';
import { ONNX_DEFAULT_MODEL, createOnnxProvider } from './onnx.mjs';

const OFF_NAMES = new Set(['none', 'off', 'disabled']);
const VALID_SETTINGS = ['none', 'auto', ...EMBEDDING_PROVIDER_NAMES];

const KEYED_PROVIDERS = {
  gemini: { label: 'Gemini', envNames: GEMINI_KEY_ENV_NAMES, defaultBaseUrl: GEMINI_DEFAULT_BASE_URL, defaultModel: GEMINI_DEFAULT_MODEL },
  openai: { label: 'OpenAI', envNames: OPENAI_KEY_ENV_NAMES, defaultBaseUrl: OPENAI_DEFAULT_BASE_URL, defaultModel: OPENAI_DEFAULT_MODEL },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function embeddingSection(config) {
  if (isPlainObject(config?.embedding)) return config.embedding;
  return isPlainObject(config) ? config : {};
}

function blockOf(emb, name) {
  return isPlainObject(emb[name]) ? emb[name] : {};
}

// A missing or empty provider means "none"; anything that is not a known name is an error, never "auto".
function normalizeProviderSetting(raw) {
  if (raw === undefined || raw === null) return { setting: 'none', valid: true };
  if (typeof raw !== 'string') return { setting: String(raw), valid: false };
  const name = raw.trim().toLowerCase();
  if (name === '' || OFF_NAMES.has(name)) return { setting: 'none', valid: true };
  if (name === 'auto' || EMBEDDING_PROVIDER_NAMES.includes(name)) return { setting: name, valid: true };
  return { setting: raw.trim(), valid: false };
}

function keyedPlan(emb, name, env) {
  const block = blockOf(emb, name);
  const meta = KEYED_PROVIDERS[name];
  const key = resolveApiKey(block, env, meta.envNames);
  return {
    kind: name,
    available: Boolean(key.apiKey),
    // Only this provider's own block is passed on, so a URL or model written for another provider cannot reach it.
    options: {
      model: block.model,
      dimensions: block.dimensions,
      apiKeyEnv: block.apiKeyEnv,
      apiKey: block.apiKey,
      baseUrl: block.baseUrl,
      timeoutMs: emb.timeoutMs,
    },
    model: block.model || meta.defaultModel,
    baseUrl: block.baseUrl || meta.defaultBaseUrl,
    apiKeySource: key.source || null,
    apiKeyEnv: key.source === 'env' ? key.envName : null,
  };
}

function ollamaPlan(emb, env) {
  const block = blockOf(emb, 'ollama');
  return {
    kind: 'ollama',
    available: Boolean(env?.OLLAMA_HOST || block.baseUrl),
    options: {
      baseUrl: block.baseUrl,
      model: block.model,
      dimensions: block.dimensions,
      timeoutMs: emb.timeoutMs,
    },
    model: block.model || OLLAMA_DEFAULT_MODEL,
    baseUrl: resolveOllamaBaseUrl(block, env),
    apiKeySource: null,
    apiKeyEnv: null,
  };
}

function onnxPlan(emb) {
  const block = blockOf(emb, 'onnx');
  return {
    kind: 'onnx',
    available: block.enabled === true,
    options: { model: block.model, dimensions: block.dimensions, dtype: block.dtype },
    model: block.model || ONNX_DEFAULT_MODEL,
    baseUrl: '',
    apiKeySource: null,
    apiKeyEnv: null,
  };
}

function candidatePlan(emb, name, env) {
  if (name === 'ollama') return ollamaPlan(emb, env);
  if (name === 'onnx') return onnxPlan(emb);
  return keyedPlan(emb, name, env);
}

/**
 * Decide which provider the config selects, without creating it and without any network access.
 * Returns { setting, selected, problems } where `selected` is the chosen candidate or null (no embedding).
 */
function planEmbeddingProvider(config, { env = process.env } = {}) {
  const emb = embeddingSection(config);
  const problems = [];
  const { setting, valid } = normalizeProviderSetting(emb.provider);

  if (!valid) {
    problems.push({
      code: 'unknown_provider',
      value: setting,
      message: `Unknown embedding.provider "${setting}": embedding is off until it is corrected. `
        + `Valid values: ${VALID_SETTINGS.join(', ')}.`,
    });
    return { setting, selected: null, problems };
  }
  if (setting === 'none') {
    return { setting, selected: null, problems };
  }

  if (setting === 'auto') {
    // First candidate that is configured wins; each is judged by its own block and environment only.
    for (const name of EMBEDDING_PROVIDER_NAMES) {
      const candidate = candidatePlan(emb, name, env);
      if (candidate.available) return { setting, selected: candidate, problems };
    }
    return { setting, selected: null, problems };
  }

  const candidate = candidatePlan(emb, setting, env);
  if (KEYED_PROVIDERS[setting] && !candidate.available) {
    const meta = KEYED_PROVIDERS[setting];
    const block = blockOf(emb, setting);
    const tried = [block.apiKeyEnv, ...meta.envNames].filter((name) => typeof name === 'string' && name);
    problems.push({
      code: 'missing_api_key',
      provider: setting,
      message: `embedding.provider is "${setting}" but no API key was found (looked in embedding.${setting}.apiKey `
        + `and the environment variables ${tried.join(', ')}): embedding is off.`,
    });
    return { setting, selected: null, problems };
  }
  // An explicitly selected Ollama or ONNX provider is used even without the hints "auto" looks for.
  return { setting, selected: candidate, problems };
}

const warnedProviderProblems = new Set();

function warnProviderProblemOnce(problem) {
  const key = `${problem.code}\0${problem.value ?? problem.provider ?? ''}`;
  if (warnedProviderProblems.has(key)) return;
  warnedProviderProblems.add(key);
  console.error(`[herdr-cortex] Warning: ${problem.message}`);
}

/**
 * Resolve an EmbeddingProvider from merged cortex config.
 * Returns null when the provider is 'none', unknown (a configuration error, reported once on stderr),
 * or not usable (no API key, optional ONNX package missing).
 * `env` and `fetchImpl` are injectable for tests.
 */
export async function resolveEmbeddingProvider(config = {}, { env = process.env, fetchImpl } = {}) {
  const plan = planEmbeddingProvider(config, { env });
  for (const problem of plan.problems) warnProviderProblemOnce(problem);
  if (!plan.selected) return null;

  const options = { ...plan.selected.options, env, ...(fetchImpl ? { fetchImpl } : {}) };
  switch (plan.selected.kind) {
    case 'gemini':
      return createGeminiProvider(options);
    case 'openai':
      return createOpenAIProvider(options);
    case 'ollama':
      return createOllamaProvider(options);
    case 'onnx':
      return await createOnnxProvider(options);
    default:
      return null;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseHost(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return { host: url.host, local: LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) };
  } catch {
    return null;
  }
}

/**
 * Describe what the embedding configuration does, for display by `npm run embed`, the installer and status commands.
 * Makes no network request and never includes a key value.
 *
 * Returns {
 *   setting,       // embedding.provider as configured: none | auto | gemini | openai | ollama | onnx | "<unknown text>"
 *   provider,      // provider that will actually be used, or null when nothing is embedded
 *   enabled,       // provider !== null
 *   model,         // model name the provider will use ('' when disabled)
 *   host,          // host[:port] documents and queries are sent to; null when disabled or in-process (onnx)
 *   local,         // true when no document text leaves this machine (disabled, onnx, or a loopback host)
 *   apiKeySource,  // 'env' | 'config' | null
 *   apiKeyEnv,     // name of the environment variable that supplies the key, or null
 *   breaker,       // { open, remainingMs, cooldownMs, openedAt, lastError } of this process's circuit breaker
 *   problems,      // [{ code, message, ... }] unknown_provider | missing_api_key | invalid_base_url
 *                  //   | legacy_embedding_keys | project_embedding_ignored
 *   failedDocuments // only when `store` is given: { project: { count, ids }, global: { count, ids } }
 * }
 */
export function describeEmbeddingStatus(config = {}, { env = process.env, breaker, store = null } = {}) {
  const plan = planEmbeddingProvider(config, { env });
  const selected = plan.selected;

  const problems = [...getConfigProblems(config)];
  // A config object that did not come from loadConfig may still carry old-format keys.
  const emb = embeddingSection(config);
  const legacyKeys = findLegacyEmbeddingKeys(emb);
  if (legacyKeys.length > 0 && !problems.some((p) => p.code === 'legacy_embedding_keys' && p.location === 'embedding')) {
    problems.push({
      code: 'legacy_embedding_keys',
      keys: legacyKeys,
      location: 'embedding',
      message: describeLegacyEmbeddingKeys(legacyKeys, 'embedding'),
    });
  }
  problems.push(...plan.problems);

  let host = null;
  let local = true;
  if (selected && selected.kind !== 'onnx') {
    const parsed = parseHost(selected.baseUrl);
    if (parsed) {
      host = parsed.host;
      local = parsed.local;
    } else {
      local = false;
      problems.push({
        code: 'invalid_base_url',
        provider: selected.kind,
        message: `embedding.${selected.kind}.baseUrl is not a valid URL; requests to it will fail.`,
      });
    }
  }

  const activeBreaker = breaker || getSharedEmbeddingBreaker();
  const status = {
    setting: plan.setting,
    provider: selected ? selected.kind : null,
    enabled: Boolean(selected),
    model: selected ? selected.model : '',
    host,
    local,
    apiKeySource: selected ? selected.apiKeySource : null,
    apiKeyEnv: selected ? selected.apiKeyEnv : null,
    breaker: activeBreaker.describe(),
    problems,
  };

  if (store) {
    try {
      status.failedDocuments = listFailedEmbeddings(store, { scope: 'all' });
    } catch (err) {
      status.failedDocuments = { error: String(err?.message || err).slice(0, 200) };
    }
  }

  return status;
}

/**
 * Render `describeEmbeddingStatus()` output as short human-readable lines (no key values).
 */
export function formatEmbeddingStatus(status) {
  const lines = [];
  if (!status?.enabled) {
    const why = status?.setting === 'none'
      ? 'provider is "none"'
      : status?.setting === 'auto'
        ? 'provider is "auto" and no provider is configured'
        : `provider "${status?.setting}" is not usable`;
    lines.push(`embedding: off (${why}); nothing is sent anywhere.`);
  } else {
    const via = status.setting === status.provider ? '' : ` (chosen by "${status.setting}")`;
    let where;
    if (status.provider === 'onnx') where = 'runs in this process; documents stay on this machine';
    else if (status.local) where = `sends documents and search queries to ${status.host} (this machine)`;
    else where = `sends documents and search queries to ${status.host || 'an unparseable URL'}`;
    let key = '';
    if (status.apiKeySource === 'env') key = `; API key from environment variable ${status.apiKeyEnv}`;
    else if (status.apiKeySource === 'config') key = `; API key from embedding.${status.provider}.apiKey in config.json`;
    lines.push(`embedding: ${status.provider}${via}, model ${status.model}; ${where}${key}.`);
  }

  if (status?.breaker?.open) {
    const seconds = Math.ceil(status.breaker.remainingMs / 1000);
    lines.push(`embedding paused for ${seconds}s after a service failure: ${status.breaker.lastError || 'unknown error'}`);
  }

  const failed = status?.failedDocuments;
  if (failed && !failed.error) {
    for (const scope of ['project', 'global']) {
      const entry = failed[scope];
      if (entry && entry.count > 0) {
        const shown = entry.ids.slice(0, 10).join(', ');
        const more = entry.count > 10 ? ', ...' : '';
        lines.push(
          `embedding gave up on ${entry.count} ${scope} document(s) after repeated failures: ${shown}${more} `
          + '(retry with: npm run embed -- --retry-failed)',
        );
      }
    }
  }

  for (const problem of status?.problems || []) {
    lines.push(`embedding config problem: ${problem.message}`);
  }
  return lines;
}
