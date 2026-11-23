import { chunkMarkdown, splitLongText } from '../core/frontmatter.mjs';
import { ensureVectorTable, readIndexMeta, syncFromDisk, withTransaction } from '../core/db.mjs';
import { classifyEmbeddingError } from './breaker.mjs';
import { MAX_EMBED_ATTEMPTS, MAX_EMBED_SERVICE_FAILURES } from './failed.mjs';
import { resolveEmbeddingProvider, resolveTierEmbeddingProviders } from './resolve.mjs';

export {
  classifyEmbeddingError,
  createEmbeddingBreaker,
  getSharedEmbeddingBreaker,
} from './breaker.mjs';
export {
  GIVEN_UP_REASONS,
  MAX_EMBED_ATTEMPTS,
  MAX_EMBED_SERVICE_FAILURES,
  listFailedEmbeddings,
  retryFailedEmbeddings,
} from './failed.mjs';
export {
  describeEmbeddingStatus,
  embeddingSelectionKey,
  formatEmbeddingStatus,
  resolveEmbeddingProvider,
  resolveTierEmbeddingProviders,
} from './resolve.mjs';

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

function idleResult(reason, extra = {}) {
  return {
    provider: null,
    processed: 0,
    chunksIndexed: 0,
    rebuiltTiers: [],
    errors: 0,
    circuitBroken: false,
    more: false,
    reason,
    ...extra,
  };
}

const isUsableProvider = (candidate) => Boolean(candidate) && typeof candidate.embed === 'function';

/**
 * Process pending (or model-mismatched) embeddings for one or both tiers.
 * Handles automatic doc_chunks_vec rebuild when embedding model or dimensions change.
 *
 * Each tier is embedded by its own provider: the project tier by the one `store.config` selects, the global
 * tier by the one `store.globalConfig` selects (see `resolveTierEmbeddingProviders`). `providers`
 * ({ project, global }) supplies them ready-made; `provider` is a single provider used for every tier.
 * A tier without a provider is skipped; the result names the provider of the first tier that had one and
 * lists each tier under `tiers`.
 *
 * Failures are handled by kind (see `classifyEmbeddingError`):
 *   - document: counted in the document's `embed_attempts`; after MAX_EMBED_ATTEMPTS it is no longer retried.
 *   - service (timeout, network, HTTP 408/429/5xx): not counted in `embed_attempts`. The run stops,
 *     `breaker` (when given) is opened, and the result has `reason: 'service_unavailable'`. The document that
 *     was being embedded gets one more `embed_service_failures`; when the same document has caused
 *     MAX_EMBED_SERVICE_FAILURES of them it is no longer retried either (it is then the likely cause).
 *   - auth (HTTP 401/403): not counted against any document. The run stops with `reason: 'auth_failed'`.
 * While `breaker` is open nothing is attempted at all (`reason: 'circuit_open'`).
 * `circuitBroken` is true whenever the run was stopped or skipped for one of these reasons.
 * `more` is true when a tier still had a full batch of candidates, i.e. another run may find more work.
 */
