import path from 'node:path';
import readline from 'node:readline';
import { CortexStore, DEFAULT_TOOL_SYNC_LIMITS } from '../core/store.mjs';
import { readDeferredIndex, syncFromDiskShared } from '../core/db.mjs';
import { REPO_ROOT, isMainModule, isProjectEnabled, loadConfig } from '../core/config.mjs';
import {
  createEmbeddingQueue,
  embeddingSelectionKey,
  getSharedEmbeddingBreaker,
  resolveEmbeddingProvider,
} from '../embeddings/index.mjs';
import { INBOX_DELIVERED_RETENTION_MS } from '../relay/inbox.mjs';
import { createRelayTools } from '../relay/tools.mjs';
import { createToolRegistry } from './tools.mjs';

export const SERVER_INFO = Object.freeze({
  name: 'herdr-cortex',
  version: '1.1.1',
});

export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/** How long after the server starts the background index catch-up begins. */
export const INDEX_CATCH_UP_DELAY_MS = 250;
/** How long after a tool call left documents out the catch-up starts again (the answer goes out first). */
export const INDEX_CATCH_UP_REQUEST_DELAY_MS = 50;

/**
 * The background index catch-up of a long-lived process.
 *
 * It indexes what was left out elsewhere: by the session-start hooks (too big or too slow for a hook's time
 * budget), and by the tool calls of this process, whose own sync has a small time budget so that a call
 * never waits for large or many documents (`toolSyncLimits` of the store). Nothing is ever excluded: what a
 * limited sync leaves out is indexed here.
 *
 * - The first pass starts `delayMs` after the call and covers both tiers of `store`.
 * - `request({ scope, projectRoot })` asks for another pass of one tier (the store calls it through
 *   `onSyncDeferred`). A request for another project (`projectRoot` differs from the store's; a tool call
 *   with `project_dir`) is served with a store opened for that pass through `openProjectStore`.
 * - Every pass is the yielding, shared sync (`syncFromDiskShared`): the event loop gets a turn after every
 *   file, so tool calls that arrive meanwhile are answered between two files, and a sync the embedding queue
 *   started on the same connection is joined, not repeated. One file is still indexed in one piece: while a
 *   very large document is being read, a tool call waits for that one document.
 * - `onIndexed(scope, result, { projectDir })` is called for a tier that got new or changed documents.
 * - When a hook had left documents out (the tier's deferred-index record), one line on stderr says what
 *   became of them.
 *
 * Returns { done, request, whenIdle, cancel }: `done` resolves with the results of the first pass, per tier
 * the sync result plus `waitingBefore`, the number of documents the record listed ({} when cancelled before
 * the start); `whenIdle()` resolves when no pass is running and none is asked for.
 */
