import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { CortexStore } from '../src/core/store.mjs';
import { searchMemory, tokenizeQuery } from '../src/core/search.mjs';
import { readIndexMeta } from '../src/core/db.mjs';
import { buildDocChunks, createEmbeddingQueue, processPendingEmbeddings } from '../src/embeddings/index.mjs';
import { createGeminiProvider } from '../src/embeddings/gemini.mjs';
import { createOllamaProvider } from '../src/embeddings/ollama.mjs';
import { runEmbedCli } from '../src/embeddings/cli.mjs';
import { createToolRegistry } from '../src/mcp/tools.mjs';
import { REPO_ROOT, atomicWriteText } from '../src/core/config.mjs';
import { approveProject } from '../src/core/trust.mjs';

function makeTempEnv(prefix = 'herdr-cortex-rrf-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  const promptsDir = path.join(root, 'prompts');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  // The project folder of every test environment is approved, as a user would do with cortex-trust.
  approveProject(projectDir, { globalDir });
  fs.mkdirSync(path.join(promptsDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(promptsDir, 'skills', 'plan-run', 'steps'), { recursive: true });
  fs.writeFileSync(path.join(promptsDir, 'HEAD_CORE.md'), '# HEAD_CORE\n테스트 코어\n', 'utf8');
  fs.writeFileSync(path.join(promptsDir, 'agents', 'developer.md'), '# Developer Role\n', 'utf8');
  fs.writeFileSync(
    path.join(promptsDir, 'skills', 'plan-run', 'steps', '03-minimum-plan-review.md'),
    '# Step 03 Review\n',
    'utf8',
  );

  return {
    root,
    projectDir,
    globalDir,
    promptsDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Deterministic mocked EmbeddingProvider mapping semantic topic buckets into unit vectors.
 */
function createMockProvider({ model = 'mock-embed-v1', dimensions = 4, failOnEmbed = false } = {}) {
  const vectorize = (text) => {
    const s = String(text || '').toLowerCase();
    const arr = new Float32Array(dimensions);
    // Semantic topic axes:
    // Axis 0: memory / recovery / persistence / 기억 / 복구
    // Axis 1: compaction / context / 압축 / 컨텍스트
    // Axis 2: concurrency / lock / wal / 락 / 동시성
    // Axis 3: relay / inbox / tab / 탭 / 인박스
    const axis0 = /memory|recover|persist|기억|복구|세션|영속/.test(s) ? 1.0 : 0.05;
    const axis1 = /compact|context|budget|압축|컨텍스트|예산/.test(s) ? 1.0 : 0.05;
    const axis2 = /wal|lock|concurrent|sqlite|락|동시성|경합/.test(s) ? 1.0 : 0.05;
    const axis3 = /relay|inbox|herdr|tab|릴레이|인박스|탭/.test(s) ? 1.0 : 0.05;

    const base = [axis0, axis1, axis2, axis3];
    for (let i = 0; i < dimensions; i++) {
      arr[i] = base[i % base.length];
    }
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dimensions; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dimensions; i++) arr[i] /= norm;
    return arr;
  };

  let calls = 0;
  return {
    name: 'mock',
    model,
    dimensions,
    get calls() {
      return calls;
    },
    async embed(texts) {
      calls++;
      if (failOnEmbed) {
        throw new Error('Simulated offline network outage');
      }
      return texts.map(vectorize);
    },
  };
}

test('Korean 1-2 char (압축, 락) and 3+ char (기억 복구, 데이터베이스) hybrid keyword search', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    store.saveDoc({
      id: 'doc-compact',
      type: 'decision',
      title: '컨텍스트 압축 직전 포인터 주입',
      summary: '압축 시 장문 요약을 억제하고 1줄 포인터만 남긴다.',
      content: 'PreCompact 훅에서 압축이 발생하기 직전 핵심 지시사항을 주입한다.',
      tags: ['훅', '압축'],
    });
    store.saveDoc({
      id: 'doc-wal-lock',
      type: 'decision',
      title: 'SQLite WAL 락 경합 해소',
      summary: '읽기 락 대기 없이 동시 접근을 허용한다.',
      content: '데이터베이스 파일에 WAL 모드와 busy_timeout을 적용해 락 충돌을 방지한다.',
      tags: ['sqlite', '락'],
    });
    store.saveDoc({
      id: 'doc-recovery',
      type: 'knowledge',
      title: '재부팅 후 기억 복구 절차',
      summary: '세션 재시작과 /clear 후 기억 복구 파이프라인 동작 설명',
      content: '직전 5턴 원문과 마크다운 정본을 바탕으로 기억 복구를 자동 수행한다.',
      tags: ['revive', '기억'],
    });
    store.saveDoc({
      id: 'pref-global-kr',
      scope: 'global',
      type: 'knowledge',
      category: 'preferences',
      title: '전역 한국어 출력 선호',
      summary: '모든 설계 문서와 요약은 한국어로 작성한다.',
      content: '전역 선호 규칙 본문',
      tags: ['preferences'],
    });

    // 2-char Korean token "압축" (0 trigrams in FTS5 -> LIKE fallback)
    const rCompact = await searchMemory(store, { query: '압축', scope: 'project' });
    assert.ok(rCompact.results.length >= 1);
    assert.equal(rCompact.results[0].id, 'doc-compact');

    // 1-char Korean token "락" (0 trigrams in FTS5 -> LIKE fallback)
    const rLock = await searchMemory(store, { query: '락', scope: 'project' });
    assert.ok(rLock.results.length >= 1);
    assert.equal(rLock.results[0].id, 'doc-wal-lock');

    // Multi-word Korean query "기억 복구"
    const rRecovery = await searchMemory(store, { query: '기억 복구', scope: 'project' });
    assert.ok(rRecovery.results.length >= 1);
    assert.equal(rRecovery.results[0].id, 'doc-recovery');

    // 3+ char Korean token "데이터베이스" -> FTS5 trigram match
    const rDb = await searchMemory(store, { query: '데이터베이스', scope: 'project' });
    assert.ok(rDb.results.length >= 1);
    assert.equal(rDb.results[0].id, 'doc-wal-lock');

    // Cross-tier scope="all" finds global preferences
    const rAll = await searchMemory(store, { query: '선호', scope: 'all' });
    assert.ok(rAll.results.some((r) => r.id === 'pref-global-kr' && r.scope === 'global'));
  } finally {
    store.close();
    env.cleanup();
  }
});

