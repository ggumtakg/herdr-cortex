import { normalizeRelPath } from './config.mjs';

export function normalizeGraphTarget(target) {
  const raw = String(target || '').trim();
  if (!raw) return '';
  if (raw.startsWith('file:')) {
    return `file:${normalizeRelPath(raw.slice(5))}`;
  }
  return raw;
}

function hydrateNodes(db, nodeIds) {
  const uniqueIds = [...new Set(nodeIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const docIds = uniqueIds.filter((id) => !id.startsWith('file:'));
  const nodeMap = new Map();

  for (const id of uniqueIds) {
    if (id.startsWith('file:')) {
      nodeMap.set(id, {
        id,
        nodeType: 'file',
        filePath: id.slice(5),
      });
    } else {
      nodeMap.set(id, {
        id,
        nodeType: 'doc',
        exists: false,
      });
    }
  }

  if (docIds.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < docIds.length; i += BATCH) {
      const batch = docIds.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(', ');
      const rows = db
        .prepare(`
          SELECT id, type, status, title, summary, session, branch, updated_at
          FROM docs
          WHERE id IN (${placeholders})
        `)
        .all(...batch);

      for (const row of rows) {
        nodeMap.set(row.id, {
          id: row.id,
          nodeType: 'doc',
          exists: true,
          type: row.type,
          status: row.status,
          title: row.title,
          summary: row.summary,
          session: row.session,
          branch: row.branch,
          updated_at: row.updated_at,
        });
      }
    }
  }

  return nodeMap;
}

/**
 * Get 1-hop incoming and/or outgoing neighbors for a document or file node.
 */
export function getNeighbors(db, targetId, { direction = 'both', limit = 20 } = {}) {
  const target = normalizeGraphTarget(targetId);
  if (!target) return [];

  const maxLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const outEdges = [];
  const inEdges = [];

  if (direction === 'out' || direction === 'both') {
    const outRows = db
      .prepare(`
        SELECT src, dst, kind, weight
        FROM edges
        WHERE src = ?
        ORDER BY CASE WHEN kind IN ('points_file', 'file_link') THEN 1 ELSE 0 END ASC, weight DESC, kind ASC, dst ASC
        LIMIT ?
      `)
      .all(target, maxLimit);
    for (const r of outRows) {
      outEdges.push({ direction: 'out', src: r.src, dst: r.dst, peer: r.dst, kind: r.kind, weight: r.weight });
    }
  }

  if (direction === 'in' || direction === 'both') {
    const inRows = db
      .prepare(`
        SELECT src, dst, kind, weight
        FROM edges
        WHERE dst = ?
        ORDER BY CASE WHEN kind IN ('points_file', 'file_link') THEN 1 ELSE 0 END ASC, weight DESC, kind ASC, src ASC
        LIMIT ?
      `)
      .all(target, maxLimit);
    for (const r of inRows) {
      inEdges.push({ direction: 'in', src: r.src, dst: r.dst, peer: r.src, kind: r.kind, weight: r.weight });
    }
  }

  let sliced;
  if (direction === 'out') {
    sliced = outEdges.slice(0, maxLimit);
  } else if (direction === 'in') {
    sliced = inEdges.slice(0, maxLimit);
  } else {
    // Prioritize doc-to-doc edges over file edges, interleaving outgoing and incoming
    // so neither direction starves the other.
    const isFileEdge = (e) => e.kind === 'points_file' || e.kind === 'file_link';
    const interleave = (a, b) => {
      const merged = [];
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        if (i < a.length) merged.push(a[i]);
        if (i < b.length) merged.push(b[i]);
      }
      return merged;
    };
    const docOut = outEdges.filter((e) => !isFileEdge(e));
    const docIn = inEdges.filter((e) => !isFileEdge(e));
    const fileOut = outEdges.filter(isFileEdge);
    const fileIn = inEdges.filter(isFileEdge);
    sliced = [...interleave(docOut, docIn), ...interleave(fileOut, fileIn)].slice(0, maxLimit);
  }

  const nodeMap = hydrateNodes(db, sliced.map((e) => e.peer));

  return sliced.map((e) => {
    const peerInfo = nodeMap.get(e.peer);
    const rel = {
      direction: e.direction,
      kind: e.kind,
      target: e.peer,
      weight: e.weight,
    };
    if (peerInfo?.nodeType === 'doc' && peerInfo.exists) {
      rel.title = peerInfo.title;
      rel.type = peerInfo.type;
      rel.status = peerInfo.status;
    } else if (peerInfo?.nodeType === 'file') {
      rel.filePath = peerInfo.filePath;
    }
    return rel;
  });
}

