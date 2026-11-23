import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, atomicWriteJson, atomicWriteText } from '../src/core/config.mjs';
import { CortexStore } from '../src/core/store.mjs';
import {
  EXCLUDED_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
  createMcpServer,
} from '../src/mcp/server.mjs';
import { recordSession } from '../src/revive/tracker.mjs';
import {
  createHcClient,
  detectTerminalActivity,
  parseTerminalAddress,
  sanitizeSingleLineTrigger,
} from '../src/relay/hc.mjs';
import {
  INBOX_DELIVERED_DIR,
  INBOX_DELIVERED_RETENTION_MS,
  INBOX_LOCK_FILE,
  INBOX_PREVIEW_MAX_CHARS,
  ackMessage,
  countInboxMessages,
  countPendingMessages,
  deliverInboxForHook,
  drainInbox,
  enqueueMessage,
  formatInboxForHook,
  formatInboxForHookDetailed,
  formatLongMessageNotice,
  getLegacyProjectInboxDir,
  getTerminalInboxDir,
  peekInbox,
} from '../src/relay/inbox.mjs';
import { handleClaudeSessionStart, handleClaudeUserPrompt } from '../src/hooks/claude.mjs';
import { handleAntigravityPreInvocation } from '../src/hooks/antigravity.mjs';
import { approveProject } from '../src/core/trust.mjs';
import { UNTRUSTED_MEMORY_PREAMBLE } from '../src/core/budget.mjs';

