import { chunkMarkdown, splitLongText } from '../core/frontmatter.mjs';
import { ensureVectorTable, readIndexMeta, syncFromDisk, withTransaction } from '../core/db.mjs';
import { createGeminiProvider } from './gemini.mjs';
import { createOpenAIProvider } from './openai.mjs';
import { createOllamaProvider } from './ollama.mjs';
import { createOnnxProvider } from './onnx.mjs';

const MAX_EMBED_ATTEMPTS = 3;

function isAuthCircuitBreakError(err) {
  if (!err) return false;
  if (err.status === 401 || err.status === 403) return true;
  const msg = String(err.message || '');
  return /\b(?:401|403)\b/.test(msg) && /(?:embedding failed|unauthorized|forbidden|api key)/i.test(msg);
}

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

function makeChunkPrefix(title, heading, safeMax) {
  const t = String(title || '').trim();
  const h = String(heading || '').trim();
  let label = '';
  if (t && h && h !== t) {
    label = `[${t} > ${h}]`;
  } else if (t) {
    label = `[${t}]`;
  } else if (h) {
    label = `[${h}]`;
  }
  if (!label) return '';
  const maxLabelLen = Math.max(16, Math.floor(safeMax * 0.4));
  if (label.length > maxLabelLen) {
    label = `${label.slice(0, maxLabelLen - 1)}]`;
  }
  return `${label}\n`;
}

/**
 * Build heading-aware chunks with `[title > heading]` prefix strictly accounted for inside `maxChars`
 * so chunk 0 never overflows `maxChars` and chunks 1..N preserve context.
 */
