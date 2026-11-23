import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  atomicWriteJson,
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

// How long a connection waits for a lock another connection holds before it reports SQLITE_BUSY.
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

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
  embed_service_failures INTEGER NOT NULL DEFAULT 0,
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
      db.exec("UPDATE docs SET embed_status = 'pending', embed_model = '', embed_attempts = 0, embed_service_failures = 0, embed_error = '';");
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
  // Failures of the embedding service while this document was being embedded (timeout, network, 5xx, 429).
  // Counted apart from embed_attempts, reset when the content changes or the document is embedded.
  if (!cols.has('embed_service_failures')) {
    db.exec('ALTER TABLE docs ADD COLUMN embed_service_failures INTEGER NOT NULL DEFAULT 0;');
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
        db.exec("UPDATE docs SET embed_status = 'pending', embed_model = '', embed_attempts = 0, embed_service_failures = 0, embed_error = '';");
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
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
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
        embed_status, embed_model, embed_attempts, embed_error, embed_service_failures,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
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
        embed_service_failures = excluded.embed_service_failures,
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
  const embedServiceFailures = preserveVectors ? (Number(prevDoc.embed_service_failures) || 0) : 0;

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
    embedServiceFailures,
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
    .prepare('SELECT id, path, session, content_hash, embed_status, embed_model, embed_attempts, embed_error, embed_service_failures FROM docs WHERE path = ?')
    .get(record.doc.path);
  const prevById = db
    .prepare('SELECT id, path, session, content_hash, embed_status, embed_model, embed_attempts, embed_error, embed_service_failures FROM docs WHERE id = ?')
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

// ---------------------------------------------------------------------------------------------
// Deferred indexing
//
// A sync that runs under a time budget (the session-start hooks) does not index every changed file: a file
// that is too big for a hook, or that does not fit in the time that is left, is deferred. Deferred files are
// never excluded: the next sync without a budget (the MCP server, in the background after it starts and on
// its regular syncs) indexes them. What one sync left undone is written to
// <tierDir>/state/deferred-index.json and removed again by the first sync that leaves nothing undone.
// ---------------------------------------------------------------------------------------------

export const DEFERRED_INDEX_FILE = 'deferred-index.json';
/** Most entries the record lists (`count` always holds the real number). */
export const DEFERRED_INDEX_MAX_ENTRIES = 200;

export const DEFER_REASON_TOO_LARGE = 'too_large'; // larger than the sync's `maxFileBytes`
export const DEFER_REASON_TIME_BUDGET = 'time_budget'; // does not fit in the time left before `deadline`
export const DEFER_REASON_INDEX_BUSY = 'index_busy'; // another process held the index write lock
export const DEFER_REASON_ERROR = 'error'; // reading or indexing the file failed (`error` holds the message)

export function getDeferredIndexPath(tierDir) {
  return path.join(getTierPaths(tierDir).stateDir, DEFERRED_INDEX_FILE);
}

function cleanDeferredEntry(item) {
  if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !item.path) return null;
  const entry = {
    path: item.path,
    size: Number(item.size) || 0,
    reason: typeof item.reason === 'string' && item.reason ? item.reason : DEFER_REASON_ERROR,
  };
  if (typeof item.error === 'string' && item.error) entry.error = item.error;
  return entry;
}

/**
 * Documents the last sync of this tier did not index:
 * { count, files: [{ path, size, reason, error? }], updatedAt } with paths relative to the tier directory.
 * `count` is 0 and `files` is empty when nothing is waiting (no record file).
 */
export function readDeferredIndex(tierDir) {
  const empty = { count: 0, files: [], updatedAt: '' };
  try {
    const filePath = getDeferredIndexPath(tierDir);
    if (!fs.existsSync(filePath)) return empty;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.files)) return empty;
    const files = parsed.files.map(cleanDeferredEntry).filter(Boolean);
    return {
      count: Math.max(files.length, Number(parsed.count) || 0),
      files,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return empty;
  }
}

// Replace the record with what this sync left undone; no entries removes the file.
function writeDeferredIndex(tierDir, entries) {
  const filePath = getDeferredIndexPath(tierDir);
  try {
    if (entries.length === 0) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return;
    }
    const files = entries.slice(0, DEFERRED_INDEX_MAX_ENTRIES).map(cleanDeferredEntry).filter(Boolean);
    const previous = readDeferredIndex(tierDir);
    if (previous.count === entries.length && JSON.stringify(previous.files) === JSON.stringify(files)) return;
    atomicWriteJson(filePath, {
      version: 1,
      updatedAt: formatIsoTimestamp(),
      count: entries.length,
      files,
    });
  } catch {
    // The record is advisory: a failed write never fails the sync.
  }
}

