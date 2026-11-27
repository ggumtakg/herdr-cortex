import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

import {
  DEFAULT_CONFIG,
  REPO_ROOT,
  atomicWriteJson,
  atomicWriteText,
  getConfigProblems,
  loadConfig,
} from '../src/core/config.mjs';
import {
  AGY_HOOK_KEY,
  CLAUDE_MCP_VERIFY_DELAY_MS,
  LEGACY_AGY_HOOK_KEY,
  LEGACY_MCP_SERVER_KEY,
  MCP_SERVER_KEY,
  OLD_DEFAULT_CONFIGS,
  buildShellHookCommand,
  checkAntigravity,
  checkClaudeHooks,
  checkClaudeMcpRegistration,
  claudeMcpAddArgs,
  claudeMcpRemoveArgs,
  createDatedBackup,
  describeInstalledEmbedding,
  describeMcpEntry,
  describeOwnHook,
  detectAntigravity,
  findBackups,
  formatBackupStamp,
  formatInstallSummary,
  getInstallRecordPath,
  installCortex,
  isLegacyReviveHook,
  isOwnHook,
  listBackups,
  migrateGlobalEmbeddingConfig,
  quotePathForShells,
  readInstallRecord,
  removeBackups,
  splitCommandLine,
  uninstallCortex,
} from '../src/hooks/installer.mjs';
import {
  CLAUDE_PRE_TOOL_USE_MATCHER,
  CORTEX_MCP_SERVER_NAMES,
  LEGACY_MCP_SERVER_NAME,
  MCP_SERVER_NAME,
  cortexToolBaseName,
  isCortexToolName,
} from '../src/hooks/tool-names.mjs';
import { SERVER_INFO, SERVER_INSTRUCTIONS } from '../src/mcp/server.mjs';

// Safety net: anything in this file that forgets to pass its temp home lands in a throw-away folder,
// never in the real home directory, and the real `claude` CLI is never started (see `isRealHomeRun`).
const FALLBACK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cortex-installer-home-'));
process.env.HERDR_CORTEX_TEST_HOME = FALLBACK_HOME;
// Code that only knows HERDR_CORTEX_HOME (getGlobalDir) lands in the same throw-away folder.
process.env.HERDR_CORTEX_HOME = path.join(FALLBACK_HOME, '.herdr-cortex');

// What child processes see as the user's real home directory (USERPROFILE): code that ignores the test home
// cannot reach the real one, and `assertRealHomeUntouched` proves nothing of herdr-cortex went there.
const REAL_HOME_STAND_IN = path.join(FALLBACK_HOME, 'real-home-stand-in');
fs.mkdirSync(REAL_HOME_STAND_IN, { recursive: true });

// Environment of a child process that works on the test home of `env`.
function childEnvFor(env, extra = {}) {
  const out = { ...process.env };
  for (const key of Object.keys(out)) {
    if (/^(userprofile|HC_TERMINAL_ID|HERDR_CORTEX_HOME)$/i.test(key)) delete out[key];
  }
  out.USERPROFILE = REAL_HOME_STAND_IN;
  out.HERDR_CORTEX_TEST_HOME = env.homeDir;
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

const IS_WINDOWS = process.platform === 'win32';
const SERVER_SCRIPT = path.join(REPO_ROOT, 'src', 'mcp', 'server.mjs');
const CLAUDE_HOOK_SCRIPT = path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs');
const AGY_HOOK_SCRIPT = path.join(REPO_ROOT, 'src', 'hooks', 'antigravity.mjs');
const CLAUDE_EVENTS = ['SessionStart', 'SessionEnd', 'PreCompact', 'UserPromptSubmit', 'PreToolUse'];

function makeTempEnv(prefix = 'herdr-cortex-installer-') {
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
    agyHooksPath: path.join(homeDir, '.gemini', 'config', 'hooks.json'),
    agyMcpPath: path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp_config.json'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// A file that only has to exist: stands in for a Node executable in a folder with an awkward name.
function fakeNode(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, IS_WINDOWS ? 'node.exe' : 'node');
  fs.writeFileSync(file, '');
  return file;
}

// Every file below `dir` with its content, to prove that a refused install changed nothing.
function snapshotTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out[path.relative(dir, abs)] = fs.readFileSync(abs, 'latin1');
    }
  };
  walk(dir);
  return out;
}

function ownHooksOf(settings, event) {
  return (settings.hooks?.[event] || []).flatMap((group) => (group.hooks || []).filter((hook) => isOwnHook(hook)));
}

// ---------------------------------------------------------------------------------------------
// Item 1: no dependency on `node` being on PATH
// ---------------------------------------------------------------------------------------------

