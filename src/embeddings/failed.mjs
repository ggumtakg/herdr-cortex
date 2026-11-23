// A document is retried until this many failures that are specific to it (not to the embedding service).
export const MAX_EMBED_ATTEMPTS = 3;

const GIVEN_UP_WHERE = "embed_attempts >= ? AND embed_status IN ('pending', 'error')";

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

/**
 * Documents the queue has given up on (attempt cap reached), per tier:
 * { project: { count, ids }, global: { count, ids } } — only the requested scopes are present.
 * `ids` lists at most `maxIds` documents (most recently updated first); `count` is always the full number.
 * Superseded and archived documents are left out because the queue never embeds them anyway.
 */
export function listFailedEmbeddings(store, { scope = 'all', maxIds = 50 } = {}) {
  const result = {};
  const idLimit = Math.max(0, Number(maxIds) || 0);
  for (const { scope: s, tier } of tiersFor(store, scope)) {
    if (!tier) {
      result[s] = { count: 0, ids: [] };
      continue;
    }
    const where = `${GIVEN_UP_WHERE} AND status NOT IN ('superseded', 'archived')`;
    const count = Number(
      tier.db.prepare(`SELECT COUNT(*) AS cnt FROM docs WHERE ${where}`).get(MAX_EMBED_ATTEMPTS)?.cnt,
    ) || 0;
    const ids = count > 0 && idLimit > 0
      ? tier.db
          .prepare(`SELECT id FROM docs WHERE ${where} ORDER BY updated_at DESC, id ASC LIMIT ?`)
          .all(MAX_EMBED_ATTEMPTS, idLimit)
          .map((row) => row.id)
      : [];
    result[s] = { count, ids };
  }
  return result;
}

/**
 * Give documents that reached the attempt cap a fresh start, so the next queue run embeds them again.
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
      .prepare(`UPDATE docs SET embed_status = 'pending', embed_attempts = 0, embed_error = '' WHERE ${GIVEN_UP_WHERE}`)
      .run(MAX_EMBED_ATTEMPTS);
    result[s] = Number(res.changes) || 0;
  }
  return result;
}
