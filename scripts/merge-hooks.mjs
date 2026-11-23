#!/usr/bin/env node
/**
 * Backwards-compatible wrapper delegating to src/hooks/installer.mjs.
 * Usage: node scripts/merge-hooks.mjs <install|uninstall> [repoRoot]
 */
import path from 'node:path';
import { REPO_ROOT } from '../src/core/config.mjs';
import { formatInstallSummary, installCortex, uninstallCortex } from '../src/hooks/installer.mjs';

const action = (process.argv[2] || '').trim().toLowerCase();
const repoRoot = process.argv[3] ? path.resolve(process.argv[3]) : REPO_ROOT;

if (action !== 'install' && action !== 'uninstall') {
  console.error('Usage: node scripts/merge-hooks.mjs <install|uninstall> [repoRoot]');
  process.exit(1);
}

const result = action === 'install'
  ? installCortex({ repoRoot })
  : uninstallCortex({ repoRoot });

if (action === 'install' && !result.ok) {
  for (const problem of result.problems) console.error(`[ERROR] ${problem.file}: ${problem.message}`);
  console.error('[ERROR] Nothing was changed. Fix what is named above, then run the installer again.');
  process.exit(1);
}

for (const line of formatInstallSummary(result)) console.log(line);
console.log(`[OK] herdr-cortex ${result.action} complete (home=${result.homeDir})`);
if (!result.ok) process.exitCode = 1;