test('Mocked EmbeddingProvider vector indexing, RRF fusion, offline fallback, and model-change rebuild', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    // Doc with English semantic terms only (no Korean keyword "인박스")
    store.saveDoc({
      id: 'doc-relay-en',
      type: 'knowledge',
      title: 'Cross-tab relay mailbox architecture',
      summary: 'Atomic file mailbox queue for Herdr tabs',
      content: 'Each Herdr tab drains its own relay inbox using claim/ack files.',
      tags: ['relay', 'herdr'],
    });
    store.saveDoc({
      id: 'doc-wal-en',
      type: 'decision',
      title: 'SQLite WAL concurrency configuration',
      summary: 'Avoid writer lock contention with WAL and busy_timeout',
      content: 'Multiple concurrent readers share the SQLite database without lock errors.',
      tags: ['sqlite', 'wal'],
    });

    const providerV1 = createMockProvider({ model: 'mock-embed-v1', dimensions: 4 });
    const embedRes = await processPendingEmbeddings(store, { scope: 'project', provider: providerV1 });
    assert.equal(embedRes.processed, 2);
    assert.equal(embedRes.dimensions, 4);
    assert.equal(embedRes.errors, 0);

    const projectTier = store.getTier('project');
    const readyCount = projectTier.db.prepare("SELECT COUNT(*) AS cnt FROM docs WHERE embed_status = 'ready' AND embed_model = 'mock-embed-v1'").get().cnt;
    assert.equal(readyCount, 2);
    assert.equal(readIndexMeta(projectTier.dir).dimensions, 4);

    // Pure semantic cross-lingual query: "탭 인박스" has zero keyword overlap with doc-relay-en,
    // so vector search + RRF must surface doc-relay-en!
    const vecSearch = await searchMemory(store, {
      query: '탭 인박스',
      scope: 'project',
      embeddingProvider: providerV1,
    });
    assert.equal(vecSearch.vectorUsed, true);
    assert.ok(vecSearch.results.length >= 1);
    assert.equal(vecSearch.results[0].id, 'doc-relay-en');

    // Offline / failing provider degrades gracefully to keyword search without throwing
    const offlineProvider = createMockProvider({ model: 'mock-embed-v1', dimensions: 4, failOnEmbed: true });
    const offlineSearch = await searchMemory(store, {
      query: 'SQLite WAL',
      scope: 'project',
      embeddingProvider: offlineProvider,
    });
    assert.equal(offlineSearch.vectorUsed, false);
    assert.equal(offlineSearch.results[0].id, 'doc-wal-en');

    // Switch model + dimensions (4 -> 8): triggers automatic doc_chunks_vec drop/recreate + full re-embed
    const providerV2 = createMockProvider({ model: 'mock-embed-v2', dimensions: 8 });
    const rebuildRes = await processPendingEmbeddings(store, { scope: 'project', provider: providerV2 });
    assert.ok(rebuildRes.rebuiltTiers.includes('project'));
    assert.equal(rebuildRes.processed, 2);
    assert.equal(rebuildRes.dimensions, 8);
    assert.equal(readIndexMeta(projectTier.dir).embedModel, 'mock-embed-v2');
    assert.equal(readIndexMeta(projectTier.dir).dimensions, 8);

    // Search with new 8-dim model works cleanly
    const vecSearchV2 = await searchMemory(store, {
      query: '동시성 락',
      scope: 'project',
      embeddingProvider: providerV2,
    });
    assert.equal(vecSearchV2.vectorUsed, true);
    assert.equal(vecSearchV2.results[0].id, 'doc-wal-en');
  } finally {
    store.close();
    env.cleanup();
  }
});

