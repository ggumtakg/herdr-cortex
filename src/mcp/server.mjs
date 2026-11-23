import path from 'node:path';
import readline from 'node:readline';
import { CortexStore } from '../core/store.mjs';
import { REPO_ROOT, isMainModule, isProjectEnabled, loadConfig } from '../core/config.mjs';
import {
  createEmbeddingQueue,
  getSharedEmbeddingBreaker,
  resolveEmbeddingProvider,
} from '../embeddings/index.mjs';
import { createRelayTools } from '../relay/tools.mjs';
import { createToolRegistry } from './tools.mjs';

export const SERVER_INFO = Object.freeze({
  name: 'cortex',
  version: '1.0.0',
});

export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

export const SERVER_INSTRUCTIONS = `herdr-cortex MCP 도구 안내:
- 기억 조회: memory_overview(활성 세션·결정·할 일), memory_search(하이브리드 1단계 요약), memory_read(전문), memory_graph(1~10홉 계보·파일 영향).
- 기억 저장(메인 HEAD 전용, 서브에이전트 읽기 전용): memory_save(type: decision|worklog|knowledge|todo|baseline, supersedes, derived_from, files, scope: project|global, global 선호는 category: "preferences") 및 memory_update(status: active|done|superseded|archived, supersedes: 대체할 문서 ID — memory_save와 같은 전이).
- 멀티 워크스페이스: 필요 시 memory_* 도구에 project_dir 지정 가능.
- Herdr 탭 협업: relay_tabs(탭 조회), relay_send(context_docs 첨부, HEAD 전용), relay_inbox(action: peek|ack).
- 프롬프트 로드: cortex_prompt로 start-job, product-planning, delegate, independent-review, plan-run(kind: "skill"), DEVELOPMENT_STANDARD(kind: "standard"), coder/developer/reviewer(kind: "agent") 로드.`;

