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

export function createOpenAIProvider(options = {}) {
  const apiKey = options.apiKey
    || (options.apiKeyEnv ? process.env[options.apiKeyEnv] : '')
    || process.env.OPENAI_API_KEY
    || '';

  if (!apiKey) return null;

  const model = options.model || 'text-embedding-3-small';
  const baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const dimensions = Number(options.dimensions) || 0;
  const timeoutMs = Number(options.timeoutMs) || 15000;
  const retryBaseMs = Number(options.retryBaseMs ?? 250);
  const fetchImpl = options.fetchImpl || fetch;

  async function embedBatch(batch, url) {
    const payload = {
      model,
      input: batch.map((t) => String(t)),
      ...(dimensions > 0 ? { dimensions } : {}),
    };

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
        if (attempt < MAX_RETRIES) {
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
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
          await sleep(retryBaseMs * (2 ** attempt));
          continue;
        }
        throw err;
      }

      const data = await res.json();
      const items = data?.data;
      if (!Array.isArray(items) || items.length !== batch.length) {
        throw new Error('OpenAI embedding response missing expected data array');
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
    async embed(texts) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const url = `${baseUrl}/embeddings`;

      const out = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const vecs = await embedBatch(batch, url);
        out.push(...vecs);
      }
      return out;
    },
  };
}