// Safety net: anything in this file that forgets to pass its temp `globalDir` (or the legacy revive home)
// lands in a throw-away folder, never in the real home directory.
const FALLBACK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cortex-relay-home-'));
process.env.HERDR_CORTEX_TEST_HOME = FALLBACK_HOME;
delete process.env.HERDR_CORTEX_HOME;
process.on('exit', () => {
  try {
    fs.rmSync(FALLBACK_HOME, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// The fake `execFileSync` of these tests never starts a process; an absolute `hcBin` is used as is, so the
// client does not look for a real `hc` on PATH.
const FAKE_HC_BIN = path.join(os.tmpdir(), 'herdr-cortex-test-bin', 'hc.exe');
// Characters the relay block spends on its fixed preamble line (plus the line break before it).
const INBOX_PREAMBLE_COST = UNTRUSTED_MEMORY_PREAMBLE.length + 1;

function makeTempEnv(prefix = 'herdr-cortex-relay-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  const homeDir = path.join(root, 'home');
  const promptsDir = path.join(root, 'prompts');
  for (const dir of [projectDir, globalDir, homeDir, promptsDir]) fs.mkdirSync(dir, { recursive: true });
  atomicWriteText(path.join(promptsDir, 'HEAD_CORE.md'), '# HEAD_CORE\n\n- Delegate high-resolution work.\n');
  // The project folder of every test environment is approved, as a user would do with cortex-trust.
  approveProject(projectDir, { globalDir });
  return {
    root,
    projectDir,
    globalDir,
    homeDir,
    promptsDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// `hc` 0.1.21 output, in the shapes captured from a real installation (paths and labels are stand-ins).
//   hc ls --json : rows with `status` as a plain string, absent for a bare shell; `agent` is the app name
//                  of an agent tab and the shell's executable name for a bare shell; a tab on another
//                  machine has an address like "pc2/t3".
//   hc get --json: `status` is an object { app, state, msg? } for an agent tab and null for a bare shell.
// ---------------------------------------------------------------------------------------------

const REAL_HC_LS = {
  hidden_finished: 1,
  machines: [{ name: 'pc2', state: 'connected' }],
  terminals: [
    { address: 't1', agent: 'claude-code', cwd: 'C:\\Users\\dev', state: 'live', status: 'working', turn: 50, where: '작업 / 1' },
    { address: 't2', agent: 'powershell.exe', cwd: 'C:\\Users\\dev\\Desktop\\작업', state: 'live', turn: 0, where: '작업 / 2' },
    { address: 'pc2/t3', agent: 'claude-code', cwd: 'C:\\Users\\other', state: 'live', status: 'idle', turn: 1, where: 'projects / Claude Code' },
  ],
};

// A tab that is waiting on a permission dialog, as hc 0.1.21 printed it (paths and labels are stand-ins).
const REAL_HC_BLOCKED_LS_ROW = { address: 't3', agent: 'claude-code', cwd: 'C:\\Users\\dev\\proj', state: 'live', status: 'blocked', turn: 3, where: 'proj / Claude Code' };
const REAL_HC_BLOCKED_GET_STATUS = { app: 'claude-code', kind: 'permission', msg: 'approve plan', state: 'blocked' };
// `hc send` to that tab types nothing, exits with code 9 and prints this.
const REAL_HC_SEND_BLOCKED_EXIT_CODE = 9;
const REAL_HC_SEND_BLOCKED_OUTPUT = '{"error":{"kind":"blocked","message":"t3 is blocked (permission)","hint":"typing would answer its dialog; ..."}}';

function hcLsRow({ address, agent = 'claude-code', cwd = 'C:\\Users\\dev', status, state = 'live', turn = 1, where = 'work / 1' }) {
  return { address, agent, cwd, state, ...(status ? { status } : {}), turn, where };
}

// `hc get <id> --json` of an agent tab. `status` may be overridden to model output this code cannot interpret.
function hcGetAgent({ address, cwd = 'C:\\Users\\dev', statusState = 'idle', msg, state = 'live', status, where = 'work / 1' }) {
  return {
    address,
    cwd: 'C:\\Users\\dev',
    foreground: { argv: ['C:\\Users\\dev\\.local\\bin\\claude.exe'], cwd, name: 'claude.exe', pid: 9432 },
    labels: { where },
    state,
    status: status !== undefined
      ? status
      : { app: 'claude-code', ...(msg ? { msg } : {}), state: statusState },
  };
}

function hcGetShell({ address, cwd = 'C:\\Users\\dev', where = 'work / 2' }) {
  return {
    address,
    cwd,
    foreground: {
      argv: ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoExit'],
      cwd,
      name: 'powershell.exe',
      pid: 7120,
    },
    labels: { where },
    state: 'live',
    status: null,
  };
}

/**
 * An hc client whose `hc` is a table: `ls` (object or function) answers `hc ls --json`, `get[id]` answers
 * `hc get <id> --json`. Every call is recorded in `calls`; `sent` lists the `hc send` calls
 * ({ ifCond, to, trigger }). `rejectIfFlag` makes `hc send --if` fail like an hc that does not know the flag.
 * `hc send` to a terminal listed in `blockedSend` fails the way the real hc does for a tab that waits on a
 * dialog (exit code 9, the JSON error on `blockedStream`); `refused` lists those attempts.
 */
function makeFakeHc({ ls = { terminals: [] }, get = {} } = {}) {
  const state = { calls: [], sent: [], refused: [], rejectIfFlag: false, blockedSend: new Set(), blockedStream: 'stdout' };
  const client = createHcClient({
    hcBin: FAKE_HC_BIN,
    execFileSync(bin, args, options) {
      // hc is always started by absolute path, from the folder that contains it
      assert.equal(bin, FAKE_HC_BIN);
      assert.equal(options.cwd, path.dirname(FAKE_HC_BIN));
      state.calls.push([...args]);
      if (args[0] === 'ls') {
        assert.deepEqual(args, ['ls', '--json']);
        return JSON.stringify(typeof ls === 'function' ? ls() : ls);
      }
      if (args[0] === 'get') {
        assert.equal(args[2], '--json');
        if (!Object.prototype.hasOwnProperty.call(get, args[1])) {
          return JSON.stringify({ error: `terminal ${args[1]} not found` });
        }
        return JSON.stringify(get[args[1]]);
      }
      if (args[0] === 'send') {
        assert.equal(args.includes('--force'), false, 'the relay never forces a wake trigger into a tab');
        const target = args[1] === '--if' ? args[3] : args[1];
        if (state.blockedSend.has(target)) {
          state.refused.push(target);
          const err = new Error(`Command failed: hc send ${target}`);
          err.status = REAL_HC_SEND_BLOCKED_EXIT_CODE;
          err.stdout = state.blockedStream === 'stdout' ? REAL_HC_SEND_BLOCKED_OUTPUT.replace('t3', target) : '';
          err.stderr = state.blockedStream === 'stderr' ? REAL_HC_SEND_BLOCKED_OUTPUT.replace('t3', target) : '';
          throw err;
        }
        if (args[1] === '--if') {
          if (state.rejectIfFlag) {
            const err = new Error('unknown flag: --if');
            err.stderr = 'unknown flag: --if';
            throw err;
          }
          state.sent.push({ ifCond: args[2], to: args[3], trigger: args[4] });
        } else {
          state.sent.push({ ifCond: null, to: args[1], trigger: args[2] });
        }
        return '';
      }
      throw new Error(`Unexpected hc call: ${args.join(' ')}`);
    },
  });
  return Object.assign(client, { state });
}

async function callTool(server, name, args = {}, meta) {
  const resp = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  });
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

function claudePrompt(env, terminalId, cwd = env.projectDir) {
  const out = handleClaudeUserPrompt({ cwd }, { terminalId, globalDir: env.globalDir });
  return out.hookSpecificOutput?.additionalContext || '';
}

// ---------------------------------------------------------------------------------------------
// A1: the inbox lives in the global store
// ---------------------------------------------------------------------------------------------

test('relay/inbox: messages live in <globalDir>/state/inbox/<terminalId>/; terminalId validation, FIFO enqueue/peek, ack by id, .broken/ quarantine', () => {
  const env = makeTempEnv();
  const opts = { globalDir: env.globalDir };
  try {
    // 1. Strict terminalId validation blocks traversal, leading dash option injection, reserved Windows names
    //    and addresses of other machines; nothing is created for a rejected id
    for (const badId of ['../escape', 'tab/1', 'tab\\1', '-flag', '--json', '_lead', 'CON', 'nul', 'a'.repeat(65), '', 'pc2/t3']) {
      assert.throws(() => enqueueMessage(badId, { message: 'x' }, opts), /Invalid terminalId/);
      assert.throws(() => drainInbox(badId, opts), /Invalid terminalId/);
    }
    assert.equal(fs.existsSync(path.join(env.globalDir, 'state', 'inbox')), false);

    // 2. Reading an inbox that does not exist creates nothing
    const inboxDir = getTerminalInboxDir('tab-2', opts);
    assert.equal(inboxDir, path.join(env.globalDir, 'state', 'inbox', 'tab-2'));
    assert.deepEqual(drainInbox('tab-2', opts).messages, []);
    assert.equal(peekInbox('tab-2', opts).count, 0);
    assert.equal(countPendingMessages('tab-2', opts), 0);
    assert.deepEqual(deliverInboxForHook('tab-2', opts).text, '');
    assert.equal(fs.existsSync(inboxDir), false);

    // 3. Enqueue two messages atomically and peek non-destructively
    const m1 = enqueueMessage('tab-2', {
      id: 'msg-1',
      from_terminal_id: 'tab-1',
      message: 'First message\nwith multiline body',
      context_docs: ['dec-1', 'base-p0'],
    }, opts);
    const m2 = enqueueMessage('tab-2', {
      id: 'msg-2',
      from_terminal_id: 'tab-1',
      message: 'Second message',
    }, opts);
    assert.equal(path.dirname(m1.filePath), inboxDir);
    assert.match(m1.fileName, /^\d{15}-[0-9a-f]{8}\.json$/);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(m1.filePath, 'utf8'))), [
      'id', 'from_terminal_id', 'to_terminal_id', 'message', 'context_docs', 'created_at',
    ]);
    assert.equal(fs.existsSync(path.join(env.projectDir, '.memory')), false, 'nothing is created in a project folder');

    const peeked = peekInbox('tab-2', opts);
    assert.equal(peeked.count, 2);
    assert.deepEqual(peeked.messages.map((m) => m.id), ['msg-1', 'msg-2']);
    assert.deepEqual(peeked.messages[0].context_docs, ['dec-1', 'base-p0']);
    assert.deepEqual(peeked.messages.map((m) => m.announced), [false, false]);
    assert.equal(countPendingMessages('tab-2', opts), 2);

    // 4. ackMessage removes a specific message (by id or by file stem) and leaves no lock behind
    assert.deepEqual(ackMessage('tab-2', 'msg-1', opts), {
      acked: true,
      terminalId: 'tab-2',
      messageId: 'msg-1',
      fileName: m1.fileName,
    });
    assert.deepEqual(ackMessage('tab-2', 'no-such-message', opts), { acked: false, terminalId: 'tab-2', messageId: 'no-such-message' });
    assert.throws(() => ackMessage('tab-2', '../escape', opts), /Invalid messageId/);
    assert.equal(peekInbox('tab-2', opts).count, 1);
    assert.deepEqual(fs.readdirSync(inboxDir), [m2.fileName]);

    // 5. Files that are not message JSON: a peek reports them, a drain quarantines them into .broken/
    atomicWriteText(path.join(inboxDir, '999999999999999-corrupt.json'), '{not valid json');
    atomicWriteText(path.join(inboxDir, '999999999999998-noshape.json'), '{"id":"x"}');
    const peekedCorrupt = peekInbox('tab-2', opts);
    assert.equal(peekedCorrupt.count, 1);
    assert.equal(peekedCorrupt.notices.filter((n) => n.startsWith('Unreadable inbox file')).length, 2);

    const drained = drainInbox('tab-2', opts);
    assert.equal(drained.busy, false);
    assert.deepEqual(drained.messages.map((m) => m.id), ['msg-2']);
    assert.equal(drained.notices.filter((n) => n.startsWith('Quarantined corrupt inbox file')).length, 2);
    assert.deepEqual(fs.readdirSync(path.join(inboxDir, '.broken')).sort(), [
      '999999999999998-noshape.json',
      '999999999999999-corrupt.json',
    ]);

    // Messages are never moved to claim them: until ack() they are still in the inbox
    assert.equal(peekInbox('tab-2', opts).count, 1);
    assert.deepEqual(drained.ack(), { acked: 1, kept: 0 });
    assert.equal(drained.ack().alreadyAcked, true);
    assert.equal(peekInbox('tab-2', opts).count, 0);
    assert.deepEqual(fs.readdirSync(inboxDir), ['.broken']);

    // 6. formatInboxForHook strictly never exceeds maxChars including the footer
    const longMsgs = [
      { id: 'm-1', from_terminal_id: 't1', message: 'A'.repeat(120), context_docs: [] },
      { id: 'm-2', from_terminal_id: 't1', message: 'B'.repeat(120), context_docs: [] },
    ];
    for (const budget of [40, 90, 180, 220, 400, 700]) {
      const formatted = formatInboxForHook(longMsgs, { maxChars: budget });
      assert.ok(formatted.length <= budget, `Expected length <= ${budget}, got ${formatted.length}`);
    }
  } finally {
    env.cleanup();
  }
});

test('relay/inbox migration: what an approved project still keeps in <project>/.memory/state/inbox/<tab>/ moves to the global inbox once, and the emptied folder is removed', () => {
  const env = makeTempEnv('cortex-inbox-migrate-');
  const opts = { globalDir: env.globalDir };
  try {
    const legacyDir = getLegacyProjectInboxDir(env.projectDir, 'tab-m');
    assert.equal(legacyDir, path.join(env.projectDir, '.memory', 'state', 'inbox', 'tab-m'));
    const legacyMessage = (id, text) => ({
      id,
      from_terminal_id: 'tab-9',
      to_terminal_id: 'tab-m',
      message: text,
      context_docs: [],
      created_at: '2026-11-20T10:00:00.000Z',
    });
    atomicWriteJson(path.join(legacyDir, '000001700000000-aaaa0001.json'), legacyMessage('old-1', 'Old message one'));
    atomicWriteJson(path.join(legacyDir, '000001700000001-aaaa0002.json'), legacyMessage('old-2', 'Old message two'));
    // a claim directory left by a consumer of the previous layout that died, and a quarantined file
    atomicWriteJson(path.join(legacyDir, '.taking-999999-crashed', '000001600000000-bbbb0001.json'), legacyMessage('old-claimed', 'Claimed by a dead process'));
    atomicWriteText(path.join(legacyDir, '.broken', '000001500000000-bad.json'), 'not json');
    // another terminal's old inbox in the same project
    const otherLegacyDir = getLegacyProjectInboxDir(env.projectDir, 'tab-other');
    atomicWriteJson(path.join(otherLegacyDir, '000001700000002-cccc0001.json'), { ...legacyMessage('other-1', 'For the other tab'), to_terminal_id: 'tab-other' });

    enqueueMessage('tab-m', { id: 'new-1', from_terminal_id: 'tab-9', message: 'Sent after the move' }, opts);

    // Without the session's project nothing outside the global inbox is looked at
    assert.deepEqual(peekInbox('tab-m', opts).messages.map((m) => m.id), ['new-1']);
    assert.equal(fs.existsSync(legacyDir), true);

    // With it: moved (oldest first by file name), the old directory and its .broken/ are gone
    const peeked = peekInbox('tab-m', { ...opts, projectDir: env.projectDir, isPidAlive: () => false });
    assert.deepEqual(peeked.messages.map((m) => m.id), ['old-claimed', 'old-1', 'old-2', 'new-1']);
    assert.ok(peeked.notices.some((n) => /Recovered 1 message\(s\) from stale claim dir \.taking-999999-crashed \(dead pid 999999\)/.test(n)));
    assert.ok(peeked.notices.includes("Moved 3 message(s) from the project's old inbox into the global inbox."));
    assert.equal(fs.existsSync(legacyDir), false);
    assert.equal(fs.existsSync(otherLegacyDir), true, 'other terminals are left alone');
    const inboxDir = getTerminalInboxDir('tab-m', opts);
    assert.deepEqual(fs.readdirSync(path.join(inboxDir, '.broken')), ['000001500000000-bad.json']);
    assert.equal(fs.existsSync(path.join(inboxDir, INBOX_LOCK_FILE)), false);

    // A second look moves nothing and reports nothing
    const again = peekInbox('tab-m', { ...opts, projectDir: env.projectDir });
    assert.equal(again.count, 4);
    assert.deepEqual(again.notices, []);

    // The hooks do the same move for their terminal, deliver the message, and remove the empty old inbox folder
    const otherCtx = claudePrompt(env, 'tab-other');
    assert.match(otherCtx, /^> For the other tab$/m);
    assert.equal(fs.existsSync(path.join(env.projectDir, '.memory', 'state', 'inbox')), false);
    assert.equal(claudePrompt(env, 'tab-other'), '');

    const mCtx = claudePrompt(env, 'tab-m');
    for (const text of ['Claimed by a dead process', 'Old message one', 'Old message two', 'Sent after the move']) {
      assert.ok(mCtx.includes(`> ${text}`), text);
    }
    assert.equal(peekInbox('tab-m', opts).count, 0);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// A3: one consumer at a time
// ---------------------------------------------------------------------------------------------

test('relay/inbox lock: one consumer at a time (.lock, exclusive create, pid + time); a loser does not wait and loses nothing; locks of dead or stuck consumers are replaced', () => {
  const env = makeTempEnv('cortex-inbox-lock-');
  const opts = { globalDir: env.globalDir };
  try {
    for (let i = 1; i <= 3; i++) {
      enqueueMessage('tab-L', { id: `m-${i}`, from_terminal_id: 'tab-1', message: `Message number ${i}` }, opts);
    }
    const inboxDir = getTerminalInboxDir('tab-L', opts);
    assert.equal(INBOX_LOCK_FILE, '.lock');
    const lockPath = path.join(inboxDir, INBOX_LOCK_FILE);
    const readLock = () => JSON.parse(fs.readFileSync(lockPath, 'utf8'));

    // The first consumer holds the lock from the claim until its ack
    const first = drainInbox('tab-L', opts);
    assert.equal(first.busy, false);
    assert.equal(first.messages.length, 3);
    const held = readLock();
    assert.deepEqual(Object.keys(held), ['pid', 'acquiredAt', 'token']);
    assert.equal(held.pid, process.pid);
    assert.ok(Math.abs(Date.now() - held.acquiredAt) < 60_000);

    // Everybody else gets "nothing to deliver now" at once, and the messages stay
    const started = Date.now();
    const second = drainInbox('tab-L', opts);
    assert.equal(second.busy, true);
    assert.deepEqual(second.messages, []);
    assert.deepEqual(second.notices, []);
    assert.deepEqual(second.ack(), { acked: 0, kept: 0 });
    const hookTry = deliverInboxForHook('tab-L', { ...opts, maxChars: 5000 });
    assert.equal(hookTry.busy, true);
    assert.equal(hookTry.text, '');
    assert.equal(claudePrompt(env, 'tab-L'), '', 'the hook injects nothing while another consumer delivers');
    assert.deepEqual(ackMessage('tab-L', 'm-1', opts), { acked: false, terminalId: 'tab-L', messageId: 'm-1', busy: true });
    assert.ok(Date.now() - started < 1500, 'nobody waited for the lock');
    assert.equal(peekInbox('tab-L', opts).count, 3, 'nothing was lost (and a peek needs no lock)');
    assert.equal(readLock().token, held.token, 'the holder keeps its lock');

    // The holder acknowledges part of the batch: the lock is released, the rest is delivered by the next drain
    assert.deepEqual(first.ack(['m-1']), { acked: 1, kept: 2 });
    assert.equal(fs.existsSync(lockPath), false);
    const later = deliverInboxForHook('tab-L', { ...opts, maxChars: 5000 });
    assert.deepEqual(later.deliveredIds, ['m-2', 'm-3']);
    assert.equal(later.busy, false);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(peekInbox('tab-L', opts).count, 0);

    // release() without ack keeps every message
    enqueueMessage('tab-L', { id: 'm-4', from_terminal_id: 'tab-1', message: 'Message number 4' }, opts);
    const peeking = drainInbox('tab-L', opts);
    assert.equal(fs.existsSync(lockPath), true);
    peeking.release();
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(peekInbox('tab-L', opts).count, 1);

    // A lock whose process is gone is replaced at once, without any notice about broken files
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquiredAt: Date.now(), token: 'dead' }));
    const afterDead = drainInbox('tab-L', { ...opts, isPidAlive: (pid) => pid !== 999999 });
    assert.equal(afterDead.busy, false);
    assert.deepEqual(afterDead.messages.map((m) => m.id), ['m-4']);
    assert.deepEqual(afterDead.notices, []);
    assert.equal(readLock().pid, process.pid);
    afterDead.release();

    // A live process keeps its lock ...
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 12345, acquiredAt: Date.now() - 1000, token: 'slow' }));
    assert.equal(drainInbox('tab-L', { ...opts, isPidAlive: () => true }).busy, true);
    assert.equal(readLock().token, 'slow');
    // ... unless the lock is older than the staleness limit
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 12345, acquiredAt: Date.now() - 700_000, token: 'stuck' }));
    assert.equal(drainInbox('tab-L', { ...opts, isPidAlive: () => true, staleMs: 800_000 }).busy, true);
    const afterStuck = drainInbox('tab-L', { ...opts, isPidAlive: () => true, staleMs: 600_000 });
    assert.equal(afterStuck.busy, false);
    assert.equal(readLock().pid, process.pid);
    afterStuck.release();

    // A lock file without content yet (its owner is just writing it) is respected; one left empty is not
    fs.writeFileSync(lockPath, '');
    assert.equal(drainInbox('tab-L', opts).busy, true);
    const afterEmpty = drainInbox('tab-L', { ...opts, nowMs: Date.now() + 60_000 });
    assert.equal(afterEmpty.busy, false);
    assert.deepEqual(afterEmpty.ack(), { acked: 1, kept: 0 });
    // Nothing pending and no lock is left; what the hook delivered above (m-2, m-3) is held in .delivered/
    assert.deepEqual(fs.readdirSync(inboxDir), [INBOX_DELIVERED_DIR]);
    assert.equal(fs.readdirSync(path.join(inboxDir, INBOX_DELIVERED_DIR)).length, 2);
  } finally {
    env.cleanup();
  }
});

