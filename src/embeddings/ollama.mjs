const MAX_BATCH_SIZE = 64;
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

export function createOllamaProvider(options = {}) {
  const rawHost = String(options.baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim();
  const withScheme = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
  const baseUrl = withScheme.replace(/\/+$/, '');
  const model = options.model || 'nomic-embed-text';
  const dimensions = Number(options.dimensions) || 0;
  const timeoutMs = Number(options.timeoutMs) || 15000;
  const retryBaseMs = Number(options.retryBaseMs ?? 250);
  const fetchImpl = options.fetchImpl || fetch;
  const isNomic = model.toLowerCase().includes('nomic-embed');

  async function embedBatch(batch, url, prefix) {
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
        if (attempt < MAX_RETRIES) {
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
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
          await sleep(retryBaseMs * (2 ** attempt));
          continue;
        }
        throw err;
      }

      const data = await res.json();
      const embeddings = data?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
        throw new Error('Ollama embedding response missing expected embeddings array');
      }

      return embeddings.map((vec) => new Float32Array(vec));
    }

    throw lastErr || new Error('Ollama embedding failed after retries');
  }

  return {
    name: 'ollama',
    model,
    dimensions,
    async embed(texts, { taskType = 'document' } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const url = `${baseUrl}/api/embed`;
      const prefix = isNomic ? (taskType === 'query' ? 'search_query: ' : 'search_document: ') : '';

      const out = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const vecs = await embedBatch(batch, url, prefix);
        out.push(...vecs);
      }
      return out;
    },
  };
}
