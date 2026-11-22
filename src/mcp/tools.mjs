import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, assertInsideDir } from '../core/config.mjs';
import { searchMemory } from '../core/search.mjs';
import { fitOverviewToBudget } from '../core/budget.mjs';

/**
 * Canon Protection check: detect whether the caller is a subagent.
 */
export function isSubagentCaller(args = {}, meta = {}) {
  if (meta && typeof meta === 'object') {
    const agentId = meta.agent_id || meta.agentId;
    if (agentId && String(agentId).trim() !== '') return true;
    if (meta.is_subagent === true) return true;

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
    extraTools = [],
  } = {},
) {
  const tools = new Map();

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
      },
    },
    async handler(args) {
      const provider = typeof getEmbeddingProvider === 'function' ? await getEmbeddingProvider() : null;
      return searchMemory(store, {
        query: args.query || '',
        scope: args.scope || 'all',
        type: args.type || '',
        session: args.session || '',
        branch: args.branch || '',
        file: args.file || '',
        include_superseded: Boolean(args.include_superseded),
        limit: args.limit ?? 10,
        embeddingProvider: provider,
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
      },
    },
    async handler(args) {
      const doc = store.readDoc({
        id: args.id,
        scope: args.scope || 'all',
        include_neighbors: Boolean(args.include_neighbors),
      });
      if (!doc) {
        return {
          isError: true,
          data: { error: 'NOT_FOUND', message: `Document "${args.id}" not found` },
        };
      }
      return doc;
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
        derived_from: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        due: { type: 'string' },
        category: { type: 'string', enum: ['preferences', 'knowledge'] },
      },
    },
    async handler(args) {
      const saved = store.saveDoc(args);
      if (embeddingQueue && typeof embeddingQueue.schedule === 'function') {
        embeddingQueue.schedule(saved.scope);
      }
      return saved;
    },
  });

  registerTool({
    name: 'memory_update',
    description: 'Update an existing canonical Markdown memory document (HEAD main conversation only).',
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
        derived_from: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        due: { type: 'string' },
      },
    },
    async handler(args) {
      const updated = store.updateDoc(args);
      if (embeddingQueue && typeof embeddingQueue.schedule === 'function') {
        embeddingQueue.schedule(updated.scope);
      }
      return updated;
    },
  });

  registerTool({
    name: 'memory_graph',
    description: 'Explore 1-2 hop graph relationships around a document ID or file:<relPath> target for impact analysis and baseline lineage.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'Document ID or file:<relative/path>' },
        scope: { type: 'string', enum: ['project', 'global', 'all'], default: 'project' },
        depth: { type: 'integer', minimum: 1, maximum: 3, default: 2 },
        direction: { type: 'string', enum: ['in', 'out', 'both'], default: 'both' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 60 },
      },
    },
    async handler(args) {
      return store.exploreGraph({
        target: args.target,
        scope: args.scope || 'project',
        depth: args.depth ?? 2,
        direction: args.direction || 'both',
        limit: args.limit ?? 60,
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
      },
    },
    async handler(args) {
      const overview = store.getOverview({
        session: args.session || '',
        includeGlobal: args.include_global !== false,
      });
      const fitted = fitOverviewToBudget(overview, args.budget ?? store.config?.hookBudget ?? 9000);
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

      try {
        const result = await tool.handler(args || {}, meta || {});
        if (result && typeof result === 'object' && result.isError && 'data' in result) {
          return result;
        }
        return { isError: false, data: result };
      } catch (err) {
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
