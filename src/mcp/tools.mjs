import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  assertInsideDir,
  isProjectEnabled,
  isProjectTrusted,
  loadConfig,
  projectPathKey,
} from '../core/config.mjs';
import { PROJECT_NOT_APPROVED_CODE, formatProjectNotApprovedMessage } from '../core/trust.mjs';
import { CortexStore } from '../core/store.mjs';
import { searchMemory } from '../core/search.mjs';
import { HOOK_MAX_CHARS, fitOverviewToBudget } from '../core/budget.mjs';

/**
 * Canon Protection check: detect whether the caller is a subagent.
 */
export function isSubagentCaller(args = {}, meta = {}) {
  if (meta && typeof meta === 'object') {
    const agentId = meta.agent_id || meta.agentId;
    if (agentId && String(agentId).trim() !== '') return true;
    if (meta.is_subagent === true || meta.isSubagent === true) return true;

    const parentId =
      meta.parentConversationId
      || meta.parent_conversation_id
      || meta.parentSessionId
      || meta.parent_session_id;
    if (parentId && String(parentId).trim() !== '') return true;

    const convId =
      meta['antigravity.google/conversation_id']
      || meta.conversation_id
      || meta.conversationId;
    const rootConvId =
      meta['antigravity.google/root_conversation_id']
      || meta.root_conversation_id
      || meta.rootConversationId;
    if (convId && rootConvId && String(convId) !== String(rootConvId)) {
      return true;
    }
  }

  if (args && typeof args === 'object') {
    if (args._caller_agent_id && String(args._caller_agent_id).trim() !== '') {
      return true;
    }
  }

  return false;
}

/** Most document names the `indexing` note of a tool result lists. */
export const INDEXING_NOTE_MAX_DOCUMENTS = 5;

/** The range of `memory_overview`'s `budget` argument (characters of the formatted overview). */
export const MEMORY_OVERVIEW_BUDGET_MIN = 256;
export const MEMORY_OVERVIEW_BUDGET_MAX = 50000;

/**
 * The character budget `memory_overview` formats with: the `budget` argument when it is a number (or a
 * numeric string), else `configured` (the store's `hookBudget`), else HOOK_MAX_CHARS. Fractions are dropped
 * and the result is kept between MEMORY_OVERVIEW_BUDGET_MIN and MEMORY_OVERVIEW_BUDGET_MAX.
 */
export function resolveOverviewBudget(requested, configured) {
  const toNumber = (value) => {
    if (typeof value === 'number') return value;
    return typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  };
  const chosen = [toNumber(requested), toNumber(configured), HOOK_MAX_CHARS].find((value) => !Number.isNaN(value));
  // Math.trunc keeps the infinities; the range then cuts them down like any other value outside it.
  return Math.max(MEMORY_OVERVIEW_BUDGET_MIN, Math.min(Math.trunc(chosen), MEMORY_OVERVIEW_BUDGET_MAX));
}

/**
 * The `indexing` field of a tool result: present when the index sync of this call left documents to the
 * background index catch-up (too large or too many for a tool call's time budget, or the index was busy),
 * so the caller knows the answer was made from an index that is not complete yet.
 *   { pending: <number of waiting documents>, documents: [<up to INDEXING_NOTE_MAX_DOCUMENTS names>] }
 * A name is the path inside the memory folder ("global:" in front for the global store). Returns null when
 * nothing is waiting. Documents that cannot be indexed at all are not counted here; the session-start
 * notice and `cortex-status` report those.
 */
export function describeIndexing(unindexed) {
  const pending = (Array.isArray(unindexed) ? unindexed : [])
    .filter((item) => item && typeof item.path === 'string' && item.reason !== 'error');
  if (pending.length === 0) return null;
  return {
    pending: pending.length,
    documents: pending
      .slice(0, INDEXING_NOTE_MAX_DOCUMENTS)
      .map((item) => (item.scope === 'global' ? `global:${item.path}` : item.path)),
  };
}

