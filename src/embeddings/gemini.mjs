const MAX_BATCH_SIZE = 100;
const MAX_RETRIES = 2;

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
  const apiKey = options.apiKey
    || (options.apiKeyEnv ? process.env[options.apiKeyEnv] : '')
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || '';

  if (!apiKey) return null;

  const model = options.model || 'gemini-embedding-001';
  const baseUrl = (options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const dimensions = Number(options.dimensions) || 768;
  const timeoutMs = Number(options.timeoutMs) || 15000;
  const retryBaseMs = Number(options.retryBaseMs ?? 250);
  const fetchImpl = options.fetchImpl || fetch;

  async function embedBatch(batch, geminiTask, modelPath, url) {
    const requests = batch.map((text) => ({
      model: modelPath,
      content: { parts: [{ text: String(text) }] },
      taskType: geminiTask,
      ...(dimensions > 0 ? { outputDimensionality: dimensions } : {}),
    }));

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
        if (attempt < MAX_RETRIES) {
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
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
          await sleep(retryBaseMs * (2 ** attempt));
          continue;
        }
        throw err;
      }

      const data = await res.json();
      const embeddings = data?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
        throw new Error('Gemini embedding response missing expected embeddings array');
      }

      return embeddings.map((e) => new Float32Array(e.values || []));
    }

    throw lastErr || new Error('Gemini embedding failed after retries');
  }

  return {
    name: 'gemini',
    model,
    dimensions,
    async embed(texts, { taskType = 'document' } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const geminiTask = taskType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
      const modelPath = model.startsWith('models/') ? model : `models/${model}`;
      const url = `${baseUrl}/${modelPath}:batchEmbedContents`;

      const out = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const vecs = await embedBatch(batch, geminiTask, modelPath, url);
        out.push(...vecs);
      }
      return out;
    },
  };
}
