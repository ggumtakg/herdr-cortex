import { markEmbeddingFailure } from './breaker.mjs';
import { resolveCallLimits } from './provider-util.mjs';

const MAX_BATCH_SIZE = 64;
const MAX_RETRIES = 2;

export const OLLAMA_DEFAULT_MODEL = 'nomic-embed-text';
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Where Ollama requests go: `baseUrl` from the config, else `OLLAMA_HOST`, else the local default.
 */
export function resolveOllamaBaseUrl(options = {}, env = process.env) {
  const rawHost = String(options.baseUrl || env?.OLLAMA_HOST || OLLAMA_DEFAULT_BASE_URL).trim();
  const withScheme = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
  return withScheme.replace(/\/+$/, '');
}

export function createOllamaProvider(options = {}) {
  const baseUrl = resolveOllamaBaseUrl(options, options.env || process.env);
  const model = options.model || OLLAMA_DEFAULT_MODEL;
  const dimensions = Number(options.dimensions) || 0;
  const defaultTimeoutMs = Number(options.timeoutMs) || 15000;
  const retryBaseMs = Number(options.retryBaseMs ?? 250);
  const fetchImpl = options.fetchImpl || fetch;
  const isNomic = model.toLowerCase().includes('nomic-embed');

  async function embedBatch(batch, url, prefix, { timeoutMs, maxRetries }) {
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input: batch.map((t) => `${prefix}${String(t)}`),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (netErr) {
        lastErr = netErr;
        if (attempt < maxRetries) {
          await sleep(retryBaseMs * (2 ** attempt));
          continue;
        }
        throw netErr;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error(`Ollama embedding failed (${res.status}): ${errText.slice(0, 200)}`);
        err.status = res.status;
        lastErr = err;
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          await sleep(retryBaseMs * (2 ** attempt));
          continue;
        }
        throw err;
      }

      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw markEmbeddingFailure(parseErr, 'service');
      }
      const embeddings = data?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
        throw markEmbeddingFailure(new Error('Ollama embedding response missing expected embeddings array'), 'service');
      }

      return embeddings.map((vec) => new Float32Array(vec));
    }

    throw lastErr || new Error('Ollama embedding failed after retries');
  }

  return {
    name: 'ollama',
    model,
    dimensions,
    async embed(texts, { taskType = 'document', timeoutMs, maxRetries } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const url = `${baseUrl}/api/embed`;
      const prefix = isNomic ? (taskType === 'query' ? 'search_query: ' : 'search_document: ') : '';
      const limits = resolveCallLimits(
        { timeoutMs, maxRetries },
        { timeoutMs: defaultTimeoutMs, maxRetries: MAX_RETRIES },
      );

      const out = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const vecs = await embedBatch(batch, url, prefix, limits);
        out.push(...vecs);
      }
      return out;
    },
  };
}