test('MCP Canon Protection (SUBAGENT_WRITE_DENIED) + cortex_prompt + extraTools extension hook', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    const registry = createToolRegistry(store, {
      promptsDir: env.promptsDir,
      extraTools: [
        {
          name: 'relay_tabs',
          description: 'Stage 2 plug-in test tool',
          inputSchema: { type: 'object', properties: {} },
          async handler() {
            return { tabs: ['tab-1'] };
          },
        },
      ],
    });

    const toolNames = registry.listTools().map((t) => t.name);
    for (const expected of [
      'memory_search',
      'memory_read',
      'memory_save',
      'memory_update',
      'memory_graph',
      'memory_overview',
      'cortex_prompt',
      'relay_tabs',
    ]) {
      assert.ok(toolNames.includes(expected), `Missing tool ${expected}`);
    }

    // Main HEAD caller succeeds
    const saveOk = await registry.callTool(
      'memory_save',
      {
        id: 'head-dec-1',
        type: 'decision',
        title: 'HEAD 정본 저장',
        summary: '메인 대화에서 정본 저장 허용',
        content: '본문',
      },
      {
        'antigravity.google/conversation_id': 'conv-root',
        'antigravity.google/root_conversation_id': 'conv-root',
      },
    );
    assert.equal(saveOk.isError, false);
    assert.equal(saveOk.data.id, 'head-dec-1');

    // Subagent caller #1: _meta.agent_id
    const deny1 = await registry.callTool(
      'memory_save',
      { type: 'decision', title: 'X', summary: 'Y' },
      { agent_id: 'subagent-worker-1' },
    );
    assert.equal(deny1.isError, true);
    assert.equal(deny1.data.error, 'SUBAGENT_WRITE_DENIED');

    // Subagent caller #2: args._caller_agent_id
    const deny2 = await registry.callTool('memory_update', {
      id: 'head-dec-1',
      status: 'done',
      _caller_agent_id: 'worker-dev',
    });
    assert.equal(deny2.isError, true);
    assert.equal(deny2.data.error, 'SUBAGENT_WRITE_DENIED');

    // Subagent caller #3: Antigravity conversation_id !== root_conversation_id
    const deny3 = await registry.callTool(
      'memory_update',
      { id: 'head-dec-1', summary: 'subagent edit attempt' },
      {
        'antigravity.google/conversation_id': 'conv-child-42',
        'antigravity.google/root_conversation_id': 'conv-root',
      },
    );
    assert.equal(deny3.isError, true);
    assert.equal(deny3.data.error, 'SUBAGENT_WRITE_DENIED');

    // Subagent caller #4: un-namespaced conversation_id !== root_conversation_id & camelCase agentId
    const deny4 = await registry.callTool(
      'memory_save',
      { type: 'decision', title: 'un-namespaced', summary: 'blocked' },
      { conversation_id: 'sub', root_conversation_id: 'root' },
    );
    assert.equal(deny4.isError, true);
    assert.equal(deny4.data.error, 'SUBAGENT_WRITE_DENIED');

    const deny5 = await registry.callTool(
      'memory_update',
      { id: 'head-dec-1', summary: 'camelCase subagent' },
      { agentId: 'worker-camel' },
    );
    assert.equal(deny5.isError, true);
    assert.equal(deny5.data.error, 'SUBAGENT_WRITE_DENIED');

    // Subagent READ is still allowed
    const readAllowed = await registry.callTool(
      'memory_read',
      { id: 'head-dec-1' },
      { agent_id: 'subagent-worker-1' },
    );
    assert.equal(readAllowed.isError, false);
    assert.equal(readAllowed.data.title, 'HEAD 정본 저장');

    // cortex_prompt loads safely and blocks traversal
    const stepPrompt = await registry.callTool('cortex_prompt', {
      kind: 'skill',
      name: 'plan-run/steps/03-minimum-plan-review',
    });
    assert.equal(stepPrompt.isError, false);
    assert.match(stepPrompt.data.content, /Step 03 Review/);

    const traversal = await registry.callTool('cortex_prompt', {
      kind: 'agent',
      name: '../../package.json',
    });
    assert.equal(traversal.isError, true);

    // Plugged-in Stage 2 tool works
    const relayRes = await registry.callTool('relay_tabs', {});
    assert.equal(relayRes.isError, false);
    assert.deepEqual(relayRes.data.tabs, ['tab-1']);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('Stdio JSON-RPC 2.0 MCP server full child-process round-trip', async () => {
  const env = makeTempEnv();
  const serverScript = path.join(REPO_ROOT, 'src', 'mcp', 'server.mjs');

  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      serverScript,
      '--project',
      env.projectDir,
      '--global',
      env.globalDir,
      '--prompts',
      env.promptsDir,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HERDR_CORTEX_HOME: env.globalDir },
    },
  );

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
  });

  const responses = [];
  let stdoutBuf = '';
  const waiters = [];

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiters.length > 0) {
        waiters.shift()(msg);
      } else {
        responses.push(msg);
      }
    }
  });

  const nextResponse = () =>
    new Promise((resolve, reject) => {
      if (responses.length > 0) {
        resolve(responses.shift());
        return;
      }
      const timer = setTimeout(() => reject(new Error(`MCP response timeout. stderr=${stderrBuf}`)), 5000);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

  const send = (payload) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  try {
    // 1. initialize
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });
    const initResp = await nextResponse();
    assert.equal(initResp.id, 1);
    assert.equal(initResp.result.serverInfo.name, 'herdr-cortex');
    assert.equal(initResp.result.serverInfo.version, '1.0.0');

    // 2. notifications/initialized (no response expected) + ping
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const pingResp = await nextResponse();
    assert.equal(pingResp.id, 2);
    assert.deepEqual(pingResp.result, {});

    // 3. tools/list
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const listResp = await nextResponse();
    assert.equal(listResp.id, 3);
    assert.ok(listResp.result.tools.some((t) => t.name === 'memory_save'));
    assert.ok(listResp.result.tools.some((t) => t.name === 'memory_search'));

    // 4. tools/call memory_save (HEAD)
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'memory_save',
        arguments: {
          id: 'rpc-doc-1',
          type: 'decision',
          title: 'MCP Stdio 왕복 검증',
          summary: 'JSON-RPC 2.0 저장 및 검색 왕복 성공',
          content: '실제 자식 프로세스 stdio 테스트 본문',
          tags: ['mcp', 'stdio'],
        },
      },
    });
    const saveResp = await nextResponse();
    assert.equal(saveResp.id, 4);
    assert.ok(!saveResp.result.isError);
    const savedData = JSON.parse(saveResp.result.content[0].text);
    assert.equal(savedData.id, 'rpc-doc-1');

    // 5. tools/call memory_save denied for subagent via _meta
    send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'memory_save',
        arguments: { type: 'decision', title: 'blocked', summary: 'blocked' },
        _meta: { agent_id: 'sub-99' },
      },
    });
    const denyResp = await nextResponse();
    assert.equal(denyResp.id, 5);
    assert.equal(denyResp.result.isError, true);
    assert.equal(JSON.parse(denyResp.result.content[0].text).error, 'SUBAGENT_WRITE_DENIED');

    // 6. tools/call memory_search
    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'memory_search',
        arguments: { query: '왕복', scope: 'project' },
      },
    });
    const searchResp = await nextResponse();
    assert.equal(searchResp.id, 6);
    const searchData = JSON.parse(searchResp.result.content[0].text);
    assert.equal(searchData.results[0].id, 'rpc-doc-1');
    assert.equal('content' in searchData.results[0], false);

    // 7. tools/call memory_overview
    send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'memory_overview',
        arguments: { format: 'both', budget: 4000 },
      },
    });
    const ovResp = await nextResponse();
    assert.equal(ovResp.id, 7);
    const ovData = JSON.parse(ovResp.result.content[0].text);
    assert.match(ovData.formatted, /MCP Stdio 왕복 검증/);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve();
      }, 1500);
    });
    env.cleanup();
  }
});

