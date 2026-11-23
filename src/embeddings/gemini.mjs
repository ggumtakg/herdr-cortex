import { markEmbeddingFailure } from './breaker.mjs';
import { resolveApiKey, resolveCallLimits } from './provider-util.mjs';

const MAX_BATCH_SIZE = 100;
const MAX_RETRIES = 2;

export const GEMINI_DEFAULT_MODEL = 'gemini-embedding-001';
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_KEY_ENV_NAMES = Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

export function createGeminiProvider(options = {}) {
  const env = options.env || process.env;
  const { apiKey } = resolveApiKey(options, env, GEMINI_KEY_ENV_NAMES);

  if (!apiKey) return null;

  const model = options.model || GEMINI_DEFAULT_MODEL;
  const baseUrl = (options.baseUrl || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const dimensions = Number(options.dimensions) || 768;
  const defaultTimeoutMs = Number(options.timeoutMs) || 15000;
  const retryBaseMs = Number(options.retryBaseMs ?? 250);
  const fetchImpl = options.fetchImpl || fetch;

  async function embedBatch(batch, geminiTask, modelPath, url, { timeoutMs, maxRetries }) {
    const requests = batch.map((text) => ({
      model: modelPath,
      content: { parts: [{ text: String(text) }] },
      taskType: geminiTask,
      ...(dimensions > 0 ? { outputDimensionality: dimensions } : {}),
    }));

    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({ requests }),
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
        const err = new Error(`Gemini embedding failed (${res.status}): ${errText.slice(0, 200)}`);
        err.status = res.status;
        lastErr = err;
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          await sleep(retryBaseMs * (2 ** attempt));
          continue;
        }
        throw err;
      }

      // An answer that cannot be read says the service (or whatever answers at this URL) is not usable;
      // it is not a verdict on the document.
      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw markEmbeddingFailure(parseErr, 'service');
      }
      const embeddings = data?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
        throw markEmbeddingFailure(new Error('Gemini embedding response missing expected embeddings array'), 'service');
      }

      return embeddings.map((e) => new Float32Array(e.values || []));
    }

    throw lastErr || new Error('Gemini embedding failed after retries');
  }

  return {
    name: 'gemini',
    model,
    dimensions,
    async embed(texts, { taskType = 'document', timeoutMs, maxRetries } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const geminiTask = taskType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
      const modelPath = model.startsWith('models/') ? model : `models/${model}`;
      const url = `${baseUrl}/${modelPath}:batchEmbedContents`;
      const limits = resolveCallLimits(
        { timeoutMs, maxRetries },
        { timeoutMs: defaultTimeoutMs, maxRetries: MAX_RETRIES },
      );

      const out = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const vecs = await embedBatch(batch, geminiTask, modelPath, url, limits);
        out.push(...vecs);
      }
      return out;
    },
  };
}
