import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  compareTimestamps,
  ensureTierDirs,
  formatIsoTimestamp,
  getTierPaths,
  isValidId,
  normalizeRelPath,
} from './config.mjs';
import { decodeDocBytes } from './encoding.mjs';
import { extractReferences, parseMarkdownDoc } from './frontmatter.mjs';

let sqliteVecModule = null;
try {
  sqliteVecModule = await import('sqlite-vec');
} catch {
  sqliteVecModule = null;
}

const vecEnabledDbs = new WeakSet();

// A connection without the vector extension (hook processes) cannot touch doc_chunks_vec. When it removes a
// document it leaves this marker in index_meta, and the next vector-enabled connection deletes the leftovers.
const VEC_CLEANUP_KEY = 'vecCleanupPending';
const orphanSweptDbPaths = new Set(); // index files this process has already swept once

export const SCHEMA_VERSION = 2;

const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS docs (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  status         TEXT NOT NULL,
  session        TEXT NOT NULL DEFAULT '',
  branch         TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  tags           TEXT NOT NULL DEFAULT '[]',
  due            TEXT NOT NULL DEFAULT '',
  content        TEXT NOT NULL,
  mtime_ms       REAL NOT NULL,
  size           INTEGER NOT NULL,
  hash           TEXT NOT NULL,
  content_hash   TEXT NOT NULL DEFAULT '',
  embed_status   TEXT NOT NULL DEFAULT 'pending',
  embed_model    TEXT NOT NULL DEFAULT '',
  embed_attempts INTEGER NOT NULL DEFAULT 0,
  embed_error    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_filter ON docs(status, type, session, branch, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_docs_embed  ON docs(embed_status, embed_model);

CREATE TABLE IF NOT EXISTS index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function computeContentHash(title, summary, content) {
  return sha256(`${String(title ?? '')}\n${String(summary ?? '')}\n${String(content ?? '')}`);
}

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

function defaultIndexMeta(schemaVersion = SCHEMA_VERSION) {
  return {
    schemaVersion,
    embedProvider: '',
    embedModel: '',
    dimensions: 0,
    updatedAt: '',
  };
}

function readLegacyIndexMetaFile(tierDir) {
  try {
    const { indexMetaPath } = getTierPaths(tierDir);
    if (!fs.existsSync(indexMetaPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(indexMetaPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      embedProvider: String(parsed.embedProvider || ''),
      embedModel: String(parsed.embedModel || ''),
      dimensions: Number(parsed.dimensions) || 0,
      updatedAt: String(parsed.updatedAt || ''),
    };
  } catch {
    return null;
  }
}

function readIndexMetaFromDb(db) {
  try {
    const rows = db.prepare('SELECT key, value FROM index_meta').all();
    if (!rows || rows.length === 0) {
      return null;
    }
    const map = new Map();
    for (const r of rows) {
      map.set(r.key, r.value);
    }
    return {
      schemaVersion: Number(map.get('schemaVersion')) || 1,
      embedProvider: String(map.get('embedProvider') || ''),
      embedModel: String(map.get('embedModel') || ''),
      dimensions: Number(map.get('dimensions')) || 0,
      updatedAt: String(map.get('updatedAt') || ''),
    };
  } catch {
    return null;
  }
}

/**
 * Read index metadata from the SQLite `index_meta` table.
 * Accepts either an open `DatabaseSync` instance (preferred) or a `tierDir` string for compatibility.
 */
export function readIndexMeta(dbOrTierDir) {
  if (dbOrTierDir && typeof dbOrTierDir.prepare === 'function') {
    return readIndexMetaFromDb(dbOrTierDir) || defaultIndexMeta(SCHEMA_VERSION);
  }
  if (typeof dbOrTierDir === 'string' && dbOrTierDir.trim()) {
    const { dbPath } = getTierPaths(dbOrTierDir);
    if (fs.existsSync(dbPath)) {
      let tmpDb = null;
      try {
        tmpDb = new DatabaseSync(dbPath, { readOnly: true });
        tmpDb.exec('PRAGMA busy_timeout = 2000;');
        const fromDb = readIndexMetaFromDb(tmpDb);
        if (fromDb) return fromDb;
      } catch {
        // fallback below
      } finally {
        if (tmpDb) {
          try { tmpDb.close(); } catch { /* ignore */ }
        }
      }
    }
    const legacy = readLegacyIndexMetaFile(dbOrTierDir);
    if (legacy) return legacy;
  }
  return defaultIndexMeta(SCHEMA_VERSION);
}

/**
 * Write index metadata into the SQLite `index_meta` table.
 * Safe to invoke inside an active transaction.
 */
export function writeIndexMeta(db, meta = {}) {
  const payload = {
    schemaVersion: Number(meta.schemaVersion) || SCHEMA_VERSION,
    embedProvider: String(meta.embedProvider || ''),
    embedModel: String(meta.embedModel || ''),
    dimensions: Number(meta.dimensions) || 0,
    updatedAt: meta.updatedAt ? String(meta.updatedAt) : formatIsoTimestamp(),
  };

  if (db && typeof db.prepare === 'function') {
    const upsert = db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)');
    upsert.run('schemaVersion', String(payload.schemaVersion));
    upsert.run('embedProvider', payload.embedProvider);
    upsert.run('embedModel', payload.embedModel);
    upsert.run('dimensions', String(payload.dimensions));
    upsert.run('updatedAt', payload.updatedAt);
  }
  return payload;
}

export function hasVectorTable(db) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'doc_chunks_vec'")
    .get();
  return Boolean(row);
}

function isVectorTableSchemaCurrent(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'doc_chunks_vec'")
    .get();
  if (!row || typeof row.sql !== 'string') return false;
  const sql = row.sql;
  if (/partition\s+key/i.test(sql)) return false;
  if (!/\bstatus\s+TEXT\b/i.test(sql) || !/\btype\s+TEXT\b/i.test(sql)) return false;
  return true;
}

function createVecTableSql(safeDims) {
  return `
    CREATE VIRTUAL TABLE doc_chunks_vec USING vec0(
      doc_id TEXT,
      status TEXT,
      type TEXT,
      embedding float[${safeDims}] distance_metric=cosine,
      +chunk_index INTEGER,
      +heading TEXT,
      +snippet TEXT,
      chunk_size=64
    );
  `;
}

/**
 * Create or rebuild doc_chunks_vec if embedModel, dimensions, or vec0 schema changed.
 * Updates `doc_chunks_vec`, `docs`, and `index_meta` atomically in ONE SQLite transaction.
 * Supports both `ensureVectorTable(db, tierDir, opts)` and `ensureVectorTable(db, opts)`.
 * Returns { ready, rebuilt, dimensions, embedModel }.
 */
export function ensureVectorTable(db, tierDirOrOpts = {}, maybeOpts) {
  const opts = typeof tierDirOrOpts === 'string' ? (maybeOpts || {}) : (tierDirOrOpts || {});
  const { provider = '', model = '', dimensions = 0, vecAvailable = true } = opts;

  const dims = Number(dimensions) || 0;
  if (!vecAvailable || dims <= 0) {
    return { ready: false, rebuilt: false, dimensions: 0, embedModel: model };
  }

  const meta = readIndexMeta(db);
  const tableExists = hasVectorTable(db);
  const schemaOutdated = tableExists && !isVectorTableSchemaCurrent(db);
  const metaMissing = tableExists && meta.dimensions === 0;
  const modelChanged = Boolean(meta.embedModel && model && meta.embedModel !== model);
  const dimsChanged = Boolean(meta.dimensions && meta.dimensions !== dims);
  const needsRebuild = !tableExists || schemaOutdated || metaMissing || modelChanged || dimsChanged;

  if (needsRebuild) {
    const safeDims = Math.trunc(dims);
    if (!Number.isSafeInteger(safeDims) || safeDims <= 0 || safeDims > 8192) {
      throw new Error(`Invalid vector dimensions: ${dimensions}`);
    }

    withTransaction(db, () => {
      db.exec('DROP TABLE IF EXISTS doc_chunks_vec;');
      db.exec(createVecTableSql(safeDims));
      db.exec("UPDATE docs SET embed_status = 'pending', embed_model = '', embed_attempts = 0, embed_error = '';");
      writeIndexMeta(db, {
        schemaVersion: SCHEMA_VERSION,
        embedProvider: provider || meta.embedProvider,
        embedModel: model || meta.embedModel,
        dimensions: safeDims,
      });
    });

    return { ready: true, rebuilt: true, dimensions: safeDims, embedModel: model };
  }

  if (provider !== meta.embedProvider || model !== meta.embedModel || meta.schemaVersion !== SCHEMA_VERSION) {
    withTransaction(db, () => {
      writeIndexMeta(db, {
        schemaVersion: SCHEMA_VERSION,
        embedProvider: provider || meta.embedProvider,
        embedModel: model || meta.embedModel,
        dimensions: dims,
      });
    });
  }

  return { ready: true, rebuilt: false, dimensions: dims, embedModel: model };
}

/**
 * Safely unlink SQLite DB files during corruption recovery.
 * Attempts to unlink `index.sqlite` FIRST; if locked (EBUSY/EPERM/EACCES),
 * rethrows immediately WITHOUT deleting `-wal` or `-shm` so active readers/writers are not corrupted.
 */
export function unlinkDbFiles(dbPath) {
  try {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // already gone, safe to clean sidecars
    } else if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      throw err;
    } else {
      throw err;
    }
  }

  for (const suffix of ['-wal', '-shm']) {
    const candidate = `${dbPath}${suffix}`;
    try {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    } catch {
      // ignore if already gone
    }
  }
}

