import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { CortexStore } from '../src/core/store.mjs';
import { searchMemory } from '../src/core/search.mjs';
import { readIndexMeta } from '../src/core/db.mjs';
import { processPendingEmbeddings } from '../src/embeddings/index.mjs';
import { createToolRegistry } from '../src/mcp/tools.mjs';
import { REPO_ROOT } from '../src/core/config.mjs';

function makeTempEnv(prefix = 'herdr-cortex-rrf-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  const promptsDir = path.join(root, 'prompts');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
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
    assert.equal(initResp.result.serverInfo.name, 'cortex');
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