export function startIndexCatchUp(
  store,
  {
    delayMs = INDEX_CATCH_UP_DELAY_MS,
    requestDelayMs = INDEX_CATCH_UP_REQUEST_DELAY_MS,
    onIndexed = null,
    openProjectStore = null,
    log = (line) => process.stderr.write(`${line}\n`),
  } = {},
) {
  let cancelled = false;
  let timer = null;
  let running = null;
  let firstPassDone = false;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const idleWaiters = [];

  const pendingScopes = new Set(['project', 'global']);
  const pendingProjects = new Map(); // normalized project root -> project root
  const hasPending = () => pendingScopes.size > 0 || pendingProjects.size > 0;
  const pathKey = (dir) => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));

  const syncTier = async (tier, scope, extra = {}) => {
    const waitingBefore = readDeferredIndex(tier.dir).count;
    const result = await syncFromDiskShared(tier.db, tier.dir, { isCancelled: () => cancelled });
    if (result.cancelled) return { ...result, waitingBefore };
    if (waitingBefore > 0 && typeof log === 'function') {
      const stillFailing = result.failed?.length || 0;
      log(
        `[herdr-cortex-mcp] index catch-up (${scope}): ${waitingBefore} document(s) had been left out by a hook or a tool call; `
        + `indexed ${result.addedOrUpdated}${stillFailing > 0 ? `, ${stillFailing} could not be indexed` : ''}`,
      );
    }
    if (result.addedOrUpdated > 0 && typeof onIndexed === 'function') {
      onIndexed(scope, result, extra);
    }
    return { ...result, waitingBefore };
  };

  const runPass = async (scopes, projects) => {
    const results = {};
    for (const scope of ['project', 'global']) {
      if (cancelled || !scopes.includes(scope)) continue;
      try {
        const tier = store.getTierIfExists(scope);
        if (tier) results[scope] = await syncTier(tier, scope);
      } catch (err) {
        results[scope] = { error: String(err?.message || err) };
      }
    }
    for (const projectDir of projects) {
      if (cancelled || typeof openProjectStore !== 'function') continue;
      let other = null;
      try {
        other = openProjectStore(projectDir);
        const tier = other.getTierIfExists('project');
        if (tier) await syncTier(tier, 'project', { projectDir });
      } catch {
        // another project's index is brought up to date by the next call that needs it
      } finally {
        try {
          if (other) other.close();
        } catch {
          // ignore close errors
        }
      }
    }
    return results;
  };

  const settleIdle = () => {
    if (running || timer || (hasPending() && !cancelled)) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const pump = () => {
    if (running || cancelled) return;
    running = (async () => {
      while (!cancelled && hasPending()) {
        const scopes = [...pendingScopes];
        pendingScopes.clear();
        const projects = [...pendingProjects.values()];
        pendingProjects.clear();
        const results = await runPass(scopes, projects);
        if (!firstPassDone) {
          firstPassDone = true;
          finish(results);
        }
      }
    })().catch(() => {}).finally(() => {
      running = null;
      if (!firstPassDone) {
        firstPassDone = true;
        finish({});
      }
      // A request that came in after the last round was checked still gets its pass.
      if (hasPending() && !cancelled) arm(0);
      settleIdle();
    });
  };

  // Plan a pass after `ms`, unless one is already planned for an earlier moment or one is running.
  // (a function declaration, so that the pass above can ask for the next one)
  let timerDue = 0;
  function arm(ms) {
    if (running || cancelled) return;
    const delay = Math.max(0, Number(ms) || 0);
    const due = Date.now() + delay;
    if (timer && timerDue <= due) return;
    if (timer) clearTimeout(timer);
    timerDue = due;
    timer = setTimeout(() => {
      timer = null;
      pump();
      settleIdle();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  arm(delayMs);

  return {
    done,
    /** Ask for another pass: `scope` 'project' | 'global'; `projectRoot` when it is another project's tier. */
    request({ scope = 'project', projectRoot = '' } = {}) {
      if (cancelled) return;
      const otherProject = scope === 'project' && projectRoot && pathKey(projectRoot) !== pathKey(store.projectRoot);
      if (otherProject) pendingProjects.set(pathKey(projectRoot), projectRoot);
      else pendingScopes.add(scope === 'global' ? 'global' : 'project');
      // A pass that is running picks the request up when it finishes its current round.
      arm(requestDelayMs);
    },
    whenIdle() {
      if (!running && !timer && !(hasPending() && !cancelled)) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    cancel() {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!running && !firstPassDone) {
        firstPassDone = true;
        finish({});
      }
      settleIdle();
    },
  };
}

/**
 * A retention time in Korean words ("24시간", "1시간", "90분"), for the Korean server instructions. Derived
 * from the constant so the text cannot drift from the behavior (the English tool descriptions use
 * `describeRetention` of the inbox module the same way).
 */
export function describeRetentionKorean(retentionMs = INBOX_DELIVERED_RETENTION_MS) {
  const ms = Math.max(0, Number(retentionMs) || 0);
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1 && Number.isInteger(hours)) return `${hours}시간`;
  return `${Math.round(ms / (60 * 1000))}분`;
}

export const SERVER_INSTRUCTIONS = `herdr-cortex MCP 도구 안내 (서버 이름: herdr-cortex, 도구 전체 이름: mcp__herdr-cortex__<도구>):
- 기억 조회: memory_overview(활성 세션·결정·할 일), memory_search(하이브리드 1단계 요약), memory_read(전문), memory_graph(1~10홉 계보·파일 영향).
- 기억 저장(메인 HEAD 전용, 서브에이전트 읽기 전용): memory_save(type: decision|worklog|knowledge|todo|baseline, supersedes, derived_from, files, scope: project|global, global 선호는 category: "preferences") 및 memory_update(status: active|done|superseded|archived, supersedes: 대체할 문서 ID — memory_save와 같은 전이).
- 멀티 워크스페이스: 필요 시 memory_* 도구에 project_dir 지정 가능.
- 색인 대기: memory_* 결과에 indexing { pending, documents }가 있으면 그 문서들은 아직 색인 중이라(백그라운드에서 처리) 결과에 빠져 있을 수 있음.
- Herdr 탭 협업: relay_tabs(탭 조회), relay_send(context_docs 첨부, HEAD 전용), relay_inbox(action: peek|ack; 훅이 이미 주입한 메시지는 ${describeRetentionKorean()} 보관되며 include_delivered: true로 다시 조회).
- 프롬프트 로드: cortex_prompt로 start-job, product-planning, delegate, independent-review, plan-run(kind: "skill"), DEVELOPMENT_STANDARD(kind: "standard"), coder/developer/reviewer(kind: "agent") 로드.`;

/**
 * The instructions of a server whose project is excluded. Every statement follows the tool handlers
 * (`tools.mjs`, `../relay/tools.mjs`); a test calls each tool the text names and compares.
 */
export const EXCLUDED_SERVER_INSTRUCTIONS = `herdr-cortex MCP 안내: 현재 프로젝트는 herdr-cortex 설정(excludedProjects/opt-in)에 의해 제외되어 있습니다. 이 프로젝트의 기억은 읽지도 쓰지도 않고 .memory/도 만들지 않습니다. 이 프로젝트에 대해 막히는 것과 되는 것은 다음과 같습니다.
- 차단(오류 PROJECT_EXCLUDED): scope: "global"을 명시하지 않은 memory_save·memory_update(기본값이 각각 project, all이라 생략해도 차단), scope: "project"인 memory_read, 그리고 relay_tabs/relay_send/relay_inbox 전부.
- 전역 기억 조회: memory_search·memory_read·memory_graph는 scope가 "global" 또는 "all"이면 전역 기억만으로 답하고(memory_graph는 기본값이 project이므로 scope를 적어야 함), memory_overview는 전역 선호만 담음.
- 전역 기억 저장(메인 HEAD 전용): memory_save·memory_update에 scope: "global"을 명시하면 동작.
- 표시: memory_search·memory_graph가 프로젝트 기억을 빼고 답하면 결과에 projectExcluded: true가 붙음(scope: "project"이면 오류 없이 빈 결과, "all"이면 전역 결과만). scope: "global"만 요청한 호출에는 붙지 않음.
- cortex_prompt는 평소대로 동작.
- project_dir로 다른 프로젝트를 지정한 memory_* 호출은 그 프로젝트의 제외·승인 여부로 판정(위 제한은 현재 프로젝트에만 해당).`;

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
  getEmbeddingProviders = null,
  embeddingQueue = null,
  embeddingBreaker = null,
  hcClient = null,
  projectEnabled = null,
  includeRelayTools = true,
  extraTools = [],
  env = process.env,
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
        env,
      })
    : [];

  const registry = createToolRegistry(store, {
    promptsDir,
    getEmbeddingProvider,
    getEmbeddingProviders,
    embeddingQueue,
    embeddingBreaker,
    projectEnabled: effectiveProjectEnabled,
    extraTools: [...defaultRelayTools, ...extraTools],
    env,
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
            process.stderr.write(`[herdr-cortex-mcp] internal error: ${err?.stack || err}\n`);
            if (parsed && typeof parsed === 'object' && parsed.id !== undefined) {
              writeResponse(makeJsonRpcError(parsed.id, -32603, err?.message || 'Internal error'));
            }
          }
        })
        .catch((err) => {
          process.stderr.write(`[herdr-cortex-mcp] fatal chain error: ${err?.stack || err}\n`);
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
    // Without --global the store is located by `resolveGlobalDir` (HERDR_CORTEX_HOME, the test home, the user's home).
    globalDir: undefined,
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
 * Assemble what the stdio entry point runs with: merged config, store, embedding providers, the circuit breaker
 * shared by search and the document queue, the queue itself, and the MCP server.
 * A process can hold two providers: the project tier is embedded and searched with the provider this
 * project's settings select, the global tier (shared by every project) with the one the global settings
 * select; when both select the same one, a single instance serves both.
 * Documents that are still waiting for an embedding are scheduled right away, so work left over from an earlier
 * session or an outage does not wait for the next save.
 * Shortly after the start (`indexCatchUpDelayMs`, a negative value turns it off) the index catch-up runs in the
 * background, see `startIndexCatchUp`. The store gets tool sync limits (`toolSyncLimits`, default
 * `DEFAULT_TOOL_SYNC_LIMITS`; `null` turns them off): a tool call indexes what fits its small budget, answers
 * from what is indexed, names what is still waiting in the result's `indexing` field, and the catch-up
 * indexes the rest. With the catch-up turned off the limits are off as well, so nothing is left unindexed.
 * `embeddingProvider` (one provider for every tier), `embeddingProviders` ({ project, global }),
 * `embeddingBreaker`, `input` and `output` are injectable for tests.
 */
export function createServerRuntime({
  projectDir = process.cwd(),
  globalDir,
  promptsDir = path.join(REPO_ROOT, 'prompts'),
  embeddingProvider = null,
  embeddingProviders = null,
  embeddingBreaker = null,
  hcClient = null,
  queueDebounceMs = 200,
  indexCatchUpDelayMs = INDEX_CATCH_UP_DELAY_MS,
  indexCatchUpRequestDelayMs = INDEX_CATCH_UP_REQUEST_DELAY_MS,
  toolSyncLimits = DEFAULT_TOOL_SYNC_LIMITS,
  env = process.env,
  input,
  output,
} = {}) {
  const config = loadConfig({ projectDir, globalDir });
  const projectEnabled = isProjectEnabled(projectDir, config);
  const catchUpEnabled = Number(indexCatchUpDelayMs) >= 0;
  // Assigned below; the store only reports what its limited syncs left out.
  let indexCatchUp = null;
  const store = new CortexStore({
    projectDir,
    globalDir,
    config,
    // Limited tool syncs need the catch-up to finish their work: without it every sync indexes everything.
    toolSyncLimits: catchUpEnabled ? toolSyncLimits : null,
    onSyncDeferred: ({ scope, projectRoot }) => {
      if (indexCatchUp) indexCatchUp.request({ scope, projectRoot });
    },
  });

  const breaker = embeddingBreaker
    || getSharedEmbeddingBreaker({ cooldownMs: config.embedding?.circuitBreakMs });

  // One provider instance per distinct selection (provider + its settings), created on first use.
  const providerCache = new Map();
  const providerForConfig = (cfg) => {
    const key = embeddingSelectionKey(cfg);
    // Nothing selected: still ask once, so a configuration problem is reported on stderr.
    if (!key) return resolveEmbeddingProvider(cfg).catch(() => null);
    if (!providerCache.has(key)) {
      providerCache.set(key, resolveEmbeddingProvider(cfg).catch(() => {
        providerCache.delete(key);
        return null;
      }));
    }
    return providerCache.get(key);
  };

  // { project, global } for a store (this server's, or one opened for a `project_dir` call): its own settings
  // for the project tier, the global settings (no project overlay) for the global tier.
  const getEmbeddingProviders = async (targetStore = store) => {
    if (embeddingProvider) return { project: embeddingProvider, global: embeddingProvider };
    if (embeddingProviders) {
      return { project: embeddingProviders.project || null, global: embeddingProviders.global || null };
    }
    const [projectProvider, globalProvider] = await Promise.all([
      providerForConfig(targetStore.config),
      providerForConfig(targetStore.globalConfig),
    ]);
    return { project: projectProvider, global: globalProvider };
  };
  // The project tier's provider (kept for callers that deal with one tier).
  const getEmbeddingProvider = async () => (await getEmbeddingProviders(store)).project;

  const embeddingQueue = createEmbeddingQueue(store, {
    getProviders: () => getEmbeddingProviders(store),
    debounceMs: queueDebounceMs,
    breaker,
    // A save made with `project_dir` is embedded with that project's own settings, in a store opened for the run.
    openProjectStore: (otherProjectDir) => new CortexStore({ projectDir: otherProjectDir, globalDir: store.globalDir }),
    getProviderFor: async (otherStore) => (await getEmbeddingProviders(otherStore)).project,
  });

  const server = createMcpServer({
    store,
    promptsDir,
    getEmbeddingProviders,
    embeddingQueue,
    embeddingBreaker: breaker,
    hcClient,
    projectEnabled,
    env,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  });

  embeddingQueue.schedule('all');

  // Documents a hook or a tool call deferred are indexed here; what gets indexed is then queued for embedding.
  indexCatchUp = catchUpEnabled
    ? startIndexCatchUp(store, {
        delayMs: indexCatchUpDelayMs,
        requestDelayMs: indexCatchUpRequestDelayMs,
        openProjectStore: (otherProjectDir) => new CortexStore({ projectDir: otherProjectDir, globalDir: store.globalDir }),
        onIndexed: (scope, _result, { projectDir: otherProjectDir } = {}) => (
          otherProjectDir ? embeddingQueue.schedule(scope, { projectDir: otherProjectDir }) : embeddingQueue.schedule(scope)
        ),
      })
    : { done: Promise.resolve({}), request() {}, whenIdle: () => Promise.resolve(), cancel() {} };

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    indexCatchUp.cancel();
    try {
      await indexCatchUp.whenIdle();
    } catch {
      // ignore catch-up errors on shutdown
    }
    try {
      await embeddingQueue.drain(3000);
    } catch {
      // ignore drain errors on shutdown
    }
    store.close();
  };

  return {
    config,
    store,
    server,
    embeddingQueue,
    indexCatchUp,
    embeddingBreaker: breaker,
    getEmbeddingProvider,
    getEmbeddingProviders,
    shutdown,
  };
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