// A tool result with the `indexing` note added (to `data` of an error result, to the result object otherwise).
function withIndexingNote(result, note) {
  if (!note || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result.isError && 'data' in result) {
    return result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? { ...result, data: { ...result.data, indexing: note } }
      : result;
  }
  return { ...result, indexing: note };
}

function isSameFolder(a, b) {
  if (!a || !b) return false;
  try {
    return projectPathKey(a) === projectPathKey(b);
  } catch {
    return false;
  }
}

function makeSubagentDeniedError(toolName) {
  return {
    isError: true,
    errorCode: 'SUBAGENT_WRITE_DENIED',
    data: {
      error: 'SUBAGENT_WRITE_DENIED',
      tool: toolName,
      message: 'Canonical memory writes are restricted to the main HEAD conversation; subagents have read-only memory access.',
    },
  };
}

// Arguments every tool accepts in addition to its input schema: the PreToolUse hook injects
// `_caller_agent_id` to mark subagent callers (see `isSubagentCaller`).
const INTERNAL_ARGUMENT_KEYS = new Set(['_caller_agent_id']);

function allowedArgumentNames(tool) {
  const properties = tool?.inputSchema?.properties;
  return properties && typeof properties === 'object' ? Object.keys(properties) : [];
}

/**
 * Argument names that are not declared in the tool's `inputSchema.properties`.
 * A misspelled argument would otherwise be dropped silently and the call would appear to succeed.
 * A tool whose schema declares no `properties` object at all is not checked.
 */
function findUnknownArguments(tool, args) {
  if (!args || typeof args !== 'object') return [];
  const properties = tool?.inputSchema?.properties;
  if (!properties || typeof properties !== 'object') return [];
  const allowed = new Set(allowedArgumentNames(tool));
  return Object.keys(args).filter((key) => !allowed.has(key) && !INTERNAL_ARGUMENT_KEYS.has(key));
}

function makeUnknownArgumentError(tool, unknownArgs) {
  const allowed = allowedArgumentNames(tool);
  const quoted = unknownArgs.map((key) => `"${key}"`).join(', ');
  return {
    isError: true,
    errorCode: 'UNKNOWN_ARGUMENT',
    data: {
      error: 'UNKNOWN_ARGUMENT',
      tool: tool.name,
      unknown_arguments: unknownArgs,
      allowed_arguments: allowed,
      message: `Unknown argument${unknownArgs.length === 1 ? '' : 's'} ${quoted} for tool "${tool.name}". Allowed arguments: ${allowed.join(', ') || '(none)'}.`,
    },
  };
}

function makeProjectExcludedError(toolName, projectDir) {
  return {
    isError: true,
    errorCode: 'PROJECT_EXCLUDED',
    data: {
      error: 'PROJECT_EXCLUDED',
      tool: toolName,
      project_dir: projectDir,
      message: `Project "${projectDir}" is excluded by herdr-cortex configuration; project-tier operations are disabled (only scope="global" reads/writes are permitted).`,
    },
  };
}

function makeProjectNotApprovedError(toolName, projectDir) {
  return {
    isError: true,
    errorCode: PROJECT_NOT_APPROVED_CODE,
    data: {
      error: PROJECT_NOT_APPROVED_CODE,
      tool: toolName,
      project_dir: projectDir,
      message: formatProjectNotApprovedMessage(projectDir),
    },
  };
}

/**
 * Why a store's project tier may not be used: 'excluded' (herdr-cortex configuration), 'not_approved'
 * (the user has not approved the folder), or null when it may be used. Exclusion is reported first.
 */
function projectBlockReason({ enabled, approved }) {
  if (!enabled) return 'excluded';
  if (!approved) return 'not_approved';
  return null;
}

function makeProjectBlockedError(block, toolName, projectDir) {
  return block === 'excluded'
    ? makeProjectExcludedError(toolName, projectDir)
    : makeProjectNotApprovedError(toolName, projectDir);
}

