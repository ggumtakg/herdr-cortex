import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPO_ROOT, atomicWriteText } from '../src/core/config.mjs';
import {
  getDeferredIndexPath,
  isSharedSyncRunning,
  openTierDb,
  readDeferredIndex,
  syncFromDiskShared,
} from '../src/core/db.mjs';
import { serializeMarkdownDoc } from '../src/core/frontmatter.mjs';
import {
  CortexStore,
  DEFAULT_TOOL_SYNC_LIMITS,
  TOOL_SYNC_BUDGET_MS,
  TOOL_SYNC_BYTES_PER_MS,
  TOOL_SYNC_MAX_FILE_BYTES,
  TOOL_SYNC_PER_FILE_MS,
} from '../src/core/store.mjs';
import {
  INDEX_CATCH_UP_DELAY_MS,
  INDEX_CATCH_UP_REQUEST_DELAY_MS,
  createServerRuntime,
  startIndexCatchUp,
} from '../src/mcp/server.mjs';
import { INDEXING_NOTE_MAX_DOCUMENTS, describeIndexing } from '../src/mcp/tools.mjs';
import { approveAsUser } from './support/approve.mjs';

const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');

function makeTempEnv(prefix = 'herdr-cortex-bgindex-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  for (const dir of [projectDir, globalDir]) fs.mkdirSync(dir, { recursive: true });
  approveAsUser(projectDir, { globalDir });
  return {
    root,
    projectDir,
    globalDir,
    memoryDir: path.join(projectDir, '.memory'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

// A hand-placed memory document: <tierDir>/docs/2026-11/<id>.md
function writeDoc(tierDir, id, { title = `Title of ${id}`, body = 'body' } = {}) {
  const filePath = path.join(tierDir, 'docs', '2026-11', `${id}.md`);
  atomicWriteText(filePath, serializeMarkdownDoc({ id, type: 'decision', title, summary: `Summary of ${id}`, status: 'active' }, body));
  return filePath;
}

async function callTool(runtime, name, args = {}) {
  const resp = await runtime.server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { isError: Boolean(resp.result.isError), data: JSON.parse(resp.result.content[0].text) };
}

function indexedIds(runtime, scope = 'project') {
  const tier = runtime.store.getTierIfExists(scope);
  return tier ? tier.db.prepare('SELECT id FROM docs ORDER BY id').all().map((row) => row.id) : [];
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------------
// A tool call never waits for a large or slow document
// ---------------------------------------------------------------------------------------------

test('tool calls: a large changed document is left to the background; the call answers at once with an indexing note, and the document is searchable after the catch-up', async () => {
  const env = makeTempEnv();
  let runtime = null;
  try {
    writeDoc(env.memoryDir, 'dec-small', { title: 'SMALLMARKER decision' });
    const largePath = writeDoc(env.memoryDir, 'dec-large', { title: 'LARGEMARKER decision', body: 'large body line\n'.repeat(400) });
    const largeSize = fs.statSync(largePath).size;
    assert.ok(largeSize > 6000);

    // Injected threshold: anything over 2,000 bytes counts as "large". The catch-up's own first pass is far
    // away; a pass starts 200 ms after a tool call reported a waiting document, which is after the tool
    // calls below were made and answered.
    runtime = createServerRuntime({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      promptsDir: PROMPTS_DIR,
      toolSyncLimits: { maxFileBytes: 2000 },
      indexCatchUpDelayMs: 60_000,
      indexCatchUpRequestDelayMs: 200,
    });
    const expectedNote = { pending: 1, documents: ['docs/2026-11/dec-large.md'] };

    const small = await callTool(runtime, 'memory_search', { query: 'SMALLMARKER' });
    assert.equal(small.isError, false);
    assert.deepEqual(small.data.results.map((r) => r.id), ['dec-small'], 'the small document was indexed inside the call');
    assert.deepEqual(small.data.indexing, expectedNote);

    const large = await callTool(runtime, 'memory_search', { query: 'LARGEMARKER' });
    assert.deepEqual(large.data.results, [], 'answered from what is indexed now');
    assert.deepEqual(large.data.indexing, expectedNote);
    assert.deepEqual(indexedIds(runtime), ['dec-small'], 'the call did not index the large document');

    // Every reading tool says so, and "not found" says so as well
    const overview = await callTool(runtime, 'memory_overview', { format: 'json' });
    assert.deepEqual(overview.data.indexing, expectedNote);
    const read = await callTool(runtime, 'memory_read', { id: 'dec-large' });
    assert.deepEqual([read.isError, read.data.error], [true, 'NOT_FOUND']);
    assert.deepEqual(read.data.indexing, expectedNote);
    const update = await callTool(runtime, 'memory_update', { id: 'dec-large', status: 'done' });
    assert.deepEqual([update.isError, update.data.error], [true, 'TOOL_EXECUTION_ERROR']);
    assert.deepEqual(update.data.indexing, expectedNote);
    // The document a tool writes itself is indexed by that call, as before
    const saved = await callTool(runtime, 'memory_save', { id: 'dec-saved', type: 'decision', title: 'SAVEDMARKER decision', summary: 'S' });
    assert.equal(saved.isError, false);
    assert.deepEqual((await callTool(runtime, 'memory_search', { query: 'SAVEDMARKER' })).data.results.map((r) => r.id), ['dec-saved']);
    // What is waiting is on record for the hooks and cortex-status too
    assert.deepEqual(readDeferredIndex(env.memoryDir).files, [{ path: 'docs/2026-11/dec-large.md', size: largeSize, reason: 'too_large' }]);

    // The background catch-up indexes it; the note is gone
    await runtime.indexCatchUp.whenIdle();
    assert.deepEqual(indexedIds(runtime), ['dec-large', 'dec-saved', 'dec-small']);
    const after = await callTool(runtime, 'memory_search', { query: 'LARGEMARKER' });
    assert.deepEqual(after.data.results.map((r) => r.id), ['dec-large']);
    assert.equal('indexing' in after.data, false);
    assert.equal(fs.existsSync(getDeferredIndexPath(env.memoryDir)), false);

    // A large document that appears later: the tool call that notices it asks for another pass
    writeDoc(env.memoryDir, 'dec-later', { title: 'LATERMARKER decision', body: 'later body line\n'.repeat(400) });
    const later = await callTool(runtime, 'memory_search', { query: 'LATERMARKER' });
    assert.deepEqual(later.data.results, []);
    assert.deepEqual(later.data.indexing, { pending: 1, documents: ['docs/2026-11/dec-later.md'] });
    await runtime.indexCatchUp.whenIdle();
    const laterFound = await callTool(runtime, 'memory_search', { query: 'LATERMARKER' });
    assert.deepEqual(laterFound.data.results.map((r) => r.id), ['dec-later']);
    assert.equal('indexing' in laterFound.data, false);
  } finally {
    if (runtime) await runtime.shutdown();
    env.cleanup();
  }
});

test('tool calls: the time budget is estimated from file sizes; default limits index a handful of ordinary edits inside the call', async () => {
  // The limits and why (see store.mjs)
  assert.deepEqual({ ...DEFAULT_TOOL_SYNC_LIMITS }, { budgetMs: 200, maxFileBytes: 256 * 1024, bytesPerMs: 4096, perFileMs: 5 });
  assert.deepEqual(
    [TOOL_SYNC_BUDGET_MS, TOOL_SYNC_MAX_FILE_BYTES, TOOL_SYNC_BYTES_PER_MS, TOOL_SYNC_PER_FILE_MS],
    [200, 262144, 4096, 5],
  );
  assert.deepEqual([INDEX_CATCH_UP_DELAY_MS, INDEX_CATCH_UP_REQUEST_DELAY_MS], [250, 50]);

  const env = makeTempEnv('herdr-cortex-bgindex-budget-');
  let runtime = null;
  try {
    // 1. Default limits: five ordinary edited documents (and one of 100 KB) are visible to the next call
    for (let i = 1; i <= 5; i++) writeDoc(env.memoryDir, `edit-${i}`, { title: `EDITMARKER ${i}`, body: 'a few lines of notes\n'.repeat(20) });
    writeDoc(env.memoryDir, 'edit-big', { title: 'EDITMARKER big', body: 'x'.repeat(100 * 1024) });
    runtime = createServerRuntime({ projectDir: env.projectDir, globalDir: env.globalDir, promptsDir: PROMPTS_DIR, indexCatchUpDelayMs: 60_000 });
    const found = await callTool(runtime, 'memory_search', { query: 'EDITMARKER', limit: 20 });
    assert.deepEqual(found.data.results.map((r) => r.id).sort(), ['edit-1', 'edit-2', 'edit-3', 'edit-4', 'edit-5', 'edit-big']);
    assert.equal('indexing' in found.data, false);
    // ... while a document over 256 KiB waits for the background
    writeDoc(env.memoryDir, 'too-big', { title: 'TOOBIGMARKER', body: 'y'.repeat(TOOL_SYNC_MAX_FILE_BYTES + 1) });
    const tooBig = await callTool(runtime, 'memory_search', { query: 'TOOBIGMARKER' });
    assert.deepEqual(tooBig.data.results, []);
    assert.deepEqual(tooBig.data.indexing, { pending: 1, documents: ['docs/2026-11/too-big.md'] });
    await runtime.shutdown();
    runtime = null;

    // 2. A budget of 100 ms at 10 bytes per ms (the clock stands still, so every document is measured
    //    against the full 100 ms): a document is taken when its estimate fits, otherwise it waits.
    const limited = new CortexStore({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      disableVec: true,
      toolSyncLimits: { budgetMs: 100, bytesPerMs: 10, perFileMs: 0, maxFileBytes: 1_000_000, now: () => 5_000_000 },
    });
    const reported = [];
    limited.onSyncDeferred = (info) => reported.push(info);
    try {
      writeDoc(env.memoryDir, 'fits-doc', { body: 'f'.repeat(200) });
      const slowSize = fs.statSync(writeDoc(env.memoryDir, 'slow-doc', { body: 'z'.repeat(3001) })).size;
      limited.beginSyncWindow();
      const result = limited.sync('project').project;
      assert.ok(result.deferred.some((item) => item.path === 'docs/2026-11/slow-doc.md' && item.reason === 'time_budget' && item.size === slowSize));
      assert.equal(result.deferred.some((item) => item.path === 'docs/2026-11/fits-doc.md'), false, 'about 40 ms estimated: inside the budget');
      assert.ok(limited.getUnindexedDocs().some((item) => item.scope === 'project' && item.path === 'docs/2026-11/slow-doc.md'));
      // The owner is told what was left out, with the tier it belongs to
      assert.equal(reported.length, 1);
      assert.deepEqual([reported[0].scope, reported[0].tierDir, reported[0].projectRoot], ['project', env.memoryDir, env.projectDir]);
      assert.ok(reported[0].deferred.some((item) => item.path === 'docs/2026-11/slow-doc.md'));
      // A new call starts with a clean report
      limited.beginSyncWindow();
      assert.deepEqual(limited.getUnindexedDocs(), []);
      limited.endSyncWindow();
    } finally {
      limited.close();
    }

    // 3. A store without tool limits (command lines, hooks with their own limits) indexes everything, as before
    const plain = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
    try {
      assert.equal(plain.toolSyncLimits, null);
      const result = plain.sync('project').project;
      assert.equal('deferred' in result, false);
      assert.ok(plain.getTier('project').db.prepare("SELECT id FROM docs WHERE id IN ('slow-doc', 'too-big')").all().length === 2);
    } finally {
      plain.close();
    }

    // The note itself
    assert.equal(describeIndexing([]), null);
    assert.equal(describeIndexing([{ scope: 'project', path: 'docs/a.md', size: 1, reason: 'error', error: 'EIO' }]), null, 'a document that cannot be indexed is not "waiting"');
    const many = Array.from({ length: 8 }, (_, i) => ({ scope: i === 0 ? 'global' : 'project', path: `docs/d${i}.md`, size: 10, reason: 'too_large' }));
    assert.equal(INDEXING_NOTE_MAX_DOCUMENTS, 5);
    assert.deepEqual(describeIndexing(many), { pending: 8, documents: ['global:docs/d0.md', 'docs/d1.md', 'docs/d2.md', 'docs/d3.md', 'docs/d4.md'] });
  } finally {
    if (runtime) await runtime.shutdown();
    env.cleanup();
  }
});

test('tool calls with project_dir: the other project gets the same limits, and the catch-up indexes its waiting document with a store of its own', async () => {
  const env = makeTempEnv('herdr-cortex-bgindex-other-');
  let runtime = null;
  try {
    const otherProject = path.join(env.root, 'other-project');
    fs.mkdirSync(otherProject, { recursive: true });
    approveAsUser(otherProject, { globalDir: env.globalDir });
    const otherMemory = path.join(otherProject, '.memory');
    writeDoc(otherMemory, 'other-large', { title: 'OTHERMARKER decision', body: 'other body line\n'.repeat(400) });
    writeDoc(env.globalDir, 'global-large', { title: 'GLOBALMARKER note', body: 'global body line\n'.repeat(400) });

    runtime = createServerRuntime({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      promptsDir: PROMPTS_DIR,
      toolSyncLimits: { maxFileBytes: 2000 },
      indexCatchUpDelayMs: 0,
      indexCatchUpRequestDelayMs: 10,
    });
    await runtime.indexCatchUp.done;
    // (the first pass indexed the global document; make another one that is waiting)
    writeDoc(env.globalDir, 'global-large-2', { title: 'GLOBALMARKER second', body: 'global body line\n'.repeat(400) });

    const first = await callTool(runtime, 'memory_search', { query: 'OTHERMARKER', project_dir: otherProject });
    assert.deepEqual(first.data.results, []);
    assert.deepEqual(first.data.indexing, { pending: 2, documents: ['docs/2026-11/other-large.md', 'global:docs/2026-11/global-large-2.md'] });

    await runtime.indexCatchUp.whenIdle();
    const second = await callTool(runtime, 'memory_search', { query: 'OTHERMARKER', project_dir: otherProject });
    assert.deepEqual(second.data.results.map((r) => r.id), ['other-large']);
    assert.equal('indexing' in second.data, false);
    assert.deepEqual((await callTool(runtime, 'memory_search', { query: 'GLOBALMARKER', scope: 'global' })).data.results.map((r) => r.id).sort(), ['global-large', 'global-large-2']);

    // No handle on the other project's index is kept open
    await runtime.shutdown();
    runtime = null;
    fs.rmSync(otherProject, { recursive: true, force: true });
    assert.equal(fs.existsSync(otherProject), false);
  } finally {
    if (runtime) await runtime.shutdown();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// The embedding queue does not block either
// ---------------------------------------------------------------------------------------------

test('embedding provider configured: the queue brings the index up to date one file per turn, so a tool call that arrives at startup is answered before that work is done', async () => {
  const env = makeTempEnv('herdr-cortex-bgindex-embed-');
  let runtime = null;
  try {
    const total = 12;
    for (let i = 1; i <= total; i++) {
      writeDoc(env.memoryDir, `doc-${String(i).padStart(2, '0')}`, { title: `STARTUPMARKER ${i}`, body: 'startup body line\n'.repeat(30) });
    }
    const provider = {
      name: 'fake',
      model: 'fake-embed-v1',
      dimensions: 4,
      calls: 0,
      async embed(texts) {
        this.calls += 1;
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    };

    // The catch-up's own first pass is far away: what indexes here is the embedding queue alone. The tool
    // limits are set so that a tool call indexes nothing itself.
    runtime = createServerRuntime({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      promptsDir: PROMPTS_DIR,
      embeddingProvider: provider,
      queueDebounceMs: 0,
      toolSyncLimits: { maxFileBytes: 1 },
      indexCatchUpDelayMs: 60_000,
    });
    assert.equal(runtime.embeddingQueue.hasPending(), true, 'documents waiting for an embedding are scheduled at startup');

    // Wait until the queue has begun to index, then call a tool
    const startedAt = Date.now();
    while (indexedIds(runtime).length === 0) {
      assert.ok(Date.now() - startedAt < 10_000, 'the embedding queue started');
      await nextTurn();
    }
    const indexedWhenCalled = indexedIds(runtime).length;
    assert.ok(indexedWhenCalled < total, `the queue's index sync yields between files (it had indexed ${indexedWhenCalled} of ${total} when the tool call was made)`);

    const answer = await callTool(runtime, 'memory_search', { query: 'STARTUPMARKER', limit: 50 });
    assert.equal(answer.isError, false);
    assert.ok(answer.data.indexing.pending > 0, 'the call was answered while documents were still waiting');
    assert.ok(answer.data.indexing.pending <= total - indexedWhenCalled);
    assert.ok(answer.data.indexing.documents.length <= 5);
    assert.ok(answer.data.results.length < total);
    assert.equal(isSharedSyncRunning(runtime.store.getTierIfExists('project').db), true, 'the same sync is still going on');

    // When the queue is done everything is indexed (once) and searchable, and the note is gone
    await runtime.embeddingQueue.whenIdle();
    while (runtime.embeddingQueue.hasPending()) {
      await nextTurn();
      await runtime.embeddingQueue.whenIdle();
    }
    assert.equal(indexedIds(runtime).length, total);
    assert.ok(provider.calls > 0, 'the documents were embedded');
    const done = await callTool(runtime, 'memory_search', { query: 'STARTUPMARKER', limit: 50 });
    assert.equal(done.data.results.length, total);
    assert.equal('indexing' in done.data, false);
  } finally {
    if (runtime) await runtime.shutdown();
    env.cleanup();
  }
});

test('shared yielding sync: callers that ask while a run is in progress join it; every file is read once; any caller can cancel', async () => {
  const env = makeTempEnv('herdr-cortex-bgindex-shared-');
  try {
    const tierDir = path.join(env.root, 'tier');
    for (let i = 1; i <= 6; i++) writeDoc(tierDir, `s-${i}`);
    const { db } = openTierDb(tierDir, { disableVec: true });
    try {
      let indexed = 0;
      const first = syncFromDiskShared(db, tierDir, { onFileIndexed: () => { indexed += 1; } });
      assert.equal(isSharedSyncRunning(db), true);
      const second = syncFromDiskShared(db, tierDir, { onFileIndexed: () => { indexed += 100; } });
      assert.equal(second, first, 'the second caller got the run that is in progress');
      const [a, b] = await Promise.all([first, second]);
      assert.deepEqual(a, { addedOrUpdated: 6, statUpdated: 0, deleted: 0 });
      assert.equal(b, a);
      assert.equal(indexed, 6, 'each file was indexed once, by the first run');
      assert.equal(isSharedSyncRunning(db), false);

      // A new call after the run starts a new run
      writeDoc(tierDir, 's-7');
      assert.deepEqual(await syncFromDiskShared(db, tierDir), { addedOrUpdated: 1, statUpdated: 0, deleted: 0 });

      // A joiner can stop the run; what was indexed stays
      for (let i = 8; i <= 12; i++) writeDoc(tierDir, `s-${i}`);
      let stop = false;
      const running = syncFromDiskShared(db, tierDir);
      const joined = syncFromDiskShared(db, tierDir, { isCancelled: () => stop });
      stop = true;
      assert.deepEqual(await joined, { cancelled: true });
      assert.deepEqual(await running, { cancelled: true });
      const count = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
      assert.ok(count >= 8 && count < 12, `stopped between files (${count} indexed)`);
      assert.deepEqual(await syncFromDiskShared(db, tierDir), { addedOrUpdated: 12 - count, statUpdated: 0, deleted: 0 });
    } finally {
      db.close();
    }
  } finally {
    env.cleanup();
  }
});

test('index catch-up: requests made while a pass runs, or right after it, still get their pass; cancel settles everything', async () => {
  const env = makeTempEnv('herdr-cortex-bgindex-catchup-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    writeDoc(env.memoryDir, 'c-1');
    const indexedScopes = [];
    const catchUp = startIndexCatchUp(store, {
      delayMs: 0,
      requestDelayMs: 0,
      log: null,
      onIndexed: (scope, result) => indexedScopes.push([scope, result.addedOrUpdated]),
    });
    const firstPass = await catchUp.done;
    assert.equal(firstPass.project.addedOrUpdated, 1);
    await catchUp.whenIdle();
    assert.deepEqual(indexedScopes, [['project', 1]]);

    // A request after the first pass
    writeDoc(env.memoryDir, 'c-2');
    catchUp.request({ scope: 'project', projectRoot: env.projectDir });
    await catchUp.whenIdle();
    assert.deepEqual(indexedScopes, [['project', 1], ['project', 1]]);

    // Several requests at once make one pass per tier
    writeDoc(env.memoryDir, 'c-3');
    writeDoc(env.globalDir, 'g-1');
    catchUp.request({ scope: 'project' });
    catchUp.request({ scope: 'project' });
    catchUp.request({ scope: 'global' });
    await catchUp.whenIdle();
    assert.deepEqual(indexedScopes.slice(2), [['project', 1], ['global', 1]]);

    // Another project without a way to open it is skipped quietly; idle is still reached
    catchUp.request({ scope: 'project', projectRoot: path.join(env.root, 'elsewhere') });
    await catchUp.whenIdle();

    // After cancel nothing runs any more
    writeDoc(env.memoryDir, 'c-4');
    catchUp.cancel();
    catchUp.request({ scope: 'project' });
    await catchUp.whenIdle();
    assert.equal(store.getTier('project').db.prepare("SELECT COUNT(*) AS n FROM docs WHERE id = 'c-4'").get().n, 0);

    // Cancelled before the first pass: `done` resolves with nothing
    const never = startIndexCatchUp(store, { delayMs: 60_000, log: null });
    never.cancel();
    assert.deepEqual(await never.done, {});
    await never.whenIdle();
  } finally {
    store.close();
    env.cleanup();
  }
});