test('regression: update & delete doc after doc_chunks_vec populated, plus disableVec: true reopen safety', async () => {
  const env = makeTempEnv();
  let store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    store.saveDoc({
      id: 'vec-doc-1',
      type: 'knowledge',
      title: '벡터 파티션 삭제 테스트 1',
      summary: '초기 벡터 문서 1',
      content: '릴레이 인박스 아키텍처 본문',
    });
    store.saveDoc({
      id: 'vec-doc-2',
      type: 'knowledge',
      title: '벡터 파티션 삭제 테스트 2',
      summary: '초기 벡터 문서 2',
      content: '동시성 락 설정 본문',
    });

    const provider = createMockProvider({ model: 'mock-embed-v1', dimensions: 4 });
    const indexed = await processPendingEmbeddings(store, { scope: 'project', provider });
    assert.equal(indexed.processed, 2);

    const tier = store.getTier('project');
    const initialVecRows = tier.db.prepare('SELECT COUNT(*) AS cnt FROM doc_chunks_vec').get().cnt;
    assert.ok(initialVecRows >= 2);

    // 1. Update doc that already has rows in doc_chunks_vec -> clears its vec partition & marks pending
    store.updateDoc({
      id: 'vec-doc-1',
      scope: 'project',
      append_content: '수정된 본문 내용 추가',
    });
    const afterUpdateVec1 = tier.db.prepare("SELECT COUNT(*) AS cnt FROM doc_chunks_vec WHERE doc_id = 'vec-doc-1'").get().cnt;
    const afterUpdateVec2 = tier.db.prepare("SELECT COUNT(*) AS cnt FROM doc_chunks_vec WHERE doc_id = 'vec-doc-2'").get().cnt;
    assert.equal(afterUpdateVec1, 0);
    assert.ok(afterUpdateVec2 >= 1);

    // 2. Delete Markdown file on disk for vec-doc-2 -> sync removes its vec partition cleanly
    const doc2Row = tier.db.prepare("SELECT path FROM docs WHERE id = 'vec-doc-2'").get();
    fs.unlinkSync(path.join(tier.dir, doc2Row.path));
    const syncRes = store.sync('project');
    assert.equal(syncRes.project.deleted, 1);
    const afterDeleteVec2 = tier.db.prepare("SELECT COUNT(*) AS cnt FROM doc_chunks_vec WHERE doc_id = 'vec-doc-2'").get().cnt;
    assert.equal(afterDeleteVec2, 0);

    // Re-embed vec-doc-1 so doc_chunks_vec is non-empty on disk before reopening with disableVec: true
    await processPendingEmbeddings(store, { scope: 'project', provider });
    store.close();

    // 3. Reopen existing DB (which contains doc_chunks_vec) with disableVec: true
    store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
    assert.equal(store.getTier('project').vecAvailable, false);

    // saveDoc, updateDoc, and searchMemory must all succeed without "no such module: vec0"
    store.saveDoc({
      id: 'novec-doc-3',
      type: 'decision',
      title: '오프라인 무벡터 저장',
      summary: 'sqlite-vec 비활성화 상태에서도 저장 성공',
      content: '압축 복구 무장애 동작 확인',
    });
    store.updateDoc({
      id: 'vec-doc-1',
      scope: 'project',
      summary: 'disableVec 상태에서 업데이트 성공',
    });
    const searchRes = await searchMemory(store, { query: '압축', scope: 'project', embeddingProvider: provider });
    assert.equal(searchRes.vectorUsed, false);
    assert.ok(searchRes.results.some((r) => r.id === 'novec-doc-3'));
  } finally {
    store.close();
    env.cleanup();
  }
});

