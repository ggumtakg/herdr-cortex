import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, atomicWriteJson, atomicWriteText, projectPathKey } from '../src/core/config.mjs';
import { HOOK_MAX_CHARS, resolveHookBudget } from '../src/core/budget.mjs';
import { serializeMarkdownDoc } from '../src/core/frontmatter.mjs';
import {
  DEFERRED_INDEX_FILE,
  getDeferredIndexPath,
  openTierDb,
  readDeferredIndex,
  syncFromDisk,
  syncFromDiskYielding,
} from '../src/core/db.mjs';
import { CortexStore } from '../src/core/store.mjs';
import { approveProject } from '../src/core/trust.mjs';
import {
  CLAUDE_HOOK_MAX_CHARS,
  CLEAR_RECORD_STALE_MS,
  CLEAR_RECORD_WINDOW_MS,
  COMPACT_POINTER_INSTRUCTION,
  COMPACT_USER_INSTRUCTIONS_CLAUSE,
  SUBAGENT_MEMORY_DIR_DENY_REASON,
  SUBAGENT_TRUST_CHANGE_DENY_REASON,
  TURNS_NOT_RESTORED_TOO_LARGE_NOTE,
  TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE,
  classifyTrustCommand,
  formatStateFileWriteAskReason,
  formatTrustCommandAskReason,
  getClearRecordsDir,
  handleClaudePreCompact,
  handleClaudePreToolUse,
  handleClaudeSessionEnd,
  handleClaudeSessionStart,
  renderClaudeHookStdout,
  runClaudeHook,
} from '../src/hooks/claude.mjs';
import {
  handleAntigravityPreInvocation,
  handleAntigravitySessionStart,
} from '../src/hooks/antigravity.mjs';
import {
  HOOK_INDEX_BUDGET_MS,
  HOOK_INDEX_MAX_FILE_BYTES,
  UNINDEXED_NOTICE_MAX_FILES,
  formatUnindexedNotice,
  resolveHookSyncOptions,
} from '../src/hooks/overview.mjs';
import {
  ANTIGRAVITY_TRANSCRIPT_ADAPTER,
  CLAUDE_TRANSCRIPT_ADAPTER,
  RESTORE_FAILURE_RECORD_TOO_LARGE,
  extractAntigravityState,
  extractClaudeRecentTurns,
  extractRecentTurns,
  stripSystemReminders,
} from '../src/hooks/recent-turns.mjs';
import { CLAUDE_SESSION_END_TIMEOUT_SECONDS, installCortex, isOwnHook, uninstallCortex } from '../src/hooks/installer.mjs';
import { createServerRuntime } from '../src/mcp/server.mjs';

