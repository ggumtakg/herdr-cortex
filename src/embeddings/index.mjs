import { chunkMarkdown } from '../core/frontmatter.mjs';
import { ensureVectorTable, readIndexMeta, syncFromDisk, withTransaction } from '../core/db.mjs';
import { createGeminiProvider } from './gemini.mjs';
import { createOpenAIProvider } from './openai.mjs';
import { createOllamaProvider } from './ollama.mjs';
import { createOnnxProvider } from './onnx.mjs';

/**
 * Resolve an EmbeddingProvider from merged cortex config.
 * Returns null gracefully when provider is 'none' or unconfigured/unavailable.
 */
export async function resolveEmbeddingProvider(config = {}) {
  const emb = config.embedding || config || {};
  const kind = String(emb.provider || 'auto').trim().toLowerCase();

  if (kind === 'none' || kind === 'off' || kind === 'disabled') {
    return null;
  }
  if (kind === 'gemini') {
    return createGeminiProvider(emb);
  }
  if (kind === 'openai') {
    return createOpenAIProvider(emb);
  }
  if (kind === 'ollama') {
    return createOllamaProvider(emb);
  }
  if (kind === 'onnx') {
    return await createOnnxProvider(emb);
  }

  // auto mode: check configured credentials/endpoints without blocking network probes
  const gemini = createGeminiProvider(emb);
  if (gemini) return gemini;

  const openai = createOpenAIProvider(emb);
  if (openai) return openai;

  if (process.env.OLLAMA_HOST || emb.baseUrl) {
    return createOllamaProvider(emb);
  }

  if (emb.onnxEnabled) {
    return await createOnnxProvider(emb);
  }

  return null;
}

function buildDocChunks(doc, { maxChars = 800, overlap = 100 } = {}) {
  const header = [doc.title, doc.summary].filter(Boolean).join('\n').trim();
  const bodyChunks = chunkMarkdown(doc.content || '', { maxChars, overlap });

  if (bodyChunks.length === 0) {
    if (!header) return [];
    return [{ chunkIndex: 0, heading: doc.title || '', text: header }];
  }

  return bodyChunks.map((chunk, idx) => ({
    chunkIndex: idx,
    heading: chunk.heading || doc.title || '',
    text: idx === 0 && header ? `${header}\n\n${chunk.text}` : chunk.text,
  }));
}

/**
 * Process pending (or model-mismatched) embeddings for one or both tiers.
 * Handles automatic doc_chunks_vec rebuild when embedding model or dimensions change.
 */