// Sessions whose session_next chain must be rebuilt. The list is stored with every file that is indexed and
// cleared when the chains were rebuilt, so a sync that is stopped or killed between files leaves a note for
// the next one instead of stale chains.
const SESSION_EDGES_PENDING_KEY = 'sessionEdgesPending';

function readPendingSessions(db) {
  try {
    const row = db.prepare('SELECT value FROM index_meta WHERE key = ?').get(SESSION_EDGES_PENDING_KEY);
    const parsed = row ? JSON.parse(row.value) : [];
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s) : [];
  } catch {
    return [];
  }
}

function isBusyError(err) {
  if (!err) return false;
  if (Number.isInteger(err.errcode) && ((err.errcode & 0xff) === 5 || (err.errcode & 0xff) === 6)) return true;
  const msg = `${err.message || ''} ${err.errstr || ''}`.toLowerCase();
  return msg.includes('database is locked') || msg.includes('database table is locked') || msg.includes('sqlite_busy');
}

const DOC_ROW_COLUMNS = 'id, path, mtime_ms, size, hash, content_hash, session, embed_status, embed_model, embed_attempts, embed_error, embed_service_failures';

function syncStatements(db) {
  return {
    ...upsertDocStatements(db),
    selectByPath: db.prepare(`SELECT ${DOC_ROW_COLUMNS} FROM docs WHERE path = ?`),
    selectById: db.prepare(`SELECT ${DOC_ROW_COLUMNS} FROM docs WHERE id = ?`),
    setMeta: db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)'),
    deleteMeta: db.prepare('DELETE FROM index_meta WHERE key = ?'),
  };
}

/**
 * Limits of a budgeted sync, or null when everything is to be indexed:
 * - `deadline` (epoch ms, read through `now()`): a changed file is only read when its estimated cost
 *   (`perFileMs + size / bytesPerMs`) fits in the time that is left;
 * - `maxFileBytes`: a larger file is deferred whatever time is left.
 */
function resolveSyncBudget(options) {
  const deadline = Number(options?.deadline);
  const maxFileBytes = Number(options?.maxFileBytes);
  const hasDeadline = options?.deadline !== undefined && options?.deadline !== null && Number.isFinite(deadline);
  const hasMaxBytes = Number.isFinite(maxFileBytes) && maxFileBytes > 0;
  if (!hasDeadline && !hasMaxBytes) return null;
  const bytesPerMs = Number(options?.bytesPerMs);
  const perFileMs = Number(options?.perFileMs);
  return {
    deadline: hasDeadline ? deadline : Infinity,
    maxFileBytes: hasMaxBytes ? maxFileBytes : Infinity,
    bytesPerMs: Number.isFinite(bytesPerMs) && bytesPerMs > 0 ? bytesPerMs : Infinity,
    perFileMs: Number.isFinite(perFileMs) && perFileMs > 0 ? perFileMs : 0,
    now: typeof options.now === 'function' ? options.now : Date.now,
  };
}

function budgetDeferReason(budget, size) {
  if (size > budget.maxFileBytes) return DEFER_REASON_TOO_LARGE;
  const remaining = budget.deadline - budget.now();
  if (remaining <= 0 || budget.perFileMs + size / budget.bytesPerMs > remaining) return DEFER_REASON_TIME_BUDGET;
  return '';
}

