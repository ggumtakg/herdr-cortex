import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_CONFIG,
  LEGACY_EMBEDDING_KEYS,
  LEGACY_EMBEDDING_KEY_TARGETS,
  REPO_ROOT,
  atomicWriteJson,
  atomicWriteText,
  formatLegacyEmbeddingContextNotice,
  formatLegacyEmbeddingUserNotices,
  getConfigProblems,
  loadConfig,
  projectPathKey,
  sanitizeProjectConfig,
} from '../src/core/config.mjs';
import { CortexStore } from '../src/core/store.mjs';
import { readIndexMeta } from '../src/core/db.mjs';
import { searchMemory } from '../src/core/search.mjs';
import {
  MAX_EMBED_ATTEMPTS,
  MAX_EMBED_SERVICE_FAILURES,
  classifyEmbeddingError,
  createEmbeddingBreaker,
  createEmbeddingQueue,
  describeEmbeddingStatus,
  formatEmbeddingStatus,
  listFailedEmbeddings,
  processPendingEmbeddings,
  resolveEmbeddingProvider,
  retryFailedEmbeddings,
} from '../src/embeddings/index.mjs';
import { createGeminiProvider } from '../src/embeddings/gemini.mjs';
import { createOpenAIProvider } from '../src/embeddings/openai.mjs';
import { createOllamaProvider } from '../src/embeddings/ollama.mjs';
import { EMBED_CLI_SCOPES, runEmbedCli } from '../src/embeddings/cli.mjs';
import { installCortex } from '../src/hooks/installer.mjs';
import { handleClaudeSessionStart } from '../src/hooks/claude.mjs';
import { handleAntigravityPreInvocation, handleAntigravitySessionStart } from '../src/hooks/antigravity.mjs';
import { SERVER_INSTRUCTIONS, createMcpServer, createServerRuntime } from '../src/mcp/server.mjs';
import { createToolRegistry } from '../src/mcp/tools.mjs';
import { approveAsUser } from './support/approve.mjs';

// ---------------------------------------------------------------------------------------------
// Safety net: nothing in this file may reach a real network host. Requests to the local stub
// servers started by the tests pass through; anything else is recorded and rejected.
// ---------------------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
const blockedFetches = [];
globalThis.fetch = (input, init) => {
  const url = String(typeof input === 'string' ? input : input?.url || input);
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = '';
  }
  if (hostname === '127.0.0.1' || hostname === 'localhost') {
    return realFetch(input, init);
  }
  blockedFetches.push(url);
  return Promise.reject(new TypeError(`network access is not allowed in tests: ${url}`));
};

const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');
// What listFailedEmbeddings reports for a tier with no given-up document.
const NO_FAILED_DOCUMENTS = { count: 0, ids: [], documents: [], byReason: { document_errors: 0, service_failures: 0 } };
const EMBEDDING_ENV_NAMES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST'];

function makeTempEnv(prefix = 'herdr-cortex-emb-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  // The project folder of every test environment is approved, as a user would do with cortex-trust.
  approveAsUser(projectDir, { globalDir });
  fs.mkdirSync(homeDir, { recursive: true });
  return {
    root,
    projectDir,
    globalDir,
    homeDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeGlobalConfig(env, config) {
  atomicWriteJson(path.join(env.globalDir, 'config.json'), config);
}

function writeProjectConfig(projectDir, config) {
  atomicWriteJson(path.join(projectDir, '.memory', 'config.json'), config);
}

// Environment for child processes: temp directories only, and no embedding credentials or hosts.
function childEnv(env) {
  const out = {
    ...process.env,
    HERDR_CORTEX_HOME: env.globalDir,
    HERDR_CORTEX_TEST_HOME: env.homeDir,
    HERDR_CORTEX_PROJECT: env.projectDir,
  };
  for (const name of [...EMBEDDING_ENV_NAMES, 'HC_TERMINAL_ID']) delete out[name];
  return out;
}

function captureWarnings() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  return {
    lines,
    restore() {
      console.error = original;
    },
  };
}

function makeSink() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 10, label = 'condition' } = {}) {
  const started = Date.now();
  while (true) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFailure(mode) {
  if (mode === 'timeout') {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    return err;
  }
  if (mode === 'network') {
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    return err;
  }
  const status = Number(mode);
  const err = new Error(`Fake embedding failed (${status})`);
  err.status = status;
  return err;
}

/**
 * Embedding provider double. `state.mode` is 'ok', 'hang', a failure name understood by `makeFailure`
 * ('timeout' | 'network' | '400' | '401' | '429' | '503' ...), or a function (texts, options) => one of those.
 */
function makeProvider({ name = 'mock', model = 'mock-embed-v1', dimensions = 4 } = {}) {
  const state = { calls: 0, mode: 'ok', options: [], texts: [] };
  return {
    name,
    model,
    dimensions,
    state,
    async embed(texts, options = {}) {
      state.calls++;
      state.options.push(options);
      state.texts.push(texts);
      const mode = typeof state.mode === 'function' ? state.mode(texts, options) : state.mode;
      if (mode === 'hang') return new Promise(() => {});
      if (mode !== 'ok') throw makeFailure(mode);
      return texts.map(() => new Float32Array([1, 0, 0, 0]));
    },
  };
}

function embedRow(store, scope, id) {
  const row = store.getTier(scope).db
    .prepare('SELECT embed_status, embed_attempts, embed_error FROM docs WHERE id = ?')
    .get(id);
  return row ? { ...row } : undefined;
}

function vectorCount(store, scope, id) {
  return store.getTier(scope).db
    .prepare('SELECT COUNT(*) AS cnt FROM doc_chunks_vec WHERE doc_id = ?')
    .get(id).cnt;
}

function saveNote(store, id, extra = {}) {
  return store.saveDoc({
    id,
    type: 'knowledge',
    title: `Note ${id}`,
    summary: `Summary of ${id}`,
    content: `Body text of ${id} about harbor logistics.`,
    ...extra,
  });
}

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

/**
 * Local stand-in for an Ollama server: answers POST /api/embed with one vector (`vector`) per input.
 */
async function startStubEmbedServer({ vector = [1, 0, 0, 0] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const inputs = Array.isArray(body.input) ? body.input : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings: inputs.map(() => vector) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// A. Embedding is off unless the user turns it on
// ---------------------------------------------------------------------------------------------

test('embedding default: provider is "none", so keys in the environment send nothing; "auto" must be chosen explicitly', async () => {
  const env = makeTempEnv('cortex-emb-default-');
  try {
    assert.equal(DEFAULT_CONFIG.embedding.provider, 'none');

    const keysPresent = { GEMINI_API_KEY: 'test-gemini-key', OPENAI_API_KEY: 'test-openai-key', OLLAMA_HOST: '127.0.0.1:1' };
    const fetchCalls = [];
    const fetchImpl = async (url) => {
      fetchCalls.push(url);
      throw new Error('unexpected request');
    };

    // No config file at all
    const untouched = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    assert.equal(untouched.embedding.provider, 'none');
    assert.equal(await resolveEmbeddingProvider(untouched, { env: keysPresent, fetchImpl }), null);

    // A config file that does not mention the provider, and "embedding" sections without one
    writeGlobalConfig(env, { hookBudget: 8000, embedding: { chunkMaxChars: 500 } });
    const silent = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    assert.equal(await resolveEmbeddingProvider(silent, { env: keysPresent, fetchImpl }), null);
    assert.equal(await resolveEmbeddingProvider({ embedding: {} }, { env: keysPresent, fetchImpl }), null);
    assert.equal(await resolveEmbeddingProvider({}, { env: keysPresent, fetchImpl }), null);

    const status = describeEmbeddingStatus(silent, { env: keysPresent, breaker: createEmbeddingBreaker() });
    assert.equal(status.setting, 'none');
    assert.equal(status.provider, null);
    assert.equal(status.enabled, false);
    assert.equal(status.host, null);
    assert.deepEqual(status.problems, []);

    // "auto" still exists, as an explicit choice (also when written with other casing)
    for (const spelling of ['auto', ' Auto ']) {
      writeGlobalConfig(env, { embedding: { provider: spelling } });
      const auto = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
      const provider = await resolveEmbeddingProvider(auto, { env: keysPresent, fetchImpl });
      assert.equal(provider.name, 'gemini');
    }

    assert.deepEqual(fetchCalls, [], 'resolving a provider must not send anything');
    assert.deepEqual(blockedFetches, []);
  } finally {
    env.cleanup();
  }
});

test('embedding provider typo: an unknown name is a configuration error (no embedding), reported by status and by npm run embed', async () => {
  const env = makeTempEnv('cortex-emb-typo-');
  const warnings = captureWarnings();
  const prevExitCode = process.exitCode;
  try {
    const keysPresent = { GEMINI_API_KEY: 'test-gemini-key', OPENAI_API_KEY: 'test-openai-key', OLLAMA_HOST: '127.0.0.1:1' };
    writeGlobalConfig(env, { embedding: { provider: 'nome', onnx: { enabled: true } } });
    const config = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });

    // Does not fall through to "auto" even though every auto candidate is available
    assert.equal(await resolveEmbeddingProvider(config, { env: keysPresent }), null);
    assert.equal(await resolveEmbeddingProvider(config, { env: keysPresent }), null);
    const typoWarnings = warnings.lines.filter((line) => line.includes('"nome"'));
    assert.equal(typoWarnings.length, 1, 'the unknown provider is reported once per process');
    assert.match(typoWarnings[0], /Unknown embedding\.provider "nome"/);
    assert.match(typoWarnings[0], /none, auto, gemini, openai, ollama, onnx/);

    const status = describeEmbeddingStatus(config, { env: keysPresent, breaker: createEmbeddingBreaker() });
    assert.equal(status.setting, 'nome');
    assert.equal(status.provider, null);
    assert.equal(status.enabled, false);
    assert.equal(status.problems.length, 1);
    assert.equal(status.problems[0].code, 'unknown_provider');
    assert.equal(status.problems[0].value, 'nome');

    // Other non-names are errors too, not "auto"
    for (const bad of ['gemini-pro', 'true', 42, true, ['gemini']]) {
      assert.equal(await resolveEmbeddingProvider({ embedding: { provider: bad } }, { env: keysPresent }), null);
      const badStatus = describeEmbeddingStatus({ embedding: { provider: bad } }, { env: keysPresent, breaker: createEmbeddingBreaker() });
      assert.equal(badStatus.problems[0].code, 'unknown_provider', `provider ${JSON.stringify(bad)}`);
    }

    // npm run embed: says so before doing anything, summary carries the reason, exit code 1
    const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, config });
    saveNote(store, 'typo-pending');
    store.close();

    const stdout = makeSink();
    const stderr = makeSink();
    process.exitCode = 0;
    const summary = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir],
      { env: keysPresent, stdout, stderr },
    );
    assert.equal(summary.provider, null);
    assert.equal(summary.reason, 'invalid_provider');
    assert.match(summary.error, /Unknown embedding\.provider "nome"/);
    assert.equal(summary.processed, 0);
    assert.equal(process.exitCode, 1);
    assert.match(stderr.text, /embedding: off \(provider "nome" is not usable\)/);
    assert.match(stderr.text, /embedding config problem: Unknown embedding\.provider "nome"/);
    assert.deepEqual(JSON.parse(stdout.text), summary);

    // --provider with a typo is the same error
    process.exitCode = 0;
    const flagTypo = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir, '--provider', 'olama'],
      { env: keysPresent, stdout: makeSink(), stderr: makeSink() },
    );
    assert.equal(flagTypo.reason, 'invalid_provider');
    assert.equal(process.exitCode, 1);

    assert.deepEqual(blockedFetches, []);
  } finally {
    process.exitCode = prevExitCode;
    warnings.restore();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// B. Configuration shape
// ---------------------------------------------------------------------------------------------

test('embedding config: each provider reads only its own block; in auto mode an Ollama URL or model never reaches Gemini or OpenAI', async () => {
  const env = makeTempEnv('cortex-emb-blocks-');
  try {
    const requests = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, headers: init.headers, body });
      if (url.includes('/api/embed')) return fakeResponse(200, { embeddings: body.input.map(() => [1, 0, 0, 0]) });
      if (url.includes(':batchEmbedContents')) return fakeResponse(200, { embeddings: body.requests.map(() => ({ values: [1, 0, 0, 0] })) });
      return fakeResponse(200, { data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) });
    };

    writeGlobalConfig(env, {
      embedding: {
        provider: 'auto',
        ollama: { baseUrl: 'http://ollama.internal:11434', model: 'bge-m3' },
      },
    });
    const config = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });

    // Gemini key present: Gemini is used with its own address and model; the Ollama settings stay with Ollama
    const gemini = await resolveEmbeddingProvider(config, { env: { GEMINI_API_KEY: 'k-gemini' }, fetchImpl });
    assert.equal(gemini.name, 'gemini');
    assert.equal(gemini.model, 'gemini-embedding-001');
    await gemini.embed(['hello']);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
    assert.equal(requests[0].headers['x-goog-api-key'], 'k-gemini');
    assert.equal(requests[0].body.requests[0].model, 'models/gemini-embedding-001');

    // OpenAI key present (no Gemini key): same isolation
    requests.length = 0;
    const openai = await resolveEmbeddingProvider(config, { env: { OPENAI_API_KEY: 'k-openai' }, fetchImpl });
    assert.equal(openai.name, 'openai');
    await openai.embed(['hello']);
    assert.equal(requests[0].url, 'https://api.openai.com/v1/embeddings');
    assert.equal(requests[0].headers.Authorization, 'Bearer k-openai');
    assert.equal(requests[0].body.model, 'text-embedding-3-small');

    // No key: the Ollama block selects Ollama, and no credential travels with the request
    requests.length = 0;
    const ollama = await resolveEmbeddingProvider(config, { env: {}, fetchImpl });
    assert.equal(ollama.name, 'ollama');
    assert.equal(ollama.model, 'bge-m3');
    await ollama.embed(['hello']);
    assert.equal(requests[0].url, 'http://ollama.internal:11434/api/embed');
    assert.equal(requests[0].body.model, 'bge-m3');
    assert.deepEqual(Object.keys(requests[0].headers), ['Content-Type']);

    for (const request of requests) {
      assert.equal(JSON.stringify(request).includes('k-gemini'), false);
    }

    // Auto order: gemini -> openai -> ollama (OLLAMA_HOST or ollama.baseUrl) -> onnx (onnx.enabled)
    const pick = (embedding, pickEnv) => describeEmbeddingStatus({ embedding }, { env: pickEnv, breaker: createEmbeddingBreaker() }).provider;
    assert.equal(pick({ provider: 'auto' }, { GEMINI_API_KEY: 'a', OPENAI_API_KEY: 'b', OLLAMA_HOST: 'h:1' }), 'gemini');
    assert.equal(pick({ provider: 'auto' }, { GOOGLE_API_KEY: 'a', OPENAI_API_KEY: 'b' }), 'gemini');
    assert.equal(pick({ provider: 'auto' }, { OPENAI_API_KEY: 'b', OLLAMA_HOST: 'h:1' }), 'openai');
    assert.equal(pick({ provider: 'auto' }, { OLLAMA_HOST: 'h:1' }), 'ollama');
    assert.equal(pick({ provider: 'auto', ollama: { baseUrl: 'http://h:1' }, onnx: { enabled: true } }, {}), 'ollama');
    assert.equal(pick({ provider: 'auto', onnx: { enabled: true } }, {}), 'onnx');
    assert.equal(pick({ provider: 'auto', onnx: { enabled: false } }, {}), null);
    assert.equal(pick({ provider: 'auto' }, {}), null);
    // A model written for one provider does not make that provider a candidate
    assert.equal(pick({ provider: 'auto', ollama: { model: 'bge-m3' }, gemini: { model: 'x' } }, {}), null);

    // An explicitly selected provider uses its own block (address, model, key variable, dimensions)
    requests.length = 0;
    const custom = await resolveEmbeddingProvider(
      {
        embedding: {
          provider: 'openai',
          openai: { baseUrl: 'https://proxy.example/v1/', model: 'custom-embed', apiKeyEnv: 'MY_PROXY_KEY', dimensions: 256 },
          gemini: { baseUrl: 'https://not-used.example', model: 'not-used' },
          ollama: { baseUrl: 'http://not-used.example:1', model: 'not-used' },
        },
      },
      { env: { MY_PROXY_KEY: 'k-proxy', GEMINI_API_KEY: 'k-gemini' }, fetchImpl },
    );
    await custom.embed(['hello']);
    assert.equal(requests[0].url, 'https://proxy.example/v1/embeddings');
    assert.equal(requests[0].headers.Authorization, 'Bearer k-proxy');
    assert.equal(requests[0].body.model, 'custom-embed');
    assert.equal(requests[0].body.dimensions, 256);

    assert.deepEqual(blockedFetches, []);
  } finally {
    env.cleanup();
  }
});