test('installer: Claude Code hooks are written in exec form with the absolute Node path; MCP entries start that Node; the install record keeps it', () => {
  const env = makeTempEnv();
  try {
    // A Node path with a space and non-ASCII characters, as in "C:\Program Files" or a Korean user name
    const nodePath = fakeNode(path.join(env.root, 'Program Files 한글'));
    fs.mkdirSync(path.join(env.homeDir, '.gemini'), { recursive: true });

    const res = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, nodePath });
    assert.equal(res.ok, true);
    assert.equal(res.nodePath, nodePath);

    const settings = readJson(env.settingsPath);
    assert.deepEqual(Object.keys(settings.hooks).sort(), [...CLAUDE_EVENTS].sort());
    const expectedArg = { SessionStart: 'session-start', SessionEnd: 'session-end', PreCompact: 'pre-compact', UserPromptSubmit: 'user-prompt', PreToolUse: 'pre-tool-use' };
    for (const event of CLAUDE_EVENTS) {
      assert.equal(settings.hooks[event].length, 1, event);
      const [handler] = settings.hooks[event][0].hooks;
      // exec form: the executable alone in `command`, every argument its own `args` element, no shell involved
      assert.deepEqual(Object.keys(handler).sort(), ['args', 'command', 'timeout', 'type'], event);
      assert.equal(handler.type, 'command');
      assert.equal(handler.command, nodePath, event);
      assert.deepEqual(handler.args, ['--no-warnings', CLAUDE_HOOK_SCRIPT, expectedArg[event], '--id', 'herdr-cortex'], event);
      assert.equal(path.isAbsolute(handler.command), true);
      assert.deepEqual(describeOwnHook(handler), { form: 'exec', nodePath, scriptPath: CLAUDE_HOOK_SCRIPT, arg: expectedArg[event] });
    }

    // MCP entries (Claude Code and Antigravity)
    const claudeEntry = readJson(env.claudeJsonPath).mcpServers[MCP_SERVER_KEY];
    assert.deepEqual(claudeEntry, { type: 'stdio', command: nodePath, args: ['--no-warnings', SERVER_SCRIPT], env: {} });
    assert.deepEqual(readJson(env.agyMcpPath).mcpServers[MCP_SERVER_KEY], { command: nodePath, args: ['--no-warnings', SERVER_SCRIPT] });

    // Install record, read by the shell commands
    const record = readInstallRecord(env.globalDir);
    assert.equal(record.nodePath, nodePath);
    assert.equal(record.repoRoot, REPO_ROOT);
    assert.equal(getInstallRecordPath(env.globalDir), path.join(env.globalDir, 'state', 'install.json'));
    assert.match(formatInstallSummary(res).join('\n'), /\[OK\] Node for hooks and MCP server: /);

    // A Node path that does not exist is refused before anything is written
    const other = makeTempEnv('herdr-cortex-installer-nonode-');
    try {
      const bad = installCortex({ repoRoot: REPO_ROOT, homeDir: other.homeDir, nodePath: path.join(other.root, 'missing', 'node.exe') });
      assert.equal(bad.ok, false);
      assert.match(bad.problems[0].message, /not the absolute path of an existing Node executable/);
      assert.deepEqual(fs.readdirSync(other.homeDir), []);
      assert.equal(installCortex({ repoRoot: REPO_ROOT, homeDir: other.homeDir, nodePath: 'node' }).ok, false);
    } finally {
      other.cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test('installer: the Antigravity hook command is one line that cmd.exe, PowerShell and bash all run, also with spaces and non-ASCII characters in the paths', () => {
  const env = makeTempEnv('herdr-cortex-installer-shells-');
  try {
    // How a path is written
    if (IS_WINDOWS) {
      assert.equal(quotePathForShells('C:\\Program Files\\nodejs\\node.exe'), 'C:/"Program Files"/nodejs/node.exe');
      assert.equal(quotePathForShells('C:\\Users\\김 영민\\tools\\node.exe'), 'C:/Users/"김 영민"/tools/node.exe');
      assert.equal(quotePathForShells('C:\\nodejs\\node.exe'), 'C:/nodejs/node.exe');
      assert.equal(quotePathForShells("D:\\it's (x86) & co\\node.exe"), 'D:/"it\'s (x86) & co"/node.exe');
    }
    for (const unsafe of ['C:\\100%\\node.exe', 'C:\\a$b\\node.exe', 'C:\\a`b\\node.exe', 'C:\\a"b\\node.exe', 'C:\\a\nb\\node.exe', '']) {
      assert.throws(() => quotePathForShells(unsafe), /cannot be written into a hook command/, JSON.stringify(unsafe));
    }
    assert.equal(
      buildShellHookCommand({ nodePath: process.execPath, scriptPath: AGY_HOOK_SCRIPT, arg: 'session-start' }),
      `${quotePathForShells(process.execPath)} --no-warnings ${quotePathForShells(AGY_HOOK_SCRIPT)} session-start --id herdr-cortex`,
    );

    // What the installer writes, with the real Node of this test run
    fs.mkdirSync(path.join(env.homeDir, '.gemini'), { recursive: true });
    assert.equal(installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir }).ok, true);
    const group = readJson(env.agyHooksPath)[AGY_HOOK_KEY];
    assert.deepEqual(Object.keys(group).sort(), ['PreInvocation', 'SessionStart']);
    const command = group.PreInvocation[0].command;
    assert.equal(command, buildShellHookCommand({ nodePath: process.execPath, scriptPath: AGY_HOOK_SCRIPT, arg: 'pre-invocation' }));
    assert.deepEqual(group.PreInvocation[0], { type: 'command', command, timeout: 10 });
    assert.equal(isOwnHook(group.PreInvocation[0]), true);
    assert.deepEqual(splitCommandLine(command), [
      process.execPath.replace(/\\/g, '/'), '--no-warnings', AGY_HOOK_SCRIPT.replace(/\\/g, '/'), 'pre-invocation', '--id', 'herdr-cortex',
    ]);

    // The same line run by each shell that exists here. A subagent payload makes the hook answer "{}" at once.
    const payload = JSON.stringify({ conversationId: 'sub', rootConversationId: 'root' });
    const childEnv = childEnvFor(env);
    const ran = [];
    const check = (shell, stdout) => {
      assert.deepEqual(JSON.parse(String(stdout).trim()), {}, `${shell}: ${stdout}`);
      ran.push(shell);
    };
    if (IS_WINDOWS) {
      check('cmd', execSync(command, { input: payload, env: childEnv, encoding: 'utf8', shell: process.env.ComSpec || 'cmd.exe' }));
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input: payload, env: childEnv, encoding: 'utf8' });
      assert.equal(ps.status, 0, ps.stderr);
      check('powershell', ps.stdout);
    }
    const bashPath = IS_WINDOWS ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
    if (fs.existsSync(bashPath)) {
      const bash = spawnSync(bashPath, ['-c', command], { input: payload, env: childEnv, encoding: 'utf8' });
      assert.equal(bash.status, 0, bash.stderr);
      check('bash', bash.stdout);
    }
    assert.ok(ran.length >= 1, 'at least one shell ran the command');

    // The Claude Code entry, started the way Claude Code starts an exec-form hook: no shell at all
    const handler = readJson(env.settingsPath).hooks.SessionEnd[0].hooks[0];
    const direct = spawnSync(handler.command, handler.args, {
      input: JSON.stringify({ session_id: 'sess-x', reason: 'logout', cwd: env.projectDir }),
      env: childEnv,
      encoding: 'utf8',
    });
    assert.equal(direct.status, 0, direct.stderr);
    assertRealHomeUntouched();

    // A path no shell-neutral spelling exists for stops the install, naming the Antigravity file; nothing is written
    const other = makeTempEnv('herdr-cortex-installer-percent-');
    try {
      fs.mkdirSync(path.join(other.homeDir, '.gemini'), { recursive: true });
      const oddNode = fakeNode(path.join(other.root, '100% node'));
      const before = snapshotTree(other.homeDir);
      const res = installCortex({ repoRoot: REPO_ROOT, homeDir: other.homeDir, nodePath: oddNode });
      assert.equal(res.ok, false);
      assert.equal(res.problems.length, 1);
      assert.equal(res.problems[0].file, other.agyHooksPath);
      assert.match(res.problems[0].message, /cannot be written into a hook command/);
      assert.deepEqual(snapshotTree(other.homeDir), before);
      // Without Antigravity the same Node path is fine: exec form needs no quoting
      fs.rmSync(path.join(other.homeDir, '.gemini'), { recursive: true });
      const fine = installCortex({ repoRoot: REPO_ROOT, homeDir: other.homeDir, nodePath: oddNode, antigravityPresent: false });
      assert.equal(fine.ok, true);
      assert.equal(readJson(other.settingsPath).hooks.SessionStart[0].hooks[0].command, oddNode);
    } finally {
      other.cleanup();
    }
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 2: only entries with our marker are ours
// ---------------------------------------------------------------------------------------------

test('installer: a hook is ours only when it carries --id herdr-cortex; the user\'s hooks and the groups that hold them survive install and uninstall', () => {
  const env = makeTempEnv('herdr-cortex-installer-strict-');
  try {
    // Recognition
    const oldShellForm = { type: 'command', command: `node --no-warnings "${CLAUDE_HOOK_SCRIPT}" user-prompt --id herdr-cortex`, timeout: 10 };
    assert.equal(isOwnHook(oldShellForm), true);
    assert.deepEqual(describeOwnHook(oldShellForm), { form: 'shell', nodePath: 'node', scriptPath: CLAUDE_HOOK_SCRIPT, arg: 'user-prompt' });
    assert.equal(isOwnHook({ type: 'command', command: 'C:\\n\\node.exe', args: ['x.mjs', 'session-start', '--id', 'herdr-cortex'] }), true);
    assert.equal(isOwnHook({ type: 'command', command: '& "C:\\Program Files\\nodejs\\node.exe" "x.mjs" session-start --id herdr-cortex' }), true);
    for (const notOurs of [
      { type: 'command', command: 'node "C:\\work\\herdr-cortex\\my-own-hook.mjs"' },
      { type: 'command', command: `node "${CLAUDE_HOOK_SCRIPT}" session-start` },
      { type: 'command', command: 'node src/hooks/claude.mjs session-start' },
      { type: 'command', command: 'node hook.mjs --id herdr-cortex-fork' },
      { type: 'command', command: 'node hook.mjs --identity herdr-cortex' },
      { type: 'command', command: 'echo "--id herdr-cortex"' },
      { type: 'command', command: 'node', args: ['hook.mjs', '--id=herdr-cortex'] },
      { type: 'command', command: 'node record-session.mjs' },
      { type: 'prompt', prompt: 'mention --id herdr-cortex' },
      null,
    ]) {
      assert.equal(isOwnHook(notOurs), false, JSON.stringify(notOurs));
    }
    // The predecessor's hooks: exactly `node [--flags] <...>record-session.mjs <claude|antigravity>`
    for (const legacy of [
      'node "G:\\old\\scripts\\record-session.mjs" claude',
      'node record-session.mjs antigravity',
      'node.exe --no-warnings "C:\\tools\\herdr-revive\\scripts\\record-session.mjs" claude',
    ]) {
      assert.equal(isLegacyReviveHook({ type: 'command', command: legacy }), true, legacy);
    }
    for (const notLegacy of [
      'node "D:\\mine\\record-session.mjs" backup',
      'node "D:\\mine\\record-session.mjs"',
      'python record-session.mjs claude',
      'node my-record-session.mjs claude',
      'node record-session.mjs claude && echo done',
      'node other.mjs record-session.mjs claude extra',
    ]) {
      assert.equal(isLegacyReviveHook({ type: 'command', command: notLegacy }), false, notLegacy);
    }

    const userHooks = {
      mentionsName: { type: 'command', command: 'node "C:\\work\\herdr-cortex\\my-own-hook.mjs"' },
      sameScriptName: { type: 'command', command: 'node "D:\\other\\src\\hooks\\claude.mjs" session-start' },
      recordSession: { type: 'command', command: 'node "D:\\mine\\record-session.mjs" backup' },
      sharedGroup: { type: 'command', command: 'echo user-hook-in-a-shared-group' },
    };
    const original = {
      theme: 'dark',
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [userHooks.mentionsName] },
          { matcher: 'startup', hooks: [userHooks.sameScriptName, userHooks.recordSession] },
          // a group the user added their own hook to, next to ours (old shell form) and the predecessor's
          {
            matcher: '',
            hooks: [
              { type: 'command', command: `node --no-warnings "${CLAUDE_HOOK_SCRIPT}" session-start --id herdr-cortex`, timeout: 10 },
              userHooks.sharedGroup,
              { type: 'command', command: 'node "G:\\old\\scripts\\record-session.mjs" claude' },
            ],
          },
        ],
        // an event this installer does not use, with an entry of ours left from somewhere: still cleaned by the marker
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo stop-hook' }] }],
        Notification: [],
      },
    };
    atomicWriteJson(env.settingsPath, original);
    atomicWriteJson(env.agyHooksPath, {
      'user-group': { SessionStart: [{ type: 'command', command: 'echo custom' }] },
      [AGY_HOOK_KEY]: {
        SessionStart: [
          { type: 'command', command: `node --no-warnings "${AGY_HOOK_SCRIPT}" session-start --id herdr-cortex`, timeout: 10 },
          { type: 'command', command: 'echo user-hook-inside-our-group' },
        ],
        PostInvocation: [{ type: 'command', command: 'echo user-event-inside-our-group' }],
      },
      [LEGACY_AGY_HOOK_KEY]: {
        SessionStart: [
          { type: 'command', command: 'node record-session.mjs antigravity' },
          { type: 'command', command: 'echo user-hook-inside-the-old-group' },
        ],
      },
    });

    assert.equal(installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir }).ok, true);
    assert.equal(installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir }).ok, true);

    const installed = readJson(env.settingsPath);
    assert.equal(installed.theme, 'dark');
    assert.deepEqual(installed.hooks.SessionStart.slice(0, 3), [
      { matcher: '', hooks: [userHooks.mentionsName] },
      { matcher: 'startup', hooks: [userHooks.sameScriptName, userHooks.recordSession] },
      { matcher: '', hooks: [userHooks.sharedGroup] },
    ]);
    assert.equal(installed.hooks.SessionStart.length, 4);
    for (const event of CLAUDE_EVENTS) assert.equal(ownHooksOf(installed, event).length, 1, event);
    assert.deepEqual(installed.hooks.Stop, original.hooks.Stop);
    assert.deepEqual(installed.hooks.Notification, []);

    const agyInstalled = readJson(env.agyHooksPath);
    assert.deepEqual(agyInstalled['user-group'], { SessionStart: [{ type: 'command', command: 'echo custom' }] });
    assert.deepEqual(agyInstalled[LEGACY_AGY_HOOK_KEY], { SessionStart: [{ type: 'command', command: 'echo user-hook-inside-the-old-group' }] });
    assert.deepEqual(agyInstalled[AGY_HOOK_KEY].SessionStart.map((hook) => isOwnHook(hook)), [false, true]);
    assert.equal(agyInstalled[AGY_HOOK_KEY].SessionStart[0].command, 'echo user-hook-inside-our-group');
    assert.equal(agyInstalled[AGY_HOOK_KEY].PreInvocation.length, 1);
    assert.deepEqual(agyInstalled[AGY_HOOK_KEY].PostInvocation, [{ type: 'command', command: 'echo user-event-inside-our-group' }]);

    assert.equal(uninstallCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir }).ok, true);

    assert.deepEqual(readJson(env.settingsPath), {
      theme: 'dark',
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [userHooks.mentionsName] },
          { matcher: 'startup', hooks: [userHooks.sameScriptName, userHooks.recordSession] },
          { matcher: '', hooks: [userHooks.sharedGroup] },
        ],
        Stop: original.hooks.Stop,
        Notification: [],
      },
    });
    assert.deepEqual(readJson(env.agyHooksPath), {
      'user-group': { SessionStart: [{ type: 'command', command: 'echo custom' }] },
      [AGY_HOOK_KEY]: {
        SessionStart: [{ type: 'command', command: 'echo user-hook-inside-our-group' }],
        PostInvocation: [{ type: 'command', command: 'echo user-event-inside-our-group' }],
      },
      [LEGACY_AGY_HOOK_KEY]: { SessionStart: [{ type: 'command', command: 'echo user-hook-inside-the-old-group' }] },
    });

    // Uninstall with nothing of ours left changes nothing and writes no backup
    const again = uninstallCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir });
    assert.deepEqual([again.claudeSettings.action, again.antigravityHooks.action, again.backups.length], ['skipped', 'skipped', 0]);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 3: the server is called herdr-cortex
