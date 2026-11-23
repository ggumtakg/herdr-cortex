import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { atomicWriteJson, atomicWriteText } from '../src/core/config.mjs';
import { CortexStore } from '../src/core/store.mjs';
import {
  EXCLUDED_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
  createMcpServer,
} from '../src/mcp/server.mjs';
import { recordSession } from '../src/revive/tracker.mjs';
import { createHcClient, sanitizeSingleLineTrigger } from '../src/relay/hc.mjs';
import {
  ackMessage,
  drainInbox,
  enqueueMessage,
  formatInboxForHook,
  formatInboxForHookDetailed,
  getTerminalInboxDir,
  peekInbox,
} from '../src/relay/inbox.mjs';

function makeTempEnv(prefix = 'herdr-cortex-relay-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  return {
    root,
    projectDir,
    globalDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('relay/inbox: terminalId validation, FIFO enqueue/peek, .taking-<pid> claim/ack, stale crash recovery, and .broken/ quarantine', () => {
  const env = makeTempEnv();
  try {
    // 1. Strict terminalId validation blocks traversal, leading dash option injection, and reserved Windows names
    for (const badId of ['../escape', 'tab/1', 'tab\\1', '-flag', '--json', '_lead', 'CON', 'nul', 'a'.repeat(65), '']) {
      assert.throws(() => enqueueMessage(env.projectDir, badId, { message: 'x' }), /Invalid terminalId/);
    }

    // 2. Enqueue two messages atomically and peek non-destructively
    const m1 = enqueueMessage(env.projectDir, 'tab-2', {
      id: 'msg-1',
      from_terminal_id: 'tab-1',
      message: 'First message\nwith multiline body',
      context_docs: ['dec-1', 'base-p0'],
    });
    const m2 = enqueueMessage(env.projectDir, 'tab-2', {
      id: 'msg-2',
      from_terminal_id: 'tab-1',
      message: 'Second message',
    });

    const peeked = peekInbox(env.projectDir, 'tab-2');
    assert.equal(peeked.count, 2);
    assert.deepEqual(peeked.messages.map((m) => m.id), ['msg-1', 'msg-2']);
    assert.deepEqual(peeked.messages[0].context_docs, ['dec-1', 'base-p0']);

    // 3. ackMessage removes a specific message cleanly
    const ackOne = ackMessage(env.projectDir, 'tab-2', 'msg-1');
    assert.equal(ackOne.acked, true);
    assert.equal(peekInbox(env.projectDir, 'tab-2').count, 1);

    // 4. Plant a corrupt JSON file + simulate a crashed consumer (.taking-999999-dead/)
    const inboxDir = getTerminalInboxDir(env.projectDir, 'tab-2');
    atomicWriteText(path.join(inboxDir, '999999999999999-corrupt.json'), '{not valid json');

    const crashedTakingDir = path.join(inboxDir, '.taking-999999-crashed');
    fs.mkdirSync(crashedTakingDir, { recursive: true });
    atomicWriteJson(path.join(crashedTakingDir, '000000000000001-recovered.json'), {
      id: 'msg-recovered',
      from_terminal_id: 'tab-3',
      to_terminal_id: 'tab-2',
      message: 'Recovered after dead PID crash',
      context_docs: [],
      created_at: '2026-11-22T10:00:00.000Z',
    });

    // Also simulate a live PID whose .taking dir exceeded staleMs
    const staleTakingDir = path.join(inboxDir, '.taking-12345-old');
    fs.mkdirSync(staleTakingDir, { recursive: true });
    atomicWriteJson(path.join(staleTakingDir, '000000000000002-stale.json'), {
      id: 'msg-stale',
      from_terminal_id: 'tab-4',
      to_terminal_id: 'tab-2',
      message: 'Recovered after stale timeout',
      context_docs: [],
      created_at: '2026-11-22T10:01:00.000Z',
    });
    const oldTime = new Date(Date.now() - 700_000);
    fs.utimesSync(staleTakingDir, oldTime, oldTime);

    // Drain recovers dead-PID dir and stale-time dir, quarantines corrupt JSON into .broken/
    const drained = drainInbox(env.projectDir, 'tab-2', {
      staleMs: 600_000,
      isPidAlive: (pid) => pid === 12345, // 999999 is dead, 12345 is alive but stale
    });

    assert.equal(drained.messages.length, 3);
    const drainedIds = drained.messages.map((m) => m.id);
    assert.ok(drainedIds.includes('msg-recovered'));
    assert.ok(drainedIds.includes('msg-stale'));
    assert.ok(drainedIds.includes(m2.id));

    // Verify corrupt JSON was quarantined into .broken/
    const brokenFiles = fs.readdirSync(path.join(inboxDir, '.broken'));
    assert.ok(brokenFiles.some((f) => f.includes('corrupt.json')));
    assert.ok(drained.notices.some((n) => n.includes('Quarantined corrupt')));
    assert.ok(drained.notices.some((n) => n.includes('dead pid 999999')));
    assert.ok(drained.notices.some((n) => n.includes('older than 600000ms')));

    // Before ack(): claim dir exists and holds the messages
    assert.equal(fs.existsSync(drained.claimDir), true);
    assert.equal(peekInbox(env.projectDir, 'tab-2').count, 0);

    // Call ack(): removes claimed files and .taking-* dir cleanly (idempotent on second call)
    const ackRes1 = drained.ack();
    assert.equal(ackRes1.acked, 3);
    assert.equal(fs.existsSync(drained.claimDir), false);
    const ackRes2 = drained.ack();
    assert.equal(ackRes2.alreadyAcked, true);
    assert.ok(m1.id);

    // 5. peekInbox also recovers stale .taking-* directories left by dead PIDs
    const stalePeekDir = path.join(inboxDir, '.taking-888888-peekdead');
    fs.mkdirSync(stalePeekDir, { recursive: true });
    atomicWriteJson(path.join(stalePeekDir, '000000000000009-peekrec.json'), {
      id: 'msg-peek-recovered',
      from_terminal_id: 'tab-9',
      to_terminal_id: 'tab-2',
      message: 'Recovered during peekInbox',
      context_docs: [],
      created_at: '2026-11-22T10:09:00.000Z',
    });
    const peekRecovered = peekInbox(env.projectDir, 'tab-2', { isPidAlive: () => false });
    assert.equal(peekRecovered.count, 1);
    assert.equal(peekRecovered.messages[0].id, 'msg-peek-recovered');
    assert.ok(peekRecovered.notices.some((n) => n.includes('dead pid 888888')));

    // 6. formatInboxForHook strictly never exceeds maxChars including footer / trim notices
    const longMsgs = [
      { id: 'm-1', from_terminal_id: 't1', message: 'A'.repeat(120), context_docs: [] },
      { id: 'm-2', from_terminal_id: 't1', message: 'B'.repeat(120), context_docs: [] },
    ];
    for (const budget of [40, 90, 180, 220]) {
      const formatted = formatInboxForHook(longMsgs, { maxChars: budget });
      assert.ok(formatted.length <= budget, `Expected length <= ${budget}, got ${formatted.length}`);
    }
  } finally {
    env.cleanup();
  }
});

test('relay/hc: listTerminals, getTerminal idle/busy detection, single-line sendTrigger, and graceful missing hc', () => {
  const sentCalls = [];
  const mockExec = (bin, args) => {
    assert.equal(bin, 'hc');
    if (args[0] === 'ls') {
      return JSON.stringify({
        terminals: [
          { address: 't1', state: 'live', agent: 'claude', idle: true, cwd: 'G:\\proj', where: 'proj / Claude' },
          { address: 't2', state: 'live', agent: 'agy', busy: true, cwd: 'G:\\proj', where: 'proj / Antigravity' },
          { address: 't3', state: 'exited', agent: 'powershell.exe', cwd: 'G:\\other', where: 'other' },
        ],
      });
    }
    if (args[0] === 'get' && args[1] === 't1') {
      return JSON.stringify({ address: 't1', state: 'live', foreground: { name: 'claude', status: 'idle' } });
    }
    if (args[0] === 'get' && args[1] === 't2') {
      return JSON.stringify({ address: 't2', state: 'live', foreground: { name: 'agy', busy: true } });
    }
    if (args[0] === 'send') {
      sentCalls.push({ id: args[1], text: args[2] });
      return '';
    }
    throw new Error(`Unexpected hc args: ${args.join(' ')}`);
  };

  const hc = createHcClient({ execFileSync: mockExec });
  const ls = hc.listTerminals();
  assert.equal(ls.ok, true);
  assert.equal(ls.terminals.length, 3);
  assert.equal(ls.terminals[0].idle, true);
  assert.equal(ls.terminals[0].busy, false);
  assert.equal(ls.terminals[1].busy, true);
  assert.equal(ls.terminals[1].idle, false);
  assert.equal(ls.terminals[2].live, false);

  const g1 = hc.getTerminal('t1');
  assert.equal(g1.ok, true);
  assert.equal(g1.status.idle, true);

  const g2 = hc.getTerminal('t2');
  assert.equal(g2.ok, true);
  assert.equal(g2.status.busy, true);
  assert.equal(g2.status.idle, false);

  // Multiline text gets strictly collapsed to a single line
  const sendRes = hc.sendTrigger('t1', 'Line 1\nLine 2\r\n\tLine 3');
  assert.equal(sendRes.ok, true);
  assert.equal(sendRes.sent, 'Line 1 Line 2 Line 3');
  assert.equal(sentCalls[0].text.includes('\n'), false);
  assert.equal(sanitizeSingleLineTrigger('a\nb\nc'), 'a b c');

  // Missing hc binary degrades gracefully
  const missingHc = createHcClient({
    execFileSync() {
      const err = new Error('spawnSync hc ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  const missingRes = missingHc.listTerminals();
  assert.equal(missingRes.ok, false);
  assert.equal(missingRes.code, 'HC_NOT_FOUND');
});

test('relay/tools + MCP server: exposes all 10 tools and runs relay_tabs, relay_send (wake auto/always/never), and relay_inbox', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  const prevTerminalId = process.env.HC_TERMINAL_ID;

  try {
    process.env.HC_TERMINAL_ID = 't1';

    // Save a project doc + saved revive session for t2
    store.saveDoc({
      id: 'dec-relay-1',
      type: 'decision',
      title: 'Relay Test Decision',
      summary: 'Cross-tab relay design verified',
      session: 'stage-2',
      branch: 'relay',
    });
    recordSession({
      terminalId: 't2',
      agent: 'antigravity',
      payload: { conversationId: 'conv-t2-abc', cwd: env.projectDir },
      globalDir: env.globalDir,
    });

    const sentTriggers = [];
    const mockHc = createHcClient({
      execFileSync(_bin, args) {
        if (args[0] === 'ls') {
          return JSON.stringify({
            terminals: [
              { address: 't1', state: 'live', agent: 'claude', idle: true, cwd: env.projectDir, where: 'proj / Claude' },
              { address: 't2', state: 'live', agent: 'agy', idle: true, cwd: env.projectDir, where: 'proj / Antigravity' },
              { address: 't3', state: 'live', agent: 'claude', busy: true, cwd: env.projectDir, where: 'proj / Worker' },
            ],
          });
        }
        if (args[0] === 'get' && args[1] === 't2') {
          return JSON.stringify({ address: 't2', state: 'live', agent: 'agy', idle: true });
        }
        if (args[0] === 'get' && args[1] === 't3') {
          return JSON.stringify({ address: 't3', state: 'live', agent: 'claude', busy: true });
        }
        if (args[0] === 'send') {
          if (args[1] === '--if') {
            sentTriggers.push({ ifCond: args[2], to: args[3], trigger: args[4] });
          } else {
            sentTriggers.push({ ifCond: null, to: args[1], trigger: args[2] });
          }
          return '';
        }
        throw new Error(`Unexpected hc call: ${args.join(' ')}`);
      },
    });

    const server = createMcpServer({
      store,
      hcClient: mockHc,
    });

    // 1. Verify tools/list exposes all 10 tools (6 memory_* + 3 relay_* + 1 cortex_prompt)
    const listResp = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const toolNames = listResp.result.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      'cortex_prompt',
      'memory_graph',
      'memory_overview',
      'memory_read',
      'memory_save',
      'memory_search',
      'memory_update',
      'relay_inbox',
      'relay_send',
      'relay_tabs',
    ]);

    // 2. relay_tabs merges hc ls + saved revive sessions + project memory sessions
    const tabsResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'relay_tabs', arguments: {} },
    });
    const tabsData = JSON.parse(tabsResp.result.content[0].text);
    assert.equal(tabsData.hcAvailable, true);
    assert.equal(tabsData.currentTerminalId, 't1');
    assert.equal(tabsData.tabs.length, 3);
    const t2Tab = tabsData.tabs.find((t) => t.terminalId === 't2');
    assert.equal(t2Tab.sameProject, true);
    assert.equal(t2Tab.savedSession.sessionId, 'conv-t2-abc');
    assert.equal(tabsData.projectSessions[0].session, 'stage-2');

    // 3. relay_send with wake="auto" to IDLE t2 -> saves multiline body in inbox + sends short single-line trigger
    const multilineBody = 'Line A: review schema\nLine B: verify tests\nLine C: report back';
    const sendIdleResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'relay_send',
        arguments: {
          to_terminal_id: 't2',
          message: multilineBody,
          context_docs: ['dec-relay-1'],
          wake: 'auto',
        },
      },
    });
    const sendIdleData = JSON.parse(sendIdleResp.result.content[0].text);
    assert.equal(sendIdleData.queued, true);
    assert.equal(sendIdleData.woke, true);
    assert.equal(sendIdleData.wakeReason, 'sent_auto_idle');
    assert.equal(sentTriggers.length, 1);
    assert.equal(sentTriggers[0].ifCond, 'idle');
    assert.equal(sentTriggers[0].to, 't2');
    // NEVER sends raw multiline body via hc send!
    assert.equal(sentTriggers[0].trigger.includes('\n'), false);
    assert.equal(sentTriggers[0].trigger.includes('Line A'), false);
    assert.match(sentTriggers[0].trigger, /relay_inbox/);

    // 4. relay_send with wake="auto" to BUSY t3 -> enqueues message, skips hc send
    const sendBusyResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'relay_send',
        arguments: { to_terminal_id: 't3', message: 'Wait until free', wake: 'auto' },
      },
    });
    const sendBusyData = JSON.parse(sendBusyResp.result.content[0].text);
    assert.equal(sendBusyData.queued, true);
    assert.equal(sendBusyData.woke, false);
    assert.equal(sendBusyData.wakeReason, 'target_busy');
    assert.equal(sentTriggers.length, 1);

    // 5. relay_send with wake="always" to BUSY t3 -> sends short wake trigger
    const sendAlwaysResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'relay_send',
        arguments: { to_terminal_id: 't3', message: 'Urgent override', wake: 'always' },
      },
    });
    const sendAlwaysData = JSON.parse(sendAlwaysResp.result.content[0].text);
    assert.equal(sendAlwaysData.woke, true);
    assert.equal(sendAlwaysData.wakeReason, 'sent_always');
    assert.equal(sentTriggers.length, 2);

    // 6. relay_send with wake="never" to IDLE t2 -> does NOT call hc send
    const sendNeverResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'relay_send',
        arguments: { to_terminal_id: 't2', message: 'Silent delivery', wake: 'never' },
      },
    });
    const sendNeverData = JSON.parse(sendNeverResp.result.content[0].text);
    assert.equal(sendNeverData.woke, false);
    assert.equal(sendNeverData.wakeReason, 'wake_disabled');
    assert.equal(sentTriggers.length, 2);

    // 7. relay_inbox peek & ack for t2
    process.env.HC_TERMINAL_ID = 't2';
    const peekResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'relay_inbox', arguments: { action: 'peek' } },
    });
    const peekData = JSON.parse(peekResp.result.content[0].text);
    assert.equal(peekData.count, 2);
    assert.equal(peekData.messages[0].message, multilineBody);
    assert.deepEqual(peekData.messages[0].context_docs, ['dec-relay-1']);

    const ackResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'relay_inbox', arguments: { action: 'ack', message_id: peekData.messages[0].id } },
    });
    const ackData = JSON.parse(ackResp.result.content[0].text);
    assert.equal(ackData.acked, true);

    const peekAfter = await server.handleMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'relay_inbox', arguments: { action: 'peek' } },
    });
    assert.equal(JSON.parse(peekAfter.result.content[0].text).count, 1);
  } finally {
    if (prevTerminalId === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = prevTerminalId;
    store.close();
    env.cleanup();
  }
});