// Marker fields of a result that holds global-tier data only because the project tier was withheld.
function projectBlockFlags(block, projectDir) {
  if (block === 'excluded') return { projectExcluded: true };
  if (block === 'not_approved') {
    return {
      projectNotApproved: true,
      projectNotApprovedMessage: formatProjectNotApprovedMessage(projectDir),
    };
  }
  return {};
}

function readGlobalOnlyOverview(targetStore, sessionFilter = '', flags = { projectExcluded: true }) {
  const globalDocsDir = path.join(targetStore.globalDir, 'docs');
  if (!fs.existsSync(globalDocsDir)) {
    return {
      sessionFilter: sessionFilter || null,
      ...flags,
      sessions: [],
      todos: [],
      decisions: [],
      recentWork: [],
      globalPreferences: [],
    };
  }
  const globalTier = targetStore.getTier('global');
  targetStore.sync('global');
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

  return {
    sessionFilter: sessionFilter || null,
    ...flags,
    sessions: [],
    todos: [],
    decisions: [],
    recentWork: [],
    globalPreferences: globalPrefs,
  };
}

function resolvePromptFile(promptsDir, kind, name) {
  const cleanKind = String(kind || '').trim().toLowerCase();
  const cleanName = String(name || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

  if (cleanName.includes('..') || cleanName.includes('\0')) {
    throw new Error(`Invalid prompt name "${name}": path traversal is not allowed`);
  }

  const candidates = [];
  if (cleanKind === 'skill') {
    if (!cleanName) throw new Error('cortex_prompt(kind="skill") requires a non-empty "name"');
    const withMd = cleanName.endsWith('.md') ? cleanName : `${cleanName}.md`;
    candidates.push(path.join(promptsDir, 'skills', cleanName, 'SKILL.md'));
    candidates.push(path.join(promptsDir, 'skills', withMd));
  } else if (cleanKind === 'agent') {
    if (!cleanName) throw new Error('cortex_prompt(kind="agent") requires a non-empty "name"');
    const withMd = cleanName.endsWith('.md') ? cleanName : `${cleanName}.md`;
    candidates.push(path.join(promptsDir, 'agents', withMd));
  } else if (cleanKind === 'standard') {
    const targetName = cleanName || 'DEVELOPMENT_STANDARD';
    const withMd = targetName.endsWith('.md') ? targetName : `${targetName}.md`;
    candidates.push(path.join(promptsDir, withMd));
  } else if (cleanKind === 'core') {
    const targetName = cleanName || 'HEAD_CORE';
    const withMd = targetName.endsWith('.md') ? targetName : `${targetName}.md`;
    candidates.push(path.join(promptsDir, withMd));
  } else {
    throw new Error(`Invalid prompt kind "${kind}": expected "skill", "agent", "standard", or "core"`);
  }

  for (const candidate of candidates) {
    const safePath = assertInsideDir(promptsDir, candidate);
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      return safePath;
    }
  }

  throw new Error(`Prompt not found for kind="${cleanKind}" name="${cleanName}"`);
}

/**
 * Create the MCP tool registry of the `herdr-cortex` server.
 * Supports registering extra tools (e.g., Stage 2 relay_tabs / relay_send / relay_inbox).
 */
