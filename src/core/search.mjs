import { normalizeRelPath } from './config.mjs';
import { hasVectorTable, readIndexMeta, syncFromDisk } from './db.mjs';
import { getNeighbors } from './graph.mjs';

const RRF_K = 60;

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

export function tokenizeQuery(query) {
  const cleaned = String(query || '').trim();
  if (!cleaned) return [];
  const rawTokens = cleaned
    .split(/[\s,;()\[\]{}|/\\]+/)
    .map((t) => t.replace(/^["'`]+|["'`]+$/g, '').trim())
    .filter(Boolean);
  return [...new Set(rawTokens)];
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

function runKeywordSearch(db, query, candidateIds, candidateMap, { include_superseded = false } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed || candidateIds.size === 0) return [];

  const tokens = tokenizeQuery(trimmed);
  if (tokens.length === 0) return [];

  const longTokens = tokens.filter((t) => t.length >= 3);
  const shortTokens = tokens.filter((t) => t.length >= 1 && t.length <= 2);

  const docScores = new Map();
  const docMatchedTokens = new Map();

  const addScore = (docId, delta, tokenKey) => {
    if (!candidateIds.has(docId)) return;
    docScores.set(docId, (docScores.get(docId) || 0) + delta);
    if (tokenKey) {
      let set = docMatchedTokens.get(docId);
      if (!set) {
        set = new Set();
        docMatchedTokens.set(docId, set);
      }
      set.add(tokenKey);
    }
  };

  // 1. FTS5 trigram search for 3+ char tokens
  const ftsStmt = db.prepare(`
    SELECT doc_id, bm25(docs_fts, 0.0, 3.0, 2.0, 1.5, 1.0) AS rank_score
    FROM docs_fts
    WHERE docs_fts MATCH ?
    ORDER BY rank_score ASC
    LIMIT 100
  `);

  const runFtsToken = (token, weight, tokenKey) => {
    try {
      const rows = ftsStmt.all(escapeFtsPhrase(token));
      for (const row of rows) {
        // SQLite bm25() returns negative values where more negative = better match
        const mag = Math.max(0.1, Math.abs(Number(row.rank_score) || 0) + 1.0);
        addScore(row.doc_id, mag * weight, tokenKey);
      }
    } catch {
      // Fallback to LIKE below if FTS5 rejects a special token
      shortTokens.push(token);
    }
  };

  for (const token of longTokens) {
    runFtsToken(token, 1.0, token.toLowerCase());
  }

  // Also run phrase FTS5 boost when multi-word query is >= 3 chars (e.g. "기억 복구")
  if (trimmed.length >= 3 && tokens.length > 1) {
    try {
      const rows = ftsStmt.all(escapeFtsPhrase(trimmed));
      for (const row of rows) {
        const mag = Math.max(0.1, Math.abs(Number(row.rank_score) || 0) + 1.0);
        addScore(row.doc_id, mag * 0.8, null);
      }
    } catch {
      // ignore phrase FTS syntax edge cases
    }
  }

  // 2. Hybrid LIKE fallback for 1-2 char tokens (e.g. "압축", "락", "훅", "DB")
  const uniqueShort = [...new Set(shortTokens)];
  if (uniqueShort.length > 0) {
    const statusClause = include_superseded ? '' : "status NOT IN ('superseded', 'archived') AND ";
    const likeStmt = db.prepare(`
      SELECT id, title, summary, tags, content
      FROM docs
      WHERE ${statusClause}(
        LOWER(title) LIKE ? ESCAPE '\\'
        OR LOWER(summary) LIKE ? ESCAPE '\\'
        OR LOWER(tags) LIKE ? ESCAPE '\\'
        OR LOWER(content) LIKE ? ESCAPE '\\'
      )
      ORDER BY updated_at DESC
      LIMIT 200
    `);

    for (const token of uniqueShort) {
      const lower = token.toLowerCase();
      const pattern = `%${escapeLike(lower)}%`;
      const rows = likeStmt.all(pattern, pattern, pattern, pattern);
      for (const row of rows) {
        if (!candidateIds.has(row.id)) continue;
        let fieldScore = 0;
        if (String(row.title || '').toLowerCase().includes(lower)) fieldScore += 3.0;
        if (String(row.summary || '').toLowerCase().includes(lower)) fieldScore += 2.0;
        if (String(row.tags || '').toLowerCase().includes(lower)) fieldScore += 1.5;
        if (String(row.content || '').toLowerCase().includes(lower)) fieldScore += 1.0;
        if (fieldScore > 0) {
          addScore(row.id, fieldScore, lower);
        }
      }
    }
  }

  const totalTokens = tokens.length;
  const ranked = [];
  for (const [docId, rawScore] of docScores.entries()) {
    const matchedCount = docMatchedTokens.get(docId)?.size || 0;
    const coverageBoost = 1 + matchedCount / Math.max(1, totalTokens);
    ranked.push({
      docId,
      score: rawScore * coverageBoost,
      matchedTokens: matchedCount,
      updatedAt: candidateMap.get(docId)?.updated_at || '',
    });
  }

  ranked.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  return ranked;
}

function runVectorSearch(db, tierDir, queryVec, candidateIds, limit) {
  if (!queryVec || !(queryVec instanceof Float32Array) || queryVec.length === 0) {
    return [];
  }
  if (!hasVectorTable(db)) return [];

  const meta = readIndexMeta(tierDir);
  if (meta.dimensions > 0 && meta.dimensions !== queryVec.length) {
    return [];
  }

  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM doc_chunks_vec').get();
  if (!countRow || Number(countRow.cnt) === 0) return [];

  const k = BigInt(Math.max(limit * 6, 40));
  const queryBytes = new Uint8Array(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);

  let rows;
  try {
    rows = db
      .prepare(`
        SELECT doc_id, distance
        FROM doc_chunks_vec
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance ASC
      `)
      .all(queryBytes, k);
  } catch {
    return [];
  }

  const bestByDoc = new Map();
  for (const row of rows) {
    if (!candidateIds.has(row.doc_id)) continue;
    const dist = Number(row.distance);
    const prev = bestByDoc.get(row.doc_id);
    if (prev === undefined || dist < prev) {
      bestByDoc.set(row.doc_id, dist);
    }
  }

  return [...bestByDoc.entries()]
    .map(([docId, distance]) => ({ docId, distance }))
    .sort((a, b) => a.distance - b.distance);
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
    embeddingProvider = null,
  } = params;

  const maxLimit = Math.max(1, Math.min(100, Number(limit) || 10));
  const scopes = scope === 'all' ? ['project', 'global'] : [scope];
  const trimmedQuery = String(query || '').trim();

  // Compute query embedding once (gracefully degrade on offline/error)
  let queryVec = null;
  let vectorUsed = false;
  if (trimmedQuery && embeddingProvider && typeof embeddingProvider.embed === 'function') {
    try {
      const vecs = await embeddingProvider.embed([trimmedQuery], { taskType: 'query' });
      if (Array.isArray(vecs) && vecs[0] && vecs[0].length > 0) {
        queryVec = vecs[0] instanceof Float32Array ? vecs[0] : new Float32Array(vecs[0]);
      }
    } catch {
      queryVec = null;
    }
  }

  const { whereSql, params: filterParams } = buildFilterWhere({
    type,
    session,
    branch,
    file,
    include_superseded: Boolean(include_superseded),
  });

  const combinedResults = [];

  for (const s of scopes) {
    const tier = store.getTier(s);
    syncFromDisk(tier.db, tier.dir);

    const candidateRows = tier.db
      .prepare(`
        SELECT d.id, d.type, d.status, d.session, d.branch, d.title, d.summary, d.tags, d.due, d.updated_at
        FROM docs d
        WHERE ${whereSql}
        ORDER BY d.updated_at DESC
      `)
      .all(...filterParams);

    if (candidateRows.length === 0) continue;

    const candidateMap = new Map();
    const candidateIds = new Set();
    for (const row of candidateRows) {
      candidateMap.set(row.id, row);
      candidateIds.add(row.id);
    }

    // Filter-only listing when query is empty
    if (!trimmedQuery) {
      for (const row of candidateRows.slice(0, maxLimit)) {
        combinedResults.push({
          row,
          scope: s,
          db: tier.db,
          score: 1 + computeRecencyBoost(row.updated_at),
        });
      }
      continue;
    }

    const kwRanked = runKeywordSearch(tier.db, trimmedQuery, candidateIds, candidateMap, {
      include_superseded: Boolean(include_superseded),
    });
    const vecRanked = tier.vecAvailable && queryVec
      ? runVectorSearch(tier.db, tier.dir, queryVec, candidateIds, maxLimit)
      : [];

    if (vecRanked.length > 0) vectorUsed = true;

    const rrfScores = new Map();
    const addRrf = (docId, rank, weight) => {
      const contribution = weight / (RRF_K + rank);
      rrfScores.set(docId, (rrfScores.get(docId) || 0) + contribution);
    };

    kwRanked.forEach((hit, idx) => addRrf(hit.docId, idx + 1, 1.0));
    vecRanked.forEach((hit, idx) => addRrf(hit.docId, idx + 1, 1.0));

    // 1-hop graph expansion boost from top seeds
    const seedIds = [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([docId]) => docId);

    const graphNeighborScores = new Map();
    for (const seedId of seedIds) {
      const neighbors = getNeighbors(tier.db, seedId, { direction: 'both', limit: 15 });
      for (const n of neighbors) {
        if (n.target.startsWith('file:')) continue;
        if (!candidateIds.has(n.target)) continue;
        if (seedIds.includes(n.target)) continue;
        graphNeighborScores.set(
          n.target,
          Math.max(graphNeighborScores.get(n.target) || 0, Number(n.weight) || 1.0),
        );
      }
    }

    const graphRanked = [...graphNeighborScores.entries()].sort((a, b) => b[1] - a[1]);
    graphRanked.forEach(([docId], idx) => addRrf(docId, idx + 1, 0.25));

    for (const [docId, baseScore] of rrfScores.entries()) {
      const row = candidateMap.get(docId);
      if (!row) continue;
      combinedResults.push({
        row,
        scope: s,
        db: tier.db,
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
