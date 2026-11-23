// Child processes of the tests must never show the real confirmation dialog of `cortex-trust`.
// `makeNoDialogEnv` builds an environment in which the dialog cannot be started: the variables that name
// the Windows folder point at an empty folder, so Windows PowerShell is not found there and the command has
// to refuse. `assertNoDialogEnv` proves that with a harmless child process before a test relies on it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export function makeNoDialogEnv(baseEnv, emptyDir) {
  fs.mkdirSync(emptyDir, { recursive: true });
  assert.deepEqual(fs.readdirSync(emptyDir), [], 'the stand-in Windows folder must be empty');
  const env = { ...baseEnv };
  // Windows treats variable names case-insensitively, a plain object does not: drop every spelling first.
  for (const key of Object.keys(env)) {
    if (/^(systemroot|windir)$/i.test(key)) delete env[key];
  }
  env.SystemRoot = emptyDir;
  env.windir = emptyDir;
  return env;
}

export function assertNoDialogEnv(env) {
  const confirmModule = new URL('../../src/core/confirm.mjs', import.meta.url).href;
  const probe = [
    "import fs from 'node:fs';",
    `import { resolveWindowsPowerShell } from ${JSON.stringify(confirmModule)};`,
    'const found = resolveWindowsPowerShell(process.env);',
    'process.stdout.write(JSON.stringify({ found, exists: Boolean(found) && fs.existsSync(found) }));',
  ].join('\n');
  const res = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', probe], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(res.status, 0, res.stderr);
  const seen = JSON.parse(res.stdout);
  assert.equal(seen.exists, false, `a child process with this environment could still start PowerShell: ${seen.found}`);
  if (process.platform === 'win32') {
    assert.ok(seen.found.toLowerCase().startsWith(String(env.SystemRoot).toLowerCase()), seen.found);
  }
}