function migrateSchemaIfNeeded(db, tierDir, vecAvailable) {
  // 1. Add missing v2 columns to existing docs tables
  const colRows = db.prepare('PRAGMA table_info(docs)').all();
  const cols = new Set(colRows.map((c) => c.name));
  const needsContentHashBackfill = !cols.has('content_hash');

  if (!cols.has('content_hash')) {
    db.exec("ALTER TABLE docs ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';");
  }
  if (!cols.has('embed_attempts')) {
    db.exec('ALTER TABLE docs ADD COLUMN embed_attempts INTEGER NOT NULL DEFAULT 0;');
  }
  if (!cols.has('embed_error')) {
    db.exec("ALTER TABLE docs ADD COLUMN embed_error TEXT NOT NULL DEFAULT '';");
  }

  if (needsContentHashBackfill) {
    const rows = db.prepare("SELECT id, title, summary, content FROM docs WHERE content_hash = ''").all();
    if (rows.length > 0) {
      withTransaction(db, () => {
        const upd = db.prepare('UPDATE docs SET content_hash = ? WHERE id = ?');
        for (const r of rows) {
          upd.run(computeContentHash(r.title, r.summary, r.content), r.id);
        }
      });
    }
  }

  // 2. Migrate legacy state/index-meta.json into SQLite index_meta table if empty
  let dbMeta = readIndexMetaFromDb(db);
  if (!dbMeta) {
    const legacy = tierDir ? readLegacyIndexMetaFile(tierDir) : null;
    if (legacy) {
      withTransaction(db, () => {
        writeIndexMeta(db, {
          schemaVersion: legacy.schemaVersion || 1,
          embedProvider: legacy.embedProvider,
          embedModel: legacy.embedModel,
          dimensions: legacy.dimensions,
          updatedAt: legacy.updatedAt || formatIsoTimestamp(),
        });
      });
      dbMeta = readIndexMetaFromDb(db);
    } else {
      const hasVec = hasVectorTable(db);
      const initialVer = hasVec && !isVectorTableSchemaCurrent(db) ? 1 : SCHEMA_VERSION;
      withTransaction(db, () => {
        writeIndexMeta(db, { schemaVersion: initialVer });
      });
      dbMeta = readIndexMetaFromDb(db);
    }
  }

  // 3. Upgrade outdated v1 doc_chunks_vec (with PARTITION KEY) automatically when vecAvailable
  const hasVec = hasVectorTable(db);
  const outdatedVec = hasVec && !isVectorTableSchemaCurrent(db);

  if (vecAvailable && (outdatedVec || (dbMeta && dbMeta.schemaVersion < SCHEMA_VERSION))) {
    if (dbMeta && dbMeta.dimensions > 0) {
      ensureVectorTable(db, {
        provider: dbMeta.embedProvider,
        model: dbMeta.embedModel,
        dimensions: dbMeta.dimensions,
        vecAvailable: true,
      });
    } else if (outdatedVec) {
      withTransaction(db, () => {
        db.exec('DROP TABLE IF EXISTS doc_chunks_vec;');
        db.exec("UPDATE docs SET embed_status = 'pending', embed_model = '', embed_attempts = 0, embed_error = '';");
        writeIndexMeta(db, {
          schemaVersion: SCHEMA_VERSION,
          embedProvider: dbMeta?.embedProvider || '',
          embedModel: dbMeta?.embedModel || '',
          dimensions: 0,
        });
      });
    } else {
      withTransaction(db, () => {
        writeIndexMeta(db, {
          schemaVersion: SCHEMA_VERSION,
          embedProvider: dbMeta?.embedProvider || '',
          embedModel: dbMeta?.embedModel || '',
          dimensions: dbMeta?.dimensions || 0,
        });
      });
    }
  } else if (!outdatedVec && dbMeta && dbMeta.schemaVersion < SCHEMA_VERSION) {
    withTransaction(db, () => {
      writeIndexMeta(db, {
        schemaVersion: SCHEMA_VERSION,
        embedProvider: dbMeta.embedProvider,
        embedModel: dbMeta.embedModel,
        dimensions: dbMeta.dimensions,
      });
    });
  }
}