// ---------------------------------------------------------------------------------------------

test('rename: the server, its registration key and the PreToolUse matcher say herdr-cortex; the hooks still recognize the old prefix; prompts name neither', () => {
  assert.equal(MCP_SERVER_KEY, 'herdr-cortex');
  assert.equal(LEGACY_MCP_SERVER_KEY, 'cortex');
  assert.equal(MCP_SERVER_NAME, 'herdr-cortex');
  assert.equal(LEGACY_MCP_SERVER_NAME, 'cortex');
  assert.equal(SERVER_INFO.name, 'herdr-cortex');
  assert.match(SERVER_INSTRUCTIONS, /mcp__herdr-cortex__/);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /mcp__cortex__/);

  // Newly registered matcher: the new prefix only
  assert.equal(CLAUDE_PRE_TOOL_USE_MATCHER, 'mcp__herdr-cortex__.*|Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell');
  // Runtime recognition: both prefixes, so a setup that was not re-installed yet keeps working
  assert.deepEqual([...CORTEX_MCP_SERVER_NAMES], ['herdr-cortex', 'cortex']);
  for (const name of ['mcp__herdr-cortex__memory_save', 'mcp__cortex__memory_save']) {
    assert.equal(isCortexToolName(name), true, name);
    assert.equal(cortexToolBaseName(name), 'memory_save', name);
  }

  // Prompts and skills refer to tools by their bare names; no file names the server prefix
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.name.endsWith('.md') && /mcp__cortex__|mcp__herdr-cortex__|`cortex` (?:MCP|서버)/.test(fs.readFileSync(abs, 'utf8'))) {
        offenders.push(path.relative(REPO_ROOT, abs));
      }
    }
  };
  walk(path.join(REPO_ROOT, 'prompts'));
  assert.deepEqual(offenders, []);
});

test('installer: an old "cortex" entry is removed only when it is ours; a foreign "herdr-cortex" entry stops the install; uninstall removes only our entries', () => {
  const env = makeTempEnv('herdr-cortex-installer-mcp-');
  try {
    // Whose entry is it? Decided by what it starts, never by its name.
    const ours = { command: 'node', args: ['--no-warnings', SERVER_SCRIPT] };
    assert.deepEqual(describeMcpEntry(ours, { repoRoot: REPO_ROOT }), { ours: true, thisRepo: true, nodePath: 'node', scriptPath: SERVER_SCRIPT });
    // another checkout of herdr-cortex (its package.json says so)
    const otherCheckout = path.join(env.root, 'copy-of-the-tool');
    atomicWriteText(path.join(otherCheckout, 'package.json'), JSON.stringify({ name: 'herdr-cortex' }));
    atomicWriteText(path.join(otherCheckout, 'src', 'mcp', 'server.mjs'), '');
    const otherOurs = { command: 'C:\\n\\node.exe', args: ['--no-warnings', path.join(otherCheckout, 'src', 'mcp', 'server.mjs')] };
    assert.deepEqual([describeMcpEntry(otherOurs, { repoRoot: REPO_ROOT }).ours, describeMcpEntry(otherOurs, { repoRoot: REPO_ROOT }).thisRepo], [true, false]);
    // a different project that happens to have src/mcp/server.mjs
    const foreignProject = path.join(env.root, 'cortex-db');
    atomicWriteText(path.join(foreignProject, 'package.json'), JSON.stringify({ name: 'cortex-db' }));
    atomicWriteText(path.join(foreignProject, 'src', 'mcp', 'server.mjs'), '');
    const foreign = { command: 'node', args: [path.join(foreignProject, 'src', 'mcp', 'server.mjs')] };
    assert.equal(describeMcpEntry(foreign, { repoRoot: REPO_ROOT }).ours, false);
    // a herdr-cortex folder that was moved or deleted: recognized by the folder name; any other vanished folder is not
    assert.equal(describeMcpEntry({ command: 'node', args: ['--no-warnings', path.join(env.root, 'herdr-cortex-old', 'src', 'mcp', 'server.mjs')] }, { repoRoot: REPO_ROOT }).ours, true);
    assert.equal(describeMcpEntry({ command: 'node', args: [path.join(env.root, 'gone', 'src', 'mcp', 'server.mjs')] }, { repoRoot: REPO_ROOT }).ours, false);
    for (const notOurs of [
      { command: 'python', args: [SERVER_SCRIPT] },
      { command: 'node', args: ['src/mcp/server.mjs'] },
      { command: 'node', args: [path.join(REPO_ROOT, 'src', 'mcp', 'server.mjs.bak')] },
      { command: 'npx', args: ['cortex'] },
      { type: 'http', url: 'https://example.invalid/mcp' },
      null,
    ]) {
      assert.equal(describeMcpEntry(notOurs, { repoRoot: REPO_ROOT }).ours, false, JSON.stringify(notOurs));
    }

    // Old name, ours: replaced by the new name. Other servers are untouched.
    atomicWriteJson(env.claudeJsonPath, { numStartups: 5, mcpServers: { cortex: ours, other: { command: 'python', args: ['other.py'] } } });
    atomicWriteJson(env.agyMcpPath, { mcpServers: { cortex: ours } });
    atomicWriteJson(env.settingsPath, { mcpServers: { cortex: ours, keep: foreign } });
    const res = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir });
    assert.equal(res.ok, true);
    const claudeJson = readJson(env.claudeJsonPath);
    assert.deepEqual(Object.keys(claudeJson.mcpServers).sort(), ['herdr-cortex', 'other']);
    assert.equal(claudeJson.numStartups, 5);
    assert.deepEqual(claudeJson.mcpServers[MCP_SERVER_KEY].args, ['--no-warnings', SERVER_SCRIPT]);
    assert.deepEqual(Object.keys(readJson(env.agyMcpPath).mcpServers), ['herdr-cortex']);
    assert.deepEqual(readJson(env.settingsPath).mcpServers, { keep: foreign }, 'the entry the first release wrote into settings.json is removed too');
    assert.match(res.notes.join('\n'), /old name "cortex" was removed/);

    // Old name, not ours: left alone (and said so)
    atomicWriteJson(env.claudeJsonPath, { mcpServers: { cortex: foreign } });
    const kept = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir });
    assert.equal(kept.ok, true);
    assert.deepEqual(readJson(env.claudeJsonPath).mcpServers.cortex, foreign);
    assert.ok(readJson(env.claudeJsonPath).mcpServers[MCP_SERVER_KEY]);
    assert.match(kept.notes.join('\n'), /named "cortex" that is not herdr-cortex was left untouched/);

    // New name, not ours: stop, change nothing anywhere
    atomicWriteJson(env.claudeJsonPath, { mcpServers: { 'herdr-cortex': foreign } });
    fs.rmSync(env.settingsPath);
    const before = snapshotTree(env.homeDir);
    const refused = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.problems.map((p) => p.file), [env.claudeJsonPath]);
    assert.match(refused.problems[0].message, /already has an MCP server named "herdr-cortex" that does not start herdr-cortex/);
    assert.deepEqual(snapshotTree(env.homeDir), before);
    // The same in an Antigravity file
    atomicWriteJson(env.claudeJsonPath, {});
    atomicWriteJson(env.agyMcpPath, { mcpServers: { 'herdr-cortex': { command: 'npx', args: ['something-else'] } } });
    const refusedAgy = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir });
    assert.deepEqual([refusedAgy.ok, refusedAgy.problems[0].file], [false, env.agyMcpPath]);

    // Uninstall: our entries go, foreign ones under either name stay
    atomicWriteJson(env.agyMcpPath, { mcpServers: { 'herdr-cortex': ours, cortex: foreign } });
    atomicWriteJson(env.claudeJsonPath, { mcpServers: { 'herdr-cortex': foreign, cortex: ours } });
    const removed = uninstallCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir });
    assert.equal(removed.ok, true);
    assert.deepEqual(readJson(env.agyMcpPath).mcpServers, { cortex: foreign });
    assert.deepEqual(readJson(env.claudeJsonPath).mcpServers, { 'herdr-cortex': foreign });
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 4: registration through the claude CLI
// ---------------------------------------------------------------------------------------------