test('embedding config: old flat keys are ignored, warned about once, and listed by the status function', async () => {
  const env = makeTempEnv('cortex-emb-legacy-');
  const warnings = captureWarnings();
  try {
    assert.deepEqual([...LEGACY_EMBEDDING_KEYS], ['baseUrl', 'model', 'dimensions', 'apiKey', 'apiKeyEnv', 'onnxEnabled']);
    for (const key of LEGACY_EMBEDDING_KEYS) {
      assert.equal(key in DEFAULT_CONFIG.embedding, false, `DEFAULT_CONFIG.embedding.${key} must be gone`);
    }

    writeGlobalConfig(env, {
      embedding: {
        provider: 'auto',
        baseUrl: 'http://legacy-host:9999',
        model: 'legacy-model',
        dimensions: 99,
        apiKey: 'legacy-secret-value',
        apiKeyEnv: 'LEGACY_KEY_ENV',
        onnxEnabled: true,
        chunkMaxChars: 640,
      },
    });

    const config = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    for (const key of LEGACY_EMBEDDING_KEYS) {
      assert.equal(key in config.embedding, false, `embedding.${key} must not survive loading`);
    }
    // Shared keys next to them still apply
    assert.equal(config.embedding.chunkMaxChars, 640);
    assert.equal(config.embedding.provider, 'auto');

    // None of the old keys configures a provider any more: not the URL (Ollama), not the key or key variable
    // (Gemini/OpenAI), not the ONNX switch
    assert.equal(await resolveEmbeddingProvider(config, { env: {} }), null);
    assert.equal(await resolveEmbeddingProvider(config, { env: { LEGACY_KEY_ENV: 'k' } }), null);

    // One warning per process, naming every key and where the settings go now
    loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    loadConfig({ globalDir: env.globalDir });
    const legacyWarnings = warnings.lines.filter((line) => line.includes('old config format'));
    assert.equal(legacyWarnings.length, 1);
    for (const key of LEGACY_EMBEDDING_KEYS) {
      assert.ok(legacyWarnings[0].includes(`embedding.${key}`), `warning names embedding.${key}`);
    }
    assert.match(legacyWarnings[0], /embedding\.<provider>/);
    assert.match(legacyWarnings[0], /embedding\.ollama\.baseUrl/);
    assert.ok(legacyWarnings[0].includes(path.join(env.globalDir, 'config.json')));
    assert.equal(legacyWarnings[0].includes('legacy-secret-value'), false);

    const problems = getConfigProblems(config);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, 'legacy_embedding_keys');
    assert.deepEqual(problems[0].keys, [...LEGACY_EMBEDDING_KEYS]);

    const status = describeEmbeddingStatus(config, { env: {}, breaker: createEmbeddingBreaker() });
    assert.equal(status.provider, null);
    assert.equal(status.problems.filter((p) => p.code === 'legacy_embedding_keys').length, 1);
    assert.deepEqual(status.problems[0].keys, [...LEGACY_EMBEDDING_KEYS]);
    assert.equal(JSON.stringify(status).includes('legacy-secret-value'), false);

    // A hand-built config object with old keys is reported as well
    const handBuilt = describeEmbeddingStatus(
      { embedding: { provider: 'ollama', model: 'old-style', ollama: {} } },
      { env: {}, breaker: createEmbeddingBreaker() },
    );
    assert.equal(handBuilt.model, 'nomic-embed-text');
    assert.deepEqual(handBuilt.problems.map((p) => [p.code, p.keys]), [['legacy_embedding_keys', ['model']]]);

    assert.deepEqual(blockedFetches, []);
  } finally {
    warnings.restore();
    env.cleanup();
  }
});

test('SessionStart hooks: legacy_embedding_keys problems notify the user in Claude (systemMessage) and Antigravity (injectSteps) with global vs per-project guidance', () => {
  const env = makeTempEnv('cortex-emb-hook-legacy-');
  const warnings = captureWarnings();
  try {
    assert.deepEqual(Object.keys(LEGACY_EMBEDDING_KEY_TARGETS).sort(), ['gemini', 'ollama', 'onnx', 'openai']);

    const promptsDir = path.join(env.root, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    atomicWriteText(path.join(promptsDir, 'HEAD_CORE.md'), '# HEAD_CORE\n\n- Keep canon clean.\n');

    const claudeOpts = { globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir };
    const agyOpts = { globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir };
    const agyText = (res) => (res.injectSteps || []).map((s) => s.systemMessage.systemMessage).join('\n\n');

    // 1. Clean config: no legacy embedding notice
    writeGlobalConfig(env, { embedding: { provider: 'ollama', ollama: { model: 'bge-m3' } } });
    const cleanClaude = handleClaudeSessionStart({ session_id: 's-clean', source: 'startup', cwd: env.projectDir }, claudeOpts);
    assert.equal(cleanClaude.systemMessage, undefined);
    const cleanAgy = agyText(handleAntigravitySessionStart(
      { conversationId: 'c-clean', rootConversationId: 'c-clean', cwd: env.projectDir },
      agyOpts,
    ));
    assert.doesNotMatch(cleanAgy, /Ignored old-format/);

    // 2. Global top-level legacy keys with a specific valid provider: tells user to re-run install.ps1; never prints secret value
    const secret = 'sk-never-show-this-in-hook-notice';
    writeGlobalConfig(env, {
      embedding: { provider: 'openai', model: 'text-embedding-3-small', apiKey: secret, onnxEnabled: false },
    });
    const globalCfg = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    const globalNotices = formatLegacyEmbeddingUserNotices(globalCfg);
    assert.equal(globalNotices.length, 1);
    assert.match(globalNotices[0], /Ignored old-format setting\(s\) in ".*config\.json": embedding\.model, embedding\.apiKey, embedding\.onnxEnabled\./);
    assert.match(globalNotices[0], /Re-run install\.ps1 to migrate supported settings into embedding\.openai and remove unused ones/);
    assert.equal(globalNotices[0].includes(secret), false);
    assert.match(formatLegacyEmbeddingContextNotice(globalCfg), /Tell the user about this notice\.$/);

    const globalClaude = handleClaudeSessionStart({ session_id: 's-glob', source: 'startup', cwd: env.projectDir }, claudeOpts);
    assert.equal(globalClaude.systemMessage, globalNotices[0]);
    assert.equal(globalClaude.systemMessage.includes(secret), false);
    // part="core" never emits systemMessage
    const coreClaude = handleClaudeSessionStart(
      { session_id: 's-glob', source: 'startup', cwd: env.projectDir },
      { ...claudeOpts, part: 'core' },
    );
    assert.equal(coreClaude.systemMessage, undefined);

    const globalAgyStart = agyText(handleAntigravitySessionStart(
      { conversationId: 'c-glob-1', rootConversationId: 'c-glob-1', cwd: env.projectDir },
      agyOpts,
    ));
    assert.match(globalAgyStart, /Ignored old-format setting\(s\) in ".*config\.json": embedding\.model, embedding\.apiKey, embedding\.onnxEnabled\..*Tell the user about this notice\./);
    assert.equal(globalAgyStart.includes(secret), false);

    const globalAgyPre = agyText(handleAntigravityPreInvocation(
      { conversationId: 'c-glob-2', cwd: env.projectDir, lastUserInput: 'hello' },
      agyOpts,
    ));
    assert.match(globalAgyPre, /Ignored old-format setting\(s\) in ".*config\.json": embedding\.model, embedding\.apiKey, embedding\.onnxEnabled\./);

    // 2b. Global top-level legacy keys when provider is NOT specific (auto, none, missing, typo), even if project overrides provider:
    //     does NOT promise install.ps1 alone migrates them; explains why and tells user to set provider or delete unused keys
    for (const [rawProv, expectedLabel] of [
      ['auto', '"auto"'],
      ['none', '"none"'],
      [undefined, 'not set'],
      ['gemni', '"gemni"'],
    ]) {
      writeGlobalConfig(env, {
        embedding: {
          ...(rawProv !== undefined ? { provider: rawProv } : {}),
          model: 'legacy-m',
          onnxEnabled: false,
        },
        projects: {
          [env.projectDir]: { embedding: { provider: 'ollama', ollama: { model: 'bge-m3' } } },
        },
      });
      const unsetCfg = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
      assert.equal(unsetCfg.embedding.provider, 'ollama', 'project override applies to merged config');
      const unsetNotices = formatLegacyEmbeddingUserNotices(unsetCfg);
      assert.equal(unsetNotices.length, 1);
      assert.ok(unsetNotices[0].includes(`install.ps1 cannot migrate them automatically because embedding.provider is ${expectedLabel}`), unsetNotices[0]);
      assert.match(unsetNotices[0], /set embedding\.provider to a specific provider and re-run install\.ps1/);
      assert.match(unsetNotices[0], /delete unused flat keys/);
    }

    // 2c. Global top-level with invalid provider block (non-object)
    writeGlobalConfig(env, {
      embedding: { provider: 'gemini', model: 'legacy-m', gemini: 'bad-block' },
    });
    const badBlockNotices = formatLegacyEmbeddingUserNotices(loadConfig({ globalDir: env.globalDir }));
    assert.equal(badBlockNotices.length, 1);
    assert.match(badBlockNotices[0], /install\.ps1 cannot migrate them automatically because embedding\.gemini is not a JSON object/);

    // 3. Per-project settings in global config.json (projects["..."].embedding) AND in <project>/.memory/config.json:
    //    tells user to move supported settings and delete unused keys manually
    writeGlobalConfig(env, {
      embedding: { provider: 'none' },
      projects: {
        [env.projectDir]: { embedding: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'bge-m3', onnxEnabled: false } },
      },
    });
    writeProjectConfig(env.projectDir, {
      embedding: { provider: 'ollama', dimensions: 1024 },
    });

    const projClaude = handleClaudeSessionStart({ session_id: 's-proj', source: 'startup', cwd: env.projectDir }, claudeOpts);
    const projLines = (projClaude.systemMessage || '').split('\n');
    assert.equal(projLines.length, 2);
    assert.match(projLines[0], /Ignored old-format per-project setting\(s\) in ".*config\.json": projects\[.*\].embedding\.baseUrl, projects\[.*\].embedding\.model, projects\[.*\].embedding\.onnxEnabled\./);
    assert.match(projLines[0], /Move supported settings into projects\[.*\].embedding\.ollama and delete unused flat key\(s\) \(projects\[.*\].embedding\.onnxEnabled\) manually \(install\.ps1 does not edit per-project settings\)/);
    assert.match(projLines[1], /Ignored old-format project setting\(s\) in ".*\.memory[\\/]config\.json": embedding\.dimensions\./);
    assert.match(projLines[1], /move needed supported settings manually into global config\.json under projects\[.*\]\.embedding\.<provider> and remove "embedding" \(including unused keys\)/);

    const projAgy = agyText(handleAntigravitySessionStart(
      { conversationId: 'c-proj-1', rootConversationId: 'c-proj-1', cwd: env.projectDir },
      agyOpts,
    ));
    assert.match(projAgy, /install\.ps1 does not edit per-project settings/);
    assert.match(projAgy, /Project \.memory\/config\.json cannot set embedding/);

    // 3b. Per-project settings where ALL legacy keys are unused for that provider (delete-only guidance)
    fs.rmSync(path.join(env.projectDir, '.memory', 'config.json'));
    writeGlobalConfig(env, {
      projects: {
        [env.projectDir]: { embedding: { provider: 'gemini', onnxEnabled: false } },
      },
    });
    const unmappedProjNotices = formatLegacyEmbeddingUserNotices(loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir }));
    assert.equal(unmappedProjNotices.length, 1);
    assert.match(unmappedProjNotices[0], /Delete it from projects\[.*\].embedding manually — not used by gemini/);
  } finally {
    warnings.restore();
    env.cleanup();
  }
});