function queryFrontierEdges(db, frontier, dir) {
  const BATCH = 200;
  const collected = [];

  for (let i = 0; i < frontier.length; i += BATCH) {
    const batch = frontier.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(', ');

    if (dir === 'out' || dir === 'both') {
      const outRows = db
        .prepare(`
          SELECT src, dst, kind, weight
          FROM edges
          WHERE src IN (${placeholders})
          ORDER BY weight DESC, kind ASC, dst ASC
        `)
        .all(...batch);
      for (const r of outRows) {
        collected.push({
          src: r.src,
          dst: r.dst,
          kind: r.kind,
          weight: Number(r.weight) || 0,
          stepDir: 'out',
          peer: r.dst,
        });
      }
    }

    if (dir === 'in' || dir === 'both') {
      const inRows = db
        .prepare(`
          SELECT src, dst, kind, weight
          FROM edges
          WHERE dst IN (${placeholders})
          ORDER BY weight DESC, kind ASC, src ASC
        `)
        .all(...batch);
      for (const r of inRows) {
        collected.push({
          src: r.src,
          dst: r.dst,
          kind: r.kind,
          weight: Number(r.weight) || 0,
          stepDir: 'in',
          peer: r.src,
        });
      }
    }
  }

  collected.sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind) || a.peer.localeCompare(b.peer));
  return collected;
}

/**
 * Explore 1..10 hop neighborhood around a doc ID or `file:<relPath>` using batched BFS
 * with a global visited-nodes Set (eliminating recursive path explosion & duplicate LIMIT exhaustion).
 */
export function exploreGraph(db, { target, depth = 2, direction = 'both', limit = 60 } = {}) {
  const normalizedTarget = normalizeGraphTarget(target);
  if (!normalizedTarget) {
    throw new Error('exploreGraph requires a non-empty target');
  }

  const maxDepth = Math.max(1, Math.min(10, Number(depth) || 2));
  const dir = direction === 'in' || direction === 'out' ? direction : 'both';
  const maxEdges = Math.max(1, Math.min(500, Number(limit) || 60));

  const visitedNodes = new Map(); // nodeId -> minimum hop
  visitedNodes.set(normalizedTarget, 0);

  const edgeMap = new Map(); // `${src}\0${dst}\0${kind}` -> edge
  let frontier = [normalizedTarget];

  for (let hop = 1; hop <= maxDepth && frontier.length > 0 && edgeMap.size < maxEdges; hop++) {
    const hopEdges = queryFrontierEdges(db, frontier, dir);
    const nextFrontierSet = new Set();

    for (const e of hopEdges) {
      if (edgeMap.size >= maxEdges) break;

      const edgeKey = `${e.src}\0${e.dst}\0${e.kind}`;
      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, {
          src: e.src,
          dst: e.dst,
          kind: e.kind,
          weight: e.weight,
          hop,
          direction: e.stepDir,
        });
      }

      if (!visitedNodes.has(e.peer)) {
        visitedNodes.set(e.peer, hop);
        nextFrontierSet.add(e.peer);
      }
    }

    frontier = [...nextFrontierSet];
  }

  const hydrated = hydrateNodes(db, [...visitedNodes.keys()]);
  const nodes = [...visitedNodes.entries()]
    .map(([id, hop]) => ({
      ...(hydrated.get(id) || { id }),
      hop,
    }))
    .sort((a, b) => a.hop - b.hop || a.id.localeCompare(b.id));

  return {
    target: normalizedTarget,
    depth: maxDepth,
    direction: dir,
    nodes,
    edges: [...edgeMap.values()],
  };
}