export function buildDocChunks(doc, { maxChars = 800, overlap = 100 } = {}) {
  const safeMax = Math.max(64, Number(maxChars ?? 800) || 800);
  const rawOverlap = Number(overlap ?? 100);
  const safeOverlap = Number.isFinite(rawOverlap) ? Math.max(0, rawOverlap) : 100;

  const title = String(doc?.title || '').trim();
  const summary = String(doc?.summary || '').trim();
  const content = String(doc?.content || '').trim();

  const bodyChunks = chunkMarkdown(content, { maxChars: safeMax, overlap: safeOverlap });

  const out = [];
  let chunkIndex = 0;

  const emitWithPrefix = (heading, text) => {
    const cleanText = String(text || '').trim();
    if (!cleanText) return;
    const prefix = makeChunkPrefix(title, heading, safeMax);
    const full = `${prefix}${cleanText}`;
    if (full.length <= safeMax) {
      out.push({
        chunkIndex: chunkIndex++,
        heading: heading || title,
        text: full,
      });
      return;
    }

    const bodyBudget = Math.max(32, safeMax - prefix.length);
    const pieceOverlap = Math.min(safeOverlap, Math.floor(bodyBudget / 2));
    const pieces = splitLongText(cleanText, bodyBudget, pieceOverlap);
    for (const piece of pieces) {
      out.push({
        chunkIndex: chunkIndex++,
        heading: heading || title,
        text: `${prefix}${piece}`,
      });
    }
  };

  if (bodyChunks.length === 0) {
    if (summary) {
      emitWithPrefix('', summary);
    } else if (title) {
      emitWithPrefix('', title);
    }
    return out;
  }

  for (let i = 0; i < bodyChunks.length; i++) {
    const chunk = bodyChunks[i];
    const heading = chunk.heading || '';
    const text = i === 0 && summary ? `${summary}\n\n${chunk.text}` : chunk.text;
    emitWithPrefix(heading, text);
  }

  return out;
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
      circuitBroken: false,
      reason: 'no_provider',
    };
  }

  const resolvedMaxChars = chunkMaxChars ?? store.config?.embedding?.chunkMaxChars ?? 800;
  const resolvedOverlap = chunkOverlap ?? store.config?.embedding?.chunkOverlap ?? 100;
  const maxChars = Math.max(64, Number(resolvedMaxChars) || 800);
  const overlap = Number.isFinite(Number(resolvedOverlap)) ? Math.max(0, Number(resolvedOverlap)) : 100;
  const scopes = scope === 'all' ? ['project', 'global'] : [scope];

  let totalProcessed = 0;
  let totalChunks = 0;
  let totalErrors = 0;
  let circuitBroken = false;
  const rebuiltTiers = [];
  let knownDims = Number(activeProvider.dimensions) || 0;

  for (const s of scopes) {
    if (circuitBroken) break;

    const tier = typeof store.getTierIfExists === 'function'
      ? store.getTierIfExists(s)
      : store.getTier(s);
    if (!tier) continue;

    syncFromDisk(tier.db, tier.dir);

    if (!tier.vecAvailable) {
      continue;
    }

    const meta = readIndexMeta(tier.db);
    let tableReady = false;

    if (knownDims > 0) {
      const res = ensureVectorTable(tier.db, {
        provider: activeProvider.name,
        model: activeProvider.model,
        dimensions: knownDims,
        vecAvailable: tier.vecAvailable,
      });
      tableReady = res.ready;
      if (res.rebuilt) rebuiltTiers.push(s);
    } else if (meta.dimensions > 0 && meta.embedModel === activeProvider.model) {
      knownDims = meta.dimensions;
      const res = ensureVectorTable(tier.db, {
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
        SELECT id, type, status, title, summary, content, hash
        FROM docs
        WHERE status NOT IN ('superseded', 'archived')
          AND embed_attempts < ?
          AND (
            embed_status = 'pending'
            OR embed_status = 'error'
            OR (embed_status = 'ready' AND embed_model != ?)
          )
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(MAX_EMBED_ATTEMPTS, activeProvider.model, Math.max(1, Number(maxDocs) || 100));

    const recordErrorStmt = tier.db.prepare(`
      UPDATE docs
      SET embed_status = 'error',
          embed_attempts = embed_attempts + 1,
          embed_error = ?
      WHERE id = ?
    `);

    for (const doc of pendingRows) {
      const chunks = buildDocChunks(doc, { maxChars, overlap });
      if (chunks.length === 0) {
        tier.db
          .prepare("UPDATE docs SET embed_status = 'skipped', embed_model = ?, embed_attempts = 0, embed_error = '' WHERE id = ?")
          .run(activeProvider.model, doc.id);
        continue;
      }

      let vectors;
      try {
        vectors = await activeProvider.embed(
          chunks.map((c) => c.text),
          { taskType: 'document' },
        );
      } catch (err) {
        totalErrors++;
        const errMsg = String(err?.message || err || 'Embedding provider failed').slice(0, 200);
        try {
          recordErrorStmt.run(errMsg, doc.id);
        } catch {
          // ignore if DB closed mid-shutdown
        }
        if (isAuthCircuitBreakError(err)) {
          circuitBroken = true;
          break;
        }
        continue;
      }

      const detectedDims = Array.isArray(vectors) && vectors[0] ? vectors[0].length : 0;
      const allValid =
        Array.isArray(vectors)
        && vectors.length === chunks.length
        && detectedDims > 0
        && vectors.every((v) => v && v.length === detectedDims);

      if (!allValid) {
        totalErrors++;
        try {
          recordErrorStmt.run('Invalid or mismatched vector dimensions returned by provider', doc.id);
        } catch {
          // ignore
        }
        continue;
      }

      if (!tableReady || detectedDims !== knownDims) {
        knownDims = detectedDims;
        const res = ensureVectorTable(tier.db, {
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

      try {
        const committed = withTransaction(tier.db, () => {
          // Stale guard: verify document still exists and has not been modified while embed() ran
          const current = tier.db
            .prepare('SELECT hash, status, type FROM docs WHERE id = ?')
            .get(doc.id);
          if (!current || current.hash !== doc.hash) {
            return false;
          }

          tier.db.prepare('DELETE FROM doc_chunks_vec WHERE doc_id = ?').run(doc.id);
          const ins = tier.db.prepare(`
            INSERT INTO doc_chunks_vec (doc_id, status, type, embedding, chunk_index, heading, snippet)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const vec = vectors[i] instanceof Float32Array ? vectors[i] : new Float32Array(vectors[i]);
            const vecBytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
            ins.run(
              doc.id,
              current.status,
              current.type,
              vecBytes,
              BigInt(chunk.chunkIndex),
              chunk.heading || '',
              chunk.text.slice(0, 240),
            );
          }

          tier.db
            .prepare("UPDATE docs SET embed_status = 'ready', embed_model = ?, embed_attempts = 0, embed_error = '' WHERE id = ? AND hash = ?")
            .run(activeProvider.model, doc.id, doc.hash);
          return true;
        });

        if (committed) {
          totalProcessed++;
          totalChunks += chunks.length;
        }
      } catch (err) {
        totalErrors++;
        const errMsg = String(err?.message || err || 'Vector commit failed').slice(0, 200);
        try {
          recordErrorStmt.run(errMsg, doc.id);
        } catch {
          // ignore if DB closed
        }
      }
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
    circuitBroken,
  };
}

/**
 * Non-blocking debounced async embedding queue so memory_save returns immediately.
 * Tracks `inFlightPromise` and exposes `drain(timeoutMs)` for safe shutdown without closing DB mid-write.
 */
export function createEmbeddingQueue(store, { provider = null, getProvider = null, debounceMs = 150 } = {}) {
  let timer = null;
  let inFlightPromise = null;
  let draining = false;
  const pendingScopes = new Set();

  const flush = () => {
    if (inFlightPromise) return inFlightPromise;
    if (pendingScopes.size === 0) return Promise.resolve();

    const scopes = [...pendingScopes];
    pendingScopes.clear();

    inFlightPromise = (async () => {
      try {
        const scope = scopes.length > 1 ? 'all' : scopes[0];
        const activeProvider = provider || (typeof getProvider === 'function' ? await getProvider() : null);
        await processPendingEmbeddings(store, { scope, provider: activeProvider });
      } catch {
        // swallow background errors; docs remain pending/error for next run
      } finally {
        inFlightPromise = null;
        if (!draining && pendingScopes.size > 0) {
          schedule(Array.from(pendingScopes)[0]);
        }
      }
    })();

    return inFlightPromise;
  };

  const schedule = (scope = 'project') => {
    if (draining) return;
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

  const drain = async (timeoutMs = 3000) => {
    draining = true;
    cancel();
    if (!inFlightPromise) return;

    const safeTimeout = Math.max(0, Number(timeoutMs ?? 3000) || 0);
    if (safeTimeout === 0) return;

    let timeoutHandle = null;
    try {
      await Promise.race([
        inFlightPromise,
        new Promise((resolve) => {
          timeoutHandle = setTimeout(resolve, safeTimeout);
          if (typeof timeoutHandle.unref === 'function') {
            timeoutHandle.unref();
          }
        }),
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  return { schedule, flush, cancel, drain };
}
