import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  compareTimestamps,
  getProjectMemoryDir,
  getTierPaths,
  isProjectEnabled,
  isProjectTrusted,
  loadConfig,
  normalizeRelPath,
  resolveGlobalDir,
} from '../core/config.mjs';
import { sanitizeInline } from '../core/budget.mjs';

/**
 * Host-independent helpers for dependent-file hints (2-6):
 * 1. `workSize.contractFiles` glob matching (project-root relative; S -> deny + L escalation).
 * 2. Memory-graph lookup for active `decision` / `baseline` documents referencing `file:<relPath>`,
 *    opening an approved project's existing `.memory/index.sqlite` directly in read-only mode with a
 *    short `PRAGMA busy_timeout` (<200ms), without running any disk sync or creating/modifying/unlinking
 *    index files, and matching file paths case-insensitively on Windows.
 */

export const DEPENDENCY_LOOKUP_TIMEOUT_MS = 200;
export const DEPENDENCY_NOTICE_MAX_DOCS = 3;
export const DEPENDENCY_NOTICE_MAX_CHARS = 300;
export const CONTRACT_DENY_MAX_CHARS = 300;

let cachedDatabaseSync = null;

function getDatabaseSync() {
  if (!cachedDatabaseSync) {
    const req = createRequire(import.meta.url);
    cachedDatabaseSync = req('node:sqlite').DatabaseSync;
  }
  return cachedDatabaseSync;
}

function clipInline(value, maxChars) {
  const clean = sanitizeInline(value);
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 3) return clean.slice(0, Math.max(0, maxChars));
  return `${clean.slice(0, maxChars - 3)}...`;
}

function escapeRegexChar(ch) {
  return /[.+^$()|\\]/.test(ch) ? `\\${ch}` : ch;
}

function globBodyToRegexSource(glob) {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.+/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      out += '/.*';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
      continue;
    }
    const ch = glob[i];
    if (ch === '*') {
      out += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close > i + 1) {
        let inner = glob.slice(i + 1, close);
        if (inner.startsWith('!')) inner = `^${inner.slice(1)}`;
        out += `[${inner.replace(/\\/g, '\\\\')}]`;
        i = close + 1;
        continue;
      }
      out += '\\[';
      i++;
      continue;
    }
    if (ch === '{') {
      const close = glob.indexOf('}', i + 1);
      if (close > i + 1 && !glob.slice(i + 1, close).includes('{')) {
        const alts = glob
          .slice(i + 1, close)
          .split(',')
          .map((part) => globBodyToRegexSource(part));
        out += `(?:${alts.join('|')})`;
        i = close + 1;
        continue;
      }
      out += '\\{';
      i++;
      continue;
    }
    out += escapeRegexChar(ch);
    i++;
  }
  return out;
}

function compileProjectGlob(rawPattern) {
  if (typeof rawPattern !== 'string') return null;
  const clean = rawPattern
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!clean || clean.includes('\0')) return null;

  const src = globBodyToRegexSource(clean);
  const flags = process.platform === 'win32' ? 'i' : '';
  return new RegExp(`^${src}$`, flags);
}

/**
 * Return the first pattern in `patterns` matching `relPosixPath` (relative to project root), or `''`.
 */
export function matchContractFilePattern(relPosixPath, patterns) {
  if (typeof relPosixPath !== 'string' || !relPosixPath.trim()) return '';
  if (!Array.isArray(patterns) || patterns.length === 0) return '';

  const normalized = relPosixPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  if (!normalized) return '';

  for (const rawPattern of patterns) {
    if (typeof rawPattern !== 'string' || !rawPattern.trim()) continue;
    const re = compileProjectGlob(rawPattern);
    if (re && re.test(normalized)) {
      return rawPattern.trim();
    }
  }
  return '';
}

export function formatContractFileDenyReason({ file, pattern, commandName = 'cortex-work' } = {}) {
  const shortFile = clipInline(file || '대상 파일', 45);
  const shortPattern = clipInline(pattern || '*', 45);
  const text =
    `[herdr-cortex] "${shortFile}"은(는) 사용자가 계약 파일로 지정한 경로(패턴: "${shortPattern}")이므로 편집을 막고 L로 올렸습니다. `
    + '`cortex_prompt(kind: "skill", name: "start-job")`에 따라 워커에게 위임하세요. '
    + `잘못 걸렸으면 사용자에게 알리세요(\`${commandName}\`).`;
  return clipInline(text, CONTRACT_DENY_MAX_CHARS);
}