test('P0-10 metadata-only update preserves doc_chunks_vec & embed_status=ready while updating vec0 status/type', async () => {
  const env = makeTempEnv('cortex-p010-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    store.saveDoc({
      id: 'meta-preserve-1',
      type: 'todo',
      title: '메타데이터 보존 테스트',
      summary: '본문 변경 없이 status와 tags만 바뀐다',
      content: '릴레이 인박스 큐 검증 본문',
      tags: ['v1'],
    });

    const provider = createMockProvider({ model: 'mock-embed-v1', dimensions: 4 });
    const first = await processPendingEmbeddings(store, { scope: 'project', provider });
    assert.equal(first.processed, 1);
    assert.equal(provider.calls, 1);

    // Update ONLY metadata (status, tags, due, type) — content_hash unchanged!
    const upd = store.updateDoc({
      id: 'meta-preserve-1',
      scope: 'project',
      status: 'done',
      type: 'worklog',
      tags: ['v1', 'completed'],
      due: '2026-12-31',
    });
    assert.equal(upd.embed_status, 'ready');

    const tier = store.getTier('project');
    const vecRows = tier.db
      .prepare("SELECT doc_id, status, type FROM doc_chunks_vec WHERE doc_id = 'meta-preserve-1'")
      .all();
    assert.ok(vecRows.length >= 1, 'Existing vector rows must be preserved');
    assert.equal(vecRows[0].status, 'done');
    assert.equal(vecRows[0].type, 'worklog');

    // Re-running processPendingEmbeddings must NOT call provider again
    const second = await processPendingEmbeddings(store, { scope: 'project', provider });
    assert.equal(second.processed, 0);
    assert.equal(provider.calls, 1);

    // Now archive it -> vec0 status becomes 'archived', so default vector search excludes it
    store.updateDoc({ id: 'meta-preserve-1', scope: 'project', status: 'archived' });
    const archVec = tier.db
      .prepare("SELECT status FROM doc_chunks_vec WHERE doc_id = 'meta-preserve-1'")
      .get();
    assert.equal(archVec.status, 'archived');

    const searchExcluded = await searchMemory(store, {
      query: '탭 인박스',
      scope: 'project',
      embeddingProvider: provider,
    });
    assert.ok(!searchExcluded.results.some((r) => r.id === 'meta-preserve-1'));
  } finally {
    store.close();
    env.cleanup();
  }
});