function makeTempEnv(prefix = 'herdr-cortex-hardening-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  const globalDir = path.join(homeDir, '.herdr-cortex');
  const promptsDir = path.join(root, 'prompts');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  // The project folder is approved, as a user would do with cortex-trust.
  approveProject(projectDir, { globalDir });
  atomicWriteText(path.join(promptsDir, 'HEAD_CORE.md'), '# HEAD_CORE\n\n- Delegate high-resolution work.\n');
  return {
    root,
    projectDir,
    homeDir,
    globalDir,
    promptsDir,
    memoryDir: path.join(projectDir, '.memory'),
    hookOptions(extra = {}) {
      return { terminalId: '', globalDir, legacyHome: homeDir, promptsDir, ...extra };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Environment for child processes: everything the code could write goes to the temp tree.
function childEnv(env) {
  const out = { ...process.env, HERDR_CORTEX_HOME: env.globalDir, HERDR_CORTEX_TEST_HOME: env.homeDir };
  delete out.HC_TERMINAL_ID;
  return out;
}

function writeJsonl(filePath, items) {
  const content = items.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n';
  atomicWriteText(filePath, content);
}

// A hand-placed memory document: <tierDir>/docs/2026-11/<id>.md
function writeDoc(tierDir, id, frontmatter = {}, body = 'body') {
  const filePath = path.join(tierDir, 'docs', '2026-11', `${id}.md`);
  atomicWriteText(filePath, serializeMarkdownDoc({
    id,
    type: 'decision',
    title: `Title of ${id}`,
    summary: `Summary of ${id}`,
    status: 'active',
    ...frontmatter,
  }, body));
  return filePath;
}

function indexedIds(tierDir) {
  const { db } = openTierDb(tierDir, { disableVec: true, autoSyncOnRecover: false });
  try {
    return db.prepare('SELECT id FROM docs ORDER BY id').all().map((r) => r.id);
  } finally {
    db.close();
  }
}

function contextOf(out) {
  return out?.hookSpecificOutput?.additionalContext || '';
}

function agyText(out) {
  return (out?.injectSteps || []).map((s) => s.systemMessage?.systemMessage || '').join('\n\n');
}

const user = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const human = (text) => user(text, { origin: { kind: 'human' } });
const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

// ---------------------------------------------------------------------------------------------
// Item 1: slow or large documents are deferred, never excluded, and the hook still injects everything else
// ---------------------------------------------------------------------------------------------

test('index deferral: the hook indexes what fits, defers the large document with a notice, and the MCP server catches up', async () => {
  const env = makeTempEnv('cortex-defer-hook-');
  let runtime = null;
  try {
    writeDoc(env.memoryDir, 'dec-alpha', { title: 'Alpha decision' });
    writeDoc(env.memoryDir, 'dec-beta', { title: 'Beta decision' });
    writeDoc(env.memoryDir, 'todo-gamma', { type: 'todo', title: 'Gamma todo' });
    const hugePath = writeDoc(env.memoryDir, 'dec-huge', { title: 'Huge decision' }, 'large body line\n'.repeat(4000));
    const hugeSize = fs.statSync(hugePath).size;
    assert.ok(hugeSize > 50_000);
    const indexBudget = { maxFileBytes: 20_000 };
    const startPayload = { session_id: 'sess-defer-1', source: 'startup', cwd: env.projectDir };

    // --- first hook run ---
    const first = contextOf(handleClaudeSessionStart(startPayload, env.hookOptions({ indexBudget })));
    assert.match(first, /# HEAD_CORE/);
    assert.match(first, /Cortex Memory Overview/);
    assert.match(first, /Alpha decision/);
    assert.match(first, /Beta decision/);
    assert.match(first, /Gamma todo/);
    assert.doesNotMatch(first, /Huge decision/);
    assert.ok(first.length <= CLAUDE_HOOK_MAX_CHARS);

    const expectedNotice = formatUnindexedNotice([
      { scope: 'project', path: 'docs/2026-11/dec-huge.md', size: hugeSize, reason: 'too_large' },
    ]);
    assert.match(expectedNotice, /^\[herdr-cortex\] Memory may be incomplete: 1 document is not indexed yet/);
    assert.match(expectedNotice, /"docs\/2026-11\/dec-huge\.md" \(\d+ KB, too large to index at session start\)/);
    assert.equal(expectedNotice.includes('\n'), false);
    assert.ok(first.includes(expectedNotice), 'the injection names the document that was not indexed and why');

    // the normal documents are indexed, the large one is recorded as deferred
    assert.deepEqual(indexedIds(env.memoryDir), ['dec-alpha', 'dec-beta', 'todo-gamma']);
    assert.equal(getDeferredIndexPath(env.memoryDir), path.join(env.memoryDir, 'state', DEFERRED_INDEX_FILE));
    const record = JSON.parse(fs.readFileSync(getDeferredIndexPath(env.memoryDir), 'utf8'));
    assert.equal(record.version, 1);
    assert.equal(record.count, 1);
    assert.deepEqual(record.files, [{ path: 'docs/2026-11/dec-huge.md', size: hugeSize, reason: 'too_large' }]);
    assert.equal(typeof record.updatedAt, 'string');
    assert.deepEqual(readDeferredIndex(env.memoryDir).files, record.files);

    // --- second hook run: finished work is not redone ---
    const ftsBefore = (() => {
      const { db } = openTierDb(env.memoryDir, { disableVec: true, autoSyncOnRecover: false });
      try {
        return db.prepare('SELECT rowid, doc_id FROM docs_fts ORDER BY rowid').all();
      } finally {
        db.close();
      }
    })();
    const recordBytesBefore = fs.readFileSync(getDeferredIndexPath(env.memoryDir), 'utf8');
    const second = contextOf(handleClaudeSessionStart(startPayload, env.hookOptions({ indexBudget })));
    assert.ok(second.includes(expectedNotice));
    assert.match(second, /Alpha decision/);
    const limited = new CortexStore({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      disableVec: true,
      syncOptions: resolveHookSyncOptions({ indexBudget }),
    });
    try {
      assert.deepEqual(limited.sync('project').project, {
        addedOrUpdated: 0,
        statUpdated: 0,
        deleted: 0,
        deferred: [{ path: 'docs/2026-11/dec-huge.md', size: hugeSize, reason: 'too_large' }],
      });
      assert.deepEqual(limited.getUnindexedDocs(), [
        { scope: 'project', path: 'docs/2026-11/dec-huge.md', size: hugeSize, reason: 'too_large' },
      ]);
      const ftsAfter = limited.getTier('project').db.prepare('SELECT rowid, doc_id FROM docs_fts ORDER BY rowid').all();
      assert.deepEqual(ftsAfter, ftsBefore, 'documents indexed by the first run were not written again');
    } finally {
      limited.close();
    }
    assert.equal(fs.readFileSync(getDeferredIndexPath(env.memoryDir), 'utf8'), recordBytesBefore, 'an unchanged record is not rewritten');

    // --- the Antigravity hook says the same in a step of its own ---
    const agy = handleAntigravitySessionStart(
      { conversationId: 'conv-defer', rootConversationId: 'conv-defer', cwd: env.projectDir },
      env.hookOptions({ indexBudget }),
    );
    const agySteps = agy.injectSteps.map((s) => s.systemMessage.systemMessage);
    assert.ok(agySteps.includes(expectedNotice));
    assert.ok(agySteps.some((s) => /Alpha decision/.test(s)));
    assert.equal(agySteps.some((s) => /Huge decision/.test(s)), false);

    // --- the MCP server process indexes it in the background and clears the record ---
    runtime = createServerRuntime({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      promptsDir: env.promptsDir,
      indexCatchUpDelayMs: 0,
    });
    const caughtUp = await runtime.indexCatchUp.done;
    assert.equal(caughtUp.project.addedOrUpdated, 1);
    assert.equal(caughtUp.project.waitingBefore, 1, 'the server read the record the hook left');
    assert.equal('deferred' in caughtUp.project, false);
    await runtime.shutdown();
    runtime = null;

    assert.deepEqual(indexedIds(env.memoryDir), ['dec-alpha', 'dec-beta', 'dec-huge', 'todo-gamma']);
    assert.equal(fs.existsSync(getDeferredIndexPath(env.memoryDir)), false, 'the record is cleared');
    assert.deepEqual(readDeferredIndex(env.memoryDir), { count: 0, files: [], updatedAt: '' });

    // --- next session: nothing is said when nothing was deferred ---
    const third = contextOf(handleClaudeSessionStart(startPayload, env.hookOptions({ indexBudget })));
    assert.match(third, /Huge decision/);
    assert.doesNotMatch(third, /Memory may be incomplete/);
    assert.doesNotMatch(third, /not indexed/);
  } finally {
    if (runtime) await runtime.shutdown();
    env.cleanup();
  }
});

test('index deferral: time budget from the file size, defaults, notice bounds, and a deferred file is never taken for a deleted one', () => {
  const env = makeTempEnv('cortex-defer-budget-');
  try {
    // Defaults leave headroom inside the 10 s the hooks are registered with
    const defaults = resolveHookSyncOptions({ startedAt: 1000 });
    assert.equal(HOOK_INDEX_BUDGET_MS, 4000);
    assert.equal(defaults.deadline, 1000 + HOOK_INDEX_BUDGET_MS);
    assert.equal(defaults.maxFileBytes, HOOK_INDEX_MAX_FILE_BYTES);
    assert.ok(defaults.bytesPerMs > 0 && defaults.perFileMs > 0);

    const tierDir = path.join(env.root, 'tier');
    const bodies = { 'doc-a': 'a'.repeat(200), 'doc-b': 'b'.repeat(200), 'doc-c': 'c'.repeat(200), 'doc-d': 'd'.repeat(200) };
    for (const [id, body] of Object.entries(bodies)) writeDoc(tierDir, id, { session: 'budget-session' }, body);
    const sizeOf = (id) => fs.statSync(path.join(tierDir, 'docs', '2026-11', `${id}.md`)).size;
    const { db } = openTierDb(tierDir, { disableVec: true });
    try {
      // A clock that only moves when a file was indexed: 60 ms per file, 100 ms budget, 40 ms estimate each
      const clock = { now: 5_000_000 };
      const bytesPerMs = sizeOf('doc-a') / 40;
      const limited = () => syncFromDisk(db, tierDir, {
        deadline: clock.now + 100,
        bytesPerMs,
        now: () => clock.now,
        onFileIndexed: () => { clock.now += 60; },
      });
      const first = limited();
      assert.equal(first.addedOrUpdated, 2);
      assert.deepEqual(first.deferred.map((d) => [d.path, d.reason]), [
        ['docs/2026-11/doc-c.md', 'time_budget'],
        ['docs/2026-11/doc-d.md', 'time_budget'],
      ]);
      assert.equal(first.deferred[0].size, sizeOf('doc-c'));
      assert.deepEqual(db.prepare('SELECT id FROM docs ORDER BY id').all().map((r) => r.id), ['doc-a', 'doc-b']);
      assert.equal(readDeferredIndex(tierDir).count, 2);

      // The next limited run continues where the first one stopped
      const second = limited();
      assert.equal(second.addedOrUpdated, 2);
      assert.equal('deferred' in second, false);
      assert.equal(readDeferredIndex(tierDir).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'session_next'").get().n, 3, 'the session chain is complete');

      // A changed document that is deferred keeps its row; a deleted document is still removed
      atomicWriteText(path.join(tierDir, 'docs', '2026-11', 'doc-a.md'), serializeMarkdownDoc(
        { id: 'doc-a', type: 'decision', title: 'Doc A rewritten', summary: 's', status: 'active' },
        'z'.repeat(5000),
      ));
      fs.unlinkSync(path.join(tierDir, 'docs', '2026-11', 'doc-d.md'));
      const third = syncFromDisk(db, tierDir, { maxFileBytes: 2000 });
      assert.deepEqual(third.deferred.map((d) => [d.path, d.reason]), [['docs/2026-11/doc-a.md', 'too_large']]);
      assert.equal(third.deleted, 1);
      assert.equal(third.addedOrUpdated, 0);
      const rows = db.prepare('SELECT id, title FROM docs ORDER BY id').all();
      assert.deepEqual(rows.map((r) => r.id), ['doc-a', 'doc-b', 'doc-c'], 'doc-a was deferred, not deleted; doc-d was deleted');
      assert.equal(rows[0].title, 'Title of doc-a', 'the deferred document keeps its last indexed state');

      // A document without a row that is deferred may be a moved one: rows of vanished files wait for it
      fs.renameSync(path.join(tierDir, 'docs', '2026-11', 'doc-a.md'), path.join(tierDir, 'docs', '2026-11', 'doc-a-moved.md'));
      const fourth = syncFromDisk(db, tierDir, { maxFileBytes: 2000 });
      assert.deepEqual(fourth.deferred.map((d) => d.path), ['docs/2026-11/doc-a-moved.md']);
      assert.equal(fourth.deleted, 0);
      assert.equal(db.prepare("SELECT path FROM docs WHERE id = 'doc-a'").get().path, 'docs/2026-11/doc-a.md');

      // While another process holds the index write lock, a limited sync does not fail and does not wait
      // past its deadline: the file is deferred and indexed by a later run
      writeDoc(tierDir, 'doc-busy');
      const other = openTierDb(tierDir, { disableVec: true, autoSyncOnRecover: false }).db;
      try {
        other.exec('BEGIN IMMEDIATE');
        const waitStart = Date.now();
        const busy = syncFromDisk(db, tierDir, { deadline: Date.now() + 150, maxFileBytes: 2000 });
        assert.ok(Date.now() - waitStart < 3000, `waited ${Date.now() - waitStart} ms`);
        assert.deepEqual(busy.deferred.map((d) => [d.path, d.reason]), [
          ['docs/2026-11/doc-a-moved.md', 'too_large'],
          ['docs/2026-11/doc-busy.md', 'index_busy'],
        ]);
        other.exec('COMMIT');
      } finally {
        other.close();
      }
      assert.equal(syncFromDisk(db, tierDir, { deadline: Date.now() + 5000, maxFileBytes: 2000 }).addedOrUpdated, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM docs WHERE id = 'doc-busy'").get().n, 1);

      // Without limits everything is indexed: the moved document keeps its id, the record is removed
      const full = syncFromDisk(db, tierDir);
      assert.deepEqual(full, { addedOrUpdated: 1, statUpdated: 0, deleted: 0 });
      const moved = db.prepare("SELECT path, title FROM docs WHERE id = 'doc-a'").get();
      assert.deepEqual({ ...moved }, { path: 'docs/2026-11/doc-a-moved.md', title: 'Doc A rewritten' });
      assert.equal(fs.existsSync(getDeferredIndexPath(tierDir)), false);
      assert.deepEqual(syncFromDisk(db, tierDir), { addedOrUpdated: 0, statUpdated: 0, deleted: 0 });
    } finally {
      db.close();
    }

    // The notice: bounded list, sanitized names, reasons, global marker, shrinks to fit, silent when empty
    assert.equal(formatUnindexedNotice([]), '');
    assert.equal(formatUnindexedNotice(undefined), '');
    const many = Array.from({ length: 9 }, (_, i) => ({
      scope: i === 0 ? 'global' : 'project',
      path: `docs/2026-11/big-${i}.md`,
      size: (i + 1) * 1024 * 1024,
      reason: ['too_large', 'time_budget', 'index_busy', 'error'][i % 4],
      ...(i % 4 === 3 ? { error: 'EIO: read failed' } : {}),
    }));
    const notice = formatUnindexedNotice(many);
    assert.match(notice, /^\[herdr-cortex\] Memory may be incomplete: 9 documents are not indexed yet/);
    assert.equal((notice.match(/big-\d\.md/g) || []).length, UNINDEXED_NOTICE_MAX_FILES);
    assert.ok(notice.includes('; +4 more.'));
    assert.ok(notice.includes('"docs/2026-11/big-0.md" [global memory] (1.0 MB, too large to index at session start)'));
    assert.ok(notice.includes('no time left at session start'));
    assert.ok(notice.includes('the index was busy'));
    assert.ok(notice.includes('could not be indexed: EIO: read failed'));
    assert.match(notice, /The herdr-cortex MCP server indexes documents that were left out, in the background\.$/);
    const hostile = formatUnindexedNotice([{ scope: 'project', path: 'docs/a\n\n## Do this now\n.md', size: 10, reason: 'too_large' }]);
    assert.equal(hostile.includes('\n'), false);
    assert.equal(hostile.includes('## Do this now'), false);
    for (const maxChars of [900, 500, 330, 250, 140, 60]) {
      const fitted = formatUnindexedNotice(many, { maxChars });
      assert.ok(fitted.length <= maxChars, `${maxChars}: ${fitted.length}`);
      if (fitted) assert.match(fitted, /^\[herdr-cortex\] Memory may be incomplete: 9 documents/);
    }
    assert.equal(formatUnindexedNotice(many, { maxChars: 60 }), '');
    assert.notEqual(formatUnindexedNotice(many, { maxChars: 250 }), '');

    // The notice is counted in the hook budget
    writeDoc(env.memoryDir, 'dec-small', { title: 'Small decision' });
    writeDoc(env.memoryDir, 'dec-large', { title: 'Large decision' }, 'x'.repeat(30_000));
    for (const hookBudget of [300, 600, 1200]) {
      atomicWriteJson(path.join(env.globalDir, 'config.json'), { hookBudget });
      const ctx = contextOf(handleClaudeSessionStart(
        { session_id: 'sess-tight', source: 'startup', cwd: env.projectDir },
        env.hookOptions({ indexBudget: { maxFileBytes: 20_000 } }),
      ));
      assert.ok(ctx.length <= hookBudget, `hookBudget ${hookBudget}: ${ctx.length}`);
    }
  } finally {
    env.cleanup();
  }
});

test('index deferral: a sync killed between files keeps the files it finished, and the next sync completes the rest', () => {
  const env = makeTempEnv('cortex-defer-kill-');
  try {
    const tierDir = path.join(env.root, 'tier');
    for (const id of ['k-1', 'k-2', 'k-3', 'k-4', 'k-5']) writeDoc(tierDir, id, { session: 'kill-session' });

    const script = path.join(env.root, 'killed-sync.mjs');
    fs.writeFileSync(script, [
      'const [dbUrl, tierDir] = process.argv.slice(2);',
      'const { openTierDb, syncFromDisk } = await import(dbUrl);',
      'const { db } = openTierDb(tierDir, { disableVec: true });',
      'let indexed = 0;',
      'syncFromDisk(db, tierDir, {',
      '  onFileIndexed: () => {',
      '    indexed += 1;',
      '    if (indexed === 2) {',
      "      process.kill(process.pid, 'SIGKILL');",
      '      for (;;) { /* wait for the kill */ }',
      '    }',
      '  },',
      '});',
      "console.log('finished without being killed');",
      '',
    ].join('\n'), 'utf8');
    const killed = spawnSync(
      process.execPath,
      ['--no-warnings', script, pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'db.mjs')).href, tierDir],
      { encoding: 'utf8', env: childEnv(env), timeout: 30000 },
    );
    assert.equal(killed.stdout.includes('finished without being killed'), false, killed.stdout + killed.stderr);
    assert.notEqual(killed.status, 0);

    const { db } = openTierDb(tierDir, { disableVec: true, autoSyncOnRecover: false });
    try {
      assert.deepEqual(db.prepare('SELECT id FROM docs ORDER BY id').all().map((r) => r.id), ['k-1', 'k-2']);
      assert.equal(
        db.prepare('SELECT doc_id FROM docs_fts ORDER BY doc_id').all().map((r) => r.doc_id).join(','),
        'k-1,k-2',
      );

      const resumed = syncFromDisk(db, tierDir);
      assert.deepEqual(resumed, { addedOrUpdated: 3, statUpdated: 0, deleted: 0 });
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM docs').get().n, 5);
      // The session chain covers the documents of both runs
      const chain = db.prepare("SELECT src, dst FROM edges WHERE kind = 'session_next'").all();
      assert.equal(chain.length, 4);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM index_meta WHERE key = 'sessionEdgesPending'").get().n, 0);
    } finally {
      db.close();
    }
  } finally {
    env.cleanup();
  }
});

test('index deferral: the background sync yields between files, and a file that cannot be indexed stays listed with its error', async () => {
  const env = makeTempEnv('cortex-defer-yield-');
  const realReadFileSync = fs.readFileSync;
  try {
    const tierDir = path.join(env.root, 'tier');
    for (const id of ['y-1', 'y-2', 'y-3', 'y-4', 'y-5', 'y-6']) writeDoc(tierDir, id);
    const { db } = openTierDb(tierDir, { disableVec: true });
    try {
      // Other work on the event loop gets a turn while the sync is between two files
      let indexed = 0;
      let done = false;
      const seenByOtherWork = new Set();
      const otherWork = (async () => {
        while (!done) {
          await new Promise((resolve) => setImmediate(resolve));
          seenByOtherWork.add(indexed);
        }
      })();
      const result = await syncFromDiskYielding(db, tierDir, { onFileIndexed: () => { indexed += 1; } });
      done = true;
      await otherWork;
      assert.deepEqual(result, { addedOrUpdated: 6, statUpdated: 0, deleted: 0 });
      assert.ok(
        [...seenByOtherWork].filter((n) => n > 0 && n < 6).length >= 3,
        `other work ran between files: ${[...seenByOtherWork].join(',')}`,
      );

      // A cancelled run keeps what it indexed and reports that it was cancelled
      for (const id of ['z-1', 'z-2', 'z-3']) writeDoc(tierDir, id);
      let afterFirst = false;
      const cancelled = await syncFromDiskYielding(db, tierDir, {
        onFileIndexed: () => { afterFirst = true; },
        isCancelled: () => afterFirst,
      });
      assert.deepEqual(cancelled, { cancelled: true });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM docs WHERE id LIKE 'z-%'").get().n, 1);

      // A file whose read fails is reported and kept on the list; the others are indexed
      const brokenPath = writeDoc(tierDir, 'broken-doc');
      fs.readFileSync = (target, ...rest) => {
        if (String(target) === brokenPath) throw new Error('EIO: simulated read failure');
        return realReadFileSync(target, ...rest);
      };
      const withFailure = syncFromDisk(db, tierDir);
      assert.equal(withFailure.addedOrUpdated, 2);
      assert.equal(withFailure.failed.length, 1);
      assert.deepEqual(
        { ...withFailure.failed[0], size: 0 },
        { path: 'docs/2026-11/broken-doc.md', size: 0, reason: 'error', error: 'EIO: simulated read failure' },
      );
      const listed = readDeferredIndex(tierDir);
      assert.equal(listed.count, 1);
      assert.equal(listed.files[0].path, 'docs/2026-11/broken-doc.md');
      assert.equal(listed.files[0].error, 'EIO: simulated read failure');
      assert.equal(syncFromDisk(db, tierDir).failed.length, 1, 'still failing: still listed');

      fs.readFileSync = realReadFileSync;
      assert.deepEqual(syncFromDisk(db, tierDir), { addedOrUpdated: 1, statUpdated: 0, deleted: 0 });
      assert.equal(readDeferredIndex(tierDir).count, 0);
    } finally {
      db.close();
    }
  } finally {
    fs.readFileSync = realReadFileSync;
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 2: after /clear, turns come only from the session that was actually cleared
// ---------------------------------------------------------------------------------------------

test('/clear: turns are restored from the session the SessionEnd hook recorded, never from a guessed transcript', () => {
  const env = makeTempEnv('cortex-clear-');
  try {
    const transcriptDir = path.join(env.root, 'claude-projects', 'C--work-project');
    const transcriptOf = (sessionId) => path.join(transcriptDir, `${sessionId}.jsonl`);
    writeJsonl(transcriptOf('sess-a'), [human('Goal of window A'), assistant('Reply in window A')]);
    writeJsonl(transcriptOf('sess-other'), [human('Secret of the other window'), assistant('Other window reply')]);
    // The other window's transcript is the most recently modified file in the directory
    const past = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(transcriptOf('sess-a'), past, past);
    const recordsDir = getClearRecordsDir(env.globalDir);
    assert.equal(recordsDir, path.join(env.globalDir, 'state', 'cleared-sessions'));
    const recordFile = (sessionId) => path.join(recordsDir, `${sessionId}.json`);
    const listRecords = () => (fs.existsSync(recordsDir) ? fs.readdirSync(recordsDir).sort() : []);

    let newCount = 0;
    const startAfterClear = (options = {}, cwd = env.projectDir) => {
      const sessionId = `sess-new-${++newCount}`;
      atomicWriteText(transcriptOf(sessionId), '');
      return contextOf(handleClaudeSessionStart(
        { session_id: sessionId, source: 'clear', transcript_path: transcriptOf(sessionId), cwd, hook_event_name: 'SessionStart' },
        env.hookOptions(options),
      ));
    };
    const endSession = (sessionId, reason, options = {}, extra = {}) => handleClaudeSessionEnd(
      { session_id: sessionId, transcript_path: transcriptOf(sessionId), cwd: env.projectDir, hook_event_name: 'SessionEnd', reason, ...extra },
      { terminalId: '', globalDir: env.globalDir, ...options },
    );

    // 1. No record: nothing is restored (the newer transcript of the other window is not used) and a note says so
    const noRecord = startAfterClear();
    assert.doesNotMatch(noRecord, /window A|other window/i);
    assert.doesNotMatch(noRecord, /Recent Conversation Turns/);
    assert.ok(noRecord.includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE));
    assert.equal(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE.includes('\n'), false);

    // 2. Only "clear" is recorded; the handler returns nothing in every case
    for (const reason of ['logout', 'prompt_input_exit', 'resume', 'other', '', undefined]) {
      assert.deepEqual(endSession('sess-a', reason), {});
    }
    assert.deepEqual(endSession('sess-a', 'clear', {}, { agent_id: 'sub-1' }), {}, 'subagents are ignored');
    assert.deepEqual(listRecords(), []);

    // 3. SessionEnd(clear) of session A, then SessionStart(clear): the turns are A's
    const t0 = 1_800_000_000_000;
    assert.deepEqual(endSession('sess-a', 'clear', { now: () => t0 }), {});
    const record = JSON.parse(fs.readFileSync(recordFile('sess-a'), 'utf8'));
    assert.deepEqual(record, {
      version: 1,
      sessionId: 'sess-a',
      transcriptPath: transcriptOf('sess-a'),
      cwd: env.projectDir,
      cwdKey: projectPathKey(env.projectDir),
      terminalId: null,
      clearedAt: new Date(t0).toISOString(),
      clearedAtMs: t0,
    });
    const restored = startAfterClear({ now: () => t0 + 1500 });
    assert.match(restored, /Recent Conversation Turns/);
    assert.match(restored, /Goal of window A/);
    assert.match(restored, /Reply in window A/);
    assert.doesNotMatch(restored, /other window/i);
    assert.equal(restored.includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE), false);
    assert.deepEqual(listRecords(), [], 'the record is consumed');

    // 4. ... so a second /clear without a new record restores nothing
    const consumed = startAfterClear({ now: () => t0 + 3000 });
    assert.doesNotMatch(consumed, /window A/);
    assert.ok(consumed.includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE));

    // 5. Two windows cleared at the same moment in the same folder: no guess
    endSession('sess-a', 'clear', { now: () => t0 });
    endSession('sess-other', 'clear', { now: () => t0 + 200 });
    assert.deepEqual(listRecords(), ['sess-a.json', 'sess-other.json']);
    const ambiguous = startAfterClear({ now: () => t0 + 1000 });
    assert.doesNotMatch(ambiguous, /window A|other window/i);
    assert.ok(ambiguous.includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE));
    assert.deepEqual(listRecords(), ['sess-a.json', 'sess-other.json'], 'records that were not used stay');

    // 6. A record older than the window is ignored; one older than the stale limit is deleted
    fs.unlinkSync(recordFile('sess-other'));
    const justTooOld = startAfterClear({ now: () => t0 + CLEAR_RECORD_WINDOW_MS + 1 });
    assert.doesNotMatch(justTooOld, /window A/);
    assert.ok(justTooOld.includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE));
    assert.deepEqual(listRecords(), ['sess-a.json']);
    const inTime = startAfterClear({ now: () => t0 + CLEAR_RECORD_WINDOW_MS });
    assert.match(inTime, /Goal of window A/);
    endSession('sess-a', 'clear', { now: () => t0 });
    startAfterClear({ now: () => t0 + CLEAR_RECORD_STALE_MS + 1 });
    assert.deepEqual(listRecords(), [], 'stale records are pruned');
    // ... also by the next SessionEnd(clear)
    endSession('sess-a', 'clear', { now: () => t0 });
    endSession('sess-other', 'clear', { now: () => t0 + CLEAR_RECORD_STALE_MS + 5 });
    assert.deepEqual(listRecords(), ['sess-other.json']);
    fs.unlinkSync(recordFile('sess-other'));

    // 7. Records of another folder or another terminal are not candidates
    const otherFolder = path.join(env.root, 'other-folder');
    fs.mkdirSync(otherFolder);
    endSession('sess-a', 'clear', { now: () => t0 }, { cwd: otherFolder });
    assert.ok(startAfterClear({ now: () => t0 + 100 }).includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE));
    endSession('sess-a', 'clear', { now: () => t0, terminalId: 'tab-7' });
    assert.equal(JSON.parse(fs.readFileSync(recordFile('sess-a'), 'utf8')).terminalId, 'tab-7');
    assert.ok(startAfterClear({ now: () => t0 + 100 }).includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE), 'no terminal');
    assert.ok(startAfterClear({ now: () => t0 + 100, terminalId: 'tab-8' }).includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE), 'other terminal');
    assert.match(startAfterClear({ now: () => t0 + 100, terminalId: 'tab-7' }), /Goal of window A/);
    // The same folder reached through a junction is the same folder
    const alias = path.join(env.root, 'project-alias');
    fs.symlinkSync(env.projectDir, alias, 'junction');
    endSession('sess-a', 'clear', { now: () => t0 });
    assert.match(startAfterClear({ now: () => t0 + 100 }, alias), /Goal of window A/);

    // 8. A record never makes the hook read a transcript outside the new transcript's directory
    const outside = path.join(env.root, 'elsewhere', 'sess-outside.jsonl');
    writeJsonl(outside, [human('Outside secret'), assistant('Outside reply')]);
    atomicWriteJson(recordFile('sess-outside'), {
      version: 1,
      sessionId: 'sess-outside',
      transcriptPath: outside,
      cwd: env.projectDir,
      cwdKey: projectPathKey(env.projectDir),
      terminalId: null,
      clearedAt: new Date(t0).toISOString(),
      clearedAtMs: t0,
    });
    atomicWriteJson(recordFile('sess-traversal'), {
      version: 1,
      sessionId: 'sess-traversal',
      transcriptPath: path.join(transcriptDir, '..', '..', 'elsewhere', 'sess-outside.jsonl'),
      cwd: env.projectDir,
      cwdKey: projectPathKey(env.projectDir),
      terminalId: null,
      clearedAt: new Date(t0).toISOString(),
      clearedAtMs: t0,
    });
    atomicWriteText(recordFile('garbage'), 'not json');
    const escaped = startAfterClear({ now: () => t0 + 100 });
    assert.doesNotMatch(escaped, /Outside/);
    assert.ok(escaped.includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE));

    // 9. An excluded project writes no record
    for (const name of listRecords()) fs.unlinkSync(path.join(recordsDir, name));
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { excludedProjects: [env.projectDir] });
    endSession('sess-a', 'clear');
    assert.deepEqual(listRecords(), []);
    fs.unlinkSync(path.join(env.globalDir, 'config.json'));

    // 10. The hook process: writes the record, prints nothing, and is done well inside the 1.5 s default
    const startedAt = Date.now();
    const cli = spawnSync(
      process.execPath,
      ['--no-warnings', path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs'), 'session-end', '--id', 'herdr-cortex'],
      {
        input: JSON.stringify({ session_id: 'sess-a', transcript_path: transcriptOf('sess-a'), cwd: env.projectDir, hook_event_name: 'SessionEnd', reason: 'clear' }),
        encoding: 'utf8',
        cwd: env.projectDir,
        env: childEnv(env),
        timeout: 30000,
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, '');
    assert.ok(Date.now() - startedAt < 1500, `session-end took ${Date.now() - startedAt} ms`);
    assert.deepEqual(listRecords(), ['sess-a.json']);
    assert.equal(fs.existsSync(path.join(env.globalDir, 'index.sqlite')), false, 'no database is opened');
    assert.match(startAfterClear(), /Goal of window A/);
  } finally {
    env.cleanup();
  }
});

