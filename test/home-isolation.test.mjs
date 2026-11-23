import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  GLOBAL_DIR_NAME,
  REPO_ROOT,
  getGlobalDir,
  getTrustedProjectsPath,
  resolveGlobalDir,
  resolveHomeDir,
} from '../src/core/config.mjs';
import { resolveTrustCliCwd } from '../src/core/trust-cli.mjs';
import { describeInstalledEmbedding, installCortex, listBackups, uninstallCortex } from '../src/hooks/installer.mjs';
import { getLegacySessionsDir, resolveCortexGlobalDir, resolveEffectiveHome } from '../src/revive/tracker.mjs';
import { TEST_GUARD_VARIABLE } from './support/isolate-home.mjs';

function realIfExists(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function isInside(parent, child) {
  const rel = path.relative(realIfExists(parent), realIfExists(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function restoreEnv(saved, keys) {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

// ---------------------------------------------------------------------------------------------
// The guard: nothing in the suite can resolve the real home directory or the real global store
// ---------------------------------------------------------------------------------------------

test('test-suite guard: the home directory and the default global store of every test process are inside the per-run temp directory', () => {
  const guardDir = process.env[TEST_GUARD_VARIABLE];
  assert.ok(
    guardDir,
    `${TEST_GUARD_VARIABLE} is not set: run the suite through "npm test" (it loads test/support/isolate-home.mjs with --import)`,
  );
  assert.ok(fs.statSync(guardDir).isDirectory());
  assert.ok(isInside(os.tmpdir(), guardDir), 'the guard directory is a temp directory');

  // What the code under test resolves when a test passes no directory at all
  assert.equal(path.resolve(os.homedir()), path.resolve(guardDir));
  assert.equal(resolveHomeDir(), path.resolve(guardDir));
  assert.equal(resolveEffectiveHome(), path.resolve(guardDir));
  assert.equal(getGlobalDir(), path.join(path.resolve(guardDir), GLOBAL_DIR_NAME));
  assert.equal(resolveCortexGlobalDir(), getGlobalDir());
  assert.equal(getTrustedProjectsPath(), path.join(getGlobalDir(), 'state', 'trusted-projects.json'));
  assert.ok(isInside(guardDir, getLegacySessionsDir()));

  // A child process inherits the guard; so does one that was given only a test home of its own
  // (the accident this guard exists for: HERDR_CORTEX_TEST_HOME set, HERDR_CORTEX_HOME forgotten).
  const probe = [
    "import os from 'node:os';",
    `import { getGlobalDir, getTrustedProjectsPath } from ${JSON.stringify(new URL('../src/core/config.mjs', import.meta.url).href)};`,
    'process.stdout.write(JSON.stringify({ home: os.homedir(), globalDir: getGlobalDir(), approvals: getTrustedProjectsPath() }));',
  ].join('\n');
  const runProbe = (env) => {
    const res = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', probe], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };

  const inherited = runProbe(process.env);
  assert.equal(path.resolve(inherited.home), path.resolve(guardDir));
  assert.equal(inherited.globalDir, getGlobalDir());

  const ownHome = path.join(guardDir, 'own-test-home');
  const onlyTestHome = { ...process.env, HERDR_CORTEX_TEST_HOME: ownHome };
  delete onlyTestHome.HERDR_CORTEX_HOME;
  const viaTestHome = runProbe(onlyTestHome);
  assert.equal(viaTestHome.globalDir, path.join(ownHome, GLOBAL_DIR_NAME));
  assert.equal(viaTestHome.approvals, path.join(ownHome, GLOBAL_DIR_NAME, 'state', 'trusted-projects.json'));
});

// ---------------------------------------------------------------------------------------------
// One precedence for the global store, used by the runtime, the command lines and the installer
// ---------------------------------------------------------------------------------------------

test('global store location: explicit argument, then HERDR_CORTEX_HOME, then <HERDR_CORTEX_TEST_HOME>/.herdr-cortex, then <user home>/.herdr-cortex', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cortex-precedence-'));
  const saved = { ...process.env };
  try {
    const explicit = path.join(base, 'explicit-store');
    const explicitHome = path.join(base, 'explicit-home');
    const envStore = path.join(base, 'env-store');
    const testHome = path.join(base, 'test-home');
    const legacyTestHome = path.join(base, 'legacy-test-home');
    const everything = {
      HERDR_CORTEX_HOME: envStore,
      HERDR_CORTEX_TEST_HOME: testHome,
      HERDR_REVIVE_TEST_HOME: legacyTestHome,
    };

    assert.equal(resolveGlobalDir({ globalDir: explicit, homeDir: explicitHome, env: everything }), explicit);
    assert.equal(resolveGlobalDir({ homeDir: explicitHome, env: everything }), path.join(explicitHome, GLOBAL_DIR_NAME));
    assert.equal(resolveGlobalDir({ env: everything }), envStore);
    assert.equal(
      resolveGlobalDir({ env: { HERDR_CORTEX_TEST_HOME: testHome, HERDR_REVIVE_TEST_HOME: legacyTestHome } }),
      path.join(testHome, GLOBAL_DIR_NAME),
    );
    assert.equal(
      resolveGlobalDir({ env: { HERDR_REVIVE_TEST_HOME: legacyTestHome } }),
      path.join(legacyTestHome, GLOBAL_DIR_NAME),
    );
    assert.equal(resolveGlobalDir({ env: {} }), path.join(os.homedir(), GLOBAL_DIR_NAME));
    // Blank values count as not set
    assert.equal(
      resolveGlobalDir({ globalDir: '  ', env: { HERDR_CORTEX_HOME: ' ', HERDR_CORTEX_TEST_HOME: testHome } }),
      path.join(testHome, GLOBAL_DIR_NAME),
    );

    assert.equal(resolveHomeDir(explicitHome, { env: everything }), explicitHome);
    assert.equal(resolveHomeDir('', { env: everything }), testHome);
    assert.equal(resolveHomeDir('', { env: { HERDR_REVIVE_TEST_HOME: legacyTestHome } }), legacyTestHome);
    assert.equal(resolveHomeDir('', { env: {} }), os.homedir());

    // The same function is behind every entry point of the running process
    process.env.HERDR_CORTEX_HOME = envStore;
    process.env.HERDR_CORTEX_TEST_HOME = testHome;
    assert.equal(getGlobalDir(), envStore);
    assert.equal(resolveCortexGlobalDir(), envStore);
    assert.equal(getGlobalDir(explicit), explicit);
    delete process.env.HERDR_CORTEX_HOME;
    assert.equal(
      getGlobalDir(),
      path.join(testHome, GLOBAL_DIR_NAME),
      'getGlobalDir honors HERDR_CORTEX_TEST_HOME like the session tracker does',
    );
    assert.equal(resolveCortexGlobalDir(), path.join(testHome, GLOBAL_DIR_NAME));
    assert.equal(resolveEffectiveHome(), testHome);
  } finally {
    restoreEnv(saved, ['HERDR_CORTEX_HOME', 'HERDR_CORTEX_TEST_HOME']);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('installer: the global store follows the same precedence (HERDR_CORTEX_HOME is honored, an explicit home keeps its own store)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cortex-installer-store-'));
  const saved = { ...process.env };
  const options = { nodePath: process.execPath, claudeCli: null, antigravityPresent: false, verifyDelayMs: 0 };
  try {
    const home = path.join(base, 'home');
    const store = path.join(base, 'elsewhere', 'store');
    fs.mkdirSync(home, { recursive: true });

    // Configuration files go to the test home, the store goes where HERDR_CORTEX_HOME says
    process.env.HERDR_CORTEX_TEST_HOME = home;
    process.env.HERDR_CORTEX_HOME = store;
    const installed = installCortex(options);
    assert.equal(installed.ok, true, JSON.stringify(installed.problems));
    assert.equal(installed.homeDir, home);
    assert.equal(installed.globalInit.globalDir, store);
    assert.ok(fs.existsSync(path.join(store, 'config.json')));
    assert.ok(fs.existsSync(path.join(store, 'state', 'install.json')));
    assert.equal(
      fs.existsSync(path.join(home, GLOBAL_DIR_NAME)),
      false,
      'nothing is created in <home>/.herdr-cortex when HERDR_CORTEX_HOME names another place',
    );
    assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')));
    assert.deepEqual(listBackups(), []);
    assert.ok(describeInstalledEmbedding().length > 0);

    const removed = uninstallCortex({ claudeCli: null });
    assert.equal(removed.ok, true, JSON.stringify(removed.problems));
    assert.equal(
      fs.existsSync(path.join(store, 'state', 'install.json')),
      false,
      'uninstall finds the install record in the same store',
    );

    // An explicit home directory is an explicit argument: its own store, whatever the environment says
    const otherHome = path.join(base, 'other-home');
    fs.mkdirSync(otherHome, { recursive: true });
    const explicit = installCortex({ ...options, homeDir: otherHome });
    assert.equal(explicit.ok, true, JSON.stringify(explicit.problems));
    assert.equal(explicit.globalInit.globalDir, path.join(otherHome, GLOBAL_DIR_NAME));

    // ... and an explicit store wins over an explicit home
    const explicitStore = path.join(base, 'explicit-store');
    const both = installCortex({ ...options, homeDir: otherHome, globalDir: explicitStore });
    assert.equal(both.ok, true, JSON.stringify(both.problems));
    assert.equal(both.globalInit.globalDir, explicitStore);
  } finally {
    restoreEnv(saved, ['HERDR_CORTEX_HOME', 'HERDR_CORTEX_TEST_HOME']);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// cortex-trust: the default folder
// ---------------------------------------------------------------------------------------------

test('trust CLI default folder: INIT_CWD is used only when running as the "trust" npm script of this package', () => {
  const cwd = path.join(os.tmpdir(), 'shell-location');
  const initCwd = path.join(os.tmpdir(), 'where-npm-was-run');
  const packageJson = path.join(REPO_ROOT, 'package.json');
  const ours = { npm_lifecycle_event: 'trust', npm_package_json: packageJson, npm_package_name: 'herdr-cortex', INIT_CWD: initCwd };

  // npm run trust (of this package): the folder the user ran npm from
  assert.equal(resolveTrustCliCwd({ env: ours, cwd }), initCwd);
  // npm versions that do not set npm_package_json: the package name decides
  assert.equal(
    resolveTrustCliCwd({ env: { npm_lifecycle_event: 'trust', npm_package_name: 'herdr-cortex', INIT_CWD: initCwd }, cwd }),
    initCwd,
  );

  // Anything else, for example a shell that was itself started from an npm script of some project
  for (const env of [
    { ...ours, npm_lifecycle_event: 'test' },
    { ...ours, npm_package_json: path.join(os.tmpdir(), 'other', 'package.json'), npm_package_name: 'other' },
    { ...ours, npm_package_json: path.join(os.tmpdir(), 'other', 'package.json') },
    { npm_lifecycle_event: 'trust', npm_package_name: 'other-package', INIT_CWD: initCwd },
    { npm_lifecycle_event: 'trust', INIT_CWD: initCwd },
    { npm_lifecycle_event: 'trust', npm_package_json: packageJson, npm_package_name: 'herdr-cortex' },
    { INIT_CWD: initCwd },
    {},
  ]) {
    assert.equal(resolveTrustCliCwd({ env, cwd }), cwd, JSON.stringify(env));
  }
});