export async function processPendingEmbeddings(
  store,
  {
    scope = 'all',
    provider = null,
    maxDocs = 100,
    chunkMaxChars,
    chunkOverlap,
  } = {},
) {
  const activeProvider = provider || (await resolveEmbeddingProvider(store.config));
  if (!activeProvider || typeof activeProvider.embed !== 'function') {
    return {
      provider: null,
      processed: 0,
      chunksIndexed: 0,
      rebuiltTiers: [],
      errors: 0,
      reason: 'no_provider',
    };
  }

  const maxChars = Number(chunkMaxChars || store.config?.embedding?.chunkMaxChars) || 800;
  const overlap = Number(chunkOverlap || store.config?.embedding?.chunkOverlap) || 100;
  const scopes = scope === 'all' ? ['project', 'global'] : [scope];

  let totalProcessed = 0;
  let totalChunks = 0;
  let totalErrors = 0;
  const rebuiltTiers = [];
  let knownDims = Number(activeProvider.dimensions) || 0;

  for (const s of scopes) {
    const tier = store.getTier(s);
    syncFromDisk(tier.db, tier.dir);

    if (!tier.vecAvailable) {
      continue;
    }

    const meta = readIndexMeta(tier.dir);
    let tableReady = false;

    if (knownDims > 0) {
      const res = ensureVectorTable(tier.db, tier.dir, {
        provider: activeProvider.name,
        model: activeProvider.model,
        dimensions: knownDims,
        vecAvailable: tier.vecAvailable,
      });
      tableReady = res.ready;
      if (res.rebuilt) rebuiltTiers.push(s);
    } else if (meta.dimensions > 0 && meta.embedModel === activeProvider.model) {
      knownDims = meta.dimensions;
      const res = ensureVectorTable(tier.db, tier.dir, {
        provider: activeProvider.name,
        model: activeProvider.model,
        dimensions: knownDims,
        vecAvailable: tier.vecAvailable,
      });
      tableReady = res.ready;
      if (res.rebuilt) rebuiltTiers.push(s);
    }

    const pendingRows = tier.db
      .prepare(`
        SELECT id, title, summary, content
        FROM docs
        WHERE embed_status = 'pending' OR embed_model != ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(activeProvider.model, Math.max(1, Number(maxDocs) || 100));

    for (const doc of pendingRows) {
      const chunks = buildDocChunks(doc, { maxChars, overlap });
      if (chunks.length === 0) {
        tier.db
          .prepare("UPDATE docs SET embed_status = 'skipped', embed_model = ? WHERE id = ?")
          .run(activeProvider.model, doc.id);
        continue;
      }

      let vectors;
      try {
        vectors = await activeProvider.embed(
          chunks.map((c) => c.text),
          { taskType: 'document' },
        );
      } catch {
        totalErrors++;
        tier.db
          .prepare("UPDATE docs SET embed_status = 'error' WHERE id = ?")
          .run(doc.id);
        continue;
      }

      if (!Array.isArray(vectors) || vectors.length !== chunks.length || !vectors[0]?.length) {
        totalErrors++;
        tier.db
          .prepare("UPDATE docs SET embed_status = 'error' WHERE id = ?")
          .run(doc.id);
        continue;
      }

      const detectedDims = vectors[0].length;
      if (!tableReady || detectedDims !== knownDims) {
        knownDims = detectedDims;
        const res = ensureVectorTable(tier.db, tier.dir, {
          provider: activeProvider.name,
          model: activeProvider.model,
          dimensions: detectedDims,
          vecAvailable: tier.vecAvailable,
        });
        tableReady = res.ready;
        if (res.rebuilt && !rebuiltTiers.includes(s)) {
          rebuiltTiers.push(s);
        }
      }

      withTransaction(tier.db, () => {
        tier.db.prepare('DELETE FROM doc_chunks_vec WHERE doc_id = ?').run(doc.id);
        const ins = tier.db.prepare(`
          INSERT INTO doc_chunks_vec (doc_id, embedding, chunk_index, heading, snippet)
          VALUES (?, ?, ?, ?, ?)
        `);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const vec = vectors[i] instanceof Float32Array ? vectors[i] : new Float32Array(vectors[i]);
          const vecBytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
          ins.run(
            doc.id,
            vecBytes,
            BigInt(chunk.chunkIndex),
            chunk.heading || '',
            chunk.text.slice(0, 240),
          );
        }

        tier.db
          .prepare("UPDATE docs SET embed_status = 'ready', embed_model = ? WHERE id = ?")
          .run(activeProvider.model, doc.id);
      });

      totalProcessed++;
      totalChunks += chunks.length;
    }
  }

  return {
    provider: activeProvider.name,
    model: activeProvider.model,
    dimensions: knownDims,
    processed: totalProcessed,
    chunksIndexed: totalChunks,
    rebuiltTiers,
    errors: totalErrors,
  };
}

/**
 * Non-blocking debounced async embedding queue so memory_save returns immediately.
 */
export function createEmbeddingQueue(store, { provider = null, getProvider = null, debounceMs = 150 } = {}) {
  let timer = null;
  let running = false;
  let pendingScopes = new Set();

  const flush = async () => {
    if (running || pendingScopes.size === 0) return;
    running = true;
    const scopes = [...pendingScopes];
    pendingScopes.clear();

    try {
      const scope = scopes.length > 1 ? 'all' : scopes[0];
      const activeProvider = provider || (typeof getProvider === 'function' ? await getProvider() : null);
      await processPendingEmbeddings(store, { scope, provider: activeProvider });
    } catch {
      // swallow background errors; docs remain pending/error for next run
    } finally {
      running = false;
      if (pendingScopes.size > 0) {
        schedule(Array.from(pendingScopes)[0]);
      }
    }
  };

  const schedule = (scope = 'project') => {
    pendingScopes.add(scope);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  };

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingScopes.clear();
  };

  return { schedule, flush, cancel };
}