function initDatabaseInstance(dbPath, { disableVec = false, tierDir = '' } = {}) {
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
    migrateSchemaIfNeeded(db, tierDir, vecAvailable);
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
    const opened = initDatabaseInstance(paths.dbPath, { disableVec, tierDir: paths.root });
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
    const opened = initDatabaseInstance(paths.dbPath, { disableVec, tierDir: paths.root });
    db = opened.db;
    vecAvailable = opened.vecAvailable;
    recovered = true;
  }

  // Restore vector table if index_meta already records dimensions
  const meta = readIndexMeta(db);
  if (vecAvailable && meta.dimensions > 0 && !hasVectorTable(db)) {
    ensureVectorTable(db, {
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
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function sanitizeManualDocId(rawId, fallbackId, relPath) {
  const trimmed = String(rawId || '').trim();
  if (trimmed && isValidId(trimmed)) {
    return trimmed;
  }
  if (trimmed) {
    console.error(`[herdr-cortex] Warning: invalid frontmatter id "${trimmed}" in "${relPath}"; falling back to filename.`);
  }
  const fb = String(fallbackId || '').trim();
  if (fb && isValidId(fb)) {
    return fb;
  }
  const cleaned = fb
    .replace(/[^a-zA-Z0-9가-힣._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120);
  if (cleaned && isValidId(cleaned)) {
    console.error(`[herdr-cortex] Warning: sanitized invalid doc filename id "${fb}" -> "${cleaned}" in "${relPath}".`);
    return cleaned;
  }
  const prefixed = `doc-${cleaned || sha256(relPath).slice(0, 12)}`.slice(0, 128);
  if (isValidId(prefixed)) {
    console.error(`[herdr-cortex] Warning: sanitized invalid doc id in "${relPath}" -> "${prefixed}".`);
    return prefixed;
  }
  return null;
}

function normalizeDocRecord(absPath, tierDir, rawText, stat) {
  const relPath = normalizeRelPath(path.relative(tierDir, absPath));
  const { frontmatter, body } = parseMarkdownDoc(rawText);
  const fallbackId = path.basename(absPath, path.extname(absPath));
  const id = sanitizeManualDocId(frontmatter.id, fallbackId, relPath);
  if (!id) return null;

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
  const contentHash = computeContentHash(title, summary, body);

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
      content_hash: contentHash,
      created_at,
      updated_at,
    },
    refs,
  };
}

function prepareVecStatements(db) {
  if (!vecEnabledDbs.has(db) || !hasVectorTable(db)) {
    return { deleteVecById: null, updateVecMeta: null };
  }
  let deleteVecById = null;
  let updateVecMeta = null;
  try {
    deleteVecById = db.prepare('DELETE FROM doc_chunks_vec WHERE doc_id = ?');
  } catch {
    deleteVecById = null;
  }
  try {
    if (isVectorTableSchemaCurrent(db)) {
      updateVecMeta = db.prepare('UPDATE doc_chunks_vec SET status = ?, type = ? WHERE doc_id = ?');
    }
  } catch {
    updateVecMeta = null;
  }
  return { deleteVecById, updateVecMeta };
}

function upsertDocStatements(db) {
  const vecStmts = prepareVecStatements(db);
  return {
    upsertDoc: db.prepare(`
      INSERT INTO docs (
        id, path, type, status, session, branch, title, summary, tags, due,
        content, mtime_ms, size, hash, content_hash,
        embed_status, embed_model, embed_attempts, embed_error,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
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
        content_hash = excluded.content_hash,
        embed_status = excluded.embed_status,
        embed_model = excluded.embed_model,
        embed_attempts = excluded.embed_attempts,
        embed_error = excluded.embed_error,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `),
    updateStatOnly: db.prepare('UPDATE docs SET mtime_ms = ?, size = ? WHERE id = ?'),
    deleteDocById: db.prepare('DELETE FROM docs WHERE id = ?'),
    deleteFtsById: db.prepare('DELETE FROM docs_fts WHERE doc_id = ?'),
    insertFts: db.prepare('INSERT INTO docs_fts (doc_id, title, summary, tags, content) VALUES (?, ?, ?, ?, ?)'),
    deleteVecById: vecStmts.deleteVecById,
    updateVecMeta: vecStmts.updateVecMeta,
    deleteOutEdges: db.prepare("DELETE FROM edges WHERE src = ? AND kind != 'session_next'"),
    deleteSessionNextForDoc: db.prepare("DELETE FROM edges WHERE (src = ? OR dst = ?) AND kind = 'session_next'"),
    deleteAllDocEdges: db.prepare('DELETE FROM edges WHERE src = ? OR dst = ?'),
    insertEdge: db.prepare('INSERT OR REPLACE INTO edges (src, dst, kind, weight) VALUES (?, ?, ?, ?)'),
  };
}

function writeDocAndEdges(stmts, record, prevDoc = null) {
  const { doc, refs } = record;
  const preserveVectors = Boolean(
    prevDoc
    && prevDoc.id === doc.id
    && prevDoc.content_hash
    && prevDoc.content_hash === doc.content_hash,
  );

  const embedStatus = preserveVectors ? (prevDoc.embed_status || 'pending') : 'pending';
  const embedModel = preserveVectors ? (prevDoc.embed_model || '') : '';
  const embedAttempts = preserveVectors ? (Number(prevDoc.embed_attempts) || 0) : 0;
  const embedError = preserveVectors ? (prevDoc.embed_error || '') : '';

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
    doc.content_hash,
    embedStatus,
    embedModel,
    embedAttempts,
    embedError,
    doc.created_at,
    doc.updated_at,
  );

  doc.embed_status = embedStatus;
  doc.embed_model = embedModel;

  stmts.deleteFtsById.run(doc.id);
  stmts.insertFts.run(doc.id, doc.title, doc.summary, doc.tagsText, doc.content);

  if (preserveVectors) {
    if (stmts.updateVecMeta) {
      try {
        stmts.updateVecMeta.run(doc.status, doc.type, doc.id);
      } catch {
        // ignore if vec0 update unavailable
      }
    }
  } else if (stmts.deleteVecById) {
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

/**
 * Order documents of one session by creation time, then by id.
 * Timestamps are compared as points in time rather than as strings, so second-precision values
 * written by older versions, millisecond values, and hand-written variants (`Z`, no offset) mix correctly.
 */
function compareSessionDocOrder(a, b) {
  const byTime = compareTimestamps(a.created_at, b.created_at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function rebuildSessionNextEdges(db, sessions) {
  if (!sessions || sessions.size === 0) return;

  const selectSessionDocs = db.prepare('SELECT id, created_at FROM docs WHERE session = ?');
  const deleteSessionEdgeForSrc = db.prepare("DELETE FROM edges WHERE src = ? AND kind = 'session_next'");
  const insertEdge = db.prepare('INSERT OR REPLACE INTO edges (src, dst, kind, weight) VALUES (?, ?, ?, ?)');

  for (const session of sessions) {
    if (!session) continue;
    const rows = selectSessionDocs.all(session).sort(compareSessionDocOrder);
    for (const row of rows) {
      deleteSessionEdgeForSrc.run(row.id);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      insertEdge.run(rows[i].id, rows[i + 1].id, 'session_next', 0.8);
    }
  }
}

/**
 * Read a document file and decode it to text (UTF-8, UTF-16 with a byte-order mark, or CP949).
 * Returns the `decodeDocBytes` result; undecodable bytes never throw, they come back with `safe: false`
 * and a lossy `text` that can be indexed but must not be written back.
 */
export function readDocFile(absPath) {
  return decodeDocBytes(fs.readFileSync(absPath));
}

/**
 * Index a single Markdown file inside a transaction the caller already holds (see `withTransaction`).
 * This lets a caller keep its own read-modify-write of the file and the index update under one write lock.
 */
export function indexSingleFile(db, tierDir, absFilePath) {
  const root = path.resolve(tierDir);
  const resolvedFile = path.resolve(absFilePath);
  const stat = fs.statSync(resolvedFile);
  const rawText = readDocFile(resolvedFile).text;
  const record = normalizeDocRecord(resolvedFile, root, rawText, stat);
  if (!record) {
    throw new Error(`Unable to derive valid document ID for "${resolvedFile}"`);
  }

  const prevByPath = db
    .prepare('SELECT id, path, session, content_hash, embed_status, embed_model, embed_attempts, embed_error FROM docs WHERE path = ?')
    .get(record.doc.path);
  const prevById = db
    .prepare('SELECT id, path, session, content_hash, embed_status, embed_model, embed_attempts, embed_error FROM docs WHERE id = ?')
    .get(record.doc.id);

  const affectedSessions = new Set();
  if (prevByPath?.session) affectedSessions.add(prevByPath.session);
  if (prevById?.session) affectedSessions.add(prevById.session);
  if (record.doc.session) affectedSessions.add(record.doc.session);

  const stmts = upsertDocStatements(db);

  if (prevByPath && prevByPath.id !== record.doc.id) {
    stmts.deleteDocById.run(prevByPath.id);
    stmts.deleteFtsById.run(prevByPath.id);
    if (stmts.deleteVecById) {
      stmts.deleteVecById.run(prevByPath.id);
    } else if (hasVectorTable(db)) {
      // No vector extension on this connection: leave the cleanup to one that has it.
      db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)').run(VEC_CLEANUP_KEY, '1');
    }
    stmts.deleteAllDocEdges.run(prevByPath.id, prevByPath.id);
  }

  const prevForDoc = prevById || (prevByPath?.id === record.doc.id ? prevByPath : null);
  if (prevForDoc && prevForDoc.session !== record.doc.session) {
    stmts.deleteSessionNextForDoc.run(record.doc.id, record.doc.id);
  }

  writeDocAndEdges(stmts, record, prevForDoc);
  rebuildSessionNextEdges(db, affectedSessions);

  return record.doc;
}

/**
 * Incrementally sync a single Markdown file on disk into SQLite (10-30ms fast path).
 */
export function syncSingleFile(db, tierDir, absFilePath) {
  return withTransaction(db, () => indexSingleFile(db, tierDir, absFilePath));
}

// Bump when the way file bytes are turned into text changes, so files indexed by an older decoder
// (for example CP949 files that were read as broken UTF-8) are re-read once on the next sync.
const TEXT_DECODER_VERSION = '2';

const duplicateDocsByTier = new Map(); // tier root -> [{ id, path, keptPath }]
const warnedDuplicates = new Set(); // `${tierRoot}\0${id}\0${path}`

function noteDuplicateDoc(found, tierRoot, id, relPath, keptPath) {
  found.push({ id, path: relPath, keptPath });
  const key = `${tierRoot}\0${id}\0${relPath}`;
  if (warnedDuplicates.has(key)) return;
  warnedDuplicates.add(key);
  console.error(
    `[herdr-cortex] Warning: duplicate document ID "${id}" in "${relPath}" (already indexed at "${keptPath}"); skipping duplicate.`,
  );
}

/**
 * Documents that the most recent `syncFromDisk` of this tier (in this process) skipped because another
 * file already uses the same id. Returns [{ id, path, keptPath }] with paths relative to the tier directory;
 * empty when the tier has not been synced yet or has no duplicates.
 */
export function getDuplicateDocIds(tierDir) {
  const found = duplicateDocsByTier.get(path.resolve(tierDir)) || [];
  return found.map((item) => ({ ...item }));
}

/**
 * Delete vector rows whose document no longer exists. Returns the number of rows removed.
 * Must run on a vector-enabled connection, inside the caller's transaction.
 */
function deleteOrphanVectors(db) {
  try {
    const res = db.prepare('DELETE FROM doc_chunks_vec WHERE doc_id NOT IN (SELECT id FROM docs)').run();
    return Number(res.changes) || 0;
  } catch {
    return 0;
  }
}

/**
 * Orphan-vector upkeep for one sync (see VEC_CLEANUP_KEY). `removedDocs` says whether this sync deleted
 * document rows whose vectors it could not delete itself.
 */
function reconcileOrphanVectors(db, { removedDocs, dbPath }) {
  if (!hasVectorTable(db)) return 0;

  if (!vecEnabledDbs.has(db)) {
    if (removedDocs) {
      db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)').run(VEC_CLEANUP_KEY, '1');
    }
    return 0;
  }

  // The scan reads the whole vector table, so it runs only when another connection asked for it,
  // and once per process and index file to catch leftovers from before the marker existed.
  const flagged = db.prepare('SELECT value FROM index_meta WHERE key = ?').get(VEC_CLEANUP_KEY)?.value === '1';
  if (!flagged && orphanSweptDbPaths.has(dbPath)) return 0;

  const removed = deleteOrphanVectors(db);
  orphanSweptDbPaths.add(dbPath);
  if (flagged) {
    db.prepare('DELETE FROM index_meta WHERE key = ?').run(VEC_CLEANUP_KEY);
  }
  return removed;
}

/**
 * Incrementally sync all Markdown files in <tierDir>/docs/ into SQLite.
 * Reads existing state INSIDE a `BEGIN IMMEDIATE` transaction to prevent TOCTOU races.
 * Checks (mtime_ms, size) first, then SHA-256 hash; detects duplicate IDs; removes deleted files.
 * On a vector-enabled connection it also removes vector rows left behind by connections that could not;
 * the result then carries `orphanVectorsRemoved` (the key is absent when nothing was removed).
 */
export function syncFromDisk(db, tierDir) {
  const paths = ensureTierDirs(tierDir);
  const diskFiles = collectMarkdownFiles(paths.docsDir);

  let addedOrUpdated = 0;
  let statUpdated = 0;
  let deleted = 0;
  let orphanVectorsRemoved = 0;
  const duplicates = [];

  withTransaction(db, () => {
    const decoderRow = db.prepare("SELECT value FROM index_meta WHERE key = 'textDecoderVersion'").get();
    const rereadAll = decoderRow?.value !== TEXT_DECODER_VERSION;

    const existingRows = db
      .prepare('SELECT id, path, mtime_ms, size, hash, content_hash, session, embed_status, embed_model, embed_attempts, embed_error FROM docs')
      .all();

    const byPath = new Map();
    const byId = new Map();
    for (const row of existingRows) {
      byPath.set(row.path, row);
      byId.set(row.id, row);
    }

    const seenPaths = new Set();
    const seenIds = new Map(); // id -> winning relPath
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
      const existing = byPath.get(relPath);

      const statUnchanged = Boolean(existing) && existing.mtime_ms === stat.mtimeMs && existing.size === stat.size;

      if (statUnchanged && !rereadAll) {
        if (seenIds.has(existing.id)) {
          noteDuplicateDoc(duplicates, paths.root, existing.id, relPath, seenIds.get(existing.id));
          continue;
        }
        seenPaths.add(relPath);
        seenIds.set(existing.id, relPath);
        continue;
      }

      // Undecodable bytes come back as lossy text (still indexable); only a failed read skips the file.
      let rawText;
      try {
        rawText = readDocFile(absPath).text;
      } catch {
        continue;
      }

      const fileHash = sha256(rawText);
      if (existing && existing.hash === fileHash) {
        if (seenIds.has(existing.id)) {
          noteDuplicateDoc(duplicates, paths.root, existing.id, relPath, seenIds.get(existing.id));
          continue;
        }
        seenPaths.add(relPath);
        seenIds.set(existing.id, relPath);
        if (!statUnchanged) {
          toStatOnly.push({ id: existing.id, mtime_ms: stat.mtimeMs, size: stat.size });
        }
        continue;
      }

      const record = normalizeDocRecord(absPath, paths.root, rawText, stat);
      if (!record) continue;

      if (seenIds.has(record.doc.id)) {
        noteDuplicateDoc(duplicates, paths.root, record.doc.id, relPath, seenIds.get(record.doc.id));
        continue;
      }

      seenPaths.add(relPath);
      seenIds.set(record.doc.id, relPath);

      const prevById = byId.get(record.doc.id) || null;
      toUpsert.push({ record, prevByPath: existing || null, prevById });
      if (existing?.session) affectedSessions.add(existing.session);
      if (prevById?.session) affectedSessions.add(prevById.session);
      if (record.doc.session) affectedSessions.add(record.doc.session);
    }

    const toDelete = [];
    for (const row of existingRows) {
      if (!seenPaths.has(row.path)) {
        toDelete.push(row);
        if (row.session) affectedSessions.add(row.session);
      }
    }

    if (rereadAll) {
      db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)').run('textDecoderVersion', TEXT_DECODER_VERSION);
    }

    if (toUpsert.length === 0 && toStatOnly.length === 0 && toDelete.length === 0) {
      orphanVectorsRemoved = reconcileOrphanVectors(db, { removedDocs: false, dbPath: paths.dbPath });
      return;
    }

    const stmts = upsertDocStatements(db);
    let removedDocs = false;

    for (const item of toStatOnly) {
      stmts.updateStatOnly.run(item.mtime_ms, item.size, item.id);
    }

    for (const row of toDelete) {
      // If the same doc ID moved to a new path in `toUpsert`, delete old row cleanly without losing vector check via prevById
      stmts.deleteDocById.run(row.id);
      stmts.deleteFtsById.run(row.id);
      if (!seenIds.has(row.id)) {
        removedDocs = true;
        if (stmts.deleteVecById) stmts.deleteVecById.run(row.id);
      }
      stmts.deleteAllDocEdges.run(row.id, row.id);
    }

    for (const { record, prevByPath, prevById } of toUpsert) {
      if (prevByPath && prevByPath.id !== record.doc.id) {
        removedDocs = true;
        stmts.deleteDocById.run(prevByPath.id);
        stmts.deleteFtsById.run(prevByPath.id);
        if (stmts.deleteVecById) stmts.deleteVecById.run(prevByPath.id);
        stmts.deleteAllDocEdges.run(prevByPath.id, prevByPath.id);
      }
      const prevForDoc = prevById || (prevByPath?.id === record.doc.id ? prevByPath : null);
      if (prevForDoc && prevForDoc.session !== record.doc.session) {
        stmts.deleteSessionNextForDoc.run(record.doc.id, record.doc.id);
      }
      writeDocAndEdges(stmts, record, prevForDoc);
    }

    rebuildSessionNextEdges(db, affectedSessions);

    orphanVectorsRemoved = reconcileOrphanVectors(db, { removedDocs, dbPath: paths.dbPath });

    addedOrUpdated = toUpsert.length;
    statUpdated = toStatOnly.length;
    deleted = toDelete.filter((r) => !seenIds.has(r.id)).length;
  });

  duplicateDocsByTier.set(paths.root, duplicates);

  return {
    addedOrUpdated,
    statUpdated,
    deleted,
    ...(orphanVectorsRemoved > 0 ? { orphanVectorsRemoved } : {}),
  };
}