function collectActiveDocsFromRows(rows) {
  const byDocId = new Map();
  for (const row of rows || []) {
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    if (row.status !== 'active') continue;
    if (row.type !== 'decision' && row.type !== 'baseline') continue;
    const prev = byDocId.get(row.id);
    if (!prev) {
      byDocId.set(row.id, {
        id: row.id,
        type: row.type,
        title: row.title || row.id,
        updated_at: row.updated_at || '',
        edgeKind: row.kind || '',
      });
    } else if (row.kind === 'points_file' && prev.edgeKind !== 'points_file') {
      prev.edgeKind = 'points_file';
    }
  }
  return [...byDocId.values()];
}

function queryIncomingFileDocsReadOnly(db, normalizedRel, { caseInsensitive = false } = {}) {
  const target = `file:${normalizedRel}`;

  if (!caseInsensitive) {
    const rows = db
      .prepare(`
        SELECT d.id, d.type, d.status, d.title, d.updated_at, e.kind
        FROM edges e
        JOIN docs d ON d.id = e.src
        WHERE e.dst = ?
          AND d.status = 'active'
          AND d.type IN ('decision', 'baseline')
        LIMIT 200
      `)
      .all(target);
    return collectActiveDocsFromRows(rows);
  }

  // On Windows, `file:src/Mixed.mjs` and `file:src/mixed.mjs` name the same file.
  // `e.dst >= 'file:' AND e.dst < 'file;'` restricts SQLite to the `file:*` range of `idx_edges_dst`.
  const hasNonAscii = /[^\x00-\x7f]/.test(target);
  if (!hasNonAscii) {
    const rows = db
      .prepare(`
        SELECT d.id, d.type, d.status, d.title, d.updated_at, e.kind
        FROM edges e
        JOIN docs d ON d.id = e.src
        WHERE e.dst >= 'file:' AND e.dst < 'file;'
          AND e.dst = ? COLLATE NOCASE
          AND d.status = 'active'
          AND d.type IN ('decision', 'baseline')
        LIMIT 200
      `)
      .all(target);
    return collectActiveDocsFromRows(rows);
  }

  const wantedLower = target.toLowerCase();
  const rows = db
    .prepare(`
      SELECT d.id, d.type, d.status, d.title, d.updated_at, e.kind, e.dst
      FROM edges e
      JOIN docs d ON d.id = e.src
      WHERE e.dst >= 'file:' AND e.dst < 'file;'
        AND d.status = 'active'
        AND d.type IN ('decision', 'baseline')
    `)
    .all()
    .filter((row) => typeof row.dst === 'string' && row.dst.toLowerCase() === wantedLower);
  return collectActiveDocsFromRows(rows);
}

/**
 * Read active `decision` and `baseline` documents linked to `file:<relPosixPath>` from an approved
 * project's existing `.memory/index.sqlite` in read-only mode without running any disk sync or
 * modifying index files. Returns `[]` when the project is unapproved/disabled, no index exists,
 * the index is locked beyond the short wait, the schema differs, or elapsed time exceeds `timeoutMs`.
 */
