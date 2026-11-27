import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT, atomicWriteJson, atomicWriteText } from '../src/core/config.mjs';
import { ROLE_ENV_VAR, WORKER_ROLE, isWorkerSession } from '../src/core/role.mjs';
import { serializeMarkdownDoc } from '../src/core/frontmatter.mjs';
import { CortexStore } from '../src/core/store.mjs';
import { readSavedSession, recordSession } from '../src/revive/tracker.mjs';
import { countInboxMessages, enqueueMessage, peekInbox } from '../src/relay/inbox.mjs';
import { createHcClient } from '../src/relay/hc.mjs';
import {
  getClearRecordsDir,
  handleClaudeSessionEnd,
  handleClaudeSessionStart,
  handleClaudeUserPrompt,
} from '../src/hooks/claude.mjs';
import {
  handleAntigravityPreInvocation,
  handleAntigravitySessionStart,
} from '../src/hooks/antigravity.mjs';
import { createMcpServer } from '../src/mcp/server.mjs';
import { approveAsUser } from './support/approve.mjs';

const FAKE_HC_BIN = path.join(os.tmpdir(), 'herdr-cortex-worker-role-bin', 'hc.exe');

function makeTempEnv(prefix = 'herdr-cortex-worker-role-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const unapprovedDir = path.join(root, 'unapproved-project');
  const homeDir = path.join(root, 'home');
  const globalDir = path.join(homeDir, '.herdr-cortex');
  const promptsDir = path.join(root, 'prompts');

  for (const dir of [projectDir, unapprovedDir, homeDir, globalDir, promptsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  approveAsUser(projectDir, { globalDir });

  atomicWriteText(
    path.join(promptsDir, 'HEAD_CORE.md'),
    '# HEAD_CORE\n\n- Stay at low/mid resolution; delegate high-resolution implementation.\n',
  );

  // Seed unapproved project with a .memory/ folder so notApprovedNotice triggers
  fs.mkdirSync(path.join(unapprovedDir, '.memory', 'docs'), { recursive: true });

  return {
    root,
    projectDir,
    unapprovedDir,
    homeDir,
    globalDir,
    promptsDir,
    memoryDir: path.join(projectDir, '.memory'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeDoc(tierDir, id, frontmatter = {}, body = 'body') {
  const filePath = path.join(tierDir, 'docs', '2026-11', `${id}.md`);
  atomicWriteText(
    filePath,
    serializeMarkdownDoc(
      {
        id,
        type: 'decision',
        title: `Title of ${id}`,
        summary: `Summary of ${id}`,
        status: 'active',
        ...frontmatter,
      },
      body,
    ),
  );
  return filePath;
}

function writeJsonl(filePath, items) {
  const content = `${items.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n')}\n`;
  atomicWriteText(filePath, content);
}

function makeFakeHc(projectDir) {
  return createHcClient({
    hcBin: FAKE_HC_BIN,
    execFileSync(_bin, args) {
      if (args[0] === 'ls') {
        return JSON.stringify({
          terminals: [{ address: 't1', agent: 'claude-code', cwd: projectDir, state: 'live', status: 'idle', turn: 1, where: 'w/1' }],
        });
      }
      if (args[0] === 'get') {
        return JSON.stringify({
          address: args[1],
          cwd: projectDir,
          foreground: { argv: ['claude'], cwd: projectDir, name: 'claude.exe', pid: 100 },
          state: 'live',
          status: { app: 'claude-code', state: 'idle' },
        });
      }
      if (args[0] === 'send') return '';
      throw new Error(`Unexpected hc call: ${args.join(' ')}`);
    },
  });
}

test('core/role: isWorkerSession trims whitespace, ignores case, and treats missing or other values as non-worker', () => {
  assert.equal(ROLE_ENV_VAR, 'HERDR_CORTEX_ROLE');
  assert.equal(WORKER_ROLE, 'worker');

  assert.equal(isWorkerSession({ env: { HERDR_CORTEX_ROLE: 'worker' } }), true);
  assert.equal(isWorkerSession({ env: { HERDR_CORTEX_ROLE: 'WORKER' } }), true);
  assert.equal(isWorkerSession({ env: { HERDR_CORTEX_ROLE: '  \tWoRkEr\r\n ' } }), true);

  assert.equal(isWorkerSession({ env: {} }), false);
  assert.equal(isWorkerSession({ env: null }), false);
  assert.equal(isWorkerSession({ env: { HERDR_CORTEX_ROLE: '' } }), false);
  assert.equal(isWorkerSession({ env: { HERDR_CORTEX_ROLE: '   ' } }), false);
  assert.equal(isWorkerSession({ env: { HERDR_CORTEX_ROLE: 'head' } }), false);
  assert.equal(isWorkerSession({ env: { HERDR_CORTEX_ROLE: 'subagent' } }), false);
  assert.equal(isWorkerSession({ env: { HERDR_CORTEX_ROLE: 123 } }), false);
});

test('hooks/claude: worker session preserves tab session/inbox/clear-records and omits HEAD_CORE + recent turns while keeping overview and notices', () => {
  const env = makeTempEnv('cortex-worker-claude-');
  try {
    writeDoc(env.memoryDir, 'dec-keep', { title: 'Worker visible decision' });
    writeDoc(env.memoryDir, 'dec-deferred', { title: 'Deferred large doc' }, 'x'.repeat(30_000));
    const indexBudget = { maxFileBytes: 10_000 };

    // Parent HEAD tab already has saved session and a pending relay message
    recordSession({
      terminalId: 'tab-head',
      agent: 'claude',
      payload: { session_id: 'head-sess-1', cwd: env.projectDir },
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
    });
    enqueueMessage(
      'tab-head',
      { id: 'msg-for-head', from_terminal_id: 'tab-peer', message: 'Secret relay message for HEAD only' },
      { globalDir: env.globalDir },
    );

    const transcriptPath = path.join(env.root, 'claude-worker.jsonl');
    writeJsonl(transcriptPath, [
      { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Prior human turn' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Prior assistant reply' }] } },
      { type: 'system', subtype: 'compact_boundary' },
    ]);

    const workerEnv = { HERDR_CORTEX_ROLE: '  Worker  ', HC_TERMINAL_ID: 'tab-head' };
    const baseOpts = {
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
      promptsDir: env.promptsDir,
      indexBudget,
      clearRecordWaitMs: 0,
    };

    // 1. SessionStart (compact) in worker session: no HEAD_CORE, no recent turns, no inbox drain, no session overwrite
    const startWorker = handleClaudeSessionStart(
      { session_id: 'worker-sess-99', source: 'compact', transcript_path: transcriptPath, cwd: env.projectDir },
      { ...baseOpts, env: workerEnv },
    );
    const workerCtx = startWorker.hookSpecificOutput?.additionalContext || '';
    assert.doesNotMatch(workerCtx, /# HEAD_CORE/);
    assert.doesNotMatch(workerCtx, /Recent Conversation Turns/);
    assert.doesNotMatch(workerCtx, /Prior human turn/);
    assert.doesNotMatch(workerCtx, /Secret relay message for HEAD only/);
    assert.match(workerCtx, /Cortex Memory Overview/);
    assert.match(workerCtx, /Worker visible decision/);
    assert.match(workerCtx, /Memory may be incomplete: 1 document is not indexed yet/);

    // part="core" returns empty object in worker session
    assert.deepEqual(
      handleClaudeSessionStart(
        { session_id: 'worker-sess-99', source: 'startup', cwd: env.projectDir },
        { ...baseOpts, part: 'core', env: workerEnv },
      ),
      {},
    );

    // Unapproved folder notice is still injected in worker session
    const unapprovedOut = handleClaudeSessionStart(
      { session_id: 'worker-sess-unapproved', source: 'startup', cwd: env.unapprovedDir },
      { ...baseOpts, env: workerEnv },
    );
    assert.match(unapprovedOut.hookSpecificOutput?.additionalContext || '', /Project memory was not loaded/);
    assert.match(unapprovedOut.systemMessage || '', /Project memory was not loaded/);

    // SessionEnd(clear) and SessionStart(clear) in worker session touch neither cleared-sessions nor turns note
    handleClaudeSessionEnd(
      { session_id: 'worker-sess-99', reason: 'clear', transcript_path: transcriptPath, cwd: env.projectDir },
      { globalDir: env.globalDir, env: workerEnv },
    );
    assert.equal(fs.existsSync(getClearRecordsDir(env.globalDir)), false);

    const emptyTranscript = path.join(env.root, 'empty-after-clear.jsonl');
    writeJsonl(emptyTranscript, []);
    const clearWorker = handleClaudeSessionStart(
      { session_id: 'worker-sess-100', source: 'clear', transcript_path: emptyTranscript, cwd: env.projectDir },
      { ...baseOpts, env: workerEnv },
    );
    assert.doesNotMatch(clearWorker.hookSpecificOutput?.additionalContext || '', /Recent turns were not restored/);

    // UserPromptSubmit in worker session does NOT drain HEAD's relay inbox
    const promptWorker = handleClaudeUserPrompt(
      { session_id: 'worker-sess-99', cwd: env.projectDir },
      { globalDir: env.globalDir, env: workerEnv },
    );
    assert.equal(promptWorker.hookSpecificOutput, undefined);

    // Verify parent HEAD tab's session and inbox are completely intact
    assert.equal(readSavedSession('tab-head', { globalDir: env.globalDir }).sessionId, 'head-sess-1');
    assert.deepEqual(countInboxMessages('tab-head', { globalDir: env.globalDir }), { pending: 1, held: 0, broken: 0 });
    assert.equal(peekInbox('tab-head', { globalDir: env.globalDir }).messages[0].announced, false);

    // 2. Without HERDR_CORTEX_ROLE=worker, normal HEAD behavior runs in full
    const normalEnv = { HC_TERMINAL_ID: 'tab-head' };
    const startHead = handleClaudeSessionStart(
      { session_id: 'head-sess-2', source: 'compact', transcript_path: transcriptPath, cwd: env.projectDir },
      { ...baseOpts, env: normalEnv },
    );
    const headCtx = startHead.hookSpecificOutput?.additionalContext || '';
    assert.match(headCtx, /# HEAD_CORE/);
    assert.match(headCtx, /Cortex Memory Overview/);
    assert.match(headCtx, /Recent Conversation Turns/);
    assert.match(headCtx, /Prior human turn/);
    assert.match(headCtx, /Secret relay message for HEAD only/);
    assert.equal(readSavedSession('tab-head', { globalDir: env.globalDir }).sessionId, 'head-sess-2');
    assert.deepEqual(countInboxMessages('tab-head', { globalDir: env.globalDir }), { pending: 0, held: 1, broken: 0 });

    handleClaudeSessionEnd(
      { session_id: 'head-sess-2', reason: 'clear', transcript_path: transcriptPath, cwd: env.projectDir },
      { globalDir: env.globalDir, env: normalEnv },
    );
    assert.equal(fs.existsSync(path.join(getClearRecordsDir(env.globalDir), 'head-sess-2.json')), true);
  } finally {
    env.cleanup();
  }
});

test('hooks/antigravity: worker session preserves tab session/inbox and omits HEAD_CORE + checkpoint turns while keeping overview and notices', () => {
  const env = makeTempEnv('cortex-worker-agy-');
  try {
    writeDoc(env.memoryDir, 'dec-agy', { title: 'Antigravity worker decision' });
    writeDoc(env.memoryDir, 'dec-agy-big', { title: 'Big unindexed doc' }, 'y'.repeat(30_000));
    const indexBudget = { maxFileBytes: 10_000 };

    recordSession({
      terminalId: 'tab-agy',
      agent: 'antigravity',
      payload: { conversationId: 'head-conv-1', rootConversationId: 'head-conv-1', cwd: env.projectDir },
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
    });
    enqueueMessage(
      'tab-agy',
      { id: 'msg-agy-head', from_terminal_id: 'tab-peer', message: 'Relay message meant for Antigravity HEAD' },
      { globalDir: env.globalDir },
    );

    const agyTranscript = path.join(env.root, 'agy-worker-transcript.jsonl');
    writeJsonl(agyTranscript, [
      { type: 'USER_INPUT', userInput: { userResponse: '<USER_REQUEST>Earlier user question</USER_REQUEST>' } },
      { type: 'PLANNER_RESPONSE', plannerResponse: { response: 'Earlier planner answer' } },
      { type: 'CHECKPOINT', status: 'DONE', stepIndex: 3, timestamp: '2026-11-27T01:00:00Z' },
    ]);

    const workerEnv = { HERDR_CORTEX_ROLE: 'worker', HC_TERMINAL_ID: 'tab-agy' };
    const agyText = (out) => (out?.injectSteps || []).map((s) => s.systemMessage?.systemMessage || '').join('\n\n');
    const baseOpts = {
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
      promptsDir: env.promptsDir,
      indexBudget,
    };

    // 1. SessionStart (explicit root) in worker session
    const startWorker = agyText(
      handleAntigravitySessionStart(
        { conversationId: 'worker-conv-1', rootConversationId: 'worker-conv-1', cwd: env.projectDir },
        { ...baseOpts, env: workerEnv },
      ),
    );
    assert.doesNotMatch(startWorker, /# HEAD_CORE/);
    assert.doesNotMatch(startWorker, /Relay message meant for Antigravity HEAD/);
    assert.match(startWorker, /Cortex Memory Overview/);
    assert.match(startWorker, /Antigravity worker decision/);
    assert.match(startWorker, /Memory may be incomplete: 1 document is not indexed yet/);

    // 2. PreInvocation (first turn + CHECKPOINT DONE + unapproved folder) in worker session
    const preWorker = agyText(
      handleAntigravityPreInvocation(
        {
          conversationId: 'worker-conv-2',
          transcriptPath: agyTranscript,
          lastUserInput: 'Run delegated task',
          cwd: env.projectDir,
        },
        { ...baseOpts, env: workerEnv },
      ),
    );
    assert.doesNotMatch(preWorker, /# HEAD_CORE/);
    assert.doesNotMatch(preWorker, /Recent Conversation Turns/);
    assert.doesNotMatch(preWorker, /Earlier user question/);
    assert.doesNotMatch(preWorker, /Relay message meant for Antigravity HEAD/);
    assert.match(preWorker, /Cortex Memory Overview/);
    assert.match(preWorker, /Antigravity worker decision/);

    const preUnapproved = agyText(
      handleAntigravityPreInvocation(
        { conversationId: 'worker-conv-unapproved', lastUserInput: 'Check', cwd: env.unapprovedDir },
        { ...baseOpts, env: workerEnv },
      ),
    );
    assert.match(preUnapproved, /Project memory was not loaded/);

    // Parent session and inbox untouched
    assert.equal(readSavedSession('tab-agy', { globalDir: env.globalDir }).sessionId, 'head-conv-1');
    assert.deepEqual(countInboxMessages('tab-agy', { globalDir: env.globalDir }), { pending: 1, held: 0, broken: 0 });

    // 3. Without HERDR_CORTEX_ROLE, normal Antigravity PreInvocation records session, injects HEAD_CORE + checkpoint turns + inbox
    const preHead = agyText(
      handleAntigravityPreInvocation(
        {
          conversationId: 'head-conv-2',
          transcriptPath: agyTranscript,
          lastUserInput: 'Continue work',
          cwd: env.projectDir,
        },
        { ...baseOpts, env: { HC_TERMINAL_ID: 'tab-agy' } },
      ),
    );
    assert.match(preHead, /# HEAD_CORE/);
    assert.match(preHead, /Cortex Memory Overview/);
    assert.match(preHead, /Recent Conversation Turns/);
    assert.match(preHead, /Earlier user question/);
    assert.match(preHead, /Relay message meant for Antigravity HEAD/);
    assert.equal(readSavedSession('tab-agy', { globalDir: env.globalDir }).sessionId, 'head-conv-2');
    assert.deepEqual(countInboxMessages('tab-agy', { globalDir: env.globalDir }), { pending: 0, held: 1, broken: 0 });
  } finally {
    env.cleanup();
  }
});

test('mcp & relay: worker session denies write tools with SUBAGENT_WRITE_DENIED and allows all read tools (in-process and stdio CLI)', async () => {
  const env = makeTempEnv('cortex-worker-mcp-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const hcClient = makeFakeHc(env.projectDir);
    const callTool = async (server, name, args = {}) => {
      const resp = await server.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      return { isError: Boolean(resp.result.isError), data: JSON.parse(resp.result.content[0].text) };
    };

    // Seed canonical doc and relay message from normal HEAD server
    const headServer = createMcpServer({
      store,
      promptsDir: env.promptsDir,
      hcClient,
      env: { HC_TERMINAL_ID: 't1' },
    });
    const seeded = await callTool(headServer, 'memory_save', {
      id: 'dec-seeded-1',
      type: 'decision',
      title: 'Seeded decision',
      summary: 'Created by HEAD',
      files: ['src/core/role.mjs'],
    });
    assert.equal(seeded.isError, false);
    enqueueMessage('t1', { id: 'msg-peek-only', from_terminal_id: 't2', message: 'Pending message' }, { globalDir: env.globalDir });

    // Worker MCP server denies all write operations with SUBAGENT_WRITE_DENIED and permits all read tools
    const workerServer = createMcpServer({
      store,
      promptsDir: env.promptsDir,
      hcClient,
      env: { HERDR_CORTEX_ROLE: '  WORKER ', HC_TERMINAL_ID: 't1' },
    });

    for (const [toolName, args] of [
      ['memory_save', { type: 'worklog', title: 'Blocked', summary: 'Blocked' }],
      ['memory_update', { id: 'dec-seeded-1', status: 'done' }],
      ['relay_send', { to_terminal_id: 't1', message: 'Blocked send', wake: 'never' }],
      ['relay_inbox', { action: 'ack', message_id: 'all' }],
    ]) {
      const denied = await callTool(workerServer, toolName, args);
      assert.equal(denied.isError, true, `${toolName} must fail in worker session`);
      assert.equal(denied.data.error, 'SUBAGENT_WRITE_DENIED', `${toolName} must return SUBAGENT_WRITE_DENIED`);
    }

    // Read tools all succeed and inbox message remains unacknowledged
    assert.equal((await callTool(workerServer, 'memory_search', { query: 'Seeded' })).isError, false);
    const readDoc = await callTool(workerServer, 'memory_read', { id: 'dec-seeded-1' });
    assert.equal(readDoc.isError, false);
    assert.equal(readDoc.data.title, 'Seeded decision');
    assert.equal((await callTool(workerServer, 'memory_graph', { target: 'dec-seeded-1' })).isError, false);
    assert.equal((await callTool(workerServer, 'memory_overview', {})).isError, false);
    assert.equal((await callTool(workerServer, 'cortex_prompt', { kind: 'core' })).isError, false);
    assert.equal((await callTool(workerServer, 'relay_tabs', {})).isError, false);
    const peekRes = await callTool(workerServer, 'relay_inbox', { action: 'peek' });
    assert.equal(peekRes.isError, false);
    assert.equal(peekRes.data.count, 1);

    // End-to-end stdio server process inherits HERDR_CORTEX_ROLE=worker from process.env
    const rpcLines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_update', arguments: { id: 'dec-seeded-1', status: 'done' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_read', arguments: { id: 'dec-seeded-1' } } }),
    ].join('\n') + '\n';

    const child = spawnSync(
      process.execPath,
      ['--no-warnings', path.join(REPO_ROOT, 'src', 'mcp', 'server.mjs'), '--project', env.projectDir, '--global', env.globalDir, '--prompts', env.promptsDir],
      {
        input: rpcLines,
        encoding: 'utf8',
        cwd: env.projectDir,
        env: {
          ...process.env,
          HERDR_CORTEX_HOME: env.globalDir,
          HERDR_CORTEX_TEST_HOME: env.homeDir,
          HERDR_CORTEX_ROLE: 'worker',
        },
        timeout: 20000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const responses = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(responses[0].result.isError, true);
    assert.equal(JSON.parse(responses[0].result.content[0].text).error, 'SUBAGENT_WRITE_DENIED');
    assert.equal(responses[1].result.isError, undefined);
    assert.equal(JSON.parse(responses[1].result.content[0].text).id, 'dec-seeded-1');
  } finally {
    store.close();
    env.cleanup();
  }
});
