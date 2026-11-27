import fs from 'node:fs';
import path from 'node:path';
import { getProjectMemoryDir } from '../core/config.mjs';
import { CortexStore } from '../core/store.mjs';
import { sanitizeInline } from '../core/budget.mjs';
import {
  DEFER_REASON_INDEX_BUSY,
  DEFER_REASON_TIME_BUDGET,
  DEFER_REASON_TOO_LARGE,
} from '../core/db.mjs';

/**
 * Index sync limits of the session-start hooks (Claude Code and Antigravity register them with a 10 s
 * timeout, and a hook that is killed injects nothing at all):
 * - HOOK_INDEX_BUDGET_MS: time, counted from the start of the hook process, in which changed documents are
 *   indexed. What does not fit is deferred to the MCP server, never excluded.
 * - HOOK_INDEX_BYTES_PER_MS / HOOK_INDEX_PER_FILE_MS: deliberately low throughput used to estimate, from a
 *   file's size alone, whether indexing it fits in the time that is left.
 * - HOOK_INDEX_MAX_FILE_BYTES: a changed document larger than this is always left to the MCP server.
 */
export const HOOK_INDEX_BUDGET_MS = 4000;
export const HOOK_INDEX_BYTES_PER_MS = 1024;
export const HOOK_INDEX_PER_FILE_MS = 5;
export const HOOK_INDEX_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Most document names the "not indexed yet" notice lists. */
export const UNINDEXED_NOTICE_MAX_FILES = 5;
/** Most document names the one-line notice for the user's screen lists. */
export const UNINDEXED_USER_NOTICE_MAX_FILES = 3;
const UNINDEXED_NOTICE_MAX_NAME_CHARS = 120;

/**
 * One-line notice injected into model context (in approved, non-worker sessions) when there are 0 active
 * memory documents in both the project and global tiers, so the agent knows herdr-cortex memory is active.
 */
export const EMPTY_MEMORY_NOTICE =
  '[herdr-cortex] Memory is on and has no active documents to show yet; call memory_save when decisions are agreed, work is committed, or user preferences are confirmed.';

/**
 * Sync limits for one hook run (the `syncOptions` of `CortexStore`).
 * `startedAt` is when the hook process started (epoch ms; defaults to now). `indexBudget` overrides single
 * values for tests: { budgetMs, maxFileBytes, bytesPerMs, perFileMs, now }.
 */
export function resolveHookSyncOptions({ startedAt, indexBudget } = {}) {
  const overrides = indexBudget && typeof indexBudget === 'object' ? indexBudget : {};
  const now = typeof overrides.now === 'function' ? overrides.now : Date.now;
  const numberOr = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== undefined
    ? Number(value)
    : fallback);
  const start = numberOr(startedAt, now());
  return {
    deadline: start + numberOr(overrides.budgetMs, HOOK_INDEX_BUDGET_MS),
    maxFileBytes: numberOr(overrides.maxFileBytes, HOOK_INDEX_MAX_FILE_BYTES),
    bytesPerMs: numberOr(overrides.bytesPerMs, HOOK_INDEX_BYTES_PER_MS),
    perFileMs: numberOr(overrides.perFileMs, HOOK_INDEX_PER_FILE_MS),
    now,
  };
}

function hasAnyOverviewItems(ov) {
  if (!ov) return false;
  return (
    (ov.p0Baselines?.length || 0) > 0
    || (ov.sessions?.length || 0) > 0
    || (ov.todos?.length || 0) > 0
    || (ov.decisions?.length || 0) > 0
    || (ov.recentWork?.length || 0) > 0
    || (ov.globalPreferences?.length || 0) > 0
  );
}

/**
 * Memory overview for a hook injection, read after an index sync that runs under `syncOptions`.
 * Returns { overview, unindexed }: `overview` is the overview data or null when there is nothing to show,
 * `unindexed` lists the documents that sync left out ([{ scope, path, size, reason, error? }]).
 * An unapproved project is treated like a folder without `.memory/`: only the global tier is read.
 * Errors never propagate: a hook still injects everything else.
 */
