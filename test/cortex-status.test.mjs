import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_CONFIG, REPO_ROOT, atomicWriteJson, atomicWriteText } from '../src/core/config.mjs';
import { DEFERRED_INDEX_FILE } from '../src/core/db.mjs';
import { CortexStore } from '../src/core/store.mjs';
import { approveAsUser } from './support/approve.mjs';
import { MAX_EMBED_ATTEMPTS } from '../src/embeddings/failed.mjs';
import { installCortex, isOwnHook } from '../src/hooks/installer.mjs';
import { deliverInboxForHook, enqueueMessage } from '../src/relay/inbox.mjs';
import { collectStatus, formatStatus } from '../scripts/cortex-status.mjs';

// Safety net: anything in this file that forgets to pass its temp home lands in a throw-away folder.
const FALLBACK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cortex-status-home-'));
process.env.HERDR_CORTEX_TEST_HOME = FALLBACK_HOME;
// Code that only knows HERDR_CORTEX_HOME (getGlobalDir) lands in the same throw-away folder.
process.env.HERDR_CORTEX_HOME = path.join(FALLBACK_HOME, '.herdr-cortex');

// What child processes see as the user's real home directory (USERPROFILE): code that ignores the test home
// cannot reach the real one, and `assertRealHomeUntouched` proves nothing of herdr-cortex went there.
const REAL_HOME_STAND_IN = path.join(FALLBACK_HOME, 'real-home-stand-in');
fs.mkdirSync(REAL_HOME_STAND_IN, { recursive: true });

// Environment of a child process that works on the test home of `env`. Its PATH holds one empty folder:
// whether this machine has `agy` on PATH must not change what the child reports about Antigravity.
function childEnvFor(env, extra = {}) {
  const out = { ...process.env };
  for (const key of Object.keys(out)) {
    if (/^(userprofile|HC_TERMINAL_ID|HERDR_CORTEX_HOME|path)$/i.test(key)) delete out[key];
  }
  out.USERPROFILE = REAL_HOME_STAND_IN;
  out.HERDR_CORTEX_TEST_HOME = env.homeDir;
  out.PATH = REAL_HOME_STAND_IN;
  return { ...out, ...extra };
}