test('regression: cross-project relay_send and relay_tabs route messages to target terminal project inbox', async () => {
  const env = makeTempEnv('herdr-cortex-xproj-');
  const projectX = path.join(env.root, 'project-x');
  const projectY = path.join(env.root, 'project-y');
  fs.mkdirSync(projectX, { recursive: true });
  fs.mkdirSync(projectY, { recursive: true });

  const storeX = new CortexStore({ projectDir: projectX, globalDir: env.globalDir, disableVec: true });
  const storeY = new CortexStore({ projectDir: projectY, globalDir: env.globalDir, disableVec: true });
  const prevTerminalId = process.env.HC_TERMINAL_ID;

  try {
    process.env.HC_TERMINAL_ID = 'tab-a';
    const mockHc = createHcClient({
      execFileSync(_bin, args) {
        if (args[0] === 'ls') {
          return JSON.stringify({
            terminals: [
              { address: 'tab-a', state: 'live', agent: 'claude', idle: true, cwd: projectX, where: 'proj-x / Claude' },
              { address: 'tab-b', state: 'live', agent: 'agy', idle: true, cwd: projectY, where: 'proj-y / Antigravity' },
            ],
          });
        }
        if (args[0] === 'get' && args[1] === 'tab-b') {
          return JSON.stringify({ address: 'tab-b', state: 'live', agent: 'agy', idle: true, cwd: projectY });
        }
        if (args[0] === 'send') {
          return '';
        }
        throw new Error(`Unexpected hc call: ${args.join(' ')}`);
      },
    });

    const serverA = createMcpServer({ store: storeX, hcClient: mockHc });
    const serverB = createMcpServer({ store: storeY, hcClient: mockHc });

    // Server A (in Project X) sends to Tab B (in Project Y)
    const sendResp = await serverA.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'relay_send',
        arguments: {
          to_terminal_id: 'tab-b',
          message: 'Cross-project handoff from X to Y',
          context_docs: ['base-p0'],
          wake: 'auto',
        },
      },
    });
    const sendData = JSON.parse(sendResp.result.content[0].text);
    assert.equal(sendData.queued, true);
    assert.equal(sendData.woke, true);
    assert.equal(path.resolve(sendData.target_project_dir), path.resolve(projectY));

    // Project X must NOT hold Tab B's message; Project Y MUST hold it
    assert.equal(peekInbox(projectX, 'tab-b').count, 0);
    assert.equal(peekInbox(projectY, 'tab-b').count, 1);

    // relay_tabs from Server A reports Tab B's pendingInboxCount from Project Y
    const tabsResp = await serverA.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'relay_tabs', arguments: {} },
    });
    const tabsData = JSON.parse(tabsResp.result.content[0].text);
    const tabB = tabsData.tabs.find((t) => t.terminalId === 'tab-b');
    assert.equal(tabB.sameProject, false);
    assert.equal(tabB.pendingInboxCount, 1);

    // Server B (in Project Y) peeks via relay_inbox and drainInbox receives the message cleanly
    process.env.HC_TERMINAL_ID = 'tab-b';
    const peekB = await serverB.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'relay_inbox', arguments: { action: 'peek' } },
    });
    const peekBData = JSON.parse(peekB.result.content[0].text);
    assert.equal(peekBData.count, 1);
    assert.equal(peekBData.messages[0].message, 'Cross-project handoff from X to Y');

    const drainedY = drainInbox(projectY, 'tab-b');
    assert.equal(drainedY.messages.length, 1);
    assert.equal(drainedY.messages[0].message, 'Cross-project handoff from X to Y');
    drainedY.ack();
    assert.equal(peekInbox(projectY, 'tab-b').count, 0);
  } finally {
    if (prevTerminalId === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = prevTerminalId;
    storeX.close();
    storeY.close();
    env.cleanup();
  }
});

