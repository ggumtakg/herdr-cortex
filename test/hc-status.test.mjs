import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CortexStore } from '../src/core/store.mjs';
import { SERVER_INSTRUCTIONS, createMcpServer, describeRetentionKorean } from '../src/mcp/server.mjs';
import {
  HC_BLOCKED_KINDS,
  HC_STATUS_STATES,
  HC_TARGET_ERROR_CODES,
  createHcClient,
  detectTerminalActivity,
} from '../src/relay/hc.mjs';
import { INBOX_DELIVERED_RETENTION_MS, countPendingMessages, describeRetention } from '../src/relay/inbox.mjs';
import { SEND_REFUSED_WAKE_REASONS, createRelayTools } from '../src/relay/tools.mjs';
import { approveAsUser } from './support/approve.mjs';

// The fake `execFileSync` below never starts a process; an absolute `hcBin` is used as is.
const FAKE_HC_BIN = path.join(os.tmpdir(), 'herdr-cortex-test-bin', 'hc.exe');

function makeTempEnv(prefix = 'herdr-cortex-hc-status-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  for (const dir of [projectDir, globalDir]) fs.mkdirSync(dir, { recursive: true });
  approveAsUser(projectDir, { globalDir });
  return {
    root,
    projectDir,
    globalDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// `hc ls --json` row and `hc get <id> --json` result in the shapes hc 0.1.21 prints (see relay-inbox.test.mjs):
// a row carries the status word as a plain string, `hc get` an object { app, state, kind?, msg? }.
function lsRow(address, status, extra = {}) {
  return { address, agent: 'claude-code', cwd: 'C:\\Users\\dev', state: 'live', ...(status ? { status } : {}), turn: 1, where: 'work / 1', ...extra };
}
function getResult(address, status, extra = {}) {
  return {
    address,
    cwd: 'C:\\Users\\dev',
    foreground: { argv: ['C:\\Users\\dev\\.local\\bin\\claude.exe'], cwd: 'C:\\Users\\dev', name: 'claude.exe', pid: 9432 },
    labels: { where: 'work / 1' },
    state: 'live',
    status,
    ...extra,
  };
}

// An `hc send` failure as hc reports it: a JSON error object on stdout (its output format when the output
// is a pipe) and a non-zero exit code. The kinds are the ones `hc schema` lists for terminal.send; only
// "blocked" (exit code 9, this message) was captured from a real tab, the other messages are stand-ins.
function hcFailure(kind, message, { status = 1, stream = 'stdout' } = {}) {
  const err = new Error(`Command failed: hc send (${kind})`);
  err.status = status;
  const text = JSON.stringify({ error: { kind, message } });
  err.stdout = stream === 'stdout' ? text : '';
  err.stderr = stream === 'stderr' ? text : '';
  return err;
}

/**
 * An hc client backed by tables: `ls` rows, `get[id]` results, and `sendFails[id]` = an error to throw when
 * a trigger is sent to that terminal. `sent` lists the sends that went through ({ ifCond, to }).
 */
function makeFakeHc({ ls = [], get = {}, sendFails = {} } = {}) {
  const state = { calls: [], sent: [] };
  const client = createHcClient({
    hcBin: FAKE_HC_BIN,
    execFileSync(bin, args) {
      state.calls.push([...args]);
      if (args[0] === 'ls') return JSON.stringify({ hidden_finished: 0, machines: [], terminals: ls });
      if (args[0] === 'get') {
        if (!Object.prototype.hasOwnProperty.call(get, args[1])) throw hcFailure('not_found', `no terminal ${args[1]}`);
        return JSON.stringify(get[args[1]]);
      }
      if (args[0] === 'send') {
        assert.equal(args.includes('--force'), false, 'the relay never forces a wake trigger into a tab');
        const conditional = args[1] === '--if';
        const to = conditional ? args[3] : args[1];
        if (sendFails[to]) throw sendFails[to];
        state.sent.push({ ifCond: conditional ? args[2] : null, to });
        return '';
      }
      throw new Error(`Unexpected hc call: ${args.join(' ')}`);
    },
  });
  return Object.assign(client, { state });
}

async function callTool(server, name, args = {}) {
  const resp = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { isError: Boolean(resp.result.isError), data: JSON.parse(resp.result.content[0].text) };
}

async function withTerminalId(terminalId, fn) {
  const prev = process.env.HC_TERMINAL_ID;
  process.env.HC_TERMINAL_ID = terminalId;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = prev;
  }
}

test('hc status vocabulary: exactly idle, working, done, blocked, error (as hc defines them); any other word is unknown; the terminal state is live or finished', () => {
  assert.deepEqual([...HC_STATUS_STATES], ['idle', 'working', 'done', 'blocked', 'error']);
  assert.deepEqual([...HC_BLOCKED_KINDS], ['permission', 'question', 'auth']);

  // Each of the five words, as a row of `hc ls` (string) and as a result of `hc get` (object)
  const flags = (t) => ({ idle: t.idle, busy: t.busy, done: t.done, blocked: t.blocked, error: t.error, unknown: t.unknown });
  const none = { idle: false, busy: false, done: false, blocked: false, error: false, unknown: false };
  const flagOf = { idle: 'idle', working: 'busy', done: 'done', blocked: 'blocked', error: 'error' };
  for (const word of HC_STATUS_STATES) {
    for (const terminal of [lsRow('t1', word), getResult('t1', { app: 'claude-code', state: word })]) {
      const seen = detectTerminalActivity(terminal);
      assert.equal(seen.activity, word);
      assert.deepEqual(flags(seen), { ...none, [flagOf[word]]: true }, word);
      assert.equal(seen.live, true);
      assert.equal(seen.isBareShell, false);
    }
  }

  // Words hc does not define are not interpreted: none of the names this code used to guess, and no
  // other spelling of the real ones ("nothing is translated")
  const notHcWords = [
    'busy', 'running', 'thinking', 'active', 'streaming', 'executing',
    'waiting_permission', 'permission', 'stuck', 'approval',
    'errored', 'failed', 'crashed',
    'waiting', 'ready', 'input', 'prompt', 'paused',
    'Idle', 'WORKING', 'Done', ' blocked!', 'compacting', '',
  ];
  for (const word of notHcWords) {
    for (const terminal of [lsRow('t1', word), getResult('t1', { app: 'claude-code', state: word })]) {
      const seen = detectTerminalActivity(terminal);
      assert.equal(seen.activity, 'unknown', JSON.stringify(word));
      assert.deepEqual(flags(seen), { ...none, unknown: true }, JSON.stringify(word));
    }
  }

  // Why a blocked tab waits: hc's `kind`, present in `hc get` only
  for (const kind of HC_BLOCKED_KINDS) {
    const blocked = detectTerminalActivity(getResult('t3', { app: 'claude-code', kind, msg: 'approve plan', state: 'blocked' }));
    assert.deepEqual([blocked.activity, blocked.blocked, blocked.blockedKind], ['blocked', true, kind]);
  }
  assert.equal(detectTerminalActivity(lsRow('t3', 'blocked')).blockedKind, '', 'an hc ls row has no kind');
  assert.equal(detectTerminalActivity(getResult('t3', { app: 'claude-code', state: 'blocked' })).blockedKind, '');
  assert.equal(detectTerminalActivity(getResult('t3', { app: 'claude-code', state: 'blocked', kind: null })).blockedKind, '');
  assert.equal(detectTerminalActivity(getResult('t3', { app: 'claude-code', state: 'working', kind: 'permission' })).blockedKind, '', 'kind counts only while blocked');

  // The terminal's own state: "live" or "finished" (a finished row as `hc ls --all` prints it)
  const finished = detectTerminalActivity(lsRow('t9', 'idle', { state: 'finished', exit_code: 1, reason: 'killed' }));
  assert.deepEqual([finished.activity, finished.live, finished.state, finished.idle], ['not_live', false, 'finished', false]);
  for (const state of ['error', 'crashed', 'Live', 'starting']) {
    const other = detectTerminalActivity(lsRow('t9', 'idle', { state }));
    assert.deepEqual([other.activity, other.live, other.error], ['not_live', false, false], state);
  }
  // A bare shell: no status, the program is a shell
  const shell = detectTerminalActivity({ address: 't2', agent: 'powershell.exe', cwd: 'C:\\Users\\dev', state: 'live', turn: 0, where: 'work / 2' });
  assert.deepEqual([shell.activity, shell.isBareShell, shell.unknown], ['shell', true, false]);
  const shellGet = detectTerminalActivity(getResult('t2', null, { foreground: { argv: ['powershell.exe'], cwd: 'C:\\', name: 'powershell.exe', pid: 1 } }));
  assert.deepEqual([shellGet.activity, shellGet.isBareShell], ['shell', true]);
  // Nothing at all
  assert.deepEqual(flags(detectTerminalActivity(null)), none);
  assert.equal(detectTerminalActivity(null).blockedKind, '');
});

test('hc send failures: the error kind says what happened to the target (blocked, status changed, finished, gone); anything else is a failure of hc', () => {
  assert.deepEqual({ ...HC_TARGET_ERROR_CODES }, {
    blocked: 'HC_TARGET_BLOCKED',
    status_mismatch: 'HC_STATUS_MISMATCH',
    finished: 'HC_TARGET_FINISHED',
    not_found: 'HC_TARGET_NOT_FOUND',
  });
  assert.deepEqual({ ...SEND_REFUSED_WAKE_REASONS }, {
    HC_TARGET_BLOCKED: 'target_blocked',
    HC_STATUS_MISMATCH: 'target_status_changed',
    HC_TARGET_FINISHED: 'target_not_live',
    HC_TARGET_NOT_FOUND: 'target_not_live',
  });

  const hc = makeFakeHc({
    sendFails: {
      't-blocked': hcFailure('blocked', 't-blocked is blocked (permission)', { status: 9 }),
      't-changed': hcFailure('status_mismatch', 't-changed is working, not idle'),
      't-finished': hcFailure('finished', 't-finished has finished'),
      't-gone': hcFailure('not_found', 'no terminal t-gone', { stream: 'stderr' }),
      't-unavailable': hcFailure('unavailable', 'the core is not running'),
      't-plain': Object.assign(new Error('Command failed'), { status: 1, stderr: 'something broke' }),
    },
  });
  const expectations = [
    ['t-blocked', 'HC_TARGET_BLOCKED', 'blocked', 't-blocked is blocked (permission)'],
    ['t-changed', 'HC_STATUS_MISMATCH', 'status_mismatch', 't-changed is working, not idle'],
    ['t-finished', 'HC_TARGET_FINISHED', 'finished', 't-finished has finished'],
    ['t-gone', 'HC_TARGET_NOT_FOUND', 'not_found', 'no terminal t-gone'],
    ['t-unavailable', 'HC_EXEC_ERROR', 'unavailable', 'the core is not running'],
    ['t-plain', 'HC_EXEC_ERROR', undefined, 'something broke'],
  ];
  for (const [to, code, kind, error] of expectations) {
    for (const options of [{}, { ifIdle: true }]) {
      const res = hc.sendTrigger(to, 'ping', options);
      assert.deepEqual([res.ok, res.code, res.kind, res.error], [false, code, kind, error], `${to} ${JSON.stringify(options)}`);
    }
  }
  assert.deepEqual(hc.state.sent, []);
  // `--if idle` is passed exactly so, and only when asked for
  hc.sendTrigger('t-ok', 'ping', { ifIdle: true });
  hc.sendTrigger('t-ok', 'ping');
  assert.deepEqual(hc.state.calls.slice(-2), [['send', '--if', 'idle', 't-ok', 'ping'], ['send', 't-ok', 'ping']]);
});

test('relay_send and relay_tabs with the real vocabulary: done is wakeable (sent without --if), idle keeps --if idle, refusals are reported by kind, relay_tabs shows blockedKind', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const agent = (address, state, extra = {}) => getResult(address, { app: 'claude-code', state, ...extra });
    const hc = makeFakeHc({
      ls: [
        lsRow('t-idle', 'idle'),
        lsRow('t-done', 'done'),
        lsRow('t-working', 'working'),
        lsRow('t-blocked', 'blocked'),
        lsRow('t-question', 'blocked'),
        lsRow('t-error', 'error'),
        lsRow('t-odd', 'paused'),
        lsRow('pc2/t3', 'blocked'),
      ],
      get: {
        't-idle': agent('t-idle', 'idle'),
        't-done': agent('t-done', 'done'),
        't-working': agent('t-working', 'working'),
        't-blocked': agent('t-blocked', 'blocked', { kind: 'permission', msg: 'approve plan' }),
        't-question': agent('t-question', 'blocked', { kind: 'question' }),
        't-error': agent('t-error', 'error'),
        't-odd': agent('t-odd', 'paused'),
        // What `hc get` said a moment ago no longer holds when `hc send` runs:
        't-idle-then-working': agent('t-idle-then-working', 'idle'),
        't-done-then-blocked': agent('t-done-then-blocked', 'done'),
        't-idle-then-finished': agent('t-idle-then-finished', 'idle'),
        't-working-then-gone': agent('t-working-then-gone', 'working'),
        't-idle-hc-broken': agent('t-idle-hc-broken', 'idle'),
      },
      sendFails: {
        't-blocked': hcFailure('blocked', 't-blocked is blocked (permission)', { status: 9 }),
        't-idle-then-working': hcFailure('status_mismatch', 't-idle-then-working is working, not idle'),
        't-done-then-blocked': hcFailure('blocked', 't-done-then-blocked is blocked (question)', { status: 9 }),
        't-idle-then-finished': hcFailure('finished', 't-idle-then-finished has finished'),
        't-working-then-gone': hcFailure('not_found', 'no terminal t-working-then-gone'),
        't-idle-hc-broken': hcFailure('unavailable', 'the core is not running'),
      },
    });
    const server = createMcpServer({ store, hcClient: hc });

    await withTerminalId('t1', async () => {
      const send = async (to, wake) => {
        const before = hc.state.sent.length;
        const res = await callTool(server, 'relay_send', { to_terminal_id: to, message: `to ${to}`, wake });
        assert.equal(res.isError, false, `${to}/${wake}`);
        assert.equal(res.data.queued, true, 'the message is stored whatever happens to the wake');
        return { ...res.data, sentNow: hc.state.sent.slice(before) };
      };
      const expectations = [
        // [target, wake, woke, wakeReason, --if condition of the send that went through]
        ['t-idle', 'auto', true, 'sent_auto_idle', 'idle'],
        ['t-done', 'auto', true, 'sent_auto_done', null],
        ['t-done', 'always', true, 'sent_always', null],
        ['t-working', 'auto', false, 'target_busy'],
        ['t-working', 'always', true, 'sent_always', null],
        ['t-blocked', 'auto', false, 'target_blocked'],
        ['t-blocked', 'always', false, 'target_blocked'],
        ['t-error', 'auto', false, 'target_error'],
        ['t-error', 'always', false, 'target_error'],
        ['t-odd', 'auto', false, 'target_status_unknown'],
        ['t-idle-then-working', 'auto', false, 'target_status_changed'],
        ['t-done-then-blocked', 'auto', false, 'target_blocked'],
        ['t-idle-then-finished', 'auto', false, 'target_not_live'],
        ['t-working-then-gone', 'always', false, 'target_not_live'],
        ['t-idle-hc-broken', 'auto', false, 'hc_send_failed'],
      ];
      for (const [to, wake, woke, reason, ifCond] of expectations) {
        const res = await send(to, wake);
        assert.deepEqual([res.woke, res.wakeReason], [woke, reason], `${to}/${wake}`);
        if (woke) {
          assert.deepEqual(res.sentNow, [{ ifCond, to }], `${to}/${wake}`);
          assert.equal(res.wakeError, undefined);
        } else {
          assert.deepEqual(res.sentNow, [], `${to}/${wake}: nothing was typed`);
        }
      }
      assert.equal((await send('t-idle-then-working', 'auto')).wakeError, 't-idle-then-working is working, not idle');
      assert.equal((await send('t-idle-hc-broken', 'auto')).wakeError, 'the core is not running');
      assert.equal(countPendingMessages('t-done', { globalDir: env.globalDir }), 2);

      // relay_tabs: the status word as activity, and why a blocked tab waits
      const tabs = (await callTool(server, 'relay_tabs')).data.tabs;
      const byId = new Map(tabs.map((tab) => [tab.terminalId, tab]));
      assert.deepEqual(
        tabs.map((tab) => [tab.terminalId, tab.activity, tab.blockedKind]),
        [
          ['t-idle', 'idle', null],
          ['t-done', 'done', null],
          ['t-working', 'working', null],
          ['t-blocked', 'blocked', 'permission'],
          ['t-question', 'blocked', 'question'],
          ['t-error', 'error', null],
          ['t-odd', 'unknown', null],
          ['pc2/t3', 'blocked', null],
        ],
      );
      assert.deepEqual([byId.get('t-done').done, byId.get('t-done').idle, byId.get('t-done').busy], [true, false, false]);
      assert.deepEqual([byId.get('t-idle').done, byId.get('t-idle').idle], [false, true]);
      assert.equal(byId.get('t-odd').statusUnknown, true);
      // Only blocked tabs of this machine are asked for again
      const getsForTabs = hc.state.calls.filter((args) => args[0] === 'get').slice(-2).map((args) => args[1]);
      assert.deepEqual(getsForTabs, ['t-blocked', 't-question']);
    });
  } finally {
    store.close();
    env.cleanup();
  }
});