export function lookupFileDependencyDocs(
  projectRoot,
  relPosixPath,
  {
    globalDir,
    config,
    timeoutMs = DEPENDENCY_LOOKUP_TIMEOUT_MS,
    nowMs = () => performance.now(),
    exploreGraphFn = null,
  } = {},
) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) return [];
  if (typeof relPosixPath !== 'string' || !relPosixPath.trim()) return [];
  const maxMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEPENDENCY_LOOKUP_TIMEOUT_MS;
  if (maxMs <= 0) return [];

  const startedAt = nowMs();
  const resolvedRoot = path.resolve(projectRoot.trim());
  const normalizedRel = normalizeRelPath(relPosixPath.trim());
  if (!normalizedRel) return [];

  const effectiveGlobalDir = resolveGlobalDir({ globalDir });
  const effectiveConfig = config || loadConfig({ projectDir: resolvedRoot, globalDir: effectiveGlobalDir });
  if (!isProjectEnabled(resolvedRoot, effectiveConfig)) return [];
  if (!isProjectTrusted(resolvedRoot, { globalDir: effectiveGlobalDir })) return [];

  const memDir = getProjectMemoryDir(resolvedRoot);
  const { dbPath } = getTierPaths(memDir);
  try {
    if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) return [];
  } catch {
    return [];
  }

  const elapsedBeforeOpen = nowMs() - startedAt;
  if (elapsedBeforeOpen > maxMs) return [];

  let db = null;
  try {
    const DatabaseSync = getDatabaseSync();
    db = new DatabaseSync(dbPath, { readOnly: true });

    const remainingMs = maxMs - Math.max(0, nowMs() - startedAt);
    if (remainingMs <= 0) return [];
    const busyMs = Math.max(1, Math.min(80, Math.floor(remainingMs * 0.5)));
    db.exec(`PRAGMA busy_timeout = ${busyMs};`);

    let matched;
    if (typeof exploreGraphFn === 'function') {
      const g = exploreGraphFn(db, {
        target: `file:${normalizedRel}`,
        depth: 1,
        direction: 'in',
        limit: 200,
      });
      const edgeKindsByDoc = new Map();
      for (const edge of g?.edges || []) {
        if (!edge || typeof edge.src !== 'string') continue;
        const prev = edgeKindsByDoc.get(edge.src);
        if (!prev || edge.kind === 'points_file') edgeKindsByDoc.set(edge.src, edge.kind);
      }
      matched = [];
      for (const node of g?.nodes || []) {
        if (!node || node.hop !== 1 || node.nodeType !== 'doc' || !node.exists) continue;
        if (node.status !== 'active') continue;
        if (node.type !== 'decision' && node.type !== 'baseline') continue;
        matched.push({
          id: node.id,
          type: node.type,
          title: node.title || node.id,
          updated_at: node.updated_at || '',
          edgeKind: edgeKindsByDoc.get(node.id) || '',
        });
      }
    } else {
      matched = queryIncomingFileDocsReadOnly(db, normalizedRel, {
        caseInsensitive: process.platform === 'win32',
      });
    }

    if (nowMs() - startedAt > maxMs) return [];

    matched.sort((a, b) => {
      const aPoints = a.edgeKind === 'points_file' ? 0 : 1;
      const bPoints = b.edgeKind === 'points_file' ? 0 : 1;
      if (aPoints !== bPoints) return aPoints - bPoints;
      const tsCmp = compareTimestamps(b.updated_at, a.updated_at);
      if (tsCmp !== 0) return tsCmp;
      return a.id.localeCompare(b.id);
    });

    return matched.slice(0, DEPENDENCY_NOTICE_MAX_DOCS).map(({ id, type, title }) => ({ id, type, title }));
  } catch {
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

export function formatFileDependencyNotice(docs) {
  const shown = Array.isArray(docs) ? docs.filter((d) => d && d.id).slice(0, DEPENDENCY_NOTICE_MAX_DOCS) : [];
  if (shown.length === 0) return '';

  const prefix = '[herdr-cortex] 연결된 활성 결정·기준선: ';
  const suffix =
    '. 이 편집이 다른 곳이 의존하는 것(공개 인터페이스, 설정 형식, 저장 데이터 구조, 훅 동작)을 바꾸면 L이므로 위임하고, 바꾸지 않으면 그대로 진행하세요.';
  const availableForDocs = DEPENDENCY_NOTICE_MAX_CHARS - prefix.length - suffix.length;
  const sepTotal = (shown.length - 1) * 2;
  const perItem = Math.max(20, Math.floor((availableForDocs - sepTotal) / shown.length));

  const itemsText = shown
    .map((doc) => {
      const cleanId = clipInline(doc.id, Math.max(12, perItem - 10));
      const titleBudget = Math.max(4, perItem - cleanId.length - 3);
      const cleanTitle = clipInline(doc.title || doc.id, titleBudget);
      return `[${cleanId}] ${cleanTitle}`;
    })
    .join(', ');

  return clipInline(`${prefix}${itemsText}${suffix}`, DEPENDENCY_NOTICE_MAX_CHARS);
}