export async function processPendingEmbeddings(
  store,
  {
    scope = 'all',
    provider = null,
    providers = null,
    maxDocs = 100,
    chunkMaxChars,
    chunkOverlap,
    breaker = null,
  } = {},
) {
  if (breaker && breaker.isOpen()) {
    return idleResult('circuit_open', { circuitBroken: true });
  }

  const scopes = scope === 'all' ? ['project', 'global'] : [scope];

  let tierProviders;
  if (provider) {
    tierProviders = { project: provider, global: provider };
  } else if (providers && typeof providers === 'object') {
    tierProviders = { project: providers.project || null, global: providers.global || null };
  } else {
    tierProviders = await resolveTierEmbeddingProviders(store, { scopes });
  }
  if (!scopes.some((s) => isUsableProvider(tierProviders[s]))) {
    return idleResult('no_provider');
  }

  // Chunk sizes follow the tier's own settings as well (the global tier never takes a project's overlay).
  const chunkSettingsFor = (s) => {
    const embedding = (s === 'global' ? store.globalConfig?.embedding : null) || store.config?.embedding;
    const resolvedMaxChars = chunkMaxChars ?? embedding?.chunkMaxChars ?? 800;
    const resolvedOverlap = chunkOverlap ?? embedding?.chunkOverlap ?? 100;
    return {
      maxChars: Math.max(64, Number(resolvedMaxChars) || 800),
      overlap: Number.isFinite(Number(resolvedOverlap)) ? Math.max(0, Number(resolvedOverlap)) : 100,
    };
  };
  const batchLimit = Math.max(1, Number(maxDocs) || 100);

  let totalProcessed = 0;
  let totalChunks = 0;
  let totalErrors = 0;
  let stopReason = '';
  let more = false;
  const rebuiltTiers = [];
  const tierResults = {};
  const dimsByProvider = new Map(); // dimensions learned from a provider's first answer, reused for its next tier
  let firstProvider = null;

  for (const s of scopes) {
    if (stopReason) break;

    const activeProvider = tierProviders[s];
    if (!isUsableProvider(activeProvider)) continue;
    if (!firstProvider) firstProvider = activeProvider;

    let knownDims = dimsByProvider.get(activeProvider) ?? (Number(activeProvider.dimensions) || 0);
    const tierResult = {
      provider: activeProvider.name,
      model: activeProvider.model,
      dimensions: knownDims,
      processed: 0,
      chunksIndexed: 0,
      errors: 0,
    };

    const tier = typeof store.getTierIfExists === 'function'
      ? store.getTierIfExists(s)
      : store.getTier(s);
    if (!tier) continue;
    tierResults[s] = tierResult;

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
      dimsByProvider.set(activeProvider, knownDims);
      const res = ensureVectorTable(tier.db, {
        provider: activeProvider.name,
        model: activeProvider.model,
        dimensions: knownDims,
        vecAvailable: tier.vecAvailable,
      });
      tableReady = res.ready;
      if (res.rebuilt) rebuiltTiers.push(s);
    }

    // Documents that have not failed yet go first, so one document that keeps failing cannot hold up the rest.
    // Among the failed ones, those the service failed on least often go first, so a long outage is not
    // charged to a single document.
    const pendingRows = tier.db
      .prepare(`
        SELECT id, type, status, title, summary, content, hash
        FROM docs
        WHERE status NOT IN ('superseded', 'archived')
          AND embed_attempts < ?
          AND embed_service_failures < ?
          AND (
            embed_status = 'pending'
            OR embed_status = 'error'
            OR (embed_status = 'ready' AND embed_model != ?)
          )
        ORDER BY CASE WHEN embed_status = 'error' THEN 1 ELSE 0 END, embed_service_failures ASC, updated_at DESC
        LIMIT ?
      `)
      .all(MAX_EMBED_ATTEMPTS, MAX_EMBED_SERVICE_FAILURES, activeProvider.model, batchLimit);

    const tierHasFullBatch = pendingRows.length >= batchLimit;
    const chunkSettings = chunkSettingsFor(s);

    // A failure specific to the document counts toward its attempt cap ...
    const recordDocFailureStmt = tier.db.prepare(`
      UPDATE docs
      SET embed_status = 'error',
          embed_attempts = embed_attempts + 1,
          embed_error = ?
      WHERE id = ?
    `);
    // ... a failure of the service is counted apart (the document is given up on only when the service keeps
    // failing on this very document) ...
    const recordServiceFailureStmt = tier.db.prepare(`
      UPDATE docs
      SET embed_status = 'error',
          embed_service_failures = embed_service_failures + 1,
          embed_error = ?
      WHERE id = ?
    `);
    // ... and a failure of the credentials is only noted; the document stays eligible.
    const recordAuthFailureStmt = tier.db.prepare(`
      UPDATE docs
      SET embed_status = 'error',
          embed_error = ?
      WHERE id = ?
    `);

    for (const doc of pendingRows) {
      const chunks = buildDocChunks(doc, chunkSettings);
      if (chunks.length === 0) {
        tier.db
          .prepare("UPDATE docs SET embed_status = 'skipped', embed_model = ?, embed_attempts = 0, embed_service_failures = 0, embed_error = '' WHERE id = ?")
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
        tierResult.errors++;
        const kind = classifyEmbeddingError(err);
        const errMsg = String(err?.message || err || 'Embedding provider failed').slice(0, 200);
        const recordStmt = kind === 'document'
          ? recordDocFailureStmt
          : kind === 'service'
            ? recordServiceFailureStmt
            : recordAuthFailureStmt;
        try {
          recordStmt.run(errMsg, doc.id);
        } catch {
          // ignore if DB closed mid-shutdown
        }
        if (kind === 'document') {
          continue;
        }
        if (kind === 'service') {
          stopReason = 'service_unavailable';
          if (breaker) breaker.recordFailure(err);
        } else {
          stopReason = 'auth_failed';
        }
        break;
      }

      const detectedDims = Array.isArray(vectors) && vectors[0] ? vectors[0].length : 0;
      const allValid =
        Array.isArray(vectors)
        && vectors.length === chunks.length
        && detectedDims > 0
        && vectors.every((v) => v && v.length === detectedDims);

      if (!allValid) {
        totalErrors++;
        tierResult.errors++;
        try {
          recordDocFailureStmt.run('Invalid or mismatched vector dimensions returned by provider', doc.id);
        } catch {
          // ignore
        }
        continue;
      }

      // The service answered usefully: a tripped breaker closes and postponed work is picked up again.
      if (breaker) breaker.recordSuccess();

      if (!tableReady || detectedDims !== knownDims) {
        knownDims = detectedDims;
        dimsByProvider.set(activeProvider, knownDims);
        tierResult.dimensions = knownDims;
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
            .prepare("UPDATE docs SET embed_status = 'ready', embed_model = ?, embed_attempts = 0, embed_service_failures = 0, embed_error = '' WHERE id = ? AND hash = ?")
            .run(activeProvider.model, doc.id, doc.hash);
          return true;
        });

        if (committed) {
          totalProcessed++;
          totalChunks += chunks.length;
          tierResult.processed++;
          tierResult.chunksIndexed += chunks.length;
        }
      } catch (err) {
        totalErrors++;
        tierResult.errors++;
        const errMsg = String(err?.message || err || 'Vector commit failed').slice(0, 200);
        try {
          recordDocFailureStmt.run(errMsg, doc.id);
        } catch {
          // ignore if DB closed
        }
      }
    }

    tierResult.dimensions = knownDims;
    if (tierHasFullBatch && !stopReason) more = true;
  }

  return {
    provider: firstProvider.name,
    model: firstProvider.model,
    dimensions: dimsByProvider.get(firstProvider) ?? (Number(firstProvider.dimensions) || 0),
    tiers: tierResults,
    processed: totalProcessed,
    chunksIndexed: totalChunks,
    rebuiltTiers,
    errors: totalErrors,
    circuitBroken: Boolean(stopReason),
    more,
    ...(stopReason ? { reason: stopReason } : {}),
  };
}