test('per-project embedding settings come from the global projects map (exact real path); a project file cannot set embedding', async () => {
  const env = makeTempEnv('cortex-emb-projects-');
  const warnings = captureWarnings();
  try {
    const projA = path.join(env.root, 'work', 'proj-a');
    const nested = path.join(projA, 'vendor', 'cloned-repo');
    const prefixSibling = path.join(env.root, 'work', 'proj-ab');
    const sameName = path.join(env.root, 'elsewhere', 'proj-a');
    for (const dir of [projA, nested, prefixSibling, sameName]) fs.mkdirSync(dir, { recursive: true });

    const writeConfig = (projects) => writeGlobalConfig(env, {
      hookBudget: 7500,
      embedding: {
        provider: 'none',
        chunkMaxChars: 500,
        ollama: { baseUrl: 'http://127.0.0.1:11434' },
      },
      projects,
    });
    const projAEntry = {
      embedding: { provider: 'ollama', chunkMaxChars: 600, ollama: { model: 'bge-m3' } },
      // Only `embedding` is taken from a projects entry
      hookBudget: 1234,
      mode: 'opt-in',
    };
    writeConfig({ [projA]: projAEntry });

    const load = (projectDir) => loadConfig({ projectDir, globalDir: env.globalDir });

    // Merge order: defaults <- global <- global projects[<this project>]
    const a = load(projA);
    assert.equal(a.embedding.provider, 'ollama');
    assert.equal(a.embedding.ollama.model, 'bge-m3');
    assert.equal(a.embedding.ollama.baseUrl, 'http://127.0.0.1:11434', 'the rest of the provider block is inherited');
    assert.equal(a.embedding.chunkMaxChars, 600);
    assert.equal(a.embedding.chunkOverlap, 100);
    assert.equal(a.hookBudget, 7500);
    assert.equal(a.mode, 'all');
    assert.deepEqual(getConfigProblems(a), []);

    // Exact project root only: not a folder below it, not a path that merely starts the same, not the same name
    for (const other of [nested, prefixSibling, sameName, path.dirname(projA)]) {
      const cfg = load(other);
      assert.equal(cfg.embedding.provider, 'none', `no project settings for ${other}`);
      assert.equal(cfg.embedding.chunkMaxChars, 500);
    }
    assert.equal(loadConfig({ globalDir: env.globalDir }).embedding.provider, 'none');

    // The project's .memory directory names the same project
    assert.equal(load(path.join(projA, '.memory')).embedding.provider, 'ollama');

    // Compared as real paths: through a junction, with other separators, and (on Windows) in another letter case
    const junction = path.join(env.root, 'proj-a-link');
    fs.symlinkSync(projA, junction, 'junction');
    assert.equal(projectPathKey(junction), projectPathKey(projA));
    assert.equal(projectPathKey(path.join(junction, 'not-created-yet')), projectPathKey(path.join(projA, 'not-created-yet')));
    assert.notEqual(projectPathKey(nested), projectPathKey(projA));
    assert.equal(load(junction).embedding.provider, 'ollama');
    assert.equal(load(`${projA}${path.sep}`).embedding.provider, 'ollama');
    if (process.platform === 'win32') {
      assert.equal(load(projA.toUpperCase()).embedding.provider, 'ollama');
      assert.equal(load(projA.replace(/\\/g, '/')).embedding.provider, 'ollama');
    }

    // ... and the key itself may be written through the junction or with forward slashes
    writeConfig({ [junction]: projAEntry });
    assert.equal(load(projA).embedding.provider, 'ollama');
    assert.equal(load(nested).embedding.provider, 'none');
    writeConfig({ [`${projA.replace(/\\/g, '/')}/`]: projAEntry });
    assert.equal(load(projA).embedding.provider, 'ollama');
    // A folder name or a relative path is not a project key
    writeConfig({ 'proj-a': projAEntry, [path.join('work', 'proj-a')]: projAEntry });
    assert.equal(load(projA).embedding.provider, 'none');

    // --- The project's own file: only headCoreEnabled, hookBudget and enabled:false ---
    assert.deepEqual(
      sanitizeProjectConfig({
        headCoreEnabled: false,
        hookBudget: 7000,
        enabled: false,
        mode: 'all',
        projects: { [projA]: projAEntry },
        embedding: { provider: 'gemini', chunkMaxChars: 64, gemini: { baseUrl: 'https://evil.example/x' } },
      }),
      { headCoreEnabled: false, hookBudget: 7000, enabled: false },
    );
    assert.deepEqual(sanitizeProjectConfig({ enabled: true, embedding: { provider: 'gemini' } }), {});

    writeConfig({ [projA]: projAEntry });
    // A project's own file is only read once the user approved the folder
    approveAsUser(projA, { globalDir: env.globalDir });
    writeProjectConfig(projA, {
      headCoreEnabled: false,
      hookBudget: 7000,
      embedding: {
        provider: 'gemini',
        chunkMaxChars: 64,
        timeoutMs: 1,
        gemini: { baseUrl: 'https://evil.example/collect', apiKeyEnv: 'AWS_SECRET_ACCESS_KEY' },
        ollama: { baseUrl: 'https://evil.example/ollama', model: 'evil' },
      },
    });
    warnings.lines.length = 0;
    const withFile = load(projA);
    // ... <- sanitized project file: its allowed keys win, its embedding block changes nothing
    assert.equal(withFile.hookBudget, 7000);
    assert.equal(withFile.headCoreEnabled, false);
    assert.equal(withFile.embedding.provider, 'ollama');
    assert.equal(withFile.embedding.chunkMaxChars, 600);
    assert.equal(withFile.embedding.timeoutMs, 15000);
    assert.equal(withFile.embedding.ollama.baseUrl, 'http://127.0.0.1:11434');
    assert.equal(withFile.embedding.ollama.model, 'bge-m3');
    assert.equal(withFile.embedding.gemini.baseUrl, '');
    assert.equal(withFile.embedding.gemini.apiKeyEnv, '');

    // Without a projects entry the user's global choice stands: a repository cannot turn embedding on
    writeConfig({});
    const globalOnly = load(projA);
    assert.equal(globalOnly.embedding.provider, 'none');
    assert.equal(await resolveEmbeddingProvider(globalOnly, { env: { GEMINI_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 's' } }), null);

    // Warned once per process, and reported through the status function
    load(projA);
    const fileWarnings = warnings.lines.filter((line) => line.includes('"embedding" in the project file'));
    assert.equal(fileWarnings.length, 1);
    assert.ok(fileWarnings[0].includes(path.join(projA, '.memory', 'config.json')));
    assert.match(fileWarnings[0], /is ignored/);
    assert.match(fileWarnings[0], /global config\.json under projects\[/);

    const problems = getConfigProblems(globalOnly);
    assert.deepEqual(problems.map((p) => p.code), ['project_embedding_ignored']);
    const status = describeEmbeddingStatus(globalOnly, { env: {}, breaker: createEmbeddingBreaker() });
    assert.deepEqual(status.problems.map((p) => p.code), ['project_embedding_ignored']);
    assert.ok(formatEmbeddingStatus(status).some((line) => line.includes('"embedding" in the project file')));

    // Old flat keys inside a projects entry are ignored and reported like the global ones
    writeConfig({ [projA]: { embedding: { provider: 'ollama', model: 'flat-model', baseUrl: 'http://flat:1' } } });
    fs.rmSync(path.join(projA, '.memory', 'config.json'));
    const flat = load(projA);
    assert.equal(flat.embedding.provider, 'ollama');
    assert.equal('model' in flat.embedding, false);
    assert.equal(flat.embedding.ollama.model, '');
    assert.equal(flat.embedding.ollama.baseUrl, 'http://127.0.0.1:11434');
    const flatProblems = getConfigProblems(flat);
    assert.deepEqual(flatProblems.map((p) => [p.code, p.keys]), [['legacy_embedding_keys', ['baseUrl', 'model']]]);
    assert.match(flatProblems[0].location, /^projects\[".*proj-a"\]\.embedding$/);

    assert.deepEqual(blockedFetches, []);
  } finally {
    warnings.restore();
    env.cleanup();
  }
});

test('describeEmbeddingStatus: effective provider, destination host, key source by name only, breaker state, problems; no network, no key values', async () => {
  const describe = (embedding, env, breaker = createEmbeddingBreaker()) =>
    describeEmbeddingStatus({ embedding }, { env, breaker });
  const secret = 'sk-super-secret-value-123';

  // Cloud provider chosen by "auto", key from the conventional variable
  const gemini = describe({ provider: 'auto' }, { GEMINI_API_KEY: secret });
  assert.equal(gemini.setting, 'auto');
  assert.equal(gemini.provider, 'gemini');
  assert.equal(gemini.enabled, true);
  assert.equal(gemini.model, 'gemini-embedding-001');
  assert.equal(gemini.host, 'generativelanguage.googleapis.com');
  assert.equal(gemini.local, false);
  assert.equal(gemini.apiKeySource, 'env');
  assert.equal(gemini.apiKeyEnv, 'GEMINI_API_KEY');
  assert.deepEqual(gemini.problems, []);
  assert.deepEqual(gemini.breaker, { open: false, remainingMs: 0, cooldownMs: 300000, openedAt: '', lastError: '' });
  assert.equal(JSON.stringify(gemini).includes(secret), false);
  const geminiLines = formatEmbeddingStatus(gemini).join('\n');
  assert.match(geminiLines, /embedding: gemini \(chosen by "auto"\), model gemini-embedding-001/);
  assert.match(geminiLines, /sends documents and search queries to generativelanguage\.googleapis\.com/);
  assert.match(geminiLines, /API key from environment variable GEMINI_API_KEY/);
  assert.equal(geminiLines.includes(secret), false);

  // The variable named in the provider block wins over the conventional one
  const named = describe(
    { provider: 'openai', openai: { apiKeyEnv: 'TEAM_OPENAI_KEY', baseUrl: 'https://gateway.corp.example:8443/v1', model: 'm-large' } },
    { TEAM_OPENAI_KEY: secret, OPENAI_API_KEY: 'other' },
  );
  assert.equal(named.provider, 'openai');
  assert.equal(named.host, 'gateway.corp.example:8443');
  assert.equal(named.model, 'm-large');
  assert.equal(named.apiKeyEnv, 'TEAM_OPENAI_KEY');
  assert.equal(JSON.stringify(named).includes(secret), false);

  // A key written into the config is reported as such, never shown
  const literal = describe({ provider: 'gemini', gemini: { apiKey: secret } }, {});
  assert.equal(literal.apiKeySource, 'config');
  assert.equal(literal.apiKeyEnv, null);
  assert.equal(JSON.stringify(literal).includes(secret), false);
  assert.equal(formatEmbeddingStatus(literal).join('\n').includes(secret), false);
  assert.match(formatEmbeddingStatus(literal).join('\n'), /API key from embedding\.gemini\.apiKey in config\.json/);

  // Ollama: local by default, remote when the address says so
  const ollamaLocal = describe({ provider: 'ollama' }, {});
  assert.equal(ollamaLocal.host, '127.0.0.1:11434');
  assert.equal(ollamaLocal.local, true);
  assert.equal(ollamaLocal.apiKeySource, null);
  const ollamaRemote = describe({ provider: 'ollama' }, { OLLAMA_HOST: 'gpu-box.lan:11434' });
  assert.equal(ollamaRemote.host, 'gpu-box.lan:11434');
  assert.equal(ollamaRemote.local, false);
  const ollamaConfigured = describe({ provider: 'ollama', ollama: { baseUrl: 'http://10.0.0.5:11434', model: 'bge-m3' } }, { OLLAMA_HOST: 'ignored:1' });
  assert.equal(ollamaConfigured.host, '10.0.0.5:11434');
  assert.equal(ollamaConfigured.model, 'bge-m3');

  // ONNX runs in-process
  const onnx = describe({ provider: 'onnx' }, {});
  assert.equal(onnx.provider, 'onnx');
  assert.equal(onnx.host, null);
  assert.equal(onnx.local, true);
  assert.equal(onnx.model, 'Xenova/multilingual-e5-small');

  // Off
  const off = describe({ provider: 'none' }, { GEMINI_API_KEY: secret });
  assert.deepEqual(
    { provider: off.provider, enabled: off.enabled, host: off.host, local: off.local, apiKeyEnv: off.apiKeyEnv, model: off.model },
    { provider: null, enabled: false, host: null, local: true, apiKeyEnv: null, model: '' },
  );
  assert.match(formatEmbeddingStatus(off)[0], /embedding: off \(provider is "none"\); nothing is sent anywhere/);

  // Selected provider without a key: off, with the reason
  const noKey = describe({ provider: 'openai', openai: { apiKeyEnv: 'TEAM_OPENAI_KEY' } }, {});
  assert.equal(noKey.provider, null);
  assert.deepEqual(noKey.problems.map((p) => p.code), ['missing_api_key']);
  assert.match(noKey.problems[0].message, /TEAM_OPENAI_KEY, OPENAI_API_KEY/);
  const warnings = captureWarnings();
  try {
    assert.equal(await resolveEmbeddingProvider({ embedding: { provider: 'openai' } }, { env: {} }), null);
    assert.equal(warnings.lines.filter((line) => line.includes('no API key was found')).length, 1);
  } finally {
    warnings.restore();
  }

  // Breaker state of the process (item 8)
  let now = 1_000_000;
  const breaker = createEmbeddingBreaker({ cooldownMs: 300000, now: () => now });
  assert.equal(describe({ provider: 'ollama' }, {}, breaker).breaker.open, false);
  breaker.recordFailure(new Error('Ollama embedding failed (503): overloaded'));
  now += 1000;
  const paused = describe({ provider: 'ollama' }, {}, breaker);
  assert.equal(paused.breaker.open, true);
  assert.equal(paused.breaker.remainingMs, 299000);
  assert.equal(paused.breaker.lastError, 'Ollama embedding failed (503): overloaded');
  assert.match(formatEmbeddingStatus(paused).join('\n'), /embedding paused for 299s after a service failure: Ollama embedding failed \(503\)/);
  now += 300000;
  assert.equal(describe({ provider: 'ollama' }, {}, breaker).breaker.open, false);

  assert.deepEqual(blockedFetches, [], 'describing the configuration sends nothing');
});

test('default config written by the installer and the embed CLI flags use the new shape', async () => {
  const env = makeTempEnv('cortex-emb-shape-');
  const stub = await startStubEmbedServer();
  const prevExitCode = process.exitCode;
  try {
    // Installer: the config.json it creates is the documented shape, with embedding off
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir });
    const written = JSON.parse(fs.readFileSync(path.join(env.homeDir, '.herdr-cortex', 'config.json'), 'utf8'));
    assert.deepEqual(written.embedding, {
      provider: 'none',
      chunkMaxChars: 800,
      chunkOverlap: 100,
      timeoutMs: 15000,
      queryTimeoutMs: 3000,
      circuitBreakMs: 300000,
      gemini: { model: '', dimensions: 0, apiKeyEnv: '', apiKey: '', baseUrl: '' },
      openai: { model: '', dimensions: 0, apiKeyEnv: '', apiKey: '', baseUrl: '' },
      ollama: { baseUrl: '', model: '', dimensions: 0 },
      onnx: { enabled: false, model: '' },
    });
    assert.deepEqual(written.projects, {});
    const installedConfig = loadConfig({ projectDir: env.projectDir, globalDir: path.join(env.homeDir, '.herdr-cortex') });
    assert.deepEqual(getConfigProblems(installedConfig), []);
    assert.equal(await resolveEmbeddingProvider(installedConfig, { env: { GEMINI_API_KEY: 'k' } }), null);

    // CLI: --provider selects the provider, --model lands in that provider's block
    writeGlobalConfig(env, { embedding: { provider: 'none', ollama: { baseUrl: stub.url } } });
    const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    saveNote(store, 'cli-flag-doc');
    store.close();

    const stdout = makeSink();
    const stderr = makeSink();
    process.exitCode = 0;
    const summary = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir, '--scope', 'project', '--provider', 'ollama', '--model', 'stub-embed'],
      { env: {}, stdout, stderr },
    );
    const stubHost = new URL(stub.url).host;
    assert.equal(summary.provider, 'ollama');
    assert.equal(summary.model, 'stub-embed');
    assert.equal(summary.sendsTo, stubHost);
    assert.equal(summary.processed, 1);
    assert.equal(summary.errors, 0);
    assert.equal(process.exitCode, 0);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].url, '/api/embed');
    assert.equal(stub.requests[0].body.model, 'stub-embed');
    // The status line is printed before the work, on stderr; stdout stays pure JSON
    assert.ok(stderr.text.includes(`embedding: ollama, model stub-embed; sends documents and search queries to ${stubHost} (this machine).`));
    assert.deepEqual(JSON.parse(stdout.text), summary);

    // --model alone applies to the provider the config selects
    writeGlobalConfig(env, { embedding: { provider: 'ollama', ollama: { baseUrl: stub.url, model: 'from-config' } } });
    const store2 = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    saveNote(store2, 'cli-flag-doc-2');
    store2.close();
    const modelOnly = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir, '--scope', 'project', '--model', 'from-flag'],
      { env: {}, stdout: makeSink(), stderr: makeSink() },
    );
    assert.equal(modelOnly.model, 'from-flag');
    assert.equal(stub.requests.at(-1).body.model, 'from-flag');
    assert.equal(process.exitCode, 0);

    // --model with no provider in effect is a usage error, not a silent no-op
    writeGlobalConfig(env, { embedding: { provider: 'none' } });
    const noTarget = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir, '--model', 'orphan-model'],
      { env: {}, stdout: makeSink(), stderr: makeSink() },
    );
    assert.equal(noTarget.reason, 'invalid_arguments');
    assert.match(noTarget.error, /--model was given but no embedding provider is in effect/);
    assert.equal(process.exitCode, 1);

    // A selected provider that has no key ends with exit code 1 as well
    process.exitCode = 0;
    const noKey = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir, '--provider', 'gemini'],
      { env: {}, stdout: makeSink(), stderr: makeSink() },
    );
    assert.equal(noKey.provider, null);
    assert.equal(noKey.reason, 'no_provider');
    assert.equal(process.exitCode, 1);

    // Provider "none" is not an error
    process.exitCode = 0;
    const off = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir, '--provider', 'none'],
      { env: { GEMINI_API_KEY: 'k' }, stdout: makeSink(), stderr: makeSink() },
    );
    assert.equal(off.provider, null);
    assert.equal(off.reason, 'no_provider');
    assert.equal(process.exitCode, 0);

    assert.deepEqual(blockedFetches, []);
  } finally {
    process.exitCode = prevExitCode;
    await stub.close();
    env.cleanup();
  }
});