test('P0-8 + P0-9 embeddings reliability: 3-attempt cap, 401 circuit breaker, stale guard, queue drain, Gemini header/batch/retry, Ollama nomic prefix, buildDocChunks', async () => {
  const env = makeTempEnv('cortex-p089-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    store.saveDoc({
      id: 'err-cap-doc',
      type: 'knowledge',
      title: '재시도 상한 테스트',
      summary: '3회 실패 후 더 이상 호출하지 않아야 함',
      content: '내용',
    });
    store.saveDoc({
      id: 'superseded-skip',
      type: 'knowledge',
      status: 'superseded',
      title: '대체된 문서',
      summary: '임베딩 대상에서 제외되어야 함',
      content: '내용',
    });

    // 1. Failing provider stops after 3 attempts
    const failing = createMockProvider({ model: 'mock-fail', dimensions: 4, failOnEmbed: true });
    for (let i = 1; i <= 3; i++) {
      const r = await processPendingEmbeddings(store, { scope: 'project', provider: failing });
      assert.equal(r.errors, 1);
      assert.equal(failing.calls, i);
    }
    // 4th run MUST NOT call provider at all (embed_attempts >= 3)
    const run4 = await processPendingEmbeddings(store, { scope: 'project', provider: failing });
    assert.equal(run4.processed, 0);
    assert.equal(run4.errors, 0);
    assert.equal(failing.calls, 3);

    const ov = store.getOverview({ includeGlobal: false });
    assert.equal(ov.embeddingStats.error, 1);
    assert.match(ov.embeddingStats.lastError, /Simulated offline network outage/);

    // 2. HTTP 401 circuit breaker stops immediately after 1st doc
    store.saveDoc({ id: 'cb-doc-1', type: 'knowledge', title: 'CB1', summary: 'S1', content: 'C1' });
    store.saveDoc({ id: 'cb-doc-2', type: 'knowledge', title: 'CB2', summary: 'S2', content: 'C2' });
    let cbCalls = 0;
    const authFailProvider = {
      name: 'gemini',
      model: 'gemini-embedding-001',
      dimensions: 4,
      async embed() {
        cbCalls++;
        const err = new Error('Gemini embedding failed (401): API key not valid');
        err.status = 401;
        throw err;
      },
    };
    const cbRes = await processPendingEmbeddings(store, { scope: 'project', provider: authFailProvider });
    assert.equal(cbRes.circuitBroken, true);
    assert.equal(cbCalls, 1, '401 must circuit-break before calling provider for 2nd doc');

    // 3. Stale guard: doc modified mid-embed is NOT overwritten with stale vectors
    store.saveDoc({ id: 'stale-doc', type: 'knowledge', title: 'Initial', summary: 'V1', content: 'Original body' });
    const staleProvider = {
      name: 'mock',
      model: 'mock-stale-v1',
      dimensions: 4,
      async embed(texts) {
        // Modify the doc while embed() is in flight!
        store.updateDoc({ id: 'stale-doc', scope: 'project', content: 'Modified mid-flight body' });
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    };
    await processPendingEmbeddings(store, { scope: 'project', provider: staleProvider });
    const tier = store.getTier('project');
    const staleRow = tier.db.prepare("SELECT embed_status FROM docs WHERE id = 'stale-doc'").get();
    const staleVecCnt = tier.db.prepare("SELECT COUNT(*) AS cnt FROM doc_chunks_vec WHERE doc_id = 'stale-doc'").get().cnt;
    assert.equal(staleRow.embed_status, 'pending');
    assert.equal(staleVecCnt, 0);

    // 4. Gemini provider: x-goog-api-key header (NO ?key= query), sub-batch <= 100, retry on 429
    const geminiCalls = [];
    let failFirst429 = true;
    const gemini = createGeminiProvider({
      apiKey: 'secret-test-key',
      dimensions: 4,
      retryBaseMs: 5,
      fetchImpl: async (url, init) => {
        geminiCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        if (failFirst429) {
          failFirst429 = false;
          return { ok: false, status: 429, text: async () => 'Rate limited' };
        }
        const reqs = JSON.parse(init.body).requests;
        return {
          ok: true,
          status: 200,
          json: async () => ({ embeddings: reqs.map(() => ({ values: [1, 0, 0, 0] })) }),
        };
      },
    });
    const texts105 = Array.from({ length: 105 }, (_, i) => `chunk-${i}`);
    const gVecs = await gemini.embed(texts105, { taskType: 'document' });
    assert.equal(gVecs.length, 105);
    assert.equal(geminiCalls.length, 3); // 1st batch (429) + retry (100) + 2nd batch (5)
    for (const c of geminiCalls) {
      assert.equal(c.url.includes('key='), false, 'API key must NEVER appear in URL query');
      assert.equal(c.headers['x-goog-api-key'], 'secret-test-key');
      assert.ok(c.body.requests.length <= 100);
    }

    // 5. Ollama nomic-embed prefixing
    const ollamaInputs = [];
    const ollama = createOllamaProvider({
      model: 'nomic-embed-text',
      retryBaseMs: 5,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        ollamaInputs.push(body.input);
        return { ok: true, status: 200, json: async () => ({ embeddings: body.input.map(() => [0.5, 0.5, 0, 0]) }) };
      },
    });
    await ollama.embed(['hello'], { taskType: 'document' });
    await ollama.embed(['world'], { taskType: 'query' });
    assert.deepEqual(ollamaInputs[0], ['search_document: hello']);
    assert.deepEqual(ollamaInputs[1], ['search_query: world']);

    // 6. buildDocChunks: chunk 0 stays <= maxChars and chunks 1..N preserve [title > heading] prefix
    const chunks = buildDocChunks(
      {
        title: '아키텍처 가이드',
        summary: '요약 문장입니다.',
        content: `# 섹션1\n${'가나다라마바사 '.repeat(40)}\n\n## 섹션2\n${'아자차카타파하 '.repeat(40)}`,
      },
      { maxChars: 160, overlap: 0 },
    );
    assert.ok(chunks.length >= 4);
    for (const ch of chunks) {
      assert.ok(ch.text.length <= 160, `Chunk ${ch.chunkIndex} exceeded maxChars: ${ch.text.length}`);
      assert.match(ch.text, /^\[아키텍처 가이드/);
    }
    assert.ok(chunks.some((c) => c.text.startsWith('[아키텍처 가이드 > 섹션2]\n')));

    // 7. createEmbeddingQueue.drain() awaits in-flight flush cleanly
    let flushFinished = false;
    const slowProvider = {
      name: 'slow',
      model: 'slow-v1',
      dimensions: 4,
      async embed(texts) {
        await new Promise((r) => setTimeout(r, 40));
        flushFinished = true;
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    };
    const queue = createEmbeddingQueue(store, { provider: slowProvider, debounceMs: 5 });
    queue.schedule('project');
    await new Promise((r) => setTimeout(r, 15)); // let flush start
    await queue.drain(2000);
    assert.equal(flushFinished, true, 'drain() must wait for in-flight flush to finish');
  } finally {
    store.close();
    env.cleanup();
  }
});

