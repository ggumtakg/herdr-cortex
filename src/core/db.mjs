import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  atomicWriteJson,
  ensureTierDirs,
  formatIsoTimestamp,
  getTierPaths,
  normalizeRelPath,
} from './config.mjs';
import { extractReferences, parseMarkdownDoc } from './frontmatter.mjs';

let sqliteVecModule = null;
try {
  sqliteVecModule = await import('sqlite-vec');
} catch {
  sqliteVecModule = null;
}

const vecEnabledDbs = new WeakSet();

export const SCHEMA_VERSION = 1;

const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS docs (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL,
  session      TEXT NOT NULL DEFAULT '',
  branch       TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  due          TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,
  mtime_ms     REAL NOT NULL,
  size         INTEGER NOT NULL,
  hash         TEXT NOT NULL,
  embed_status TEXT NOT NULL DEFAULT 'pending',
  embed_model  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_filter ON docs(status, type, session, branch, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_docs_embed  ON docs(embed_status, embed_model);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  doc_id UNINDEXED,
  title,
  summary,
  tags,
  content,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS edges (
  src    TEXT NOT NULL,
  dst    TEXT NOT NULL,
  kind   TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst, kind);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src, kind);
`;

function isCorruptionError(err) {
  if (!err) return false;
  const msg = `${err.message || ''} ${err.errstr || ''}`.toLowerCase();
  return (
    msg.includes('malformed')
    || msg.includes('not a database')
    || msg.includes('corrupt')
    || msg.includes('sqlite_corrupt')
    || msg.includes('sqlite_notadb')
    || msg.includes('file is encrypted')
  );
}

export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}

export function readIndexMeta(tierDir) {
  const { indexMetaPath } = getTierPaths(tierDir);
  try {
    if (!fs.existsSync(indexMetaPath)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        embedProvider: '',
        embedModel: '',
        dimensions: 0,
        updatedAt: '',
      };
    }
    const parsed = JSON.parse(fs.readFileSync(indexMetaPath, 'utf8'));
    return {
      schemaVersion: Number(parsed.schemaVersion) || SCHEMA_VERSION,
      embedProvider: String(parsed.embedProvider || ''),
      embedModel: String(parsed.embedModel || ''),
      dimensions: Number(parsed.dimensions) || 0,
      updatedAt: String(parsed.updatedAt || ''),
    };
  } catch {
    return {
      schemaVersion: SCHEMA_VERSION,
      embedProvider: '',
      embedModel: '',
      dimensions: 0,
      updatedAt: '',
    };
  }
}

export function writeIndexMeta(tierDir, meta) {
  const { indexMetaPath } = getTierPaths(tierDir);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    embedProvider: String(meta.embedProvider || ''),
    embedModel: String(meta.embedModel || ''),
    dimensions: Number(meta.dimensions) || 0,
    updatedAt: formatIsoTimestamp(),
  };
  atomicWriteJson(indexMetaPath, payload);
  return payload;
}

export function hasVectorTable(db) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'doc_chunks_vec'")
    .get();
  return Boolean(row);
}

/**
 * Create or rebuild doc_chunks_vec if embedModel or dimensions changed.
 * Returns { ready, rebuilt, dimensions, embedModel }.
 */
export function ensureVectorTable(db, tierDir, { provider = '', model = '', dimensions = 0, vecAvailable = true } = {}) {
  const dims = Number(dimensions) || 0;
  if (!vecAvailable || dims <= 0) {
    return { ready: false, rebuilt: false, dimensions: 0, embedModel: model };
  }

  const meta = readIndexMeta(tierDir);
  const tableExists = hasVectorTable(db);
  const metaMissing = tableExists && meta.dimensions === 0;
  const modelChanged = Boolean(meta.embedModel && model && meta.embedModel !== model);
  const dimsChanged = Boolean(meta.dimensions && meta.dimensions !== dims);
  const needsRebuild = !tableExists || metaMissing || modelChanged || dimsChanged;

  if (needsRebuild) {
    const safeDims = Math.trunc(dims);
    if (!Number.isSafeInteger(safeDims) || safeDims <= 0 || safeDims > 8192) {
      throw new Error(`Invalid vector dimensions: ${dimensions}`);
    }

    withTransaction(db, () => {
      db.exec('DROP TABLE IF EXISTS doc_chunks_vec;');
      db.exec(`
        CREATE VIRTUAL TABLE doc_chunks_vec USING vec0(
          doc_id TEXT PARTITION KEY,
          embedding float[${safeDims}] distance_metric=cosine,
          +chunk_index INTEGER,
          +heading TEXT,
          +snippet TEXT
        );
      `);
      db.exec("UPDATE docs SET embed_status = 'pending', embed_model = '';");
    });

    writeIndexMeta(tierDir, {
      embedProvider: provider || meta.embedProvider,
      embedModel: model || meta.embedModel,
      dimensions: safeDims,
    });

    return { ready: true, rebuilt: true, dimensions: safeDims, embedModel: model };
  }

  if (provider !== meta.embedProvider || model !== meta.embedModel) {
    writeIndexMeta(tierDir, {
      embedProvider: provider || meta.embedProvider,
      embedModel: model || meta.embedModel,
      dimensions: dims,
    });
  }

  return { ready: true, rebuilt: false, dimensions: dims, embedModel: model };
}

function unlinkDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbPath}${suffix}`;
    try {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    } catch {
      // ignore if already gone
    }
  }
}