function assertRealHomeUntouched() {
  // PowerShell keeps a cache of its own under AppData\ of whatever USERPROFILE it is started with.
  assert.deepEqual(fs.readdirSync(REAL_HOME_STAND_IN).filter((name) => name !== 'AppData'), [], 'nothing was written into the (stand-in) real home directory');
}
process.on('exit', () => {
  try {
    fs.rmSync(FALLBACK_HOME, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function makeTempEnv(prefix = 'herdr-cortex-status-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  return {
    root,
    homeDir,
    projectDir,
    globalDir: path.join(homeDir, '.herdr-cortex'),
    settingsPath: path.join(homeDir, '.claude', 'settings.json'),
    claudeJsonPath: path.join(homeDir, '.claude.json'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function docFile(id, title) {
  return `---\nid: ${id}\ntype: decision\nstatus: active\ntitle: ${title}\nsummary: A summary\nupdated_at: 2026-11-20T10:00:00.000Z\n---\n\nBody of ${title}\n`;
}

function lineOf(lines, name) {
  return lines.filter((line) => line.startsWith(`${name.padEnd(13)}: `)).map((line) => line.slice(15));
}

test('cortex-status: a fresh install reports every check as in order, without any network request', async () => {
  const env = makeTempEnv();
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (...args) => {
    fetched.push(args[0]);
    throw new Error('network access is not allowed in cortex-status');
  };
  try {
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false });
    // An embedding provider with a remote host and a key is configured: describing it must not contact it
    atomicWriteJson(path.join(env.globalDir, 'config.json'), {
      ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      embedding: { ...DEFAULT_CONFIG.embedding, provider: 'openai', openai: { ...DEFAULT_CONFIG.embedding.openai, apiKeyEnv: 'STATUS_TEST_KEY' } },
    });

    const status = await collectStatus({
      repoRoot: REPO_ROOT,
      cwd: env.projectDir,
      homeDir: env.homeDir,
      env: { STATUS_TEST_KEY: 'sk-secret-value-123' },
    });
    assert.deepEqual(status.warnings, []);
    assert.deepEqual(fetched, [], 'no network request');
    assert.equal(JSON.stringify(status).includes('sk-secret-value-123'), false, 'no key value in the status');

    assert.deepEqual(
      [status.node.running, status.node.recorded, status.node.recordedExists, status.node.versionOk],
      [process.execPath, process.execPath, true, true],
    );
    assert.equal(status.claudeHooks.ok, true);
    assert.deepEqual([status.claudeMcp.registered, status.claudeMcp.ours, status.claudeMcp.nodeExists], [true, true, true]);
    assert.equal(status.antigravity.present, false);
    assert.deepEqual([status.project.path, status.project.approved, status.project.enabled, status.project.rule], [env.projectDir, false, true, 'mode=all']);

    const lines = formatStatus(status);
    assert.equal(lines[0], '=== herdr-cortex status ===');
    assert.deepEqual(lineOf(lines, 'Repo'), [REPO_ROOT]);
    assert.deepEqual(lineOf(lines, 'Global store'), [env.globalDir]);
    assert.deepEqual(lineOf(lines, 'Node'), [`${process.version} OK | ${process.execPath}`]);
    assert.deepEqual(lineOf(lines, '  recorded'), ['same path (exists)']);
    assert.deepEqual(lineOf(lines, 'Claude hooks'), ['SessionStart=ok SessionEnd=ok PreCompact=ok UserPromptSubmit=ok PreToolUse=ok PostToolUse=ok PostToolUseFailure=ok SubagentStop=ok']);
    assert.deepEqual(lineOf(lines, 'Claude MCP'), ['"herdr-cortex" registered (node ok, server.mjs ok)']);
    assert.deepEqual(lineOf(lines, 'Antigravity'), ['not found (no "agy" on PATH and no ~/.gemini folder)']);
    assert.deepEqual(lineOf(lines, 'This folder'), [env.projectDir]);
    assert.deepEqual(lineOf(lines, '  approved'), ['no (approve with: cortex-trust approve)']);
    assert.deepEqual(lineOf(lines, '  enabled'), ['yes (mode=all) | headCore=on | hookBudget=9000']);
    assert.deepEqual(lineOf(lines, 'Embedding'), ['openai, model text-embedding-3-small; sends documents and search queries to api.openai.com; API key from environment variable STATUS_TEST_KEY.']);
    assert.deepEqual(lineOf(lines, 'Index'), [
      'project not read (folder not approved)',
      'global  docs=0 (embedded 0, pending 0, error 0) | not indexed=0 | duplicate ids=0',
    ]);
    assert.deepEqual(lineOf(lines, 'Relay inbox'), ['not in a Herdr tab (HC_TERMINAL_ID is not set); no inbox holds messages']);
    assert.deepEqual(lineOf(lines, 'Work size'), ['not in a Herdr tab (HC_TERMINAL_ID is not set); limit=1 file(s), 1000 chars']);
    assert.deepEqual(lineOf(lines, 'Config'), ['no problems']);
    assert.deepEqual(lineOf(lines, 'Result'), ['everything checked is in order']);
    assert.ok(lines.every((line) => line.length < 400));
    // Nothing was created in the unapproved project
    assert.deepEqual(fs.readdirSync(env.projectDir), []);
  } finally {
    globalThis.fetch = realFetch;
    env.cleanup();
  }
});

test('cortex-status: missing Node path, broken or missing registrations, an unapproved or excluded folder and configuration problems are each named with the fix', async () => {
  const env = makeTempEnv('herdr-cortex-status-broken-');
  try {
    // Nothing installed at all
    const bare = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: {} });
    const bareText = bare.warnings.join('\n');
    assert.match(bareText, /No install record found \(run install\.ps1 again\)/);
    assert.match(bareText, /Claude Code hook SessionStart: not registered \(run install\.ps1 again\)/);
    assert.match(bareText, /Claude Code MCP: no server named "herdr-cortex" in .*\.claude\.json\. Close every Claude Code window, then run install\.ps1 again\./);
    const bareLines = formatStatus(bare);
    assert.deepEqual(lineOf(bareLines, 'Claude hooks'), ['SessionStart=missing SessionEnd=missing PreCompact=missing UserPromptSubmit=missing PreToolUse=missing PostToolUse=missing PostToolUseFailure=missing SubagentStop=missing']);
    assert.deepEqual(lineOf(bareLines, 'Claude MCP'), ['"herdr-cortex" NOT registered']);
    assert.deepEqual(lineOf(bareLines, '  recorded'), ['none (no install record)']);
    assert.equal(bareLines.includes(`Needs attention (${bare.warnings.length}):`), true);

    // Installed with a Node that has since disappeared (uninstalled, or a version manager switched folders)
    const vanishedDir = path.join(env.root, 'nodes', 'v22');
    fs.mkdirSync(vanishedDir, { recursive: true });
    const vanishedNode = path.join(vanishedDir, 'node.exe');
    fs.writeFileSync(vanishedNode, '');
    fs.mkdirSync(path.join(env.homeDir, '.gemini'), { recursive: true });
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, nodePath: vanishedNode });
    fs.rmSync(vanishedDir, { recursive: true });

    const gone = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: {} });
    const goneText = gone.warnings.join('\n');
    assert.ok(goneText.includes(`The Node path recorded at install time does not exist: ${vanishedNode} (run install.ps1 again).`));
    assert.ok(goneText.includes(`Claude Code hook PreToolUse: the recorded Node path does not exist: ${vanishedNode} (run install.ps1 again).`));
    assert.ok(goneText.includes(`Claude Code MCP: the recorded Node path does not exist: ${vanishedNode} (run install.ps1 again).`));
    assert.match(goneText, /Antigravity hook SessionStart: the recorded Node path does not exist/);
    assert.match(goneText, /Antigravity MCP: node missing in /);
    const goneLines = formatStatus(gone);
    assert.deepEqual(lineOf(goneLines, '  recorded'), [`${vanishedNode} (MISSING)`]);
    assert.deepEqual(lineOf(goneLines, 'Claude hooks'), ['SessionStart=node_missing SessionEnd=node_missing PreCompact=node_missing UserPromptSubmit=node_missing PreToolUse=node_missing PostToolUse=node_missing PostToolUseFailure=node_missing SubagentStop=node_missing']);
    assert.deepEqual(lineOf(goneLines, 'Claude MCP'), ['"herdr-cortex" registered (node MISSING, server.mjs ok)']);
    assert.deepEqual(lineOf(goneLines, 'Antigravity'), ['SessionStart=node_missing PreInvocation=node_missing PreToolUse=node_missing PostToolUse=node_missing | MCP=node_missing | found by: ~/.gemini folder']);

    // Re-installed, then partly undone by hand and by a Claude Code that rewrote its file
    fs.rmSync(path.join(env.homeDir, '.gemini'), { recursive: true });
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false });
    const settings = readJson(env.settingsPath);
    delete settings.hooks.PreCompact;
    // a hook of the user's own that mentions the tool is not taken for the registration
    settings.hooks.PreCompact = [{ matcher: '', hooks: [{ type: 'command', command: 'node "C:\\work\\herdr-cortex\\src\\hooks\\claude.mjs" pre-compact' }] }];
    assert.equal(isOwnHook(settings.hooks.PreCompact[0].hooks[0]), false);
    atomicWriteJson(env.settingsPath, settings);
    atomicWriteJson(env.claudeJsonPath, { numStartups: 4, mcpServers: { cortex: { command: 'node', args: ['--no-warnings', path.join(REPO_ROOT, 'src', 'mcp', 'server.mjs')] } } });

    // The folder is excluded and the configuration carries problems
    atomicWriteJson(path.join(env.globalDir, 'config.json'), {
      mode: 'all',
      excludedProjects: [env.projectDir],
      embedding: { provider: 'olama', model: 'bge-m3' },
    });
    const broken = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: {} });
    const brokenText = broken.warnings.join('\n');
    assert.match(brokenText, /Claude Code hook PreCompact: not registered/);
    assert.match(brokenText, /Claude Code MCP: no server named "herdr-cortex" in .* \(only the old name "cortex"\)/);
    assert.match(brokenText, /Embedding configuration: .*olama/);
    assert.match(brokenText, /embedding\.model is from the old config format and ignored/);
    assert.equal(broken.project.enabled, false);
    const brokenLines = formatStatus(broken);
    assert.deepEqual(lineOf(brokenLines, 'Claude hooks'), ['SessionStart=ok SessionEnd=ok PreCompact=missing UserPromptSubmit=ok PreToolUse=ok PostToolUse=ok PostToolUseFailure=ok SubagentStop=ok']);
    assert.deepEqual(lineOf(brokenLines, '  enabled'), ['no (matches excludedProjects) | headCore=on | hookBudget=9000']);
    assert.deepEqual(lineOf(brokenLines, 'Index')[0], 'project not read (excluded by configuration)');
    assert.deepEqual(lineOf(brokenLines, 'Embedding'), ['off (provider "olama" is not usable); nothing is sent anywhere.']);
    assert.match(lineOf(brokenLines, 'Config')[0], /^\d+ problem\(s\), see below$/);

    // A config.json that is not JSON
    atomicWriteText(path.join(env.globalDir, 'config.json'), '{ "mode": ');
    const badConfig = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: {} });
    assert.match(badConfig.warnings.join('\n'), /Configuration: .*config\.json is ignored: /);
  } finally {
    env.cleanup();
  }
});

