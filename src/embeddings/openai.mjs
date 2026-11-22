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
  const fetchImpl = options.fetchImpl || fetch;

  return {
    name: 'openai',
    model,
    dimensions,
    async embed(texts) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const url = `${baseUrl}/embeddings`;
      const payload = {
        model,
        input: texts.map((t) => String(t)),
        ...(dimensions > 0 ? { dimensions } : {}),
      };

      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenAI embedding failed (${res.status}): ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const items = data?.data;
      if (!Array.isArray(items) || items.length !== texts.length) {
        throw new Error('OpenAI embedding response missing expected data array');
      }

      const sorted = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return sorted.map((item) => new Float32Array(item.embedding || []));
    },
  };
}