test('/clear: the tab record still identifies the previous session exactly, and the installer registers SessionEnd', () => {
  const env = makeTempEnv('cortex-clear-tab-');
  try {
    const transcriptDir = path.join(env.root, 'claude-projects', 'C--work-project');
    const transcriptOf = (sessionId) => path.join(transcriptDir, `${sessionId}.jsonl`);
    writeJsonl(transcriptOf('tab-sess-1'), [human('Tab session goal'), assistant('Tab session reply')]);
    writeJsonl(transcriptOf('zz-newer-other'), [human('Other window text'), assistant('Other window reply')]);
    atomicWriteText(transcriptOf('tab-sess-2'), '');

    const options = env.hookOptions({ terminalId: 'tab-clear-1' });
    handleClaudeSessionStart({ session_id: 'tab-sess-1', source: 'startup', cwd: env.projectDir }, options);
    // The session was also recorded by SessionEnd: using the tab record consumes that record too
    handleClaudeSessionEnd(
      { session_id: 'tab-sess-1', transcript_path: transcriptOf('tab-sess-1'), cwd: env.projectDir, reason: 'clear' },
      { terminalId: 'tab-clear-1', globalDir: env.globalDir },
    );
    const ctx = contextOf(handleClaudeSessionStart(
      { session_id: 'tab-sess-2', source: 'clear', transcript_path: transcriptOf('tab-sess-2'), cwd: env.projectDir },
      options,
    ));
    assert.match(ctx, /Tab session goal/);
    assert.doesNotMatch(ctx, /Other window/);
    assert.equal(ctx.includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE), false);
    assert.deepEqual(fs.readdirSync(getClearRecordsDir(env.globalDir)), []);

    // Installer: SessionEnd is registered once with an explicit timeout above the 1.5 s default, idempotently
    const settingsPath = path.join(env.homeDir, '.claude', 'settings.json');
    atomicWriteJson(settingsPath, {
      hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user-own-session-end' }] }] },
    });
    installCortex({ repoRoot: env.root, homeDir: env.homeDir });
    installCortex({ repoRoot: env.root, homeDir: env.homeDir });
    const hooks = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    assert.equal(hooks.SessionEnd.length, 2);
    const ours = hooks.SessionEnd.filter((entry) => entry.hooks.some((h) => isOwnHook(h)));
    assert.equal(ours.length, 1);
    assert.deepEqual(ours[0], {
      matcher: '',
      hooks: [{
        type: 'command',
        command: process.execPath,
        args: ['--no-warnings', path.join(env.root, 'src', 'hooks', 'claude.mjs'), 'session-end', '--id', 'herdr-cortex'],
        timeout: CLAUDE_SESSION_END_TIMEOUT_SECONDS,
      }],
    });
    assert.ok(CLAUDE_SESSION_END_TIMEOUT_SECONDS >= 3);
    for (const event of ['SessionStart', 'PreCompact', 'UserPromptSubmit', 'PreToolUse']) {
      assert.equal(hooks[event].length, 1, event);
      assert.equal(hooks[event][0].hooks[0].timeout, 10, event);
    }
    uninstallCortex({ repoRoot: env.root, homeDir: env.homeDir });
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks;
    assert.deepEqual(after, { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user-own-session-end' }] }] });
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 3: only what the person typed counts as a turn
// ---------------------------------------------------------------------------------------------

test('recent turns: each kind of Claude Code record is classified by who typed it', () => {
  const env = makeTempEnv('cortex-turn-kinds-');
  try {
    const toMessage = CLAUDE_TRANSCRIPT_ADAPTER.toMessage;
    const reminder = '<system-reminder>\nInjected by the harness.\n</system-reminder>';

    // Marked records
    assert.deepEqual(toMessage(human('Typed by the person')), { role: 'user', text: 'Typed by the person', human: true });
    assert.equal(toMessage(user('<task-notification>\n<task-id>t1</task-id>\n</task-notification>', { origin: { kind: 'task-notification', producer: 'x', runId: 'r' } })).human, false);
    assert.equal(toMessage(user('Report from another agent', { origin: { kind: 'peer', from: 'worker' }, isMeta: true })).human, false);
    assert.equal(toMessage(user('Plain text injected by the system', { isMeta: true })).human, false);
    assert.equal(toMessage(user('Summary of the conversation so far', { isCompactSummary: true })).human, false);
    assert.equal(toMessage(user('Marked as meta although origin says human', { origin: { kind: 'human' }, isMeta: true })).human, false);
    assert.equal(toMessage(user('Future origin kind', { origin: { kind: 'something-new' } })).human, false);

    // Tool results are not what the person typed, except the answer to a question the agent asked
    assert.equal(toMessage(user([{ type: 'tool_result', tool_use_id: 't1', content: 'file contents, a user answered here once' }])), null);
    assert.deepEqual(
      toMessage(user([{ type: 'tool_result', tool_use_id: 't2', content: 'User has answered your questions: use WAL' }])),
      { role: 'user', text: 'User has answered your questions: use WAL', human: true },
    );

    // Embedded reminders are stripped from human messages
    assert.deepEqual(
      toMessage(user([{ type: 'text', text: reminder }, { type: 'text', text: 'Real question after a reminder block' }], { origin: { kind: 'human' } })),
      { role: 'user', text: 'Real question after a reminder block', human: true },
    );
    assert.deepEqual(
      toMessage(human(`Before ${reminder} after${reminder}`)),
      { role: 'user', text: 'Before  after', human: true },
    );
    assert.equal(toMessage(human(reminder)), null, 'nothing is left of a reminder-only record');
    assert.equal(stripSystemReminders(`a${reminder}b${reminder}c`), 'abc');
    assert.equal(stripSystemReminders('no tags here'), 'no tags here');
    assert.equal(stripSystemReminders('open <system-reminder> never closed'), 'open <system-reminder> never closed');
    assert.equal(stripSystemReminders(undefined), '');
    // one forward scan: a long run of opening tags is handled quickly
    const manyOpen = '<system-reminder>'.repeat(200_000);
    const scanStart = Date.now();
    assert.equal(stripSystemReminders(manyOpen), manyOpen);
    assert.equal(stripSystemReminders(`${manyOpen}</system-reminder>tail`), 'tail');
    assert.ok(Date.now() - scanStart < 2000, `strip took ${Date.now() - scanStart} ms`);

    // Records without origin / isMeta (older transcripts): judged by their text
    assert.deepEqual(toMessage(user('Old-format prompt')), { role: 'user', text: 'Old-format prompt', human: true });
    assert.equal(toMessage(user(reminder)), null);
    assert.deepEqual(toMessage(user(`${reminder}\nOld prompt after a reminder`)), { role: 'user', text: 'Old prompt after a reminder', human: true });
    assert.equal(toMessage(user('<task-notification>\n<status>completed</status>\n</task-notification>')).human, false);
    assert.equal(toMessage(user('<system-reminder> never closed')).human, false);
    assert.equal(toMessage(user('<bash-stdout>ok</bash-stdout>')).human, false);
    assert.equal(toMessage(user('<user-prompt-submit-hook>injected</user-prompt-submit-hook>')).human, false);
    for (const noise of ['<command-name>/status</command-name>', '<local-command-stdout>OK</local-command-stdout>', '<local-command-caveat>x</local-command-caveat>', '[Request interrupted by user]']) {
      assert.equal(toMessage(user(noise)), null, noise);
    }
    assert.equal(toMessage(user('Mentioning <task-notification> mid-sentence is fine')).human, true);

    // Prompts typed while the agent was busy: stored as a queued_command attachment with its own markers;
    // queue-operation records repeat text that is recorded again when it is delivered
    assert.deepEqual(
      toMessage({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'Typed while busy', origin: { kind: 'human' }, humanTurn: true } }),
      { role: 'user', text: 'Typed while busy', human: true },
    );
    assert.deepEqual(
      toMessage({ type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'Typed while busy, as blocks' }], origin: { kind: 'human' } } }),
      { role: 'user', text: 'Typed while busy, as blocks', human: true },
    );
    assert.equal(toMessage({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } } }).human, false);
    assert.equal(toMessage({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'peer report', origin: { kind: 'peer' }, isMeta: true } }).human, false);
    assert.equal(toMessage({ type: 'attachment', attachment: { type: 'environment', text: 'x' } }), null);
    assert.equal(toMessage({ type: 'queue-operation', operation: 'enqueue', content: 'Typed while busy' }), null);
    assert.equal(toMessage({ type: 'queue-operation', operation: 'dequeue' }), null);
    assert.deepEqual(toMessage({ type: 'queued_command', content: 'Legacy queued prompt' }), { role: 'user', text: 'Legacy queued prompt', human: true });

    // Assistant and other records
    assert.deepEqual(
      toMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }, { type: 'text', text: 'Visible reply' }] } }),
      { role: 'assistant', text: 'Visible reply', human: false },
    );
    assert.equal(toMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } }), null);
    for (const other of [null, 42, 'text', {}, { type: 'system', subtype: 'turn_duration' }, { type: 'file-history-snapshot' }, { type: 'last-prompt', lastPrompt: 'x' }]) {
      assert.equal(toMessage(other), null);
    }

    // The Antigravity adapter marks the user steps it already selected as human
    const agy = ANTIGRAVITY_TRANSCRIPT_ADAPTER.toMessage;
    assert.deepEqual(agy({ type: 'USER_INPUT', userInput: { userResponse: '<USER_REQUEST>Question</USER_REQUEST>' } }), { role: 'user', text: 'Question', human: true });
    assert.deepEqual(agy({ type: 'USER_EXPLICIT', text: 'Explicit request' }), { role: 'user', text: 'Explicit request', human: true });
    assert.deepEqual(agy({ type: 'PLANNER_RESPONSE', plannerResponse: { response: 'Answer' } }), { role: 'assistant', text: 'Answer', human: false });
    assert.equal(agy({ type: 'TOOL_CALL', text: 'ignored' }), null);
    assert.equal(agy({ type: 'CHECKPOINT', status: 'DONE', step_index: 3 }), null);
    assert.equal(ANTIGRAVITY_TRANSCRIPT_ADAPTER.boundaryKind({ type: 'CHECKPOINT' }), null);
    assert.equal(CLAUDE_TRANSCRIPT_ADAPTER.boundaryKind({ type: 'system', subtype: 'compact_boundary' }), 'compact');
    assert.equal(CLAUDE_TRANSCRIPT_ADAPTER.boundaryKind(user('<command-name>/clear</command-name>')), 'clear');

    // A third host plugs in as one more adapter; grouping and formatting stay shared
    const otherHostPath = path.join(env.root, 'other-host.jsonl');
    writeJsonl(otherHostPath, [
      { who: 'person', say: 'Other host question' },
      { who: 'tool', say: 'Tool chatter on the user side' },
      { who: 'model', say: 'Other host answer' },
    ]);
    const otherHost = extractRecentTurns(otherHostPath, {
      name: 'other-host',
      toMessage: (entry) => (entry.who === 'model'
        ? { role: 'assistant', text: entry.say, human: false }
        : { role: 'user', text: entry.say, human: entry.who === 'person' }),
    });
    assert.deepEqual(otherHost.turns, [{ user: 'Other host question', assistant: 'Other host answer' }]);
    assert.match(otherHost.text, /^## Recent Conversation Turns\n\n### Turn 1\n\*\*User:\*\* Other host question\n\*\*Assistant:\*\* Other host answer$/);
  } finally {
    env.cleanup();
  }
});

