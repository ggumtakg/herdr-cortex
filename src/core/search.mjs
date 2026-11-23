import { normalizeRelPath } from './config.mjs';
import { hasVectorTable, readIndexMeta, syncFromDisk } from './db.mjs';
import { getNeighbors } from './graph.mjs';

const RRF_K = 60;
const DEFAULT_MAX_VEC_DISTANCE = 0.65;

const TRIM_PUNCT_RE = /^[?.!,:;'"`()\[\]{}]+|[?.!,:;'"`()\[\]{}]+$/g;
const HANGUL_3PLUS_RE = /^[가-힣]{3,}$/;
const HANGUL_PARTICLE_RE = /(?:에서|으로|에게|부터|까지|은|는|이|가|을|를|의|에|로|와|과|도|만)$/;

function parseTagsJson(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeFtsPhrase(token) {
  return `"${String(token).replace(/"/g, '""')}"`;
}

function escapeLike(token) {
  return String(token).replace(/[\\%_]/g, (m) => `\\${m}`);
}

function stripHangulParticle(token) {
  if (!HANGUL_3PLUS_RE.test(token)) return null;
  const stem = token.replace(HANGUL_PARTICLE_RE, '');
  if (stem.length >= 2 && stem.length < token.length) {
    return stem;
  }
  return null;
}

function extractQueryTokens(query) {
  const cleaned = String(query || '').trim();
  if (!cleaned) return { primaryTokens: [], stemTokens: [] };

  const rawParts = cleaned
    .split(/[\s,;()\[\]{}|/\\]+/)
    .map((t) => t.replace(TRIM_PUNCT_RE, '').trim())
    .filter(Boolean);

  const primaryTokens = [...new Set(rawParts)];
  const primaryLower = new Set(primaryTokens.map((t) => t.toLowerCase()));
  const stemTokens = [];
  const seenStems = new Set();

  for (const token of primaryTokens) {
    const stem = stripHangulParticle(token);
    if (stem && !primaryLower.has(stem) && !seenStems.has(stem)) {
      seenStems.add(stem);
      stemTokens.push({ stem, parentKey: token.toLowerCase() });
    }
  }

  return { primaryTokens, stemTokens };
}

export function tokenizeQuery(query) {
  const { primaryTokens, stemTokens } = extractQueryTokens(query);
  return [...primaryTokens, ...stemTokens.map((s) => s.stem)];
}

function buildFilterWhere({ type, session, branch, file, include_superseded }) {
  const clauses = [];
  const params = [];

  if (!include_superseded) {
    clauses.push("d.status NOT IN ('superseded', 'archived')");
  }
  if (type) {
    clauses.push('d.type = ?');
    params.push(String(type).trim());
  }
  if (session) {
    clauses.push('d.session = ?');
    params.push(String(session).trim());
  }
  if (branch) {
    clauses.push('d.branch = ?');
    params.push(String(branch).trim());
  }
  if (file) {
    const norm = normalizeRelPath(String(file));
    const exactTarget = `file:${norm}`;
    const suffixPattern = `file:%/${escapeLike(norm)}`;
    clauses.push(
      "EXISTS (SELECT 1 FROM edges ef WHERE ef.src = d.id AND ef.kind IN ('points_file', 'file_link') AND (ef.dst = ? OR ef.dst LIKE ? ESCAPE '\\'))",
    );
    params.push(exactTarget, suffixPattern);
  }

  return {
    whereSql: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1',
    params,
  };
}

function hydrateDocsByIds(db, docIds) {
  const uniqueIds = [...new Set(docIds.filter(Boolean))];
  const map = new Map();
  if (uniqueIds.length === 0) return map;

  const BATCH = 200;
  for (let i = 0; i < uniqueIds.length; i += BATCH) {
    const batch = uniqueIds.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    const rows = db
      .prepare(`
        SELECT d.id, d.type, d.status, d.session, d.branch, d.title, d.summary, d.tags, d.due, d.updated_at
        FROM docs d
        WHERE d.id IN (${placeholders})
      `)
      .all(...batch);
    for (const row of rows) {
      map.set(row.id, row);
    }
  }
  return map;
}

function filterDocIdsByWhere(db, docIds, whereSql, filterParams) {
  const uniqueIds = [...new Set(docIds.filter(Boolean))];
  const allowed = new Set();
  if (uniqueIds.length === 0) return allowed;

  const BATCH = 200;
  for (let i = 0; i < uniqueIds.length; i += BATCH) {
    const batch = uniqueIds.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT d.id FROM docs d WHERE d.id IN (${placeholders}) AND (${whereSql})`)
      .all(...batch, ...filterParams);
    for (const row of rows) {
      allowed.add(row.id);
    }
  }
  return allowed;
}

function runKeywordSearch(db, query, { whereSql, filterParams, maxLimit = 10 }) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];

  const { primaryTokens, stemTokens } = extractQueryTokens(trimmed);
  if (primaryTokens.length === 0) return [];

  const ftsLimit = Math.max(100, maxLimit * 5);
  const likeLimit = Math.max(200, maxLimit * 10);

  const ftsItems = [];
  const likeItems = [];

  for (const token of primaryTokens) {
    const key = token.toLowerCase();
    if (token.length >= 3) {
      ftsItems.push({ token, weight: 1.0, tokenKey: key });
    } else {
      likeItems.push({ token, weight: 1.0, tokenKey: key });
    }
  }

  for (const { stem, parentKey } of stemTokens) {
    if (stem.length >= 3) {
      ftsItems.push({ token: stem, weight: 0.75, tokenKey: parentKey });
    } else {
      likeItems.push({ token: stem, weight: 0.75, tokenKey: parentKey });
    }
  }

  const docScores = new Map();
  const docMatchedTokens = new Map();
  const docUpdatedAt = new Map();

  const addScore = (docId, delta, tokenKey, updatedAt) => {
    docScores.set(docId, (docScores.get(docId) || 0) + delta);
    if (updatedAt && !docUpdatedAt.has(docId)) {
      docUpdatedAt.set(docId, updatedAt);
    }
    if (tokenKey) {
      let set = docMatchedTokens.get(docId);
      if (!set) {
        set = new Set();
        docMatchedTokens.set(docId, set);
      }
      set.add(tokenKey);
    }
  };

  // 1. FTS5 trigram search with SQL pushdown of structured filters BEFORE LIMIT
  const ftsStmt = db.prepare(`
    SELECT d.id AS doc_id, d.updated_at, bm25(docs_fts, 0.0, 3.0, 2.0, 1.5, 1.0) AS rank_score
    FROM docs_fts
    JOIN docs d ON d.id = docs_fts.doc_id
    WHERE (${whereSql}) AND docs_fts MATCH ?
    ORDER BY rank_score ASC
    LIMIT ?
  `);

  for (const item of ftsItems) {
    try {
      const rows = ftsStmt.all(...filterParams, escapeFtsPhrase(item.token), ftsLimit);
      for (const row of rows) {
        const mag = Math.max(0.1, Math.abs(Number(row.rank_score) || 0) + 1.0);
        addScore(row.doc_id, mag * item.weight, item.tokenKey, row.updated_at);
      }
    } catch {
      // Fallback to LIKE if FTS5 rejects a special token
      likeItems.push(item);
    }
  }

  // Phrase FTS5 boost for multi-word queries >= 3 chars (punctuation-cleaned)
  const cleanPhrase = primaryTokens.join(' ');
  if (cleanPhrase.length >= 3 && primaryTokens.length > 1) {
    try {
      const rows = ftsStmt.all(...filterParams, escapeFtsPhrase(cleanPhrase), ftsLimit);
      for (const row of rows) {
        const mag = Math.max(0.1, Math.abs(Number(row.rank_score) || 0) + 1.0);
        addScore(row.doc_id, mag * 0.8, null, row.updated_at);
      }
    } catch {
      // ignore phrase FTS syntax edge cases
    }
  }

  // 2. Hybrid LIKE fallback for 1-2 char tokens & short Hangul stems with SQL pushdown
  if (likeItems.length > 0) {
    const likeStmt = db.prepare(`
      SELECT d.id, d.title, d.summary, d.tags, d.content, d.updated_at
      FROM docs d
      WHERE (${whereSql}) AND (
        LOWER(d.title) LIKE ? ESCAPE '\\'
        OR LOWER(d.summary) LIKE ? ESCAPE '\\'
        OR LOWER(d.tags) LIKE ? ESCAPE '\\'
        OR LOWER(d.content) LIKE ? ESCAPE '\\'
      )
      ORDER BY d.updated_at DESC
      LIMIT ?
    `);

    const seenLikeTokens = new Set();
    for (const item of likeItems) {
      const lower = item.token.toLowerCase();
      const dedupeKey = `${lower}\0${item.tokenKey}`;
      if (seenLikeTokens.has(dedupeKey)) continue;
      seenLikeTokens.add(dedupeKey);

      const pattern = `%${escapeLike(lower)}%`;
      const rows = likeStmt.all(...filterParams, pattern, pattern, pattern, pattern, likeLimit);
      for (const row of rows) {
        let fieldScore = 0;
        if (String(row.title || '').toLowerCase().includes(lower)) fieldScore += 3.0;
        if (String(row.summary || '').toLowerCase().includes(lower)) fieldScore += 2.0;
        if (String(row.tags || '').toLowerCase().includes(lower)) fieldScore += 1.5;
        if (String(row.content || '').toLowerCase().includes(lower)) fieldScore += 1.0;
        if (fieldScore > 0) {
          addScore(row.id, fieldScore * item.weight, item.tokenKey, row.updated_at);
        }
      }
    }
  }

  const totalTokens = primaryTokens.length;
  const ranked = [];
  for (const [docId, rawScore] of docScores.entries()) {
    const matchedCount = docMatchedTokens.get(docId)?.size || 0;
    const coverageBoost = 1 + matchedCount / Math.max(1, totalTokens);
    ranked.push({
      docId,
      score: rawScore * coverageBoost,
      matchedTokens: matchedCount,
      updatedAt: docUpdatedAt.get(docId) || '',
    });
  }

  ranked.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  return ranked;
}

function getVecRowCount(db, vecAvailable) {
  if (!vecAvailable || !hasVectorTable(db)) return 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM doc_chunks_vec').get();
    return Number(row?.cnt) || 0;
  } catch {
    return 0;
  }
}

function runVectorSearch(
  db,
  queryVec,
  {
    whereSql,
    filterParams,
    type = '',
    session = '',
    branch = '',
    file = '',
    include_superseded = false,
    limit = 10,
    maxDistance = DEFAULT_MAX_VEC_DISTANCE,
  } = {},
) {
  if (!queryVec || !(queryVec instanceof Float32Array) || queryVec.length === 0) {
    return [];
  }
  if (!hasVectorTable(db)) return [];

  const meta = readIndexMeta(db);
  if (meta.dimensions > 0 && meta.dimensions !== queryVec.length) {
    return [];
  }

  const k = BigInt(Math.max(limit * 6, 40));
  const queryBytes = new Uint8Array(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);

  // CRITICAL sqlite-vec rule: use `!=` chains (NEVER `NOT IN`) so vec0 pushes down predicates cleanly.
  const vecClauses = ['embedding MATCH ?', 'k = ?'];
  const vecParams = [queryBytes, k];

  if (!include_superseded) {
    vecClauses.push("status != 'superseded'");
    vecClauses.push("status != 'archived'");
  }
  if (type) {
    vecClauses.push('type = ?');
    vecParams.push(String(type).trim());
  }

  let rows;
  try {
    rows = db
      .prepare(`
        SELECT doc_id, distance
        FROM doc_chunks_vec
        WHERE ${vecClauses.join(' AND ')}
        ORDER BY distance ASC
      `)
      .all(...vecParams);
  } catch {
    return [];
  }

  const bestByDoc = new Map();
  for (const row of rows) {
    const dist = Number(row.distance);
    if (!Number.isFinite(dist) || dist > maxDistance) continue;
    const prev = bestByDoc.get(row.doc_id);
    if (prev === undefined || dist < prev) {
      bestByDoc.set(row.doc_id, dist);
    }
  }

  if (bestByDoc.size === 0) return [];

  // Always verify candidates against canonical documents table (guards against
  // stale doc_chunks_vec.status after disableVec syncs AND applies session/branch/file filters)
  const allowedIds = filterDocIdsByWhere(db, [...bestByDoc.keys()], whereSql, filterParams);

  const results = [];
  for (const [docId, distance] of bestByDoc.entries()) {
    if (!allowedIds.has(docId)) continue;
    results.push({ docId, distance });
  }

  results.sort((a, b) => a.distance - b.distance);
  return results;
}

function computeRecencyBoost(updatedAt) {
  if (!updatedAt) return 0;
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  return 0.002 * Math.exp(-ageDays / 30);
}

/**
 * 2-stage RRF hybrid search across project, global, or both tiers.
 * Returns ONLY stage-1 summaries (never dumps full content).
 */
export async function searchMemory(store, params = {}) {
  const {
    query = '',
    scope = 'all',
    type = '',
    session = '',
    branch = '',
    file = '',
    include_superseded = false,
    limit = 10,
    maxDistance = DEFAULT_MAX_VEC_DISTANCE,
    embeddingProvider = null,
  } = params;

  const maxLimit = Math.max(1, Math.min(100, Number(limit) || 10));
  const scopes = scope === 'all' ? ['project', 'global'] : [scope];
  const trimmedQuery = String(query || '').trim();
  const safeMaxDist = Number.isFinite(Number(maxDistance)) ? Number(maxDistance) : DEFAULT_MAX_VEC_DISTANCE;

  const { whereSql, params: filterParams } = buildFilterWhere({
    type,
    session,
    branch,
    file,
    include_superseded: Boolean(include_superseded),
  });

  // 1. Open only existing tiers lazily (never create .memory/ on read-only search)
  const activeTiers = [];
  for (const s of scopes) {
    const tier = typeof store.getTierIfExists === 'function'
      ? store.getTierIfExists(s)
      : store.getTier(s);
    if (!tier) continue;
    syncFromDisk(tier.db, tier.dir);
    const vecRowCount = trimmedQuery ? getVecRowCount(tier.db, tier.vecAvailable) : 0;
    const meta = vecRowCount > 0 ? readIndexMeta(tier.db) : null;
    activeTiers.push({ scope: s, tier, vecRowCount, meta });
  }

  if (activeTiers.length === 0) {
    return {
      query: trimmedQuery,
      scope,
      vectorUsed: false,
      totalReturned: 0,
      results: [],
    };
  }

  // Filter-only listing when query is empty (SQL LIMIT pushdown, zero bulk load)
  if (!trimmedQuery) {
    const combined = [];
    for (const { scope: s, tier } of activeTiers) {
      const rows = tier.db
        .prepare(`
          SELECT d.id, d.type, d.status, d.session, d.branch, d.title, d.summary, d.tags, d.due, d.updated_at
          FROM docs d
          WHERE ${whereSql}
          ORDER BY d.updated_at DESC
          LIMIT ?
        `)
        .all(...filterParams, maxLimit);
      for (const row of rows) {
        combined.push({
          row,
          scope: s,
          db: tier.db,
          score: 1 + computeRecencyBoost(row.updated_at),
        });
      }
    }

    combined.sort(
      (a, b) => b.score - a.score || String(b.row.updated_at).localeCompare(String(a.row.updated_at)),
    );

    const topHits = combined.slice(0, maxLimit).map(({ row, scope: s, db, score }) => ({
      id: row.id,
      scope: s,
      type: row.type,
      status: row.status,
      title: row.title,
      summary: row.summary,
      tags: parseTagsJson(row.tags),
      session: row.session,
      branch: row.branch,
      updated_at: row.updated_at,
      score: Number(score.toFixed(6)),
      relations: getNeighbors(db, row.id, { direction: 'both', limit: 8 }).map((rel) => ({
        kind: rel.kind,
        direction: rel.direction,
        target: rel.target,
        ...(rel.title ? { title: rel.title } : {}),
      })),
    }));

    return {
      query: trimmedQuery,
      scope,
      vectorUsed: false,
      totalReturned: topHits.length,
      results: topHits,
    };
  }

  // 2. Lazy query embedding: ONLY call embeddingProvider.embed if at least one target tier has indexed vectors!
  let queryVec = null;
  const anyTierHasVectors = activeTiers.some((t) => t.vecRowCount > 0);
  if (anyTierHasVectors && embeddingProvider && typeof embeddingProvider.embed === 'function') {
    try {
      const vecs = await embeddingProvider.embed([trimmedQuery], { taskType: 'query' });
      if (Array.isArray(vecs) && vecs[0] && vecs[0].length > 0) {
        queryVec = vecs[0] instanceof Float32Array ? vecs[0] : new Float32Array(vecs[0]);
      }
    } catch {
      queryVec = null;
    }
  }

  // 3. Run keyword + vector search per tier
  let vectorUsed = false;
  const tierStates = [];

  for (const entry of activeTiers) {
    const { scope: s, tier, vecRowCount, meta } = entry;
    const kwRanked = runKeywordSearch(tier.db, trimmedQuery, {
      whereSql,
      filterParams,
      maxLimit,
    });
    const vecRanked = vecRowCount > 0 && queryVec
      ? runVectorSearch(tier.db, queryVec, {
          whereSql,
          filterParams,
          type,
          session,
          branch,
          file,
          include_superseded: Boolean(include_superseded),
          limit: maxLimit,
          maxDistance: safeMaxDist,
        })
      : [];

    if (vecRanked.length > 0) vectorUsed = true;

    tierStates.push({
      scope: s,
      tier,
      embedModel: meta?.embedModel || '',
      kwRanked,
      vecRanked,
      rrfScores: new Map(),
    });
  }

  // 4. Compute RRF scores
  const addRrf = (scoreMap, docId, rank, weight) => {
    const contribution = weight / (RRF_K + rank);
    scoreMap.set(docId, (scoreMap.get(docId) || 0) + contribution);
  };

  for (const ts of tierStates) {
    ts.kwRanked.forEach((hit, idx) => addRrf(ts.rrfScores, hit.docId, idx + 1, 1.0));
  }

  // Cross-tier global vector ranking when multiple tiers share the same embedding model
  const vecTiers = tierStates.filter((ts) => ts.vecRanked.length > 0);
  const distinctModels = new Set(vecTiers.map((ts) => ts.embedModel).filter(Boolean));
  const useGlobalVecRank = vecTiers.length > 1 && distinctModels.size <= 1;

  if (useGlobalVecRank) {
    const globalVecHits = [];
    for (const ts of vecTiers) {
      for (const hit of ts.vecRanked) {
        globalVecHits.push({ ts, docId: hit.docId, distance: hit.distance });
      }
    }
    globalVecHits.sort((a, b) => a.distance - b.distance);
    globalVecHits.forEach((item, idx) => addRrf(item.ts.rrfScores, item.docId, idx + 1, 1.0));
  } else {
    for (const ts of vecTiers) {
      ts.vecRanked.forEach((hit, idx) => addRrf(ts.rrfScores, hit.docId, idx + 1, 1.0));
    }
  }

  // 5. 1-hop graph expansion boost from top seeds + hydrate ONLY matched docs
  const combinedResults = [];

  for (const ts of tierStates) {
    if (ts.rrfScores.size === 0) continue;

    const seedIds = [...ts.rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([docId]) => docId);
    const seedSet = new Set(seedIds);

    const rawNeighborScores = new Map();
    for (const seedId of seedIds) {
      const neighbors = getNeighbors(ts.tier.db, seedId, { direction: 'both', limit: 15 });
      for (const n of neighbors) {
        if (n.target.startsWith('file:')) continue;
        if (seedSet.has(n.target)) continue;
        rawNeighborScores.set(
          n.target,
          Math.max(rawNeighborScores.get(n.target) || 0, Number(n.weight) || 1.0),
        );
      }
    }

    if (rawNeighborScores.size > 0) {
      const validNeighborIds = filterDocIdsByWhere(
        ts.tier.db,
        [...rawNeighborScores.keys()],
        whereSql,
        filterParams,
      );
      const graphRanked = [...rawNeighborScores.entries()]
        .filter(([docId]) => validNeighborIds.has(docId))
        .sort((a, b) => b[1] - a[1]);
      graphRanked.forEach(([docId], idx) => addRrf(ts.rrfScores, docId, idx + 1, 0.25));
    }

    // Hydrate ONLY matched doc IDs
    const hydratedMap = hydrateDocsByIds(ts.tier.db, [...ts.rrfScores.keys()]);
    for (const [docId, baseScore] of ts.rrfScores.entries()) {
      const row = hydratedMap.get(docId);
      if (!row) continue;
      combinedResults.push({
        row,
        scope: ts.scope,
        db: ts.tier.db,
        score: baseScore + computeRecencyBoost(row.updated_at),
      });
    }
  }

  combinedResults.sort(
    (a, b) => b.score - a.score || String(b.row.updated_at).localeCompare(String(a.row.updated_at)),
  );

  const topHits = combinedResults.slice(0, maxLimit).map(({ row, scope: s, db, score }) => ({
    id: row.id,
    scope: s,
    type: row.type,
    status: row.status,
    title: row.title,
    summary: row.summary,
    tags: parseTagsJson(row.tags),
    session: row.session,
    branch: row.branch,
    updated_at: row.updated_at,
    score: Number(score.toFixed(6)),
    relations: getNeighbors(db, row.id, { direction: 'both', limit: 8 }).map((rel) => ({
      kind: rel.kind,
      direction: rel.direction,
      target: rel.target,
      ...(rel.title ? { title: rel.title } : {}),
    })),
  }));

  return {
    query: trimmedQuery,
    scope,
    vectorUsed,
    totalReturned: topHits.length,
    results: topHits,
  };
}