const DRAIN_WORKER_SOURCE = `
import fs from 'node:fs';
const [inboxModuleUrl, globalDir, terminalId, goFile, stopFile] = process.argv.slice(2);
const { drainInbox } = await import(inboxModuleUrl);
const pause = new Int32Array(new SharedArrayBuffer(4));
const delivered = [];
const notices = [];
let busy = 0;
let rounds = 0;
let emptyAfterStop = 0;
while (!fs.existsSync(goFile)) Atomics.wait(pause, 0, 0, 2);
while (emptyAfterStop < 25) {
  rounds++;
  const drained = drainInbox(terminalId, { globalDir });
  notices.push(...drained.notices);
  if (drained.busy) {
    busy++;
    continue;
  }
  if (drained.messages.length === 0) {
    if (fs.existsSync(stopFile)) emptyAfterStop++;
    Atomics.wait(pause, 0, 0, 1);
    continue;
  }
  emptyAfterStop = 0;
  // Like a hook with a small budget: deliver a few, leave the rest for a later drain.
  const take = drained.messages.slice(0, 3).map((m) => m.id);
  const res = drained.ack(take);
  if (res.acked !== take.length) notices.push('ack mismatch: ' + JSON.stringify(res));
  delivered.push(...take);
}
process.stdout.write(JSON.stringify({ delivered, notices, busy, rounds }));
`;

test('relay/inbox concurrency: several processes draining one inbox deliver every message exactly once, with no quarantine notice and nothing lost', async () => {
  const env = makeTempEnv('cortex-inbox-procs-');
  const opts = { globalDir: env.globalDir };
  const WORKERS = 6;
  const MESSAGES = 240;
  try {
    const workerPath = path.join(env.root, 'drain-worker.mjs');
    fs.writeFileSync(workerPath, DRAIN_WORKER_SOURCE);
    const goFile = path.join(env.root, 'go');
    const stopFile = path.join(env.root, 'stop');
    const inboxModuleUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'relay', 'inbox.mjs')).href;

    // A first batch is already waiting when the workers start at the same moment
    const sentIds = [];
    const send = () => {
      const id = `msg-${String(sentIds.length).padStart(4, '0')}`;
      enqueueMessage('tab-shared', { id, from_terminal_id: 'tab-1', message: `payload of ${id}` }, opts);
      sentIds.push(id);
    };
    for (let i = 0; i < 60; i++) send();

    const workers = Array.from({ length: WORKERS }, () => new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--no-warnings', workerPath, inboxModuleUrl, env.globalDir, 'tab-shared', goFile, stopFile],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`drain worker exited with ${code}: ${stderr}`));
        else resolve(JSON.parse(stdout));
      });
    }));

    await new Promise((resolve) => setTimeout(resolve, 300)); // let every worker reach its start line
    fs.writeFileSync(goFile, '');
    // ... and more messages keep arriving while they drain
    while (sentIds.length < MESSAGES) {
      for (let i = 0; i < 6 && sentIds.length < MESSAGES; i++) send();
      await new Promise((resolve) => setImmediate(resolve));
    }
    fs.writeFileSync(stopFile, '');

    const results = await Promise.all(workers);
    const delivered = results.flatMap((r) => r.delivered);
    const notices = results.flatMap((r) => r.notices);
    const busyTotal = results.reduce((sum, r) => sum + r.busy, 0);

    assert.equal(delivered.length, MESSAGES, 'every message was delivered, none twice');
    assert.deepEqual([...new Set(delivered)].sort(), [...sentIds].sort(), 'exactly the messages that were sent');
    assert.deepEqual(notices, [], 'no quarantine or recovery notices');
    assert.ok(busyTotal > 0, 'the workers really competed for the lock');
    assert.ok(results.filter((r) => r.delivered.length > 0).length >= 2, 'more than one process delivered messages');

    const inboxDir = getTerminalInboxDir('tab-shared', opts);
    assert.deepEqual(fs.readdirSync(inboxDir), [], 'no message, lock file or .broken folder is left');
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// A4: a message longer than the injection budget
// ---------------------------------------------------------------------------------------------

test('relay/inbox partial delivery: a message that fits but has no room left waits for the next prompt; only fully injected messages are acknowledged', () => {
  const env = makeTempEnv('cortex-partial-ack-');
  const opts = { globalDir: env.globalDir };
  try {
    enqueueMessage('tab-p1', { id: 'msg-fit', from_terminal_id: 'tab-0', message: 'Short message 1' }, opts);
    enqueueMessage('tab-p1', { id: 'msg-wait', from_terminal_id: 'tab-0', message: 'Second message '.repeat(20) }, opts);

    // Block of 170 characters next to the preamble: the first message fits, the second does not fit the
    // room that is left. It would fit a block of the size the caller names as its largest, so it is not
    // announced: it waits, and a footer points to relay_inbox.
    const budget = 170 + INBOX_PREAMBLE_COST + 2;
    const d1 = drainInbox('tab-p1', opts);
    assert.equal(d1.messages.length, 2);
    const det1 = formatInboxForHookDetailed(d1.messages, { maxChars: budget, fullBlockChars: 9000 });
    assert.deepEqual(det1.includedIds, ['msg-fit']);
    assert.deepEqual(det1.announcedIds, []);
    assert.deepEqual(det1.omittedIds, ['msg-wait']);
    assert.ok(det1.text.length <= budget);
    assert.ok(det1.text.endsWith('(+remaining relay messages available via relay_inbox)'));
    assert.deepEqual(d1.ack(det1.includedIds), { acked: 1, kept: 1 });

    const remaining = peekInbox('tab-p1', opts);
    assert.deepEqual(remaining.messages.map((m) => [m.id, m.announced]), [['msg-wait', false]]);

    // The same through the hook helper: nothing fits now, the message stays untouched ...
    const tight = deliverInboxForHook('tab-p1', { ...opts, maxChars: budget, fullBlockChars: 9000 });
    assert.deepEqual(tight.deliveredIds, []);
    assert.deepEqual(tight.announcedIds, []);
    assert.deepEqual(tight.waitingIds, ['msg-wait']);
    assert.equal(peekInbox('tab-p1', opts).messages[0].announced, false);
    // ... and the next prompt with a full block delivers it whole
    const roomy = deliverInboxForHook('tab-p1', { ...opts, maxChars: 9000 });
    assert.deepEqual(roomy.deliveredIds, ['msg-wait']);
    assert.equal(peekInbox('tab-p1', opts).count, 0);
  } finally {
    env.cleanup();
  }
});