test('cortex-status: Antigravity counts as present on the signs the installer goes by (agy on PATH or ~/.gemini), and the line names the sign that was found', async () => {
  const env = makeTempEnv('herdr-cortex-status-agy-');
  try {
    const binDir = path.join(env.root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy'), '');
    const withAgy = { PATH: binDir };
    const withoutAgy = { PATH: env.root };
    const geminiDir = path.join(env.homeDir, '.gemini');
    const statusWith = (envVars) => collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: envVars });
    const agyWarnings = (status) => status.warnings.filter((line) => line.startsWith('Antigravity'));

    // Neither sign: the installer leaves Antigravity alone and the status says it was not found
    const skipped = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, env: withoutAgy });
    assert.deepEqual([skipped.antigravityPresent, fs.existsSync(geminiDir)], [false, false]);
    const absent = await statusWith(withoutAgy);
    assert.deepEqual([absent.antigravity.present, absent.antigravity.detectedBy], [false, '']);
    assert.deepEqual(lineOf(formatStatus(absent), 'Antigravity'), ['not found (no "agy" on PATH and no ~/.gemini folder)']);
    assert.deepEqual(agyWarnings(absent), []);

    // agy on PATH, nothing registered yet: the installer would set it up, so the status says what is missing
    const onPath = await statusWith(withAgy);
    assert.deepEqual([onPath.antigravity.present, onPath.antigravity.detectedBy, onPath.antigravity.ok], [true, 'path', false]);
    assert.deepEqual(lineOf(formatStatus(onPath), 'Antigravity'), ['SessionStart=missing PreInvocation=missing PreToolUse=missing PostToolUse=missing | MCP=missing | found by: "agy" on PATH']);
    assert.deepEqual(agyWarnings(onPath), [
      'Antigravity hook SessionStart: not registered (run install.ps1 again).',
      'Antigravity hook PreInvocation: not registered (run install.ps1 again).',
      'Antigravity hook PreToolUse: not registered (run install.ps1 again).',
      'Antigravity hook PostToolUse: not registered (run install.ps1 again).',
      `Antigravity MCP: missing in ${path.join(geminiDir, 'antigravity-cli', 'mcp_config.json')} (run install.ps1 again).`,
    ]);
    assert.equal(fs.existsSync(geminiDir), false, 'the check creates nothing');

    // The installer goes by the same sign; from then on the folder exists and is the sign that is named
    const viaPath = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, env: withAgy });
    assert.deepEqual([viaPath.antigravityPresent, viaPath.antigravityDetectedBy], [true, 'path']);
    for (const envVars of [withAgy, withoutAgy]) {
      const installed = await statusWith(envVars);
      assert.deepEqual([installed.antigravity.present, installed.antigravity.detectedBy, installed.antigravity.ok], [true, 'config-dir', true]);
      assert.deepEqual(lineOf(formatStatus(installed), 'Antigravity'), ['SessionStart=ok PreInvocation=ok PreToolUse=ok PostToolUse=ok | MCP=ok | found by: ~/.gemini folder']);
      assert.deepEqual(installed.warnings, []);
    }
  } finally {
    env.cleanup();
  }
});

