import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { CortexStore } from '../core/store.mjs';
import { REPO_ROOT, loadConfig } from '../core/config.mjs';
import { createEmbeddingQueue, resolveEmbeddingProvider } from '../embeddings/index.mjs';
import { createRelayTools } from '../relay/tools.mjs';
import { createToolRegistry } from './tools.mjs';

export const SERVER_INFO = Object.freeze({
  name: 'cortex',
  version: '1.0.0',
});

export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

function makeJsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeJsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

/**
 * Create a zero-dep Stdio JSON-RPC 2.0 MCP server instance.
 */
export function createMcpServer({
  store,
  promptsDir = path.join(REPO_ROOT, 'prompts'),
  getEmbeddingProvider = null,
  embeddingQueue = null,
  hcClient = null,
  includeRelayTools = true,
  extraTools = [],
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const defaultRelayTools = includeRelayTools && store
    ? createRelayTools({
        projectDir: store.projectRoot,
        globalDir: store.globalDir,
        hcClient,
        store,
      })
    : [];

  const registry = createToolRegistry(store, {
    promptsDir,
    getEmbeddingProvider,
    embeddingQueue,
    extraTools: [...defaultRelayTools, ...extraTools],
  });

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      return makeJsonRpcError(null, -32600, 'Invalid Request');
    }

    const { id, method, params } = msg;
    const isNotification = id === undefined;

    if (typeof method !== 'string') {
      return isNotification ? null : makeJsonRpcError(id, -32600, 'Invalid Request: missing method');
    }

    if (method === 'initialize') {
      const clientVersion = typeof params?.protocolVersion === 'string'
        ? params.protocolVersion
        : DEFAULT_PROTOCOL_VERSION;
      return makeJsonRpcResult(id, {
        protocolVersion: clientVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      });
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return null;
    }

    if (method === 'ping') {
      return isNotification ? null : makeJsonRpcResult(id, {});
    }

    if (method === 'tools/list') {
      return makeJsonRpcResult(id, {
        tools: registry.listTools(),
      });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const toolMeta = {
        ...(msg._meta && typeof msg._meta === 'object' ? msg._meta : {}),
        ...(params?._meta && typeof params._meta === 'object' ? params._meta : {}),
      };

      if (typeof toolName !== 'string' || !toolName) {
        return makeJsonRpcError(id, -32602, 'Invalid params: missing tool "name"');
      }

      const outcome = await registry.callTool(toolName, toolArgs, toolMeta);
      const text = typeof outcome.data === 'string'
        ? outcome.data
        : JSON.stringify(outcome.data, null, 2);

      return makeJsonRpcResult(id, {
        content: [{ type: 'text', text }],
        ...(outcome.isError ? { isError: true } : {}),
      });
    }

    if (isNotification) return null;
    return makeJsonRpcError(id, -32601, `Method not found: ${method}`);
  }

  function writeResponse(payload) {
    if (!payload) return;
    output.write(`${JSON.stringify(payload)}\n`);
  }

  function start() {
    const rl = readline.createInterface({
      input,
      crlfDelay: Infinity,
      terminal: false,
    });

    // Serialize async message processing to preserve JSON-RPC ordering
    let chain = Promise.resolve();

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      chain = chain
        .then(async () => {
          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch (err) {
            writeResponse(makeJsonRpcError(null, -32700, `Parse error: ${err.message}`));
            return;
          }
          const resp = await handleMessage(parsed);
          writeResponse(resp);
        })
        .catch((err) => {
          process.stderr.write(`[cortex-mcp] internal error: ${err?.stack || err}\n`);
        });
    });

    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });

    rl.once('close', () => {
      chain.finally(() => resolveDone());
    });

    return {
      rl,
      done,
      whenIdle() {
        return chain;
      },
      close() {
        rl.close();
      },
    };
  }

  return {
    registry,
    handleMessage,
    start,
  };
}

function parseCliOptions(argv) {
  const opts = {
    projectDir: process.env.HERDR_CORTEX_PROJECT || process.cwd(),
    globalDir: process.env.HERDR_CORTEX_HOME || undefined,
    promptsDir: path.join(REPO_ROOT, 'prompts'),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' && argv[i + 1]) opts.projectDir = path.resolve(argv[++i]);
    else if (a === '--global' && argv[i + 1]) opts.globalDir = path.resolve(argv[++i]);
    else if (a === '--prompts' && argv[i + 1]) opts.promptsDir = path.resolve(argv[++i]);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const opts = parseCliOptions(process.argv.slice(2));
  const config = loadConfig({ projectDir: opts.projectDir, globalDir: opts.globalDir });
  const store = new CortexStore({
    projectDir: opts.projectDir,
    globalDir: opts.globalDir,
    config,
  });

  let cachedProviderPromise = null;
  const getEmbeddingProvider = () => {
    if (!cachedProviderPromise) {
      cachedProviderPromise = resolveEmbeddingProvider(config).catch(() => null);
    }
    return cachedProviderPromise;
  };

  const embeddingQueue = createEmbeddingQueue(store, {
    getProvider: getEmbeddingProvider,
    debounceMs: 200,
  });

  const server = createMcpServer({
    store,
    promptsDir: opts.promptsDir,
    getEmbeddingProvider,
    embeddingQueue,
  });

  const handle = server.start();

  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    embeddingQueue.cancel();
    handle.close();
    store.close();
  };

  handle.done.finally(shutdown);
  process.on('SIGINT', () => {
    handle.close();
    handle.done.finally(() => {
      shutdown();
      process.exit(0);
    });
  });
  process.on('SIGTERM', () => {
    handle.close();
    handle.done.finally(() => {
      shutdown();
      process.exit(0);
    });
  });
}
