// A document is retried until this many failures that are specific to it (not to the embedding service).
export const MAX_EMBED_ATTEMPTS = 3;

// Failures of the embedding service (timeout, network, HTTP 408/429/5xx) are not the document's fault and
// are not counted in embed_attempts. But when the service fails this many times while embedding the same
// document, the document itself is the likely cause (it would otherwise be retried after every pause,
// forever, and re-open the circuit breaker each time): it is given up on as well.
export const MAX_EMBED_SERVICE_FAILURES = 10;

/** Why the queue stopped retrying a document. */
export const GIVEN_UP_REASONS = Object.freeze({
  document: 'document_errors', // embed_attempts reached MAX_EMBED_ATTEMPTS
  service: 'service_failures', // embed_service_failures reached MAX_EMBED_SERVICE_FAILURES
});

const GIVEN_UP_WHERE = "(embed_attempts >= ? OR embed_service_failures >= ?) AND embed_status IN ('pending', 'error')";

function tiersFor(store, scope) {
  const scopes = scope === 'all' ? ['project', 'global'] : [scope];
  const out = [];
  for (const s of scopes) {
    let tier = null;
    try {
      tier = typeof store.getTierIfExists === 'function' ? store.getTierIfExists(s) : store.getTier(s);
    } catch {
      tier = null;
    }
    out.push({ scope: s, tier });
  }
  return out;
}

function emptyEntry() {
  return {
    count: 0,
    ids: [],
    documents: [],
    byReason: { [GIVEN_UP_REASONS.document]: 0, [GIVEN_UP_REASONS.service]: 0 },
  };
}

/**
 * Documents the queue has given up on, per tier:
 * { project: { count, ids, documents, byReason }, global: { ... } } — only the requested scopes are present.
 *   count     - all given-up documents of the tier
 *   ids       - at most `maxIds` of them (most recently updated first)
 *   documents - the same documents as `ids`, each { id, reason, error } with reason
 *               'document_errors' (the document failed MAX_EMBED_ATTEMPTS times) or
 *               'service_failures' (the embedding service failed MAX_EMBED_SERVICE_FAILURES times on it)
 *   byReason  - { document_errors: n, service_failures: n } over all given-up documents
 * Superseded and archived documents are left out because the queue never embeds them anyway.
 */
export function listFailedEmbeddings(store, { scope = 'all', maxIds = 50 } = {}) {
  const result = {};
  const idLimit = Math.max(0, Number(maxIds) || 0);
  for (const { scope: s, tier } of tiersFor(store, scope)) {
    const entry = emptyEntry();
    result[s] = entry;
    if (!tier) continue;

    const where = `${GIVEN_UP_WHERE} AND status NOT IN ('superseded', 'archived')`;
    const counts = tier.db
      .prepare(`
        SELECT COUNT(*) AS cnt,
               SUM(CASE WHEN embed_attempts >= ? THEN 1 ELSE 0 END) AS doc_cnt
        FROM docs WHERE ${where}
      `)
      .get(MAX_EMBED_ATTEMPTS, MAX_EMBED_ATTEMPTS, MAX_EMBED_SERVICE_FAILURES);
    entry.count = Number(counts?.cnt) || 0;
    entry.byReason[GIVEN_UP_REASONS.document] = Number(counts?.doc_cnt) || 0;
    entry.byReason[GIVEN_UP_REASONS.service] = entry.count - entry.byReason[GIVEN_UP_REASONS.document];

    if (entry.count > 0 && idLimit > 0) {
      const rows = tier.db
        .prepare(`
          SELECT id, embed_attempts, embed_error FROM docs
          WHERE ${where} ORDER BY updated_at DESC, id ASC LIMIT ?
        `)
        .all(MAX_EMBED_ATTEMPTS, MAX_EMBED_SERVICE_FAILURES, idLimit);
      entry.ids = rows.map((row) => row.id);
      entry.documents = rows.map((row) => ({
        id: row.id,
        reason: Number(row.embed_attempts) >= MAX_EMBED_ATTEMPTS ? GIVEN_UP_REASONS.document : GIVEN_UP_REASONS.service,
        error: String(row.embed_error || ''),
      }));
    }
  }
  return result;
}

/**
 * Give the given-up documents (either reason) a fresh start, so the next queue run embeds them again.
 * Returns the number of documents reset per tier: { project: n, global: n }.
 */
export function retryFailedEmbeddings(store, { scope = 'all' } = {}) {
  const result = {};
  for (const { scope: s, tier } of tiersFor(store, scope)) {
    if (!tier) {
      result[s] = 0;
      continue;
    }
    const res = tier.db
      .prepare(`
        UPDATE docs
        SET embed_status = 'pending', embed_attempts = 0, embed_service_failures = 0, embed_error = ''
        WHERE ${GIVEN_UP_WHERE}
      `)
      .run(MAX_EMBED_ATTEMPTS, MAX_EMBED_SERVICE_FAILURES);
    result[s] = Number(res.changes) || 0;
  }
  return result;
}