test('P0-5 regression: inbox partial ACK preserves omitted and truncated messages in inbox', () => {
  const env = makeTempEnv('cortex-partial-ack-');
  try {
    // Case 1: 2 messages where only the 1st fits -> 1st is acked, 2nd is restored back into inbox
    enqueueMessage(env.projectDir, 'tab-p1', { id: 'msg-fit', from_terminal_id: 'tab-0', message: 'Short message 1' });
    enqueueMessage(env.projectDir, 'tab-p1', { id: 'msg-omit', from_terminal_id: 'tab-0', message: 'Second message '.repeat(20) });

    const d1 = drainInbox(env.projectDir, 'tab-p1');
    assert.equal(d1.messages.length, 2);
    const det1 = formatInboxForHookDetailed(d1.messages, { maxChars: 170 });
    assert.deepEqual(det1.includedIds, ['msg-fit']);
    assert.deepEqual(det1.omittedIds, ['msg-omit']);
    assert.deepEqual(det1.truncatedIds, []);
    assert.ok(det1.text.length <= 170);

    const ack1 = d1.ack(det1.includedIds);
    assert.equal(ack1.acked, 1);
    assert.equal(ack1.restored, 1);
    assert.equal(fs.existsSync(d1.claimDir), false);

    // Omitted message MUST still be present in inbox
    const remaining1 = peekInbox(env.projectDir, 'tab-p1');
    assert.equal(remaining1.count, 1);
    assert.equal(remaining1.messages[0].id, 'msg-omit');

    // Case 2: Single oversized message is truncated -> includedIds is [] -> message restored for relay_inbox!
    const d2 = drainInbox(env.projectDir, 'tab-p1');
    const det2 = formatInboxForHookDetailed(d2.messages, { maxChars: 140 });
    assert.deepEqual(det2.includedIds, []);
    assert.deepEqual(det2.truncatedIds, ['msg-omit']);
    assert.match(det2.text, /\[\.\.\.trimmed, inspect via relay_inbox\]/);

    const ack2 = d2.ack(det2.includedIds);
    assert.equal(ack2.acked, 0);
    assert.equal(ack2.restored, 1);
    assert.equal(peekInbox(env.projectDir, 'tab-p1').count, 1);
    assert.equal(peekInbox(env.projectDir, 'tab-p1').messages[0].id, 'msg-omit');
  } finally {
    env.cleanup();
  }
});

