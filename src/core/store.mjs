import fs from 'node:fs';
import path from 'node:path';
import {
  assertInsideDir,
  atomicWriteText,
  ensureTierDirs,
  formatIsoTimestamp,
  generateDocId,
  getGlobalDir,
  getProjectMemoryDir,
  getTierPaths,
  loadConfig,
  sanitizeRelFilePath,
  validateDocId,
} from './config.mjs';
import { parseMarkdownDoc, serializeMarkdownDoc } from './frontmatter.mjs';
import { openTierDb, syncFromDisk, syncSingleFile } from './db.mjs';
import { exploreGraph, getNeighbors } from './graph.mjs';

export const VALID_TYPES = new Set(['decision', 'worklog', 'knowledge', 'todo', 'baseline']);
export const VALID_STATUSES = new Set(['active', 'done', 'superseded', 'archived']);
const VALID_GLOBAL_CATEGORIES = new Set(['preferences', 'knowledge']);

function parseTagsJson(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeStringArray(val) {
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) {
    return [...new Set(val.map((v) => String(v).trim()).filter(Boolean))];
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function sanitizeFilesArray(val) {
  const items = normalizeStringArray(val);
  if (items === undefined) return undefined;
  const cleaned = [];
  for (const item of items) {
    const safe = sanitizeRelFilePath(item);
    if (!safe) {
      throw new Error(`Invalid relative file path "${item}": traversal, absolute paths, drive letters, and NUL bytes are not allowed`);
    }
    cleaned.push(safe);
  }
  return [...new Set(cleaned)];
}

function resolveDocAbsPath(tierDir, relPath) {
  const { root, docsDir } = getTierPaths(tierDir);
  const abs = path.resolve(root, relPath);
  return assertInsideDir(docsDir, abs);
}

export class CortexStore {
  constructor({
    projectDir = process.cwd(),
    globalDir,
    config,
    disableVec = false,
    onWrite = null,
  } = {}) {
    this.projectRoot = path.resolve(projectDir);
    this.projectDir = getProjectMemoryDir(this.projectRoot);
    this.globalDir = getGlobalDir(globalDir);
    this.config = config || loadConfig({ projectDir: this.projectRoot, globalDir: this.globalDir });
    this.disableVec = disableVec;
    this.onWrite = typeof onWrite === 'function' ? onWrite : null;
    this._tiers = new Map();
  }

  getTierDir(scope = 'project') {
    if (scope === 'global') return this.globalDir;
    if (scope === 'project') return this.projectDir;
    throw new Error(`Invalid scope "${scope}": expected "project" or "global"`);
  }

  getTier(scope = 'project') {
    if (scope !== 'project' && scope !== 'global') {
      throw new Error(`Invalid scope "${scope}": expected "project" or "global"`);
    }
    if (this._tiers.has(scope)) {
      return this._tiers.get(scope);
    }
    const dir = this.getTierDir(scope);
    ensureTierDirs(dir);
    const opened = openTierDb(dir, { disableVec: this.disableVec });
    const tier = {
      scope,
      dir,
      db: opened.db,
      vecAvailable: opened.vecAvailable,
      recovered: opened.recovered,
      dbPath: opened.dbPath,
    };
    this._tiers.set(scope, tier);
    return tier;
  }

  sync(scope = 'all') {
    const scopes = scope === 'all' ? ['project', 'global'] : [scope];
    const results = {};
    for (const s of scopes) {
      const tier = this.getTier(s);
      results[s] = syncFromDisk(tier.db, tier.dir);
    }
    return results;
  }

  close() {
    for (const tier of this._tiers.values()) {
      try {
        tier.db.close();
      } catch {
        // ignore close errors
      }
    }
    this._tiers.clear();
  }

  _notifyWrite(scope, docId) {
    if (this.onWrite) {
      try {
        this.onWrite({ scope, docId });
      } catch {
        // never break write path for async hooks
      }
    }
  }

  saveDoc(params = {}) {
    const scope = params.scope ?? 'project';
    if (scope !== 'project' && scope !== 'global') {
      throw new Error(`Invalid scope "${scope}": expected "project" or "global"`);
    }
    const type = String(params.type || 'knowledge').trim();
    if (!VALID_TYPES.has(type)) {
      throw new Error(`Invalid type "${type}": expected one of ${[...VALID_TYPES].join(', ')}`);
    }

    const status = String(params.status || 'active').trim();
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`Invalid status "${status}": expected one of ${[...VALID_STATUSES].join(', ')}`);
    }

    const title = String(params.title || '').trim();
    if (!title) {
      throw new Error('saveDoc requires a non-empty "title"');
    }

    const summary = String(params.summary || '').trim();
    if (!summary) {
      throw new Error('saveDoc requires a non-empty "summary"');
    }

    const now = new Date();
    const nowIso = formatIsoTimestamp(now);
    const id = params.id ? validateDocId(String(params.id).trim()) : generateDocId(type, title, now);

    const tier = this.getTier(scope);
    syncFromDisk(tier.db, tier.dir);

    const existing = tier.db.prepare('SELECT id, path FROM docs WHERE id = ?').get(id);
    if (existing) {
      throw new Error(`Document "${id}" already exists in scope "${scope}". Use updateDoc to modify it.`);
    }

    const tags = normalizeStringArray(params.tags) || [];
    const files = sanitizeFilesArray(params.files) || [];
    const derivedFrom = normalizeStringArray(params.derived_from);
    const supersedes = params.supersedes ? validateDocId(String(params.supersedes).trim()) : '';

    if (supersedes && supersedes === id) {
      throw new Error('A document cannot supersede itself');
    }

    // Determine target file path inside tier's docs/ directory
    const { docsDir } = getTierPaths(tier.dir);
    let subDir;
    if (scope === 'global') {
      const requestedCategory = String(params.category || '').trim().toLowerCase();
      const inferredPref = tags.some((t) => t.toLowerCase() === 'preference' || t.toLowerCase() === 'preferences');
      const category = VALID_GLOBAL_CATEGORIES.has(requestedCategory)
        ? requestedCategory
        : inferredPref
          ? 'preferences'
          : 'knowledge';
      subDir = path.join(docsDir, category);
    } else {
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      subDir = path.join(docsDir, ym);
    }

    const targetPath = assertInsideDir(docsDir, path.join(subDir, `${id}.md`));
    if (fs.existsSync(targetPath)) {
      throw new Error(`Target file "${path.basename(targetPath)}" already exists on disk. Use updateDoc or choose a unique id.`);
    }

    const frontmatter = {
      id,
      type,
      title,
      summary,
      status,
      ...(params.session ? { session: String(params.session).trim() } : {}),
      ...(params.branch ? { branch: String(params.branch).trim() } : {}),
      tags,
      ...(files.length > 0 ? { files } : {}),
      ...(supersedes ? { supersedes } : {}),
      ...(derivedFrom && derivedFrom.length > 0 ? { derived_from: derivedFrom } : {}),
      ...(params.due ? { due: String(params.due).trim() } : {}),
      created_at: nowIso,
      updated_at: nowIso,
    };

    const body = String(params.content ?? '');
    const markdown = serializeMarkdownDoc(frontmatter, body);
    atomicWriteText(targetPath, markdown);

    // Transition superseded doc atomically while preserving its body
    let supersededDoc = null;
    if (supersedes) {
      const oldRow = tier.db.prepare('SELECT id, path FROM docs WHERE id = ?').get(supersedes);
      if (oldRow) {
        const oldAbs = resolveDocAbsPath(tier.dir, oldRow.path);
        if (fs.existsSync(oldAbs)) {
          const oldRaw = fs.readFileSync(oldAbs, 'utf8');
          const parsedOld = parseMarkdownDoc(oldRaw);
          const updatedOldFm = {
            ...parsedOld.frontmatter,
            id: parsedOld.frontmatter.id || oldRow.id,
            status: 'superseded',
            updated_at: nowIso,
          };
          atomicWriteText(oldAbs, serializeMarkdownDoc(updatedOldFm, parsedOld.body));
          syncSingleFile(tier.db, tier.dir, oldAbs);
          supersededDoc = oldRow.id;
        }
      }
    }

    const indexed = syncSingleFile(tier.db, tier.dir, targetPath);
    this._notifyWrite(scope, id);

    return {
      id,
      scope,
      path: indexed.path,
      type: indexed.type,
      status: indexed.status,
      title: indexed.title,
      summary: indexed.summary,
      session: indexed.session,
      branch: indexed.branch,
      tags,
      files,
      supersedes: supersedes || null,
      supersededTransitioned: supersededDoc,
      created_at: indexed.created_at,
      updated_at: indexed.updated_at,
      embed_status: 'pending',
    };
  }

  updateDoc(params = {}) {
    const id = validateDocId(String(params.id || '').trim());
    const requestedScope = params.scope || 'all';
    const candidateScopes = requestedScope === 'all' ? ['project', 'global'] : [requestedScope];

    let foundTier = null;
    let foundRow = null;
    for (const s of candidateScopes) {
      const tier = this.getTier(s);
      syncFromDisk(tier.db, tier.dir);
      const row = tier.db.prepare('SELECT id, path FROM docs WHERE id = ?').get(id);
      if (row) {
        foundTier = tier;
        foundRow = row;
        break;
      }
    }

    if (!foundTier || !foundRow) {
      throw new Error(`Document "${id}" not found in scope "${requestedScope}"`);
    }

    if (params.status !== undefined && !VALID_STATUSES.has(String(params.status).trim())) {
      throw new Error(`Invalid status "${params.status}": expected one of ${[...VALID_STATUSES].join(', ')}`);
    }
    if (params.type !== undefined && !VALID_TYPES.has(String(params.type).trim())) {
      throw new Error(`Invalid type "${params.type}": expected one of ${[...VALID_TYPES].join(', ')}`);
    }

    const absPath = resolveDocAbsPath(foundTier.dir, foundRow.path);
    const raw = fs.readFileSync(absPath, 'utf8');
    const parsed = parseMarkdownDoc(raw);
    const fm = { ...parsed.frontmatter, id: parsed.frontmatter.id || id };

    if (params.type !== undefined) fm.type = String(params.type).trim();
    if (params.status !== undefined) fm.status = String(params.status).trim();
    if (params.title !== undefined) fm.title = String(params.title).trim();
    if (params.summary !== undefined) fm.summary = String(params.summary).trim();
    if (params.session !== undefined) fm.session = String(params.session).trim();
    if (params.branch !== undefined) fm.branch = String(params.branch).trim();
    if (params.due !== undefined) fm.due = String(params.due).trim();
    if (params.tags !== undefined) fm.tags = normalizeStringArray(params.tags) || [];
    if (params.files !== undefined) {
      fm.files = sanitizeFilesArray(params.files) || [];
    }
    if (params.derived_from !== undefined) {
      fm.derived_from = normalizeStringArray(params.derived_from) || [];
    }

    const nowIso = formatIsoTimestamp();
    fm.updated_at = nowIso;

    let body = parsed.body;
    if (params.content !== undefined) {
      body = String(params.content);
    } else if (params.append_content !== undefined && String(params.append_content).length > 0) {
      const appendText = String(params.append_content);
      body = body.trimEnd() ? `${body.trimEnd()}\n\n${appendText}` : appendText;
    }

    atomicWriteText(absPath, serializeMarkdownDoc(fm, body));
    const indexed = syncSingleFile(foundTier.db, foundTier.dir, absPath);
    this._notifyWrite(foundTier.scope, id);

    return {
      id: indexed.id,
      scope: foundTier.scope,
      path: indexed.path,
      type: indexed.type,
      status: indexed.status,
      title: indexed.title,
      summary: indexed.summary,
      session: indexed.session,
      branch: indexed.branch,
      tags: parseTagsJson(indexed.tagsJson),
      updated_at: indexed.updated_at,
      embed_status: 'pending',
    };
  }

  readDoc({ id, scope = 'all', include_neighbors = false } = {}) {
    const cleanId = validateDocId(String(id || '').trim());
    const candidateScopes = scope === 'all' ? ['project', 'global'] : [scope];

    for (const s of candidateScopes) {
      const tier = this.getTier(s);
      syncFromDisk(tier.db, tier.dir);
      const row = tier.db.prepare('SELECT * FROM docs WHERE id = ?').get(cleanId);
      if (!row) continue;

      // Read frontmatter extras (files, supersedes, derived_from) from disk if available
      let extraFm = {};
      try {
        const absPath = resolveDocAbsPath(tier.dir, row.path);
        if (fs.existsSync(absPath)) {
          extraFm = parseMarkdownDoc(fs.readFileSync(absPath, 'utf8')).frontmatter;
        }
      } catch {
        // DB content still authoritative fallback
      }

      const result = {
        id: row.id,
        scope: s,
        path: row.path,
        type: row.type,
        status: row.status,
        session: row.session,
        branch: row.branch,
        title: row.title,
        summary: row.summary,
        tags: parseTagsJson(row.tags),
        files: normalizeStringArray(extraFm.files) || [],
        supersedes: extraFm.supersedes || '',
        derived_from: normalizeStringArray(extraFm.derived_from) || [],
        due: row.due,
        created_at: row.created_at,
        updated_at: row.updated_at,
        embed_status: row.embed_status,
        embed_model: row.embed_model,
        content: row.content,
      };

      if (include_neighbors) {
        result.neighbors = getNeighbors(tier.db, row.id, { direction: 'both', limit: 30 });
      }

      return result;
    }

    return null;
  }

  exploreGraph({ target, scope = 'project', depth = 2, direction = 'both', limit = 60 } = {}) {
    const scopes = scope === 'all' ? ['project', 'global'] : [scope];
    if (scopes.length === 1) {
      const tier = this.getTier(scopes[0]);
      syncFromDisk(tier.db, tier.dir);
      return {
        scope: scopes[0],
        ...exploreGraph(tier.db, { target, depth, direction, limit }),
      };
    }

    const nodeMap = new Map();
    const edgeMap = new Map();
    let normalizedTarget = target;

    for (const s of scopes) {
      const tier = this.getTier(s);
      syncFromDisk(tier.db, tier.dir);
      const res = exploreGraph(tier.db, { target, depth, direction, limit });
      normalizedTarget = res.target;
      for (const node of res.nodes) {
        const prev = nodeMap.get(node.id);
        if (!prev || (!prev.exists && node.exists) || node.hop < prev.hop) {
          nodeMap.set(node.id, { ...node, scope: node.exists ? s : prev?.scope });
        }
      }
      for (const edge of res.edges) {
        const key = `${edge.src}|${edge.dst}|${edge.kind}`;
        if (!edgeMap.has(key)) edgeMap.set(key, edge);
      }
    }

    return {
      scope: 'all',
      target: normalizedTarget,
      depth,
      direction,
      nodes: [...nodeMap.values()].sort((a, b) => a.hop - b.hop || a.id.localeCompare(b.id)),
      edges: [...edgeMap.values()],
    };
  }

  getOverview({ session = '', includeGlobal = true } = {}) {
    const projectTier = this.getTier('project');
    syncFromDisk(projectTier.db, projectTier.dir);

    const sessionFilter = String(session || '').trim();
    const whereSession = sessionFilter ? ' AND session = ?' : '';
    const sessionParams = sessionFilter ? [sessionFilter] : [];

    // 1. Active sessions & branches
    const sessionRows = projectTier.db
      .prepare(`
        SELECT session, branch, COUNT(*) AS doc_count, MAX(updated_at) AS latest_updated_at
        FROM docs
        WHERE status = 'active' AND session != '' ${whereSession}
        GROUP BY session, branch
        ORDER BY latest_updated_at DESC
      `)
      .all(...sessionParams);

    const sessionsMap = new Map();
    for (const r of sessionRows) {
      let entry = sessionsMap.get(r.session);
      if (!entry) {
        entry = {
          session: r.session,
          branches: [],
          docCount: 0,
          latestUpdatedAt: r.latest_updated_at,
        };
        sessionsMap.set(r.session, entry);
      }
      if (r.branch && !entry.branches.includes(r.branch)) {
        entry.branches.push(r.branch);
      }
      entry.docCount += Number(r.doc_count) || 0;
      if (r.latest_updated_at > entry.latestUpdatedAt) {
        entry.latestUpdatedAt = r.latest_updated_at;
      }
    }

    // 2. Active todos
    const todos = projectTier.db
      .prepare(`
        SELECT id, title, summary, session, branch, due, tags, updated_at
        FROM docs
        WHERE status = 'active' AND type = 'todo' ${whereSession}
        ORDER BY CASE WHEN due != '' THEN 0 ELSE 1 END, due ASC, updated_at DESC
        LIMIT 30
      `)
      .all(...sessionParams)
      .map((r) => ({ ...r, tags: parseTagsJson(r.tags) }));

    // 3. Recent active decisions & baselines
    const decisions = projectTier.db
      .prepare(`
        SELECT id, type, title, summary, session, branch, tags, updated_at
        FROM docs
        WHERE status = 'active' AND type IN ('decision', 'baseline') ${whereSession}
        ORDER BY updated_at DESC
        LIMIT 30
      `)
      .all(...sessionParams)
      .map((r) => ({ ...r, tags: parseTagsJson(r.tags) }));

    // 4. Recent active worklogs & knowledge
    const recentWork = projectTier.db
      .prepare(`
        SELECT id, type, title, summary, session, branch, tags, updated_at
        FROM docs
        WHERE status = 'active' AND type IN ('worklog', 'knowledge') ${whereSession}
        ORDER BY updated_at DESC
        LIMIT 20
      `)
      .all(...sessionParams)
      .map((r) => ({ ...r, tags: parseTagsJson(r.tags) }));

    const projectStats = projectTier.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN embed_status = 'pending' THEN 1 ELSE 0 END) AS pending
        FROM docs
      `)
      .get();

    // 5. Global preferences & knowledge
    let globalPreferences = [];
    let globalStats = { total: 0, active: 0, pending: 0 };

    if (includeGlobal) {
      const globalTier = this.getTier('global');
      syncFromDisk(globalTier.db, globalTier.dir);

      globalPreferences = globalTier.db
        .prepare(`
          SELECT id, path, type, title, summary, tags, updated_at
          FROM docs
          WHERE status = 'active'
          ORDER BY CASE WHEN path LIKE 'docs/preferences/%' THEN 0 ELSE 1 END, updated_at DESC
          LIMIT 25
        `)
        .all()
        .map((r) => ({
          id: r.id,
          type: r.type,
          category: r.path.startsWith('docs/preferences/') ? 'preferences' : 'knowledge',
          title: r.title,
          summary: r.summary,
          tags: parseTagsJson(r.tags),
          updated_at: r.updated_at,
        }));

      globalStats = globalTier.db
        .prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN embed_status = 'pending' THEN 1 ELSE 0 END) AS pending
          FROM docs
        `)
        .get();
    }

    return {
      sessionFilter: sessionFilter || null,
      sessions: [...sessionsMap.values()],
      todos,
      decisions,
      recentWork,
      globalPreferences,
      stats: {
        projectDocs: Number(projectStats?.total) || 0,
        projectActiveDocs: Number(projectStats?.active) || 0,
        globalDocs: Number(globalStats?.total) || 0,
        globalActiveDocs: Number(globalStats?.active) || 0,
        pendingEmbeddings:
          (Number(projectStats?.pending) || 0) + (Number(globalStats?.pending) || 0),
      },
    };
  }
}