test('P1-1 + P1-2 search: lazy embed (0 calls when no vectors), SQL pushdown (no LIMIT starvation), Korean punctuation/particles, distance cutoff, and cross-tier RRF', async () => {
  const env = makeTempEnv('cortex-p112-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    // 1. Seed 120 superseded docs + 1 active doc with same keyword -> SQL pushdown MUST find the active doc!
    for (let i = 0; i < 120; i++) {
      store.saveDoc({
        id: `sup-starve-${String(i).padStart(3, '0')}`,
        type: 'decision',
        status: 'superseded',
        title: `스타베이션 테스트 구버전 ${i}`,
        summary: '스타베이션 구버전 요약',
        content: '스타베이션 본문',
      });
    }
    store.saveDoc({
      id: 'active-starve-winner',
      type: 'decision',
      status: 'active',
      title: '스타베이션 활성 문서',
      summary: '유일한 활성 문서가 SQL 푸시다운으로 반드시 검색되어야 한다',
      content: '스타베이션 핵심 해결 문제 및 기억 데이터베이스 설명',
    });

    // Lazy query embedding: 0 indexed vectors -> provider.embed MUST NOT be called!
    const spyProvider = createMockProvider({ model: 'mock-embed-v1', dimensions: 4 });
    const starveRes = await searchMemory(store, {
      query: '스타베이션',
      scope: 'project',
      embeddingProvider: spyProvider,
    });
    assert.equal(spyProvider.calls, 0, 'Must NOT call embeddingProvider.embed when no tier has vectors');
    assert.equal(starveRes.results.length, 1);
    assert.equal(starveRes.results[0].id, 'active-starve-winner');

    // 2. Korean punctuation & particle stripping: "문제?", "기억을", "데이터베이스에서"
    const toks = tokenizeQuery('문제? 기억을 데이터베이스에서');
    assert.ok(toks.includes('문제'));
    assert.ok(toks.includes('기억을'));
    assert.ok(toks.includes('기억'));
    assert.ok(toks.includes('데이터베이스'));

    const rPunct = await searchMemory(store, { query: '문제?', scope: 'project' });
    assert.ok(rPunct.results.some((r) => r.id === 'active-starve-winner'));

    const rParticle = await searchMemory(store, { query: '기억을', scope: 'project' });
    assert.ok(rParticle.results.some((r) => r.id === 'active-starve-winner'));

    const rLongParticle = await searchMemory(store, { query: '데이터베이스에서', scope: 'project' });
    assert.ok(rLongParticle.results.some((r) => r.id === 'active-starve-winner'));

    // 3. Cross-tier RRF & cosine distance cutoff:
    // Project doc has strong cosine match (dist ~0.01); Global doc has weak cosine match (dist ~0.40);
    // Unrelated doc has distance ~0.95 (> 0.65 cutoff -> excluded!)
    store.saveDoc({
      id: 'proj-strong-vec',
      scope: 'project',
      type: 'knowledge',
      title: 'Alpha Strong Project Doc',
      summary: 'Project exact semantic hit',
      content: 'strong-target-marker',
    });
    store.saveDoc({
      id: 'proj-unrelated-vec',
      scope: 'project',
      type: 'knowledge',
      title: 'Zeta Unrelated Doc',
      summary: 'Completely orthogonal topic',
      content: 'orthogonal-marker',
    });
    store.saveDoc({
      id: 'global-weak-vec',
      scope: 'global',
      type: 'knowledge',
      title: 'Beta Weak Global Doc',
      summary: 'Global weaker semantic hit',
      content: 'weak-global-marker',
    });

    const normalize = (arr) => {
      const n = Math.sqrt(arr.reduce((acc, v) => acc + v * v, 0)) || 1;
      return new Float32Array(arr.map((v) => v / n));
    };
    const crossTierProvider = {
      name: 'mock-cross',
      model: 'shared-model-v1',
      dimensions: 4,
      async embed(texts, { taskType } = {}) {
        return texts.map((t) => {
          if (taskType === 'query') return normalize([1, 0, 0, 0]);
          if (t.includes('strong-target-marker')) return normalize([0.99, 0.14, 0, 0]); // cosine dist ~0.01
          if (t.includes('weak-global-marker')) return normalize([0.65, 0.76, 0, 0]); // cosine dist ~0.35 <= 0.65
          return normalize([0.05, 0, 0, 0.998]); // cosine dist ~0.95 > 0.65
        });
      },
    };

    await processPendingEmbeddings(store, { scope: 'all', provider: crossTierProvider, maxDocs: 200 });

    const crossRes = await searchMemory(store, {
      query: 'unmatched-keyword-xyz-query',
      scope: 'all',
      embeddingProvider: crossTierProvider,
    });
    assert.equal(crossRes.vectorUsed, true);
    assert.equal(crossRes.results[0].id, 'proj-strong-vec', 'Strong project vector hit must outrank weak global hit');
    assert.ok(crossRes.results.some((r) => r.id === 'global-weak-vec'));
    assert.ok(!crossRes.results.some((r) => r.id === 'proj-unrelated-vec'), 'Distance > 0.65 must be filtered out');
  } finally {
    store.close();
    env.cleanup();
  }
});