test('relay tool descriptions take the retention time of delivered messages from INBOX_DELIVERED_RETENTION_MS', () => {
  assert.equal(describeRetention(INBOX_DELIVERED_RETENTION_MS), '24 hours');
  assert.equal(describeRetention(), '24 hours');
  assert.equal(describeRetention(60 * 60 * 1000), '1 hour');
  assert.equal(describeRetention(48 * 60 * 60 * 1000), '48 hours');
  assert.equal(describeRetention(90 * 60 * 1000), '90 minutes');
  assert.equal(describeRetention(60 * 1000), '1 minute');

  const text = describeRetention(INBOX_DELIVERED_RETENTION_MS);
  const tools = createRelayTools({ projectDir: os.tmpdir(), globalDir: path.join(os.tmpdir(), 'herdr-cortex-no-store'), hcClient: makeFakeHc(), projectEnabled: true });
  const description = (name) => tools.find((tool) => tool.name === name).description;
  assert.ok(description('relay_tabs').includes(`heldInboxCount = messages already injected and kept for ${text}.`));
  assert.ok(description('relay_inbox').includes(`A message a hook injected is kept for ${text} as delivered`));
  assert.match(description('relay_tabs'), /activity is idle \| working \| done \| blocked \| error \| unknown \| shell \| not_live/);
  assert.match(description('relay_tabs'), /blockedKind/);
  // The number appears nowhere in the source of the tool definitions as a literal
  const source = fs.readFileSync(new URL('../src/relay/tools.mjs', import.meta.url), 'utf8');
  const withoutComments = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
  assert.equal(/\b24\b/.test(withoutComments), false, 'no hard-coded "24" in src/relay/tools.mjs');
});

test('the server instructions take the retention time of delivered messages from INBOX_DELIVERED_RETENTION_MS', () => {
  assert.equal(describeRetentionKorean(INBOX_DELIVERED_RETENTION_MS), '24시간');
  assert.equal(describeRetentionKorean(), '24시간');
  assert.equal(describeRetentionKorean(60 * 60 * 1000), '1시간');
  assert.equal(describeRetentionKorean(48 * 60 * 60 * 1000), '48시간');
  assert.equal(describeRetentionKorean(90 * 60 * 1000), '90분');
  assert.equal(describeRetentionKorean(60 * 1000), '1분');

  const text = describeRetentionKorean(INBOX_DELIVERED_RETENTION_MS);
  assert.ok(SERVER_INSTRUCTIONS.includes(`훅이 이미 주입한 메시지는 ${text} 보관되며 include_delivered: true로 다시 조회`));
  // The number appears nowhere in the source of the server as a literal
  const source = fs.readFileSync(new URL('../src/mcp/server.mjs', import.meta.url), 'utf8');
  const withoutComments = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
  assert.equal(/\b24\b/.test(withoutComments), false, 'no hard-coded "24" in src/mcp/server.mjs');
});