export function loadHookOverview({ projectDir, globalDir, config, projectTrusted, syncOptions = null }) {
  const projectMemExists = projectTrusted && fs.existsSync(getProjectMemoryDir(projectDir));
  const globalDocsExists = fs.existsSync(path.join(globalDir, 'docs'));
  if (!projectMemExists && !globalDocsExists) {
    return { overview: null, unindexed: [], syncFailed: false };
  }

  const store = new CortexStore({
    projectDir,
    globalDir,
    config,
    disableVec: true,
    syncOptions,
  });

  let overview = null;
  let syncFailed = false;
  try {
    if (projectMemExists) {
      const ov = store.getOverview({ includeGlobal: globalDocsExists });
      overview = hasAnyOverviewItems(ov) ? ov : null;
    } else {
      // Avoid creating <project>/.memory in directories that don't use cortex yet
      const globalTier = store.getTier('global');
      store.sync('global');
      const globalPrefs = globalTier.db
        .prepare(`
          SELECT id, path, type, title, summary, tags, updated_at
          FROM docs
          WHERE status = 'active'
          ORDER BY CASE WHEN path LIKE 'docs/preferences/%' THEN 0 ELSE 1 END, updated_at DESC
          LIMIT 25
        `)
        .all()
        .map((r) => {
          let tags = [];
          try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
          return {
            id: r.id,
            type: r.type,
            category: r.path.startsWith('docs/preferences/') ? 'preferences' : 'knowledge',
            title: r.title,
            summary: r.summary,
            tags,
            updated_at: r.updated_at,
          };
        });

      if (globalPrefs.length > 0) {
        overview = {
          sessionFilter: null,
          sessions: [],
          todos: [],
          decisions: [],
          recentWork: [],
          globalPreferences: globalPrefs,
        };
      }
    }
  } catch {
    overview = null;
    syncFailed = true;
  }

  let unindexed = [];
  try {
    unindexed = store.getUnindexedDocs();
  } catch {
    unindexed = [];
  }
  store.close();
  return { overview, unindexed, syncFailed };
}

function formatBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function describeUnindexedReason(item) {
  switch (item.reason) {
    case DEFER_REASON_TOO_LARGE:
      return 'too large to index at session start';
    case DEFER_REASON_TIME_BUDGET:
      return 'no time left at session start';
    case DEFER_REASON_INDEX_BUSY:
      return 'the index was busy';
    default: {
      const detail = sanitizeInline(item.error || '').slice(0, 80);
      return detail ? `could not be indexed: ${detail}` : 'could not be indexed';
    }
  }
}

function formatUnindexedEntry(item) {
  let name = sanitizeInline(item.path);
  if (name.length > UNINDEXED_NOTICE_MAX_NAME_CHARS) {
    name = `...${name.slice(name.length - UNINDEXED_NOTICE_MAX_NAME_CHARS + 3)}`;
  }
  const where = item.scope === 'global' ? ' [global memory]' : '';
  return `"${name}"${where} (${formatBytes(item.size)}, ${describeUnindexedReason(item)})`;
}

/**
 * One-line notice for the hook injection that names the documents the hook's index sync left out, so the
 * reader knows memory may be incomplete. Lists at most `maxFiles` names (fewer when `maxChars` is tight,
 * down to the bare count); returns '' when nothing was left out or not even the short form fits.
 */
export function formatUnindexedNotice(
  unindexed,
  { maxFiles = UNINDEXED_NOTICE_MAX_FILES, maxChars = Infinity } = {},
) {
  const items = Array.isArray(unindexed) ? unindexed.filter((item) => item && typeof item.path === 'string') : [];
  const total = items.length;
  if (total === 0) return '';

  const head = total === 1
    ? '[herdr-cortex] Memory may be incomplete: 1 document is not indexed yet, so it is missing from the memory overview and from search.'
    : `[herdr-cortex] Memory may be incomplete: ${total} documents are not indexed yet, so they are missing from the memory overview and from search.`;
  const tail = ' The herdr-cortex MCP server indexes documents that were left out, in the background.';

  for (let shown = Math.min(Math.max(0, Number(maxFiles) || 0), total); shown >= 0; shown--) {
    let text = head;
    if (shown > 0) {
      const names = items.slice(0, shown).map(formatUnindexedEntry).join('; ');
      const more = total > shown ? `; +${total - shown} more` : '';
      text += ` Not indexed: ${names}${more}.`;
    }
    text += tail;
    if (text.length <= maxChars) return text;
  }
  return head.length <= maxChars ? head : '';
}

/**
 * The same fact as one compact line for the user's own screen (the hooks' `systemMessage`): how many
 * documents are not indexed yet and the first few names. '' when nothing was left out.
 */
export function formatUnindexedUserNotice(unindexed, { maxFiles = UNINDEXED_USER_NOTICE_MAX_FILES } = {}) {
  const items = Array.isArray(unindexed) ? unindexed.filter((item) => item && typeof item.path === 'string') : [];
  const total = items.length;
  if (total === 0) return '';
  const shown = items.slice(0, Math.max(0, Number(maxFiles) || 0)).map(formatUnindexedEntry);
  if (total > shown.length && shown.length > 0) shown.push(`+${total - shown.length} more`);
  return `[herdr-cortex] ${total === 1 ? '1 memory document is' : `${total} memory documents are`} not indexed yet, `
    + 'so the memory overview and search may be incomplete until the MCP server has indexed them'
    + `${shown.length > 0 ? `: ${shown.join('; ')}` : ''}.`;
}