test('cortex-status: approval, per-tier embedding status with given-up documents, documents left unindexed, duplicate ids, and pending / held relay messages of this tab', async () => {
  const env = makeTempEnv('herdr-cortex-status-data-');
  try {
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false });
    approveAsUser(env.projectDir, { globalDir: env.globalDir });
    // Project tier: ollama on this machine; global tier: gemini (key from the environment)
    atomicWriteJson(path.join(env.globalDir, 'config.json'), {
      ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      embedding: { ...DEFAULT_CONFIG.embedding, provider: 'gemini' },
      projects: { [env.projectDir]: { embedding: { provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'bge-m3' } } } },
    });

    // Documents: three in the project (one of them a duplicate id in a second file), one global
    const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
    try {
      store.saveDoc({ id: 'dec-ok', type: 'decision', title: 'Fine', summary: 'S' });
      store.saveDoc({ id: 'dec-gave-up', type: 'decision', title: 'Gave up', summary: 'S' });
      store.saveDoc({ scope: 'global', id: 'pref-1', type: 'knowledge', category: 'preferences', title: 'Pref', summary: 'S' });
      store.getTier('project').db
        .prepare("UPDATE docs SET embed_attempts = ?, embed_status = 'error', embed_error = 'bad input' WHERE id = 'dec-gave-up'")
        .run(MAX_EMBED_ATTEMPTS);
    } finally {
      store.close();
    }
    const docsDir = path.join(env.projectDir, '.memory', 'docs', '2026-11');
    atomicWriteText(path.join(docsDir, 'copy-of-dec-ok.md'), docFile('dec-ok', 'A second file with the same id'));
    // A document a hook left out (too slow for its time budget), as the hook records it
    atomicWriteText(path.join(docsDir, 'late-1.md'), docFile('late-1', 'Left out by a hook'));
    atomicWriteJson(path.join(env.projectDir, '.memory', 'state', DEFERRED_INDEX_FILE), {
      version: 1,
      updatedAt: '2026-11-23T10:00:00.000Z',
      count: 1,
      files: [{ path: 'docs/2026-11/late-1.md', size: 200, reason: 'time_budget' }],
    });

    // Relay: three messages for this tab, two already injected by a hook (held), one of the pending ones announced
    const opts = { globalDir: env.globalDir };
    enqueueMessage('t7', { id: 'm-1', from_terminal_id: 't1', message: 'first' }, opts);
    enqueueMessage('t7', { id: 'm-2', from_terminal_id: 't1', message: 'second' }, opts);
    assert.deepEqual(deliverInboxForHook('t7', opts).deliveredIds, ['m-1', 'm-2']);
    enqueueMessage('t7', { id: 'm-3', from_terminal_id: 't1', message: 'x'.repeat(30000) }, opts);
    assert.deepEqual(deliverInboxForHook('t7', { ...opts, maxChars: 2500 }).announcedIds, ['m-3']);
    enqueueMessage('t7', { id: 'm-4', from_terminal_id: 't1', message: 'fourth' }, opts);
    enqueueMessage('t9', { id: 'o-1', from_terminal_id: 't1', message: 'for another tab' }, opts);
    atomicWriteText(path.join(env.globalDir, 'state', 'inbox', 't7', '.broken', 'bad.json'), '{');

    const status = await collectStatus({
      repoRoot: REPO_ROOT,
      cwd: env.projectDir,
      homeDir: env.homeDir,
      env: { HC_TERMINAL_ID: 't7', GEMINI_API_KEY: 'g-secret-key' },
    });
    assert.equal(JSON.stringify(status).includes('g-secret-key'), false);
    const lines = formatStatus(status);

    assert.match(lineOf(lines, '  approved')[0], /^yes \(since \d{4}-/);
    assert.deepEqual(lineOf(lines, 'Embedding'), [
      '(this project\'s memory): ollama, model bge-m3; sends documents and search queries to 127.0.0.1:11434 (this machine).',
      '(global memory, shared by all projects): gemini, model gemini-embedding-001; sends documents and search queries to generativelanguage.googleapis.com; API key from environment variable GEMINI_API_KEY.',
      'gave up on 1 project document(s) after repeated failures: dec-gave-up (retry with: npm run embed -- --retry-failed)',
    ]);
    assert.deepEqual(status.embedding.failedDocuments.project.documents, [{ id: 'dec-gave-up', reason: 'document_errors', error: 'bad input' }]);

    // The check indexed the document the hook had left out, and found the duplicate id
    assert.deepEqual(lineOf(lines, 'Index'), [
      'project docs=3 (embedded 0, pending 2, error 1) | not indexed=0 (1 indexed by this check) | duplicate ids=1',
      'global  docs=1 (embedded 0, pending 1, error 0) | not indexed=0 | duplicate ids=0',
    ]);
    const projectTier = status.tiers[0];
    assert.deepEqual([projectTier.deferredBefore, projectTier.deferred.count], [1, 0]);
    assert.equal(projectTier.duplicates.length, 1);
    assert.equal(projectTier.duplicates[0].id, 'dec-ok');
    assert.match(status.warnings.join('\n'), /project memory: 1 document\(s\) skipped because their id is already used: dec-ok \(/);

    assert.deepEqual(status.relay.inbox, { terminalId: 't7', pending: 2, held: 2, broken: 1, announced: 1 });
    assert.deepEqual(lineOf(lines, 'Relay inbox'), ['tab t7: pending=2 (1 announced, waiting for ack), held=2, broken=1']);

    // Outside a Herdr tab every inbox that holds something is listed
    const outside = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: {} });
    const outsideLines = formatStatus(outside);
    assert.deepEqual(outside.relay.others.map((inbox) => [inbox.terminalId, inbox.pending, inbox.held]), [['t7', 2, 2], ['t9', 1, 0]]);
    assert.ok(outsideLines.includes('Relay inbox  : not in a Herdr tab (HC_TERMINAL_ID is not set); inboxes with messages:'));
    assert.ok(outsideLines.includes('             : tab t9: pending=1, held=0, broken=0'));
    // The key is missing now: a configuration problem of the global tier, named
    assert.match(outside.warnings.join('\n'), /Embedding configuration \(global memory\): /);

    // A file that is still not indexed after the check stays listed (here: unreadable as a document)
    fs.mkdirSync(path.join(docsDir, 'folder-named-like-a-doc.md'), { recursive: true });
    const again = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: {} });
    assert.equal(again.tiers[0].opened, true);
  } finally {
    env.cleanup();
  }
});

