import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from '../src/core/config.mjs';
import { installCortex } from '../src/hooks/installer.mjs';
import {
  HOST_SPECS,
  buildSpawnSpec,
  buildWorkerEnv,
  buildWorkerPrompt,
  resolveExecutable,
  runWorker,
} from '../scripts/cortex-worker.mjs';

const WORKER_SCRIPT = path.join(REPO_ROOT, 'scripts', 'cortex-worker.mjs');
const AUTO_REVIVE = path.join(REPO_ROOT, 'scripts', 'auto-revive.ps1');
const SYS_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYS_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CSC_EXE = path.join(SYS_ROOT, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const HAS_POWERSHELL = process.platform === 'win32' && fs.existsSync(POWERSHELL);
const HAS_CSC = process.platform === 'win32' && fs.existsSync(CSC_EXE);
const SKIP_PS = HAS_POWERSHELL ? false : 'Windows PowerShell is not available';

const FALLBACK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cortex-worker-home-'));
const REAL_HOME_STAND_IN = path.join(FALLBACK_HOME, 'real-home-stand-in');
fs.mkdirSync(REAL_HOME_STAND_IN, { recursive: true });

process.on('exit', () => {
  try {
    fs.rmSync(FALLBACK_HOME, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function assertRealHomeUntouched() {
  assert.deepEqual(
    fs.readdirSync(REAL_HOME_STAND_IN).filter((name) => name !== 'AppData'),
    [],
    'nothing was written into the (stand-in) real home directory',
  );
}

function isPidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isPidAlive(pid);
}

function makeTempEnv(prefix = 'herdr-cortex-worker-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(root, 'home');
  const projectDir = path.join(root, 'project 폴더 (공백)');
  const binDir = path.join(root, 'bin');
  const tempDir = path.join(root, 'temp');
  for (const dir of [homeDir, projectDir, binDir, tempDir]) fs.mkdirSync(dir, { recursive: true });
  return {
    root,
    homeDir,
    projectDir,
    binDir,
    tempDir,
    globalDir: path.join(homeDir, '.herdr-cortex'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

function childEnvFor(env, { pathDirs = [env.binDir], extra = {} } = {}) {
  const out = { ...process.env };
  for (const key of Object.keys(out)) {
    if (/^(path|temp|tmp|tmpdir|userprofile|home|HC_TERMINAL_ID|HERDR_CORTEX_ROLE|HERDR_CORTEX_HOME|HERDR_CORTEX_TEST_HOME|HERDR_REVIVE_TEST_HOME)$/i.test(key)) {
      delete out[key];
    }
  }
  const baseDirs = process.platform === 'win32'
    ? [path.join(SYS_ROOT, 'System32'), SYS_ROOT, path.join(SYS_ROOT, 'System32', 'WindowsPowerShell', 'v1.0')]
    : ['/usr/bin', '/bin'];
  const sep = process.platform === 'win32' ? ';' : ':';
  out.PATH = [...pathDirs, ...baseDirs].join(sep);
  out.TEMP = env.tempDir;
  out.TMP = env.tempDir;
  out.USERPROFILE = REAL_HOME_STAND_IN;
  out.HOME = REAL_HOME_STAND_IN;
  out.HERDR_CORTEX_TEST_HOME = env.homeDir;
  out.HERDR_CORTEX_HOME = env.globalDir;
  return { ...out, ...extra };
}

function makeMemorySink() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
      return true;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/**
 * Install a fake `agy` or `claude` executable in `targetBinDir` (`.cmd`, npm-style `.ps1` shim invoking `node`,
 * or compiled `.exe` invoking `node` on Windows; executable shell script elsewhere).
 * Records `{ argv, cwd, roleEnv, hasTerminalId, customMark, settingsPath, settingsJson }` in `calls.jsonl`.
 */
function makeFakeHostCli(env, binName, { winKind = 'cmd', binDir = env.binDir } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const callsPath = path.join(env.root, `${binName}-${winKind}-calls.jsonl`);
  const runnerPath = path.join(binDir, `${binName}-runner.mjs`);
  const runnerSource = [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    `const callsPath = ${JSON.stringify(callsPath)};`,
    'const argv = process.argv.slice(2);',
    'const envKeys = Object.keys(process.env);',
    'const hasTerminalId = envKeys.some((k) => k.toLowerCase() === "hc_terminal_id");',
    'let settingsPath = null;',
    'let settingsJson = null;',
    'const settingsIdx = argv.indexOf("--settings");',
    'if (settingsIdx !== -1 && settingsIdx + 1 < argv.length) {',
    '  settingsPath = argv[settingsIdx + 1];',
    '  if (fs.existsSync(settingsPath)) {',
    '    settingsJson = JSON.parse(fs.readFileSync(settingsPath, "utf8"));',
    '  }',
    '}',
    'const record = {',
    '  argv,',
    '  cwd: process.cwd(),',
    '  roleEnv: process.env.HERDR_CORTEX_ROLE || null,',
    '  hasTerminalId,',
    '  customMark: process.env.WORKER_TEST_PASSTHROUGH || null,',
    '  settingsPath,',
    '  settingsJson,',
    '};',
    'fs.appendFileSync(callsPath, JSON.stringify(record) + "\\n", "utf8");',
    'const mode = process.env.FAKE_HOST_MODE || "ok";',
    'if (mode === "sleep-tree") {',
    '  const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    '  if (process.env.FAKE_HOST_PIDS_FILE) {',
    '    fs.writeFileSync(process.env.FAKE_HOST_PIDS_FILE, JSON.stringify({ childPid: process.pid, grandchildPid: gc.pid }), "utf8");',
    '  }',
    '  setInterval(() => {}, 1000);',
    '} else if (mode === "empty") {',
    '  process.exit(0);',
    '} else if (mode === "whitespace") {',
    '  process.stdout.write("   \\n");',
    '  process.exit(0);',
    '} else {',
    '  const outText = process.env.FAKE_HOST_STDOUT || "첫째 줄: 역할 확인 완료\\n둘째 줄: version=1.1.1\\n";',
    '  if (process.env.FAKE_HOST_STDERR) process.stderr.write(process.env.FAKE_HOST_STDERR);',
    '  process.stdout.write(outText);',
    '  process.exit(Number(process.env.FAKE_HOST_EXIT || 0));',
    '}',
  ].join('\n');
  fs.writeFileSync(runnerPath, runnerSource, 'utf8');

  let installedPath;
  if (process.platform === 'win32') {
    if (winKind === 'ps1') {
      installedPath = path.join(binDir, `${binName}.ps1`);
      // npm-style .ps1 shim that forwards $args to a native executable (node.exe).
      const ps1Source = [
        `& "${process.execPath}" "${runnerPath}" $args`,
        'exit $LASTEXITCODE',
        '',
      ].join('\r\n');
      fs.writeFileSync(installedPath, ps1Source, 'utf8');
    } else if (winKind === 'exe') {
      installedPath = path.join(binDir, `${binName}.exe`);
      const csPath = path.join(env.root, `${binName}-shim.cs`);
      const csSource = `
using System;
using System.Diagnostics;
using System.Text;
class Shim {
  static string Quote(string s) {
    if (s.Length > 0 && s.IndexOfAny(new char[] { ' ', '\\t', '\\n', '\\v', '"' }) == -1) return s;
    var sb = new StringBuilder("\\"");
    int bs = 0;
    foreach (char c in s) {
      if (c == '\\\\') { bs++; }
      else if (c == '"') { sb.Append('\\\\', bs * 2 + 1); sb.Append('"'); bs = 0; }
      else { sb.Append('\\\\', bs); sb.Append(c); bs = 0; }
    }
    sb.Append('\\\\', bs * 2);
    sb.Append('"');
    return sb.ToString();
  }
  static int Main(string[] args) {
    var sb = new StringBuilder();
    sb.Append(Quote(${JSON.stringify(runnerPath)}));
    foreach (var a in args) { sb.Append(' '); sb.Append(Quote(a)); }
    var psi = new ProcessStartInfo(${JSON.stringify(process.execPath)}, sb.ToString());
    psi.UseShellExecute = false;
    var p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}
`;
      fs.writeFileSync(csPath, csSource, 'utf8');
      const compileRes = spawnSync(CSC_EXE, ['/nologo', `/out:${installedPath}`, csPath], {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(compileRes.status, 0, `${compileRes.stdout}\n${compileRes.stderr}`);
    } else {
      installedPath = path.join(binDir, `${binName}.cmd`);
      fs.writeFileSync(
        installedPath,
        `@echo off\r\n"${process.execPath}" "%~dp0${binName}-runner.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`,
        'utf8',
      );
    }
  } else {
    installedPath = path.join(binDir, binName);
    fs.writeFileSync(installedPath, `#!/bin/sh\nexec "${process.execPath}" "${runnerPath}" "$@"\n`, { mode: 0o755 });
  }

  return {
    installedPath,
    calls() {
      if (!fs.existsSync(callsPath)) return [];
      return fs.readFileSync(callsPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    reset() {
      fs.rmSync(callsPath, { force: true });
    },
  };
}

test('cortex-worker: .ps1 shims invoking node and .cmd shims preserve prompt (Korean + spaces) and temp settings / allow rules, isolate env, write --out UTF-8, and clean up temp settings', async () => {
  const env = makeTempEnv('herdr-cortex-worker-run-');
  try {
    // Both agy and claude use npm-style .ps1 shims that invoke node.exe on Windows
    const agyPs1Dir = path.join(env.root, 'bin-agy-ps1');
    const claudePs1Dir = path.join(env.root, 'bin-claude-ps1');
    const agyCmdDir = path.join(env.root, 'bin-agy-cmd');
    const agyPs1 = makeFakeHostCli(env, 'agy', { winKind: 'ps1', binDir: agyPs1Dir });
    const claudePs1 = makeFakeHostCli(env, 'claude', { winKind: 'ps1', binDir: claudePs1Dir });
    const agyCmd = makeFakeHostCli(env, 'agy', { winKind: 'cmd', binDir: agyCmdDir });

    const briefDir = path.join(env.root, '지시 폴더 (한글 & 공백)');
    fs.mkdirSync(briefDir, { recursive: true });
    const briefPath = path.join(briefDir, '작업 지시서.md');
    const secretMarker = 'SECRET_BRIEF_BODY_NEVER_IN_ARGV_98765';
    fs.writeFileSync(briefPath, `# 작업 지시\n${secretMarker}\n두 줄로 답하라.\n`, 'utf8');

    const outPath = path.join(env.root, 'nested-out', '결과 파일.md');
    const expectedOut = '첫째 줄: developer 결과 (한글 UTF-8)\n둘째 줄: 완료\n';

    // 1. antigravity via npm-style .ps1 shim calling node.exe: prompt has no quotes/%, settings passed via temp file and cleaned up
    const agyRes = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        WORKER_SCRIPT,
        '--role', 'developer',
        '--agent', 'antigravity',
        '--model', 'gemini-4-carbon-high',
        '--brief', briefPath,
        '--out', outPath,
        '--timeout', '25',
        '--allow', 'command(node)',
        '--allow', 'command(npm)',
        '--cwd', env.projectDir,
      ],
      {
        encoding: 'utf8',
        env: childEnvFor(env, {
          pathDirs: [agyPs1Dir],
          extra: {
            HC_TERMINAL_ID: 'tab-head-01',
            WORKER_TEST_PASSTHROUGH: 'kept-value-42',
            FAKE_HOST_STDOUT: expectedOut,
          },
        }),
      },
    );

    assert.equal(agyRes.status, 0, agyRes.stderr);
    assert.equal(agyRes.stdout, expectedOut);
    assert.equal(fs.readFileSync(outPath, 'utf8'), expectedOut);
    assert.match(
      agyRes.stderr.trim(),
      /^\[cortex-worker\] role=developer agent=antigravity model=gemini-4-carbon-high elapsed=\d+\.\ds exit=0$/,
    );

    const agyCalls = agyPs1.calls();
    assert.equal(agyCalls.length, 1);
    assert.equal(agyCalls[0].roleEnv, 'worker');
    assert.equal(agyCalls[0].hasTerminalId, false);
    assert.equal(agyCalls[0].customMark, 'kept-value-42');
    assert.equal(agyCalls[0].cwd, env.projectDir);

    const expectedAgyPrompt = buildWorkerPrompt({ role: 'developer', briefPath });
    assert.equal(expectedAgyPrompt.includes('"'), false, 'script-generated prompt contains no double quotes');
    assert.equal(expectedAgyPrompt.includes('%'), false, 'script-generated prompt contains no percent signs');
    assert.match(expectedAgyPrompt, /developer 워커/);
    assert.match(expectedAgyPrompt, /cortex_prompt\(kind: 'agent', name: 'developer'\)/);
    assert.ok(expectedAgyPrompt.includes(`<${briefPath}>`), 'prompt delimits absolute brief path unambiguously');
    assert.match(expectedAgyPrompt, /마지막 메시지로 결과/);
    assert.equal(JSON.stringify(agyCalls[0].argv).includes(secretMarker), false, 'brief body never passed in argv');

    assert.ok(agyCalls[0].settingsPath, 'agy received a temporary settings file path');
    assert.deepEqual(agyCalls[0].settingsJson, {
      permissions: {
        allow: ['mcp(herdr-cortex/*)', 'command(node)', 'command(npm)'],
      },
    });
    assert.deepEqual(agyCalls[0].argv, [
      '-p',
      expectedAgyPrompt,
      '--model',
      'gemini-4-carbon-high',
      '--settings',
      agyCalls[0].settingsPath,
      '--print-timeout',
      '25m',
    ]);
    // Temporary settings file and its directory are removed after normal completion
    assert.equal(fs.existsSync(agyCalls[0].settingsPath), false, 'temp settings file removed after exit');
    assert.equal(fs.existsSync(path.dirname(agyCalls[0].settingsPath)), false, 'temp settings dir removed after exit');
    assert.deepEqual(fs.readdirSync(env.tempDir), [], 'no leftover files in TEMP');

    // 2. antigravity via .cmd shim also receives identical prompt and settings JSON
    const outCmd = makeMemorySink();
    const errCmd = makeMemorySink();
    const cmdExit = await runWorker(
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'gemini-4-neon-medium', '--brief', briefPath, '--cwd', env.projectDir],
      {
        cwd: env.root,
        env: childEnvFor(env, { pathDirs: [agyCmdDir], extra: { FAKE_HOST_STDOUT: 'CMD OK\n' } }),
        stdout: outCmd,
        stderr: errCmd,
      },
    );
    assert.equal(cmdExit, 0, errCmd.text());
    const agyCmdCalls = agyCmd.calls();
    assert.equal(agyCmdCalls.length, 1);
    assert.equal(agyCmdCalls[0].argv[1], buildWorkerPrompt({ role: 'coder', briefPath }));
    assert.deepEqual(agyCmdCalls[0].settingsJson, { permissions: { allow: ['mcp(herdr-cortex/*)'] } });
    assert.equal(fs.existsSync(agyCmdCalls[0].settingsPath), false);

    // 3. claude via npm-style .ps1 shim calling node.exe: preserves prompt, --add-dir, --allowedTools, and propagates exit code
    const stdoutSink = makeMemorySink();
    const stderrSink = makeMemorySink();
    const claudeExit = await runWorker(
      [
        '--role', 'reviewer',
        '--agent', 'claude',
        '--model', 'haiku',
        '--brief', briefPath,
        '--allow', 'Read',
        '--allow', 'Bash(git *)',
        '--cwd', env.projectDir,
      ],
      {
        cwd: env.root,
        env: childEnvFor(env, {
          pathDirs: [claudePs1Dir],
          extra: {
            hc_terminal_id: 'lowercase-tab-id',
            WORKER_TEST_PASSTHROUGH: 'ps1-ok',
            FAKE_HOST_STDOUT: 'Verdict: NEEDS_FIX\n',
            FAKE_HOST_EXIT: '5',
          },
        }),
        stdout: stdoutSink,
        stderr: stderrSink,
      },
    );

    assert.equal(claudeExit, 5);
    assert.equal(stdoutSink.text(), 'Verdict: NEEDS_FIX\n');
    assert.match(
      stderrSink.text().trim(),
      /^\[cortex-worker\] role=reviewer agent=claude model=haiku elapsed=\d+\.\ds exit=5$/,
    );

    const claudeCalls = claudePs1.calls();
    assert.equal(claudeCalls.length, 1);
    assert.equal(claudeCalls[0].roleEnv, 'worker');
    assert.equal(claudeCalls[0].hasTerminalId, false);
    assert.equal(claudeCalls[0].customMark, 'ps1-ok');
    assert.equal(claudeCalls[0].cwd, env.projectDir);
    assert.deepEqual(claudeCalls[0].argv, [
      '-p',
      buildWorkerPrompt({ role: 'reviewer', briefPath }),
      '--add-dir',
      briefDir,
      '--model',
      'haiku',
      '--allowedTools',
      'mcp__herdr-cortex__*',
      'Read',
      'Bash(git *)',
    ]);

    // User home / settings files were never created or touched
    assert.deepEqual(fs.readdirSync(env.homeDir), []);
    assertRealHomeUntouched();
  } finally {
    env.cleanup();
  }
});

test('cortex-worker: rejects % on .cmd/.bat and " on .ps1 with clear option/char/host-type messages, while .exe delivers both intact', { skip: process.platform === 'win32' ? false : 'Windows-specific host wrapper test' }, async () => {
  const env = makeTempEnv('herdr-cortex-worker-chars-');
  try {
    const cmdBinDir = path.join(env.root, 'bin-cmd');
    const ps1BinDir = path.join(env.root, 'bin-ps1');
    const pctBinDir = path.join(env.root, 'bin %PATH% dir');
    const cmdClaude = makeFakeHostCli(env, 'claude', { winKind: 'cmd', binDir: cmdBinDir });
    const ps1Claude = makeFakeHostCli(env, 'claude', { winKind: 'ps1', binDir: ps1BinDir });
    const pctAgy = makeFakeHostCli(env, 'agy', { winKind: 'cmd', binDir: pctBinDir });

    const normalBrief = path.join(env.root, 'normal-brief.md');
    fs.writeFileSync(normalBrief, '지시 본문\n', 'utf8');

    const pctBriefDir = path.join(env.root, '폴더 %USERNAME% 100%');
    fs.mkdirSync(pctBriefDir, { recursive: true });
    const pctBrief = path.join(pctBriefDir, '지시 %PATH%.md');
    fs.writeFileSync(pctBrief, '퍼센트 경로 지시\n', 'utf8');

    // 1. .cmd rejects % in --brief, --model, --allow, and executable path without spawning the host
    const cmdRejections = [
      {
        argv: ['--role', 'coder', '--agent', 'claude', '--model', 'haiku', '--brief', pctBrief],
        pathDirs: [cmdBinDir],
        expectMatch: [/--brief/, /%/, /\.cmd/],
      },
      {
        argv: ['--role', 'coder', '--agent', 'claude', '--model', 'm-%USERNAME%', '--brief', normalBrief],
        pathDirs: [cmdBinDir],
        expectMatch: [/--model/, /%/, /\.cmd/],
      },
      {
        argv: ['--role', 'coder', '--agent', 'claude', '--model', 'haiku', '--brief', normalBrief, '--allow', 'Bash(echo %PATH%)'],
        pathDirs: [cmdBinDir],
        expectMatch: [/--allow/, /%/, /\.cmd/],
      },
      {
        argv: ['--role', 'coder', '--agent', 'antigravity', '--model', 'gemini-4-neon-medium', '--brief', normalBrief],
        pathDirs: [pctBinDir],
        expectMatch: [/실행 파일 경로/, /%/, /\.cmd/],
      },
    ];

    for (const item of cmdRejections) {
      const errSink = makeMemorySink();
      const code = await runWorker(item.argv, {
        cwd: env.projectDir,
        env: childEnvFor(env, { pathDirs: item.pathDirs }),
        stdout: makeMemorySink(),
        stderr: errSink,
      });
      assert.notEqual(code, 0);
      for (const re of item.expectMatch) {
        assert.match(errSink.text(), re, `stderr should match ${re}: ${errSink.text()}`);
      }
    }
    assert.deepEqual(cmdClaude.calls(), []);
    assert.deepEqual(pctAgy.calls(), []);
    assert.deepEqual(fs.readdirSync(env.tempDir), [], 'temp files cleaned up even when spawn validation rejects');

    // 2. .ps1 rejects " (and whitespace + trailing \) in arguments without spawning the host
    const ps1Rejections = [
      {
        argv: ['--role', 'coder', '--agent', 'claude', '--model', 'm "quoted"', '--brief', normalBrief],
        expectMatch: [/--model/, /큰따옴표/, /\.ps1/],
      },
      {
        argv: ['--role', 'coder', '--agent', 'claude', '--model', 'haiku', '--brief', normalBrief, '--allow', 'Bash(echo "hi")'],
        expectMatch: [/--allow/, /큰따옴표/, /\.ps1/],
      },
      {
        argv: ['--role', 'coder', '--agent', 'claude', '--model', 'a \\', '--brief', normalBrief],
        expectMatch: [/--model/, /역슬래시/, /\.ps1/],
      },
    ];

    for (const item of ps1Rejections) {
      const errSink = makeMemorySink();
      const code = await runWorker(item.argv, {
        cwd: env.projectDir,
        env: childEnvFor(env, { pathDirs: [ps1BinDir] }),
        stdout: makeMemorySink(),
        stderr: errSink,
      });
      assert.notEqual(code, 0);
      for (const re of item.expectMatch) {
        assert.match(errSink.text(), re, `stderr should match ${re}: ${errSink.text()}`);
      }
    }
    assert.deepEqual(ps1Claude.calls(), []);

    // 3. .exe delivers both % and " completely intact
    const trickyModel = 'm "quoted" & %USERNAME% 100% trailing\\';
    const trickyAllow = 'Bash(echo "x & %PATH%" | cat)';
    if (HAS_CSC) {
      const exeBinDir = path.join(env.root, 'bin-exe');
      const exeClaude = makeFakeHostCli(env, 'claude', { winKind: 'exe', binDir: exeBinDir });
      const outExe = makeMemorySink();
      const errExe = makeMemorySink();
      const exeCode = await runWorker(
        [
          '--role', 'coder',
          '--agent', 'claude',
          '--model', trickyModel,
          '--brief', pctBrief,
          '--allow', trickyAllow,
          '--cwd', env.projectDir,
        ],
        {
          cwd: env.root,
          env: childEnvFor(env, { pathDirs: [exeBinDir], extra: { FAKE_HOST_STDOUT: 'EXE OK\n' } }),
          stdout: outExe,
          stderr: errExe,
        },
      );
      assert.equal(exeCode, 0, errExe.text());
      const exeCalls = exeClaude.calls();
      assert.equal(exeCalls.length, 1);
      assert.deepEqual(exeCalls[0].argv, [
        '-p',
        buildWorkerPrompt({ role: 'coder', briefPath: pctBrief }),
        '--add-dir',
        pctBriefDir,
        '--model',
        trickyModel,
        '--allowedTools',
        'mcp__herdr-cortex__*',
        trickyAllow,
      ]);
    } else {
      const exePath = path.join(env.binDir, 'claude.exe');
      const hostArgs = HOST_SPECS.claude.buildArgs({
        prompt: buildWorkerPrompt({ role: 'coder', briefPath: pctBrief }),
        model: trickyModel,
        allow: ['mcp__herdr-cortex__*', trickyAllow],
        timeoutMinutes: 40,
        briefPath: pctBrief,
        cwd: env.projectDir,
        platform: 'win32',
      });
      assert.deepEqual(buildSpawnSpec(exePath, hostArgs, { platform: 'win32' }), {
        command: exePath,
        args: hostArgs,
        options: { shell: false },
      });
    }
  } finally {
    env.cleanup();
  }
});

test('cortex-worker: Windows executable resolution handles .exe, .cmd, and .ps1 without matching extensionless shims', () => {
  const env = makeTempEnv('herdr-cortex-worker-resolve-');
  try {
    // Extensionless POSIX shim (like npm creates alongside .cmd/.ps1) is ignored on Windows
    fs.writeFileSync(path.join(env.binDir, 'agy'), '#!/bin/sh\n');
    assert.equal(resolveExecutable('agy', { env: { PATH: env.binDir }, platform: 'win32' }), '');

    const ps1Path = path.join(env.binDir, 'agy.ps1');
    fs.writeFileSync(ps1Path, '');
    assert.equal(resolveExecutable('agy', { env: { Path: env.binDir }, platform: 'win32' }), ps1Path);
    assert.equal(buildSpawnSpec(ps1Path, ['-p', 'hi'], { env: { Path: env.binDir }, platform: 'win32' }).options.shell, false);

    const cmdPath = path.join(env.binDir, 'agy.cmd');
    fs.writeFileSync(cmdPath, '');
    assert.equal(resolveExecutable('agy', { env: { Path: env.binDir }, platform: 'win32' }), cmdPath);
    assert.equal(buildSpawnSpec(cmdPath, ['-p', 'hi'], { env: { Path: env.binDir }, platform: 'win32' }).options.windowsVerbatimArguments, true);

    const exePath = path.join(env.binDir, 'agy.exe');
    fs.writeFileSync(exePath, '');
    assert.equal(resolveExecutable('agy', { env: { Path: env.binDir }, platform: 'win32' }), exePath);
    assert.deepEqual(buildSpawnSpec(exePath, ['-p', 'hi'], { env: { Path: env.binDir }, platform: 'win32' }), {
      command: exePath,
      args: ['-p', 'hi'],
      options: { shell: false },
    });

    // buildWorkerEnv strips HC_TERMINAL_ID regardless of case and forces HERDR_CORTEX_ROLE=worker
    const built = buildWorkerEnv({ hc_terminal_id: 't1', HC_TERMINAL_ID: 't2', herdr_cortex_role: 'head', KEEP: '1' });
    assert.deepEqual(built, { KEEP: '1', HERDR_CORTEX_ROLE: 'worker' });
    assert.deepEqual(Object.keys(HOST_SPECS), ['antigravity', 'claude']);
  } finally {
    env.cleanup();
  }
});

test('cortex-worker: terminates child and grandchild processes on --timeout, cleans up temp settings file, and fails on empty stdout', async () => {
  const env = makeTempEnv('herdr-cortex-worker-failures-');
  const spawnedPids = [];
  try {
    const agy = makeFakeHostCli(env, 'agy', { winKind: 'ps1' });
    const briefPath = path.join(env.root, 'brief.md');
    fs.writeFileSync(briefPath, '지시 내용\n', 'utf8');
    const pidsFile = path.join(env.root, 'timeout-pids.json');

    // 1. Timeout: fake agy (.ps1 -> node) spawns a sleeping grandchild process; --timeout 0.03 (1.8s) kills the entire tree and removes temp settings
    const outTimeout = makeMemorySink();
    const errTimeout = makeMemorySink();
    const started = Date.now();
    const timeoutCode = await runWorker(
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'gemini-4-neon-medium', '--brief', briefPath, '--timeout', '0.03'],
      {
        cwd: env.projectDir,
        env: childEnvFor(env, { extra: { FAKE_HOST_MODE: 'sleep-tree', FAKE_HOST_PIDS_FILE: pidsFile } }),
        stdout: outTimeout,
        stderr: errTimeout,
      },
    );
    const elapsedMs = Date.now() - started;
    assert.equal(timeoutCode, 124);
    assert.ok(elapsedMs < 15000, `worker tree was terminated promptly on timeout (took ${elapsedMs}ms)`);
    assert.match(errTimeout.text(), /시간 제한/);
    assert.match(errTimeout.text(), /\[cortex-worker\] role=coder agent=antigravity model=gemini-4-neon-medium elapsed=\d+\.\ds exit=124/);

    assert.ok(fs.existsSync(pidsFile), 'fake host recorded child and grandchild PIDs before timeout');
    const { childPid, grandchildPid } = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
    spawnedPids.push(childPid, grandchildPid);
    assert.equal(await waitForPidExit(childPid), true, `child PID ${childPid} must be terminated on timeout`);
    assert.equal(await waitForPidExit(grandchildPid), true, `grandchild PID ${grandchildPid} must be terminated on timeout`);

    const timeoutCalls = agy.calls();
    assert.equal(timeoutCalls.length, 1);
    assert.ok(timeoutCalls[0].settingsPath, 'timeout run had a temporary settings file');
    assert.equal(fs.existsSync(timeoutCalls[0].settingsPath), false, 'temp settings file removed after timeout');
    assert.equal(fs.existsSync(path.dirname(timeoutCalls[0].settingsPath)), false, 'temp settings dir removed after timeout');
    assert.deepEqual(fs.readdirSync(env.tempDir), [], 'no leftover files in TEMP after timeout');

    // 2. Empty output (0 bytes) and whitespace-only output: non-zero exit code + permission denial hint on stderr
    for (const mode of ['empty', 'whitespace']) {
      const outEmpty = makeMemorySink();
      const errEmpty = makeMemorySink();
      const emptyCode = await runWorker(
        ['--role', 'coder', '--agent', 'antigravity', '--model', 'gemini-4-neon-medium', '--brief', briefPath],
        {
          cwd: env.projectDir,
          env: childEnvFor(env, { extra: { FAKE_HOST_MODE: mode } }),
          stdout: outEmpty,
          stderr: errEmpty,
        },
      );
      assert.notEqual(emptyCode, 0, `mode=${mode} must fail with non-zero exit code`);
      assert.match(errEmpty.text(), /권한 거부|permission denied/);
      assert.match(errEmpty.text(), new RegExp(`\\[cortex-worker\\] role=coder agent=antigravity model=gemini-4-neon-medium elapsed=\\d+\\.\\ds exit=${emptyCode}`));
    }
    assert.deepEqual(fs.readdirSync(env.tempDir), []);
    assertRealHomeUntouched();
  } finally {
    for (const pid of spawnedPids) {
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    env.cleanup();
  }
});

test('cortex-worker: invalid arguments (including - prefixed --allow and newline in --model), missing brief, and empty brief exit non-zero without spawning host CLI', async () => {
  const env = makeTempEnv('herdr-cortex-worker-validation-');
  try {
    const agy = makeFakeHostCli(env, 'agy', { winKind: 'cmd' });
    const validBrief = path.join(env.root, 'valid.md');
    const emptyBrief = path.join(env.root, 'empty.md');
    const missingBrief = path.join(env.root, 'does-not-exist.md');
    fs.writeFileSync(validBrief, '유효한 지시\n', 'utf8');
    fs.writeFileSync(emptyBrief, '   \r\n\t  ', 'utf8');

    const badInvocations = [
      [],
      ['--agent', 'antigravity', '--model', 'm', '--brief', validBrief],
      ['--role', 'manager', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief],
      ['--role', 'coder', '--agent', 'codex', '--model', 'm', '--brief', validBrief],
      ['--role', 'coder', '--agent', 'antigravity', '--brief', validBrief],
      ['--role', 'coder', '--agent', 'antigravity', '--model', '--brief', validBrief],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm'],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm\nline2', '--brief', validBrief],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm\r\n', '--brief', validBrief],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief, '--allow', '-p'],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief, '--allow', '--dangerously-skip-permissions'],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief, '--allow=--mode'],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief, '--timeout', '0'],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief, '--timeout', '-3'],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief, '--timeout', 'abc'],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief, '--unknown-flag', '1'],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief, 'extra-positional'],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', validBrief, '--cwd', path.join(env.root, 'no-such-dir')],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', missingBrief],
      ['--role', 'coder', '--agent', 'antigravity', '--model', 'm', '--brief', emptyBrief],
    ];

    for (const argv of badInvocations) {
      const stdoutSink = makeMemorySink();
      const stderrSink = makeMemorySink();
      const code = await runWorker(argv, {
        cwd: env.projectDir,
        env: childEnvFor(env),
        stdout: stdoutSink,
        stderr: stderrSink,
      });
      assert.notEqual(code, 0, `expected non-zero exit code for argv=${JSON.stringify(argv)}`);
      assert.equal(stdoutSink.text(), '', `expected empty stdout for argv=${JSON.stringify(argv)}`);
      assert.ok(stderrSink.text().length > 0, `expected error message on stderr for argv=${JSON.stringify(argv)}`);
    }

    // Usage text is included on argument errors
    const errUsage = makeMemorySink();
    await runWorker(['--role', 'invalid'], { cwd: env.projectDir, env: childEnvFor(env), stdout: makeMemorySink(), stderr: errUsage });
    assert.match(errUsage.text(), /Usage: node --no-warnings scripts\/cortex-worker\.mjs/);

    // Not a single invalid/missing/empty invocation spawned `agy`
    assert.deepEqual(agy.calls(), []);
    assertRealHomeUntouched();
  } finally {
    env.cleanup();
  }
});

test('PowerShell cortex-worker command: exposed by auto-revive.ps1, uses recorded Node path, and resolves shell cwd', { skip: SKIP_PS }, () => {
  const env = makeTempEnv('herdr-cortex-worker-ps-');
  try {
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false });
    const claude = makeFakeHostCli(env, 'claude', { winKind: 'cmd' });

    const briefFile = path.join(env.projectDir, 'ps-brief.md');
    fs.writeFileSync(briefFile, 'PowerShell 호출 검증 지시\n', 'utf8');
    const outFile = path.join(env.projectDir, 'ps-out.md');

    const driverPath = path.join(env.root, 'ps-worker-driver.ps1');
    const resultPath = path.join(env.root, 'ps-worker-result.json');
    fs.writeFileSync(
      driverPath,
      [
        'param([string]$LoaderPath, [string]$ProjectDir, [string]$ResultPath)',
        '. $LoaderPath',
        '$cmd = Get-Command cortex-worker -ErrorAction Stop',
        'Set-Location -LiteralPath $ProjectDir',
        '$global:LASTEXITCODE = 0',
        '$stdoutText = (cortex-worker --role coder --agent claude --model haiku --brief .\\ps-brief.md --out .\\ps-out.md 2>$null | Out-String)',
        '$code = $global:LASTEXITCODE',
        '$payload = [ordered]@{',
        '  name = $cmd.Name',
        '  commandType = [string]$cmd.CommandType',
        '  exitCode = $code',
        '  stdout = $stdoutText',
        '}',
        '[System.IO.File]::WriteAllText($ResultPath, (ConvertTo-Json -InputObject $payload -Depth 4), (New-Object System.Text.UTF8Encoding($false)))',
        '',
      ].join('\r\n'),
      'utf8',
    );

    // Note: `node` is NOT on PATH; `cortex-worker` resolves the Node path recorded by `installCortex`
    const psRes = spawnSync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driverPath, '-LoaderPath', AUTO_REVIVE, '-ProjectDir', env.projectDir, '-ResultPath', resultPath],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: childEnvFor(env, {
          pathDirs: [env.binDir],
          extra: { HC_TERMINAL_ID: 'ps-tab-9', FAKE_HOST_STDOUT: 'PS 워커 응답 성공\n' },
        }),
      },
    );
    assert.equal(psRes.status, 0, `${psRes.stdout}\n${psRes.stderr}`);

    const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(parsed.name, 'cortex-worker');
    assert.equal(parsed.commandType, 'Function');
    assert.equal(parsed.exitCode, 0);
    assert.match(parsed.stdout, /PS 워커 응답 성공/);
    assert.equal(fs.readFileSync(outFile, 'utf8'), 'PS 워커 응답 성공\n');

    const calls = claude.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, env.projectDir);
    assert.equal(calls[0].roleEnv, 'worker');
    assert.equal(calls[0].hasTerminalId, false);
    assert.ok(calls[0].argv[1].includes(briefFile));
    assertRealHomeUntouched();
  } finally {
    env.cleanup();
  }
});
