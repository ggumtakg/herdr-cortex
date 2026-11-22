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
    const placeholders = docIds.map(() => '?').join(', ');
    const rows = db
      .prepare(`
        SELECT id, type, status, title, summary, session, branch, updated_at
        FROM docs
        WHERE id IN (${placeholders})
      `)
      .all(...docIds);

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

/**
 * Explore 1..2 hop neighborhood around a doc ID or `file:<relPath>` using WITH RECURSIVE.
 */
export function exploreGraph(db, { target, depth = 2, direction = 'both', limit = 60 } = {}) {
  const normalizedTarget = normalizeGraphTarget(target);
  if (!normalizedTarget) {
    throw new Error('exploreGraph requires a non-empty target');
  }

  const maxDepth = Math.max(1, Math.min(3, Number(depth) || 2));
  const dir = direction === 'in' || direction === 'out' ? direction : 'both';
  const maxRows = Math.max(1, Math.min(500, Number(limit) || 60));

  // SQLite WITH RECURSIVE joins directly against edges.
  let recursiveStepSql;
  if (dir === 'out') {
    recursiveStepSql = `
      SELECT
        e.dst AS node,
        t.hop + 1 AS hop,
        t.visited || e.dst || '|' AS visited,
        e.src AS edge_src,
        e.dst AS edge_dst,
        e.kind AS edge_kind,
        e.weight AS edge_weight,
        'out' AS step_dir
      FROM traversal t
      JOIN edges e ON e.src = t.node
      WHERE t.hop < ?
        AND instr(t.visited, '|' || e.dst || '|') = 0
    `;
  } else if (dir === 'in') {
    recursiveStepSql = `
      SELECT
        e.src AS node,
        t.hop + 1 AS hop,
        t.visited || e.src || '|' AS visited,
        e.src AS edge_src,
        e.dst AS edge_dst,
        e.kind AS edge_kind,
        e.weight AS edge_weight,
        'in' AS step_dir
      FROM traversal t
      JOIN edges e ON e.dst = t.node
      WHERE t.hop < ?
        AND instr(t.visited, '|' || e.src || '|') = 0
    `;
  } else {
    recursiveStepSql = `
      SELECT
        CASE WHEN e.src = t.node THEN e.dst ELSE e.src END AS node,
        t.hop + 1 AS hop,
        t.visited || (CASE WHEN e.src = t.node THEN e.dst ELSE e.src END) || '|' AS visited,
        e.src AS edge_src,
        e.dst AS edge_dst,
        e.kind AS edge_kind,
        e.weight AS edge_weight,
        CASE WHEN e.src = t.node THEN 'out' ELSE 'in' END AS step_dir
      FROM traversal t
      JOIN edges e ON (e.src = t.node OR e.dst = t.node)
      WHERE t.hop < ?
        AND instr(t.visited, '|' || (CASE WHEN e.src = t.node THEN e.dst ELSE e.src END) || '|') = 0
    `;
  }
  const sql = `
    WITH RECURSIVE traversal(node, hop, visited, edge_src, edge_dst, edge_kind, edge_weight, step_dir) AS (
      SELECT ?, 0, '|' || ? || '|', NULL, NULL, NULL, NULL, NULL
      UNION ALL
      ${recursiveStepSql}
    )
    SELECT node, hop, edge_src, edge_dst, edge_kind, edge_weight, step_dir
    FROM traversal
    WHERE hop > 0
    ORDER BY hop ASC, edge_weight DESC, edge_kind ASC
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(normalizedTarget, normalizedTarget, maxDepth, maxRows);

  const nodeHops = new Map();
  nodeHops.set(normalizedTarget, 0);

  const edgeMap = new Map();
  for (const row of rows) {
    const prevHop = nodeHops.get(row.node);
    if (prevHop === undefined || row.hop < prevHop) {
      nodeHops.set(row.node, row.hop);
    }
    const edgeKey = `${row.edge_src}|${row.edge_dst}|${row.edge_kind}`;
    if (!edgeMap.has(edgeKey)) {
      edgeMap.set(edgeKey, {
        src: row.edge_src,
        dst: row.edge_dst,
        kind: row.edge_kind,
        weight: row.edge_weight,
        hop: row.hop,
        direction: row.step_dir,
      });
    }
  }

  const hydrated = hydrateNodes(db, [...nodeHops.keys()]);
  const nodes = [...nodeHops.entries()]
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