function initDatabaseInstance(dbPath, { disableVec = false } = {}) {
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');

    let vecAvailable = false;
    if (!disableVec && sqliteVecModule && typeof sqliteVecModule.load === 'function') {
      try {
        sqliteVecModule.load(db);
        vecAvailable = true;
        vecEnabledDbs.add(db);
      } catch {
        vecAvailable = false;
      }
    }

    // Verify DB integrity before creating tables
    const integrityRow = db.prepare('PRAGMA quick_check(1)').get();
    const checkVal = integrityRow ? Object.values(integrityRow)[0] : 'ok';
    if (checkVal !== 'ok') {
      throw new Error(`SQLITE_CORRUPT: quick_check returned ${checkVal}`);
    }

    db.exec(CORE_SCHEMA_SQL);
    return { db, vecAvailable };
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore close error
    }
    throw err;
  }
}

/**
 * Open a tier's SQLite index DB, loading sqlite-vec if available,
 * and auto-recovering corrupted SQLite files by unlinking and rebuilding from Markdown.
 */
export function openTierDb(tierDir, options = {}) {
  const paths = ensureTierDirs(tierDir);
  const { disableVec = false, autoSyncOnRecover = true } = options;

  let db = null;
  let vecAvailable = false;
  let recovered = false;

  try {
    const opened = initDatabaseInstance(paths.dbPath, { disableVec });
    db = opened.db;
    vecAvailable = opened.vecAvailable;
  } catch (err) {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
      db = null;
    }
    if (!isCorruptionError(err)) {
      throw err;
    }
    unlinkDbFiles(paths.dbPath);
    const opened = initDatabaseInstance(paths.dbPath, { disableVec });
    db = opened.db;
    vecAvailable = opened.vecAvailable;
    recovered = true;
  }

  // Restore vector table if index-meta.json already records dimensions
  const meta = readIndexMeta(tierDir);
  if (vecAvailable && meta.dimensions > 0 && !hasVectorTable(db)) {
    ensureVectorTable(db, tierDir, {
      provider: meta.embedProvider,
      model: meta.embedModel,
      dimensions: meta.dimensions,
      vecAvailable,
    });
  }

  if (recovered && autoSyncOnRecover) {
    syncFromDisk(db, tierDir);
  }

  return { db, vecAvailable, recovered, dbPath: paths.dbPath, tierDir: paths.root };
}

function collectMarkdownFiles(docsDir) {
  const files = [];
  if (!fs.existsSync(docsDir)) return files;

  const stack = [docsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(full);
      }
    }
  }
  return files;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeDocRecord(absPath, tierDir, rawText, stat) {
  const relPath = normalizeRelPath(path.relative(tierDir, absPath));
  const { frontmatter, body } = parseMarkdownDoc(rawText);
  const fallbackId = path.basename(absPath, path.extname(absPath));
  const id = String(frontmatter.id || fallbackId).trim() || fallbackId;

  const type = String(frontmatter.type || 'knowledge').trim() || 'knowledge';
  const status = String(frontmatter.status || 'active').trim() || 'active';
  const session = String(frontmatter.session || '').trim();
  const branch = String(frontmatter.branch || '').trim();
  const title = String(frontmatter.title || id).trim();
  const summary = String(frontmatter.summary || '').trim();
  const due = String(frontmatter.due || '').trim();

  const tagsArr = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.map((t) => String(t).trim()).filter(Boolean)
    : typeof frontmatter.tags === 'string' && frontmatter.tags.trim()
      ? [frontmatter.tags.trim()]
      : [];

  const fallbackIso = formatIsoTimestamp(new Date(stat.mtimeMs));
  const created_at = String(frontmatter.created_at || fallbackIso).trim();
  const updated_at = String(frontmatter.updated_at || created_at).trim();

  const refs = extractReferences(body, frontmatter);

  return {
    doc: {
      id,
      path: relPath,
      type,
      status,
      session,
      branch,
      title,
      summary,
      tagsJson: JSON.stringify(tagsArr),
      tagsText: tagsArr.join(' '),
      due,
      content: body,
      mtime_ms: stat.mtimeMs,
      size: stat.size,
      hash: sha256(rawText),
      created_at,
      updated_at,
    },
    refs,
  };
}