test('cortex-status command line: prints the layout for the folder given with --cwd, and --json prints the collected object', () => {
  const env = makeTempEnv('herdr-cortex-status-cli-');
  try {
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false });
    const childEnv = childEnvFor(env, { HC_TERMINAL_ID: 't4' });
    const script = path.join(REPO_ROOT, 'scripts', 'cortex-status.mjs');

    const text = spawnSync(process.execPath, ['--no-warnings', script, '--cwd', env.projectDir], { env: childEnv, encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stderr, '');
    const lines = text.stdout.trimEnd().split('\n');
    assert.equal(lines[0], '=== herdr-cortex status ===');
    assert.deepEqual(lines.map((line) => line.split(':')[0].trimEnd()).filter((name) => !name.startsWith(' ')), [
      '=== herdr-cortex status ===', 'Repo', 'Global store', 'Node', 'sqlite-vec', 'Claude hooks', 'Claude MCP', 'Antigravity',
      'This folder', 'Approvals', 'Embedding', 'Index', 'Index', 'Relay inbox', 'Work size', 'Config', 'Result',
    ]);
    assert.ok(lines.includes(`This folder  : ${env.projectDir}`));
    assert.ok(lines.includes('Relay inbox  : tab t4: pending=0, held=0, broken=0'));
    assert.ok(lines.includes('Work size    : tab t4: S (files in window=0, limit=1 file(s), 1000 chars)'));

    const json = spawnSync(process.execPath, ['--no-warnings', script, '--cwd', env.projectDir, '--json'], { env: childEnv, encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual([parsed.homeDir, parsed.globalDir, parsed.project.path, parsed.warnings], [env.homeDir, env.globalDir, env.projectDir, []]);
    assertRealHomeUntouched();
  } finally {
    env.cleanup();
  }
});