// A stand-in for the `claude` CLI: records every call and edits the test home's .claude.json the way
// `claude mcp add` / `claude mcp remove` edit the real one.
function makeFakeClaudeCli(env, { failOn = () => false } = {}) {
  const cli = { path: path.join(env.root, 'bin', 'claude.exe'), viaCmd: false };
  const calls = [];
  const runCli = (usedCli, args) => {
    assert.equal(usedCli, cli);
    calls.push([...args]);
    if (failOn(args)) return { status: 1, stdout: '', stderr: 'simulated failure\nsecond line' };
    const data = fs.existsSync(env.claudeJsonPath) ? readJson(env.claudeJsonPath) : {};
    data.mcpServers = data.mcpServers || {};
    if (args[0] === 'mcp' && args[1] === 'add') {
      const name = args[args.indexOf('--') - 1];
      if (data.mcpServers[name]) return { status: 1, stdout: '', stderr: `MCP server ${name} already exists in user config` };
      const [command, ...rest] = args.slice(args.indexOf('--') + 1);
      data.mcpServers[name] = { type: 'stdio', command, args: rest, env: {} };
    } else if (args[0] === 'mcp' && args[1] === 'remove') {
      if (!data.mcpServers[args[2]]) return { status: 1, stdout: '', stderr: `No MCP server found with name: ${args[2]}` };
      delete data.mcpServers[args[2]];
    } else {
      throw new Error(`unexpected claude call: ${args.join(' ')}`);
    }
    atomicWriteJson(env.claudeJsonPath, data);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { cli, calls, runCli };
}

test('installer: the Claude Code MCP server is registered and removed through "claude mcp add / remove" (user scope), with a direct file edit only as fallback', () => {
  const env = makeTempEnv('herdr-cortex-installer-cli-');
  try {
    const nodePath = process.execPath;
    assert.deepEqual(claudeMcpAddArgs(REPO_ROOT, nodePath), [
      'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'herdr-cortex', '--', nodePath, '--no-warnings', SERVER_SCRIPT,
    ]);
    assert.deepEqual(claudeMcpRemoveArgs('herdr-cortex'), ['mcp', 'remove', 'herdr-cortex', '--scope', 'user']);

    const fake = makeFakeClaudeCli(env);
    const common = { repoRoot: REPO_ROOT, homeDir: env.homeDir, claudeCli: fake.cli, runCli: fake.runCli, antigravityPresent: false };

    // First install over an old registration: remove the old name, add the new one
    atomicWriteJson(env.claudeJsonPath, { numStartups: 3, mcpServers: { cortex: { command: 'node', args: ['--no-warnings', SERVER_SCRIPT] } } });
    const first = installCortex(common);
    assert.equal(first.ok, true);
    assert.deepEqual(fake.calls, [claudeMcpRemoveArgs('cortex'), claudeMcpAddArgs(REPO_ROOT, nodePath)]);
    assert.deepEqual([first.claudeMcp.method, first.claudeMcp.verified, first.claudeMcp.cliAvailable], ['cli', true, true]);
    assert.deepEqual(readJson(env.claudeJsonPath), {
      numStartups: 3,
      mcpServers: { 'herdr-cortex': { type: 'stdio', command: nodePath, args: ['--no-warnings', SERVER_SCRIPT], env: {} } },
    });
    assert.equal(findBackups(env.claudeJsonPath).length, 1, 'the file is copied before the CLI changes it');
    assert.match(formatInstallSummary(first).join('\n'), /Claude Code MCP server "herdr-cortex" \(installed; through the claude CLI\)/);

    // Nothing to change: the CLI is not called at all
    fake.calls.length = 0;
    const second = installCortex(common);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual([second.claudeMcp.method, second.claudeMcp.changed, second.claudeMcp.verified], ['none', false, true]);

    // Another Node path: `claude mcp add` refuses an existing name, so ours is removed first
    const otherNode = fakeNode(path.join(env.root, 'other node'));
    installCortex({ ...common, nodePath: otherNode });
    assert.deepEqual(fake.calls, [claudeMcpRemoveArgs('herdr-cortex'), claudeMcpAddArgs(REPO_ROOT, otherNode)]);
    assert.equal(readJson(env.claudeJsonPath).mcpServers['herdr-cortex'].command, otherNode);

    // The CLI fails: the file is edited instead, and the output says so
    const failing = makeFakeClaudeCli(env, { failOn: (args) => args[1] === 'add' });
    const viaFallback = installCortex({ ...common, claudeCli: failing.cli, runCli: failing.runCli });
    assert.equal(viaFallback.ok, true);
    assert.deepEqual(failing.calls.map((args) => args[1]), ['remove', 'add']);
    assert.equal(viaFallback.claudeMcp.method, 'file');
    assert.equal(readJson(env.claudeJsonPath).mcpServers['herdr-cortex'].command, nodePath);
    assert.match(viaFallback.notes.join('\n'), /"claude mcp add" failed \(simulated failure\); the file was edited directly instead/);

    // No CLI: file edit, said in the summary
    fs.rmSync(env.claudeJsonPath);
    const noCli = installCortex({ ...common, claudeCli: null, runCli: () => { throw new Error('must not be called'); } });
    assert.deepEqual([noCli.claudeMcp.method, noCli.claudeMcp.cliAvailable, noCli.claudeMcp.verified], ['file', false, true]);
    assert.match(formatInstallSummary(noCli).join('\n'), /The claude CLI was not used .* written into the file directly/);

    // A home directory that is not the real one never reaches the real CLI, whatever is installed on this machine
    const untouched = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false, runCli: () => { throw new Error('the real CLI must not be started'); } });
    assert.equal(untouched.ok, true);

    // Read-back after a short wait: a running Claude Code that rewrites the file makes the entry disappear
    assert.equal(CLAUDE_MCP_VERIFY_DELAY_MS, 1500);
    fs.rmSync(env.claudeJsonPath);
    const waits = [];
    const lost = installCortex({
      ...common,
      verifyDelayMs: CLAUDE_MCP_VERIFY_DELAY_MS,
      sleep: (ms) => {
        waits.push(ms);
        atomicWriteJson(env.claudeJsonPath, { numStartups: 9 }); // what the running Claude Code writes back
      },
    });
    assert.deepEqual(waits, [1500]);
    assert.equal(lost.ok, true);
    assert.equal(lost.claudeMcp.verified, false);
    assert.match(formatInstallSummary(lost).join('\n'), /\[WARN\] The MCP server "herdr-cortex" is missing from .* Close every Claude Code window, then run the installer again\./);
    assert.deepEqual(
      (({ registered, ours, upToDate }) => ({ registered, ours, upToDate }))(checkClaudeMcpRegistration({ homeDir: env.homeDir, repoRoot: REPO_ROOT, nodePath })),
      { registered: false, ours: false, upToDate: false },
    );

    // Uninstall: `claude mcp remove herdr-cortex --scope user`, and only for an entry that is ours
    installCortex(common);
    fake.calls.length = 0;
    const removed = uninstallCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, claudeCli: fake.cli, runCli: fake.runCli });
    assert.deepEqual(fake.calls, [claudeMcpRemoveArgs('herdr-cortex')]);
    assert.deepEqual([removed.claudeMcp.action, removed.claudeMcp.method], ['removed', 'cli']);
    assert.deepEqual(readJson(env.claudeJsonPath).mcpServers, {});
    atomicWriteJson(env.claudeJsonPath, { mcpServers: { 'herdr-cortex': { command: 'npx', args: ['another-tool'] } } });
    fake.calls.length = 0;
    const notOurs = uninstallCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, claudeCli: fake.cli, runCli: fake.runCli });
    assert.deepEqual(fake.calls, []);
    assert.equal(notOurs.claudeMcp.action, 'skipped');
    assert.deepEqual(readJson(env.claudeJsonPath).mcpServers, { 'herdr-cortex': { command: 'npx', args: ['another-tool'] } });
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 5: validate first, back up every time, Antigravity only when present
// ---------------------------------------------------------------------------------------------