test('relay/hooks: a message longer than the injection budget is announced once, does not hold up later messages, and stays in the inbox until relay_inbox acknowledges it', async () => {
  const env = makeTempEnv('cortex-inbox-long-');
  const opts = { globalDir: env.globalDir };
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const server = createMcpServer({ store, hcClient: makeFakeHc() });
    const longBody = `BEGIN-OF-LONG ${'0123456789'.repeat(1597)}${' END-OF-LONG'.padStart(16)}`;
    assert.equal(longBody.length, 16000);
    const long = enqueueMessage('tab-long', { from_terminal_id: 'tab-1', message: longBody, context_docs: ['dec-1'] }, opts);
    const short = enqueueMessage('tab-long', { from_terminal_id: 'tab-1', message: 'SHORT-FOLLOW-UP' }, opts);

    // --- first prompt: the announcement of the long message plus the short message in full ---
    const first = claudePrompt(env, 'tab-long');
    assert.ok(first.length <= 9000);
    const noticeLine = `[long message: 16000 characters; only the first ${INBOX_PREVIEW_MAX_CHARS} are shown below, and this notice is not repeated. `
      + 'Read the full text with relay_inbox(action="peek"), then acknowledge it with '
      + `relay_inbox(action="ack", message_id="${long.id}").]`;
    assert.equal(formatLongMessageNotice(long.id, 16000, 600), noticeLine);
    assert.equal(first, [
      `## Incoming Herdr Relay Messages (2)\n${UNTRUSTED_MEMORY_PREAMBLE}`,
      [
        `### [${long.id}] from tab-1 @ ${long.message.created_at}`,
        'Context docs: [[dec-1]]',
        noticeLine,
        `> ${longBody.slice(0, 600)}`,
      ].join('\n'),
      `### [${short.id}] from tab-1 @ ${short.message.created_at}\n> SHORT-FOLLOW-UP`,
    ].join('\n\n'));
    assert.doesNotMatch(first, /END-OF-LONG/);

    // The short one was acknowledged; the long one is still stored in full, now marked as announced
    const stored = JSON.parse(fs.readFileSync(long.filePath, 'utf8'));
    assert.equal(stored.message, longBody);
    assert.ok(Number.isFinite(Date.parse(stored.announced_at)));
    assert.equal(fs.existsSync(short.filePath), false);

    // --- following prompts: nothing for either; a new message is delivered normally ---
    assert.equal(claudePrompt(env, 'tab-long'), '');
    const startCtx = handleClaudeSessionStart(
      { session_id: 'sess-long', source: 'startup', cwd: env.projectDir },
      { terminalId: 'tab-long', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    ).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(startCtx, /Incoming Herdr Relay Messages|BEGIN-OF-LONG/);

    const third = enqueueMessage('tab-long', { from_terminal_id: 'tab-1', message: 'THIRD-MESSAGE' }, opts);
    const next = claudePrompt(env, 'tab-long');
    assert.equal(next, [
      `## Incoming Herdr Relay Messages (1)\n${UNTRUSTED_MEMORY_PREAMBLE}`,
      `### [${third.id}] from tab-1 @ ${third.message.created_at}\n> THIRD-MESSAGE`,
    ].join('\n\n'));
    assert.equal(claudePrompt(env, 'tab-long'), '');

    // --- relay_inbox: the full body and the announced flag; gone after ack ---
    await withTerminalId('tab-long', async () => {
      const peek = await callTool(server, 'relay_inbox', { action: 'peek' });
      assert.equal(peek.data.count, 1);
      assert.equal(peek.data.messages[0].id, long.id);
      assert.equal(peek.data.messages[0].message, longBody);
      assert.equal(peek.data.messages[0].announced, true);
      assert.equal(peek.data.messages[0].announced_at, stored.announced_at);

      const ack = await callTool(server, 'relay_inbox', { action: 'ack', message_id: long.id });
      assert.equal(ack.data.acked, true);
      assert.equal((await callTool(server, 'relay_inbox', { action: 'peek' })).data.count, 0);
    });
    assert.equal(claudePrompt(env, 'tab-long'), '');
    // No pending message is left; the short messages the hooks injected are held in .delivered/
    assert.deepEqual(fs.readdirSync(getTerminalInboxDir('tab-long', opts)), [INBOX_DELIVERED_DIR]);
    assert.equal(peekInbox('tab-long', opts).pendingCount, 0);

    // --- relay_send itself sets no length limit ---
    const hc = makeFakeHc({ get: { 'tab-long': hcGetAgent({ address: 'tab-long', cwd: env.projectDir }) } });
    const sender = createMcpServer({ store, hcClient: hc });
    const sent = await withTerminalId('tab-1', () => callTool(sender, 'relay_send', { to_terminal_id: 'tab-long', message: longBody, wake: 'never' }));
    assert.equal(sent.data.queued, true);
    assert.equal(peekInbox('tab-long', opts).messages[0].message.length, 16000);

    // --- Antigravity PreInvocation: same rule with its own block size ---
    const agy = handleAntigravityPreInvocation(
      { conversationId: 'conv-long', rootConversationId: 'conv-long', cwd: env.projectDir, lastUserInput: 'continue' },
      { terminalId: 'tab-long', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    const agyText = agy.injectSteps.map((step) => step.systemMessage.systemMessage).join('\n\n');
    assert.match(agyText, /\[long message: 16000 characters; only the first 600 are shown below/);
    assert.doesNotMatch(agyText, /END-OF-LONG/);
    const agyAgain = handleAntigravityPreInvocation(
      { conversationId: 'conv-long', rootConversationId: 'conv-long', cwd: env.projectDir, lastUserInput: 'continue' },
      { terminalId: 'tab-long', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(agyAgain, {});
    assert.equal(peekInbox('tab-long', opts).messages[0].announced, true);

    // --- a message that only lacks room in SessionStart's smaller share waits for UserPromptSubmit ---
    store.saveDoc({ id: 'dec-overview', type: 'decision', title: 'Overview entry', summary: 'Makes SessionStart share its budget' });
    const medium = `MEDIUM-BEGIN ${'m'.repeat(3000)} MEDIUM-END`;
    enqueueMessage('tab-mid', { from_terminal_id: 'tab-1', message: medium }, opts);
    const midStart = handleClaudeSessionStart(
      { session_id: 'sess-mid', source: 'startup', cwd: env.projectDir },
      { terminalId: 'tab-mid', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    ).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(midStart, /MEDIUM-BEGIN|long message/);
    assert.match(midStart, /\(\+remaining relay messages available via relay_inbox\)/);
    assert.equal(peekInbox('tab-mid', opts).messages[0].announced, false);
    const midPrompt = claudePrompt(env, 'tab-mid');
    assert.match(midPrompt, /MEDIUM-BEGIN m+ MEDIUM-END$/);
    assert.equal(peekInbox('tab-mid', opts).count, 0);
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Delivered messages are kept for a retention period instead of being deleted
// ---------------------------------------------------------------------------------------------

test('relay/inbox retention: a message a hook injected is kept as delivered for 24 hours, is never injected again, can be listed and acknowledged, and is purged by a later drain', async () => {
  const env = makeTempEnv('cortex-inbox-held-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  const opts = { globalDir: env.globalDir };
  try {
    assert.equal(INBOX_DELIVERED_RETENTION_MS, 24 * 60 * 60 * 1000);
    assert.equal(INBOX_DELIVERED_DIR, '.delivered');
    const inboxDir = getTerminalInboxDir('tab-h', opts);
    const heldDir = path.join(inboxDir, INBOX_DELIVERED_DIR);

    const m1 = enqueueMessage('tab-h', { id: 'held-1', from_terminal_id: 'tab-0', message: 'First handoff', context_docs: ['dec-1'] }, opts);
    enqueueMessage('tab-h', { id: 'held-2', from_terminal_id: 'tab-0', message: 'Second handoff' }, opts);

    // The hook injects both. Its output may still be discarded by the host, so nothing is deleted.
    const t0 = Date.now();
    const first = claudePrompt(env, 'tab-h');
    assert.match(first, /First handoff/);
    assert.match(first, /Second handoff/);
    assert.deepEqual(fs.readdirSync(inboxDir), [INBOX_DELIVERED_DIR], 'no pending file and no lock is left');
    assert.deepEqual(fs.readdirSync(heldDir).sort(), fs.readdirSync(heldDir).sort().filter((name) => name.endsWith('.json')));
    const storedHeld = JSON.parse(fs.readFileSync(path.join(heldDir, m1.fileName), 'utf8'));
    assert.equal(storedHeld.message, 'First handoff');
    assert.deepEqual(storedHeld.context_docs, ['dec-1']);
    assert.ok(Math.abs(Date.parse(storedHeld.delivered_at) - t0) < 60_000, 'delivered_at is the delivery time');

    // Delivered messages are never injected again, by either host
    assert.equal(claudePrompt(env, 'tab-h'), '');
    assert.equal(handleAntigravityPreInvocation(
      { conversationId: 'held-conv', cwd: env.projectDir },
      { terminalId: 'tab-h', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    ).injectSteps, undefined);
    assert.deepEqual(deliverInboxForHook('tab-h', opts).deliveredIds, []);

    // Counts distinguish pending from held
    assert.equal(countPendingMessages('tab-h', opts), 0);
    assert.deepEqual(countInboxMessages('tab-h', opts), { pending: 0, held: 2, broken: 0 });

    // peek: pending only by default; the held ones on request, flagged
    const plain = peekInbox('tab-h', opts);
    assert.deepEqual([plain.count, plain.pendingCount, plain.heldCount, plain.messages.length], [0, 0, 2, 0]);
    const withHeld = peekInbox('tab-h', { ...opts, includeDelivered: true });
    assert.deepEqual([withHeld.count, withHeld.pendingCount, withHeld.heldCount], [2, 0, 2]);
    assert.deepEqual(withHeld.messages.map((m) => [m.id, m.delivered, m.message]), [
      ['held-1', true, 'First handoff'],
      ['held-2', true, 'Second handoff'],
    ]);
    assert.equal(withHeld.messages[0].delivered_at, storedHeld.delivered_at);

    // The same through the MCP tools; a new pending message is listed first and is not "delivered"
    enqueueMessage('tab-h', { id: 'fresh-3', from_terminal_id: 'tab-0', message: 'Not injected yet' }, opts);
    const hc = makeFakeHc({ ls: { terminals: [hcLsRow({ address: 'tab-h', cwd: env.projectDir, status: 'idle' })] } });
    const server = createMcpServer({ store, hcClient: hc });
    await withTerminalId('tab-h', async () => {
      const toolPeek = await callTool(server, 'relay_inbox', { action: 'peek' });
      assert.deepEqual(toolPeek.data.messages.map((m) => [m.id, m.delivered]), [['fresh-3', false]]);
      assert.equal(toolPeek.data.heldCount, 2);
      const toolPeekAll = await callTool(server, 'relay_inbox', { action: 'peek', include_delivered: true });
      assert.deepEqual(toolPeekAll.data.messages.map((m) => [m.id, m.delivered]), [['fresh-3', false], ['held-1', true], ['held-2', true]]);

      const tabs = (await callTool(server, 'relay_tabs')).data.tabs;
      assert.deepEqual([tabs[0].terminalId, tabs[0].pendingInboxCount, tabs[0].heldInboxCount], ['tab-h', 1, 2]);

      // An explicit ack deletes a delivered message by id ...
      const ackHeld = await callTool(server, 'relay_inbox', { action: 'ack', message_id: 'held-1' });
      assert.deepEqual([ackHeld.data.acked, ackHeld.data.delivered], [true, true]);
      assert.deepEqual(countInboxMessages('tab-h', opts), { pending: 1, held: 1, broken: 0 });
      // ... "all" covers the pending messages only, unless the delivered ones are asked for as well
      const ackAll = await callTool(server, 'relay_inbox', { action: 'ack', message_id: 'all' });
      assert.deepEqual([ackAll.data.ackedCount, ackAll.data.messageIds], [1, ['fresh-3']]);
      assert.deepEqual(countInboxMessages('tab-h', opts), { pending: 0, held: 1, broken: 0 });
      const ackAllHeld = await callTool(server, 'relay_inbox', { action: 'ack', message_id: 'all', include_delivered: true });
      assert.deepEqual([ackAllHeld.data.ackedCount, ackAllHeld.data.deliveredAckedCount, ackAllHeld.data.messageIds], [1, 1, ['held-2']]);
      assert.deepEqual(countInboxMessages('tab-h', opts), { pending: 0, held: 0, broken: 0 });
    });
    assert.deepEqual(ackMessage('tab-h', 'held-1', opts), { acked: false, terminalId: 'tab-h', messageId: 'held-1' });

    // Retention: kept until 24 hours after delivery, purged by the first drain after that
    enqueueMessage('tab-h', { id: 'old-4', from_terminal_id: 'tab-0', message: 'Will expire' }, opts);
    const deliveredAt = Date.now();
    assert.deepEqual(deliverInboxForHook('tab-h', { ...opts, nowMs: deliveredAt }).deliveredIds, ['old-4']);
    const almost = deliveredAt + INBOX_DELIVERED_RETENTION_MS - 60_000;
    assert.deepEqual(deliverInboxForHook('tab-h', { ...opts, nowMs: almost }).deliveredIds, []);
    assert.deepEqual(countInboxMessages('tab-h', opts), { pending: 0, held: 1, broken: 0 });
    assert.equal(peekInbox('tab-h', { ...opts, includeDelivered: true, nowMs: almost }).count, 1);
    const after = deliveredAt + INBOX_DELIVERED_RETENTION_MS + 60_000;
    assert.equal(peekInbox('tab-h', { ...opts, includeDelivered: true, nowMs: after }).count, 0, 'an expired message is no longer listed');
    assert.equal(fs.readdirSync(heldDir).length, 1, 'a peek deletes nothing');
    assert.deepEqual(deliverInboxForHook('tab-h', { ...opts, nowMs: after }).deliveredIds, []);
    assert.deepEqual(fs.readdirSync(inboxDir), [], 'the drain purged the expired message and the empty folder');

    // A shorter retention can be passed (the default is the constant)
    enqueueMessage('tab-h', { id: 'short-5', from_terminal_id: 'tab-0', message: 'Short retention' }, opts);
    deliverInboxForHook('tab-h', { ...opts, nowMs: deliveredAt });
    drainInbox('tab-h', { ...opts, nowMs: deliveredAt + 5000, retentionMs: 1000 }).release();
    assert.deepEqual(countInboxMessages('tab-h', opts), { pending: 0, held: 0, broken: 0 });
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// A5: the real hc status shapes
// ---------------------------------------------------------------------------------------------

test('relay/hc blocked tab: the real hc ls / hc get shapes of a tab waiting on a permission dialog read as blocked, and a refused hc send is reported as target_blocked', async () => {
  const env = makeTempEnv('cortex-hc-blocked-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    // hc ls row and hc get result, as captured
    const row = detectTerminalActivity(REAL_HC_BLOCKED_LS_ROW);
    assert.deepEqual(
      [row.terminalId, row.live, row.activity, row.blocked, row.busy, row.idle, row.unknown, row.isBareShell, row.agentName],
      ['t3', true, 'blocked', true, false, false, false, false, 'claude-code'],
    );
    const got = detectTerminalActivity(hcGetAgent({ address: 't3', cwd: env.projectDir, status: REAL_HC_BLOCKED_GET_STATUS, where: 'proj / Claude Code' }));
    assert.deepEqual([got.activity, got.blocked, got.busy, got.idle, got.agentName], ['blocked', true, false, false, 'claude-code']);

    const hc = makeFakeHc({
      ls: { terminals: [REAL_HC_BLOCKED_LS_ROW] },
      get: {
        t3: hcGetAgent({ address: 't3', cwd: env.projectDir, status: REAL_HC_BLOCKED_GET_STATUS, where: 'proj / Claude Code' }),
        // hc get said "working" a moment ago, but the tab is on a dialog by the time hc send runs
        t5: hcGetAgent({ address: 't5', cwd: env.projectDir, statusState: 'working' }),
        t6: hcGetAgent({ address: 't6', cwd: env.projectDir, statusState: 'idle' }),
      },
    });
    hc.state.blockedSend = new Set(['t3', 't5', 't6']);
    assert.deepEqual(hc.listTerminals().terminals.map((t) => [t.terminalId, t.activity]), [['t3', 'blocked']]);

    // The client reports the refusal as its own code, whichever stream carries the JSON
    for (const stream of ['stdout', 'stderr']) {
      hc.state.blockedStream = stream;
      const refused = hc.sendTrigger('t3', 'ping');
      assert.deepEqual([refused.ok, refused.code, refused.error], [false, 'HC_TARGET_BLOCKED', 't3 is blocked (permission)'], stream);
    }
    // Exit code 9 with plain text instead of JSON is understood as well; another failure stays a failure
    const plainHc = createHcClient({
      hcBin: FAKE_HC_BIN,
      execFileSync() {
        const err = new Error('Command failed');
        err.status = 9;
        err.stderr = 't3 is blocked (permission)';
        throw err;
      },
    });
    assert.equal(plainHc.sendTrigger('t3', 'ping').code, 'HC_TARGET_BLOCKED');
    const otherHc = createHcClient({
      hcBin: FAKE_HC_BIN,
      execFileSync() {
        const err = new Error('Command failed');
        err.status = 1;
        err.stderr = '{"error":{"kind":"not_found","message":"no terminal t3"}}';
        throw err;
      },
    });
    assert.equal(otherHc.sendTrigger('t3', 'ping').code, 'HC_EXEC_ERROR');

    hc.state.blockedStream = 'stdout';
    hc.state.refused.length = 0;
    const server = createMcpServer({ store, hcClient: hc });
    await withTerminalId('t1', async () => {
      // auto: hc get already says blocked, nothing is sent
      const auto = await callTool(server, 'relay_send', { to_terminal_id: 't3', message: 'needs a look', wake: 'auto' });
      assert.deepEqual([auto.data.queued, auto.data.woke, auto.data.wakeReason], [true, false, 'target_blocked']);
      assert.deepEqual(hc.state.refused, []);
      // always: the send is attempted, hc refuses to type into the dialog, and that is reported as blocked
      const always = await callTool(server, 'relay_send', { to_terminal_id: 't3', message: 'needs a look', wake: 'always' });
      assert.deepEqual([always.data.queued, always.data.woke, always.data.wakeReason], [true, false, 'target_blocked']);
      assert.equal(always.data.wakeError, 't3 is blocked (permission)');
      assert.equal(always.data.triggerSent, undefined);
      assert.deepEqual(hc.state.refused, ['t3']);
      // The dialog appeared between hc get and hc send
      const raced = await callTool(server, 'relay_send', { to_terminal_id: 't5', message: 'raced', wake: 'always' });
      assert.deepEqual([raced.data.woke, raced.data.wakeReason], [false, 'target_blocked']);
      const racedAuto = await callTool(server, 'relay_send', { to_terminal_id: 't6', message: 'raced', wake: 'auto' });
      assert.deepEqual([racedAuto.data.woke, racedAuto.data.wakeReason, racedAuto.data.wakeError], [false, 'target_blocked', 't6 is blocked (permission)']);
      assert.deepEqual(hc.state.sent, [], 'nothing was typed into any tab');
    });
    assert.equal(countPendingMessages('t3', { globalDir: env.globalDir }), 2, 'the messages wait in the inbox');
  } finally {
    store.close();
    env.cleanup();
  }
});

test('relay/hc: reads real hc ls rows (string status) and hc get results (object status); unknown is not busy; single-line sendTrigger; graceful missing hc', () => {
  const hc = makeFakeHc({
    ls: REAL_HC_LS,
    get: {
      t1: hcGetAgent({ address: 't1', cwd: 'C:\\Users\\dev\\Desktop\\작업', statusState: 'working', msg: 'Editing ...', where: '작업 / 1' }),
      t2: hcGetShell({ address: 't2', cwd: 'C:\\Users\\dev\\Desktop\\작업', where: '작업 / 2' }),
      t4: hcGetAgent({ address: 't4', statusState: 'idle' }),
    },
  });

  // hc ls --json
  const ls = hc.listTerminals();
  assert.equal(ls.ok, true);
  assert.equal(ls.terminals.length, 3);
  const [working, shell, remote] = ls.terminals;
  assert.deepEqual(
    { id: working.terminalId, live: working.live, activity: working.activity, busy: working.busy, idle: working.idle, unknown: working.unknown, shell: working.isBareShell, agent: working.agentName, where: working.where },
    { id: 't1', live: true, activity: 'working', busy: true, idle: false, unknown: false, shell: false, agent: 'claude-code', where: '작업 / 1' },
  );
  assert.deepEqual(
    { id: shell.terminalId, live: shell.live, activity: shell.activity, busy: shell.busy, idle: shell.idle, unknown: shell.unknown, shell: shell.isBareShell, agent: shell.agentName },
    { id: 't2', live: true, activity: 'shell', busy: false, idle: false, unknown: false, shell: true, agent: 'powershell.exe' },
  );
  assert.deepEqual(
    { id: remote.terminalId, remote: remote.remote, machine: remote.machine, activity: remote.activity, idle: remote.idle },
    { id: 'pc2/t3', remote: true, machine: 'pc2', activity: 'idle', idle: true },
  );
  assert.equal(working.remote, false);

  // hc get <id> --json: `status` is an object
  const g1 = hc.getTerminal('t1');
  assert.equal(g1.ok, true);
  assert.deepEqual(
    { activity: g1.status.activity, busy: g1.status.busy, idle: g1.status.idle, shell: g1.status.isBareShell, agent: g1.status.agentName, cwd: g1.status.cwd, where: g1.status.where },
    { activity: 'working', busy: true, idle: false, shell: false, agent: 'claude-code', cwd: 'C:\\Users\\dev\\Desktop\\작업', where: '작업 / 1' },
  );
  const g4 = hc.getTerminal('t4');
  assert.deepEqual([g4.status.activity, g4.status.idle, g4.status.busy], ['idle', true, false]);
  const g2 = hc.getTerminal('t2');
  assert.deepEqual([g2.status.activity, g2.status.isBareShell, g2.status.idle, g2.status.busy, g2.status.unknown], ['shell', true, false, false, false]);

  // A live agent tab whose status cannot be interpreted is "unknown": not idle, and not busy either
  for (const oddStatus of [null, {}, { app: 'claude-code' }, { app: 'claude-code', state: 'compacting' }, 'compacting', 7]) {
    const odd = detectTerminalActivity(hcGetAgent({ address: 't5', status: oddStatus }));
    assert.deepEqual(
      [odd.activity, odd.unknown, odd.busy, odd.idle, odd.live, odd.isBareShell],
      ['unknown', true, false, false, true, false],
      JSON.stringify(oddStatus),
    );
  }
  assert.equal(detectTerminalActivity(hcLsRow({ address: 't6' })).activity, 'unknown', 'an agent row without status');
  // Other states
  assert.equal(detectTerminalActivity(hcGetAgent({ address: 't7', statusState: 'blocked' })).activity, 'blocked');
  assert.equal(detectTerminalActivity(hcGetAgent({ address: 't7', statusState: 'error' })).activity, 'error');
  const finished = detectTerminalActivity(hcLsRow({ address: 't8', state: 'finished', status: 'idle' }));
  assert.deepEqual([finished.activity, finished.live, finished.idle], ['not_live', false, false]);
  // A tab that hc reports as an agent is not a bare shell even when its foreground program is a shell
  const wrapped = detectTerminalActivity({ ...hcGetShell({ address: 't9' }), status: { app: 'claude-code', state: 'idle' } });
  assert.deepEqual([wrapped.activity, wrapped.isBareShell, wrapped.agentName], ['idle', false, 'claude-code']);

  // Addresses
  assert.deepEqual(parseTerminalAddress('pc2/t3'), { remote: true, machine: 'pc2', terminalId: 't3' });
  assert.deepEqual(parseTerminalAddress(' t3 '), { remote: false, machine: '', terminalId: 't3' });
  assert.equal(parseTerminalAddress('../escape').remote, false);
  assert.throws(() => hc.getTerminal('pc2/t3'), /Invalid terminalId/);

  // An API error answer
  const apiErr = hc.getTerminal('t-missing');
  assert.equal(apiErr.ok, false);
  assert.equal(apiErr.code, 'HC_API_ERROR');

  // Multiline text gets strictly collapsed to a single line
  const sendRes = hc.sendTrigger('t4', 'Line 1\nLine 2\r\n\tLine 3');
  assert.equal(sendRes.ok, true);
  assert.equal(sendRes.sent, 'Line 1 Line 2 Line 3');
  assert.deepEqual(hc.state.sent[0], { ifCond: null, to: 't4', trigger: 'Line 1 Line 2 Line 3' });
  assert.equal(sanitizeSingleLineTrigger('a\nb\nc'), 'a b c');

  // `--if idle`, with a fallback for an hc that does not know the flag
  hc.sendTrigger('t4', 'ping', { ifIdle: true });
  assert.deepEqual(hc.state.sent[1], { ifCond: 'idle', to: 't4', trigger: 'ping' });
  hc.state.rejectIfFlag = true;
  const callsBefore = hc.state.calls.length;
  assert.equal(hc.sendTrigger('t4', 'ping', { ifIdle: true }).ok, true);
  assert.deepEqual(hc.state.calls.slice(callsBefore), [['send', '--if', 'idle', 't4', 'ping'], ['send', 't4', 'ping']]);

  // Missing hc binary degrades gracefully
  const missingHc = createHcClient({
    hcBin: FAKE_HC_BIN,
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

  try {
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
      legacyHome: env.homeDir,
    });

    const hc = makeFakeHc({
      ls: {
        terminals: [
          hcLsRow({ address: 't1', cwd: env.projectDir, status: 'idle', where: 'proj / 1' }),
          hcLsRow({ address: 't2', cwd: env.projectDir, status: 'idle', where: 'proj / 2' }),
          hcLsRow({ address: 't3', cwd: env.projectDir, status: 'working', where: 'proj / 3' }),
        ],
      },
      get: {
        t2: hcGetAgent({ address: 't2', cwd: env.projectDir, statusState: 'idle' }),
        t3: hcGetAgent({ address: 't3', cwd: env.projectDir, statusState: 'working', msg: 'Editing ...' }),
      },
    });
    const server = createMcpServer({ store, hcClient: hc });

    await withTerminalId('t1', async () => {
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
      const tabs = (await callTool(server, 'relay_tabs')).data;
      assert.equal(tabs.hcAvailable, true);
      assert.equal(tabs.currentTerminalId, 't1');
      assert.equal(tabs.tabs.length, 3);
      const t2Tab = tabs.tabs.find((t) => t.terminalId === 't2');
      assert.equal(t2Tab.sameProject, true);
      assert.equal(t2Tab.idle, true);
      assert.equal(t2Tab.activity, 'idle');
      assert.equal(t2Tab.relayCapable, true);
      assert.equal(t2Tab.savedSession.sessionId, 'conv-t2-abc');
      assert.equal(tabs.tabs.find((t) => t.terminalId === 't3').busy, true);
      assert.equal(tabs.tabs.find((t) => t.terminalId === 't1').isCurrent, true);
      assert.equal(tabs.projectSessions[0].session, 'stage-2');

      // 3. relay_send with wake="auto" to IDLE t2 -> saves multiline body in inbox + sends short single-line trigger
      const multilineBody = 'Line A: review schema\nLine B: verify tests\nLine C: report back';
      const sendIdle = (await callTool(server, 'relay_send', {
        to_terminal_id: 't2',
        message: multilineBody,
        context_docs: ['dec-relay-1'],
        wake: 'auto',
      })).data;
      assert.equal(sendIdle.queued, true);
      assert.equal(sendIdle.woke, true);
      assert.equal(sendIdle.wakeReason, 'sent_auto_idle');
      assert.equal(hc.state.sent.length, 1);
      assert.equal(hc.state.sent[0].ifCond, 'idle');
      assert.equal(hc.state.sent[0].to, 't2');
      // NEVER sends raw multiline body via hc send!
      assert.equal(hc.state.sent[0].trigger.includes('\n'), false);
      assert.equal(hc.state.sent[0].trigger.includes('Line A'), false);
      assert.match(hc.state.sent[0].trigger, /relay_inbox/);

      // 4. relay_send with wake="auto" to a WORKING t3 -> enqueues message, skips hc send
      const sendBusy = (await callTool(server, 'relay_send', { to_terminal_id: 't3', message: 'Wait until free', wake: 'auto' })).data;
      assert.equal(sendBusy.queued, true);
      assert.equal(sendBusy.woke, false);
      assert.equal(sendBusy.wakeReason, 'target_busy');
      assert.equal(hc.state.sent.length, 1);

      // 5. relay_send with wake="always" to the WORKING t3 -> sends the trigger (queued behind its turn), no --if
      const sendAlways = (await callTool(server, 'relay_send', { to_terminal_id: 't3', message: 'Urgent override', wake: 'always' })).data;
      assert.equal(sendAlways.woke, true);
      assert.equal(sendAlways.wakeReason, 'sent_always');
      assert.equal(hc.state.sent.length, 2);
      assert.equal(hc.state.sent[1].ifCond, null);
      assert.equal(hc.state.sent[1].to, 't3');

      // 6. relay_send with wake="never" to IDLE t2 -> does NOT call hc send
      const sendNever = (await callTool(server, 'relay_send', { to_terminal_id: 't2', message: 'Silent delivery', wake: 'never' })).data;
      assert.equal(sendNever.woke, false);
      assert.equal(sendNever.wakeReason, 'wake_disabled');
      assert.equal(hc.state.sent.length, 2);

      // The messages are in the global inbox; the project got no inbox folder
      assert.equal(countPendingMessages('t2', { globalDir: env.globalDir }), 2);
      assert.equal(fs.existsSync(path.join(env.projectDir, '.memory', 'state', 'inbox')), false);
      const tabsAfter = (await callTool(server, 'relay_tabs')).data;
      assert.equal(tabsAfter.tabs.find((t) => t.terminalId === 't2').pendingInboxCount, 2);
      assert.equal(tabsAfter.tabs.find((t) => t.terminalId === 't3').pendingInboxCount, 2);

      // 7. relay_inbox peek & ack for t2
      process.env.HC_TERMINAL_ID = 't2';
      const peek = (await callTool(server, 'relay_inbox', { action: 'peek' })).data;
      assert.equal(peek.count, 2);
      assert.equal(peek.messages[0].message, multilineBody);
      assert.deepEqual(peek.messages[0].context_docs, ['dec-relay-1']);
      assert.equal(peek.messages[0].announced, false);

      const ack = (await callTool(server, 'relay_inbox', { action: 'ack', message_id: peek.messages[0].id })).data;
      assert.equal(ack.acked, true);
      assert.equal((await callTool(server, 'relay_inbox', { action: 'peek' })).data.count, 1);

      // ack "all" removes the rest
      const ackAll = (await callTool(server, 'relay_inbox', { action: 'ack', message_id: 'all' })).data;
      assert.equal(ackAll.acked, true);
      assert.equal(ackAll.ackedCount, 1);
      assert.equal((await callTool(server, 'relay_inbox', { action: 'peek' })).data.count, 0);

      // While a hook holds the terminal's lock, an ack reports "busy" after a short wait and changes nothing
      process.env.HC_TERMINAL_ID = 't3';
      const holder = drainInbox('t3', { globalDir: env.globalDir });
      assert.equal(holder.messages.length, 2);
      const busyAck = (await callTool(server, 'relay_inbox', { action: 'ack', message_id: 'all' })).data;
      assert.equal(busyAck.busy, true);
      assert.equal(busyAck.acked, false);
      const busyOne = (await callTool(server, 'relay_inbox', { action: 'ack', message_id: holder.messages[0].id })).data;
      assert.equal(busyOne.busy, true);
      assert.equal(busyOne.acked, false);
      holder.release();
      assert.equal((await callTool(server, 'relay_inbox', { action: 'peek' })).data.count, 2);
    });
  } finally {
    store.close();
    env.cleanup();
  }
});

test('relay_send across projects: the message goes to the global inbox of the target terminal, nothing is written into either project', async () => {
  const env = makeTempEnv('herdr-cortex-xproj-');
  const projectX = path.join(env.root, 'project-x');
  const projectY = path.join(env.root, 'project-y');
  fs.mkdirSync(projectX, { recursive: true });
  fs.mkdirSync(projectY, { recursive: true });

  const storeX = new CortexStore({ projectDir: projectX, globalDir: env.globalDir, disableVec: true });
  const storeY = new CortexStore({ projectDir: projectY, globalDir: env.globalDir, disableVec: true });

  try {
    const hc = makeFakeHc({
      ls: {
        terminals: [
          hcLsRow({ address: 'tab-a', cwd: projectX, status: 'idle', where: 'proj-x / 1' }),
          hcLsRow({ address: 'tab-b', cwd: projectY, status: 'idle', where: 'proj-y / 1' }),
        ],
      },
      get: { 'tab-b': hcGetAgent({ address: 'tab-b', cwd: projectY, statusState: 'idle' }) },
    });
    const serverA = createMcpServer({ store: storeX, hcClient: hc });
    const serverB = createMcpServer({ store: storeY, hcClient: hc });

    // Server A (in Project X, not approved) sends to Tab B (in Project Y, not approved either)
    await withTerminalId('tab-a', async () => {
      const send = (await callTool(serverA, 'relay_send', {
        to_terminal_id: 'tab-b',
        message: 'Cross-project handoff from X to Y',
        context_docs: ['base-p0'],
        wake: 'auto',
      })).data;
      assert.equal(send.queued, true);
      assert.equal(send.woke, true);
      assert.equal(path.resolve(send.target_project_dir), path.resolve(projectY));

      // One file in the global inbox of tab-b; both project folders are untouched
      const inboxDir = getTerminalInboxDir('tab-b', { globalDir: env.globalDir });
      assert.equal(fs.readdirSync(inboxDir).filter((name) => name.endsWith('.json')).length, 1);
      assert.deepEqual(fs.readdirSync(projectX), []);
      assert.deepEqual(fs.readdirSync(projectY), []);

      // relay_tabs from Server A reports Tab B's pendingInboxCount
      const tabs = (await callTool(serverA, 'relay_tabs')).data;
      const tabB = tabs.tabs.find((t) => t.terminalId === 'tab-b');
      assert.equal(tabB.sameProject, false);
      assert.equal(tabB.pendingInboxCount, 1);
    });

    // Server B (in Project Y) peeks via relay_inbox, and the hook of tab-b delivers the message although
    // project Y is not approved: the inbox is the terminal's, not the project's
    await withTerminalId('tab-b', async () => {
      const peek = (await callTool(serverB, 'relay_inbox', { action: 'peek' })).data;
      assert.equal(peek.count, 1);
      assert.equal(peek.messages[0].message, 'Cross-project handoff from X to Y');
    });
    assert.match(claudePrompt(env, 'tab-b', projectY), /^> Cross-project handoff from X to Y$/m);
    assert.equal(peekInbox('tab-b', { globalDir: env.globalDir }).count, 0);
    assert.deepEqual(fs.readdirSync(projectY), []);
  } finally {
    storeX.close();
    storeY.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// A5 / A6: wake policies
// ---------------------------------------------------------------------------------------------

test('relay_send wake: auto wakes only an idle agent and reports an unreadable status as target_status_unknown (not busy); always also wakes a working agent but never a bare shell, a tab that is not live, or one in an error state', async () => {
  const env = makeTempEnv('cortex-hc-wake-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const agent = (address, extra = {}) => hcGetAgent({ address, cwd: env.projectDir, ...extra });
    const hc = makeFakeHc({
      get: {
        't-idle': agent('t-idle', { statusState: 'idle' }),
        't-working': agent('t-working', { statusState: 'working', msg: 'Editing ...' }),
        't-shell': hcGetShell({ address: 't-shell', cwd: env.projectDir }),
        't-nostatus': agent('t-nostatus', { status: null }),
        't-nostate': agent('t-nostate', { status: { app: 'claude-code' } }),
        't-odd': agent('t-odd', { statusState: 'compacting' }),
        't-finished': agent('t-finished', { state: 'finished' }),
        't-error': agent('t-error', { statusState: 'error' }),
        't-blocked': agent('t-blocked', { statusState: 'blocked' }),
      },
    });
    const server = createMcpServer({ store, hcClient: hc });

    const send = async (to, wake) => {
      const before = hc.state.sent.length;
      const res = await callTool(server, 'relay_send', { to_terminal_id: to, message: `to ${to} with ${wake}`, wake });
      assert.equal(res.isError, false, `${to}/${wake}`);
      assert.equal(res.data.queued, true, `${to}/${wake}: the message is stored whatever happens to the wake`);
      return { ...res.data, sentNow: hc.state.sent.slice(before) };
    };

    await withTerminalId('t1', async () => {
      const expectations = [
        // [target, wake, woke, reason, how the trigger was sent]
        ['t-idle', 'auto', true, 'sent_auto_idle', 'idle'],
        ['t-idle', 'always', true, 'sent_always', null],
        ['t-working', 'auto', false, 'target_busy'],
        ['t-working', 'always', true, 'sent_always', null],
        ['t-shell', 'auto', false, 'target_is_bare_shell'],
        ['t-shell', 'always', false, 'target_is_bare_shell'],
        ['t-nostatus', 'auto', false, 'target_status_unknown'],
        ['t-nostate', 'auto', false, 'target_status_unknown'],
        ['t-odd', 'auto', false, 'target_status_unknown'],
        ['t-odd', 'always', true, 'sent_always', null],
        ['t-finished', 'auto', false, 'target_not_live'],
        ['t-finished', 'always', false, 'target_not_live'],
        ['t-error', 'auto', false, 'target_error'],
        ['t-error', 'always', false, 'target_error'],
        ['t-blocked', 'auto', false, 'target_blocked'],
        ['t-gone', 'auto', false, 'hc_unavailable'],
        ['t-gone', 'always', false, 'hc_unavailable'],
        ['t-idle', 'never', false, 'wake_disabled'],
      ];
      for (const [to, wake, woke, reason, ifCond] of expectations) {
        const res = await send(to, wake);
        assert.deepEqual([res.woke, res.wakeReason], [woke, reason], `${to}/${wake}`);
        assert.equal(res.wakeRequested, wake);
        if (woke) {
          assert.equal(res.sentNow.length, 1, `${to}/${wake}`);
          assert.equal(res.sentNow[0].to, to);
          assert.equal(res.sentNow[0].ifCond, ifCond, `${to}/${wake}`);
          assert.equal(res.triggerSent, res.sentNow[0].trigger);
        } else {
          assert.deepEqual(res.sentNow, [], `${to}/${wake}: nothing is typed into the tab`);
        }
      }
      assert.match((await send('t-gone', 'auto')).wakeError, /t-gone not found/);

      // relay_tabs shows the unknown state instead of calling the tab busy
      const lsHc = makeFakeHc({
        ls: {
          terminals: [
            ...REAL_HC_LS.terminals,
            hcLsRow({ address: 't4', cwd: env.projectDir, where: 'proj / 4' }), // an agent row without status
          ],
        },
      });
      const tabs = (await callTool(createMcpServer({ store, hcClient: lsHc }), 'relay_tabs')).data.tabs;
      const byId = new Map(tabs.map((t) => [t.terminalId, t]));
      assert.deepEqual(
        [byId.get('t4').activity, byId.get('t4').statusUnknown, byId.get('t4').busy, byId.get('t4').idle],
        ['unknown', true, false, false],
      );
      assert.deepEqual([byId.get('t1').activity, byId.get('t1').busy, byId.get('t1').statusUnknown], ['working', true, false]);
      assert.deepEqual([byId.get('t2').activity, byId.get('t2').isBareShell, byId.get('t2').agent], ['shell', true, 'powershell.exe']);

      // from_terminal_id validated strictly
      const badFrom = await callTool(server, 'relay_send', { to_terminal_id: 't-idle', from_terminal_id: '../escape', message: 'hi', wake: 'never' });
      assert.equal(badFrom.isError, true);

      // Subagent (including camelCase meta.isSubagent: true) cannot call relay_send or relay_inbox(ack), CAN call relay_inbox(peek)
      const subSend = await callTool(server, 'relay_send', { to_terminal_id: 't-idle', message: 'subagent unauthorized' }, { isSubagent: true });
      assert.equal(subSend.isError, true);
      assert.equal(subSend.data.error, 'SUBAGENT_WRITE_DENIED');
      const subAck = await callTool(server, 'relay_inbox', { action: 'ack', message_id: 'all', terminal_id: 't-shell' }, { isSubagent: true });
      assert.equal(subAck.isError, true);
      assert.equal(subAck.data.error, 'SUBAGENT_WRITE_DENIED');
      const subPeek = await callTool(server, 'relay_inbox', { action: 'peek', terminal_id: 't-shell' }, { isSubagent: true });
      assert.equal(subPeek.isError, false);
      assert.equal(subPeek.data.count, 2);
    });
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// A7: tabs on another machine
// ---------------------------------------------------------------------------------------------

test('relay and remote tabs: relay_send to "pc2/t3" fails with REMOTE_TERMINAL_UNSUPPORTED, relay_tabs lists the tab as remote and not relay-capable', async () => {
  const env = makeTempEnv('cortex-relay-remote-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    // The remote tab's folder has the same path text as this project: still not "the same project"
    const ls = {
      ...REAL_HC_LS,
      terminals: REAL_HC_LS.terminals.map((row) => (row.address === 'pc2/t3' ? { ...row, cwd: env.projectDir } : row)),
    };
    const hc = makeFakeHc({ ls });
    const server = createMcpServer({ store, hcClient: hc });

    await withTerminalId('t3', async () => {
      const sent = await callTool(server, 'relay_send', { to_terminal_id: 'pc2/t3', message: 'hello over there', wake: 'always' });
      assert.equal(sent.isError, true);
      assert.equal(sent.data.error, 'REMOTE_TERMINAL_UNSUPPORTED');
      assert.equal(sent.data.terminal_id, 'pc2/t3');
      assert.equal(sent.data.machine, 'pc2');
      assert.match(sent.data.message, /only between tabs on the same machine/);
      assert.deepEqual(hc.state.calls, [], 'hc was not asked about, or made to type into, the remote tab');
      assert.equal(fs.existsSync(path.join(env.globalDir, 'state', 'inbox')), false, 'nothing was queued');

      // An address that is simply malformed keeps the generic validation error
      const malformed = await callTool(server, 'relay_send', { to_terminal_id: '../escape', message: 'x' });
      assert.equal(malformed.isError, true);
      assert.equal(malformed.data.error, 'TOOL_EXECUTION_ERROR');
      assert.match(malformed.data.message, /Invalid terminalId/);

      const remoteInbox = await callTool(server, 'relay_inbox', { action: 'peek', terminal_id: 'pc2/t3' });
      assert.equal(remoteInbox.isError, true);
      assert.equal(remoteInbox.data.error, 'REMOTE_TERMINAL_UNSUPPORTED');

      const tabs = (await callTool(server, 'relay_tabs')).data;
      assert.equal(tabs.tabs.length, 3, 'the remote tab is listed, not dropped');
      const remoteTab = tabs.tabs.find((t) => t.terminalId === 'pc2/t3');
      assert.deepEqual(
        {
          remote: remoteTab.remote,
          machine: remoteTab.machine,
          relayCapable: remoteTab.relayCapable,
          sameProject: remoteTab.sameProject,
          isCurrent: remoteTab.isCurrent,
          pendingInboxCount: remoteTab.pendingInboxCount,
          activity: remoteTab.activity,
          agent: remoteTab.agent,
        },
        { remote: true, machine: 'pc2', relayCapable: false, sameProject: false, isCurrent: false, pendingInboxCount: 0, activity: 'idle', agent: 'claude-code' },
      );
      const localTab = tabs.tabs.find((t) => t.terminalId === 't1');
      assert.deepEqual([localTab.remote, localTab.relayCapable, 'machine' in localTab], [false, true, false]);

      // only_same_project never includes a remote tab
      const same = (await callTool(server, 'relay_tabs', { only_same_project: true })).data;
      assert.deepEqual(same.tabs.map((t) => t.terminalId), []);
    });
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// A8: the same folder reached through a junction
// ---------------------------------------------------------------------------------------------

test('relay/tools and project_dir: a folder reached through a junction is the same project (compared by real path)', async () => {
  const env = makeTempEnv('cortex-relay-junction-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const junction = path.join(env.root, 'project-link');
    fs.symlinkSync(env.projectDir, junction, 'junction');
    const elsewhere = path.join(env.root, 'elsewhere');
    fs.mkdirSync(elsewhere);

    recordSession({
      terminalId: 't-saved',
      agent: 'claude',
      payload: { session_id: 'sess-saved', cwd: junction },
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
    });

    const hc = makeFakeHc({
      ls: {
        terminals: [
          hcLsRow({ address: 't-direct', cwd: env.projectDir, status: 'idle' }),
          hcLsRow({ address: 't-link', cwd: junction, status: 'idle' }),
          hcLsRow({ address: 't-case', cwd: process.platform === 'win32' ? env.projectDir.toUpperCase() : env.projectDir, status: 'idle' }),
          hcLsRow({ address: 't-else', cwd: elsewhere, status: 'idle' }),
        ],
      },
    });
    const scheduled = [];
    const server = createMcpServer({
      store,
      hcClient: hc,
      embeddingQueue: { schedule: (...args) => scheduled.push(args) },
    });

    await withTerminalId('t-direct', async () => {
      const tabs = (await callTool(server, 'relay_tabs')).data;
      const same = Object.fromEntries(tabs.tabs.map((t) => [t.terminalId, t.sameProject]));
      assert.deepEqual(same, { 't-direct': true, 't-link': true, 't-case': true, 't-else': false });
      assert.equal(tabs.savedSessions.find((s) => s.terminalId === 't-saved').sameProject, true);
      const onlySame = (await callTool(server, 'relay_tabs', { only_same_project: true })).data;
      assert.deepEqual(onlySame.tabs.map((t) => t.terminalId), ['t-direct', 't-link', 't-case']);
    });

    // project_dir naming the default project through the junction uses the default store: the embedding queue
    // is told about the default project, not about "another project" at the junction path
    const saved = await callTool(server, 'memory_save', {
      id: 'dec-via-link',
      type: 'decision',
      title: 'Saved through the junction',
      summary: 'Same project',
      project_dir: junction,
    });
    assert.equal(saved.isError, false);
    assert.deepEqual(scheduled, [['project']]);
    assert.equal(store.readDoc({ id: 'dec-via-link', scope: 'project' }).title, 'Saved through the junction');

    // A really different folder still goes through its own store
    approveProject(elsewhere, { globalDir: env.globalDir });
    scheduled.length = 0;
    const other = await callTool(server, 'memory_save', { id: 'dec-else', type: 'decision', title: 'Elsewhere', summary: 'Other project', project_dir: elsewhere });
    assert.equal(other.isError, false);
    assert.deepEqual(scheduled, [['project', { projectDir: elsewhere }]]);
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// A2: the exclusion policy covers every relay entry point
// ---------------------------------------------------------------------------------------------

test('excluded project: relay_tabs, relay_send and relay_inbox (peek and ack) return PROJECT_EXCLUDED, hooks deliver nothing there, and the messages wait in the global inbox', async () => {
  const env = makeTempEnv('cortex-relay-excluded-');
  const excludedProj = path.join(env.root, 'excluded_relay_proj');
  fs.mkdirSync(excludedProj, { recursive: true });
  approveProject(excludedProj, { globalDir: env.globalDir });
  atomicWriteJson(path.join(env.globalDir, 'config.json'), { mode: 'all', excludedProjects: ['excluded_relay_proj'] });

  const excludedStore = new CortexStore({ projectDir: excludedProj, globalDir: env.globalDir, disableVec: true });
  const enabledStore = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const hc = makeFakeHc({
      ls: { terminals: [hcLsRow({ address: 't-ex', cwd: excludedProj, status: 'idle' })] },
      get: { 't-ex': hcGetAgent({ address: 't-ex', cwd: excludedProj, statusState: 'idle' }) },
    });
    const excludedServer = createMcpServer({ store: excludedStore, hcClient: hc });
    const opts = { globalDir: env.globalDir };
    // A message that reached the tab's inbox before it moved into the excluded project
    const waiting = enqueueMessage('t-ex', { from_terminal_id: 't1', message: 'WAITING-MESSAGE' }, opts);

    await withTerminalId('t-ex', async () => {
      const calls = [
        ['relay_tabs', {}],
        ['relay_tabs', { only_same_project: true }],
        ['relay_send', { to_terminal_id: 't1', message: 'blocked' }],
        ['relay_inbox', {}],
        ['relay_inbox', { action: 'peek' }],
        ['relay_inbox', { action: 'ack', message_id: waiting.id }],
        ['relay_inbox', { action: 'ack', message_id: 'all' }],
      ];
      for (const [name, args] of calls) {
        const res = await callTool(excludedServer, name, args);
        assert.equal(res.isError, true, `${name} ${JSON.stringify(args)}`);
        assert.equal(res.data.error, 'PROJECT_EXCLUDED', `${name} ${JSON.stringify(args)}`);
        assert.equal(res.data.tool, name);
        assert.equal(res.data.project_dir, path.resolve(excludedProj));
      }
      assert.deepEqual(hc.state.calls, [], 'hc is not consulted for an excluded project');
    });

    // Hooks do not deliver in the excluded project either
    assert.equal(claudePrompt(env, 't-ex', excludedProj), '');
    assert.deepEqual(
      handleClaudeSessionStart(
        { session_id: 'sess-ex', source: 'startup', cwd: excludedProj },
        { terminalId: 't-ex', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
      ),
      {},
    );
    assert.equal(peekInbox('t-ex', opts).count, 1, 'the message was neither delivered nor deleted');
    assert.equal(fs.existsSync(path.join(excludedProj, '.memory')), false);

    // A tab working in an excluded project is not a relay target
    const enabledServer = createMcpServer({ store: enabledStore, hcClient: hc });
    await withTerminalId('t1', async () => {
      const refused = await callTool(enabledServer, 'relay_send', { to_terminal_id: 't-ex', message: 'Cannot land in excluded project' });
      assert.equal(refused.isError, true);
      assert.equal(refused.data.error, 'TARGET_PROJECT_EXCLUDED');
      assert.equal(countPendingMessages('t-ex', opts), 1);
      // ... while relay tools of an enabled project work
      assert.equal((await callTool(enabledServer, 'relay_tabs')).isError, false);
    });

    // Once the same terminal works in an enabled project again, the waiting message is delivered
    assert.match(claudePrompt(env, 't-ex', env.projectDir), /^> WAITING-MESSAGE$/m);
  } finally {
    excludedStore.close();
    enabledStore.close();
    env.cleanup();
  }
});

test('P0-3, P0-11, P1-8, P1-11, P2-5 regression: MCP excludedProjects enforcement, derived_from array schema, depth<=10, project_dir, and -32603 error safety', async () => {
  const env = makeTempEnv('cortex-mcp-p0-');
  const excludedProj = path.join(env.root, 'excluded_mcp_proj');
  const otherEnabledProj = path.join(env.root, 'other_enabled_proj');
  fs.mkdirSync(excludedProj, { recursive: true });
  fs.mkdirSync(otherEnabledProj, { recursive: true });
  approveProject(otherEnabledProj, { globalDir: env.globalDir });

  atomicWriteJson(path.join(env.globalDir, 'config.json'), {
    mode: 'all',
    excludedProjects: ['excluded_mcp_proj'],
  });

  const excludedStore = new CortexStore({ projectDir: excludedProj, globalDir: env.globalDir, disableVec: true });
  const enabledStore = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });

  try {
    // 1. Check schema fixes & SERVER_INSTRUCTIONS
    const enabledServer = createMcpServer({ store: enabledStore, hcClient: makeFakeHc() });
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
    const excludedServer = createMcpServer({ store: excludedStore, hcClient: makeFakeHc() });
    const initExcluded = await excludedServer.handleMessage({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
    assert.equal(initExcluded.result.instructions, EXCLUDED_SERVER_INSTRUCTIONS);
    assert.match(EXCLUDED_SERVER_INSTRUCTIONS, /relay_tabs\/relay_send\/relay_inbox/);

    const saveProjBlocked = await callTool(excludedServer, 'memory_save', { type: 'decision', title: 'Blocked', summary: 'Must fail' });
    assert.equal(saveProjBlocked.isError, true);
    assert.equal(saveProjBlocked.data.error, 'PROJECT_EXCLUDED');

    const updateProjBlocked = await callTool(excludedServer, 'memory_update', { id: 'dec-1', status: 'done' });
    assert.equal(updateProjBlocked.isError, true);
    assert.equal(updateProjBlocked.data.error, 'PROJECT_EXCLUDED');

    const relayBlocked = await callTool(excludedServer, 'relay_send', { to_terminal_id: 't2', message: 'blocked' });
    assert.equal(relayBlocked.isError, true);
    assert.equal(relayBlocked.data.error, 'PROJECT_EXCLUDED');

    // Global save + overview + search work on excluded project without EVER creating <excluded>/.memory/
    const saveGlobal = await callTool(excludedServer, 'memory_save', {
      scope: 'global', type: 'knowledge', category: 'preferences', title: 'Global Pref', summary: 'Use Korean',
    });
    assert.equal(saveGlobal.isError, false);

    const ovExcluded = await callTool(excludedServer, 'memory_overview', { format: 'json' });
    assert.equal(ovExcluded.data.projectExcluded, true);
    assert.equal(ovExcluded.data.globalPreferences.length, 1);

    const searchExcluded = await callTool(excludedServer, 'memory_search', { query: 'Korean', scope: 'all' });
    assert.ok(searchExcluded.data.results.length >= 1);
    assert.equal(fs.existsSync(path.join(excludedProj, '.memory')), false);

    // 3. Cross-project relay_send targeting excluded project returns TARGET_PROJECT_EXCLUDED & never creates .memory/
    const hcTargetExcl = makeFakeHc({ get: { 't-excl': hcGetAgent({ address: 't-excl', cwd: excludedProj, statusState: 'idle' }) } });
    const xprojServer = createMcpServer({ store: enabledStore, hcClient: hcTargetExcl });
    const targetExcl = await callTool(xprojServer, 'relay_send', { to_terminal_id: 't-excl', message: 'Cannot land in excluded project' });
    assert.equal(targetExcl.isError, true);
    assert.equal(targetExcl.data.error, 'TARGET_PROJECT_EXCLUDED');
    assert.equal(fs.existsSync(path.join(excludedProj, '.memory')), false);
    assert.equal(countPendingMessages('t-excl', { globalDir: env.globalDir }), 0);
    assert.deepEqual(hcTargetExcl.state.sent, []);

    // 4. Optional project_dir override works cleanly on memory_save & memory_search
    const saveOther = await callTool(enabledServer, 'memory_save', {
      id: 'other-doc-1', type: 'decision', title: 'Other workspace doc', summary: 'Stored via project_dir', project_dir: otherEnabledProj,
    });
    assert.equal(saveOther.isError, false);
    assert.equal(fs.existsSync(path.join(otherEnabledProj, '.memory', 'docs')), true);

    const readOther = await callTool(enabledServer, 'memory_read', { id: 'other-doc-1', scope: 'project', project_dir: otherEnabledProj });
    assert.equal(readOther.data.id, 'other-doc-1');

    // 5. P1-8: Stdio start() sends JSON-RPC -32603 error response if internal handleMessage throws (never hangs client)
    const input = new PassThrough();
    const output = new PassThrough();
    let outBuf = '';
    output.on('data', (chunk) => { outBuf += chunk.toString('utf8'); });

    const crashingServer = createMcpServer({
      store: enabledStore,
      hcClient: makeFakeHc(),
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
