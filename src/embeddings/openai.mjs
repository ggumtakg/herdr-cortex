import { markEmbeddingFailure } from './breaker.mjs';
import { resolveApiKey, resolveCallLimits } from './provider-util.mjs';

const MAX_BATCH_SIZE = 100;
const MAX_RETRIES = 2;

export const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_KEY_ENV_NAMES = Object.freeze(['OPENAI_API_KEY']);

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

export function createOpenAIProvider(options = {}) {
  const env = options.env || process.env;
  const { apiKey } = resolveApiKey(options, env, OPENAI_KEY_ENV_NAMES);

  if (!apiKey) return null;

  const model = options.model || OPENAI_DEFAULT_MODEL;
  const baseUrl = (options.baseUrl || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const dimensions = Number(options.dimensions) || 0;
  const defaultTimeoutMs = Number(options.timeoutMs) || 15000;
  const retryBaseMs = Number(options.retryBaseMs ?? 250);
  const fetchImpl = options.fetchImpl || fetch;

  async function embedBatch(batch, url, { timeoutMs, maxRetries }) {
    const payload = {
      model,
      input: batch.map((t) => String(t)),
      ...(dimensions > 0 ? { dimensions } : {}),
    };

    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
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
        const err = new Error(`OpenAI embedding failed (${res.status}): ${errText.slice(0, 200)}`);
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
      const items = data?.data;
      if (!Array.isArray(items) || items.length !== batch.length) {
        throw markEmbeddingFailure(new Error('OpenAI embedding response missing expected data array'), 'service');
      }

      const sorted = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return sorted.map((item) => new Float32Array(item.embedding || []));
    }

    throw lastErr || new Error('OpenAI embedding failed after retries');
  }

  return {
    name: 'openai',
    model,
    dimensions,
    async embed(texts, { timeoutMs, maxRetries } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const url = `${baseUrl}/embeddings`;
      const limits = resolveCallLimits(
        { timeoutMs, maxRetries },
        { timeoutMs: defaultTimeoutMs, maxRetries: MAX_RETRIES },
      );

      const out = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const vecs = await embedBatch(batch, url, limits);
        out.push(...vecs);
      }
      return out;
    },
  };
}
