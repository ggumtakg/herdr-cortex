import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { GLOBAL_DIR_NAME, REPO_ROOT, resolveGlobalDir, resolveHomeDir } from '../src/core/config.mjs';

// Windows PowerShell 5.1 against scratch folders only (see powershell-scripts.test.mjs): a test home, a
// stand-in for the real home directory, and a PATH that holds Windows itself and nothing else.
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SKIP = process.platform === 'win32' && fs.existsSync(POWERSHELL) ? false : 'Windows PowerShell is not available';

const STORE_LOCATION = path.join(REPO_ROOT, 'scripts', 'store-location.ps1');
const INSTALL_PS1 = path.join(REPO_ROOT, 'install.ps1');
const UNINSTALL_PS1 = path.join(REPO_ROOT, 'uninstall.ps1');

const LOCATION_VARIABLES = ['HERDR_CORTEX_HOME', 'HERDR_CORTEX_TEST_HOME', 'HERDR_REVIVE_TEST_HOME'];

function makeTempEnv(prefix = 'herdr-cortex-ps-store-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(root, 'home');
  const realHomeStandIn = path.join(root, 'real-home-stand-in');
  for (const dir of [homeDir, realHomeStandIn]) fs.mkdirSync(dir, { recursive: true });
  return {
    root,
    homeDir,
    realHomeStandIn,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Environment of a child PowerShell: only the location variables given in `vars`, USERPROFILE pointing at
// the stand-in, and a PATH without node, hc or claude.
function psEnv(env, vars = {}) {
  const out = { ...process.env };
  for (const key of Object.keys(out)) {
    if (/^(path|userprofile|home|HC_TERMINAL_ID|CLAUDECODE|HERDR_CORTEX_HOME|HERDR_CORTEX_TEST_HOME|HERDR_REVIVE_TEST_HOME|HERDR_REVIVE_DISABLE|HERDR_REVIVE_IN_AGENT|HERDR_CORTEX_TEST_EXECUTION_POLICY)$/i.test(key)) {
      delete out[key];
    }
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  out.Path = [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  out.USERPROFILE = env.realHomeStandIn;
  return { ...out, ...vars };
}

function runPsFile(scriptPath, args, options = {}) {
  return spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 120000, ...options },
  );
}

function assertStandInUntouched(env) {
  assert.deepEqual(
    fs.readdirSync(env.realHomeStandIn).filter((name) => name !== 'AppData'),
    [],
    'nothing was written into the (stand-in) real home directory',
  );
}

test('store-location.ps1: the PowerShell scripts resolve the home directory and the global store in the same order as the Node side', { skip: SKIP }, () => {
  const env = makeTempEnv();
  try {
    const driver = path.join(env.root, 'print-location.ps1');
    fs.writeFileSync(driver, [
      'param([string]$LocationScript, [string]$OutPath, [string]$Explicit)',
      '$ErrorActionPreference = "Stop"',
      '. $LocationScript',
      '$result = @{',
      '    testHome = [string](Get-HerdrTestHome)',
      '    home = [string](Get-HerdrEffectiveHome)',
      '    globalDir = [string](Get-HerdrCortexGlobalDir)',
      '    explicit = [string](Get-HerdrCortexGlobalDir -GlobalDir $Explicit)',
      '}',
      '[System.IO.File]::WriteAllText($OutPath, (ConvertTo-Json -InputObject $result), (New-Object System.Text.UTF8Encoding($false)))',
      '',
    ].join('\r\n'));
    const outPath = path.join(env.root, 'location.json');
    const explicit = path.join(env.root, 'explicit store');

    const envStore = path.join(env.root, 'env store 저장소');
    const testHome = path.join(env.root, 'test home');
    const legacyTestHome = path.join(env.root, 'legacy-test-home');
    const cases = [
      { HERDR_CORTEX_HOME: envStore, HERDR_CORTEX_TEST_HOME: testHome, HERDR_REVIVE_TEST_HOME: legacyTestHome },
      { HERDR_CORTEX_TEST_HOME: testHome, HERDR_REVIVE_TEST_HOME: legacyTestHome },
      { HERDR_REVIVE_TEST_HOME: legacyTestHome },
      { HERDR_CORTEX_HOME: envStore },
      { HERDR_CORTEX_HOME: '   ', HERDR_CORTEX_TEST_HOME: testHome },
      {},
    ];
    for (const vars of cases) {
      fs.rmSync(outPath, { force: true });
      const res = runPsFile(driver, ['-LocationScript', STORE_LOCATION, '-OutPath', outPath, '-Explicit', explicit], { env: psEnv(env, vars) });
      assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
      const seen = JSON.parse(fs.readFileSync(outPath, 'utf8'));

      // What the Node side resolves for the same variables (USERPROFILE is the home directory there)
      const nodeEnv = { ...vars };
      const expectedHome = nodeEnv.HERDR_CORTEX_TEST_HOME || nodeEnv.HERDR_REVIVE_TEST_HOME || env.realHomeStandIn;
      const expectedGlobal = (nodeEnv.HERDR_CORTEX_HOME || '').trim()
        ? nodeEnv.HERDR_CORTEX_HOME
        : path.join(expectedHome, GLOBAL_DIR_NAME);
      assert.deepEqual(seen, {
        testHome: nodeEnv.HERDR_CORTEX_TEST_HOME || nodeEnv.HERDR_REVIVE_TEST_HOME || '',
        home: expectedHome,
        globalDir: expectedGlobal,
        explicit,
      }, JSON.stringify(vars));
      if (nodeEnv.HERDR_CORTEX_TEST_HOME || nodeEnv.HERDR_REVIVE_TEST_HOME) {
        assert.equal(resolveHomeDir('', { env: nodeEnv }), seen.home, JSON.stringify(vars));
        assert.equal(resolveGlobalDir({ env: nodeEnv }), seen.globalDir, JSON.stringify(vars));
      } else if ((nodeEnv.HERDR_CORTEX_HOME || '').trim()) {
        assert.equal(resolveGlobalDir({ env: nodeEnv }), seen.globalDir, JSON.stringify(vars));
      }
      assert.equal(resolveGlobalDir({ globalDir: explicit, env: nodeEnv }), seen.explicit);
    }

    // Every script that needs a location takes it from this one file
    for (const script of ['install.ps1', 'uninstall.ps1', path.join('scripts', 'auto-revive.ps1'), path.join('scripts', 'revive-agents.ps1')]) {
      const text = fs.readFileSync(path.join(REPO_ROOT, script), 'utf8');
      assert.match(text, /store-location\.ps1/, script);
      assert.match(text, /Get-HerdrCortexGlobalDir/, script);
      for (const name of LOCATION_VARIABLES) {
        assert.equal(text.includes(`$env:${name}`), false, `${script} reads ${name} itself`);
      }
    }
    for (const script of ['install.ps1', 'uninstall.ps1', ...fs.readdirSync(path.join(REPO_ROOT, 'scripts')).filter((name) => name.endsWith('.ps1')).map((name) => path.join('scripts', name))]) {
      const bytes = fs.readFileSync(path.join(REPO_ROOT, script));
      assert.equal(bytes.some((byte) => byte > 0x7f), false, `${script} is ASCII only`);
    }
    assertStandInUntouched(env);
  } finally {
    env.cleanup();
  }
});

test('install.ps1 / uninstall.ps1: the global store goes where HERDR_CORTEX_HOME says, also for the Node installer they start', { skip: SKIP }, () => {
  const env = makeTempEnv('herdr-cortex-ps-store-install-');
  try {
    const store = path.join(env.root, 'elsewhere', 'the store');
    const childEnv = psEnv(env, {
      HERDR_CORTEX_TEST_HOME: env.homeDir,
      HERDR_CORTEX_HOME: store,
      HERDR_CORTEX_TEST_EXECUTION_POLICY: 'Undefined,Undefined',
    });

    const install = runPsFile(INSTALL_PS1, ['-NodePath', process.execPath, '-SetExecutionPolicy'], { env: childEnv });
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    assert.ok(install.stdout.includes(`[OK] Global store: ${store} (config.json created)`), install.stdout);
    assert.ok(fs.existsSync(path.join(store, 'config.json')));
    assert.ok(fs.existsSync(path.join(store, 'state', 'install.json')), 'the Node installer used the same store');
    assert.ok(fs.existsSync(path.join(store, 'state', 'execution-policy.json')), 'install.ps1 itself used the same store');
    assert.equal(fs.existsSync(path.join(env.homeDir, GLOBAL_DIR_NAME)), false, 'nothing in <home>\\.herdr-cortex');
    assert.ok(fs.existsSync(path.join(env.homeDir, '.claude', 'settings.json')), 'settings still go to the home directory');

    const uninstall = runPsFile(UNINSTALL_PS1, ['-NodePath', process.execPath, '-PurgeData'], { env: childEnv });
    assert.equal(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    assert.ok(uninstall.stdout.includes(`[OK] Removed store directory: ${store}`), uninstall.stdout);
    assert.equal(fs.existsSync(store), false);
    assertStandInUntouched(env);
  } finally {
    env.cleanup();
  }
});

test('install.ps1: a fatal problem ends the script with exit code 1 by itself (the caller sees $LASTEXITCODE 1, not a thrown error)', { skip: SKIP }, () => {
  const env = makeTempEnv('herdr-cortex-ps-exit-');
  try {
    const missingNode = path.join(env.root, 'no-such', 'node.exe');
    const childEnv = psEnv(env, { HERDR_CORTEX_TEST_HOME: env.homeDir });

    // Called from another script, as a user's own setup script would call it
    const driver = path.join(env.root, 'call-install.ps1');
    fs.writeFileSync(driver, [
      'param([string]$InstallPath, [string]$NodePath)',
      '$global:LASTEXITCODE = 0',
      '$threw = $false',
      'try {',
      '    & $InstallPath -NodePath $NodePath -SkipExecutionPolicy 2>$null | Out-Null',
      '} catch {',
      '    $threw = $true',
      '}',
      'Write-Output ("THREW=" + $threw + " EXIT=" + $LASTEXITCODE)',
      'exit 0',
      '',
    ].join('\r\n'));
    const called = runPsFile(driver, ['-InstallPath', INSTALL_PS1, '-NodePath', missingNode], { env: childEnv });
    assert.equal(called.status, 0, `${called.stdout}\n${called.stderr}`);
    assert.match(called.stdout, /THREW=False EXIT=1/);

    // Started directly: exit code 1 and the reason on stderr
    const direct = runPsFile(INSTALL_PS1, ['-NodePath', missingNode], { env: childEnv });
    assert.equal(direct.status, 1);
    // (PowerShell wraps the error text at the console width, so the text is compared without white space)
    assert.ok(direct.stderr.replace(/\s+/g, '').includes('-NodePathdoesnotpointatafile:'), direct.stderr);

    // Nothing was installed anywhere
    assert.deepEqual(fs.readdirSync(env.homeDir), []);
    assertStandInUntouched(env);

    // No "Write-Error ...; exit" pair is left in install.ps1: every fatal message goes through the helper
    const text = fs.readFileSync(INSTALL_PS1, 'utf8');
    assert.equal(/Write-Error [^\r\n]*\r?\n\s*exit 1/.test(text.replace(/Write-Error -Message \$Message -ErrorAction Continue/, '')), false);
    assert.equal((text.match(/Stop-HerdrInstall "/g) || []).length, 4);
  } finally {
    env.cleanup();
  }
});