test('P0-3 + P0-8 embeddings CLI: skips excluded projects, loops batches until 0 remaining, sets exitCode=1 on errors', async () => {
  const env = makeTempEnv('cortex-cli-');
  const prevExitCode = process.exitCode;
  try {
    // 1. Excluded project is skipped cleanly without creating .memory/
    const exProj = path.join(env.root, 'excluded-cli-proj');
    fs.mkdirSync(exProj, { recursive: true });
    atomicWriteText(path.join(env.globalDir, 'config.json'), JSON.stringify({ mode: 'all', excludedProjects: ['excluded-cli-proj'] }));

    const skippedRes = await runEmbedCli(['--project', exProj, '--global', env.globalDir, '--scope', 'project']);
    assert.equal(skippedRes.skipped, true);
    assert.equal(fs.existsSync(path.join(exProj, '.memory')), false);

    // 2. Multi-batch loop with --max-docs 2 processes all 5 docs
    const okProj = path.join(env.root, 'ok-cli-proj');
    fs.mkdirSync(okProj, { recursive: true });
    approveProject(okProj, { globalDir: env.globalDir });
    const store = new CortexStore({ projectDir: okProj, globalDir: env.globalDir });
    for (let i = 0; i < 5; i++) {
      store.saveDoc({ id: `cli-doc-${i}`, type: 'knowledge', title: `CLI ${i}`, summary: `S ${i}`, content: `C ${i}` });
    }
    store.close();

    const okProvider = createMockProvider({ model: 'mock-cli-v1', dimensions: 4 });
    process.exitCode = 0;
    const multiRes = await runEmbedCli(
      ['--project', okProj, '--global', env.globalDir, '--scope', 'project', '--max-docs', '2'],
      { provider: okProvider },
    );
    assert.equal(multiRes.processed, 5);
    assert.equal(multiRes.errors, 0);
    assert.equal(process.exitCode, 0);

    // 3. Error sets process.exitCode = 1
    const errStore = new CortexStore({ projectDir: okProj, globalDir: env.globalDir });
    errStore.saveDoc({ id: 'cli-err-doc', type: 'knowledge', title: 'Err', summary: 'S', content: 'C' });
    errStore.close();

    const errProvider = createMockProvider({ model: 'mock-cli-v1', dimensions: 4, failOnEmbed: true });
    const errRes = await runEmbedCli(
      ['--project', okProj, '--global', env.globalDir, '--scope', 'project'],
      { provider: errProvider },
    );
    assert.equal(errRes.errors, 1);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prevExitCode;
    env.cleanup();
  }
});