// Extra wait after the breaker's pause before the queue tries again.
const RETRY_SLACK_MS = 25;

function samePath(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Non-blocking debounced async embedding queue so memory_save returns immediately.
 * Tracks `inFlightPromise` and exposes `drain(timeoutMs)` for safe shutdown without closing DB mid-write.
 *
 * With a `breaker` (shared with search): the queue does not run while the breaker is open, keeps the postponed
 * work and tries again when the pause is over; when the breaker closes after a success it schedules
 * `recoverScope` so documents that piled up are embedded without waiting for the next save.
 *
 * `schedule('project', { projectDir })` queues another project's store (a save made with `project_dir`).
 * That store is opened through `openProjectStore(projectDir)` for the run only and closed right after.
 *
 * Providers: `provider` / `getProvider()` give one provider for every tier; `getProviders()` gives
 * { project, global } so the global tier can follow the global settings while the project tier follows its
 * own. With none of them each run resolves the providers from the store's configuration.
 */
export function createEmbeddingQueue(
  store,
  {
    provider = null,
    getProvider = null,
    getProviders = null,
    debounceMs = 150,
    breaker = null,
    maxDocs = 100,
    recoverScope = 'all',
    openProjectStore = null,
    getProviderFor = null,
  } = {},
) {
  let timer = null;
  let timerDue = 0;
  let inFlightPromise = null;
  let draining = false;
  const pendingScopes = new Set();
  const pendingProjects = new Map(); // normalized path -> project directory

  const hasPending = () => pendingScopes.size > 0 || pendingProjects.size > 0;

  const nextDelay = () => (breaker && breaker.isOpen() ? breaker.remainingMs() + RETRY_SLACK_MS : debounceMs);

  const projectKey = (projectDir) => {
    const text = String(projectDir);
    return process.platform === 'win32' ? text.toLowerCase() : text;
  };

  // True when the run stopped because the service is unavailable and the breaker will tell us when to return.
  const pausedByService = (res) => Boolean(
    breaker
    && breaker.isOpen()
    && res
    && (res.reason === 'circuit_open' || res.reason === 'service_unavailable'),
  );

  const flush = () => {
    if (inFlightPromise) return inFlightPromise;
    if (!hasPending()) return Promise.resolve();
    if (breaker && breaker.isOpen()) {
      // Not now: keep what is pending and come back when the pause is over.
      if (!draining) arm(nextDelay());
      return Promise.resolve();
    }

    const scopes = [...pendingScopes];
    pendingScopes.clear();
    const projects = [...pendingProjects.values()];
    pendingProjects.clear();

    inFlightPromise = (async () => {
      let paused = false;
      try {
        if (scopes.length > 0) {
          let res = null;
          try {
            const scope = scopes.length > 1 || scopes[0] === 'all' ? 'all' : scopes[0];
            const activeProvider = provider || (typeof getProvider === 'function' ? await getProvider() : null);
            const tierProviders = !activeProvider && typeof getProviders === 'function' ? await getProviders() : null;
            res = await processPendingEmbeddings(store, {
              scope,
              provider: activeProvider,
              providers: tierProviders,
              breaker,
              maxDocs,
            });
          } catch {
            // swallow background errors; docs remain pending/error for next run
          }
          if (pausedByService(res)) {
            paused = true;
            for (const s of scopes) pendingScopes.add(s);
          } else if (res && res.more && res.processed > 0) {
            for (const s of scopes) pendingScopes.add(s);
          }
        }

        for (const projectDir of projects) {
          if (paused || (breaker && breaker.isOpen())) {
            paused = true;
            pendingProjects.set(projectKey(projectDir), projectDir);
            continue;
          }
          let otherStore = null;
          let res = null;
          try {
            otherStore = openProjectStore(projectDir);
            const activeProvider = typeof getProviderFor === 'function'
              ? await getProviderFor(otherStore)
              : await resolveEmbeddingProvider(otherStore.config);
            res = await processPendingEmbeddings(otherStore, {
              scope: 'project',
              provider: activeProvider,
              breaker,
              maxDocs,
            });
          } catch {
            // swallow background errors; docs remain pending/error for next run
          } finally {
            try {
              if (otherStore) otherStore.close();
            } catch {
              // ignore close errors
            }
          }
          if (pausedByService(res)) {
            paused = true;
            pendingProjects.set(projectKey(projectDir), projectDir);
          } else if (res && res.more && res.processed > 0) {
            pendingProjects.set(projectKey(projectDir), projectDir);
          }
        }
      } finally {
        inFlightPromise = null;
        if (!draining && hasPending()) {
          arm(nextDelay());
        }
      }
    })();

    return inFlightPromise;
  };

  // Plan a run after `delayMs`, unless one is already planned for an earlier moment.
  function arm(delayMs) {
    const delay = Math.max(0, Number(delayMs) || 0);
    const due = Date.now() + delay;
    if (timer && timerDue <= due) return;
    if (timer) clearTimeout(timer);
    timerDue = due;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  const schedule = (scope = 'project', { projectDir } = {}) => {
    if (draining) return;
    const otherProject = projectDir && !samePath(projectDir, store?.projectRoot) ? String(projectDir) : '';
    if (otherProject && scope !== 'global') {
      // Another project's documents live in that project's own store.
      if (typeof openProjectStore !== 'function') return;
      pendingProjects.set(projectKey(otherProject), otherProject);
    } else {
      pendingScopes.add(scope);
    }
    arm(nextDelay());
  };

  const unsubscribe = breaker && typeof breaker.onRecover === 'function'
    ? breaker.onRecover(() => {
        if (!draining) schedule(recoverScope);
      })
    : () => {};

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingScopes.clear();
    pendingProjects.clear();
  };

  const drain = async (timeoutMs = 3000) => {
    draining = true;
    unsubscribe();
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

  /** Resolves when no run is in progress (the run that is in flight, if any, has finished). */
  const whenIdle = () => inFlightPromise || Promise.resolve();

  return { schedule, flush, cancel, drain, hasPending, whenIdle };
}
