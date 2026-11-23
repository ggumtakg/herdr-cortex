import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_CONFIG, REPO_ROOT, atomicWriteJson, atomicWriteText } from '../src/core/config.mjs';
import { runTrustCli } from '../src/core/trust-cli.mjs';
import { OLD_DEFAULT_CONFIGS, findBackups, installCortex, isOwnHook } from '../src/hooks/installer.mjs';

// The PowerShell scripts are driven through Windows PowerShell 5.1 (`powershell -NoProfile -File`), always
// against scratch files and a test home (HERDR_CORTEX_TEST_HOME): the real profile, the real ExecutionPolicy,
// the real ~/.claude and the real `hc` / `claude` are never touched. `-ExecutionPolicy Bypass` on the command
// line applies to that one process only.
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const HAS_POWERSHELL = process.platform === 'win32' && fs.existsSync(POWERSHELL);
const SKIP = HAS_POWERSHELL ? false : 'Windows PowerShell is not available';

const INSTALL_TOOLS = path.join(REPO_ROOT, 'scripts', 'install-tools.ps1');
const REVIVE_AGENTS = path.join(REPO_ROOT, 'scripts', 'revive-agents.ps1');
const AUTO_REVIVE = path.join(REPO_ROOT, 'scripts', 'auto-revive.ps1');
const INSTALL_PS1 = path.join(REPO_ROOT, 'install.ps1');
const UNINSTALL_PS1 = path.join(REPO_ROOT, 'uninstall.ps1');

const BLOCK_START = '# >>> herdr-cortex >>>';
const BLOCK_END = '# <<< herdr-cortex <<<';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// "한글" in the Korean ANSI code page (CP949): not valid UTF-8.
const HANGUL_CP949 = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);