test('P0-6 & P0-7 regression: hc blocked/error/done/isBareShell/foreground.cwd/error-json/--if fallback, and subagent relay denial', async () => {
  const env = makeTempEnv('cortex-hc-guard-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  const prevTid = process.env.HC_TERMINAL_ID;
  try {
    process.env.HC_TERMINAL_ID = 't1';
    const sendLog = [];
    let rejectIfFlag = false;

    const mockHc = createHcClient({
      execFileSync(_bin, args) {
        if (args[0] === 'ls') {
          return JSON.stringify({
            terminals: [
              { address: 't-blocked', state: 'live', foreground: { name: 'claude', status: 'blocked', cwd: 'G:\\fg-cwd' }, cwd: 'G:\\outer-cwd' },
              { address: 't-error', state: 'live', foreground: { name: 'claude', status: 'error' } },
              { address: 't-unknown', state: 'live', foreground: { name: 'claude' } },
              { address: 't-done', state: 'live', foreground: { name: 'claude', status: 'done' } },
              { address: 't-shell', state: 'live', foreground: { name: 'powershell.exe', status: 'idle' } },
            ],
          });
        }
        if (args[0] === 'get' && args[1] === 't-shell') {
          return JSON.stringify({ address: 't-shell', state: 'live', foreground: { name: 'powershell.exe', status: 'idle', cwd: env.projectDir } });
        }
        if (args[0] === 'get' && args[1] === 't-blocked') {
          return JSON.stringify({ address: 't-blocked', state: 'live', foreground: { name: 'claude', status: 'blocked', cwd: env.projectDir } });
        }
        if (args[0] === 'get' && args[1] === 't-done') {
          return JSON.stringify({ address: 't-done', state: 'live', foreground: { name: 'claude', status: 'done', cwd: env.projectDir } });
        }
        if (args[0] === 'get' && args[1] === 't-api-err') {
          return JSON.stringify({ error: 'terminal not found' });
        }
        if (args[0] === 'send') {
          sendLog.push([...args]);
          if (rejectIfFlag && args[1] === '--if') {
            const err = new Error('unknown flag: --if');
            err.stderr = 'unknown flag: --if';
            throw err;
          }
          return '';
        }
        throw new Error(`Unexpected hc call: ${args.join(' ')}`);
      },
    });

    // 1. detectTerminalActivity: blocked, error, unknown, isBareShell are NOT idle; done IS idle; foreground.cwd wins
    const ls = mockHc.listTerminals();
    assert.equal(ls.ok, true);
    const byId = new Map(ls.terminals.map((t) => [t.terminalId, t]));
    assert.equal(byId.get('t-blocked').idle, false);
    assert.equal(byId.get('t-blocked').blocked, true);
    assert.equal(byId.get('t-blocked').cwd, 'G:\\fg-cwd');
    assert.equal(byId.get('t-error').idle, false);
    assert.equal(byId.get('t-error').error, true);
    assert.equal(byId.get('t-unknown').idle, false);
    assert.equal(byId.get('t-done').idle, true);
    assert.equal(byId.get('t-shell').isBareShell, true);
    assert.equal(byId.get('t-shell').idle, false);

    // 2. parsed.error returns ok: false
    const apiErr = mockHc.getTerminal('t-api-err');
    assert.equal(apiErr.ok, false);
    assert.equal(apiErr.code, 'HC_API_ERROR');

    // 3. sendTrigger --if idle fallback when flag rejected
    rejectIfFlag = true;
    const fbRes = mockHc.sendTrigger('t-done', 'ping', { ifIdle: true });
    assert.equal(fbRes.ok, true);
    assert.deepEqual(sendLog[0], ['send', '--if', 'idle', 't-done', 'ping']);
    assert.deepEqual(sendLog[1], ['send', 't-done', 'ping']);
    rejectIfFlag = false;

    const server = createMcpServer({ store, hcClient: mockHc });

    // 4. wake="auto" blocks bare shell with target_is_bare_shell and does NOT call hc send
    const sendLogCountBefore = sendLog.length;
    const bareRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'relay_send', arguments: { to_terminal_id: 't-shell', message: 'Do not type in bare shell', wake: 'auto' } },
    });
    const bareData = JSON.parse(bareRes.result.content[0].text);
    assert.equal(bareData.queued, true);
    assert.equal(bareData.woke, false);
    assert.equal(bareData.wakeReason, 'target_is_bare_shell');
    assert.equal(sendLog.length, sendLogCountBefore);

    // 5. from_terminal_id validated strictly
    const badFrom = await server.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'relay_send', arguments: { to_terminal_id: 't-done', from_terminal_id: '../escape', message: 'hi', wake: 'never' } },
    });
    assert.equal(badFrom.result.isError, true);

    // 6. Subagent (including camelCase meta.isSubagent: true) cannot call relay_send or relay_inbox(ack), CAN call relay_inbox(peek)
    const subSend = await server.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'relay_send',
        arguments: { to_terminal_id: 't-done', message: 'subagent unauthorized' },
        _meta: { isSubagent: true },
      },
    });
    assert.equal(subSend.result.isError, true);
    assert.equal(JSON.parse(subSend.result.content[0].text).error, 'SUBAGENT_WRITE_DENIED');

    const subAck = await server.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'relay_inbox',
        arguments: { action: 'ack', message_id: 'all', terminal_id: 't-shell' },
        _meta: { isSubagent: true },
      },
    });
    assert.equal(subAck.result.isError, true);
    assert.equal(JSON.parse(subAck.result.content[0].text).error, 'SUBAGENT_WRITE_DENIED');

    const subPeek = await server.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'relay_inbox',
        arguments: { action: 'peek', terminal_id: 't-shell' },
        _meta: { isSubagent: true },
      },
    });
    assert.ok(!subPeek.result.isError);
    assert.equal(JSON.parse(subPeek.result.content[0].text).count, 1);
  } finally {
    if (prevTid === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = prevTid;
    store.close();
    env.cleanup();
  }
});

