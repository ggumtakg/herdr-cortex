// Loaded before every test file: `npm test` passes it to Node with --import, and the test runner hands the
// flag on to the process of each test file.
//
// No test, and no child process a test starts, may reach the user's real home directory or the real global
// store, even when a test forgets to pass its own directories. This module points the home directory
// (USERPROFILE, HOME, HERDR_CORTEX_TEST_HOME) and the global store (HERDR_CORTEX_HOME) at one temporary
// directory per test run. The process that created the directory removes it when it exits; the processes of
// the test files inherit HERDR_CORTEX_TEST_GUARD_DIR and reuse it. Tests that pass their own directories are
// unaffected: an explicit argument always wins over these variables.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_GUARD_VARIABLE = 'HERDR_CORTEX_TEST_GUARD_DIR';

if (!process.env[TEST_GUARD_VARIABLE]) {
  // os.tmpdir() reads TEMP/TMP, so it still names the real temp folder here.
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cortex-test-home-'));
  process.env[TEST_GUARD_VARIABLE] = created;
  process.on('exit', () => {
    try {
      fs.rmSync(created, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // best effort: a leftover temp folder is harmless
    }
  });
}

const guardHome = process.env[TEST_GUARD_VARIABLE];
fs.mkdirSync(guardHome, { recursive: true });

process.env.USERPROFILE = guardHome;
process.env.HOME = guardHome;
process.env.HERDR_CORTEX_TEST_HOME = guardHome;
process.env.HERDR_CORTEX_HOME = path.join(guardHome, '.herdr-cortex');
delete process.env.HERDR_REVIVE_TEST_HOME;
