import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, assertInsideDir, isProjectEnabled, loadConfig } from '../core/config.mjs';
import { CortexStore } from '../core/store.mjs';
import { searchMemory } from '../core/search.mjs';
import { fitOverviewToBudget } from '../core/budget.mjs';

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

function readGlobalOnlyOverview(targetStore, sessionFilter = '') {
  const globalDocsDir = path.join(targetStore.globalDir, 'docs');
  if (!fs.existsSync(globalDocsDir)) {
    return {
      sessionFilter: sessionFilter || null,
      projectExcluded: true,
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
    projectExcluded: true,
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
 * Create the MCP tool registry for `cortex`.
 * Supports registering extra tools (e.g., Stage 2 relay_tabs / relay_send / relay_inbox).
 */
export function createToolRegistry(
  store,
  {
    promptsDir = path.join(REPO_ROOT, 'prompts'),
    getEmbeddingProvider = null,
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

  const withProjectStore = async (args, fn) => {
    const requestedDir = typeof args?.project_dir === 'string' && args.project_dir.trim()
      ? path.resolve(args.project_dir.trim())
      : '';
    const defaultRoot = store?.projectRoot ? path.resolve(store.projectRoot) : '';

    if (!requestedDir || requestedDir.toLowerCase() === defaultRoot.toLowerCase()) {
      return fn(store, {
        projectDir: defaultRoot,
        enabled: isDefaultProjectEnabled(),
        isDefaultStore: true,
      });
    }

    const cfg = loadConfig({ projectDir: requestedDir, globalDir: store.globalDir });
    const enabled = isProjectEnabled(requestedDir, cfg);
    const tempStore = new CortexStore({
      projectDir: requestedDir,
      globalDir: store.globalDir,
      config: cfg,
      disableVec: store.disableVec,
    });
    try {
      return await fn(tempStore, {
        projectDir: requestedDir,
        enabled,
        isDefaultStore: false,
      });
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
      return withProjectStore(args, async (targetStore, { projectDir, enabled }) => {
        const requestedScope = args.scope || 'all';
        if (!enabled && requestedScope === 'project') {
          return {
            query: args.query || '',
            scope: 'project',
            projectExcluded: true,
            projectDir,
            vectorUsed: false,
            results: [],
          };
        }
        const effectiveScope = enabled ? requestedScope : 'global';
        const provider = typeof getEmbeddingProvider === 'function' ? await getEmbeddingProvider() : null;
        return searchMemory(targetStore, {
          query: args.query || '',
          scope: effectiveScope,
          type: args.type || '',
          session: args.session || '',
          branch: args.branch || '',
          file: args.file || '',
          include_superseded: Boolean(args.include_superseded),
          limit: args.limit ?? 10,
          embeddingProvider: provider,
          embeddingBreaker,
        });
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
      return withProjectStore(args, async (targetStore, { projectDir, enabled }) => {
        const requestedScope = args.scope || 'all';
        if (!enabled && requestedScope === 'project') {
          return makeProjectExcludedError('memory_read', projectDir);
        }
        const effectiveScope = enabled ? requestedScope : 'global';
        const doc = targetStore.readDoc({
          id: args.id,
          scope: effectiveScope,
          include_neighbors: Boolean(args.include_neighbors),
        });
        if (!doc) {
          return {
            isError: true,
            data: { error: 'NOT_FOUND', message: `Document "${args.id}" not found` },
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
      return withProjectStore(args, async (targetStore, { projectDir, enabled, isDefaultStore }) => {
        const requestedScope = args.scope || 'project';
        if (!enabled && requestedScope !== 'global') {
          return makeProjectExcludedError('memory_save', projectDir);
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
      return withProjectStore(args, async (targetStore, { projectDir, enabled, isDefaultStore }) => {
        const requestedScope = args.scope || 'all';
        if (!enabled && requestedScope !== 'global') {
          return makeProjectExcludedError('memory_update', projectDir);
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
      return withProjectStore(args, async (targetStore, { projectDir, enabled }) => {
        const requestedScope = args.scope || 'project';
        if (!enabled && requestedScope === 'project') {
          return {
            target: args.target,
            scope: 'project',
            projectExcluded: true,
            projectDir,
            nodes: [],
            edges: [],
          };
        }
        const effectiveScope = enabled ? requestedScope : 'global';
        return targetStore.exploreGraph({
          target: args.target,
          scope: effectiveScope,
          depth: args.depth ?? 2,
          direction: args.direction || 'both',
          limit: args.limit ?? 60,
        });
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
        budget: { type: 'integer', minimum: 256, maximum: 50000, default: 9000 },
        format: { type: 'string', enum: ['both', 'json', 'markdown'], default: 'both' },
        project_dir: { type: 'string', description: 'Optional project directory override' },
      },
    },
    async handler(args) {
      return withProjectStore(args, async (targetStore, { enabled }) => {
        const overview = enabled
          ? targetStore.getOverview({
              session: args.session || '',
              includeGlobal: args.include_global !== false,
            })
          : (args.include_global !== false
              ? readGlobalOnlyOverview(targetStore, args.session || '')
              : {
                  sessionFilter: args.session || null,
                  projectExcluded: true,
                  sessions: [],
                  todos: [],
                  decisions: [],
                  recentWork: [],
                  globalPreferences: [],
                });
        const fitted = fitOverviewToBudget(overview, args.budget ?? targetStore.config?.hookBudget ?? 9000);
        if (args.format === 'markdown') {
          return { markdown: fitted.text, step: fitted.step, charCount: fitted.charCount };
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
          },
        };
      }
    },
  };
}