test('installer: every file is checked before any is written; one malformed file means nothing is changed and the file is named', () => {
  const env = makeTempEnv('herdr-cortex-installer-validate-');
  try {
    atomicWriteJson(env.agyHooksPath, { 'user-group': { SessionStart: [] } });
    atomicWriteJson(env.agyMcpPath, { mcpServers: {} });
    atomicWriteJson(env.claudeJsonPath, { numStartups: 1 });

    const cases = [
      [env.settingsPath, '{ "hooks": { "SessionStart": [ ', /is not valid JSON/],
      [env.settingsPath, '[1, 2]', /must contain a JSON object/],
      [env.settingsPath, '{ "hooks": [] }', /"hooks" must be a JSON object/],
      [env.settingsPath, '{ "hooks": { "PreToolUse": {} } }', /"hooks\.PreToolUse" must be a JSON array/],
      [env.claudeJsonPath, '{ "mcpServers": "none" }', /"mcpServers" must be a JSON object/],
      [env.claudeJsonPath, 'not json at all', /is not valid JSON/],
      [env.agyHooksPath, '{ "herdr-cortex": 5 }', /"herdr-cortex" must be a JSON object/],
      [env.agyMcpPath, '{ broken', /is not valid JSON/],
    ];
    for (const [file, content, expected] of cases) {
      const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      const before = snapshotTree(env.homeDir);

      const res = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir });
      assert.equal(res.ok, false, content);
      assert.deepEqual(res.problems.map((p) => p.file), [file], content);
      assert.match(res.problems[0].message, expected);
      assert.deepEqual(snapshotTree(env.homeDir), before, `nothing was written (${content})`);
      assert.equal(fs.existsSync(env.globalDir), false, 'not even the global store was created');

      if (saved) fs.writeFileSync(file, saved);
      else fs.rmSync(file);
    }

    // Two bad files: both are named
    fs.mkdirSync(path.dirname(env.settingsPath), { recursive: true });
    fs.writeFileSync(env.settingsPath, '{');
    fs.writeFileSync(env.claudeJsonPath, '}');
    assert.deepEqual(
      installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir }).problems.map((p) => p.file).sort(),
      [env.claudeJsonPath, env.settingsPath].sort(),
    );

    // The command line: exit code 1, the file named on stderr, nothing changed
    const before = snapshotTree(env.homeDir);
    const childEnv = childEnvFor(env);
    const cliRun = spawnSync(process.execPath, ['--no-warnings', path.join(REPO_ROOT, 'src', 'hooks', 'installer.mjs'), 'install', REPO_ROOT], { env: childEnv, encoding: 'utf8' });
    assert.equal(cliRun.status, 1);
    assert.ok(cliRun.stderr.includes(`[ERROR] ${env.settingsPath}: is not valid JSON`), cliRun.stderr);
    assert.match(cliRun.stderr, /\[ERROR\] Nothing was changed\./);
    assert.deepEqual(snapshotTree(env.homeDir), before);

    // Fixed: the same command installs, and uninstall skips an unreadable file but cleans the others
    atomicWriteJson(env.settingsPath, { theme: 'dark' });
    atomicWriteJson(env.claudeJsonPath, { numStartups: 1 });
    const okRun = spawnSync(process.execPath, ['--no-warnings', path.join(REPO_ROOT, 'src', 'hooks', 'installer.mjs'), 'install', REPO_ROOT], { env: childEnv, encoding: 'utf8' });
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.match(okRun.stdout, /\[OK\] Claude Code hooks \(installed\)/);
    assertRealHomeUntouched();
    assert.equal(readJson(env.settingsPath).hooks.SessionStart.length, 1);
    fs.writeFileSync(env.agyHooksPath, '{ broken');
    const partial = uninstallCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir });
    assert.equal(partial.ok, false);
    assert.deepEqual(partial.problems.map((p) => p.file), [env.agyHooksPath]);
    assert.equal(fs.readFileSync(env.agyHooksPath, 'utf8'), '{ broken');
    assert.deepEqual(readJson(env.settingsPath), { theme: 'dark' });
    assert.deepEqual(readJson(env.claudeJsonPath).mcpServers, {});
  } finally {
    env.cleanup();
  }
});

test('installer: a dated backup is written before every change to an existing file; old fixed-name backups are still recognized; backups can be listed and removed', () => {
  const env = makeTempEnv('herdr-cortex-installer-backup-');
  try {
    assert.equal(formatBackupStamp(new Date(2026, 10, 23, 9, 5, 7)), '20261123-090507');

    atomicWriteJson(env.settingsPath, { theme: 'dark' });
    const originalSettings = fs.readFileSync(env.settingsPath, 'utf8');
    const install = (now) => installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, now, antigravityPresent: false });

    const first = install(new Date(2026, 10, 23, 10, 0, 0));
    const firstBackup = `${env.settingsPath}.herdr-cortex.20261123-100000.bak`;
    assert.deepEqual(first.backups, [firstBackup]);
    assert.equal(first.claudeSettings.backupPath, firstBackup);
    assert.equal(fs.readFileSync(firstBackup, 'utf8'), originalSettings, 'the backup is the file as it was');
    assert.deepEqual(findBackups(env.claudeJsonPath), [], 'a file that did not exist before has no backup');

    // An install that changes nothing writes no file and no backup
    const mtime = fs.statSync(env.settingsPath).mtimeMs;
    const unchanged = install(new Date(2026, 10, 23, 11, 0, 0));
    assert.deepEqual([unchanged.backups, unchanged.claudeSettings.changed], [[], false]);
    assert.equal(fs.statSync(env.settingsPath).mtimeMs, mtime);

    // The user edits the file; the next install that changes it backs up that state under a new name
    const edited = readJson(env.settingsPath);
    edited.hooks.PreCompact = [];
    edited.model = 'opus';
    atomicWriteJson(env.settingsPath, edited);
    const editedText = fs.readFileSync(env.settingsPath, 'utf8');
    const second = install(new Date(2026, 10, 24, 8, 30, 15));
    const secondBackup = `${env.settingsPath}.herdr-cortex.20261124-083015.bak`;
    assert.deepEqual(second.backups, [secondBackup]);
    assert.equal(fs.readFileSync(secondBackup, 'utf8'), editedText);
    assert.equal(fs.readFileSync(firstBackup, 'utf8'), originalSettings, 'earlier backups are never overwritten');

    // Two changes within the same second: a counter keeps both
    assert.equal(createDatedBackup(env.settingsPath, new Date(2026, 10, 24, 8, 30, 15)), `${env.settingsPath}.herdr-cortex.20261124-083015-2.bak`);
    assert.equal(createDatedBackup(path.join(env.homeDir, 'missing.json')), '');

    // Uninstall backs up as well
    const removed = uninstallCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, now: new Date(2026, 10, 25, 1, 2, 3) });
    assert.ok(removed.backups.includes(`${env.settingsPath}.herdr-cortex.20261125-010203.bak`));
    assert.ok(removed.backups.includes(`${env.claudeJsonPath}.herdr-cortex.20261125-010203.bak`));

    // Listing: dated backups, the fixed name of earlier versions, and backups next to extra files (profiles);
    // files that only look similar are not ours
    const legacyBackup = `${env.claudeJsonPath}.herdr-cortex.bak`;
    fs.writeFileSync(legacyBackup, '{}');
    const profile = path.join(env.homeDir, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
    atomicWriteText(profile, '# profile\n');
    const profileBackup = `${profile}.herdr-cortex.20261123-100000.bak`;
    fs.writeFileSync(profileBackup, '# old profile\n');
    const notOurs = [`${env.settingsPath}.bak`, `${env.settingsPath}.herdr-cortex.notes.bak`, `${env.settingsPath}.herdr-cortex.20261123.bak`, `${env.settingsPath}.user.20261123-100000.bak`];
    for (const file of notOurs) fs.writeFileSync(file, 'keep');

    const listed = listBackups({ homeDir: env.homeDir, extraFiles: [profile] });
    assert.equal(listed.includes(legacyBackup), true);
    assert.equal(listed.includes(profileBackup), true);
    assert.equal(listed.filter((file) => file.startsWith(`${env.settingsPath}.herdr-cortex.`)).length, 4);
    for (const file of notOurs) assert.equal(listed.includes(file), false, file);
    assert.equal(listBackups({ homeDir: env.homeDir }).includes(profileBackup), false);

    const { removed: deleted, failed } = removeBackups({ homeDir: env.homeDir, extraFiles: [profile] });
    assert.deepEqual([deleted.length, failed.length], [listed.length, 0]);
    assert.deepEqual(listBackups({ homeDir: env.homeDir, extraFiles: [profile] }), []);
    for (const file of notOurs) assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
    assert.equal(fs.existsSync(env.settingsPath), true);
    assert.equal(fs.existsSync(profile), true);
  } finally {
    env.cleanup();
  }
});