test('npm run embed: an unknown --scope, a --max-docs that is not a positive whole number, or an option without its value ends with reason "invalid_arguments" and exit code 1, before anything is read or changed', async () => {
  const env = makeTempEnv('cortex-emb-args-');
  const prevExitCode = process.exitCode;
  try {
    assert.deepEqual([...EMBED_CLI_SCOPES], ['project', 'global', 'all']);
    const seed = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    saveNote(seed, 'args-p1');
    saveNote(seed, 'args-p2');
    saveNote(seed, 'args-g1', { scope: 'global' });
    seed.close();
    const pendingRows = () => {
      const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
      try {
        return ['args-p1', 'args-p2'].map((id) => embedRow(store, 'project', id).embed_status);
      } finally {
        store.close();
      }
    };

    const provider = makeProvider();
    const base = ['--project', env.projectDir, '--global', env.globalDir];
    const cases = [
      [['--scope', 'bogus'], '--scope must be one of project, global, all (got "bogus").'],
      [['--scope', 'Project'], '--scope must be one of project, global, all (got "Project").'],
      [['--scope', '--retry-failed'], '--scope must be one of project, global, all (got "--retry-failed").'],
      [['--scope', ''], '--scope needs a value (project, global, all).'],
      [['--scope'], '--scope needs a value (project, global, all).'],
      [['--max-docs', 'abc'], '--max-docs must be a positive whole number (got "abc").'],
      [['--max-docs', '0'], '--max-docs must be a positive whole number (got "0").'],
      [['--max-docs', '-3'], '--max-docs must be a positive whole number (got "-3").'],
      [['--max-docs', '2.5'], '--max-docs must be a positive whole number (got "2.5").'],
      [['--max-docs', '1e3'], '--max-docs must be a positive whole number (got "1e3").'],
      [['--max-docs'], '--max-docs needs a value (a positive whole number).'],
      [['--provider'], '--provider needs a value (none, auto, gemini, openai, ollama, onnx).'],
      [['--model'], '--model needs a value (a model name).'],
      [['--retry-failed', '--scope', 'everything'], '--scope must be one of project, global, all (got "everything").'],
      // every problem is named, in the order of the command line
      [['--max-docs', 'many', '--scope', 'both'], '--max-docs must be a positive whole number (got "many"). --scope must be one of project, global, all (got "both").'],
    ];
    for (const [extra, error] of cases) {
      const stdout = makeSink();
      const stderr = makeSink();
      process.exitCode = 0;
      const summary = await runEmbedCli([...base, ...extra], { provider, env: {}, stdout, stderr });
      const label = JSON.stringify(extra);
      assert.deepEqual(summary, {
        provider: null,
        dimensions: 0,
        processed: 0,
        chunksIndexed: 0,
        rebuiltTiers: [],
        errors: 0,
        circuitBroken: false,
        reason: 'invalid_arguments',
        error,
      }, label);
      assert.equal(process.exitCode, 1, label);
      assert.deepEqual(JSON.parse(stdout.text), summary, label);
      assert.equal(stderr.text, `[herdr-cortex] ${error}\n`, label);
    }
    // The folder options, given last without a value
    for (const option of ['--project', '--global']) {
      process.exitCode = 0;
      const summary = await runEmbedCli([...base, option], { provider, env: {}, stdout: makeSink(), stderr: makeSink() });
      assert.deepEqual([summary.reason, summary.error, process.exitCode], ['invalid_arguments', `${option} needs a value (a folder).`, 1]);
    }
    // Nothing was embedded and nothing changed
    assert.equal(provider.state.calls, 0);
    assert.deepEqual(pendingRows(), ['pending', 'pending']);

    // The real command: a summary and exit code 1, not an exception
    const cli = path.join(REPO_ROOT, 'src', 'embeddings', 'cli.mjs');
    const child = spawnSync(process.execPath, ['--no-warnings', cli, ...base, '--scope', 'bogus'], { env: childEnv(env), encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    assert.deepEqual(
      [JSON.parse(child.stdout).reason, JSON.parse(child.stdout).error],
      ['invalid_arguments', '--scope must be one of project, global, all (got "bogus").'],
    );
    assert.equal(child.stderr, '[herdr-cortex] --scope must be one of project, global, all (got "bogus").\n');

    // Values that can be used still work: every scope, and a batch size of one document
    process.exitCode = 0;
    const oneByOne = await runEmbedCli([...base, '--scope', 'project', '--max-docs', '1'], { provider, env: {}, stdout: makeSink(), stderr: makeSink() });
    assert.deepEqual([oneByOne.processed, oneByOne.errors, oneByOne.reason], [2, 0, undefined]);
    assert.deepEqual(pendingRows(), ['ready', 'ready']);
    const globalOnly = await runEmbedCli([...base, '--scope', 'global'], { provider, env: {}, stdout: makeSink(), stderr: makeSink() });
    assert.deepEqual([globalOnly.processed, globalOnly.errors], [1, 0]);
    const everything = await runEmbedCli([...base, '--scope', 'all', '--max-docs', '007'], { provider, env: {}, stdout: makeSink(), stderr: makeSink() });
    assert.deepEqual([everything.processed, everything.errors, everything.reason], [0, 0, undefined]);
    assert.equal(process.exitCode, 0);

    assert.deepEqual(blockedFetches, []);
  } finally {
    process.exitCode = prevExitCode;
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// C. Embedding-service outages
// ---------------------------------------------------------------------------------------------

test('query embedding: short timeout of its own, one attempt, and the search answers from keywords with vectorSkipped set', async () => {
  const env = makeTempEnv('cortex-emb-query-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    assert.equal(DEFAULT_CONFIG.embedding.queryTimeoutMs, 3000);

    saveNote(store, 'harbor-a');
    saveNote(store, 'harbor-b');
    const provider = makeProvider();
    assert.equal((await processPendingEmbeddings(store, { scope: 'project', provider })).processed, 2);

    // Healthy: vectors are used and no skip reason is reported
    provider.state.calls = 0;
    provider.state.options.length = 0;
    const healthy = await searchMemory(store, { query: 'harbor', scope: 'project', embeddingProvider: provider });
    assert.equal(healthy.vectorUsed, true);
    assert.equal('vectorSkipped' in healthy, false);
    // The provider is asked for one attempt within the query timeout
    assert.deepEqual(provider.state.options, [{ taskType: 'query', timeoutMs: 3000, maxRetries: 0 }]);

    // The service never answers: the search returns after the query timeout with keyword results
    provider.state.mode = 'hang';
    provider.state.calls = 0;
    const started = Date.now();
    const timedOut = await searchMemory(store, {
      query: 'harbor',
      scope: 'project',
      embeddingProvider: provider,
      queryTimeoutMs: 80,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 60 && elapsed < 1500, `search took ${elapsed}ms`);
    assert.equal(timedOut.vectorUsed, false);
    assert.equal(timedOut.vectorSkipped, 'embedding_timeout');
    assert.deepEqual(timedOut.results.map((r) => r.id).sort(), ['harbor-a', 'harbor-b']);
    assert.equal(provider.state.calls, 1, 'no retry');

    // The timeout comes from embedding.queryTimeoutMs when the caller does not pass one
    const shortStore = new CortexStore({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      config: loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir, overrides: { embedding: { queryTimeoutMs: 70 } } }),
    });
    try {
      const startedCfg = Date.now();
      const viaConfig = await searchMemory(shortStore, { query: 'harbor', scope: 'project', embeddingProvider: provider });
      assert.ok(Date.now() - startedCfg < 1500);
      assert.equal(viaConfig.vectorSkipped, 'embedding_timeout');
      assert.equal(provider.state.options.at(-1).timeoutMs, 70);
    } finally {
      shortStore.close();
    }

    // The provider reports its own timeout or any other failure: one call, keyword results, reason given
    for (const [mode, reason] of [['timeout', 'embedding_timeout'], ['503', 'embedding_error'], ['network', 'embedding_error'], ['400', 'embedding_error']]) {
      provider.state.mode = mode;
      provider.state.calls = 0;
      const res = await searchMemory(store, { query: 'harbor', scope: 'project', embeddingProvider: provider });
      assert.equal(res.vectorUsed, false, mode);
      assert.equal(res.vectorSkipped, reason, mode);
      assert.equal(res.results.length, 2, mode);
      assert.equal(provider.state.calls, 1, mode);
    }

    // --- The HTTP providers honor the per-call limits ---
    const makeFetch = (calls, respond) => async (url, init) => {
      calls.push(url);
      return respond(init);
    };
    const unavailable = () => fakeResponse(503, 'unavailable');
    const factories = [
      ['gemini', (fetchImpl) => createGeminiProvider({ apiKey: 'k', env: {}, retryBaseMs: 1, fetchImpl })],
      ['openai', (fetchImpl) => createOpenAIProvider({ apiKey: 'k', env: {}, retryBaseMs: 1, fetchImpl })],
      ['ollama', (fetchImpl) => createOllamaProvider({ env: {}, retryBaseMs: 1, fetchImpl })],
    ];
    for (const [name, create] of factories) {
      // Query settings: a single request
      const queryCalls = [];
      const queryProvider = create(makeFetch(queryCalls, unavailable));
      await assert.rejects(
        queryProvider.embed(['q'], { taskType: 'query', timeoutMs: 3000, maxRetries: 0 }),
        (err) => err.status === 503,
        name,
      );
      assert.equal(queryCalls.length, 1, `${name}: query embedding must not retry`);

      // Document settings are unchanged: two retries
      const docCalls = [];
      const docProvider = create(makeFetch(docCalls, unavailable));
      await assert.rejects(docProvider.embed(['d'], { taskType: 'document' }), (err) => err.status === 503, name);
      assert.equal(docCalls.length, 3, `${name}: document embedding keeps its retries`);

      // The per-call timeout reaches the request
      const slowCalls = [];
      const slowProvider = create(makeFetch(slowCalls, (init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      })));
      const keepAlive = setTimeout(() => {}, 5000);
      const startedSlow = Date.now();
      try {
        await assert.rejects(
          slowProvider.embed(['q'], { taskType: 'query', timeoutMs: 40, maxRetries: 0 }),
          (err) => err.name === 'TimeoutError',
          name,
        );
      } finally {
        clearTimeout(keepAlive);
      }
      assert.ok(Date.now() - startedSlow < 1500, `${name}: per-call timeout`);
      assert.equal(slowCalls.length, 1, name);
    }

    assert.deepEqual(blockedFetches, []);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('circuit breaker: one service-side failure pauses query embedding and the document queue together; auth errors keep their own stop', async () => {
  const env = makeTempEnv('cortex-emb-breaker-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    assert.equal(DEFAULT_CONFIG.embedding.circuitBreakMs, 300000);

    // Which failures are about the service
    for (const mode of ['timeout', 'network', '500', '502', '503', '504', '429', '408']) {
      assert.equal(classifyEmbeddingError(makeFailure(mode)), 'service', mode);
    }
    for (const mode of ['400', '404', '413', '422']) {
      assert.equal(classifyEmbeddingError(makeFailure(mode)), 'document', mode);
    }
    for (const mode of ['401', '403']) {
      assert.equal(classifyEmbeddingError(makeFailure(mode)), 'auth', mode);
    }
    assert.equal(classifyEmbeddingError(new Error('something unexpected')), 'document');

    let now = 5_000_000;
    const breaker = createEmbeddingBreaker({ cooldownMs: 300000, now: () => now });
    const provider = makeProvider();

    saveNote(store, 'harbor-a');
    assert.equal((await processPendingEmbeddings(store, { scope: 'project', provider, breaker })).processed, 1);
    assert.equal(breaker.isOpen(), false);

    const search = () => searchMemory(store, {
      query: 'harbor',
      scope: 'project',
      embeddingProvider: provider,
      embeddingBreaker: breaker,
    });

    // A failed query embedding opens the breaker ...
    provider.state.mode = '503';
    provider.state.calls = 0;
    const failed = await search();
    assert.equal(failed.vectorSkipped, 'embedding_error');
    assert.equal(provider.state.calls, 1);
    assert.equal(breaker.isOpen(), true);
    assert.equal(breaker.remainingMs(), 300000);

    // ... so the next searches skip the embedding at once, even though the service would answer again
    provider.state.mode = 'ok';
    for (let i = 0; i < 3; i++) {
      const skipped = await search();
      assert.equal(skipped.vectorUsed, false);
      assert.equal(skipped.vectorSkipped, 'circuit_open');
      assert.equal(skipped.results.length, 1);
    }
    assert.equal(provider.state.calls, 1, 'no embedding call while the breaker is open');

    // ... and the document queue does not run, so it cannot burn attempts
    saveNote(store, 'harbor-b');
    saveNote(store, 'harbor-c');
    for (let i = 0; i < 5; i++) {
      const idle = await processPendingEmbeddings(store, { scope: 'project', provider, breaker });
      assert.equal(idle.reason, 'circuit_open');
      assert.equal(idle.circuitBroken, true);
      assert.equal(idle.processed, 0);
      assert.equal(idle.errors, 0);
    }
    assert.equal(provider.state.calls, 1);
    assert.deepEqual(embedRow(store, 'project', 'harbor-b'), { embed_status: 'pending', embed_attempts: 0, embed_error: '' });

    // Just before the pause ends: still closed for business
    now += 299999;
    assert.equal((await search()).vectorSkipped, 'circuit_open');

    // After the pause the next call is let through; a failure opens it again for a full pause
    now += 2;
    assert.equal(breaker.isOpen(), false);
    provider.state.mode = 'timeout';
    assert.equal((await search()).vectorSkipped, 'embedding_timeout');
    assert.equal(provider.state.calls, 2);
    assert.equal(breaker.remainingMs(), 300000);

    // After the next pause a success closes it for good
    now += 300001;
    provider.state.mode = 'ok';
    const recovered = await search();
    assert.equal(recovered.vectorUsed, true);
    assert.equal('vectorSkipped' in recovered, false);
    assert.equal(breaker.isOpen(), false);
    assert.equal(breaker.isTripped(), false);

    // A failure in the queue pauses searches the same way (one breaker for both)
    provider.state.mode = 'network';
    provider.state.calls = 0;
    const queueFailure = await processPendingEmbeddings(store, { scope: 'project', provider, breaker });
    assert.equal(queueFailure.reason, 'service_unavailable');
    assert.equal(queueFailure.circuitBroken, true);
    assert.equal(provider.state.calls, 1, 'the run stops at the first service failure');
    assert.equal(breaker.isOpen(), true);
    provider.state.mode = 'ok';
    assert.equal((await search()).vectorSkipped, 'circuit_open');
    assert.equal(provider.state.calls, 1);

    // A failure that is about the request itself does not open the breaker
    now += 300001;
    provider.state.mode = '400';
    assert.equal((await search()).vectorSkipped, 'embedding_error');
    assert.equal(breaker.isOpen(), false);

    // 401/403 keep their existing behavior: the run stops at once, without the timed pause
    provider.state.mode = '401';
    provider.state.calls = 0;
    const auth = await processPendingEmbeddings(store, { scope: 'project', provider, breaker });
    assert.equal(auth.circuitBroken, true);
    assert.equal(auth.reason, 'auth_failed');
    assert.equal(provider.state.calls, 1);
    assert.equal(breaker.isOpen(), false);

    // A provider that ignores the query deadline (a local model still loading) and answers late:
    // the search has moved on, and the late answer closes the breaker that the timeout opened
    const slowBreaker = createEmbeddingBreaker({ cooldownMs: 300000 });
    const slowProvider = {
      name: 'mock',
      model: 'mock-embed-v1',
      dimensions: 4,
      async embed(texts) {
        await sleep(150);
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    };
    const slow = await searchMemory(store, {
      query: 'harbor',
      scope: 'project',
      embeddingProvider: slowProvider,
      embeddingBreaker: slowBreaker,
      queryTimeoutMs: 40,
    });
    assert.equal(slow.vectorSkipped, 'embedding_timeout');
    assert.equal(slowBreaker.isOpen(), true);
    await waitFor(() => !slowBreaker.isOpen(), { timeoutMs: 2000, label: 'late answer closes the breaker' });
    assert.equal(slowBreaker.isTripped(), false);

    // circuitBreakMs: 0 turns the pause off
    const noPause = createEmbeddingBreaker({ cooldownMs: 0 });
    noPause.recordFailure(new Error('down'));
    assert.equal(noPause.isOpen(), false);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('embed_attempts: an outage never counts against documents; only document-specific failures reach the cap of 3', async () => {
  const env = makeTempEnv('cortex-emb-attempts-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    assert.equal(MAX_EMBED_ATTEMPTS, 3);
    const ids = ['outage-a', 'outage-b', 'outage-c'];
    for (const id of ids) saveNote(store, id);
    const provider = makeProvider();

    // An outage that spans many queue runs (the old code gave up on every pending document after three)
    for (const mode of ['timeout', '503', '429', 'network', '500', '408']) {
      provider.state.mode = mode;
      for (let run = 0; run < 2; run++) {
        provider.state.calls = 0;
        const res = await processPendingEmbeddings(store, { scope: 'project', provider });
        assert.equal(res.reason, 'service_unavailable', mode);
        assert.equal(res.circuitBroken, true, mode);
        assert.equal(res.processed, 0, mode);
        assert.equal(res.errors, 1, mode);
        assert.equal(provider.state.calls, 1, `${mode}: the run stops at the first failure instead of failing every document`);
      }
    }
    for (const id of ids) {
      assert.equal(embedRow(store, 'project', id).embed_attempts, 0, `${id} keeps a clean attempt count`);
    }
    // The failure is still visible on the document that hit it
    const noted = ids.map((id) => embedRow(store, 'project', id)).filter((row) => row.embed_status === 'error');
    assert.ok(noted.length >= 1);
    assert.match(noted[0].embed_error, /Fake embedding failed|fetch failed|timeout/);
    assert.deepEqual(listFailedEmbeddings(store, { scope: 'project' }).project, NO_FAILED_DOCUMENTS);

    // 401/403 are not the document's fault either
    provider.state.mode = '403';
    for (let run = 0; run < 4; run++) {
      await processPendingEmbeddings(store, { scope: 'project', provider });
    }
    for (const id of ids) assert.equal(embedRow(store, 'project', id).embed_attempts, 0);

    // The service comes back: everything is embedded
    provider.state.mode = 'ok';
    const back = await processPendingEmbeddings(store, { scope: 'project', provider });
    assert.equal(back.processed, 3);
    assert.equal(back.circuitBroken, false);
    for (const id of ids) {
      assert.deepEqual(embedRow(store, 'project', id), { embed_status: 'ready', embed_attempts: 0, embed_error: '' });
    }

    // --- Failures that belong to one document ---
    saveNote(store, 'rejected-doc', { content: 'REJECT-ME content the service refuses' });
    saveNote(store, 'odd-vectors-doc', { content: 'ODD-VECTORS content' });
    saveNote(store, 'fine-doc');
    const picky = {
      name: 'mock',
      model: 'mock-embed-v1',
      dimensions: 4,
      calls: [],
      async embed(texts) {
        const joined = texts.join('\n');
        picky.calls.push(joined);
        if (joined.includes('REJECT-ME')) throw makeFailure('400');
        if (joined.includes('ODD-VECTORS')) return texts.map(() => new Float32Array(0));
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    };

    for (let run = 1; run <= 3; run++) {
      const res = await processPendingEmbeddings(store, { scope: 'project', provider: picky });
      assert.equal(res.circuitBroken, false, 'a rejected document does not stop the run');
      assert.equal(res.errors, 2);
      assert.equal(embedRow(store, 'project', 'rejected-doc').embed_attempts, run);
      assert.equal(embedRow(store, 'project', 'odd-vectors-doc').embed_attempts, run);
    }
    assert.deepEqual(embedRow(store, 'project', 'fine-doc'), { embed_status: 'ready', embed_attempts: 0, embed_error: '' });
    assert.match(embedRow(store, 'project', 'rejected-doc').embed_error, /Fake embedding failed \(400\)/);
    assert.match(embedRow(store, 'project', 'odd-vectors-doc').embed_error, /mismatched vector dimensions/);

    // At the cap they are left alone
    picky.calls.length = 0;
    const capped = await processPendingEmbeddings(store, { scope: 'project', provider: picky });
    assert.equal(capped.errors, 0);
    assert.deepEqual(picky.calls, []);

    // A document that failed earlier waits behind documents that have not been tried yet
    saveNote(store, 'retry-later', { content: 'REJECT-ME again' });
    await processPendingEmbeddings(store, { scope: 'project', provider: picky });
    assert.equal(embedRow(store, 'project', 'retry-later').embed_attempts, 1);
    saveNote(store, 'older-but-fresh');
    store.getTier('project').db
      .prepare("UPDATE docs SET updated_at = '2000-01-01T00:00:00.000+00:00' WHERE id = 'older-but-fresh'")
      .run();
    picky.calls.length = 0;
    await processPendingEmbeddings(store, { scope: 'project', provider: picky });
    assert.equal(picky.calls.length, 2);
    assert.ok(picky.calls[0].includes('older-but-fresh'), 'the untried document is embedded first');
    assert.ok(picky.calls[1].includes('REJECT-ME again'));
  } finally {
    store.close();
    env.cleanup();
  }
});

test('catch-up: a postponed queue run is retried after the breaker pause, and a recovered service triggers the queue without a new save', async () => {
  const env = makeTempEnv('cortex-emb-catchup-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  const queues = [];
  try {
    const isReady = (id, scope = 'project') => embedRow(store, scope, id)?.embed_status === 'ready';

    // --- 1. The run that hit the outage is retried once the pause is over (not dropped) ---
    {
      const breaker = createEmbeddingBreaker({ cooldownMs: 500 });
      const provider = makeProvider();
      const queue = createEmbeddingQueue(store, { provider, breaker, debounceMs: 5 });
      queues.push(queue);

      provider.state.mode = '503';
      saveNote(store, 'retry-after-pause');
      queue.schedule('project');
      await waitFor(() => provider.state.calls === 1 && breaker.isOpen(), { label: 'first failing run' });
      assert.equal(queue.hasPending(), true, 'the postponed run stays queued');

      provider.state.mode = 'ok';
      await sleep(80);
      assert.equal(provider.state.calls, 1, 'nothing is attempted during the pause');
      assert.equal(isReady('retry-after-pause'), false);

      await waitFor(() => isReady('retry-after-pause'), { label: 'retry after the pause' });
      assert.equal(provider.state.calls, 2);
      assert.equal(embedRow(store, 'project', 'retry-after-pause').embed_attempts, 0);
      await queue.drain(1000);
    }

    // --- 2. Saves made while the breaker is open are kept and processed when the pause is over ---
    {
      const breaker = createEmbeddingBreaker({ cooldownMs: 500 });
      const provider = makeProvider();
      const queue = createEmbeddingQueue(store, { provider, breaker, debounceMs: 5 });
      queues.push(queue);

      breaker.recordFailure(makeFailure('timeout'));
      saveNote(store, 'saved-during-pause-1');
      queue.schedule('project');
      saveNote(store, 'saved-during-pause-2', { scope: 'global' });
      queue.schedule('global');
      await sleep(80);
      assert.equal(provider.state.calls, 0);

      await waitFor(() => isReady('saved-during-pause-1') && isReady('saved-during-pause-2', 'global'), { label: 'queued saves after the pause' });
      await queue.drain(1000);
    }

    // --- 3. A successful query embedding closes the breaker and the backlog is embedded right away ---
    {
      let now = 9_000_000;
      const breaker = createEmbeddingBreaker({ cooldownMs: 300000, now: () => now });
      const provider = makeProvider();
      const queue = createEmbeddingQueue(store, { provider, breaker, debounceMs: 5 });
      queues.push(queue);

      provider.state.mode = 'network';
      saveNote(store, 'backlog-1');
      saveNote(store, 'backlog-2', { scope: 'global' });
      queue.schedule('project');
      await waitFor(() => breaker.isOpen() && queue.hasPending(), { label: 'outage noticed by the queue' });
      await queue.whenIdle();

      // The pause runs out (the queue's own retry is still five real minutes away) and the service is back
      now += 300001;
      provider.state.mode = 'ok';
      const res = await searchMemory(store, {
        query: 'harbor',
        scope: 'project',
        embeddingProvider: provider,
        embeddingBreaker: breaker,
      });
      assert.equal(res.vectorUsed, true);
      assert.equal(breaker.isTripped(), false);

      // No save, no schedule() call: recovery alone starts the queue, for both tiers
      await waitFor(() => isReady('backlog-1') && isReady('backlog-2', 'global'), { label: 'backlog after recovery' });
      await queue.drain(1000);
    }

    // --- 4. A backlog larger than one batch is worked off in follow-up runs ---
    {
      const provider = makeProvider();
      const queue = createEmbeddingQueue(store, { provider, debounceMs: 5, maxDocs: 2 });
      queues.push(queue);
      const batchIds = ['batch-1', 'batch-2', 'batch-3', 'batch-4', 'batch-5'];
      for (const id of batchIds) saveNote(store, id);
      queue.schedule('project');
      await waitFor(() => batchIds.every((id) => isReady(id)), { label: 'all batches' });
      await queue.drain(1000);
    }
  } finally {
    for (const queue of queues) queue.cancel();
    store.close();
    env.cleanup();
  }
});

test('MCP server start: documents left pending are embedded without any tool call (in-process runtime and real child process)', async () => {
  const env = makeTempEnv('cortex-emb-startup-');
  const stub = await startStubEmbedServer();
  let child = null;
  let checker = null;
  try {
    // Documents saved earlier, while no embedding ran
    writeGlobalConfig(env, { embedding: { provider: 'ollama', ollama: { baseUrl: stub.url, model: 'stub-embed' } } });
    const seed = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    saveNote(seed, 'left-over-project');
    saveNote(seed, 'left-over-global', { scope: 'global' });
    seed.close();

    // --- In-process: createServerRuntime schedules the queue on creation ---
    const provider = makeProvider({ name: 'ollama', model: 'stub-embed' });
    const runtime = createServerRuntime({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      promptsDir: PROMPTS_DIR,
      embeddingProvider: provider,
      embeddingBreaker: createEmbeddingBreaker(),
      queueDebounceMs: 5,
      input: new PassThrough(),
      output: new PassThrough(),
    });
    try {
      await waitFor(
        () => embedRow(runtime.store, 'project', 'left-over-project')?.embed_status === 'ready'
          && embedRow(runtime.store, 'global', 'left-over-global')?.embed_status === 'ready',
        { label: 'startup catch-up in the runtime' },
      );
      assert.equal(stub.requests.length, 0, 'the injected provider was used, not the configured one');

      // The runtime hands one breaker to search and to the queue
      provider.state.mode = '503';
      const search = await runtime.server.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'harbor', scope: 'project' } },
      });
      assert.equal(JSON.parse(search.result.content[0].text).vectorSkipped, 'embedding_error');
      assert.equal(runtime.embeddingBreaker.isOpen(), true);
      const callsAfterFailure = provider.state.calls;
      provider.state.mode = 'ok';
      const save = await runtime.server.handleMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory_save', arguments: { id: 'saved-while-open', type: 'knowledge', title: 'T', summary: 'S', content: 'harbor' } },
      });
      assert.equal(save.result.isError, undefined);
      const searchAgain = await runtime.server.handleMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'harbor', scope: 'project' } },
      });
      assert.equal(JSON.parse(searchAgain.result.content[0].text).vectorSkipped, 'circuit_open');
      await sleep(60);
      assert.equal(provider.state.calls, callsAfterFailure, 'neither the search nor the queue calls the provider while open');
      assert.equal(embedRow(runtime.store, 'project', 'saved-while-open').embed_status, 'pending');
    } finally {
      await runtime.shutdown();
    }

    // --- Child process: the real entry point, the real provider, a local stub service ---
    const seed2 = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    saveNote(seed2, 'left-over-for-child');
    seed2.close();

    child = spawn(
      process.execPath,
      [
        '--no-warnings',
        path.join(REPO_ROOT, 'src', 'mcp', 'server.mjs'),
        '--project', env.projectDir,
        '--global', env.globalDir,
        '--prompts', PROMPTS_DIR,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(env) },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
    let exitTimer = null;

    checker = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
    await waitFor(
      () => embedRow(checker, 'project', 'left-over-for-child')?.embed_status === 'ready'
        && embedRow(checker, 'project', 'saved-while-open')?.embed_status === 'ready',
      { timeoutMs: 15000, intervalMs: 25, label: `startup catch-up in the child process (stderr: ${stderr})` },
    );
    assert.ok(stub.requests.length >= 1);
    assert.equal(stub.requests[0].url, '/api/embed');
    assert.equal(stub.requests[0].body.model, 'stub-embed');
    checker.close();
    checker = null;

    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise((resolve) => { exitTimer = setTimeout(() => resolve('did not exit'), 15000); }),
    ]);
    clearTimeout(exitTimer);
    assert.equal(code, 0, stderr);
    child = null;

    assert.deepEqual(blockedFetches, []);
  } finally {
    if (child) child.kill();
    if (checker) checker.close();
    await stub.close();
    env.cleanup();
  }
});

test('given-up documents: counted with ids per tier in the status function and the embed summary; --retry-failed resets them', async () => {
  const env = makeTempEnv('cortex-emb-failed-');
  const prevExitCode = process.exitCode;
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    saveNote(store, 'stuck-p1');
    saveNote(store, 'stuck-p2');
    saveNote(store, 'stuck-g1', { scope: 'global' });
    saveNote(store, 'stuck-but-superseded', { status: 'superseded' });

    assert.deepEqual(listFailedEmbeddings(store), { project: NO_FAILED_DOCUMENTS, global: NO_FAILED_DOCUMENTS });

    const rejecting = makeProvider();
    rejecting.state.mode = '400';
    for (let run = 0; run < MAX_EMBED_ATTEMPTS; run++) {
      await processPendingEmbeddings(store, { scope: 'all', provider: rejecting });
    }

    const failed = listFailedEmbeddings(store);
    assert.equal(failed.project.count, 2);
    assert.deepEqual([...failed.project.ids].sort(), ['stuck-p1', 'stuck-p2']);
    assert.deepEqual(failed.global, {
      count: 1,
      ids: ['stuck-g1'],
      documents: [{ id: 'stuck-g1', reason: 'document_errors', error: 'Fake embedding failed (400)' }],
      byReason: { document_errors: 1, service_failures: 0 },
    });
    assert.deepEqual(failed.project.byReason, { document_errors: 2, service_failures: 0 });
    assert.deepEqual(Object.keys(listFailedEmbeddings(store, { scope: 'global' })), ['global']);
    assert.deepEqual(listFailedEmbeddings(store, { scope: 'project', maxIds: 1 }).project.ids.length, 1);
    assert.equal(listFailedEmbeddings(store, { scope: 'project', maxIds: 1 }).project.count, 2);

    // Status function
    const status = describeEmbeddingStatus(store.config, { env: {}, breaker: createEmbeddingBreaker(), store });
    assert.deepEqual(status.failedDocuments, failed);
    const lines = formatEmbeddingStatus(status).join('\n');
    assert.match(lines, /embedding gave up on 2 project document\(s\)/);
    assert.match(lines, /embedding gave up on 1 global document\(s\).*stuck-g1/);
    assert.match(lines, /npm run embed -- --retry-failed/);
    assert.equal('failedDocuments' in describeEmbeddingStatus(store.config, { env: {}, breaker: createEmbeddingBreaker() }), false);
    store.close();

    // npm run embed without the flag: they stay given up, and the summary says how many
    const working = makeProvider();
    process.exitCode = 0;
    const plain = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir],
      { provider: working, env: {}, stdout: makeSink(), stderr: makeSink() },
    );
    assert.equal(plain.processed, 0);
    assert.equal(working.state.calls, 0);
    assert.equal(plain.failedDocuments.project.count, 2);
    assert.equal(plain.failedDocuments.global.count, 1);
    assert.equal('retryReset' in plain, false);

    // --retry-failed: reset, embedded, nothing left
    const stdout = makeSink();
    const retried = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir, '--retry-failed'],
      { provider: working, env: {}, stdout, stderr: makeSink() },
    );
    assert.deepEqual(retried.retryReset, { project: 2, global: 1 });
    assert.equal(retried.processed, 3);
    assert.equal(retried.errors, 0);
    assert.deepEqual(retried.failedDocuments, { project: NO_FAILED_DOCUMENTS, global: NO_FAILED_DOCUMENTS });
    assert.deepEqual(JSON.parse(stdout.text), retried);
    assert.equal(process.exitCode, 0);

    const check = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    try {
      for (const [scope, id] of [['project', 'stuck-p1'], ['project', 'stuck-p2'], ['global', 'stuck-g1']]) {
        assert.deepEqual(embedRow(check, scope, id), { embed_status: 'ready', embed_attempts: 0, embed_error: '' });
      }

      // retryFailedEmbeddings on its own, limited to one tier
      saveNote(check, 'stuck-again');
      for (let run = 0; run < MAX_EMBED_ATTEMPTS; run++) {
        await processPendingEmbeddings(check, { scope: 'project', provider: rejecting });
      }
      assert.equal(embedRow(check, 'project', 'stuck-again').embed_attempts, 3);
      assert.deepEqual(retryFailedEmbeddings(check, { scope: 'global' }), { global: 0 });
      assert.equal(embedRow(check, 'project', 'stuck-again').embed_attempts, 3);
      assert.deepEqual(retryFailedEmbeddings(check, { scope: 'project' }), { project: 1 });
      assert.deepEqual(embedRow(check, 'project', 'stuck-again'), { embed_status: 'pending', embed_attempts: 0, embed_error: '' });
    } finally {
      check.close();
    }
  } finally {
    process.exitCode = prevExitCode;
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// D. Orphan vectors and project_dir scheduling
// ---------------------------------------------------------------------------------------------

test('orphan vectors: rows left behind by a connection without the vector extension are deleted by the next vector-enabled sync', async () => {
  const env = makeTempEnv('cortex-emb-orphans-');
  const vecStore = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  let hookStore = null;
  try {
    const provider = makeProvider();
    saveNote(vecStore, 'keep-doc');
    saveNote(vecStore, 'gone-doc');
    assert.equal((await processPendingEmbeddings(vecStore, { scope: 'project', provider })).processed, 2);
    const tier = vecStore.getTier('project');
    assert.equal(tier.vecAvailable, true);
    assert.ok(vectorCount(vecStore, 'project', 'gone-doc') > 0);

    // A hook process (no vector extension) notices the deleted file and removes the document row
    const gonePath = path.join(tier.dir, tier.db.prepare("SELECT path FROM docs WHERE id = 'gone-doc'").get().path);
    fs.unlinkSync(gonePath);
    hookStore = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
    assert.equal(hookStore.sync('project').project.deleted, 1);
    hookStore.close();
    hookStore = null;

    // The row is gone for everyone, its vectors are still there
    assert.equal(tier.db.prepare("SELECT COUNT(*) AS cnt FROM docs WHERE id = 'gone-doc'").get().cnt, 0);
    assert.ok(vectorCount(vecStore, 'project', 'gone-doc') > 0, 'premise: the hook process could not delete the vectors');

    // The vector-enabled process syncs (nothing changed on disk from its point of view) and cleans up
    const synced = vecStore.sync('project').project;
    assert.ok(synced.orphanVectorsRemoved >= 1);
    assert.equal(vectorCount(vecStore, 'project', 'gone-doc'), 0);
    assert.ok(vectorCount(vecStore, 'project', 'keep-doc') > 0);
    assert.equal(embedRow(vecStore, 'project', 'keep-doc').embed_status, 'ready');

    // Nothing left to do afterwards: the usual result shape, no repeated scan result
    assert.deepEqual(vecStore.sync('project').project, { addedOrUpdated: 0, statUpdated: 0, deleted: 0 });

    // Search over the remaining vectors still works
    const res = await searchMemory(vecStore, { query: 'harbor', scope: 'project', embeddingProvider: provider });
    assert.equal(res.vectorUsed, true);
    assert.deepEqual(res.results.map((r) => r.id), ['keep-doc']);
  } finally {
    if (hookStore) hookStore.close();
    vecStore.close();
    env.cleanup();
  }
});

test('orphan vectors: an index that already carries leftovers (no marker) is cleaned by the first vector-enabled sync of a process', async () => {
  const env = makeTempEnv('cortex-emb-orphans-old-');
  let store = null;
  try {
    // Another process builds the leftover state: vectors for a document whose row a hook process removed,
    // in an index written before the cleanup marker existed.
    const seedScript = path.join(env.root, 'seed-orphans.mjs');
    fs.writeFileSync(seedScript, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'const [storeUrl, embeddingsUrl, projectDir, globalDir] = process.argv.slice(2);',
      'const { CortexStore } = await import(storeUrl);',
      'const { processPendingEmbeddings } = await import(embeddingsUrl);',
      "const provider = { name: 'mock', model: 'mock-embed-v1', dimensions: 4, async embed(texts) { return texts.map(() => new Float32Array([1, 0, 0, 0])); } };",
      'const vecStore = new CortexStore({ projectDir, globalDir });',
      "for (const id of ['old-keep', 'old-gone']) vecStore.saveDoc({ id, type: 'knowledge', title: id, summary: id, content: `harbor ${id}` });",
      "const res = await processPendingEmbeddings(vecStore, { scope: 'project', provider });",
      "if (res.processed !== 2) throw new Error(`seed embedded ${res.processed} documents`);",
      "const tier = vecStore.getTier('project');",
      "const gonePath = path.join(tier.dir, tier.db.prepare(\"SELECT path FROM docs WHERE id = 'old-gone'\").get().path);",
      'vecStore.close();',
      'fs.unlinkSync(gonePath);',
      'const plain = new CortexStore({ projectDir, globalDir, disableVec: true });',
      "plain.sync('project');",
      "plain.getTier('project').db.prepare(\"DELETE FROM index_meta WHERE key = 'vecCleanupPending'\").run();",
      'plain.close();',
      '',
    ].join('\n'), 'utf8');
    const seeded = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        seedScript,
        pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'store.mjs')).href,
        pathToFileURL(path.join(REPO_ROOT, 'src', 'embeddings', 'index.mjs')).href,
        env.projectDir,
        env.globalDir,
      ],
      { encoding: 'utf8', env: childEnv(env), timeout: 30000 },
    );
    assert.equal(seeded.status, 0, seeded.stderr);

    store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    assert.ok(vectorCount(store, 'project', 'old-gone') > 0, 'premise: the index carries orphan vectors');
    assert.equal(store.getTier('project').db.prepare("SELECT COUNT(*) AS cnt FROM docs WHERE id = 'old-gone'").get().cnt, 0);

    const synced = store.sync('project').project;
    assert.ok(synced.orphanVectorsRemoved >= 1);
    assert.equal(vectorCount(store, 'project', 'old-gone'), 0);
    assert.ok(vectorCount(store, 'project', 'old-keep') > 0);
  } finally {
    if (store) store.close();
    env.cleanup();
  }
});

