/**
 * Local ONNX embedding provider using lazy dynamic import of @huggingface/transformers.
 * Returns null gracefully if the optional package is not installed.
 */
export async function createOnnxProvider(options = {}) {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    return null;
  }

  if (!transformers || typeof transformers.pipeline !== 'function') {
    return null;
  }

  const model = options.model || 'Xenova/multilingual-e5-small';
  const dimensions = Number(options.dimensions) || 0;
  let extractorPromise = null;

  const getExtractor = () => {
    if (!extractorPromise) {
      extractorPromise = transformers
        .pipeline('feature-extraction', model, {
          dtype: options.dtype || 'q8',
        })
        .catch((err) => {
          extractorPromise = null;
          throw err;
        });
    }
    return extractorPromise;
  };

  return {
    name: 'onnx',
    model,
    dimensions,
    async embed(texts, { taskType = 'document' } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const extractor = await getExtractor();
      const isE5 = model.toLowerCase().includes('e5');
      const prefix = isE5 ? (taskType === 'query' ? 'query: ' : 'passage: ') : '';

      const results = [];
      for (const text of texts) {
        const output = await extractor(`${prefix}${String(text)}`, {
          pooling: 'mean',
          normalize: true,
        });
        results.push(new Float32Array(output.data));
      }
      return results;
    },
  };
}