test('P0-3, P0-11, P1-8, P1-11, P2-5 regression: MCP excludedProjects enforcement, derived_from array schema, depth<=10, project_dir, and -32603 error safety', async () => {
  const env = makeTempEnv('cortex-mcp-p0-');
  const excludedProj = path.join(env.root, 'excluded_mcp_proj');
  const otherEnabledProj = path.join(env.root, 'other_enabled_proj');
  fs.mkdirSync(excludedProj, { recursive: true });
  fs.mkdirSync(otherEnabledProj, { recursive: true });

  atomicWriteJson(path.join(env.globalDir, 'config.json'), {
    mode: 'all',
    excludedProjects: ['excluded_mcp_proj'],
  });

  const excludedStore = new CortexStore({ projectDir: excludedProj, globalDir: env.globalDir, disableVec: true });
  const enabledStore = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });

  try {
    // 1. Check schema fixes & SERVER_INSTRUCTIONS
    const enabledServer = createMcpServer({ store: enabledStore });
    const initEnabled = await enabledServer.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(initEnabled.result.instructions, SERVER_INSTRUCTIONS);
    assert.match(SERVER_INSTRUCTIONS, /preferences/);
    assert.match(SERVER_INSTRUCTIONS, /relay_inbox/);
    assert.match(SERVER_INSTRUCTIONS, /product-planning/);
    assert.match(SERVER_INSTRUCTIONS, /DEVELOPMENT_STANDARD/);

    const listResp = await enabledServer.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const saveTool = listResp.result.tools.find((t) => t.name === 'memory_save');
    const updateTool = listResp.result.tools.find((t) => t.name === 'memory_update');
    const graphTool = listResp.result.tools.find((t) => t.name === 'memory_graph');

    assert.deepEqual(saveTool.inputSchema.properties.derived_from, { type: 'array', items: { type: 'string' } });
    assert.deepEqual(updateTool.inputSchema.properties.derived_from, { type: 'array', items: { type: 'string' } });
    assert.equal(graphTool.inputSchema.properties.depth.maximum, 10);

    // notifications/roots/list_changed handled cleanly (returns null)
    const rootsNotif = await enabledServer.handleMessage({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
    assert.equal(rootsNotif, null);

    // 2. Excluded project server: instructions, PROJECT_EXCLUDED blocks, global reads/writes allowed, NEVER creates .memory/
    const excludedServer = createMcpServer({ store: excludedStore });
    const initExcluded = await excludedServer.handleMessage({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
    assert.equal(initExcluded.result.instructions, EXCLUDED_SERVER_INSTRUCTIONS);

    const saveProjBlocked = await excludedServer.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'memory_save', arguments: { type: 'decision', title: 'Blocked', summary: 'Must fail' } },
    });
    assert.equal(saveProjBlocked.result.isError, true);
    assert.equal(JSON.parse(saveProjBlocked.result.content[0].text).error, 'PROJECT_EXCLUDED');

    const updateProjBlocked = await excludedServer.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'memory_update', arguments: { id: 'dec-1', status: 'done' } },
    });
    assert.equal(updateProjBlocked.result.isError, true);
    assert.equal(JSON.parse(updateProjBlocked.result.content[0].text).error, 'PROJECT_EXCLUDED');

    const relayBlocked = await excludedServer.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'relay_send', arguments: { to_terminal_id: 't2', message: 'blocked' } },
    });
    assert.equal(relayBlocked.result.isError, true);
    assert.equal(JSON.parse(relayBlocked.result.content[0].text).error, 'PROJECT_EXCLUDED');

    // Global save + overview + search work on excluded project without EVER creating <excluded>/.memory/
    const saveGlobal = await excludedServer.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'memory_save',
        arguments: { scope: 'global', type: 'knowledge', category: 'preferences', title: 'Global Pref', summary: 'Use Korean' },
      },
    });
    assert.ok(!saveGlobal.result.isError);

    const ovExcluded = await excludedServer.handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'memory_overview', arguments: { format: 'json' } },
    });
    const ovExData = JSON.parse(ovExcluded.result.content[0].text);
    assert.equal(ovExData.projectExcluded, true);
    assert.equal(ovExData.globalPreferences.length, 1);

    const searchExcluded = await excludedServer.handleMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'Korean', scope: 'all' } },
    });
    assert.ok(JSON.parse(searchExcluded.result.content[0].text).results.length >= 1);
    assert.equal(fs.existsSync(path.join(excludedProj, '.memory')), false);

    // 3. Cross-project relay_send targeting excluded project returns TARGET_PROJECT_EXCLUDED & never creates .memory/
    const mockHcTargetExcl = createHcClient({
      execFileSync(_bin, args) {
        if (args[0] === 'get' && args[1] === 't-excl') {
          return JSON.stringify({ address: 't-excl', state: 'live', foreground: { name: 'claude', status: 'idle', cwd: excludedProj } });
        }
        return '';
      },
    });
    const xprojServer = createMcpServer({ store: enabledStore, hcClient: mockHcTargetExcl });
    const targetExclResp = await xprojServer.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'relay_send', arguments: { to_terminal_id: 't-excl', message: 'Cannot land in excluded project' } },
    });
    assert.equal(targetExclResp.result.isError, true);
    assert.equal(JSON.parse(targetExclResp.result.content[0].text).error, 'TARGET_PROJECT_EXCLUDED');
    assert.equal(fs.existsSync(path.join(excludedProj, '.memory')), false);

    // 4. Optional project_dir override works cleanly on memory_save & memory_search
    const saveOther = await enabledServer.handleMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'memory_save',
        arguments: { id: 'other-doc-1', type: 'decision', title: 'Other workspace doc', summary: 'Stored via project_dir', project_dir: otherEnabledProj },
      },
    });
    assert.ok(!saveOther.result.isError);
    assert.equal(fs.existsSync(path.join(otherEnabledProj, '.memory', 'docs')), true);

    const readOther = await enabledServer.handleMessage({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'memory_read', arguments: { id: 'other-doc-1', scope: 'project', project_dir: otherEnabledProj } },
    });
    assert.equal(JSON.parse(readOther.result.content[0].text).id, 'other-doc-1');

    // 5. P1-8: Stdio start() sends JSON-RPC -32603 error response if internal handleMessage throws (never hangs client)
    const input = new PassThrough();
    const output = new PassThrough();
    let outBuf = '';
    output.on('data', (chunk) => { outBuf += chunk.toString('utf8'); });

    const crashingServer = createMcpServer({
      store: enabledStore,
      input,
      output,
      extraTools: [],
    });
    // Force registry.listTools to throw to exercise start() catch path
    crashingServer.registry.listTools = () => {
      throw new Error('Simulated internal crash');
    };
    const handle = crashingServer.start();
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })}\n`);
    input.end();
    await handle.done;

    const errResp = JSON.parse(outBuf.trim());
    assert.equal(errResp.id, 99);
    assert.equal(errResp.error.code, -32603);
    assert.match(errResp.error.message, /Simulated internal crash/);
  } finally {
    excludedStore.close();
    enabledStore.close();
    env.cleanup();
  }
});