test('memory_save / memory_update with project_dir: the other project (or the global tier) is scheduled for embedding, and no DB handle stays open', async () => {
  const env = makeTempEnv('cortex-emb-projectdir-');
  const otherProject = path.join(env.root, 'other-project');
  fs.mkdirSync(otherProject, { recursive: true });
  approveAsUser(otherProject, { globalDir: env.globalDir });
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  const provider = makeProvider();
  let opened = 0;
  let closed = 0;
  const queue = createEmbeddingQueue(store, {
    provider,
    debounceMs: 5,
    openProjectStore: (projectDir) => {
      opened++;
      const other = new CortexStore({ projectDir, globalDir: env.globalDir });
      const close = other.close.bind(other);
      other.close = () => {
        closed++;
        close();
      };
      return other;
    },
    getProviderFor: async () => provider,
  });
  try {
    const registry = createToolRegistry(store, { promptsDir: PROMPTS_DIR, embeddingQueue: queue });
    const call = async (name, args) => {
      const outcome = await registry.callTool(name, args, {});
      assert.equal(outcome.isError, false, JSON.stringify(outcome.data));
      return outcome.data;
    };
    const otherRow = (id) => {
      const peek = new CortexStore({ projectDir: otherProject, globalDir: env.globalDir, disableVec: true });
      try {
        return embedRow(peek, 'project', id);
      } finally {
        peek.close();
      }
    };

    // Save into another project
    await call('memory_save', {
      id: 'other-doc',
      type: 'knowledge',
      title: 'Saved elsewhere',
      summary: 'Written through project_dir',
      content: 'harbor notes of the other project',
      project_dir: otherProject,
    });
    await waitFor(() => otherRow('other-doc')?.embed_status === 'ready', { label: 'embedding in the other project' });
    assert.equal(fs.existsSync(path.join(env.projectDir, '.memory')), false, 'the default project is not touched');

    // Update there: content changes, so it is embedded again
    const callsBefore = provider.state.calls;
    await call('memory_update', { id: 'other-doc', content: 'rewritten harbor notes', project_dir: otherProject });
    await waitFor(() => provider.state.calls > callsBefore && otherRow('other-doc')?.embed_status === 'ready', { label: 're-embedding after update' });
    assert.ok(provider.state.texts.at(-1).join('\n').includes('rewritten harbor notes'));

    // scope "global" with project_dir: the global tier is embedded
    await call('memory_save', {
      id: 'global-via-other',
      scope: 'global',
      type: 'knowledge',
      title: 'Global note',
      summary: 'Saved with project_dir and scope global',
      content: 'harbor preference',
      project_dir: otherProject,
    });
    await waitFor(() => embedRow(store, 'global', 'global-via-other')?.embed_status === 'ready', { label: 'embedding in the global tier' });
    await call('memory_update', { id: 'global-via-other', scope: 'global', content: 'harbor preference v2', project_dir: otherProject });
    await waitFor(
      () => provider.state.texts.at(-1).join('\n').includes('harbor preference v2')
        && embedRow(store, 'global', 'global-via-other')?.embed_status === 'ready',
      { label: 're-embedding in the global tier' },
    );

    // The default project still works as before
    await call('memory_save', { id: 'own-doc', type: 'knowledge', title: 'Own', summary: 'Own project', content: 'harbor' });
    await waitFor(() => embedRow(store, 'project', 'own-doc')?.embed_status === 'ready', { label: 'embedding in the default project' });

    // Every store opened for another project was closed again
    await queue.drain(2000);
    assert.ok(opened >= 2);
    assert.equal(closed, opened);
    assert.doesNotThrow(() => fs.rmSync(otherProject, { recursive: true, force: true }), 'no open handle keeps the other project locked');
    assert.equal(fs.existsSync(otherProject), false);

    // A queue that cannot open other projects ignores them instead of embedding the wrong store
    const plainQueue = createEmbeddingQueue(store, { provider, debounceMs: 5 });
    plainQueue.schedule('project', { projectDir: path.join(env.root, 'nowhere') });
    assert.equal(plainQueue.hasPending(), false);
    plainQueue.cancel();
  } finally {
    queue.cancel();
    store.close();
    env.cleanup();
  }
});