test('installer: the Antigravity configuration is touched only when Antigravity is present (agy on PATH or an existing ~/.gemini)', () => {
  const env = makeTempEnv('herdr-cortex-installer-agy-');
  try {
    // Detection
    const noAgy = () => '';
    assert.equal(detectAntigravity({ homeDir: env.homeDir, findCommand: noAgy }), '');
    assert.equal(detectAntigravity({ homeDir: env.homeDir, findCommand: (name) => (name === 'agy' ? 'C:\\tools\\agy.exe' : '') }), 'path');
    const binDir = path.join(env.root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, IS_WINDOWS ? 'agy.cmd' : 'agy'), '');
    assert.equal(detectAntigravity({ homeDir: env.homeDir, env: { PATH: binDir } }), 'path');
    assert.equal(detectAntigravity({ homeDir: env.homeDir, env: { PATH: env.root } }), '');

    // Absent: nothing under ~/.gemini is created
    const absent = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, env: { PATH: env.root } });
    assert.equal(absent.ok, true);
    assert.equal(absent.antigravityPresent, false);
    assert.equal(fs.existsSync(path.join(env.homeDir, '.gemini')), false);
    assert.deepEqual([absent.antigravityHooks.action, ...absent.antigravityMcp.map((m) => m.action)], ['skipped', 'skipped', 'skipped']);
    assert.match(formatInstallSummary(absent).join('\n'), /\[SKIP\] Antigravity: no "agy" on PATH and no ~\/\.gemini folder; its configuration was not touched\./);
    // The status check goes by the same two signs as the installer, with the same PATH
    const absentState = checkAntigravity({ homeDir: env.homeDir, repoRoot: REPO_ROOT, env: { PATH: env.root } });
    assert.deepEqual([absentState.present, absentState.detectedBy, absentState.events], [false, '', {}]);
    assert.equal(checkAntigravity({ homeDir: env.homeDir, repoRoot: REPO_ROOT, findCommand: noAgy }).present, false);
    const onPathState = checkAntigravity({ homeDir: env.homeDir, repoRoot: REPO_ROOT, env: { PATH: binDir } });
    assert.deepEqual(
      [onPathState.present, onPathState.detectedBy, onPathState.ok, onPathState.events.SessionStart.state, onPathState.events.PreInvocation.state, onPathState.mcp.state],
      [true, 'path', false, 'missing', 'missing', 'missing'],
    );
    assert.equal(fs.existsSync(path.join(env.homeDir, '.gemini')), false, 'checking creates nothing');
    assert.equal(readJson(env.settingsPath).hooks.SessionStart.length, 1, 'Claude Code is set up all the same');

    // agy on PATH: its files are created
    const viaPath = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, env: { PATH: binDir } });
    assert.deepEqual([viaPath.antigravityPresent, viaPath.antigravityDetectedBy], [true, 'path']);
    assert.equal(readJson(env.agyHooksPath)[AGY_HOOK_KEY].SessionStart.length, 1);
    assert.ok(readJson(env.agyMcpPath).mcpServers[MCP_SERVER_KEY]);
    // the second MCP config file is only updated when it already exists
    assert.equal(fs.existsSync(path.join(env.homeDir, '.gemini', 'config', 'mcp_config.json')), false);

    // An existing ~/.gemini is enough, without agy on PATH
    const viaDir = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, env: { PATH: env.root } });
    assert.deepEqual([viaDir.antigravityPresent, viaDir.antigravityDetectedBy], [true, 'config-dir']);
    const agyState = checkAntigravity({ homeDir: env.homeDir, repoRoot: REPO_ROOT, env: { PATH: env.root } });
    assert.deepEqual([agyState.present, agyState.ok, agyState.events.SessionStart.state, agyState.events.PreInvocation.state, agyState.mcp.state], [true, true, 'ok', 'ok', 'ok']);
    // the folder is the sign that is reported, also when agy is on PATH as well
    assert.equal(agyState.detectedBy, 'config-dir');
    assert.equal(checkAntigravity({ homeDir: env.homeDir, repoRoot: REPO_ROOT, env: { PATH: binDir } }).detectedBy, 'config-dir');

    // Uninstall cleans the Antigravity files whenever they exist
    uninstallCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, env: { PATH: env.root } });
    assert.deepEqual(readJson(env.agyHooksPath), {});
    assert.deepEqual(readJson(env.agyMcpPath).mcpServers, {});
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 7: the default config of an older install
// ---------------------------------------------------------------------------------------------

test('installer: a config.json that is still an older default is replaced (with a backup); an edited one is kept and its problems are named', () => {
  const env = makeTempEnv('herdr-cortex-installer-config-');
  const configPath = path.join(env.globalDir, 'config.json');
  const install = (now = new Date(2026, 10, 23, 12, 0, 0)) => installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, now, antigravityPresent: false });
  try {
    assert.equal(OLD_DEFAULT_CONFIGS.length, 2);
    for (const oldDefault of OLD_DEFAULT_CONFIGS) assert.equal(oldDefault.embedding.provider, 'auto');

    // Exactly what an older installer wrote, whatever the formatting or key order
    const writers = [
      (cfg) => `${JSON.stringify(cfg, null, 2)}\n`,
      (cfg) => `\uFEFF${JSON.stringify(cfg)}`,
      (cfg) => JSON.stringify({ embedding: Object.fromEntries(Object.entries(cfg.embedding).reverse()), ...Object.fromEntries(Object.entries(cfg).filter(([key]) => key !== 'embedding').reverse()) }, null, 4),
    ];
    let stampHour = 1;
    for (const oldDefault of OLD_DEFAULT_CONFIGS) {
      for (const write of writers) {
        const text = write(oldDefault);
        atomicWriteText(configPath, text);
        const res = install(new Date(2026, 10, 23, stampHour++, 0, 0));
        assert.equal(res.ok, true);
        assert.equal(res.globalInit.configAction, 'replaced');
        assert.deepEqual(readJson(configPath), JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
        assert.equal(fs.readFileSync(res.globalInit.backupPath, 'utf8'), text, 'the old file is kept as a dated backup');
        assert.match(path.basename(res.globalInit.backupPath), /^config\.json\.herdr-cortex\.\d{8}-\d{6}\.bak$/);
        assert.ok(res.backups.includes(res.globalInit.backupPath));
        assert.match(formatInstallSummary(res).join('\n'), /config\.json was still the default of an older version .* replaced by the current default \(embedding off\)/);
        assert.deepEqual(getConfigProblems(loadConfig({ globalDir: env.globalDir })), []);
      }
    }
    assert.deepEqual(describeInstalledEmbedding({ homeDir: env.homeDir }), ['embedding: off (provider is "none"); nothing is sent anywhere.']);

    // The current default: nothing to do
    const backupsBefore = findBackups(configPath).length;
    const current = install();
    assert.deepEqual([current.globalInit.configAction, current.globalInit.configProblems, current.globalInit.backupPath], ['kept', [], '']);
    assert.equal(findBackups(configPath).length, backupsBefore);

    // Edited by the user (even slightly): left exactly as it is, and the problems are spelled out
    const editedText = `${JSON.stringify({ ...OLD_DEFAULT_CONFIGS[1], hookBudget: 5000 }, null, 2)}\n`;
    atomicWriteText(configPath, editedText);
    const kept = install();
    assert.equal(kept.ok, true);
    assert.equal(kept.globalInit.configAction, 'kept');
    assert.equal(fs.readFileSync(configPath, 'utf8'), editedText);
    assert.equal(findBackups(configPath).length, backupsBefore);
    assert.equal(kept.globalInit.configProblems.length, 1);
    assert.match(kept.globalInit.configProblems[0], /embedding\.baseUrl, embedding\.model, embedding\.dimensions, embedding\.apiKeyEnv, embedding\.onnxEnabled are from the old config format and ignored/);
    assert.ok(formatInstallSummary(kept).some((line) => line.startsWith(`[WARN] ${configPath}: `) && line.includes('old config format')));
    assert.match(describeInstalledEmbedding({ homeDir: env.homeDir })[0], /^embedding: off \(provider is "auto" and no provider is configured\)/);

    // A provider typo is reported the same way
    atomicWriteJson(configPath, { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), embedding: { ...DEFAULT_CONFIG.embedding, provider: 'olama' } });
    assert.match(install().globalInit.configProblems.join('\n'), /olama/);

    // Not JSON at all: not touched, reported, and the rest of the install still happens
    atomicWriteText(configPath, '{ "mode": ');
    const broken = install();
    assert.equal(broken.ok, true);
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{ "mode": ');
    assert.match(broken.globalInit.configProblems[0], /is not valid JSON/);

    // No file: the current default is created
    fs.rmSync(configPath);
    assert.equal(install().globalInit.configAction, 'created');
    assert.deepEqual(readJson(configPath).embedding.provider, 'none');
  } finally {
    env.cleanup();
  }
});

