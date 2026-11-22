export function createOllamaProvider(options = {}) {
  const rawHost = String(options.baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim();
  const withScheme = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
  const baseUrl = withScheme.replace(/\/+$/, '');
  const model = options.model || 'nomic-embed-text';
  const dimensions = Number(options.dimensions) || 0;
  const timeoutMs = Number(options.timeoutMs) || 15000;
  const fetchImpl = options.fetchImpl || fetch;

  return {
    name: 'ollama',
    model,
    dimensions,
    async embed(texts) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const url = `${baseUrl}/api/embed`;

      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: texts.map((t) => String(t)),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Ollama embedding failed (${res.status}): ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const embeddings = data?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error('Ollama embedding response missing expected embeddings array');
      }

      return embeddings.map((vec) => new Float32Array(vec));
    },
  };
}
