import fs from 'node:fs';
import path from 'node:path';
import {
  assertInsideDir,
  atomicWriteText,
  ensureMemoryGitignore,
  ensureTierDirs,
  formatIsoTimestamp,
  generateDocId,
  getGlobalDir,
  getProjectMemoryDir,
  getTierPaths,
  isProjectEnabled as checkProjectEnabled,
  isProjectTrusted as checkProjectTrusted,
  loadConfig,
  sanitizeRelFilePath,
  validateDocId,
} from './config.mjs';
import { ProjectNotApprovedError } from './trust.mjs';
import { decodeDocBytes } from './encoding.mjs';
import {
  UnsafeUpdateError,
  parseMarkdownDoc,
  parseMarkdownDocDetailed,
  renderUpdatedMarkdownDoc,
  serializeMarkdownDoc,
} from './frontmatter.mjs';
import { indexSingleFile, openTierDb, readDocFile, syncFromDisk, withTransaction } from './db.mjs';
import { exploreGraph, getNeighbors, normalizeGraphTarget } from './graph.mjs';

export { ProjectNotApprovedError, UnsafeUpdateError };

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

function sanitizeFilesArray(val, projectRoot = null) {
  const items = normalizeStringArray(val);
  if (items === undefined) return undefined;
  const cleaned = [];
  for (const item of items) {
    const safe = sanitizeRelFilePath(item, projectRoot);
    if (!safe) {
      throw new Error(`Invalid relative file path "${item}": traversal, external absolute paths, drive letters, and NUL bytes are not allowed`);
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

let lastIssuedTimestampMs = 0;

/**
 * Current time as a Date that is strictly later than any Date this function returned earlier in this
 * process, so two documents saved back-to-back never share a millisecond timestamp.
 */
function nextTimestampDate() {
  const ms = Math.max(Date.now(), lastIssuedTimestampMs + 1);
  lastIssuedTimestampMs = ms;
  return new Date(ms);
}

/**
 * Read a document and compute its rewritten text without touching the disk.
 * `mutate(parsed)` receives the parsed document and returns the new { frontmatter, body }.
 * Returns { absPath, originalBytes, text }.
 * Throws `UnsafeUpdateError` when the file cannot be rewritten without risking loss of content:
 * its text encoding cannot be determined, or its frontmatter would not survive the rewrite.
 */
function planDocRewrite(absPath, relPath, mutate) {
  const refuse = (reason) => new UnsafeUpdateError(
    `UNSAFE_UPDATE: "${relPath}" was not modified because ${reason}. Fix the file by hand (for example re-save it as UTF-8, or simplify its frontmatter) and try again.`,
  );

  const originalBytes = fs.readFileSync(absPath);
  const decoded = decodeDocBytes(originalBytes);
  if (!decoded.safe) throw refuse(decoded.reason);

  const parsed = parseMarkdownDocDetailed(decoded.text);
  const { frontmatter, body } = mutate(parsed);
  try {
    return { absPath, originalBytes, text: renderUpdatedMarkdownDoc(parsed, frontmatter, body) };
  } catch (err) {
    if (err instanceof UnsafeUpdateError) throw refuse(err.reason);
    throw err;
  }
}

function restoreOriginalFile(plan) {
  try {
    fs.writeFileSync(plan.absPath, plan.originalBytes);
  } catch {
    // best effort: the caller is already reporting the original failure
  }
}

function removeFileQuietly(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup failure
  }
}

export class CortexStore {
  constructor({
    projectDir = process.cwd(),
    globalDir,
    config,
    globalConfig,
    disableVec = false,
    onWrite = null,
  } = {}) {
    this.projectRoot = path.resolve(projectDir);
    this.projectDir = getProjectMemoryDir(this.projectRoot);
    this.globalDir = getGlobalDir(globalDir);
    this.config = config || loadConfig({ projectDir: this.projectRoot, globalDir: this.globalDir });
    this._globalConfig = globalConfig || null;
    this.disableVec = disableVec;
    this.onWrite = typeof onWrite === 'function' ? onWrite : null;
    this._tiers = new Map();
  }

  /**
   * The global configuration without any per-project overlay (no `projects["<path>"]` entry, no project
   * file). The global tier is shared by every project, so its embedding always follows these settings;
   * `config` (which includes this project's overlay) applies to the project tier only. Loaded on first use.
   */
  get globalConfig() {
    if (!this._globalConfig) {
      this._globalConfig = loadConfig({ globalDir: this.globalDir });
    }
    return this._globalConfig;
  }

  isProjectEnabled() {
    return checkProjectEnabled(this.projectRoot, this.config);
  }

  /**
   * True when the user approved this project folder. Read from the approval list on every call, so an
   * approval or a revocation made while this process runs takes effect on the next operation.
   */
  isProjectTrusted() {
    return checkProjectTrusted(this.projectRoot, { globalDir: this.globalDir });
  }

  getTierDir(scope = 'project') {
    if (scope === 'global') return this.globalDir;
    if (scope === 'project') return this.projectDir;
    throw new Error(`Invalid scope "${scope}": expected "project" or "global"`);
  }

  getTier(scope = 'project', { create = true } = {}) {
    if (scope !== 'project' && scope !== 'global') {
      throw new Error(`Invalid scope "${scope}": expected "project" or "global"`);
    }
    if (scope === 'project' && !this.isProjectEnabled()) {
      if (!create) return null;
      throw new Error(`Project memory is disabled for "${this.projectRoot}" by cortex config`);
    }
    // The project tier of a folder the user has not approved is never opened, read or created. This is the
    // single choke point every reader and writer goes through (tools, hooks, search, embedding queue).
    if (scope === 'project' && !this.isProjectTrusted()) {
      if (!create) return null;
      throw new ProjectNotApprovedError(this.projectRoot);
    }
    if (this._tiers.has(scope)) {
      return this._tiers.get(scope);
    }

    const dir = this.getTierDir(scope);
    const paths = getTierPaths(dir);
    if (!create) {
      const existsOnDisk = fs.existsSync(paths.dbPath) || fs.existsSync(paths.docsDir);
      if (!existsOnDisk) {
        return null;
      }
    }

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

  getTierIfExists(scope = 'project') {
    return this.getTier(scope, { create: false });
  }

  sync(scope = 'all') {
    const scopes = scope === 'all' ? ['project', 'global'] : [scope];
    const results = {};
    for (const s of scopes) {
      const tier = this.getTierIfExists(s);
      if (!tier) {
        results[s] = { addedOrUpdated: 0, statUpdated: 0, deleted: 0 };
        continue;
      }
      results[s] = syncFromDisk(tier.db, tier.dir);
    }
    return results;
  }

  // A write into the project tier keeps `.memory/` out of git unless the folder already has its own .gitignore.
  _prepareTierForWrite(tier) {
    if (tier.scope === 'project') ensureMemoryGitignore(tier.dir);
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

    const now = nextTimestampDate();
    const nowIso = formatIsoTimestamp(now);
    const id = params.id ? validateDocId(String(params.id).trim()) : generateDocId(type, title, now);

    const tier = this.getTier(scope, { create: true });
    this._prepareTierForWrite(tier);
    syncFromDisk(tier.db, tier.dir);

    const existing = tier.db.prepare('SELECT id, path FROM docs WHERE id = ?').get(id);
    if (existing) {
      throw new Error(`Document "${id}" already exists in scope "${scope}". Use updateDoc to modify it.`);
    }

    const tags = normalizeStringArray(params.tags) || [];
    const files = sanitizeFilesArray(params.files, this.projectRoot) || [];
    const derivedFrom = normalizeStringArray(params.derived_from) || [];
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
      ...(derivedFrom.length > 0 ? { derived_from: derivedFrom } : {}),
      ...(params.due ? { due: String(params.due).trim() } : {}),
      created_at: nowIso,
      updated_at: nowIso,
    };

    const body = String(params.content ?? '');
    const markdown = serializeMarkdownDoc(frontmatter, body);

    // Create the new file, rewrite the superseded document and index both under the tier's write lock
    // (BEGIN IMMEDIATE), so another process cannot interleave its own read-modify-write of those files.
    let indexed = null;
    let transition = { plan: null, transitioned: null, notFound: null };
    withTransaction(tier.db, () => {
      if (tier.db.prepare('SELECT id FROM docs WHERE id = ?').get(id)) {
        throw new Error(`Document "${id}" already exists in scope "${scope}". Use updateDoc to modify it.`);
      }
      if (fs.existsSync(targetPath)) {
        throw new Error(`Target file "${path.basename(targetPath)}" already exists on disk. Use updateDoc or choose a unique id.`);
      }
      if (supersedes) {
        transition = this._planSupersedeTransition(tier, supersedes, nowIso);
      }

      let supersededWritten = false;
      try {
        atomicWriteText(targetPath, markdown);
        if (transition.plan) {
          atomicWriteText(transition.plan.absPath, transition.plan.text);
          supersededWritten = true;
          indexSingleFile(tier.db, tier.dir, transition.plan.absPath);
        }
        indexed = indexSingleFile(tier.db, tier.dir, targetPath);
      } catch (err) {
        // Leave the disk as it was: drop the new file and put the superseded document back.
        removeFileQuietly(targetPath);
        if (supersededWritten) restoreOriginalFile(transition.plan);
        throw err;
      }
    });

    const supersedesWarning = supersedes ? this._supersedeWarning(scope, supersedes, transition.notFound) : null;
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
      derived_from: derivedFrom,
      supersedes: supersedes || null,
      supersededTransitioned: transition.transitioned,
      ...(supersedesWarning ? { supersedesWarning } : {}),
      created_at: indexed.created_at,
      updated_at: indexed.updated_at,
      embed_status: indexed.embed_status || 'pending',
    };
  }

  /**
   * Prepare the transition of document `supersedesId` to status "superseded" (shared by saveDoc and
   * updateDoc). Must be called inside the tier's write transaction; nothing is written here.
   * Returns { plan, transitioned, notFound }:
   * - plan: pending rewrite of the old document (see `planDocRewrite`), or null
   * - transitioned: id of the document that will be transitioned, or null
   * - notFound: 'row' (no such document in this tier), 'file' (indexed but missing on disk), or null
   * Throws `UnsafeUpdateError` when the old document cannot be rewritten without losing content.
   */
  _planSupersedeTransition(tier, supersedesId, nowIso) {
    const oldRow = tier.db.prepare('SELECT id, path FROM docs WHERE id = ?').get(supersedesId);
    if (!oldRow) {
      return { plan: null, transitioned: null, notFound: 'row' };
    }
    const oldAbs = resolveDocAbsPath(tier.dir, oldRow.path);
    if (!fs.existsSync(oldAbs)) {
      return { plan: null, transitioned: null, notFound: 'file' };
    }
    const plan = planDocRewrite(oldAbs, oldRow.path, (parsed) => ({
      frontmatter: {
        ...parsed.frontmatter,
        id: parsed.frontmatter.id || oldRow.id,
        status: 'superseded',
        updated_at: nowIso,
      },
      body: parsed.body,
    }));
    return { plan, transitioned: oldRow.id, notFound: null };
  }

  /**
   * Warning text for a supersede target that could not be transitioned, or null.
   * Looks into the other scope, so it must run outside the tier's write transaction.
   */
  _supersedeWarning(scope, supersedesId, notFound) {
    if (notFound === 'file') {
      return `Target "${supersedesId}" file missing on disk in "${scope}" scope; not transitioned.`;
    }
    if (notFound !== 'row') return null;

    const otherScope = scope === 'project' ? 'global' : 'project';
    const otherTier = this.getTierIfExists(otherScope);
    let foundInOther = false;
    if (otherTier) {
      syncFromDisk(otherTier.db, otherTier.dir);
      foundInOther = Boolean(otherTier.db.prepare('SELECT id FROM docs WHERE id = ?').get(supersedesId));
    }
    return foundInOther
      ? `Target "${supersedesId}" exists in "${otherScope}" scope, not "${scope}"; not transitioned.`
      : `Target "${supersedesId}" not found in "${scope}" scope; not transitioned.`;
  }

  updateDoc(params = {}) {
    const id = validateDocId(String(params.id || '').trim());
    const requestedScope = params.scope || 'all';
    const candidateScopes = requestedScope === 'all' ? ['project', 'global'] : [requestedScope];

    let foundTier = null;
    let foundRow = null;
    for (const s of candidateScopes) {
      const tier = this.getTierIfExists(s);
      if (!tier) continue;
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

    // `supersedes: ""` clears the link; a non-empty value records it and transitions the target.
    const supersedesGiven = params.supersedes !== undefined && params.supersedes !== null;
    const supersedes = supersedesGiven ? String(params.supersedes).trim() : '';
    if (supersedes) {
      validateDocId(supersedes);
      if (supersedes === id) {
        throw new Error('A document cannot supersede itself');
      }
    }

    const absPath = resolveDocAbsPath(foundTier.dir, foundRow.path);
    const nowIso = formatIsoTimestamp(nextTimestampDate());
    this._prepareTierForWrite(foundTier);

    const applyUpdate = (parsed) => {
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
        fm.files = sanitizeFilesArray(params.files, this.projectRoot) || [];
      }
      if (params.derived_from !== undefined) {
        fm.derived_from = normalizeStringArray(params.derived_from) || [];
      }
      if (supersedesGiven) fm.supersedes = supersedes;

      fm.updated_at = nowIso;

      let body = parsed.body;
      if (params.content !== undefined) {
        body = String(params.content);
      } else if (params.append_content !== undefined && String(params.append_content).length > 0) {
        const appendText = String(params.append_content);
        body = body.trimEnd() ? `${body.trimEnd()}\n\n${appendText}` : appendText;
      }
      return { frontmatter: fm, body };
    };

    // Read, modify and write the file under the tier's write lock (BEGIN IMMEDIATE). Every writer
    // takes the same lock, so two processes updating one document cannot lose each other's change.
    // Both rewrites are computed before anything is written: a refusal leaves the disk untouched.
    let indexed = null;
    let transition = { plan: null, transitioned: null, notFound: null };
    withTransaction(foundTier.db, () => {
      const plan = planDocRewrite(absPath, foundRow.path, applyUpdate);
      if (supersedes) {
        transition = this._planSupersedeTransition(foundTier, supersedes, nowIso);
      }

      atomicWriteText(plan.absPath, plan.text);
      if (transition.plan) {
        try {
          atomicWriteText(transition.plan.absPath, transition.plan.text);
        } catch (err) {
          restoreOriginalFile(plan);
          throw err;
        }
        indexSingleFile(foundTier.db, foundTier.dir, transition.plan.absPath);
      }
      indexed = indexSingleFile(foundTier.db, foundTier.dir, plan.absPath);
    });

    const supersedesWarning = supersedes
      ? this._supersedeWarning(foundTier.scope, supersedes, transition.notFound)
      : null;
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
      ...(supersedes
        ? {
            supersedes,
            supersededTransitioned: transition.transitioned,
            ...(supersedesWarning ? { supersedesWarning } : {}),
          }
        : {}),
      updated_at: indexed.updated_at,
      embed_status: indexed.embed_status || 'pending',
    };
  }

  readDoc({ id, scope = 'all', include_neighbors = false } = {}) {
    const cleanId = validateDocId(String(id || '').trim());
    const candidateScopes = scope === 'all' ? ['project', 'global'] : [scope];

    for (const s of candidateScopes) {
      const tier = this.getTierIfExists(s);
      if (!tier) continue;
      syncFromDisk(tier.db, tier.dir);
      const row = tier.db.prepare('SELECT * FROM docs WHERE id = ?').get(cleanId);
      if (!row) continue;

      // Read frontmatter extras (files, supersedes, derived_from) from disk if available
      let extraFm = {};
      try {
        const absPath = resolveDocAbsPath(tier.dir, row.path);
        if (fs.existsSync(absPath)) {
          extraFm = parseMarkdownDoc(readDocFile(absPath).text).frontmatter;
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
        supersedes: extraFm.supersedes ? String(extraFm.supersedes) : '',
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
    const maxDepth = Math.max(1, Math.min(10, Number(depth) || 2));
    const maxEdges = Math.max(1, Math.min(500, Number(limit) || 60));
    const dir = direction === 'in' || direction === 'out' ? direction : 'both';
    const normalizedTarget = normalizeGraphTarget(target);
    if (!normalizedTarget) {
      throw new Error('exploreGraph requires a non-empty target');
    }

    const scopes = scope === 'all' ? ['project', 'global'] : [scope];
    if (scopes.length === 1) {
      const tier = this.getTierIfExists(scopes[0]);
      if (!tier) {
        return {
          scope: scopes[0],
          target: normalizedTarget,
          depth: maxDepth,
          direction: dir,
          nodes: [],
          edges: [],
        };
      }
      syncFromDisk(tier.db, tier.dir);
      return {
        scope: scopes[0],
        ...exploreGraph(tier.db, { target: normalizedTarget, depth: maxDepth, direction: dir, limit: maxEdges }),
      };
    }

    const nodeMap = new Map();
    const edgeMap = new Map();

    for (const s of scopes) {
      const tier = this.getTierIfExists(s);
      if (!tier) continue;
      syncFromDisk(tier.db, tier.dir);
      const res = exploreGraph(tier.db, { target: normalizedTarget, depth: maxDepth, direction: dir, limit: maxEdges });
      for (const node of res.nodes) {
        const prev = nodeMap.get(node.id);
        if (!prev) {
          nodeMap.set(node.id, { ...node, ...(node.exists ? { scope: s } : {}) });
        } else {
          const minHop = Math.min(prev.hop, node.hop);
          // NEVER allow `exists: false` to overwrite `exists: true`
          if (!prev.exists && node.exists) {
            nodeMap.set(node.id, { ...node, hop: minHop, scope: s });
          } else {
            nodeMap.set(node.id, { ...prev, hop: minHop });
          }
        }
      }
      for (const edge of res.edges) {
        const key = `${edge.src}\0${edge.dst}\0${edge.kind}`;
        const prevEdge = edgeMap.get(key);
        if (!prevEdge || edge.hop < prevEdge.hop) {
          edgeMap.set(key, edge);
        }
      }
    }

    // Enforce limit after cross-tier merge
    const mergedEdges = [...edgeMap.values()]
      .sort((a, b) => a.hop - b.hop || b.weight - a.weight || a.kind.localeCompare(b.kind))
      .slice(0, maxEdges);

    const activeNodeIds = new Set([normalizedTarget]);
    for (const edge of mergedEdges) {
      activeNodeIds.add(edge.src);
      activeNodeIds.add(edge.dst);
    }

    const mergedNodes = [...nodeMap.values()]
      .filter((n) => activeNodeIds.has(n.id))
      .sort((a, b) => a.hop - b.hop || a.id.localeCompare(b.id));

    return {
      scope: 'all',
      target: normalizedTarget,
      depth: maxDepth,
      direction: dir,
      nodes: mergedNodes,
      edges: mergedEdges,
    };
  }

  getOverview({ session = '', includeGlobal = true } = {}) {
    const projectTier = this.getTierIfExists('project');
    const sessionFilter = String(session || '').trim();
    const whereSession = sessionFilter ? ' AND session = ?' : '';
    const sessionParams = sessionFilter ? [sessionFilter] : [];

    const sessionsMap = new Map();
    let p0Baselines = [];
    let todos = [];
    let decisions = [];
    let recentWork = [];
    let projectStats = { total: 0, active: 0, embed_ready: 0, embed_pending: 0, embed_error: 0 };
    let projectLastError = null;

    if (projectTier) {
      syncFromDisk(projectTier.db, projectTier.dir);

      // 0. Active P0 baselines (queried separately so 30 newer decisions never push them out)
      p0Baselines = projectTier.db
        .prepare(`
          SELECT id, type, title, summary, session, branch, tags, updated_at
          FROM docs
          WHERE status = 'active' AND type = 'baseline' AND LOWER(branch) = 'p0' ${whereSession}
          ORDER BY updated_at DESC
          LIMIT 10
        `)
        .all(...sessionParams)
        .map((r) => ({ ...r, tags: parseTagsJson(r.tags) }));

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
      todos = projectTier.db
        .prepare(`
          SELECT id, title, summary, session, branch, due, tags, updated_at
          FROM docs
          WHERE status = 'active' AND type = 'todo' ${whereSession}
          ORDER BY CASE WHEN due != '' THEN 0 ELSE 1 END, due ASC, updated_at DESC
          LIMIT 30
        `)
        .all(...sessionParams)
        .map((r) => ({ ...r, tags: parseTagsJson(r.tags) }));

      // 3. Recent active decisions & non-P0 baselines
      decisions = projectTier.db
        .prepare(`
          SELECT id, type, title, summary, session, branch, tags, updated_at
          FROM docs
          WHERE status = 'active'
            AND type IN ('decision', 'baseline')
            AND NOT (type = 'baseline' AND LOWER(branch) = 'p0')
            ${whereSession}
          ORDER BY updated_at DESC
          LIMIT 30
        `)
        .all(...sessionParams)
        .map((r) => ({ ...r, tags: parseTagsJson(r.tags) }));

      // 4. Recent active worklogs & knowledge
      recentWork = projectTier.db
        .prepare(`
          SELECT id, type, title, summary, session, branch, tags, updated_at
          FROM docs
          WHERE status = 'active' AND type IN ('worklog', 'knowledge') ${whereSession}
          ORDER BY updated_at DESC
          LIMIT 20
        `)
        .all(...sessionParams)
        .map((r) => ({ ...r, tags: parseTagsJson(r.tags) }));

      projectStats = projectTier.db
        .prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN embed_status = 'ready' THEN 1 ELSE 0 END) AS embed_ready,
            SUM(CASE WHEN embed_status = 'pending' AND status NOT IN ('superseded', 'archived') THEN 1 ELSE 0 END) AS embed_pending,
            SUM(CASE WHEN embed_status = 'error' THEN 1 ELSE 0 END) AS embed_error
          FROM docs
        `)
        .get() || projectStats;

      projectLastError = projectTier.db
        .prepare("SELECT embed_error, updated_at FROM docs WHERE embed_error != '' ORDER BY updated_at DESC LIMIT 1")
        .get() || null;
    }

    // 5. Global preferences & knowledge
    let globalPreferences = [];
    let globalStats = { total: 0, active: 0, embed_ready: 0, embed_pending: 0, embed_error: 0 };
    let globalLastError = null;

    if (includeGlobal) {
      const globalTier = this.getTierIfExists('global');
      if (globalTier) {
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
              SUM(CASE WHEN embed_status = 'ready' THEN 1 ELSE 0 END) AS embed_ready,
              SUM(CASE WHEN embed_status = 'pending' AND status NOT IN ('superseded', 'archived') THEN 1 ELSE 0 END) AS embed_pending,
              SUM(CASE WHEN embed_status = 'error' THEN 1 ELSE 0 END) AS embed_error
            FROM docs
          `)
          .get() || globalStats;

        globalLastError = globalTier.db
          .prepare("SELECT embed_error, updated_at FROM docs WHERE embed_error != '' ORDER BY updated_at DESC LIMIT 1")
          .get() || null;
      }
    }

    let lastError = '';
    if (projectLastError && globalLastError) {
      lastError = String(projectLastError.updated_at || '') >= String(globalLastError.updated_at || '')
        ? projectLastError.embed_error
        : globalLastError.embed_error;
    } else {
      lastError = projectLastError?.embed_error || globalLastError?.embed_error || '';
    }

    const embedReady = (Number(projectStats?.embed_ready) || 0) + (Number(globalStats?.embed_ready) || 0);
    const embedPending = (Number(projectStats?.embed_pending) || 0) + (Number(globalStats?.embed_pending) || 0);
    const embedError = (Number(projectStats?.embed_error) || 0) + (Number(globalStats?.embed_error) || 0);

    return {
      sessionFilter: sessionFilter || null,
      p0Baselines,
      sessions: [...sessionsMap.values()],
      todos,
      decisions,
      recentWork,
      globalPreferences,
      embeddingStats: {
        ready: embedReady,
        pending: embedPending,
        error: embedError,
        lastError,
      },
      stats: {
        projectDocs: Number(projectStats?.total) || 0,
        projectActiveDocs: Number(projectStats?.active) || 0,
        globalDocs: Number(globalStats?.total) || 0,
        globalActiveDocs: Number(globalStats?.active) || 0,
        pendingEmbeddings: embedPending,
      },
    };
  }
}