test('memory_save with project_dir through the server runtime: embedded with a store the runtime opens and closes itself', async () => {
  const env = makeTempEnv('cortex-emb-runtime-dir-');
  const otherProject = path.join(env.root, 'other-project');
  fs.mkdirSync(otherProject, { recursive: true });
  approveAsUser(otherProject, { globalDir: env.globalDir });
  const provider = makeProvider();
  const runtime = createServerRuntime({
    projectDir: env.projectDir,
    globalDir: env.globalDir,
    promptsDir: PROMPTS_DIR,
    embeddingProvider: provider,
    embeddingBreaker: createEmbeddingBreaker(),
    queueDebounceMs: 5,
    input: new PassThrough(),
    output: new PassThrough(),
  });
  try {
    const response = await runtime.server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'memory_save',
        arguments: { id: 'runtime-other-doc', type: 'knowledge', title: 'T', summary: 'S', content: 'harbor', project_dir: otherProject },
      },
    });
    assert.equal(response.result.isError, undefined, response.result.content[0].text);

    await waitFor(() => {
      const peek = new CortexStore({ projectDir: otherProject, globalDir: env.globalDir, disableVec: true });
      try {
        return embedRow(peek, 'project', 'runtime-other-doc')?.embed_status === 'ready';
      } finally {
        peek.close();
      }
    }, { label: 'embedding through the runtime queue' });

    await runtime.shutdown();
    assert.doesNotThrow(() => fs.rmSync(otherProject, { recursive: true, force: true }));
  } finally {
    await runtime.shutdown();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// E. Leftovers from phase 1
// ---------------------------------------------------------------------------------------------

test('MCP server: instructions mention supersedes for memory_update, and non-object tool arguments get -32602', async () => {
  const env = makeTempEnv('cortex-emb-server-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    assert.match(SERVER_INSTRUCTIONS, /memory_update\([^)]*supersedes[^)]*\)/);

    const server = createMcpServer({ store, includeRelayTools: false });
    const initialized = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.match(initialized.result.instructions, /memory_update\([^)]*supersedes/);

    const callWith = (args, id = 7) => server.handleMessage({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'memory_overview', ...(args === undefined ? {} : { arguments: args }) },
    });

    for (const bad of [['session-a'], [], 'session-a', 42, true]) {
      const response = await callWith(bad);
      assert.equal(response.id, 7);
      assert.equal(response.result, undefined, `arguments ${JSON.stringify(bad)} must not reach the tool`);
      assert.equal(response.error.code, -32602);
      assert.match(response.error.message, /"arguments" must be an object/);
    }

    // An object, null, or no arguments at all are still fine
    for (const good of [{}, { include_global: false }, null, undefined]) {
      const response = await callWith(good);
      assert.equal(response.error, undefined, JSON.stringify(good));
      assert.equal(response.result.isError, undefined);
    }

    // The existing checks keep their codes
    const noName = await server.handleMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { arguments: {} } });
    assert.equal(noName.error.code, -32602);
    const unknownArg = await callWith({ no_such_argument: 1 });
    assert.equal(unknownArg.result.isError, true);
    assert.equal(JSON.parse(unknownArg.result.content[0].text).error, 'UNKNOWN_ARGUMENT');
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// A document that keeps making the service fail is given up on in the end
// ---------------------------------------------------------------------------------------------

function serviceFailures(store, scope, id) {
  return store.getTier(scope).db
    .prepare('SELECT embed_service_failures FROM docs WHERE id = ?')
    .get(id).embed_service_failures;
}

test('service-side failures are counted per document, apart from embed_attempts: after 10 on the same document it is given up on, listed with its reason, and --retry-failed resets it', async () => {
  const env = makeTempEnv('cortex-emb-service-failures-');
  const prevExitCode = process.exitCode;
  let store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    assert.equal(MAX_EMBED_SERVICE_FAILURES, 10);

    saveNote(store, 'healthy-1');
    saveNote(store, 'healthy-2');
    // The newest document is tried first; this one makes the service answer 503 every time
    saveNote(store, 'poison', { content: 'POISON-TEXT that the service chokes on' });
    assert.equal(serviceFailures(store, 'project', 'poison'), 0);

    const provider = makeProvider();
    provider.state.mode = (texts) => (texts.join('\n').includes('POISON-TEXT') ? '503' : 'ok');
    // No pause between runs: every call below stands for "the next breaker window"
    const breaker = createEmbeddingBreaker({ cooldownMs: 0 });
    const run = () => processPendingEmbeddings(store, { scope: 'project', provider, breaker });

    // Run 1: the poison document fails first and stops the run
    const first = await run();
    assert.equal(first.reason, 'service_unavailable');
    assert.equal(first.processed, 0);
    assert.equal(serviceFailures(store, 'project', 'poison'), 1);
    assert.equal(embedRow(store, 'project', 'poison').embed_attempts, 0, 'not counted as the document\'s own failure');

    // Run 2: having failed, it now waits behind the others, which are embedded
    const second = await run();
    assert.equal(second.processed, 2);
    assert.equal(second.reason, 'service_unavailable');
    assert.equal(serviceFailures(store, 'project', 'poison'), 2);
    assert.equal(embedRow(store, 'project', 'healthy-1').embed_status, 'ready');
    assert.equal(serviceFailures(store, 'project', 'healthy-1'), 0);

    // A change that leaves the text alone keeps the count
    store.updateDoc({ id: 'poison', tags: ['still-the-same-text'] });
    assert.equal(serviceFailures(store, 'project', 'poison'), 2);

    for (let n = 3; n <= MAX_EMBED_SERVICE_FAILURES; n++) {
      assert.deepEqual(listFailedEmbeddings(store, { scope: 'project' }).project, NO_FAILED_DOCUMENTS, `not given up before failure ${n}`);
      const res = await run();
      assert.equal(res.reason, 'service_unavailable', `run ${n}`);
      assert.equal(serviceFailures(store, 'project', 'poison'), n);
    }
    assert.deepEqual(embedRow(store, 'project', 'poison'), {
      embed_status: 'error',
      embed_attempts: 0,
      embed_error: 'Fake embedding failed (503)',
    });

    // Given up: the next runs do not touch it, so it no longer re-opens the breaker
    const callsBefore = provider.state.calls;
    const after = await run();
    assert.equal(provider.state.calls, callsBefore);
    assert.equal(after.errors, 0);
    assert.equal(after.circuitBroken, false);
    assert.equal('reason' in after, false);

    // Listed with a reason that tells it apart from a document that failed on its own
    saveNote(store, 'rejected', { content: 'REJECT-ME says the service with a 400' });
    provider.state.mode = (texts) => (texts.join('\n').includes('REJECT-ME') ? '400' : 'ok');
    for (let i = 0; i < MAX_EMBED_ATTEMPTS; i++) await run();
    const failed = listFailedEmbeddings(store, { scope: 'project' }).project;
    assert.equal(failed.count, 2);
    assert.deepEqual(failed.byReason, { document_errors: 1, service_failures: 1 });
    assert.deepEqual(
      [...failed.documents].sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: 'poison', reason: 'service_failures', error: 'Fake embedding failed (503)' },
        { id: 'rejected', reason: 'document_errors', error: 'Fake embedding failed (400)' },
      ],
    );
    const lines = formatEmbeddingStatus(describeEmbeddingStatus(store.config, { env: {}, breaker, store })).join('\n');
    assert.match(lines, /embedding gave up on 2 project document\(s\) after repeated failures/);
    assert.match(lines, /1 of them because the embedding service failed 10 times on the same document \(timeout, network or server error\): poison/);

    // New content gives the document a fresh start ...
    store.updateDoc({ id: 'poison', content: 'POISON-TEXT, edited but still poisonous' });
    assert.equal(serviceFailures(store, 'project', 'poison'), 0);
    assert.equal(listFailedEmbeddings(store, { scope: 'project' }).project.byReason.service_failures, 0);
    provider.state.mode = (texts) => (texts.join('\n').includes('POISON-TEXT') ? 'timeout' : 'ok');
    await run();
    assert.equal(serviceFailures(store, 'project', 'poison'), 1);
    // ... and so does a successful embedding
    provider.state.mode = 'ok';
    saveNote(store, 'flaky', { content: 'Body of a document that failed a few times during an outage' });
    store.getTier('project').db.prepare("UPDATE docs SET embed_service_failures = 4, embed_status = 'error' WHERE id = 'flaky'").run();
    await run();
    assert.equal(embedRow(store, 'project', 'flaky').embed_status, 'ready');
    assert.equal(serviceFailures(store, 'project', 'flaky'), 0);
    assert.equal(embedRow(store, 'project', 'poison').embed_status, 'ready');

    // --retry-failed resets a document given up for this reason too
    store.getTier('project').db
      .prepare("UPDATE docs SET embed_service_failures = 10, embed_status = 'error', embed_error = 'Fake embedding failed (503)' WHERE id = 'poison'")
      .run();
    store.getTier('project').db.prepare("DELETE FROM doc_chunks_vec WHERE doc_id = 'poison'").run();
    assert.equal(listFailedEmbeddings(store, { scope: 'project' }).project.byReason.service_failures, 1);
    store.close();
    store = null;

    const working = makeProvider();
    process.exitCode = 0;
    const plain = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir],
      { provider: working, env: {}, stdout: makeSink(), stderr: makeSink() },
    );
    assert.deepEqual(plain.failedDocuments.project.byReason, { document_errors: 1, service_failures: 1 });
    assert.equal(plain.failedDocuments.project.documents.find((doc) => doc.id === 'poison').reason, 'service_failures');
    assert.equal(working.state.calls, 0);

    const retried = await runEmbedCli(
      ['--project', env.projectDir, '--global', env.globalDir, '--retry-failed'],
      { provider: working, env: {}, stdout: makeSink(), stderr: makeSink() },
    );
    assert.deepEqual(retried.retryReset, { project: 2, global: 0 });
    assert.equal(retried.processed, 2);
    assert.deepEqual(retried.failedDocuments.project, NO_FAILED_DOCUMENTS);

    store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    assert.equal(serviceFailures(store, 'project', 'poison'), 0);
    assert.equal(embedRow(store, 'project', 'poison').embed_status, 'ready');

    // --- An index created before this column existed gets it on open ---
    const dbPath = store.getTier('project').dbPath;
    store.close();
    store = null;
    const raw = new DatabaseSync(dbPath);
    raw.exec('ALTER TABLE docs DROP COLUMN embed_service_failures;');
    assert.equal(raw.prepare('PRAGMA table_info(docs)').all().some((col) => col.name === 'embed_service_failures'), false);
    raw.close();
    store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    assert.equal(serviceFailures(store, 'project', 'poison'), 0);
    saveNote(store, 'after-migration');
    assert.equal((await processPendingEmbeddings(store, { scope: 'project', provider: working })).processed, 1);
  } finally {
    process.exitCode = prevExitCode;
    if (store) store.close();
    env.cleanup();
  }
});