function errorText(err) {
  return String(err?.message || err || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * The sync as a sequence of steps: one step per changed file, each in its own `BEGIN IMMEDIATE`
 * transaction (the file is read and its row written under the index write lock, like every other writer),
 * then one closing transaction for deleted files, session chains and vector upkeep. The generator yields
 * after every file it handled, always outside a transaction, so a caller can stop or pause between files
 * without losing what was indexed so far.
 */
function* syncSteps(db, tierDir, options = {}) {
  const paths = ensureTierDirs(tierDir);
  const diskFiles = collectMarkdownFiles(paths.docsDir);
  const budget = resolveSyncBudget(options);
  const onFileIndexed = typeof options.onFileIndexed === 'function' ? options.onFileIndexed : null;

  let addedOrUpdated = 0;
  let statUpdated = 0;
  let deleted = 0;
  let orphanVectorsRemoved = 0;
  const duplicates = [];
  const deferred = []; // [{ path, size, reason }]
  const failed = []; // [{ path, size, reason: 'error', error }]
  let deferredWithoutRow = false;
  let indexBusy = false;

  // What the index held when this sync started. It only decides which files look unchanged; every write
  // below reads the row again inside its own transaction.
  const snapshot = new Map();
  for (const row of db.prepare('SELECT id, path, mtime_ms, size FROM docs').all()) {
    snapshot.set(row.path, row);
  }

  // After a decoder change, files whose (mtime, size) did not change are read once more. That pass is left
  // to a sync without limits: under a budget it would be started again by every run and use up the budget.
  // An index that holds no rows has nothing to read again, so it is marked current right away.
  const decoderRow = db.prepare("SELECT value FROM index_meta WHERE key = 'textDecoderVersion'").get();
  const decoderOutdated = decoderRow?.value !== TEXT_DECODER_VERSION;
  const rereadAll = decoderOutdated && !budget && snapshot.size > 0;

  const ctx = {
    root: paths.root,
    duplicates,
    seenIds: new Map(), // id -> winning relPath
    pendingSessions: new Set(readPendingSessions(db)),
    removedDocs: false,
  };
  const diskPaths = new Set();

  let stmts = null;
  const getStmts = () => {
    if (!stmts) stmts = syncStatements(db);
    return stmts;
  };

  const claimId = (id, relPath) => {
    if (!ctx.seenIds.has(id)) ctx.seenIds.set(id, relPath);
  };
  const defer = (relPath, size, reason, known) => {
    deferred.push({ path: relPath, size, reason });
    // A deferred file keeps the row it has (stale, but still the document); one without a row is unknown.
    if (known) claimId(known.id, relPath);
    else deferredWithoutRow = true;
  };

  // A sync with a deadline must not wait past it for a lock another process holds: before each of its
  // transactions the lock wait is cut down to the time that is left.
  let busyTimeoutChanged = false;
  const limitLockWait = () => {
    if (!budget || !Number.isFinite(budget.deadline)) return;
    const waitMs = Math.max(50, Math.min(DEFAULT_BUSY_TIMEOUT_MS, Math.floor(budget.deadline - budget.now())));
    db.exec(`PRAGMA busy_timeout = ${waitMs};`);
    busyTimeoutChanged = true;
  };

  try {
    for (const absPath of diskFiles) {
      let stat;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }

      const relPath = normalizeRelPath(path.relative(paths.root, absPath));
      diskPaths.add(relPath);
      const known = snapshot.get(relPath);

      if (known && !rereadAll && known.mtime_ms === stat.mtimeMs && known.size === stat.size) {
        if (ctx.seenIds.has(known.id)) {
          noteDuplicateDoc(duplicates, paths.root, known.id, relPath, ctx.seenIds.get(known.id));
        } else {
          ctx.seenIds.set(known.id, relPath);
        }
        continue;
      }

      // The file is new or changed: it has to be read. Decide from its size alone whether to do that now.
      if (indexBusy) {
        defer(relPath, stat.size, DEFER_REASON_INDEX_BUSY, known);
        continue;
      }
      if (budget) {
        const reason = budgetDeferReason(budget, stat.size);
        if (reason) {
          defer(relPath, stat.size, reason, known);
          continue;
        }
      }

      let result;
      try {
        limitLockWait();
        result = withTransaction(db, () => indexChangedFile(db, getStmts(), ctx, absPath, relPath));
      } catch (err) {
        if (isBusyError(err)) {
          if (!budget) throw err;
          indexBusy = true;
          defer(relPath, stat.size, DEFER_REASON_INDEX_BUSY, known);
          continue;
        }
        failed.push({ path: relPath, size: stat.size, reason: DEFER_REASON_ERROR, error: errorText(err) });
        if (known) claimId(known.id, relPath);
        continue;
      }

      if (result.claimId) ctx.seenIds.set(result.claimId, relPath);
      if (result.outcome === 'indexed') addedOrUpdated += 1;
      else if (result.outcome === 'stat') statUpdated += 1;
      else if (result.outcome === 'invalid') {
        failed.push({ path: relPath, size: stat.size, reason: DEFER_REASON_ERROR, error: 'no valid document id could be derived' });
      }

      if (onFileIndexed) onFileIndexed(relPath, result.outcome);
      yield { path: relPath, outcome: result.outcome };
      // While the caller paused, other work on this connection may have changed the schema (vector table).
      if (options.yielding) stmts = null;
    }

    // Closing work: rows of deleted files, session chains, orphan vectors, decoder version.
    // Rows that were in the index when the sync started and whose file is gone. (A row written since then
    // belongs to a file that exists.) A deferred file without a row may be a document that was moved: its
    // old row is kept until that file is read.
    const staleRows = deferredWithoutRow
      ? []
      : [...snapshot.values()]
        .filter((row) => !diskPaths.has(row.path) && !fs.existsSync(path.join(paths.root, row.path)));
    const needsOrphanSweep = vecEnabledDbs.has(db)
      && hasVectorTable(db)
      && (
        !orphanSweptDbPaths.has(paths.dbPath)
        || db.prepare('SELECT value FROM index_meta WHERE key = ?').get(VEC_CLEANUP_KEY)?.value === '1'
      );
    const bumpDecoder = decoderOutdated && (snapshot.size === 0 || rereadAll);

    // When the write lock was just found busy, the closing work waits for the next sync as well.
    if (!indexBusy && (staleRows.length > 0 || ctx.pendingSessions.size > 0 || needsOrphanSweep || bumpDecoder)) {
      try {
        limitLockWait();
        withTransaction(db, () => {
          const s = getStmts();
          for (const stale of staleRows) {
            const row = s.selectById.get(stale.id);
            // Checked again under the lock: the row may have moved, the file may have been written meanwhile.
            if (!row || row.path !== stale.path) continue;
            if (fs.existsSync(path.join(paths.root, row.path))) continue;
            removeDocRow(db, s, row, ctx);
            deleted += 1;
          }
          if (ctx.pendingSessions.size > 0) {
            rebuildSessionNextEdges(db, ctx.pendingSessions);
            s.deleteMeta.run(SESSION_EDGES_PENDING_KEY);
          }
          orphanVectorsRemoved = reconcileOrphanVectors(db, { removedDocs: ctx.removedDocs, dbPath: paths.dbPath });
          if (bumpDecoder) s.setMeta.run('textDecoderVersion', TEXT_DECODER_VERSION);
        });
        ctx.pendingSessions.clear();
      } catch (err) {
        // Under a budget the closing work is left to the next sync (the pending-session note stays stored).
        if (!budget || !isBusyError(err)) throw err;
      }
    }
  } finally {
    if (busyTimeoutChanged) {
      try {
        db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
      } catch {
        // the connection may already be closed
      }
    }
  }

  duplicateDocsByTier.set(paths.root, duplicates);
  writeDeferredIndex(paths.root, [...deferred, ...failed]);

  return {
    addedOrUpdated,
    statUpdated,
    deleted,
    ...(orphanVectorsRemoved > 0 ? { orphanVectorsRemoved } : {}),
    ...(deferred.length > 0 ? { deferred } : {}),
    ...(failed.length > 0 ? { failed } : {}),
  };
}

// Remove one document row with everything that hangs on it. Runs inside the caller's transaction.
function removeDocRow(db, s, row, ctx) {
  s.deleteDocById.run(row.id);
  s.deleteFtsById.run(row.id);
  if (s.deleteVecById) {
    s.deleteVecById.run(row.id);
  } else if (hasVectorTable(db)) {
    // No vector extension on this connection: leave the cleanup to one that has it.
    s.setMeta.run(VEC_CLEANUP_KEY, '1');
  }
  s.deleteAllDocEdges.run(row.id, row.id);
  ctx.removedDocs = true;
  markSessionsPending(s, ctx, [row.session]);
}

// Note, in the same transaction as the change itself, that these sessions need their chain rebuilt. The
// list is stored again with every change (not only when it grows): an earlier transaction that added a
// session may have been rolled back.
function markSessionsPending(s, ctx, sessions) {
  let any = false;
  for (const session of sessions) {
    if (!session) continue;
    ctx.pendingSessions.add(session);
    any = true;
  }
  if (any) s.setMeta.run(SESSION_EDGES_PENDING_KEY, JSON.stringify([...ctx.pendingSessions]));
}

/**
 * Read one new or changed file and bring its row up to date. Runs inside the caller's `BEGIN IMMEDIATE`
 * transaction, so the file content and the row it is compared with cannot change underneath.
 * Returns { outcome, claimId }: outcome is 'indexed' (row written), 'stat' (same content, only mtime/size
 * stored), 'unchanged', 'duplicate' (another file owns the id) or 'invalid' (no usable id).
 */
function indexChangedFile(db, s, ctx, absPath, relPath) {
  const stat = fs.statSync(absPath);
  // Undecodable bytes come back as lossy text (still indexable); a failed read is reported by the caller.
  const rawText = readDocFile(absPath).text;
  const existing = s.selectByPath.get(relPath) || null;

  if (existing && existing.hash === sha256(rawText)) {
    if (ctx.seenIds.has(existing.id) && ctx.seenIds.get(existing.id) !== relPath) {
      noteDuplicateDoc(ctx.duplicates, ctx.root, existing.id, relPath, ctx.seenIds.get(existing.id));
      return { outcome: 'duplicate', claimId: '' };
    }
    if (existing.mtime_ms !== stat.mtimeMs || existing.size !== stat.size) {
      s.updateStatOnly.run(stat.mtimeMs, stat.size, existing.id);
      return { outcome: 'stat', claimId: existing.id };
    }
    return { outcome: 'unchanged', claimId: existing.id };
  }

  const record = normalizeDocRecord(absPath, ctx.root, rawText, stat);
  if (!record) {
    if (existing) removeDocRow(db, s, existing, ctx);
    return { outcome: 'invalid', claimId: '' };
  }

  const docId = record.doc.id;
  if (ctx.seenIds.has(docId) && ctx.seenIds.get(docId) !== relPath) {
    noteDuplicateDoc(ctx.duplicates, ctx.root, docId, relPath, ctx.seenIds.get(docId));
    if (existing && existing.id !== docId) removeDocRow(db, s, existing, ctx);
    return { outcome: 'duplicate', claimId: '' };
  }

  const prevById = s.selectById.get(docId) || null;
  if (existing && existing.id !== docId) removeDocRow(db, s, existing, ctx);

  const prevForDoc = prevById || (existing?.id === docId ? existing : null);
  if (prevForDoc && prevForDoc.session !== record.doc.session) {
    s.deleteSessionNextForDoc.run(docId, docId);
  }
  writeDocAndEdges(s, record, prevForDoc);
  markSessionsPending(s, ctx, [existing?.session, prevById?.session, record.doc.session]);

  return { outcome: 'indexed', claimId: docId };
}

/**
 * Incrementally sync all Markdown files in <tierDir>/docs/ into SQLite.
 * Checks (mtime_ms, size) first, then SHA-256 hash; detects duplicate IDs; removes deleted files.
 * Every changed file is committed in its own `BEGIN IMMEDIATE` transaction (its content is read and its row
 * written under the index write lock), so a sync that is stopped or killed keeps the files it finished.
 * On a vector-enabled connection it also removes vector rows left behind by connections that could not;
 * the result then carries `orphanVectorsRemoved` (the key is absent when nothing was removed).
 *
 * Options (all optional; without `deadline` and `maxFileBytes` every changed file is indexed):
 * - `deadline` (epoch ms), `bytesPerMs`, `perFileMs`, `now`: time budget. Before a changed file is read, its
 *   size (from `stat`) is turned into an estimated cost (`perFileMs + size / bytesPerMs`); a file that does
 *   not fit in the time left is deferred. Files whose (mtime, size) did not change are never read under a
 *   budget.
 * - `maxFileBytes`: a changed file larger than this is deferred whatever time is left.
 * - `onFileIndexed(relPath, outcome)`: called after each file's transaction was committed.
 *
 * Deferred files are not excluded: they keep the row they have (a deferred file is never taken for a
 * deleted one) and the next sync without a budget indexes them. The result lists them as
 * `deferred: [{ path, size, reason }]`, files that could not be read or indexed as
 * `failed: [{ path, size, reason: 'error', error }]` (both keys are absent when empty), and the same lists
 * are stored in <tierDir>/state/deferred-index.json until a sync leaves nothing undone.
 */
export function syncFromDisk(db, tierDir, options = {}) {
  const steps = syncSteps(db, tierDir, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * The same sync for a long-lived process: it gives the event loop a turn after every file it indexed, so
 * requests that arrive meanwhile are answered between two files. `isCancelled()` is asked before each file;
 * a cancelled run resolves with `{ cancelled: true }` and keeps what it indexed.
 */
export async function syncFromDiskYielding(db, tierDir, options = {}) {
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false;
  const steps = syncSteps(db, tierDir, { ...options, yielding: true });
  try {
    for (;;) {
      if (isCancelled()) return { cancelled: true };
      const step = steps.next();
      if (step.done) return step.value;
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    steps.return();
  }
}
