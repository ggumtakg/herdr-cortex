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
  const fetchImpl = options.fetchImpl || fetch;

  return {
    name: 'gemini',
    model,
    dimensions,
    async embed(texts, { taskType = 'document' } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const geminiTask = taskType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
      const modelPath = model.startsWith('models/') ? model : `models/${model}`;
      const url = `${baseUrl}/${modelPath}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;

      const requests = texts.map((text) => ({
        model: modelPath,
        content: { parts: [{ text: String(text) }] },
        taskType: geminiTask,
        ...(dimensions > 0 ? { outputDimensionality: dimensions } : {}),
      }));

      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini embedding failed (${res.status}): ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const embeddings = data?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error('Gemini embedding response missing expected embeddings array');
      }

      return embeddings.map((e) => new Float32Array(e.values || []));
    },
  };
}