test('a long outage is not charged to one document: service failures rotate over the waiting documents', async () => {
  const env = makeTempEnv('cortex-emb-outage-spread-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    const ids = ['wait-a', 'wait-b', 'wait-c'];
    for (const id of ids) saveNote(store, id);
    const provider = makeProvider();
    provider.state.mode = 'network';
    const breaker = createEmbeddingBreaker({ cooldownMs: 0 });

    // 18 windows of an outage: more than the per-document limit, spread over three documents
    for (let window = 0; window < 18; window++) {
      const res = await processPendingEmbeddings(store, { scope: 'project', provider, breaker });
      assert.equal(res.reason, 'service_unavailable');
    }
    assert.deepEqual(ids.map((id) => serviceFailures(store, 'project', id)), [6, 6, 6]);
    assert.deepEqual(listFailedEmbeddings(store, { scope: 'project' }).project, NO_FAILED_DOCUMENTS);

    provider.state.mode = 'ok';
    const back = await processPendingEmbeddings(store, { scope: 'project', provider, breaker });
    assert.equal(back.processed, 3);
    assert.deepEqual(ids.map((id) => serviceFailures(store, 'project', id)), [0, 0, 0]);
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// The global tier always uses the global embedding settings
// ---------------------------------------------------------------------------------------------

test('global tier embedding: follows the global settings only; per-project settings embed and search that project\'s tier, and a second project never rebuilds the shared index', async () => {
  const env = makeTempEnv('cortex-emb-tiers-');
  const prevExitCode = process.exitCode;
  // Three stand-in Ollama servers with different vector sizes: a query vector of the wrong provider
  // could not match anything in the other provider's index
  const stubX = await startStubEmbedServer({ vector: [1, 0, 0, 0] });
  const stubY = await startStubEmbedServer({ vector: [0, 1, 0] });
  const stubZ = await startStubEmbedServer({ vector: [0, 0, 1, 0, 0] });
  const runtimes = [];
  try {
    const projA = env.projectDir;
    const projB = path.join(env.root, 'project-b');
    const projC = path.join(env.root, 'project-c');
    for (const dir of [projB, projC]) {
      fs.mkdirSync(dir, { recursive: true });
      approveAsUser(dir, { globalDir: env.globalDir });
    }
    writeGlobalConfig(env, {
      embedding: { provider: 'ollama', ollama: { baseUrl: stubY.url, model: 'model-y' } },
      projects: {
        [projA]: { embedding: { ollama: { baseUrl: stubX.url, model: 'model-x' } } },
        [projB]: { embedding: { ollama: { baseUrl: stubZ.url, model: 'model-z' } } },
      },
    });

    const startRuntime = (projectDir) => {
      const runtime = createServerRuntime({
        projectDir,
        globalDir: env.globalDir,
        promptsDir: PROMPTS_DIR,
        embeddingBreaker: createEmbeddingBreaker(),
        queueDebounceMs: 5,
        input: new PassThrough(),
        output: new PassThrough(),
      });
      runtimes.push(runtime);
      return runtime;
    };
    const call = async (runtime, name, args) => {
      const resp = await runtime.server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      assert.ok(!resp.result.isError, resp.result.content[0].text);
      return JSON.parse(resp.result.content[0].text);
    };
    const isReady = (store, scope, id) => embedRow(store, scope, id)?.embed_status === 'ready';
    const inputsOf = (stub) => stub.requests.flatMap((req) => req.body.input);
    const modelsOf = (stub) => [...new Set(stub.requests.map((req) => req.body.model))];
    const globalMeta = (store) => {
      const meta = readIndexMeta(store.getTier('global').db);
      return { model: meta.embedModel, dimensions: meta.dimensions };
    };

    // --- Project A (model-x): its documents go to X, the global document goes to Y ---
    const runtimeA = startRuntime(projA);
    await call(runtimeA, 'memory_save', { id: 'a-doc', type: 'knowledge', title: 'Alpha note', summary: 'Harbor logistics in project A', content: 'ALPHA-PROJECT-BODY' });
    await call(runtimeA, 'memory_save', { id: 'g-doc', scope: 'global', type: 'knowledge', title: 'Shared note', summary: 'A preference shared by all projects', content: 'GLOBAL-SHARED-BODY' });
    await waitFor(() => isReady(runtimeA.store, 'project', 'a-doc') && isReady(runtimeA.store, 'global', 'g-doc'), { label: 'project A embedded' });

    assert.deepEqual(modelsOf(stubX), ['model-x']);
    assert.deepEqual(modelsOf(stubY), ['model-y']);
    assert.ok(inputsOf(stubX).some((text) => text.includes('ALPHA-PROJECT-BODY')));
    assert.equal(inputsOf(stubX).some((text) => text.includes('GLOBAL-SHARED-BODY')), false, 'the global document never went to the project\'s provider');
    assert.ok(inputsOf(stubY).some((text) => text.includes('GLOBAL-SHARED-BODY')));
    assert.equal(inputsOf(stubY).some((text) => text.includes('ALPHA-PROJECT-BODY')), false);
    assert.deepEqual(globalMeta(runtimeA.store), { model: 'model-y', dimensions: 3 });
    assert.equal(readIndexMeta(runtimeA.store.getTier('project').db).embedModel, 'model-x');
    assert.equal(readIndexMeta(runtimeA.store.getTier('project').db).dimensions, 4);
    assert.equal(stubZ.requests.length, 0);

    // A search embeds the query once with each tier's provider and gets vector hits from both tiers
    // (the query shares no word with either document, so every hit is a vector hit)
    const beforeX = stubX.requests.length;
    const beforeY = stubY.requests.length;
    const foundA = await call(runtimeA, 'memory_search', { query: 'zzqx-unrelated-words', scope: 'all' });
    assert.equal(foundA.vectorUsed, true);
    assert.equal('vectorSkipped' in foundA, false);
    assert.deepEqual(foundA.results.map((r) => `${r.scope}:${r.id}`).sort(), ['global:g-doc', 'project:a-doc']);
    assert.deepEqual(stubX.requests.slice(beforeX).map((req) => req.body.input), [['zzqx-unrelated-words']]);
    assert.deepEqual(stubY.requests.slice(beforeY).map((req) => req.body.input), [['zzqx-unrelated-words']]);

    // Status and `npm run embed` name both providers when they differ
    const statusA = describeEmbeddingStatus(runtimeA.store.config, { env: {}, breaker: createEmbeddingBreaker(), store: runtimeA.store });
    assert.equal(statusA.model, 'model-x');
    assert.equal(statusA.host, new URL(stubX.url).host);
    assert.deepEqual(
      { provider: statusA.globalTier.provider, model: statusA.globalTier.model, host: statusA.globalTier.host, local: statusA.globalTier.local },
      { provider: 'ollama', model: 'model-y', host: new URL(stubY.url).host, local: true },
    );
    const statusLines = formatEmbeddingStatus(statusA);
    assert.match(statusLines[0], /^embedding \(this project's memory\): ollama, model model-x; /);
    assert.match(statusLines[1], /^embedding \(global memory, shared by all projects\): ollama, model model-y; /);
    await runtimeA.shutdown();

    const stderrA = makeSink();
    process.exitCode = 0;
    const summaryA = await runEmbedCli(['--project', projA, '--global', env.globalDir], { env: {}, stdout: makeSink(), stderr: stderrA });
    assert.equal(summaryA.errors, 0);
    assert.equal(summaryA.model, 'model-x');
    assert.deepEqual(
      { project: summaryA.tiers.project.model, global: summaryA.tiers.global.model },
      { project: 'model-x', global: 'model-y' },
    );
    assert.equal(summaryA.tiers.project.sendsTo, new URL(stubX.url).host);
    assert.equal(summaryA.tiers.global.sendsTo, new URL(stubY.url).host);
    assert.deepEqual(summaryA.rebuiltTiers, []);
    assert.match(stderrA.text, /embedding \(this project's memory\): ollama, model model-x/);
    assert.match(stderrA.text, /embedding \(global memory, shared by all projects\): ollama, model model-y/);

    // --- Project B (model-z) opens the same global store: the shared index is left as it is ---
    const yDocumentRequests = stubY.requests.length;
    const runtimeB = startRuntime(projB);
    await call(runtimeB, 'memory_save', { id: 'b-doc', type: 'knowledge', title: 'Beta note', summary: 'Harbor logistics in project B', content: 'BETA-PROJECT-BODY' });
    await waitFor(() => isReady(runtimeB.store, 'project', 'b-doc'), { label: 'project B embedded' });
    await runtimeB.embeddingQueue.whenIdle();

    assert.deepEqual(modelsOf(stubZ), ['model-z']);
    assert.ok(inputsOf(stubZ).some((text) => text.includes('BETA-PROJECT-BODY')));
    assert.equal(inputsOf(stubZ).some((text) => text.includes('GLOBAL-SHARED-BODY')), false, 'project B\'s provider did not re-embed the global document');
    assert.deepEqual(globalMeta(runtimeB.store), { model: 'model-y', dimensions: 3 }, 'the global vector table was not rebuilt');
    assert.equal(isReady(runtimeB.store, 'global', 'g-doc'), true);
    assert.equal(vectorCount(runtimeB.store, 'global', 'g-doc'), 1);
    assert.equal(stubY.requests.length, yDocumentRequests, 'nothing was embedded again for the global tier');

    const foundB = await call(runtimeB, 'memory_search', { query: 'zzqx-unrelated-words', scope: 'all' });
    assert.equal(foundB.vectorUsed, true);
    assert.deepEqual(foundB.results.map((r) => `${r.scope}:${r.id}`).sort(), ['global:g-doc', 'project:b-doc']);
    await runtimeB.shutdown();

    // --- Project C has no settings of its own: one provider serves both tiers, one query embedding ---
    const runtimeC = startRuntime(projC);
    await call(runtimeC, 'memory_save', { id: 'c-doc', type: 'knowledge', title: 'Gamma note', summary: 'Harbor logistics in project C', content: 'GAMMA-PROJECT-BODY' });
    await waitFor(() => isReady(runtimeC.store, 'project', 'c-doc'), { label: 'project C embedded' });
    const providersC = await runtimeC.getEmbeddingProviders();
    assert.equal(providersC.project, providersC.global, 'the same provider instance for both tiers');
    const statusC = describeEmbeddingStatus(runtimeC.store.config, { env: {}, breaker: createEmbeddingBreaker(), store: runtimeC.store });
    assert.equal('globalTier' in statusC, false);
    assert.match(formatEmbeddingStatus(statusC)[0], /^embedding: ollama, model model-y; /);
    const beforeQueryC = stubY.requests.length;
    const foundC = await call(runtimeC, 'memory_search', { query: 'zzqx-unrelated-words', scope: 'all' });
    assert.deepEqual(foundC.results.map((r) => `${r.scope}:${r.id}`).sort(), ['global:g-doc', 'project:c-doc']);
    assert.equal(stubY.requests.length - beforeQueryC, 1, 'the query vector is reused for the second tier');

    // --- The same through the library calls, with injected providers per tier ---
    const fakeX = makeProvider({ name: 'fake-x', model: 'fake-x-v1', dimensions: 4 });
    const fakeY = makeProvider({ name: 'ollama', model: 'model-y', dimensions: 3 });
    fakeY.embed = async (texts) => {
      fakeY.state.calls++;
      fakeY.state.texts.push(texts);
      if (fakeY.state.mode !== 'ok') throw makeFailure(fakeY.state.mode);
      return texts.map(() => new Float32Array([0, 1, 0]));
    };
    await call(runtimeC, 'memory_save', { id: 'g-doc-2', scope: 'global', type: 'knowledge', title: 'Second shared note', summary: 'Another shared preference', content: 'GLOBAL-SECOND-BODY' });
    await waitFor(() => isReady(runtimeC.store, 'global', 'g-doc-2'), { label: 'second global document embedded' });
    await runtimeC.shutdown();

    const store = new CortexStore({ projectDir: projC, globalDir: env.globalDir });
    try {
      saveNote(store, 'c-doc-2');
      saveNote(store, 'g-doc-3', { scope: 'global' });
      const res = await processPendingEmbeddings(store, { scope: 'all', providers: { project: fakeX, global: fakeY } });
      assert.deepEqual(res.rebuiltTiers, ['project'], 'only the tier whose provider changed is rebuilt');
      assert.deepEqual(
        { project: [res.tiers.project.provider, res.tiers.project.model, res.tiers.project.processed], global: [res.tiers.global.provider, res.tiers.global.model, res.tiers.global.processed] },
        { project: ['fake-x', 'fake-x-v1', 2], global: ['ollama', 'model-y', 1] },
      );
      assert.equal(fakeY.state.texts.flat().some((text) => text.includes('c-doc')), false);
      assert.equal(fakeX.state.texts.flat().some((text) => text.includes('g-doc')), false);

      // A tier without a provider is skipped, the other one is still served
      saveNote(store, 'g-doc-4', { scope: 'global' });
      saveNote(store, 'c-doc-3');
      const partial = await processPendingEmbeddings(store, { scope: 'all', providers: { project: null, global: fakeY } });
      assert.equal(partial.processed, 1);
      assert.equal(embedRow(store, 'project', 'c-doc-3').embed_status, 'pending');
      assert.equal((await processPendingEmbeddings(store, { scope: 'all', providers: { project: null, global: null } })).reason, 'no_provider');

      // Search: one failing provider does not take the other tier's vector hits away
      fakeX.state.calls = 0;
      fakeY.state.calls = 0;
      const both = await searchMemory(store, { query: 'zzqx-unrelated-words', scope: 'all', embeddingProviders: { project: fakeX, global: fakeY } });
      assert.equal(both.vectorUsed, true);
      assert.deepEqual([fakeX.state.calls, fakeY.state.calls], [1, 1]);
      assert.ok(both.results.some((r) => r.scope === 'project') && both.results.some((r) => r.scope === 'global'));

      fakeX.state.mode = '503';
      const half = await searchMemory(store, { query: 'zzqx-unrelated-words', scope: 'all', embeddingProviders: { project: fakeX, global: fakeY } });
      assert.equal(half.vectorSkipped, 'embedding_error');
      assert.equal(half.vectorUsed, true);
      assert.deepEqual([...new Set(half.results.map((r) => r.scope))], ['global']);
      fakeX.state.mode = 'ok';

      // A tier whose index was built with another model gets no vector search from the wrong provider
      const wrong = makeProvider({ name: 'fake-w', model: 'fake-w-v1', dimensions: 4 });
      const mismatched = await searchMemory(store, { query: 'zzqx-unrelated-words', scope: 'project', embeddingProvider: wrong });
      assert.equal(mismatched.vectorUsed, false);
      assert.equal(wrong.state.calls, 0);
    } finally {
      store.close();
    }

    assert.deepEqual(blockedFetches, []);
  } finally {
    process.exitCode = prevExitCode;
    for (const runtime of runtimes) await runtime.shutdown();
    await Promise.all([stubX.close(), stubY.close(), stubZ.close()]);
    env.cleanup();
  }
});