function prepareVecDelete(db) {
  if (!vecEnabledDbs.has(db) || !hasVectorTable(db)) return null;
  try {
    return db.prepare('DELETE FROM doc_chunks_vec WHERE doc_id = ?');
  } catch {
    return null;
  }
}

function upsertDocStatements(db) {
  return {
    upsertDoc: db.prepare(`
      INSERT INTO docs (
        id, path, type, status, session, branch, title, summary, tags, due,
        content, mtime_ms, size, hash, embed_status, embed_model, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, 'pending', '', ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        type = excluded.type,
        status = excluded.status,
        session = excluded.session,
        branch = excluded.branch,
        title = excluded.title,
        summary = excluded.summary,
        tags = excluded.tags,
        due = excluded.due,
        content = excluded.content,
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        hash = excluded.hash,
        embed_status = 'pending',
        embed_model = '',
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `),
    updateStatOnly: db.prepare('UPDATE docs SET mtime_ms = ?, size = ? WHERE id = ?'),
    deleteDocById: db.prepare('DELETE FROM docs WHERE id = ?'),
    deleteFtsById: db.prepare('DELETE FROM docs_fts WHERE doc_id = ?'),
    insertFts: db.prepare('INSERT INTO docs_fts (doc_id, title, summary, tags, content) VALUES (?, ?, ?, ?, ?)'),
    deleteVecById: prepareVecDelete(db),
    deleteOutEdges: db.prepare("DELETE FROM edges WHERE src = ? AND kind != 'session_next'"),
    deleteSessionNextForDoc: db.prepare("DELETE FROM edges WHERE (src = ? OR dst = ?) AND kind = 'session_next'"),
    deleteAllDocEdges: db.prepare('DELETE FROM edges WHERE src = ? OR dst = ?'),
    insertEdge: db.prepare('INSERT OR REPLACE INTO edges (src, dst, kind, weight) VALUES (?, ?, ?, ?)'),
  };
}

function writeDocAndEdges(stmts, record) {
  const { doc, refs } = record;

  stmts.upsertDoc.run(
    doc.id,
    doc.path,
    doc.type,
    doc.status,
    doc.session,
    doc.branch,
    doc.title,
    doc.summary,
    doc.tagsJson,
    doc.due,
    doc.content,
    doc.mtime_ms,
    doc.size,
    doc.hash,
    doc.created_at,
    doc.updated_at,
  );

  stmts.deleteFtsById.run(doc.id);
  stmts.insertFts.run(doc.id, doc.title, doc.summary, doc.tagsText, doc.content);

  if (stmts.deleteVecById) {
    stmts.deleteVecById.run(doc.id);
  }

  stmts.deleteOutEdges.run(doc.id);

  for (const targetId of refs.linksTo) {
    if (targetId !== doc.id) {
      stmts.insertEdge.run(doc.id, targetId, 'links_to', 1.0);
    }
  }
  for (const filePath of refs.pointsFiles) {
    stmts.insertEdge.run(doc.id, `file:${filePath}`, 'points_file', 1.0);
  }
  for (const filePath of refs.fileLinks) {
    stmts.insertEdge.run(doc.id, `file:${filePath}`, 'file_link', 0.9);
  }
  for (const supId of refs.supersedes) {
    if (supId !== doc.id) {
      stmts.insertEdge.run(doc.id, supId, 'supersedes', 1.0);
    }
  }
  for (const parentId of refs.derivedFrom) {
    if (parentId !== doc.id) {
      stmts.insertEdge.run(doc.id, parentId, 'derived_from', 1.0);
    }
  }
}

function rebuildSessionNextEdges(db, sessions) {
  if (!sessions || sessions.size === 0) return;

  const selectSessionDocs = db.prepare(
    'SELECT id FROM docs WHERE session = ? ORDER BY created_at ASC, id ASC',
  );
  const deleteSessionEdgeForSrc = db.prepare("DELETE FROM edges WHERE src = ? AND kind = 'session_next'");
  const insertEdge = db.prepare('INSERT OR REPLACE INTO edges (src, dst, kind, weight) VALUES (?, ?, ?, ?)');

  for (const session of sessions) {
    if (!session) continue;
    const rows = selectSessionDocs.all(session);
    for (const row of rows) {
      deleteSessionEdgeForSrc.run(row.id);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      insertEdge.run(rows[i].id, rows[i + 1].id, 'session_next', 0.8);
    }
  }
}