// What the child processes of this file see as the user's real home directory (USERPROFILE). Everything
// under test has to go to the test home instead, so nothing of herdr-cortex may ever appear in here
// (`assertRealHomeUntouched`). PowerShell itself keeps a cache under AppData\ in it.
const REAL_HOME_STAND_IN = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cortex-ps-realhome-'));
process.on('exit', () => {
  try {
    fs.rmSync(REAL_HOME_STAND_IN, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function makeTempEnv(prefix = 'herdr-cortex-ps-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  return {
    root,
    homeDir,
    globalDir: path.join(homeDir, '.herdr-cortex'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertRealHomeUntouched() {
  assert.deepEqual(
    fs.readdirSync(REAL_HOME_STAND_IN).filter((name) => name !== 'AppData'),
    [],
    'nothing was written into the (stand-in) real home directory',
  );
}

// Environment of a child PowerShell: the test home, a stand-in for the real home directory, and a PATH that
// holds only Windows itself plus the given folders (so neither the real `hc`, `claude` nor `node` can be
// reached by name).
function psEnv(env, { pathDirs = [], extra = {} } = {}) {
  const out = { ...process.env };
  for (const key of Object.keys(out)) {
    if (/^(path|userprofile|HC_TERMINAL_ID|CLAUDECODE|HERDR_CORTEX_HOME|HERDR_REVIVE_TEST_HOME|HERDR_REVIVE_DISABLE|HERDR_REVIVE_IN_AGENT|HERDR_CORTEX_TEST_EXECUTION_POLICY)$/i.test(key)) {
      delete out[key];
    }
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  out.Path = [...pathDirs, path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  out.USERPROFILE = REAL_HOME_STAND_IN;
  out.HERDR_CORTEX_TEST_HOME = env.homeDir;
  return { ...out, ...extra };
}

function runPsFile(scriptPath, args, options = {}) {
  return spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8', windowsHide: true, ...options },
  );
}

// Run several profile operations in one PowerShell process: a small driver dot-sources install-tools.ps1 and
// calls Set-HerdrProfileBlock / Remove-HerdrProfileBlock for every entry of a JSON file.
const PROFILE_DRIVER = [
  'param([string]$ToolsPath, [string]$OpsPath, [string]$OutPath)',
  '$ErrorActionPreference = "Stop"',
  '. $ToolsPath',
  '$ops = Get-Content -Raw -LiteralPath $OpsPath -Encoding UTF8 | ConvertFrom-Json',
  '$results = New-Object System.Collections.Generic.List[object]',
  'foreach ($op in $ops) {',
  '    if ($op.action -eq "set") {',
  '        $res = Set-HerdrProfileBlock -ProfilePath $op.profilePath -BlockLines @($op.blockLines) -Stamp $op.stamp -AnsiCodePage $op.ansiCodePage',
  '    } elseif ($op.action -eq "remove") {',
  '        $res = Remove-HerdrProfileBlock -ProfilePath $op.profilePath -Stamp $op.stamp -AnsiCodePage $op.ansiCodePage',
  '    } elseif ($op.action -eq "lines") {',
  '        $res = @{ Status = "ok"; Lines = @(Get-HerdrProfileBlockLines -AutoReviveScript $op.value -NoAutoResume:([bool]$op.noAutoResume)); Value = (Invoke-Expression (ConvertTo-HerdrPathExpression $op.value)) }',
  '    }',
  '    $results.Add($res)',
  '}',
  '[System.IO.File]::WriteAllText($OutPath, (ConvertTo-Json -InputObject $results.ToArray() -Depth 5), (New-Object System.Text.UTF8Encoding($false)))',
  '',
].join('\r\n');

function runProfileOps(env, ops) {
  const driverPath = path.join(env.root, 'profile-driver.ps1');
  const opsPath = path.join(env.root, 'ops.json');
  const outPath = path.join(env.root, 'ops-out.json');
  fs.writeFileSync(driverPath, PROFILE_DRIVER);
  fs.writeFileSync(opsPath, JSON.stringify(ops.map((op) => ({ stamp: '20261123-101500', ansiCodePage: 949, ...op }))));
  fs.rmSync(outPath, { force: true });
  const res = runPsFile(driverPath, ['-ToolsPath', INSTALL_TOOLS, '-OpsPath', opsPath, '-OutPath', outPath], { env: psEnv(env) });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  return Array.isArray(parsed) ? parsed : [parsed];
}

const BLOCK_LINES = [BLOCK_START, "if (Test-Path -LiteralPath 'C:\\tools\\herdr-cortex\\scripts\\auto-revive.ps1') { . 'C:\\tools\\herdr-cortex\\scripts\\auto-revive.ps1' }", BLOCK_END];

// ---------------------------------------------------------------------------------------------
// Item 6: the profile block keeps the file's encoding and changes nothing outside the block
// ---------------------------------------------------------------------------------------------

test('profile block: written in the file\'s own encoding after a dated backup; every byte outside the block stays; removal gives the file back', { skip: SKIP }, () => {
  const env = makeTempEnv();
  try {
    const dir = path.join(env.root, 'profiles');
    fs.mkdirSync(dir, { recursive: true });
    const file = (name) => path.join(dir, `${name}.ps1`);
    const blockCrlf = `${BLOCK_LINES.join('\r\n')}\r\n`;
    const koreanComment = '# 한글 프로필\r\nSet-Alias ll Get-ChildItem\r\n';

    const originals = {
      // ANSI (CP949) with Korean text: what a profile saved by Notepad on a Korean system used to be
      cp949: Buffer.concat([Buffer.from('# '), HANGUL_CP949, Buffer.from(' profile\r\nSet-Alias ll Get-ChildItem\r\n')]),
      utf8bom: Buffer.concat([UTF8_BOM, Buffer.from(koreanComment, 'utf8')]),
      utf8: Buffer.from(koreanComment, 'utf8'),
      utf16le: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(koreanComment, 'utf16le')]),
      utf16be: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(koreanComment, 'utf16le').swap16()]),
      ascii: Buffer.from('Set-Alias ll Get-ChildItem\r\n'),
      lfOnly: Buffer.from('# unix line ends\nSet-Alias ll Get-ChildItem\n'),
      noFinalNewline: Buffer.from('Set-Alias ll Get-ChildItem'),
      empty: Buffer.alloc(0),
    };
    for (const [name, bytes] of Object.entries(originals)) fs.writeFileSync(file(name), bytes);

    const names = Object.keys(originals);
    const setResults = runProfileOps(env, [
      ...names.map((name) => ({ action: 'set', profilePath: file(name), blockLines: BLOCK_LINES })),
      { action: 'set', profilePath: path.join(dir, 'new-folder', 'created.ps1'), blockLines: BLOCK_LINES },
    ]);
    const byName = Object.fromEntries(names.map((name, index) => [name, setResults[index]]));

    const expectedEncoding = { cp949: 'ansi-949', utf8bom: 'utf-8-bom', utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be', ascii: 'utf-8', lfOnly: 'utf-8', noFinalNewline: 'utf-8', empty: 'utf-8-bom' };
    for (const name of names) {
      assert.equal(byName[name].Status, 'updated', `${name}: ${byName[name].Message}`);
      assert.equal(byName[name].Encoding, expectedEncoding[name], name);
      // The backup is the file as it was, named <file>.herdr-cortex.<stamp>.bak
      assert.equal(byName[name].BackupPath, `${file(name)}.herdr-cortex.20261123-101500.bak`, name);
      assert.deepEqual(fs.readFileSync(byName[name].BackupPath), originals[name], name);
      assert.deepEqual(findBackups(file(name)), [byName[name].BackupPath], 'the Node side recognizes the backup');
    }

    // Byte-exact results: the original bytes, then the block in the same encoding
    const after = (name) => fs.readFileSync(file(name));
    assert.deepEqual(after('cp949'), Buffer.concat([originals.cp949, Buffer.from(blockCrlf, 'latin1')]));
    assert.equal(new TextDecoder('euc-kr').decode(after('cp949')).startsWith('# 한글 profile\r\n'), true, 'the Korean text is intact');
    assert.deepEqual(after('utf8bom'), Buffer.concat([originals.utf8bom, Buffer.from(blockCrlf, 'utf8')]));
    assert.deepEqual(after('utf8'), Buffer.concat([originals.utf8, Buffer.from(blockCrlf, 'utf8')]), 'no BOM is added');
    assert.deepEqual(after('utf16le'), Buffer.concat([originals.utf16le, Buffer.from(blockCrlf, 'utf16le')]));
    assert.deepEqual(after('utf16be'), Buffer.concat([originals.utf16be, Buffer.from(blockCrlf, 'utf16le').swap16()]));
    assert.deepEqual(after('ascii'), Buffer.concat([originals.ascii, Buffer.from(blockCrlf)]));
    assert.deepEqual(after('lfOnly'), Buffer.concat([originals.lfOnly, Buffer.from(`${BLOCK_LINES.join('\n')}\n`)]), 'the file\'s line ending is used');
    assert.deepEqual(after('noFinalNewline'), Buffer.concat([originals.noFinalNewline, Buffer.from(`\r\n${blockCrlf}`)]), 'the block starts on its own line');
    assert.deepEqual(after('empty'), Buffer.concat([UTF8_BOM, Buffer.from(blockCrlf)]));

    // A profile that did not exist: created as UTF-8 with BOM, no backup
    const created = setResults[names.length];
    assert.deepEqual([created.Status, created.Encoding, created.BackupPath], ['created', 'utf-8-bom', '']);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'new-folder', 'created.ps1')), Buffer.concat([UTF8_BOM, Buffer.from(blockCrlf)]));

    // A second run with the same block changes nothing and writes no further backup; a changed block replaces
    // the old one in place, and text the user added after it stays
    fs.appendFileSync(file('cp949'), Buffer.concat([Buffer.from('# after '), HANGUL_CP949, Buffer.from('\r\n')]));
    const withTail = fs.readFileSync(file('cp949'));
    const newBlock = [BLOCK_START, "$env:HERDR_REVIVE_DISABLE = '1'", BLOCK_LINES[1], BLOCK_END];
    const second = runProfileOps(env, [
      { action: 'set', profilePath: file('utf8bom'), blockLines: BLOCK_LINES, stamp: '20261123-111500' },
      { action: 'set', profilePath: file('cp949'), blockLines: newBlock, stamp: '20261123-111500' },
    ]);
    assert.deepEqual([second[0].Status, second[0].BackupPath], ['unchanged', '']);
    assert.equal(findBackups(file('utf8bom')).length, 1);
    assert.equal(second[1].Status, 'updated');
    assert.deepEqual(fs.readFileSync(second[1].BackupPath), withTail);
    assert.deepEqual(
      fs.readFileSync(file('cp949')),
      Buffer.concat([originals.cp949, Buffer.from(`${newBlock.join('\r\n')}\r\n`), Buffer.from('# after '), HANGUL_CP949, Buffer.from('\r\n')]),
    );
    assert.equal(findBackups(file('cp949')).length, 2);

    // Removal: the block goes with its own line break, everything else is byte for byte what it was
    const removed = runProfileOps(env, [
      ...['cp949', 'utf8bom', 'utf8', 'utf16le', 'utf16be', 'ascii', 'lfOnly'].map((name) => ({ action: 'remove', profilePath: file(name), stamp: '20261123-121500' })),
      { action: 'remove', profilePath: file('ascii'), stamp: '20261123-121500' },
      { action: 'remove', profilePath: path.join(dir, 'does-not-exist.ps1') },
    ]);
    assert.deepEqual(removed.map((res) => res.Status), ['removed', 'removed', 'removed', 'removed', 'removed', 'removed', 'removed', 'unchanged', 'missing']);
    assert.deepEqual(after('cp949'), Buffer.concat([originals.cp949, Buffer.from('# after '), HANGUL_CP949, Buffer.from('\r\n')]));
    for (const name of ['utf8bom', 'utf8', 'utf16le', 'utf16be', 'ascii', 'lfOnly']) {
      assert.deepEqual(after(name), originals[name], `${name}: back to the original bytes`);
    }
    assert.equal(removed[0].BackupPath, `${file('cp949')}.herdr-cortex.20261123-121500.bak`);
    assertRealHomeUntouched(env);
  } finally {
    env.cleanup();
  }
});

test('profile block: replaced in place between other text; the predecessor\'s block is removed; a block the file\'s encoding cannot represent, or broken markers, stop that profile untouched', { skip: SKIP }, () => {
  const env = makeTempEnv('herdr-cortex-ps-block-');
  try {
    const dir = path.join(env.root, 'profiles');
    fs.mkdirSync(dir, { recursive: true });
    const file = (name) => path.join(dir, `${name}.ps1`);

    // An older block in the middle, the predecessor's block, and a duplicate of our block further down
    const before = '# top \uD55C\uAE00\r\n';
    const middle = 'function prompt { "PS> " }\r\n';
    const tail = '# bottom\r\n';
    const oldBlock = `${BLOCK_START}\r\nif (Test-Path 'C:\\old\\auto-revive.ps1') { . 'C:\\old\\auto-revive.ps1' }\r\n${BLOCK_END}`;
    const legacyBlock = "# >>> herdr-revive >>>\r\n. 'C:\\old\\herdr-revive\\auto-revive.ps1'\r\n# <<< herdr-revive <<<\r\n";
    const mixed = `${before}${oldBlock}\r\n${middle}${legacyBlock}${oldBlock}\r\n${tail}`;
    fs.writeFileSync(file('mixed'), Buffer.concat([UTF8_BOM, Buffer.from(mixed, 'utf8')]));

    // ANSI file + a block with characters outside that code page; a start marker without an end marker
    const cp949Original = Buffer.concat([Buffer.from('# '), HANGUL_CP949, Buffer.from('\r\n')]);
    fs.writeFileSync(file('cp949'), cp949Original);
    fs.writeFileSync(file('cp949-ok'), cp949Original);
    const brokenOriginal = Buffer.from(`# mine\r\n${BLOCK_START}\r\n. 'C:\\x.ps1'\r\n`);
    fs.writeFileSync(file('broken'), brokenOriginal);
    // Bytes that are neither valid UTF-8 nor valid CP949 (a lead byte at the very end)
    const undecodable = Buffer.from([0x23, 0x20, 0xc7]);
    fs.writeFileSync(file('undecodable'), undecodable);

    const koreanBlock = [BLOCK_START, "if (Test-Path -LiteralPath 'C:\\\uD55C\uAE00\\auto-revive.ps1') { . 'C:\\\uD55C\uAE00\\auto-revive.ps1' }", BLOCK_END];
    const thaiBlock = [BLOCK_START, "if (Test-Path -LiteralPath 'C:\\\u0E01\u0E02\\auto-revive.ps1') { . 'C:\\\u0E01\u0E02\\auto-revive.ps1' }", BLOCK_END];

    const results = runProfileOps(env, [
      { action: 'set', profilePath: file('mixed'), blockLines: BLOCK_LINES },
      { action: 'set', profilePath: file('cp949-ok'), blockLines: koreanBlock },
      { action: 'set', profilePath: file('cp949'), blockLines: thaiBlock },
      { action: 'set', profilePath: file('broken'), blockLines: BLOCK_LINES },
      { action: 'remove', profilePath: file('broken') },
      { action: 'set', profilePath: file('undecodable'), blockLines: BLOCK_LINES },
    ]);

    // Replaced where it was; the text around it is untouched; the duplicate and the predecessor's block are gone
    assert.equal(results[0].Status, 'updated');
    assert.deepEqual(
      fs.readFileSync(file('mixed')),
      Buffer.concat([UTF8_BOM, Buffer.from(`${before}${BLOCK_LINES.join('\r\n')}\r\n${middle}${tail}`, 'utf8')]),
    );

    // Korean in the block is fine for a CP949 file (written in CP949) ...
    assert.equal(results[1].Status, 'updated', results[1].Message);
    assert.equal(new TextDecoder('euc-kr').decode(fs.readFileSync(file('cp949-ok'))), `# 한글\r\n${koreanBlock.join('\r\n')}\r\n`);
    // ... characters the code page lacks are not: nothing is written, no backup is made
    assert.equal(results[2].Status, 'failed');
    assert.match(results[2].Message, /the block contains characters that the file's encoding \(ansi-949\) cannot represent/);
    assert.deepEqual(fs.readFileSync(file('cp949')), cp949Original);
    assert.deepEqual(findBackups(file('cp949')), []);

    // A start marker without an end marker cannot be delimited: untouched, for install and for uninstall
    for (const res of [results[3], results[4]]) {
      assert.equal(res.Status, 'failed');
      assert.match(res.Message, /contains "# >>> herdr-cortex >>>" without a matching "# <<< herdr-cortex <<<"/);
    }
    assert.deepEqual(fs.readFileSync(file('broken')), brokenOriginal);

    assert.equal(results[5].Status, 'failed');
    assert.match(results[5].Message, /not valid ansi-949 text/);
    assert.deepEqual(fs.readFileSync(file('undecodable')), undecodable);

    // The block the installer builds is ASCII only, whatever the repository folder is called, so it reads the
    // same in every encoding; the path expression evaluates back to the path
    const paths = [
      'C:\\tools\\herdr-cortex\\scripts\\auto-revive.ps1',
      "C:\\Users\\\uAE40 \uC601\uBBFC\\it's \uC791\uC5C5\\herdr-cortex\\scripts\\auto-revive.ps1",
    ];
    const built = runProfileOps(env, [
      { action: 'lines', value: paths[0], noAutoResume: false },
      { action: 'lines', value: paths[1], noAutoResume: true },
    ]);
    assert.deepEqual(built[0].Lines, [BLOCK_START, `if (Test-Path -LiteralPath '${paths[0]}') { . '${paths[0]}' }`, BLOCK_END]);
    assert.equal(built[0].Value, paths[0]);
    assert.equal(built[1].Value, paths[1]);
    assert.equal(built[1].Lines.length, 4);
    assert.equal(built[1].Lines[1], "$env:HERDR_REVIVE_DISABLE = '1'");
    for (const line of built[1].Lines) assert.match(line, /^[\x20-\x7e]+$/, 'ASCII only');
    assert.match(built[1].Lines[2], /\[char\]0xAE40 \+ ' ' \+ \[char\]0xC601 \+ \[char\]0xBBFC/);
    assert.match(built[1].Lines[2], /'\\it''s '/);
    assertRealHomeUntouched(env);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 9: tab revive
// ---------------------------------------------------------------------------------------------

// A stand-in for `hc` on PATH: `hc ls --json` and `hc get <id> --json` print files of its folder, `hc send`
// appends its arguments to sent.jsonl (and fails for the terminal named in fail-send.txt). The real hc is
// not on the PATH of these child processes.
const FAKE_HC_SOURCE = `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'ls') {
  if (fs.existsSync(path.join(dir, 'fail-ls.txt'))) { process.stdout.write('{"error":{"kind":"unavailable","message":"no server"}}'); process.exit(3); }
  process.stdout.write(read('ls.json'));
} else if (args[0] === 'get') {
  const file = path.join(dir, 'get-' + args[1] + '.json');
  if (!fs.existsSync(file)) { process.stdout.write('{"error":{"kind":"not_found","message":"no terminal"}}'); process.exit(4); }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
} else if (args[0] === 'send') {
  const failFor = fs.existsSync(path.join(dir, 'fail-send.txt')) ? read('fail-send.txt').trim() : '';
  if (args[1] === failFor) { process.stdout.write('{"error":{"kind":"blocked","message":"blocked"}}'); process.exit(9); }
  fs.appendFileSync(path.join(dir, 'sent.jsonl'), JSON.stringify({ to: args[1], text: args[2], extra: args.slice(3) }) + '\\n');
} else {
  process.exit(2);
}
`;

function makeFakeHc(env) {
  const dir = path.join(env.root, 'fake-hc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fake-hc.mjs'), FAKE_HC_SOURCE);
  fs.writeFileSync(path.join(dir, 'hc.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-hc.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  const readLines = (name) => (fs.existsSync(path.join(dir, name))
    ? fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []);
  return {
    dir,
    setLs(terminals) {
      fs.writeFileSync(path.join(dir, 'ls.json'), JSON.stringify({ hidden_finished: 0, terminals }));
    },
    setGet(id, terminal) {
      fs.writeFileSync(path.join(dir, `get-${id}.json`), JSON.stringify(terminal));
    },
    setFlag(name, value) {
      if (value === null) fs.rmSync(path.join(dir, name), { force: true });
      else fs.writeFileSync(path.join(dir, name), value);
    },
    sent: () => readLines('sent.jsonl'),
    calls: () => readLines('calls.jsonl'),
    reset() {
      for (const name of ['sent.jsonl', 'calls.jsonl']) fs.rmSync(path.join(dir, name), { force: true });
    },
  };
}

// `hc ls` rows and `hc get` results in the shapes hc 0.1.21 prints (see relay-inbox.test.mjs).
function shellRow(address, cwd, where) {
  return { address, agent: 'powershell.exe', cwd, state: 'live', turn: 0, where };
}

function agentRow(address, cwd, where, status = 'working') {
  return { address, agent: 'claude-code', cwd, state: 'live', status, turn: 5, where };
}

function shellGet(address, cwd, where) {
  return {
    address,
    cwd,
    foreground: { argv: ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoExit'], cwd, name: 'powershell.exe', pid: 7120 },
    labels: { where },
    state: 'live',
    status: null,
  };
}

function saveSession(env, terminalId, record) {
  atomicWriteJson(path.join(env.globalDir, 'sessions', `${terminalId}.json`), { terminalId, updatedAt: '2026-11-23T10:00:00.000Z', ...record });
}

function psQuote(text) {
  return `'${text.replace(/'/g, "''")}'`;
}

test('revive-agents: resumes by saved session id (changing to the saved folder first when it differs), skips a vanished folder, and does not guess with -c when tabs share a folder', { skip: SKIP }, () => {
  const env = makeTempEnv('herdr-cortex-ps-revive-');
  try {
    const hc = makeFakeHc(env);
    const folder = (name) => {
      const dir = path.join(env.root, 'work', name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const projA = folder('proj-a');
    const savedElsewhere = folder("it's 작업 dir"); // a space, an apostrophe and non-ASCII characters
    const shared = folder('shared');
    const solo = folder('solo');
    const busy = folder('busy');
    const agyDir = folder('agy');
    const cmdDir = folder('cmd');
    const odd = folder('odd');
    const gone = path.join(env.root, 'work', 'deleted-folder');
    const injection = "C:\\x'; Remove-Item -Recurse C:\\important; '";

    hc.setLs([
      shellRow('t1', projA, 'proj-a / Claude Code'),
      shellRow('t2', projA, 'proj-a / 2'),
      shellRow('t3', projA, 'gone / Claude Code'),
      shellRow('t4', shared, 'shared / Claude Code'),
      shellRow('t5', `${shared}\\`, 'shared / Claude'),
      shellRow('t6', solo, 'solo / Claude Code'),
      shellRow('t7', solo, 'solo / Antigravity'),
      agentRow('t8', busy, 'busy / Claude Code'),
      shellRow('t9', busy.toUpperCase(), 'busy / Claude Code'),
      shellRow('t10', agyDir, 'agy / 1'),
      { ...shellRow('t11', cmdDir, 'cmd / 1'), agent: 'cmd.exe' },
      shellRow('t12', odd, 'odd / Claude Code'),
      shellRow('t13', projA, 'inject / 1'),
      shellRow('t14', projA, 'plain shell'),
      { ...shellRow('t15', projA, 'finished / Claude Code'), state: 'finished' },
      { ...shellRow('pc2/t3', 'C:\\Users\\other', 'remote / Claude Code') },
    ]);
    saveSession(env, 't1', { agent: 'claude', sessionId: 'sess-same-folder', cwd: `${projA}\\` });
    saveSession(env, 't2', { agent: 'claude', sessionId: 'sess-other-folder', cwd: savedElsewhere });
    saveSession(env, 't3', { agent: 'claude', sessionId: 'sess-folder-gone', cwd: gone });
    saveSession(env, 't10', { agent: 'antigravity', sessionId: 'conv-1', cwd: agyDir });
    saveSession(env, 't11', { agent: 'claude', sessionId: 'sess-cmd', cwd: savedElsewhere });
    saveSession(env, 't12', { agent: 'claude', sessionId: 'abc; Remove-Item x', cwd: odd });
    saveSession(env, 't13', { agent: 'claude', sessionId: 'sess-inject', cwd: injection });
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { claudeExtraArgs: ['--model', 'opus'] });

    const run = (args) => {
      const res = runPsFile(REVIVE_AGENTS, args, { env: psEnv(env, { pathDirs: [hc.dir] }) });
      assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
      return res.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    };

    const cdThenResume = `Set-Location -LiteralPath ${psQuote(savedElsewhere)}; claude --resume sess-other-folder --model opus`;
    const expected = [
      '[DRYRUN] t1 (proj-a / Claude Code) [session-id] -> claude --resume sess-same-folder --model opus',
      // the saved folder differs from the tab's: go there first, then resume by id (no guess by the title)
      `[DRYRUN] t2 (proj-a / 2) [session-id, saved folder] -> ${cdThenResume}`,
      // the saved folder is gone: skipped, although the title would allow `claude -c`
      `[SKIP]   t3 (gone / Claude Code) -> the folder saved with session sess-folder-gone no longer exists: ${gone}`,
      // two tabs of one folder with nothing but their titles: `-c` cannot tell them apart
      `[SKIP]   t4 (shared / Claude Code) -> 'claude -c' not used: 2 claude tabs share the folder ${shared} (t4, t5), and -c cannot tell their conversations apart; pick one yourself with: claude --resume`,
      `[SKIP]   t5 (shared / Claude) -> 'claude -c' not used: 2 claude tabs share the folder ${shared}\\ (t5, t4), and -c cannot tell their conversations apart; pick one yourself with: claude --resume`,
      // one Claude tab and one Antigravity tab in a folder do not compete for a conversation
      '[DRYRUN] t6 (solo / Claude Code) [tab-title] -> claude -c --model opus',
      '[DRYRUN] t7 (solo / Antigravity) [tab-title] -> agy -c',
      '[SKIP]   t8 (busy / Claude Code) -> already running claude-code',
      // a tab that already runs Claude in the folder owns its most recent conversation
      `[SKIP]   t9 (busy / Claude Code) -> 'claude -c' not used: 2 claude tabs share the folder ${busy.toUpperCase()} (t9, t8), and -c cannot tell their conversations apart; pick one yourself with: claude --resume`,
      '[DRYRUN] t10 (agy / 1) [session-id] -> agy --conversation conv-1',
      `[SKIP]   t11 (cmd / 1) -> session sess-cmd was saved in another folder (${savedElsewhere}) and this tab's shell (cmd.exe) is not PowerShell; change to that folder yourself, then run: claude --resume sess-cmd --model opus`,
      '[NOTE]   t12 -> ignored invalid saved sessionId',
      '[DRYRUN] t12 (odd / Claude Code) [tab-title] -> claude -c --model opus',
      `[SKIP]   t13 (inject / 1) -> the folder saved with session sess-inject no longer exists: ${injection}`,
      '[IGNORE] t14 (plain shell) -> regular shell',
      '[SKIP]   pc2/t3 (remote / Claude Code) -> invalid terminal id',
      'Dry run complete: 6 terminal(s) would be revived, 1 already active, 7 skipped.',
    ];
    assert.deepEqual(run(['-DryRun']), expected);
    assert.deepEqual(hc.sent(), [], 'a dry run types nothing');
    assert.deepEqual(hc.calls(), [['ls', '--json']]);

    // For real: exactly the planned lines are typed, each as one argument of `hc send`
    hc.reset();
    hc.setFlag('fail-send.txt', 't10');
    const live = run(['-DelayMs', '0']);
    assert.deepEqual(hc.sent(), [
      { to: 't1', text: 'claude --resume sess-same-folder --model opus', extra: [] },
      { to: 't2', text: cdThenResume, extra: [] },
      { to: 't6', text: 'claude -c --model opus', extra: [] },
      { to: 't7', text: 'agy -c', extra: [] },
      { to: 't12', text: 'claude -c --model opus', extra: [] },
    ]);
    assert.ok(live.includes(`[REVIVE] t2 (proj-a / 2) [session-id, saved folder] -> ${cdThenResume}`));
    assert.ok(live.includes('[FAILED] t10 -> hc send exited with code 9; nothing was typed into the tab'));
    assert.equal(live[live.length - 1], 'Done: revived 5 terminal(s), 1 already active, 8 skipped.');
    assert.equal(hc.calls().some((args) => args.includes('--force')), false);

    // The typed line is safe to paste into PowerShell: the folder is one literal string, whatever it contains
    const check = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `${cdThenResume.split('; claude')[0]}; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-Location).Path`], { encoding: 'utf8', env: psEnv(env) });
    assert.equal(check.stdout.trim(), savedElsewhere, check.stderr);

    // -Status still lists every tab with what is saved for it
    const status = run(['-Status']);
    assert.equal(status[0], '=== Herdr Live Terminals & Saved Sessions ===');
    assert.ok(status.some((line) => /^\[SHELL \] t2\s+agent=powershell\.exe\s+where=proj-a \/ 2\s+saved=claude:sess-other-folder$/.test(line)), status.join('\n'));
    assert.ok(status.some((line) => /^\[ACTIVE\] t8\s+agent=claude-code/.test(line)));
    assertRealHomeUntouched(env);
  } finally {
    env.cleanup();
  }
});

// Runs commands inside a PowerShell that has loaded scripts\auto-revive.ps1 the way a profile does, and
// returns what each printed. HC_TERMINAL_ID is not set, so loading the script restores nothing by itself.
const LOADER_DRIVER = [
  'param([string]$LoaderPath, [string]$CommandsPath, [string]$OutPath)',
  '. $LoaderPath',
  '$commands = Get-Content -Raw -LiteralPath $CommandsPath -Encoding UTF8 | ConvertFrom-Json',
  '$results = New-Object System.Collections.Generic.List[object]',
  'foreach ($item in $commands) {',
  '    if ($item.cwd) { Set-Location -LiteralPath $item.cwd }',
  '    $global:LASTEXITCODE = 0',
  '    if ($item.kind -eq "plan") {',
  '        $plan = Get-HerdrAutoRevivePlan -TerminalId $item.terminalId -CurrentCwd $item.cwd',
  '        $results.Add(@{ kind = "plan"; plan = $plan })',
  '    } else {',
  '        $text = (Invoke-Expression $item.command *>&1 | Out-String -Width 4096)',
  '        $results.Add(@{ kind = "command"; text = $text; exitCode = $global:LASTEXITCODE })',
  '    }',
  '}',
  '[System.IO.File]::WriteAllText($OutPath, (ConvertTo-Json -InputObject $results.ToArray() -Depth 6), (New-Object System.Text.UTF8Encoding($false)))',
  '',
].join('\r\n');

function runInLoadedShell(env, commands, envOptions = {}) {
  const driverPath = path.join(env.root, 'loader-driver.ps1');
  const commandsPath = path.join(env.root, 'commands.json');
  const outPath = path.join(env.root, 'commands-out.json');
  fs.writeFileSync(driverPath, LOADER_DRIVER);
  fs.writeFileSync(commandsPath, JSON.stringify(commands));
  fs.rmSync(outPath, { force: true });
  const res = runPsFile(driverPath, ['-LoaderPath', AUTO_REVIVE, '-CommandsPath', commandsPath, '-OutPath', outPath], { env: psEnv(env, envOptions) });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  return Array.isArray(parsed) ? parsed : [parsed];
}

test('auto-revive: a tab that starts as a bare shell gets the same plan (saved folder first, no -c among tabs sharing a folder, nothing when hc cannot list the tabs)', { skip: SKIP }, () => {
  const env = makeTempEnv('herdr-cortex-ps-auto-');
  try {
    const hc = makeFakeHc(env);
    const folder = (name) => {
      const dir = path.join(env.root, 'work', name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const here = folder('here');
    const saved = folder("saved 폴더's");
    const shared = folder('shared');
    const alone = folder('alone');
    const gone = path.join(env.root, 'work', 'gone');

    hc.setLs([
      shellRow('t1', here, 'here / 1'),
      shellRow('t4', shared, 'shared / Claude Code'),
      agentRow('t5', shared, 'shared / Claude Code'),
      shellRow('t6', alone, 'alone / Claude Code'),
    ]);
    for (const [id, cwd, where] of [['t1', here, 'here / 1'], ['t2', here, 'here / 2'], ['t3', here, 'x / Claude Code'], ['t4', shared, 'shared / Claude Code'], ['t6', alone, 'alone / Claude Code'], ['t7', here, 'plain']]) {
      hc.setGet(id, shellGet(id, cwd, where));
    }
    hc.setGet('t8', { ...shellGet('t8', here, 'busy / Claude Code'), foreground: { argv: ['claude.exe'], cwd: here, name: 'claude.exe', pid: 1 }, status: { app: 'claude-code', state: 'idle' } });
    saveSession(env, 't1', { agent: 'claude', sessionId: 'sess-here', cwd: here });
    saveSession(env, 't2', { agent: 'antigravity', sessionId: 'conv-elsewhere', cwd: saved });
    saveSession(env, 't3', { agent: 'claude', sessionId: 'sess-gone', cwd: gone });
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { agyExtraArgs: ['--fast'] });

    const plan = (terminalId, cwd) => ({ kind: 'plan', terminalId, cwd });
    const options = { pathDirs: [hc.dir] };
    const results = runInLoadedShell(env, [plan('t1', here), plan('t2', here), plan('t3', here), plan('t4', shared), plan('t6', alone), plan('t7', here), plan('t8', here), plan('t9', here)], options);
    const plans = results.map((res) => res.plan);
    const brief = (p) => (p ? [p.Action, p.Source, p.Exe, p.Arguments, p.ChangeTo] : null);

    assert.deepEqual(brief(plans[0]), ['revive', 'session-id', 'claude', ['--resume', 'sess-here'], '']);
    // saved in another folder: the tab changes there (ChangeTo is passed to Set-Location -LiteralPath), then resumes by id
    assert.deepEqual(brief(plans[1]), ['revive', 'session-id', 'agy', ['--conversation', 'conv-elsewhere', '--fast'], saved]);
    assert.equal(plans[2].Action, 'skip');
    assert.equal(plans[2].Reason, `the folder saved with session sess-gone no longer exists: ${gone}`);
    // the title fallback is not used next to another Claude tab in the same folder (here: one that already runs)
    assert.equal(plans[3].Action, 'skip');
    assert.match(plans[3].Reason, /^'claude -c' not used: 2 claude tabs share the folder .*shared \(t4, t5\)/);
    assert.deepEqual(brief(plans[4]), ['revive', 'tab-title', 'claude', ['-c'], '']);
    assert.equal(plans[5], null, 'a plain shell tab: nothing to restore');
    assert.equal(plans[6], null, 'hc reports an agent in the tab already');
    assert.equal(plans[7], null, 'unknown to hc, nothing saved');
    // `hc ls` is only asked when the title fallback is in play
    const lsCalls = hc.calls().filter((args) => args[0] === 'ls').length;
    assert.equal(lsCalls, 2);

    // hc cannot list the tabs: the title fallback is not used blindly; a saved session id still works
    hc.setFlag('fail-ls.txt', '1');
    const blind = runInLoadedShell(env, [plan('t6', alone), plan('t1', here)], options).map((res) => res.plan);
    assert.equal(blind[0].Action, 'skip');
    assert.match(blind[0].Reason, /^'claude -c' not used: the other tabs could not be listed \(hc ls failed\)/);
    assert.deepEqual(brief(blind[1]), ['revive', 'session-id', 'claude', ['--resume', 'sess-here'], '']);

    // Without hc on PATH only a saved session id can restore a tab
    const noHc = runInLoadedShell(env, [plan('t1', here), plan('t6', alone)]).map((res) => res.plan);
    assert.deepEqual(brief(noHc[0]), ['revive', 'session-id', 'claude', ['--resume', 'sess-here'], '']);
    assert.equal(noHc[1], null);
    assertRealHomeUntouched(env);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Item 8: shell commands
// ---------------------------------------------------------------------------------------------

test('shell commands: cortex-trust and cortex-status run with the Node path recorded at install time (node need not be on PATH) and say so when that path is gone', { skip: SKIP }, () => {
  const env = makeTempEnv('herdr-cortex-ps-commands-');
  try {
    const project = path.join(env.root, 'my project 작업');
    fs.mkdirSync(project, { recursive: true });
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false });

    // PATH holds neither node nor hc: everything below works through the recorded absolute path.
    // (the variables npm sets for a script are present, as in a shell started from one: the default folder
    // must still be the shell's location, not npm's INIT_CWD)
    const shellOptions = { extra: { npm_lifecycle_event: 'test', INIT_CWD: REPO_ROOT } };
    const [before] = runInLoadedShell(env, [
      { kind: 'command', cwd: project, command: 'cortex-trust status' },
    ], shellOptions);
    assert.match(before.text, /^Not approved: .*my project 작업/);
    assert.equal(before.exitCode, 1);

    // `cortex-trust approve` shows a confirmation dialog, so no child shell of a test may run it for a folder
    // that is not approved yet. The approval is made here, with the confirmation injected, in the store the
    // shell uses; the shell commands below read it.
    const sink = { write() { return true; } };
    assert.equal(
      runTrustCli(['approve', project], {
        globalDir: env.globalDir,
        stdout: sink,
        stderr: sink,
        confirm: () => ({ confirmed: true, via: 'dialog', detail: '' }),
      }),
      0,
    );

    const results = runInLoadedShell(env, [
      { kind: 'command', cwd: project, command: 'cortex-trust status' },
      { kind: 'command', cwd: env.root, command: `cortex-trust status ${psQuote(project)} --json` },
      { kind: 'command', cwd: env.root, command: 'cortex-trust list' },
      { kind: 'command', cwd: project, command: 'cortex-status' },
      { kind: 'command', cwd: env.root, command: 'cortex-trust frobnicate' },
    ], shellOptions);
    const [after, json, list, status, usage] = results;

    assert.match(after.text, /^Approved: .*my project 작업 \(since /);
    assert.equal(after.exitCode, 0);
    assert.deepEqual([JSON.parse(json.text).action, JSON.parse(json.text).approved], ['status', true]);
    assert.match(list.text, /my project 작업/);
    // The approval went into the store of the test home, the one this shell uses
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.globalDir, 'state', 'trusted-projects.json'), 'utf8')).projects.length, 1);
    assertRealHomeUntouched(env);
    assert.equal(usage.exitCode, 2, "an unknown command: usage on stderr, exit code 2 (the exit code of the CLI is passed on)");

    const lines = status.text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    assert.equal(lines[0], '=== herdr-cortex status ===');
    assert.ok(lines.includes(`Node         : ${process.version} OK | ${process.execPath}`), status.text);
    assert.ok(lines.includes('  recorded   : same path (exists)'));
    assert.ok(lines.includes('Claude hooks : SessionStart=ok SessionEnd=ok PreCompact=ok UserPromptSubmit=ok PreToolUse=ok'));
    assert.ok(lines.includes('Claude MCP   : "herdr-cortex" registered (node ok, server.mjs ok)'));
    assert.ok(lines.includes(`This folder  : ${project}`), status.text);
    assert.ok(lines.some((line) => /^ {2}approved {3}: yes \(since /.test(line)));
    assert.ok(lines.includes('Result       : everything checked is in order'));
    assert.equal(lines[lines.length - 1], 'Saved sessions: cortex=0, legacy=0');

    // The recorded Node disappears and node is not on PATH: both commands say what is wrong and how to fix it
    const recordPath = path.join(env.globalDir, 'state', 'install.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const vanished = path.join(env.root, 'old-node', 'node.exe');
    atomicWriteJson(recordPath, { ...record, nodePath: vanished });
    const broken = runInLoadedShell(env, [
      { kind: 'command', cwd: project, command: 'cortex-status' },
      { kind: 'command', cwd: project, command: 'cortex-trust status' },
    ]);
    for (const res of broken) {
      assert.ok(res.text.includes(`the path recorded at install time does not exist: ${vanished}`), res.text);
      assert.match(res.text, /Install Node\.js >= 22\.13, then run install\.ps1 again\./);
    }
    assert.match(broken[0].text, /^=== herdr-cortex status ===/);

    // ... while with node on PATH the diagnostics still run, and report the missing recorded path themselves
    const viaPath = runInLoadedShell(env, [{ kind: 'command', cwd: project, command: 'cortex-status' }], { pathDirs: [path.dirname(process.execPath)] });
    assert.ok(viaPath[0].text.includes(`! The Node path recorded at install time does not exist: ${vanished} (run install.ps1 again).`), viaPath[0].text);
    assert.ok(viaPath[0].text.includes(`  recorded   : ${vanished} (MISSING)`));
    assertRealHomeUntouched(env);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// install.ps1 / uninstall.ps1 end to end, in test-home mode
// ---------------------------------------------------------------------------------------------

function outputLines(res) {
  return res.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

test('install.ps1 and uninstall.ps1 (test home): prerequisites by -NodePath, validate-first, profile encoding kept, ExecutionPolicy only with consent and restored, leftovers listed, backups and data removed on request', { skip: SKIP }, () => {
  const env = makeTempEnv('herdr-cortex-ps-e2e-');
  try {
    const settingsPath = path.join(env.homeDir, '.claude', 'settings.json');
    const claudeJsonPath = path.join(env.homeDir, '.claude.json');
    const configPath = path.join(env.globalDir, 'config.json');
    const profilePath = path.join(env.homeDir, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
    const policyFile = path.join(env.homeDir, 'test-execution-policy.txt');
    const policyRecord = path.join(env.globalDir, 'state', 'execution-policy.json');
    const legacyStore = path.join(env.homeDir, '.herdr-revive');

    // What a machine with an older install and the predecessor tool looks like
    const userHook = { matcher: '', hooks: [{ type: 'command', command: 'echo user-own-hook' }] };
    atomicWriteJson(settingsPath, { theme: 'dark', hooks: { SessionStart: [userHook] } });
    atomicWriteJson(claudeJsonPath, { numStartups: 7, mcpServers: { cortex: { command: 'node', args: ['--no-warnings', path.join(REPO_ROOT, 'src', 'mcp', 'server.mjs')] } } });
    atomicWriteJson(configPath, OLD_DEFAULT_CONFIGS[1]);
    atomicWriteJson(path.join(legacyStore, 'sessions', 't1.json'), { agent: 'claude', sessionId: 'old' });
    // an ANSI (CP949) profile with Korean text and the predecessor's block
    const profileHead = Buffer.concat([Buffer.from('# '), HANGUL_CP949, Buffer.from(' profile\r\nSet-Alias ll Get-ChildItem\r\n')]);
    const legacyBlock = Buffer.from("# >>> herdr-revive >>>\r\n. 'C:\\old\\herdr-revive\\auto-revive.ps1'\r\n# <<< herdr-revive <<<\r\n");
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, Buffer.concat([profileHead, legacyBlock]));

    // PATH has no node, no hc, no claude; the policy of the (simulated) machine blocks local scripts
    const childEnv = psEnv(env, { extra: { HERDR_CORTEX_TEST_EXECUTION_POLICY: 'Undefined,Undefined' } });
    const install = (args = []) => runPsFile(INSTALL_PS1, ['-NodePath', process.execPath, ...args], { env: childEnv });
    const uninstall = (args = []) => runPsFile(UNINSTALL_PS1, ['-NodePath', process.execPath, ...args], { env: childEnv });

    // 1. A malformed file: nothing is installed, the profile and the policy are not touched
    fs.writeFileSync(settingsPath, '{ "hooks": ');
    const refused = install();
    assert.notEqual(refused.status, 0);
    assert.ok(`${refused.stdout}${refused.stderr}`.includes(`[ERROR] ${settingsPath}: is not valid JSON`), refused.stderr);
    assert.match(`${refused.stdout}${refused.stderr}`, /Nothing was changed\./);
    assert.deepEqual(fs.readFileSync(profilePath), Buffer.concat([profileHead, legacyBlock]));
    assert.equal(fs.existsSync(policyFile), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), JSON.parse(JSON.stringify(OLD_DEFAULT_CONFIGS[1])));
    atomicWriteJson(settingsPath, { theme: 'dark', hooks: { SessionStart: [userHook] } });

    // 2. Install without a policy switch and without a way to ask: the policy is NOT changed, and the command is printed
    const first = install();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstLines = outputLines(first);
    assert.equal(firstLines[0], '=== herdr-cortex Installer ===');
    assert.ok(firstLines.includes(`[TEST] Installing into the test home: ${env.homeDir}`));
    assert.ok(firstLines.includes(`[OK] Node for hooks and MCP server: ${process.execPath}`), first.stdout);
    assert.ok(firstLines.some((line) => line.startsWith('[OK] config.json was still the default of an older version')));
    assert.ok(firstLines.includes('[SKIP] PowerShell ExecutionPolicy not changed (CurrentUser=Undefined, LocalMachine=Undefined).'));
    assert.ok(firstLines.includes('         Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned'));
    assert.equal(fs.existsSync(policyFile), false, 'no policy change without consent');
    assert.equal(fs.existsSync(policyRecord), false);
    assert.ok(firstLines.some((line) => /^\[OK\] Updated PowerShell profile: .*Microsoft\.PowerShell_profile\.ps1 \(encoding kept: ansi-\d+\)$/.test(line)), first.stdout);
    assert.ok(firstLines.includes('[herdr-cortex] embedding: off (provider is "none"); nothing is sent anywhere.'));
    assert.ok(firstLines.includes('herdr-cortex installation complete!'));

    // hooks (exec form, absolute Node path), MCP under the new name, the old default config replaced
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(settings.hooks.SessionStart[0], userHook);
    const ours = settings.hooks.SessionStart[1].hooks[0];
    assert.equal(isOwnHook(ours), true);
    assert.deepEqual([ours.command, ours.args[1]], [process.execPath, path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs')]);
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    assert.deepEqual(Object.keys(claudeJson.mcpServers), ['herdr-cortex']);
    assert.equal(claudeJson.mcpServers['herdr-cortex'].command, process.execPath);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).embedding.provider, 'none');
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.globalDir, 'state', 'install.json'), 'utf8')).nodePath, process.execPath);

    // the profile: same bytes as before minus the predecessor's block, plus our block (ASCII); one dated backup
    const block = Buffer.from(`${BLOCK_START}\r\nif (Test-Path -LiteralPath '${AUTO_REVIVE}') { . '${AUTO_REVIVE}' }\r\n${BLOCK_END}\r\n`);
    assert.deepEqual(fs.readFileSync(profilePath), Buffer.concat([profileHead, block]));
    const profileBackups = findBackups(profilePath);
    assert.equal(profileBackups.length, 1);
    assert.deepEqual(fs.readFileSync(profileBackups[0]), Buffer.concat([profileHead, legacyBlock]));

    // 3. Again with -SetExecutionPolicy and -NoAutoResume: the policy is set and its previous value recorded
    const second = install(['-SetExecutionPolicy', '-NoAutoResume']);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.ok(outputLines(second).includes('[OK] Set PowerShell ExecutionPolicy (CurrentUser) to RemoteSigned (it was Undefined; uninstall.ps1 restores it).'), second.stdout);
    assert.equal(fs.readFileSync(policyFile, 'utf8'), 'RemoteSigned');
    const record = JSON.parse(fs.readFileSync(policyRecord, 'utf8'));
    assert.deepEqual([record.scope, record.previous, record.set], ['CurrentUser', 'Undefined', 'RemoteSigned']);
    assert.equal(fs.readFileSync(profilePath, 'latin1').includes("$env:HERDR_REVIVE_DISABLE = '1'\r\n"), true);
    // a third run: the policy no longer blocks, nothing is asked or changed; -SkipExecutionPolicy is accepted
    const third = install(['-SkipExecutionPolicy']);
    assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
    assert.equal(outputLines(third).some((line) => line.includes('ExecutionPolicy')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(policyRecord, 'utf8')).previous, 'Undefined');

    // 4. Uninstall: registrations and the profile block go, the policy is restored, and what stays is listed
    const removed = uninstall();
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`);
    const removedLines = outputLines(removed);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { theme: 'dark', hooks: { SessionStart: [userHook] } });
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')).mcpServers, {});
    assert.deepEqual(fs.readFileSync(profilePath), profileHead, 'the profile is what the user wrote');
    assert.ok(removedLines.includes('[OK] Restored PowerShell ExecutionPolicy (CurrentUser) to Undefined (the installer had set RemoteSigned).'), removed.stdout);
    assert.equal(fs.readFileSync(policyFile, 'utf8'), 'Undefined');
    assert.equal(fs.existsSync(policyRecord), false);

    const leftAt = removedLines.indexOf('Left on this machine:');
    assert.ok(leftAt > 0, removed.stdout);
    const left = removedLines.slice(leftAt + 1);
    const backupsNow = [
      ...findBackups(settingsPath), ...findBackups(claudeJsonPath), ...findBackups(configPath), ...findBackups(profilePath),
    ];
    assert.ok(backupsNow.length >= 7, 'every change so far left a dated backup');
    assert.equal(left[0], `  - Backup files (${backupsNow.length}); delete them with: .\\uninstall.ps1 -RemoveBackups`);
    assert.deepEqual(left.slice(1, 1 + backupsNow.length).map((line) => line.trim()).sort(), [...backupsNow].sort());
    assert.ok(left.includes(`  - Global store: ${env.globalDir} (memory documents, saved sessions, config.json); delete it with: .\\uninstall.ps1 -PurgeData`));
    assert.ok(left.includes(`  - Store of the predecessor herdr-revive: ${legacyStore}; -PurgeData deletes it as well`));
    assert.ok(left.includes('  - Project memory: the .memory\\ folder of each project is your data and is never removed'));
    assert.ok(left.includes('  - PowerShell ExecutionPolicy: CurrentUser=Undefined (restored)'));
    assert.equal(removedLines[removedLines.length - 1], 'herdr-cortex uninstall complete.');

    // 5. A policy the user changed after the install is left alone
    assert.equal(install(['-SetExecutionPolicy']).status, 0);
    fs.writeFileSync(policyFile, 'AllSigned');
    const keptPolicy = outputLines(uninstall());
    assert.equal(fs.readFileSync(policyFile, 'utf8'), 'AllSigned');
    assert.ok(keptPolicy.includes('  - PowerShell ExecutionPolicy: CurrentUser=AllSigned; the installer had set RemoteSigned (it was Undefined), but it was changed since, so it was left as it is'), keptPolicy.join('\n'));

    // 6. -RemoveBackups -PurgeData: the backups this tool made and both stores are deleted, and the output says so
    const unrelated = `${settingsPath}.bak`;
    fs.writeFileSync(unrelated, 'not ours');
    const purged = uninstall(['-RemoveBackups', '-PurgeData']);
    assert.equal(purged.status, 0, `${purged.stdout}\n${purged.stderr}`);
    const purgedLines = outputLines(purged);
    assert.ok(purgedLines.some((line) => line.startsWith(`[OK] Removed backup: ${profilePath}.herdr-cortex.`)), purged.stdout);
    assert.ok(purgedLines.includes(`[OK] Removed store directory: ${env.globalDir}`));
    assert.ok(purgedLines.includes(`[OK] Removed store directory: ${legacyStore}`));
    assert.ok(purgedLines.includes('  - Backup files: none'));
    assert.ok(purgedLines.includes('  - Global store: removed'));
    assert.equal(fs.existsSync(env.globalDir), false);
    assert.equal(fs.existsSync(legacyStore), false);
    for (const file of [settingsPath, claudeJsonPath, profilePath]) assert.deepEqual(findBackups(file), [], file);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'not ours');
    assert.deepEqual(fs.readFileSync(profilePath), profileHead);

    assertRealHomeUntouched();
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// ExecutionPolicy: success is judged by the value read back, not by whether Set-ExecutionPolicy threw
// ---------------------------------------------------------------------------------------------

// Set-ExecutionPolicy stores the CurrentUser value and then throws a security error when a more specific scope
// overrides it, which is always so under `powershell -ExecutionPolicy Bypass -File install.ps1`. A real install
// reported "could not set" and skipped the record uninstall needs, although the policy had changed.
const POLICY_DRIVER = [
  'param([string]$ToolsPath, [string]$OutPath)',
  '$ErrorActionPreference = "Stop"',
  '. $ToolsPath',
  '$results = New-Object System.Collections.Generic.List[object]',
  'function Probe([string]$Name, [scriptblock]$Setter) {',
  '    $script:stored = "Undefined"',
  '    $threw = $false; $message = ""',
  '    try { Invoke-HerdrPolicyChange -Value "RemoteSigned" -Setter $Setter -Getter { $script:stored } }',
  '    catch { $threw = $true; $message = [string]$_.Exception.Message }',
  '    $results.Add(@{ name = $Name; threw = $threw; message = $message; stored = $script:stored })',
  '}',
  'Probe "stores-then-throws" { param($v) $script:stored = $v; throw (New-Object System.Security.SecurityException "Security error.") }',
  'Probe "throws-without-storing" { param($v) throw (New-Object System.Security.SecurityException "Access denied.") }',
  'Probe "silently-does-nothing" { param($v) }',
  'Probe "stores" { param($v) $script:stored = $v }',
  '[System.IO.File]::WriteAllText($OutPath, (ConvertTo-Json -InputObject $results.ToArray() -Depth 4), (New-Object System.Text.UTF8Encoding($false)))',
  '',
].join('\r\n');

test('ExecutionPolicy change: a setter that stores the value and then throws counts as done; one that does not store it fails', { skip: SKIP }, () => {
  const env = makeTempEnv('herdr-cortex-ps-policy-');
  try {
    const driverPath = path.join(env.root, 'policy-driver.ps1');
    const outPath = path.join(env.root, 'policy-out.json');
    fs.writeFileSync(driverPath, POLICY_DRIVER);
    const res = runPsFile(driverPath, ['-ToolsPath', INSTALL_TOOLS, '-OutPath', outPath], { env: psEnv(env) });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const byName = Object.fromEntries(JSON.parse(fs.readFileSync(outPath, 'utf8')).map((r) => [r.name, r]));

    assert.equal(byName['stores-then-throws'].threw, false, 'the override warning is not a failure');
    assert.equal(byName['stores-then-throws'].stored, 'RemoteSigned');
    assert.equal(byName.stores.threw, false);

    assert.equal(byName['throws-without-storing'].threw, true);
    assert.match(byName['throws-without-storing'].message, /Access denied/);
    assert.equal(byName['throws-without-storing'].stored, 'Undefined');

    assert.equal(byName['silently-does-nothing'].threw, true);
    assert.match(byName['silently-does-nothing'].message, /is 'Undefined' after setting it to 'RemoteSigned'/);

    // The real setter is used only outside the test home; it must go through the same check.
    const source = fs.readFileSync(INSTALL_TOOLS, 'utf8');
    assert.match(source, /Invoke-HerdrPolicyChange -Value \$Value/);

    assertRealHomeUntouched();
  } finally {
    env.cleanup();
  }
});