export function createToolRegistry(
  store,
  {
    promptsDir = path.join(REPO_ROOT, 'prompts'),
    getEmbeddingProvider = null,
    getEmbeddingProviders = null,
    embeddingQueue = null,
    embeddingBreaker = null,
    projectEnabled = null,
    extraTools = [],
  } = {},
) {
  const tools = new Map();

  // Queue the embedding of a document that was just written. A write made with `project_dir` lands in another
  // project's store, so the queue is told which project it was; the global tier is the same store either way.
  const scheduleEmbedding = (scope, { projectDir, isDefaultStore }) => {
    if (!embeddingQueue || typeof embeddingQueue.schedule !== 'function') return;
    if (isDefaultStore || scope === 'global') {
      embeddingQueue.schedule(scope);
    } else {
      embeddingQueue.schedule(scope, { projectDir });
    }
  };

  const isDefaultProjectEnabled = () => {
    if (typeof projectEnabled === 'boolean') return projectEnabled;
    if (!store) return true;
    const cfg = store.config || loadConfig({ projectDir: store.projectRoot, globalDir: store.globalDir });
    return isProjectEnabled(store.projectRoot, cfg);
  };

  // Approval is read from the approval list on every call: the user can give or withdraw it while the
  // server runs. It applies to the default project and to `project_dir` alike, so `project_dir` can only
  // reach folders the user approved.
  const isApproved = (projectDir) => {
    if (!store) return true;
    return isProjectTrusted(projectDir, { globalDir: store.globalDir });
  };

  // One tool call against one store. The call's index syncs share one time budget when the store has tool
  // sync limits (the MCP server's store); whatever they leave out is named in the result's `indexing` field.
  const runToolCall = async (targetStore, info, fn) => {
    const tracked = Boolean(targetStore?.toolSyncLimits) && typeof targetStore.beginSyncWindow === 'function';
    if (tracked) targetStore.beginSyncWindow();
    const currentNote = () => (tracked ? describeIndexing(targetStore.getUnindexedDocs()) : null);
    try {
      return withIndexingNote(await fn(targetStore, info), currentNote());
    } catch (err) {
      // "not found" from a tool may only mean "not indexed yet": the error says so as well
      if (err && typeof err === 'object') {
        const note = currentNote();
        if (note) err.indexing = note;
      }
      throw err;
    } finally {
      if (tracked) targetStore.endSyncWindow();
    }
  };

  const withProjectStore = async (args, fn) => {
    const requestedDir = typeof args?.project_dir === 'string' && args.project_dir.trim()
      ? path.resolve(args.project_dir.trim())
      : '';
    const defaultRoot = store?.projectRoot ? path.resolve(store.projectRoot) : '';

    // Same folder by real path: a `project_dir` that reaches the default project through a junction or a
    // symlink uses the default store instead of opening a second one on the same files.
    if (!requestedDir || isSameFolder(requestedDir, defaultRoot)) {
      return runToolCall(store, {
        projectDir: defaultRoot,
        enabled: isDefaultProjectEnabled(),
        approved: isApproved(defaultRoot),
        isDefaultStore: true,
      }, fn);
    }

    const cfg = loadConfig({ projectDir: requestedDir, globalDir: store.globalDir });
    const enabled = isProjectEnabled(requestedDir, cfg);
    const tempStore = new CortexStore({
      projectDir: requestedDir,
      globalDir: store.globalDir,
      config: cfg,
      disableVec: store.disableVec,
      // The same limits as the server's own store; what a sync leaves out is reported to the same owner.
      toolSyncLimits: store.toolSyncLimits || null,
      onSyncDeferred: store.onSyncDeferred || null,
    });
    try {
      return await runToolCall(tempStore, {
        projectDir: requestedDir,
        enabled,
        approved: isApproved(requestedDir),
        isDefaultStore: false,
      }, fn);
    } finally {
      tempStore.close();
    }
  };

  const registerTool = (toolDef) => {
    if (!toolDef || !toolDef.name || typeof toolDef.handler !== 'function') {
      throw new Error('Tool definition requires "name" and "handler" function');
    }
    tools.set(toolDef.name, {
      name: toolDef.name,
      description: toolDef.description || '',
      inputSchema: toolDef.inputSchema || { type: 'object', properties: {} },
      writeProtected: Boolean(toolDef.writeProtected),
      handler: toolDef.handler,
    });
  };

  registerTool({
    name: 'memory_search',
    description: 'Search project and/or global memory using hybrid structured, Korean-safe FTS5+LIKE, vector, and graph RRF ranking. Returns stage-1 summaries without full document content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (optional when filtering by metadata)' },
        scope: { type: 'string', enum: ['project', 'global', 'all'], default: 'all' },
        type: { type: 'string', enum: ['decision', 'worklog', 'knowledge', 'todo', 'baseline'] },
        session: { type: 'string' },
        branch: { type: 'string' },
        file: { type: 'string', description: 'Filter docs linked to this relative file path' },
        include_superseded: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        project_dir: { type: 'string', description: 'Optional project directory override' },
      },
    },
    async handler(args) {
      return withProjectStore(args, async (targetStore, { projectDir, enabled, approved }) => {
        const requestedScope = args.scope || 'all';
        const block = projectBlockReason({ enabled, approved });
        if (block && requestedScope === 'project') {
          return {
            query: args.query || '',
            scope: 'project',
            ...projectBlockFlags(block, projectDir),
            projectDir,
            vectorUsed: false,
            results: [],
          };
        }
        const effectiveScope = block ? 'global' : requestedScope;
        // Each tier has its own provider (the global tier follows the global settings); `getEmbeddingProvider`
        // is the older single-provider form.
        const providers = typeof getEmbeddingProviders === 'function' ? await getEmbeddingProviders(targetStore) : null;
        const provider = !providers && typeof getEmbeddingProvider === 'function' ? await getEmbeddingProvider() : null;
        const found = await searchMemory(targetStore, {
          query: args.query || '',
          scope: effectiveScope,
          type: args.type || '',
          session: args.session || '',
          branch: args.branch || '',
          file: args.file || '',
          include_superseded: Boolean(args.include_superseded),
          limit: args.limit ?? 10,
          embeddingProvider: provider,
          embeddingProviders: providers,
          embeddingBreaker,
        });
        // Results that lack the project tier because the project is excluded or the folder is unapproved
        // say so (a search that asked for the global tier only lacks nothing).
        return block && requestedScope !== 'global'
          ? { ...found, ...projectBlockFlags(block, projectDir) }
          : found;
      });
    },
  });

  registerTool({
    name: 'memory_read',
    description: 'Read full Markdown content and metadata of a specific memory document by ID, optionally including 1-hop graph neighbors.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global', 'all'], default: 'all' },
        include_neighbors: { type: 'boolean', default: false },
        project_dir: { type: 'string', description: 'Optional project directory override' },
      },
    },
    async handler(args) {
      return withProjectStore(args, async (targetStore, { projectDir, enabled, approved }) => {
        const requestedScope = args.scope || 'all';
        const block = projectBlockReason({ enabled, approved });
        if (block && requestedScope === 'project') {
          return makeProjectBlockedError(block, 'memory_read', projectDir);
        }
        const effectiveScope = block ? 'global' : requestedScope;
        const doc = targetStore.readDoc({
          id: args.id,
          scope: effectiveScope,
          include_neighbors: Boolean(args.include_neighbors),
        });
        if (!doc) {
          return {
            isError: true,
            data: {
              error: 'NOT_FOUND',
              message: `Document "${args.id}" not found`,
              ...(block === 'not_approved' ? projectBlockFlags(block, projectDir) : {}),
            },
          };
        }
        return doc;
      });
    },
  });

  registerTool({
    name: 'memory_save',
    description: 'Save a new canonical Markdown memory document (HEAD main conversation only). Atomically transitions superseded documents and indexes immediately.',
    writeProtected: true,
    inputSchema: {
      type: 'object',
      required: ['type', 'title', 'summary'],
      properties: {
        id: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global'], default: 'project' },
        type: { type: 'string', enum: ['decision', 'worklog', 'knowledge', 'todo', 'baseline'] },
        status: { type: 'string', enum: ['active', 'done', 'superseded', 'archived'], default: 'active' },
        title: { type: 'string' },
        summary: { type: 'string' },
        content: { type: 'string', default: '' },
        session: { type: 'string' },
        branch: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
        supersedes: { type: 'string' },
        derived_from: { type: 'array', items: { type: 'string' } },
        due: { type: 'string' },
        category: { type: 'string', enum: ['preferences', 'knowledge'] },
        project_dir: { type: 'string', description: 'Optional project directory override' },
      },
    },
    async handler(args) {
      return withProjectStore(args, async (targetStore, { projectDir, enabled, approved, isDefaultStore }) => {
        const requestedScope = args.scope || 'project';
        const block = projectBlockReason({ enabled, approved });
        if (block && requestedScope !== 'global') {
          return makeProjectBlockedError(block, 'memory_save', projectDir);
        }
        const saved = targetStore.saveDoc(args);
        scheduleEmbedding(saved.scope, { projectDir, isDefaultStore });
        return saved;
      });
    },
  });

  registerTool({
    name: 'memory_update',
    description: 'Update an existing canonical Markdown memory document (HEAD main conversation only). Setting supersedes transitions the superseded document exactly like memory_save.',
    writeProtected: true,
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'global', 'all'], default: 'all' },
        type: { type: 'string', enum: ['decision', 'worklog', 'knowledge', 'todo', 'baseline'] },
        status: { type: 'string', enum: ['active', 'done', 'superseded', 'archived'] },
        title: { type: 'string' },
        summary: { type: 'string' },
        content: { type: 'string' },
        append_content: { type: 'string' },
        session: { type: 'string' },
        branch: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
        supersedes: { type: 'string', description: 'ID of the document this one replaces; that document becomes status "superseded" (empty string clears the link)' },
        derived_from: { type: 'array', items: { type: 'string' } },
        due: { type: 'string' },
        project_dir: { type: 'string', description: 'Optional project directory override' },
      },
    },
    async handler(args) {
      return withProjectStore(args, async (targetStore, { projectDir, enabled, approved, isDefaultStore }) => {
        const requestedScope = args.scope || 'all';
        const block = projectBlockReason({ enabled, approved });
        if (block && requestedScope !== 'global') {
          return makeProjectBlockedError(block, 'memory_update', projectDir);
        }
        const updated = targetStore.updateDoc(args);
        scheduleEmbedding(updated.scope, { projectDir, isDefaultStore });
        return updated;
      });
    },
  });

  registerTool({
    name: 'memory_graph',
    description: 'Explore 1-10 hop graph relationships around a document ID or file:<relPath> target for impact analysis and baseline lineage.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'Document ID or file:<relative/path>' },
        scope: { type: 'string', enum: ['project', 'global', 'all'], default: 'project' },
        depth: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
        direction: { type: 'string', enum: ['in', 'out', 'both'], default: 'both' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 60 },
        project_dir: { type: 'string', description: 'Optional project directory override' },
      },
    },
    async handler(args) {
      return withProjectStore(args, async (targetStore, { projectDir, enabled, approved }) => {
        const requestedScope = args.scope || 'project';
        const block = projectBlockReason({ enabled, approved });
        if (block && requestedScope === 'project') {
          return {
            target: args.target,
            scope: 'project',
            ...projectBlockFlags(block, projectDir),
            projectDir,
            nodes: [],
            edges: [],
          };
        }
        const effectiveScope = block ? 'global' : requestedScope;
        const graph = targetStore.exploreGraph({
          target: args.target,
          scope: effectiveScope,
          depth: args.depth ?? 2,
          direction: args.direction || 'both',
          limit: args.limit ?? 60,
        });
        // Marked like a search: the project tier was asked for (through "all") and left out.
        return block && requestedScope !== 'global'
          ? { ...graph, ...projectBlockFlags(block, projectDir) }
          : graph;
      });
    },
  });

  registerTool({
    name: 'memory_overview',
    description: 'Get a concise overview of active sessions, branches, open todos, recent decisions/baselines, and global preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        include_global: { type: 'boolean', default: true },
        budget: {
          type: 'integer',
          minimum: MEMORY_OVERVIEW_BUDGET_MIN,
          maximum: MEMORY_OVERVIEW_BUDGET_MAX,
          default: 9000,
          description: `Character limit of the formatted overview, ${MEMORY_OVERVIEW_BUDGET_MIN}-${MEMORY_OVERVIEW_BUDGET_MAX}. `
            + 'A value outside the range is moved to the nearest end of it; a value that is not a number counts as '
            + 'omitted. Default: the configured hookBudget.',
        },
        format: { type: 'string', enum: ['both', 'json', 'markdown'], default: 'both' },
        project_dir: { type: 'string', description: 'Optional project directory override' },
      },
    },
    async handler(args) {
      return withProjectStore(args, async (targetStore, { projectDir, enabled, approved }) => {
        const block = projectBlockReason({ enabled, approved });
        const blockFlags = projectBlockFlags(block, projectDir);
        const overview = !block
          ? targetStore.getOverview({
              session: args.session || '',
              includeGlobal: args.include_global !== false,
            })
          : (args.include_global !== false
              ? readGlobalOnlyOverview(targetStore, args.session || '', blockFlags)
              : {
                  sessionFilter: args.session || null,
                  ...blockFlags,
                  sessions: [],
                  todos: [],
                  decisions: [],
                  recentWork: [],
                  globalPreferences: [],
                });
        const fitted = fitOverviewToBudget(overview, resolveOverviewBudget(args.budget, targetStore.config?.hookBudget));
        if (args.format === 'markdown') {
          return {
            markdown: fitted.text,
            step: fitted.step,
            charCount: fitted.charCount,
            ...(block === 'not_approved' ? blockFlags : {}),
          };
        }
        if (args.format === 'json') {
          return overview;
        }
        return {
          ...overview,
          formatted: fitted.text,
          fitStep: fitted.step,
        };
      });
    },
  });

  registerTool({
    name: 'cortex_prompt',
    description: 'Load authoritative prompt assets (skills, agent role cores, standards, or HEAD_CORE) safely from the prompts directory.',
    inputSchema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['skill', 'agent', 'standard', 'core'] },
        name: { type: 'string', description: 'Prompt name (e.g. "developer", "plan-run/steps/03-minimum-plan-review")' },
      },
    },
    async handler(args) {
      const safePath = resolvePromptFile(promptsDir, args.kind, args.name);
      const content = fs.readFileSync(safePath, 'utf8');
      return {
        kind: args.kind,
        name: args.name || '',
        path: path.relative(promptsDir, safePath).replace(/\\/g, '/'),
        content,
      };
    },
  });

  for (const extra of extraTools) {
    registerTool(extra);
  }

  return {
    registerTool,
    listTools() {
      return [...tools.values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
    },
    async callTool(name, args = {}, meta = {}) {
      const tool = tools.get(name);
      if (!tool) {
        return {
          isError: true,
          errorCode: 'UNKNOWN_TOOL',
          data: { error: 'UNKNOWN_TOOL', message: `Unknown tool "${name}"` },
        };
      }

      if (tool.writeProtected && isSubagentCaller(args, meta)) {
        return makeSubagentDeniedError(name);
      }

      const unknownArgs = findUnknownArguments(tool, args);
      if (unknownArgs.length > 0) {
        return makeUnknownArgumentError(tool, unknownArgs);
      }

      try {
        const result = await tool.handler(args || {}, meta || {});
        if (result && typeof result === 'object' && result.isError && 'data' in result) {
          return result;
        }
        return { isError: false, data: result };
      } catch (err) {
        // The store refuses to open the project tier of an unapproved folder; report it like the handlers do.
        if (err?.code === PROJECT_NOT_APPROVED_CODE) {
          return {
            isError: true,
            errorCode: PROJECT_NOT_APPROVED_CODE,
            data: {
              error: PROJECT_NOT_APPROVED_CODE,
              tool: name,
              ...(err.projectDir ? { project_dir: err.projectDir } : {}),
              message: err.message || String(err),
            },
          };
        }
        if (err?.code === 'UNSAFE_UPDATE') {
          return {
            isError: true,
            errorCode: 'UNSAFE_UPDATE',
            data: {
              error: 'UNSAFE_UPDATE',
              tool: name,
              message: err.message || String(err),
            },
          };
        }
        return {
          isError: true,
          errorCode: 'TOOL_EXECUTION_ERROR',
          data: {
            error: 'TOOL_EXECUTION_ERROR',
            message: err?.message || String(err),
            ...(err?.indexing ? { indexing: err.indexing } : {}),
          },
        };
      }
    },
  };
}