/**
 * Incrementally sync a single Markdown file on disk into SQLite (10-30ms fast path).
 */
export function syncSingleFile(db, tierDir, absFilePath) {
  const root = path.resolve(tierDir);
  const resolvedFile = path.resolve(absFilePath);
  const stat = fs.statSync(resolvedFile);
  const rawText = fs.readFileSync(resolvedFile, 'utf8');
  const record = normalizeDocRecord(resolvedFile, root, rawText, stat);

  const prev = db.prepare('SELECT id, session FROM docs WHERE path = ? OR id = ?').get(record.doc.path, record.doc.id);
  const affectedSessions = new Set();
  if (prev?.session) affectedSessions.add(prev.session);
  if (record.doc.session) affectedSessions.add(record.doc.session);

  withTransaction(db, () => {
    const stmts = upsertDocStatements(db);
    if (prev && prev.id !== record.doc.id) {
      stmts.deleteDocById.run(prev.id);
      stmts.deleteFtsById.run(prev.id);
      if (stmts.deleteVecById) stmts.deleteVecById.run(prev.id);
      stmts.deleteAllDocEdges.run(prev.id, prev.id);
    }
    if (prev && prev.session !== record.doc.session) {
      stmts.deleteSessionNextForDoc.run(record.doc.id, record.doc.id);
    }
    writeDocAndEdges(stmts, record);
    rebuildSessionNextEdges(db, affectedSessions);
  });

  return record.doc;
}

/**
 * Incrementally sync all Markdown files in <tierDir>/docs/ into SQLite.
 * Checks (mtime_ms, size) first, then SHA-256 hash; removes deleted files.
 */
export function syncFromDisk(db, tierDir) {
  const paths = ensureTierDirs(tierDir);
  const diskFiles = collectMarkdownFiles(paths.docsDir);

  const existingRows = db
    .prepare('SELECT id, path, mtime_ms, size, hash, session FROM docs')
    .all();

  const byPath = new Map();
  for (const row of existingRows) {
    byPath.set(row.path, row);
  }

  const seenPaths = new Set();
  const toUpsert = [];
  const toStatOnly = [];
  const affectedSessions = new Set();

  for (const absPath of diskFiles) {
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }

    const relPath = normalizeRelPath(path.relative(paths.root, absPath));
    seenPaths.add(relPath);

    const existing = byPath.get(relPath);
    if (existing && existing.mtime_ms === stat.mtimeMs && existing.size === stat.size) {
      continue;
    }

    let rawText;
    try {
      rawText = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }

    const contentHash = sha256(rawText);
    if (existing && existing.hash === contentHash) {
      toStatOnly.push({ id: existing.id, mtime_ms: stat.mtimeMs, size: stat.size });
      continue;
    }

    const record = normalizeDocRecord(absPath, paths.root, rawText, stat);
    toUpsert.push({ record, prev: existing || null });
    if (existing?.session) affectedSessions.add(existing.session);
    if (record.doc.session) affectedSessions.add(record.doc.session);
  }

  const toDelete = [];
  for (const row of existingRows) {
    if (!seenPaths.has(row.path)) {
      toDelete.push(row);
      if (row.session) affectedSessions.add(row.session);
    }
  }

  if (toUpsert.length === 0 && toStatOnly.length === 0 && toDelete.length === 0) {
    return { addedOrUpdated: 0, statUpdated: 0, deleted: 0 };
  }

  withTransaction(db, () => {
    const stmts = upsertDocStatements(db);

    for (const item of toStatOnly) {
      stmts.updateStatOnly.run(item.mtime_ms, item.size, item.id);
    }

    for (const row of toDelete) {
      stmts.deleteDocById.run(row.id);
      stmts.deleteFtsById.run(row.id);
      if (stmts.deleteVecById) stmts.deleteVecById.run(row.id);
      stmts.deleteAllDocEdges.run(row.id, row.id);
    }

    for (const { record, prev } of toUpsert) {
      if (prev && prev.id !== record.doc.id) {
        stmts.deleteDocById.run(prev.id);
        stmts.deleteFtsById.run(prev.id);
        if (stmts.deleteVecById) stmts.deleteVecById.run(prev.id);
        stmts.deleteAllDocEdges.run(prev.id, prev.id);
      }
      if (prev && prev.session !== record.doc.session) {
        stmts.deleteSessionNextForDoc.run(record.doc.id, record.doc.id);
      }
      writeDocAndEdges(stmts, record);
    }

    rebuildSessionNextEdges(db, affectedSessions);
  });

  return {
    addedOrUpdated: toUpsert.length,
    statUpdated: toStatOnly.length,
    deleted: toDelete.length,
  };
}