export const EXCLUDED_SERVER_INSTRUCTIONS = `herdr-cortex MCP 안내: 현재 프로젝트는 herdr-cortex 설정(excludedProjects/opt-in)에 의해 제외되어 있습니다. 프로젝트 기억 쓰기·relay_send 및 .memory/ 생성이 차단되며, scope: "global" 조회와 cortex_prompt만 사용할 수 있습니다.`;

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
  embeddingBreaker = null,
  hcClient = null,
  projectEnabled = null,
  includeRelayTools = true,
  extraTools = [],
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const effectiveProjectEnabled = typeof projectEnabled === 'boolean'
    ? projectEnabled
    : (store
        ? isProjectEnabled(
            store.projectRoot,
            store.config || loadConfig({ projectDir: store.projectRoot, globalDir: store.globalDir }),
          )
        : true);

  const defaultRelayTools = includeRelayTools && store
    ? createRelayTools({
        projectDir: store.projectRoot,
        globalDir: store.globalDir,
        hcClient,
        store,
        projectEnabled: effectiveProjectEnabled,
      })
    : [];

  const registry = createToolRegistry(store, {
    promptsDir,
    getEmbeddingProvider,
    embeddingQueue,
    embeddingBreaker,
    projectEnabled: effectiveProjectEnabled,
    extraTools: [...defaultRelayTools, ...extraTools],
  });

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      return makeJsonRpcError(null, -32600, 'Invalid Request');
    }

    // A JSON-RPC batch (array payload) is answered with one error instead of being dropped silently.
    if (Array.isArray(msg)) {
      return makeJsonRpcError(null, -32600, 'Invalid Request: JSON-RPC batch requests are not supported; send one request per line');
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
        instructions: effectiveProjectEnabled ? SERVER_INSTRUCTIONS : EXCLUDED_SERVER_INSTRUCTIONS,
      });
    }

    if (
      method === 'notifications/initialized'
      || method === 'initialized'
      || method === 'notifications/roots/list_changed'
    ) {
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
      const rawArgs = params?.arguments;
      // `arguments` must be a JSON object; an array or a scalar is a malformed call, not an empty one.
      if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
        return isNotification
          ? null
          : makeJsonRpcError(id, -32602, 'Invalid params: tool "arguments" must be an object');
      }
      const toolArgs = rawArgs || {};
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
          try {
            const resp = await handleMessage(parsed);
            writeResponse(resp);
          } catch (err) {
            process.stderr.write(`[cortex-mcp] internal error: ${err?.stack || err}\n`);
            if (parsed && typeof parsed === 'object' && parsed.id !== undefined) {
              writeResponse(makeJsonRpcError(parsed.id, -32603, err?.message || 'Internal error'));
            }
          }
        })
        .catch((err) => {
          process.stderr.write(`[cortex-mcp] fatal chain error: ${err?.stack || err}\n`);
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

/**
 * Assemble what the stdio entry point runs with: merged config, store, embedding provider, the circuit breaker
 * shared by search and the document queue, the queue itself, and the MCP server.
 * Documents that are still waiting for an embedding are scheduled right away, so work left over from an earlier
 * session or an outage does not wait for the next save.
 * `embeddingProvider`, `embeddingBreaker`, `input` and `output` are injectable for tests.
 */
export function createServerRuntime({
  projectDir = process.cwd(),
  globalDir,
  promptsDir = path.join(REPO_ROOT, 'prompts'),
  embeddingProvider = null,
  embeddingBreaker = null,
  hcClient = null,
  queueDebounceMs = 200,
  input,
  output,
} = {}) {
  const config = loadConfig({ projectDir, globalDir });
  const projectEnabled = isProjectEnabled(projectDir, config);
  const store = new CortexStore({ projectDir, globalDir, config });

  const breaker = embeddingBreaker
    || getSharedEmbeddingBreaker({ cooldownMs: config.embedding?.circuitBreakMs });

  let cachedProviderPromise = null;
  const getEmbeddingProvider = () => {
    if (embeddingProvider) return Promise.resolve(embeddingProvider);
    if (!cachedProviderPromise) {
      cachedProviderPromise = resolveEmbeddingProvider(config).catch(() => {
        cachedProviderPromise = null;
        return null;
      });
    }
    return cachedProviderPromise;
  };

  const embeddingQueue = createEmbeddingQueue(store, {
    getProvider: getEmbeddingProvider,
    debounceMs: queueDebounceMs,
    breaker,
    // A save made with `project_dir` is embedded with that project's own settings, in a store opened for the run.
    openProjectStore: (otherProjectDir) => new CortexStore({ projectDir: otherProjectDir, globalDir: store.globalDir }),
    getProviderFor: (otherStore) => (
      embeddingProvider ? Promise.resolve(embeddingProvider) : resolveEmbeddingProvider(otherStore.config)
    ),
  });

  const server = createMcpServer({
    store,
    promptsDir,
    getEmbeddingProvider,
    embeddingQueue,
    embeddingBreaker: breaker,
    hcClient,
    projectEnabled,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  });

  embeddingQueue.schedule('all');

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await embeddingQueue.drain(3000);
    } catch {
      // ignore drain errors on shutdown
    }
    store.close();
  };

  return { config, store, server, embeddingQueue, embeddingBreaker: breaker, getEmbeddingProvider, shutdown };
}

if (isMainModule(import.meta.url)) {
  const opts = parseCliOptions(process.argv.slice(2));
  const runtime = createServerRuntime({
    projectDir: opts.projectDir,
    globalDir: opts.globalDir,
    promptsDir: opts.promptsDir,
  });
  const { server } = runtime;

  const handle = server.start();

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    handle.close();
    await runtime.shutdown();
  };

  handle.done.finally(() => {
    shutdown().catch(() => {});
  });
  process.on('SIGINT', () => {
    handle.close();
    handle.done.finally(async () => {
      await shutdown();
      process.exit(0);
    });
  });
  process.on('SIGTERM', () => {
    handle.close();
    handle.done.finally(async () => {
      await shutdown();
      process.exit(0);
    });
  });
}