test('recent turns: notifications, reports and reminders do not push the real prompts out of the 5-turn window', () => {
  const env = makeTempEnv('cortex-turn-flood-');
  try {
    const items = [];
    const realPrompts = ['First real prompt', 'Second real prompt', 'Third real prompt'];
    for (const prompt of realPrompts) {
      // every prompt is first queued, then delivered as a user record
      items.push({ type: 'queue-operation', operation: 'enqueue', content: prompt });
      items.push({ type: 'queue-operation', operation: 'dequeue' });
      items.push(human(prompt));
      items.push(assistant(`Answer to: ${prompt}`));
      for (let i = 0; i < 4; i++) {
        items.push({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification>\n<task-id>bg-${i}</task-id>\n</task-notification>` });
        items.push(user(`<task-notification>\n<task-id>bg-${i}</task-id>\n<result>background job ${i} finished</result>\n</task-notification>`, { origin: { kind: 'task-notification' } }));
        items.push(assistant(`Noted background job ${i}.`));
        items.push(user(`Report ${i} from a worker agent`, { origin: { kind: 'peer', from: 'worker' }, isMeta: true }));
        items.push(user('<system-reminder>\nKeep going.\n</system-reminder>', { isMeta: true }));
        items.push(user([{ type: 'tool_result', tool_use_id: `t${i}`, content: `tool output ${i}` }]));
      }
    }
    const transcriptPath = path.join(env.root, 'flood.jsonl');
    writeJsonl(transcriptPath, items);

    const res = extractClaudeRecentTurns(transcriptPath, { maxTurns: 5, maxChars: 4500 });
    assert.deepEqual(res.turns.map((t) => t.user), realPrompts);
    assert.equal(res.restoreFailure, null);
    assert.equal((res.text.match(/\*\*User:\*\*/g) || []).length, 3);
    assert.doesNotMatch(res.text, /task-notification|task-id|Report \d from a worker|system-reminder|tool output/);
    // the assistant's replies between two prompts belong to the prompt before them
    assert.match(res.turns[0].assistant, /^Answer to: First real prompt\n\nNoted background job 0\./);
    assert.match(res.turns[2].assistant, /Noted background job 3\.$/);

    // The same through the hook, after a compaction
    const ctx = contextOf(handleClaudeSessionStart(
      { session_id: 'sess-flood', source: 'compact', transcript_path: transcriptPath, cwd: env.projectDir },
      env.hookOptions(),
    ));
    for (const prompt of realPrompts) assert.ok(ctx.includes(`**User:** ${prompt}`), prompt);
    assert.doesNotMatch(ctx, /task-notification|Report \d from a worker/);

    // An old-format transcript (no origin, no isMeta): the text patterns keep the notifications out
    const oldItems = [];
    for (const prompt of realPrompts) {
      oldItems.push(user(prompt));
      oldItems.push(assistant(`Answer to: ${prompt}`));
      for (let i = 0; i < 4; i++) {
        oldItems.push(user(`<task-notification>\n<result>old job ${i}</result>\n</task-notification>`));
        oldItems.push(user('<system-reminder>\nOld reminder.\n</system-reminder>'));
        oldItems.push(user([{ type: 'tool_result', tool_use_id: `o${i}`, content: `old tool output ${i}` }]));
      }
    }
    const oldPath = path.join(env.root, 'flood-old.jsonl');
    writeJsonl(oldPath, oldItems);
    const oldRes = extractClaudeRecentTurns(oldPath, { maxTurns: 5, maxChars: 4500 });
    assert.deepEqual(oldRes.turns.map((t) => t.user), realPrompts);
    assert.doesNotMatch(oldRes.text, /old job|Old reminder|old tool output/);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 4: a huge last transcript record does not wipe out turn restoration
// ---------------------------------------------------------------------------------------------

test('recent turns: the tail window grows past a huge last record, stops when enough turns are found, and reports when the cap is reached', () => {
  const env = makeTempEnv('cortex-turn-window-');
  const realReadSync = fs.readSync;
  try {
    const turns = [];
    for (let i = 1; i <= 6; i++) {
      turns.push(human(`Prompt number ${i}`));
      turns.push(assistant(`Reply number ${i}`));
    }
    const hugeRecord = user([{ type: 'tool_result', tool_use_id: 'big', content: 'x'.repeat(20_000) }]);
    const transcriptPath = path.join(env.root, 'huge-last.jsonl');
    writeJsonl(transcriptPath, [...turns, hugeRecord]);
    const fileSize = fs.statSync(transcriptPath).size;

    let bytesRead = 0;
    fs.readSync = (fd, buffer, offset, length, position) => {
      bytesRead += length;
      return realReadSync(fd, buffer, offset, length, position);
    };
    const read = (options) => {
      bytesRead = 0;
      return extractClaudeRecentTurns(transcriptPath, { maxTurns: 5, maxChars: 4500, ...options });
    };

    // The last record is larger than the first window: the window doubles until the turns before it are in reach
    const grown = read({ maxTailBytes: 1024, maxTailBytesCap: 1024 * 1024 });
    assert.equal(grown.restoreFailure, null);
    assert.deepEqual(grown.turns.map((t) => t.user), [2, 3, 4, 5, 6].map((i) => `Prompt number ${i}`));
    assert.match(grown.text, /Reply number 6/);
    assert.ok(bytesRead >= 20_000 && bytesRead <= fileSize, `read ${bytesRead} of ${fileSize}`);

    // Larger than the cap: nothing can be restored, and the result says why
    const capped = read({ maxTailBytes: 1024, maxTailBytesCap: 8192 });
    assert.deepEqual(capped.turns, []);
    assert.equal(capped.text, '');
    assert.equal(capped.restoreFailure, RESTORE_FAILURE_RECORD_TOO_LARGE);
    assert.ok(bytesRead <= 8192, `read ${bytesRead}`);

    // A record above the per-record limit is skipped without being parsed; the turns around it are restored
    const skipped = read({ maxTailBytes: 1024, maxTailBytesCap: 1024 * 1024, maxRecordBytes: 4096 });
    assert.equal(skipped.turns.length, 5);
    assert.equal(skipped.restoreFailure, null);
    const onlyHuge = path.join(env.root, 'only-huge.jsonl');
    writeJsonl(onlyHuge, [hugeRecord]);
    assert.equal(extractClaudeRecentTurns(onlyHuge, { maxRecordBytes: 4096 }).restoreFailure, RESTORE_FAILURE_RECORD_TOO_LARGE);
    assert.equal(extractClaudeRecentTurns(onlyHuge).restoreFailure, null, 'a readable transcript without turns is not a failure');

    // Growth stops as soon as five turns are in reach: a long transcript is not read to its start
    const longPath = path.join(env.root, 'long.jsonl');
    const many = [];
    for (let i = 1; i <= 400; i++) {
      many.push(human(`Long transcript prompt ${i}`));
      many.push(assistant(`Long transcript reply ${i} ${'pad '.repeat(40)}`));
    }
    writeJsonl(longPath, many);
    const longSize = fs.statSync(longPath).size;
    bytesRead = 0;
    const tail = extractClaudeRecentTurns(longPath, { maxTurns: 5, maxTailBytes: 512, maxTailBytesCap: 16 * 1024 * 1024 });
    assert.deepEqual(tail.turns.map((t) => t.user), [396, 397, 398, 399, 400].map((i) => `Long transcript prompt ${i}`));
    assert.ok(bytesRead < longSize / 10, `read ${bytesRead} of ${longSize}`);
    // ... and a compaction boundary inside the window ends the search as well
    const boundaryPath = path.join(env.root, 'boundary.jsonl');
    writeJsonl(boundaryPath, [...many, { type: 'system', subtype: 'compact_boundary' }, human('Only prompt after compaction'), assistant('Only reply after compaction')]);
    bytesRead = 0;
    const afterBoundary = extractClaudeRecentTurns(boundaryPath, { maxTurns: 5, maxTailBytes: 512, maxTailBytesCap: 16 * 1024 * 1024 });
    assert.deepEqual(afterBoundary.turns.map((t) => t.user), ['Only prompt after compaction']);
    assert.ok(bytesRead < longSize / 10, `read ${bytesRead} of ${longSize}`);
    fs.readSync = realReadSync;

    // Small windows and whole-file reads give the same turns
    const whole = extractClaudeRecentTurns(longPath, { maxTurns: 5, maxTailBytes: 0 });
    assert.deepEqual(tail.turns, whole.turns);
    for (const firstWindow of [64, 200, 333, 1024, 5000]) {
      const windowed = extractClaudeRecentTurns(longPath, { maxTurns: 5, maxTailBytes: firstWindow, maxTailBytesCap: 16 * 1024 * 1024 });
      assert.deepEqual(windowed.candidateTurns, whole.candidateTurns, `first window ${firstWindow}`);
    }

    // Antigravity transcripts go through the same reader
    const agyPath = path.join(env.root, 'transcript_full.jsonl');
    writeJsonl(agyPath, [
      { type: 'USER_INPUT', step_index: 1, userInput: { userResponse: 'Antigravity question' } },
      { type: 'PLANNER_RESPONSE', step_index: 2, plannerResponse: { response: 'Antigravity answer' } },
      { type: 'CHECKPOINT', step_index: 3, status: 'DONE', created_at: '2026-11-23T10:00:00Z' },
      { type: 'TOOL_RESULT', step_index: 4, text: 'y'.repeat(20_000) },
    ]);
    const agyGrown = extractAntigravityState(agyPath, { maxTailBytes: 1024, maxTailBytesCap: 1024 * 1024 });
    assert.deepEqual(agyGrown.turns, [{ user: 'Antigravity question', assistant: 'Antigravity answer' }]);
    assert.equal(agyGrown.latestCheckpoint.key, '3:2026-11-23T10:00:00Z');
    assert.equal(extractAntigravityState(agyPath, { maxTailBytes: 1024, maxTailBytesCap: 2048 }).restoreFailure, RESTORE_FAILURE_RECORD_TOO_LARGE);

    // The hook turns the flag into a one-line note instead of silently restoring nothing
    assert.equal(TURNS_NOT_RESTORED_TOO_LARGE_NOTE, '[herdr-cortex] Recent turns could not be restored: the last transcript record is too large.');
    const compactPayload = { session_id: 'sess-window', source: 'compact', transcript_path: transcriptPath, cwd: env.projectDir };
    const noted = contextOf(handleClaudeSessionStart(compactPayload, env.hookOptions({ turnOptions: { maxTailBytes: 1024, maxTailBytesCap: 8192 } })));
    assert.ok(noted.includes(TURNS_NOT_RESTORED_TOO_LARGE_NOTE));
    assert.doesNotMatch(noted, /Recent Conversation Turns/);
    const restored = contextOf(handleClaudeSessionStart(compactPayload, env.hookOptions({ turnOptions: { maxTailBytes: 1024, maxTailBytesCap: 1024 * 1024 } })));
    assert.match(restored, /Prompt number 6/);
    assert.equal(restored.includes(TURNS_NOT_RESTORED_TOO_LARGE_NOTE), false);
    // With the real defaults a 20 KB record is no problem at all
    assert.match(contextOf(handleClaudeSessionStart(compactPayload, env.hookOptions())), /Prompt number 6/);
  } finally {
    fs.readSync = realReadSync;
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 5: the pre-compaction instruction reaches the summarizer (plain stdout), with softened wording
// ---------------------------------------------------------------------------------------------

test('PreCompact: the hook process prints the instruction as plain text; nothing for subagents and excluded projects', () => {
  const env = makeTempEnv('cortex-precompact-');
  try {
    // Wording: one English paragraph, prefixed, softened
    assert.match(COMPACT_POINTER_INSTRUCTION, /^\[herdr-cortex\] /);
    assert.equal(COMPACT_POINTER_INSTRUCTION.includes('\n'), false);
    assert.match(COMPACT_POINTER_INSTRUCTION, /re-injected after compaction/);
    assert.match(COMPACT_POINTER_INSTRUCTION, /do not restate them at length/);
    assert.match(COMPACT_POINTER_INSTRUCTION, /Do keep in the summary the progress, findings and context from this conversation that have not been saved to memory/);
    assert.doesNotMatch(COMPACT_POINTER_INSTRUCTION, /do not write a long lossy summary/i);
    assert.doesNotMatch(COMPACT_POINTER_INSTRUCTION, /Compaction pointer/i);
    assert.ok(COMPACT_POINTER_INSTRUCTION.length < 400);

    const run = (payload, cwd = env.projectDir) => spawnSync(
      process.execPath,
      ['--no-warnings', path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs'), 'pre-compact', '--id', 'herdr-cortex'],
      { input: JSON.stringify(payload), encoding: 'utf8', cwd, env: childEnv(env), timeout: 30000 },
    );
    const base = { session_id: 's1', transcript_path: path.join(env.root, 't.jsonl'), cwd: env.projectDir, hook_event_name: 'PreCompact' };

    // Exactly the text: no JSON, no systemMessage / continue fields
    const auto = run({ ...base, trigger: 'auto', custom_instructions: '' });
    assert.equal(auto.status, 0, auto.stderr);
    assert.equal(auto.stdout, `${COMPACT_POINTER_INSTRUCTION}\n`);
    assert.throws(() => JSON.parse(auto.stdout));
    assert.doesNotMatch(auto.stdout, /systemMessage|"continue"/);
    assert.equal(run({ ...base, trigger: 'manual', custom_instructions: null }).stdout, `${COMPACT_POINTER_INSTRUCTION}\n`);

    // The user's own instructions take precedence
    const custom = run({ ...base, trigger: 'manual', custom_instructions: 'Keep every file path that was mentioned.' });
    assert.equal(custom.stdout, `${COMPACT_POINTER_INSTRUCTION}${COMPACT_USER_INSTRUCTIONS_CLAUSE}\n`);
    assert.match(custom.stdout, /The user's own compaction instructions take precedence over this note\.\n$/);
    assert.equal(custom.stdout.trimEnd().includes('\n'), false);
    assert.deepEqual(
      handleClaudePreCompact({ ...base, custom_instructions: 'x' }, { globalDir: env.globalDir }),
      { instructions: `${COMPACT_POINTER_INSTRUCTION}${COMPACT_USER_INSTRUCTIONS_CLAUSE}` },
    );
    assert.deepEqual(
      handleClaudePreCompact({ ...base, custom_instructions: '   ' }, { globalDir: env.globalDir }),
      { instructions: COMPACT_POINTER_INSTRUCTION },
    );

    // Subagents, excluded and disabled projects: nothing at all is printed
    const sub = run({ ...base, agent_id: 'sub-1', agent_type: 'general-purpose' });
    assert.equal(sub.status, 0);
    assert.equal(sub.stdout, '');
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { excludedProjects: [env.projectDir] });
    assert.equal(run(base).stdout, '');
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { enabled: false });
    assert.equal(run(base).stdout, '');
    fs.unlinkSync(path.join(env.globalDir, 'config.json'));

    // What the process prints per event
    assert.equal(renderClaudeHookStdout('pre-compact', {}), '');
    assert.equal(renderClaudeHookStdout('PRE-COMPACT', { instructions: 'abc' }), 'abc\n');
    assert.equal(renderClaudeHookStdout('session-end', { anything: 1 }), '');
    assert.equal(renderClaudeHookStdout('pre-tool-use', {}), '');
    assert.equal(renderClaudeHookStdout('user-prompt', { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } }), '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit"}}\n');
    assert.deepEqual(runClaudeHook('pre-compact', base, { globalDir: env.globalDir }), { instructions: COMPACT_POINTER_INSTRUCTION });

    // Antigravity /compact carries the same instruction; arguments are the user's own instructions
    const agyOptions = env.hookOptions({ terminalId: 'tab-agy-compact' });
    const agyPayload = { conversationId: 'conv-c', rootConversationId: 'conv-c', cwd: env.projectDir };
    handleAntigravitySessionStart(agyPayload, agyOptions);
    const plain = handleAntigravityPreInvocation({ ...agyPayload, lastUserInput: '/compact' }, agyOptions);
    assert.deepEqual(plain.injectSteps.map((s) => s.systemMessage.systemMessage), [COMPACT_POINTER_INSTRUCTION]);
    const withArgs = handleAntigravityPreInvocation({ ...agyPayload, lastUserInput: '/compact keep the test names' }, agyOptions);
    assert.deepEqual(
      withArgs.injectSteps.map((s) => s.systemMessage.systemMessage),
      [`${COMPACT_POINTER_INSTRUCTION}${COMPACT_USER_INSTRUCTIONS_CLAUSE}`],
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 6: the Antigravity hook has the same injection cap as the Claude hook
// ---------------------------------------------------------------------------------------------

test('hook budget: a configured hookBudget of 1,000,000 is capped at 9,000 characters in the Antigravity hooks too', () => {
  const env = makeTempEnv('cortex-agy-cap-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    assert.equal(HOOK_MAX_CHARS, 9000);
    assert.equal(CLAUDE_HOOK_MAX_CHARS, HOOK_MAX_CHARS);
    assert.equal(resolveHookBudget({ hookBudget: 1_000_000 }), 9000);
    assert.equal(resolveHookBudget({ hookBudget: 7000 }), 7000);
    assert.equal(resolveHookBudget({ hookBudget: 10 }), 256);
    assert.equal(resolveHookBudget({}), 9000);
    assert.equal(resolveHookBudget(undefined), 9000);

    for (let i = 0; i < 24; i++) {
      store.saveDoc({
        id: `dec-cap-${String(i).padStart(2, '0')}`,
        type: 'decision',
        title: `Budget cap decision ${i}`,
        summary: `Every line of this summary has to be counted against the injection budget. `.repeat(10),
        session: 'cap-session',
      });
    }
    store.close();
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { hookBudget: 1_000_000 });

    // SessionStart
    const start = handleAntigravitySessionStart(
      { conversationId: 'conv-cap-1', rootConversationId: 'conv-cap-1', cwd: env.projectDir },
      env.hookOptions({ terminalId: 'tab-cap-1' }),
    );
    assert.match(agyText(start), /Budget cap decision/);
    const startTotal = start.injectSteps.reduce((n, s) => n + s.systemMessage.systemMessage.length, 0);
    assert.ok(startTotal <= HOOK_MAX_CHARS, `SessionStart injected ${startTotal} characters`);

    // First PreInvocation (deferred startup injection)
    const transcript = path.join(env.root, 'agy-cap.jsonl');
    const steps = [];
    for (let i = 0; i < 6; i++) {
      steps.push({ type: 'USER_INPUT', step_index: i * 2, userInput: { userResponse: `Question ${i} ${'q '.repeat(400)}` } });
      steps.push({ type: 'PLANNER_RESPONSE', step_index: i * 2 + 1, plannerResponse: { response: `Answer ${i} ${'a '.repeat(800)}` } });
    }
    writeJsonl(transcript, steps);
    const firstPre = handleAntigravityPreInvocation(
      { conversationId: 'conv-cap-2', transcriptPath: transcript, cwd: env.projectDir, lastUserInput: 'Go on' },
      env.hookOptions({ terminalId: 'tab-cap-2' }),
    );
    assert.match(agyText(firstPre), /Budget cap decision/);
    const firstTotal = firstPre.injectSteps.reduce((n, s) => n + s.systemMessage.systemMessage.length, 0);
    assert.ok(firstTotal <= HOOK_MAX_CHARS, `first PreInvocation injected ${firstTotal} characters`);

    // Checkpoint restore (HEAD_CORE + overview + recent turns)
    writeJsonl(transcript, [...steps, { type: 'CHECKPOINT', step_index: 99, status: 'DONE', created_at: '2026-11-23T12:00:00Z' }]);
    const restore = handleAntigravityPreInvocation(
      { conversationId: 'conv-cap-2', transcriptPath: transcript, cwd: env.projectDir, lastUserInput: 'Continue' },
      env.hookOptions({ terminalId: 'tab-cap-2' }),
    );
    assert.match(agyText(restore), /Recent Conversation Turns/);
    assert.match(agyText(restore), /Budget cap decision/);
    const restoreTotal = restore.injectSteps.reduce((n, s) => n + s.systemMessage.systemMessage.length, 0);
    assert.ok(restoreTotal <= HOOK_MAX_CHARS, `checkpoint restore injected ${restoreTotal} characters`);

    // The Claude hook is unchanged
    const claude = contextOf(handleClaudeSessionStart({ session_id: 'sess-cap', cwd: env.projectDir }, env.hookOptions()));
    assert.ok(claude.length <= HOOK_MAX_CHARS);
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 7: an agent cannot approve projects for itself without the user seeing it
// ---------------------------------------------------------------------------------------------

test('PreToolUse: running the approval CLI or naming the approvals file asks the user (denied for subagents); read-only calls and look-alikes pass', () => {
  const env = makeTempEnv('cortex-trust-guard-shell-');
  try {
    const subagent = { agent_id: 'sub-9', agent_type: 'general-purpose' };
    const run = (tool, command, who = {}) => handleClaudePreToolUse(
      { tool_name: tool, tool_input: { command }, cwd: env.projectDir, ...who },
      { globalDir: env.globalDir },
    );
    const approvalsFile = path.join(env.globalDir, 'state', 'trusted-projects.json');

    const changing = [
      'cortex-trust approve',
      'cortex-trust approve "C:\\work\\some project"',
      'cortex-trust revoke .',
      'cortex-trust',
      'cortex-trust --help',
      'CORTEX-TRUST approve',
      'cortex-trust.ps1 approve',
      '& "C:\\tools\\cortex-trust.ps1" approve',
      'C:\\tools\\cortex-trust.cmd approve .',
      'powershell -NoProfile -Command "cortex-trust approve"',
      'bash -lc \'cortex-trust approve\'',
      'cd other && cortex-trust approve',
      'cortex-trust status; cortex-trust approve',
      'cortex-trust status && cortex-trust approve',
      'cortex-trust status | tee out.txt',
      'cortex-trust status > out.txt',
      'cortex-trust status $(cortex-trust approve)',
      'cortex-trust --global D:\\elsewhere status',
      'cortex-trust status\ncortex-trust approve',
      'node src/core/trust-cli.mjs approve',
      'node --no-warnings "C:\\Users\\me\\herdr-cortex\\src\\core\\trust-cli.mjs" revoke D:\\proj',
      './src/core/trust-cli.mjs approve',
      'npm run trust -- approve',
      'npm run trust',
      'npm --prefix C:\\repos\\herdr-cortex run trust -- approve .',
      'npm.cmd run-script trust -- revoke',
      `type "${approvalsFile}"`,
      'cat ~/.herdr-cortex/state/trusted-projects.json',
      'echo {} > ~/.herdr-cortex/state/trusted-projects.json',
      'Set-Content -Path $HOME\\.herdr-cortex\\state\\trusted-projects.json -Value "{}"',
      'python -c "open(\'trusted-projects.json\',\'w\').write(\'{}\')"',
      'cp trusted-projects.json.bak trusted-projects.json',
      'cat TRUSTED-PROJECTS.JSON',
    ];
    const readOnly = [
      'cortex-trust status',
      'cortex-trust list',
      'cortex-trust list --json',
      'cortex-trust --json status',
      'cortex-trust status "C:\\work\\some project"',
      'cortex-trust.ps1 status',
      'node src/core/trust-cli.mjs status',
      'node --no-warnings src/core/trust-cli.mjs list --json',
      'npm run trust -- status',
      'npm run trust -- list',
    ];
    const unrelated = [
      'ls',
      'cat trustworthy.txt',
      'npm run trustworthy',
      'npm run test',
      'npm test',
      'npm run build && echo trust',
      'echo cortex-trusted',
      'cat docs/cortex-trust.md',
      'ls cortex-trust-notes/',
      'cat my-trust-cli.mjs',
      'node trust-cli.mjs.bak',
      'ls untrusted-projects.json',
      'cat trusted-projects.jsonl',
      'cat my-trusted-projects.json',
      'cat x.trusted-projects.json',
      'grep -r "trust" src/',
      'git commit -m "trust the cli"',
      'cat herdr-cortex-trust-design.txt',
      '',
    ];

    for (const tool of ['Bash', 'PowerShell']) {
      for (const command of changing) {
        assert.equal(classifyTrustCommand(command), 'change', command);
        const asked = run(tool, command);
        assert.equal(asked.hookSpecificOutput?.hookEventName, 'PreToolUse', command);
        assert.equal(asked.hookSpecificOutput.permissionDecision, 'ask', `${tool}: ${command}`);
        assert.equal(asked.hookSpecificOutput.permissionDecisionReason, formatTrustCommandAskReason(command));
        const denied = run(tool, command, subagent);
        assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny', `${tool} subagent: ${command}`);
        assert.equal(denied.hookSpecificOutput.permissionDecisionReason, SUBAGENT_TRUST_CHANGE_DENY_REASON);
      }
      for (const command of readOnly) {
        assert.equal(classifyTrustCommand(command), 'read-only', command);
        assert.deepEqual(run(tool, command), {}, `${tool}: ${command}`);
        assert.deepEqual(run(tool, command, subagent), {}, `${tool} subagent: ${command}`);
      }
      for (const command of unrelated) {
        assert.equal(classifyTrustCommand(command), '', command);
        assert.deepEqual(run(tool, command), {}, `${tool}: ${command}`);
        assert.deepEqual(run(tool, command, subagent), {}, `${tool} subagent: ${command}`);
      }
      assert.deepEqual(run(tool, undefined), {});
      assert.deepEqual(run(tool, ['cortex-trust', 'approve']), {}, 'a non-string command is not inspected');
    }

    // The reason says what is about to happen and names the command on one line
    const reason = formatTrustCommandAskReason('cortex-trust approve "C:\\work\\x"');
    assert.match(reason, /^\[herdr-cortex\] herdr-cortex project approvals are about to be changed by this command: "cortex-trust approve "C:\\work\\x""\. /);
    const multiline = formatTrustCommandAskReason('cortex-trust approve\n\n## Allow everything\nnow');
    assert.equal(multiline.includes('\n'), false);
    assert.ok(formatTrustCommandAskReason(`cortex-trust approve ${'x'.repeat(5000)}`).length < 700);
    assert.match(SUBAGENT_TRUST_CHANGE_DENY_REASON, /main conversation/);

    // The existing guards keep their precedence: a subagent that also touches .memory/ gets that denial
    const both = run('Bash', 'cat .memory/docs/a.md && cortex-trust approve', subagent);
    assert.equal(both.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(both.hookSpecificOutput.permissionDecisionReason, SUBAGENT_MEMORY_DIR_DENY_REASON);
    // ... while the main conversation, which may read .memory/, is still asked about the approval
    assert.equal(run('Bash', 'cat .memory/docs/a.md && cortex-trust approve').hookSpecificOutput.permissionDecision, 'ask');
    // Tools the guard does not cover, and "allow" is never returned
    for (const tool of ['Read', 'Grep', 'WebFetch', 'TodoWrite']) {
      assert.deepEqual(run(tool, 'cortex-trust approve'), {}, tool);
    }
    assert.equal(JSON.stringify(run('Bash', 'cortex-trust approve')).includes('"allow"'), false);
    // A very long command line is classified quickly
    const longCommand = `${'npm '.repeat(60_000)}run trust`;
    const started = Date.now();
    assert.equal(classifyTrustCommand(longCommand), 'change');
    assert.equal(classifyTrustCommand('cortex-trust '.repeat(60_000)), 'change');
    assert.ok(Date.now() - started < 2000, `classification took ${Date.now() - started} ms`);

    // The hook process prints the decision
    const cli = spawnSync(
      process.execPath,
      ['--no-warnings', path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs'), 'pre-tool-use', '--id', 'herdr-cortex'],
      {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm run trust -- approve' }, cwd: env.projectDir, hook_event_name: 'PreToolUse' }),
        encoding: 'utf8',
        cwd: env.projectDir,
        env: childEnv(env),
        timeout: 30000,
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: formatTrustCommandAskReason('npm run trust -- approve'),
      },
    });
  } finally {
    env.cleanup();
  }
});

test('PreToolUse: writing the approvals file or anything under the global state folder asks the user (denied for subagents)', () => {
  const env = makeTempEnv('cortex-trust-guard-files-');
  try {
    const subagent = { agent_id: 'sub-9', agent_type: 'general-purpose' };
    const stateDir = path.join(env.globalDir, 'state');
    const approvalsFile = path.join(stateDir, 'trusted-projects.json');
    assert.equal(fs.existsSync(approvalsFile), true, 'premise: the approval list exists (makeTempEnv approved the project)');
    const globalAlias = path.join(env.root, 'global-alias');
    fs.symlinkSync(env.globalDir, globalAlias, 'junction');
    const run = (tool, target, who = {}, cwd = env.projectDir) => handleClaudePreToolUse(
      { tool_name: tool, tool_input: { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: target, content: '{}' }, cwd, ...who },
      { globalDir: env.globalDir },
    );

    const approvalsSpellings = [
      approvalsFile,
      approvalsFile.replace(/\\/g, '/'),
      path.join(globalAlias, 'state', 'trusted-projects.json'),
      path.relative(env.projectDir, approvalsFile),
      path.join(stateDir, 'inbox', '..', 'trusted-projects.json'),
    ];
    if (process.platform === 'win32') {
      approvalsSpellings.push(approvalsFile.toUpperCase(), `${approvalsFile}.`, path.join(env.globalDir, 'STATE.', 'trusted-projects.json'));
    }
    const otherStateFiles = [
      path.join(stateDir, 'trusted-projects.json.bak'),
      path.join(stateDir, 'cleared-sessions', 'sess-a.json'),
      path.join(stateDir, 'inbox', 'tab-1', 'msg.json'),
      path.join(stateDir, 'deferred-index.json'),
      path.join(globalAlias, 'state', 'new-file.json'),
    ];
    const elsewhere = [
      path.join(env.globalDir, 'config.json'),
      path.join(env.globalDir, 'docs', 'knowledge', 'note.md'),
      path.join(env.globalDir, 'state-notes.txt'),
      path.join(env.globalDir, 'statement', 'x.json'),
      path.join(env.projectDir, 'trusted-projects.json'),
      path.join(env.projectDir, 'state', 'trusted-projects.json'),
      path.join(env.projectDir, 'src', 'index.mjs'),
      'README.md',
    ];

    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      for (const target of approvalsSpellings) {
        const asked = run(tool, target);
        assert.equal(asked.hookSpecificOutput?.permissionDecision, 'ask', `${tool}: ${target}`);
        assert.match(asked.hookSpecificOutput.permissionDecisionReason, /project approvals are about to be changed: this call writes the approvals file "/);
        assert.equal(asked.hookSpecificOutput.permissionDecisionReason, formatStateFileWriteAskReason(path.resolve(env.projectDir, target), { approvalsFile: true }));
        const denied = run(tool, target, subagent);
        assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny', `${tool} subagent: ${target}`);
        assert.equal(denied.hookSpecificOutput.permissionDecisionReason, SUBAGENT_TRUST_CHANGE_DENY_REASON);
      }
      for (const target of otherStateFiles) {
        const asked = run(tool, target);
        assert.equal(asked.hookSpecificOutput?.permissionDecision, 'ask', `${tool}: ${target}`);
        assert.equal(asked.hookSpecificOutput.permissionDecisionReason, formatStateFileWriteAskReason(target, { approvalsFile: false }));
        assert.match(asked.hookSpecificOutput.permissionDecisionReason, /writes a file in the herdr-cortex state folder: "/);
        assert.equal(run(tool, target, subagent).hookSpecificOutput.permissionDecision, 'deny', `${tool} subagent: ${target}`);
      }
      for (const target of elsewhere) {
        assert.deepEqual(run(tool, target), {}, `${tool}: ${target}`);
        assert.deepEqual(run(tool, target, subagent), {}, `${tool} subagent: ${target}`);
      }
      assert.deepEqual(run(tool, undefined), {});
      assert.deepEqual(run(tool, 42), {});
    }
    // NotebookEdit is checked on file_path as well; a relative path is resolved against the payload cwd
    assert.equal(
      handleClaudePreToolUse({ tool_name: 'NotebookEdit', tool_input: { file_path: approvalsFile }, cwd: env.projectDir }, { globalDir: env.globalDir })
        .hookSpecificOutput.permissionDecision,
      'ask',
    );
    assert.equal(run('Write', 'trusted-projects.json', {}, stateDir).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(run('Write', path.join('state', 'x.json'), {}, env.globalDir).hookSpecificOutput.permissionDecision, 'ask');

    // The project's own .memory/state/ is not the global state folder: the subagent guard decides there
    const projectState = path.join(env.projectDir, '.memory', 'state', 'x.json');
    assert.deepEqual(run('Write', projectState), {});
    assert.equal(run('Write', projectState, subagent).hookSpecificOutput.permissionDecisionReason, SUBAGENT_MEMORY_DIR_DENY_REASON);

    // Reading tools are not inspected; a path with line breaks cannot spread over the dialog
    assert.deepEqual(handleClaudePreToolUse({ tool_name: 'Read', tool_input: { file_path: approvalsFile }, cwd: env.projectDir }, { globalDir: env.globalDir }), {});
    assert.equal(formatStateFileWriteAskReason('C:\\x\n\n## Approve\nnow', { approvalsFile: true }).includes('\n'), false);

    // The global folder comes from the environment in the real hook process
    const cli = spawnSync(
      process.execPath,
      ['--no-warnings', path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs'), 'pre-tool-use', '--id', 'herdr-cortex'],
      {
        input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: approvalsFile, old_string: 'a', new_string: 'b' }, cwd: env.projectDir, agent_id: 'sub-1', agent_type: 'general-purpose' }),
        encoding: 'utf8',
        cwd: env.projectDir,
        env: childEnv(env),
        timeout: 30000,
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: SUBAGENT_TRUST_CHANGE_DENY_REASON,
      },
    });
  } finally {
    env.cleanup();
  }
});