test('installer: legacy flat embedding keys in global config.json are migrated per provider (deleting unused ones), with backup, collision preservation, BOM/broken JSON handling, and idempotency', () => {
  const env = makeTempEnv('herdr-cortex-installer-migrate-');
  const configPath = path.join(env.globalDir, 'config.json');
  const runInstall = (now) => installCortex({
    repoRoot: REPO_ROOT,
    homeDir: env.homeDir,
    now,
    antigravityPresent: false,
  });

  try {
    // 1. Per-provider migration: gemini, openai, ollama, onnx (mapped keys moved, unmapped keys deleted)
    const providerCases = [
      {
        provider: 'gemini',
        input: {
          provider: 'gemini',
          baseUrl: 'https://gemini.proxy.example/v1beta',
          model: 'gemini-embedding-001',
          dimensions: 512,
          apiKey: 'secret-gemini-key-do-not-print',
          apiKeyEnv: 'MY_GEMINI_KEY',
          onnxEnabled: true,
          chunkMaxChars: 640,
        },
        expectedBlock: {
          baseUrl: 'https://gemini.proxy.example/v1beta',
          model: 'gemini-embedding-001',
          dimensions: 512,
          apiKey: 'secret-gemini-key-do-not-print',
          apiKeyEnv: 'MY_GEMINI_KEY',
        },
        expectedRemovedUnused: ['embedding.onnxEnabled'],
      },
      {
        provider: 'openai',
        input: {
          provider: 'openai',
          baseUrl: 'https://openai.proxy.example/v1',
          model: 'text-embedding-3-large',
          dimensions: 1024,
          apiKey: 'secret-openai-key-do-not-print',
          apiKeyEnv: 'MY_OPENAI_KEY',
          onnxEnabled: false,
        },
        expectedBlock: {
          baseUrl: 'https://openai.proxy.example/v1',
          model: 'text-embedding-3-large',
          dimensions: 1024,
          apiKey: 'secret-openai-key-do-not-print',
          apiKeyEnv: 'MY_OPENAI_KEY',
        },
        expectedRemovedUnused: ['embedding.onnxEnabled'],
      },
      {
        provider: 'ollama',
        input: {
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'bge-m3',
          dimensions: 1024,
          apiKey: 'secret-unused-ollama-key',
          apiKeyEnv: 'UNUSED_KEY_ENV',
          onnxEnabled: false,
        },
        expectedBlock: {
          baseUrl: 'http://127.0.0.1:11434',
          model: 'bge-m3',
          dimensions: 1024,
        },
        expectedRemovedUnused: ['embedding.apiKey', 'embedding.apiKeyEnv', 'embedding.onnxEnabled'],
      },
      {
        provider: 'onnx',
        input: {
          provider: 'onnx',
          model: 'Xenova/multilingual-e5-base',
          dimensions: 768,
          onnxEnabled: true,
          baseUrl: 'http://unused:11434',
          apiKey: 'secret-unused-onnx-key',
          apiKeyEnv: 'UNUSED_ONNX_ENV',
        },
        expectedBlock: {
          model: 'Xenova/multilingual-e5-base',
          dimensions: 768,
          enabled: true,
        },
        expectedRemovedUnused: ['embedding.baseUrl', 'embedding.apiKey', 'embedding.apiKeyEnv'],
      },
    ];

    let minute = 1;
    for (const tc of providerCases) {
      const rawBefore = {
        mode: 'opt-in',
        enabledProjects: ['D:\\work\\alpha'],
        customUserKey: { keep: [1, 2, 3] },
        embedding: {
          ...tc.input,
          unknownSharedKey: 'keep-me',
        },
        projects: {
          'D:\\work\\alpha': { embedding: { provider: 'ollama', model: 'stay-untouched' } },
        },
      };
      const beforeText = `${JSON.stringify(rawBefore, null, 2)}\n`;
      atomicWriteText(configPath, beforeText);

      const first = runInstall(new Date(2026, 10, 27, 9, minute++, 0));
      assert.equal(first.ok, true, tc.provider);
      assert.equal(first.globalInit.configAction, 'migrated', tc.provider);
      assert.ok(first.globalInit.backupPath, `${tc.provider} backup created`);
      assert.equal(fs.readFileSync(first.globalInit.backupPath, 'utf8'), beforeText, `${tc.provider} backup matches original`);
      assert.ok(first.backups.includes(first.globalInit.backupPath));
      assert.deepEqual(
        first.globalInit.migration.removedUnused.map((u) => u.from),
        tc.expectedRemovedUnused,
        `${tc.provider} removedUnused list`,
      );

      const after = readJson(configPath);
      assert.equal(after.mode, 'opt-in');
      assert.deepEqual(after.enabledProjects, ['D:\\work\\alpha']);
      assert.deepEqual(after.customUserKey, { keep: [1, 2, 3] });
      assert.equal(after.embedding.unknownSharedKey, 'keep-me');
      assert.deepEqual(after.projects, rawBefore.projects, 'per-project settings in projects map are not rewritten');
      assert.deepEqual(after.embedding[tc.provider], tc.expectedBlock, tc.provider);

      for (const movedKey of Object.keys(tc.input)) {
        if (movedKey === 'provider' || movedKey === 'chunkMaxChars') continue;
        assert.equal(movedKey in after.embedding, false, `${tc.provider} deletes every legacy key (${movedKey})`);
      }

      // After migration, loadConfig reports ZERO legacy_embedding_keys problems on global config
      assert.deepEqual(getConfigProblems(loadConfig({ globalDir: env.globalDir })), [], `${tc.provider} has empty configProblems`);

      const summaryText = formatInstallSummary(first).join('\n');
      assert.match(summaryText, /\[OK\] Migrated legacy embedding setting\(s\) in /);
      assert.match(summaryText, /\[OK\] Removed unused legacy embedding key\(s\) in .* \(not used by embedding\./);
      assert.ok(summaryText.includes(first.globalInit.backupPath));
      assert.doesNotMatch(summaryText, /not moved/);
      assert.doesNotMatch(summaryText, /old config format and ignored/);
      assert.equal(summaryText.includes('secret-'), false, 'secret key values must never appear in summary output');

      // Second run: nothing left to migrate -> file and backups untouched (idempotent)
      const afterFirstText = fs.readFileSync(configPath, 'utf8');
      const backupCountAfterFirst = findBackups(configPath).length;
      const second = runInstall(new Date(2026, 10, 27, 9, minute++, 0));
      assert.equal(second.ok, true);
      assert.equal(second.globalInit.configAction, 'kept', `${tc.provider} second run is a no-op`);
      assert.equal(second.globalInit.backupPath, '');
      assert.equal(fs.readFileSync(configPath, 'utf8'), afterFirstText);
      assert.equal(findBackups(configPath).length, backupCountAfterFirst);
    }

    // 2. Only unused legacy keys (nothing to move, e.g. provider: "gemini" with onnxEnabled: false):
    //    backed up once, deleted on first run, problem list empty, second run is a no-op
    const unusedOnlyRaw = {
      embedding: {
        provider: 'gemini',
        onnxEnabled: false,
        gemini: { apiKey: 'secret-keep-me', model: 'gemini-embedding-001' },
      },
    };
    const unusedOnlyBefore = `${JSON.stringify(unusedOnlyRaw, null, 2)}\n`;
    atomicWriteText(configPath, unusedOnlyBefore);
    const backupsBeforeUnused = findBackups(configPath).length;
    const unusedFirst = runInstall(new Date(2026, 10, 27, 9, 45, 0));
    assert.equal(unusedFirst.ok, true);
    assert.equal(unusedFirst.globalInit.configAction, 'migrated');
    assert.ok(unusedFirst.globalInit.backupPath);
    assert.equal(fs.readFileSync(unusedFirst.globalInit.backupPath, 'utf8'), unusedOnlyBefore);
    assert.equal(findBackups(configPath).length, backupsBeforeUnused + 1);
    const afterUnused = readJson(configPath);
    assert.equal('onnxEnabled' in afterUnused.embedding, false);
    assert.deepEqual(afterUnused.embedding.gemini, { apiKey: 'secret-keep-me', model: 'gemini-embedding-001' });
    assert.deepEqual(unusedFirst.globalInit.configProblems, []);
    assert.deepEqual(getConfigProblems(loadConfig({ globalDir: env.globalDir })), []);
    const unusedSummary = formatInstallSummary(unusedFirst).join('\n');
    assert.match(unusedSummary, /\[OK\] Removed unused legacy embedding key\(s\) in .* \(not used by embedding\.gemini\): embedding\.onnxEnabled \(backup: /);
    assert.doesNotMatch(unusedSummary, /Migrated legacy embedding setting/);
    assert.doesNotMatch(unusedSummary, /old config format/);
    assert.equal(unusedSummary.includes('secret-keep-me'), false);

    const afterUnusedText = fs.readFileSync(configPath, 'utf8');
    const unusedSecond = runInstall(new Date(2026, 10, 27, 9, 46, 0));
    assert.equal(unusedSecond.globalInit.configAction, 'kept');
    assert.equal(unusedSecond.globalInit.backupPath, '');
    assert.equal(findBackups(configPath).length, backupsBeforeUnused + 1);
    assert.equal(fs.readFileSync(configPath, 'utf8'), afterUnusedText);

    // 3. Direct unit check on migrateGlobalEmbeddingConfig with only unmapped keys
    const unmappedOnly = migrateGlobalEmbeddingConfig({
      embedding: { provider: 'ollama', onnxEnabled: true, apiKeyEnv: '' },
    });
    assert.equal(unmappedOnly.changed, true);
    assert.deepEqual(unmappedOnly.moved, []);
    assert.deepEqual(unmappedOnly.removedUnused.map((u) => u.from), ['embedding.apiKeyEnv', 'embedding.onnxEnabled']);
    assert.deepEqual(unmappedOnly.next, { embedding: { provider: 'ollama' } });

    // 4. Clean migration (all legacy keys valid for ollama): zero config problems afterward
    atomicWriteJson(configPath, {
      embedding: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'bge-m3', dimensions: 1024 },
    });
    const cleanMig = runInstall(new Date(2026, 10, 27, 10, 0, 0));
    assert.equal(cleanMig.globalInit.configAction, 'migrated');
    assert.deepEqual(cleanMig.globalInit.configProblems, []);
    assert.deepEqual(getConfigProblems(loadConfig({ globalDir: env.globalDir })), []);
    assert.match(
      describeInstalledEmbedding({ homeDir: env.homeDir })[0],
      /^embedding: ollama, model bge-m3; sends documents and search queries to 127\.0\.0\.1:11434/,
    );

    // 5. Existing target keys in provider block are NEVER overwritten (even when false or 0); legacy key is deleted
    atomicWriteJson(configPath, {
      embedding: {
        provider: 'onnx',
        model: 'old-flat-model',
        dimensions: 384,
        onnxEnabled: true,
        onnx: { enabled: false, model: 'explicit-new-model', dtype: 'fp16' },
      },
    });
    const collision = runInstall(new Date(2026, 10, 27, 10, 5, 0));
    assert.equal(collision.globalInit.configAction, 'migrated');
    const afterCollision = readJson(configPath);
    assert.deepEqual(afterCollision.embedding.onnx, {
      enabled: false,
      model: 'explicit-new-model',
      dtype: 'fp16',
      dimensions: 384,
    });
    assert.equal('model' in afterCollision.embedding, false);
    assert.equal('onnxEnabled' in afterCollision.embedding, false);
    assert.equal('dimensions' in afterCollision.embedding, false);
    const collisionSummary = formatInstallSummary(collision).join('\n');
    assert.match(collisionSummary, /\[OK\] Migrated legacy embedding setting\(s\).*embedding\.dimensions -> embedding\.onnx\.dimensions/);
    assert.match(collisionSummary, /\[OK\] Removed legacy embedding key\(s\).*existing values kept.*embedding\.model \(kept embedding\.onnx\.model\).*embedding\.onnxEnabled \(kept embedding\.onnx\.enabled\)/);

    // 6. BOM-prefixed config.json with legacy keys: migrates cleanly, backup keeps exact BOM bytes, second run is no-op
    const bomRaw = `\uFEFF${JSON.stringify({
      embedding: { provider: 'gemini', model: 'bom-gemini-model', onnxEnabled: false, gemini: { apiKey: 'k' } },
    })}\n`;
    atomicWriteText(configPath, bomRaw);
    const bomFirst = runInstall(new Date(2026, 10, 27, 10, 10, 0));
    assert.equal(bomFirst.ok, true);
    assert.equal(bomFirst.globalInit.configAction, 'migrated');
    assert.equal(fs.readFileSync(bomFirst.globalInit.backupPath, 'utf8'), bomRaw, 'backup preserves original UTF-8 BOM');
    assert.equal(fs.readFileSync(configPath, 'utf8').startsWith('\uFEFF'), false);
    assert.deepEqual(readJson(configPath).embedding, {
      provider: 'gemini',
      gemini: { apiKey: 'k', model: 'bom-gemini-model' },
    });
    assert.deepEqual(getConfigProblems(loadConfig({ globalDir: env.globalDir })), []);
    const bomSecond = runInstall(new Date(2026, 10, 27, 10, 11, 0));
    assert.equal(bomSecond.globalInit.configAction, 'kept');
    assert.equal(bomSecond.globalInit.backupPath, '');

    // 7. Broken JSON containing legacy keys: untouched, no backup, reported clearly
    const brokenRaw = '{"embedding": {"provider": "gemini", "model": "x", "onnxEnabled": false,}';
    atomicWriteText(configPath, brokenRaw);
    const backupsBeforeBroken = findBackups(configPath).length;
    const brokenRes = runInstall(new Date(2026, 10, 27, 10, 12, 0));
    assert.equal(brokenRes.ok, true);
    assert.equal(brokenRes.globalInit.configAction, 'kept');
    assert.equal(brokenRes.globalInit.backupPath, '');
    assert.equal(findBackups(configPath).length, backupsBeforeBroken);
    assert.equal(fs.readFileSync(configPath, 'utf8'), brokenRaw);
    assert.match(brokenRes.globalInit.configProblems[0], /is not valid JSON/);
    assert.match(formatInstallSummary(brokenRes).join('\n'), /\[WARN\].*config\.json: is not valid JSON/);

    // 8. Non-specific provider (auto, none, missing, unknown): NOT migrated, NO backup, warned clearly
    for (const nonSpecific of ['auto', 'none', '', undefined, 'unknown-prov']) {
      const raw = {
        hookBudget: 7000,
        embedding: {
          ...(nonSpecific !== undefined ? { provider: nonSpecific } : {}),
          model: 'bge-m3',
          baseUrl: 'http://127.0.0.1:11434',
        },
      };
      const rawText = `${JSON.stringify(raw, null, 2)}\n`;
      atomicWriteText(configPath, rawText);
      const backupsBefore = findBackups(configPath).length;
      const skipped = runInstall(new Date(2026, 10, 27, 10, 20 + minute++, 0));
      assert.equal(skipped.globalInit.configAction, 'kept');
      assert.equal(skipped.globalInit.backupPath, '');
      assert.equal(findBackups(configPath).length, backupsBefore);
      assert.equal(fs.readFileSync(configPath, 'utf8'), rawText);
      const skippedLines = formatInstallSummary(skipped).join('\n');
      assert.match(skippedLines, /were not migrated because embedding\.provider is /);
      assert.match(skippedLines, /delete unused flat keys/);
      assert.match(skippedLines, /Move provider settings into embedding\.<provider>/);
    }
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Status checks the shell command builds on
// ---------------------------------------------------------------------------------------------

test('status checks: hook registration is verified per event with the strict identification; the MCP registration check names what is wrong', () => {
  const env = makeTempEnv('herdr-cortex-installer-check-');
  try {
    // Nothing installed
    const empty = checkClaudeHooks({ homeDir: env.homeDir, repoRoot: REPO_ROOT });
    assert.equal(empty.ok, false);
    assert.deepEqual(Object.entries(empty.events).map(([event, info]) => [event, info.state]), CLAUDE_EVENTS.map((event) => [event, 'missing']));
    assert.equal(checkClaudeMcpRegistration({ homeDir: env.homeDir, repoRoot: REPO_ROOT }).registered, false);

    // A user hook that merely mentions the tool does not count as a registration
    atomicWriteJson(env.settingsPath, { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'node "C:\\work\\herdr-cortex\\my-own-hook.mjs" session-start' }] }] } });
    assert.equal(checkClaudeHooks({ homeDir: env.homeDir, repoRoot: REPO_ROOT }).events.SessionStart.state, 'missing');

    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false });
    const good = checkClaudeHooks({ homeDir: env.homeDir, repoRoot: REPO_ROOT });
    assert.equal(good.ok, true);
    assert.deepEqual(Object.values(good.events).map((info) => [info.state, info.count, info.form, info.nodePath]), CLAUDE_EVENTS.map(() => ['ok', 1, 'exec', process.execPath]));
    const reg = checkClaudeMcpRegistration({ homeDir: env.homeDir, repoRoot: REPO_ROOT, nodePath: process.execPath });
    assert.deepEqual(
      [reg.readable, reg.registered, reg.ours, reg.thisRepo, reg.upToDate, reg.nodePath, reg.nodeExists, reg.scriptPath, reg.scriptExists, reg.legacyRegistered],
      [true, true, true, true, true, process.execPath, true, SERVER_SCRIPT, true, false],
    );

    // Break the registration in the ways the status display has to tell apart
    const settings = readJson(env.settingsPath);
    const handlerOf = (event) => settings.hooks[event].find((group) => group.hooks.some((hook) => isOwnHook(hook))).hooks.find((hook) => isOwnHook(hook));
    handlerOf('SessionStart').command = path.join(env.root, 'gone', 'node.exe'); // Node was uninstalled or moved
    settings.hooks.SessionEnd.push(JSON.parse(JSON.stringify(settings.hooks.SessionEnd[0]))); // registered twice
    delete settings.hooks.PreCompact; // removed by hand
    settings.hooks.UserPromptSubmit = [{ matcher: '', hooks: [{ type: 'command', command: `node --no-warnings "${CLAUDE_HOOK_SCRIPT}" user-prompt --id herdr-cortex`, timeout: 10 }] }]; // an install from before the absolute path
    settings.hooks.PreToolUse[0].matcher = 'mcp__cortex__.*'; // the matcher of an older version
    atomicWriteJson(env.settingsPath, settings);
    const broken = checkClaudeHooks({ homeDir: env.homeDir, repoRoot: REPO_ROOT });
    assert.equal(broken.ok, false);
    assert.deepEqual(Object.fromEntries(Object.entries(broken.events).map(([event, info]) => [event, info.state])), {
      SessionStart: 'node_missing',
      SessionEnd: 'duplicate',
      PreCompact: 'missing',
      UserPromptSubmit: 'node_on_path',
      PreToolUse: 'matcher',
    });
    assert.match(broken.events.SessionStart.problems[0].message, /the recorded Node path does not exist: .*gone/);
    assert.match(broken.events.UserPromptSubmit.problems[0].message, /starts "node" by name, which only works while node is on PATH/);

    // A hook that points at another checkout
    const elsewhere = readJson(env.settingsPath);
    elsewhere.hooks.SessionEnd = [{ matcher: '', hooks: [{ type: 'command', command: process.execPath, args: ['--no-warnings', path.join(env.root, 'old-checkout', 'src', 'hooks', 'claude.mjs'), 'session-end', '--id', 'herdr-cortex'], timeout: 5 }] }];
    atomicWriteJson(env.settingsPath, elsewhere);
    assert.equal(checkClaudeHooks({ homeDir: env.homeDir, repoRoot: REPO_ROOT }).events.SessionEnd.state, 'script_missing');

    // settings.json unreadable
    fs.writeFileSync(env.settingsPath, '{');
    const unreadable = checkClaudeHooks({ homeDir: env.homeDir, repoRoot: REPO_ROOT });
    assert.deepEqual([unreadable.readable, unreadable.ok], [false, false]);
    assert.match(unreadable.error, /is not valid JSON/);

    // MCP: an entry from before the absolute path, the old name, a foreign entry
    atomicWriteJson(env.claudeJsonPath, { mcpServers: { cortex: { command: 'node', args: ['--no-warnings', SERVER_SCRIPT] } } });
    const oldName = checkClaudeMcpRegistration({ homeDir: env.homeDir, repoRoot: REPO_ROOT });
    assert.deepEqual([oldName.registered, oldName.legacyRegistered], [false, true]);
    atomicWriteJson(env.claudeJsonPath, { mcpServers: { 'herdr-cortex': { command: 'node', args: ['--no-warnings', SERVER_SCRIPT] } } });
    const byName = checkClaudeMcpRegistration({ homeDir: env.homeDir, repoRoot: REPO_ROOT, nodePath: process.execPath });
    assert.deepEqual([byName.registered, byName.ours, byName.nodePath, byName.nodeExists, byName.upToDate], [true, true, 'node', false, false]);
    atomicWriteJson(env.claudeJsonPath, { mcpServers: { 'herdr-cortex': { command: 'npx', args: ['x'] } } });
    const foreign = checkClaudeMcpRegistration({ homeDir: env.homeDir, repoRoot: REPO_ROOT });
    assert.deepEqual([foreign.registered, foreign.ours], [true, false]);
  } finally {
    env.cleanup();
  }
});
