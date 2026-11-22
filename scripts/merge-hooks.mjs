#!/usr/bin/env node
/**
 * Backwards-compatible wrapper delegating to src/hooks/installer.mjs.
 * Usage: node scripts/merge-hooks.mjs <install|uninstall> [repoRoot]
 */
import path from 'node:path';
import { REPO_ROOT } from '../src/core/config.mjs';
import { installCortex, uninstallCortex } from '../src/hooks/installer.mjs';

const action = (process.argv[2] || '').trim().toLowerCase();
const repoRoot = process.argv[3] ? path.resolve(process.argv[3]) : REPO_ROOT;

if (action !== 'install' && action !== 'uninstall') {
  console.error('Usage: node scripts/merge-hooks.mjs <install|uninstall> [repoRoot]');
  process.exit(1);
}

const result = action === 'install'
  ? installCortex({ repoRoot })
  : uninstallCortex({ repoRoot });

console.log(`[OK] herdr-cortex ${result.action} complete (home=${result.homeDir})`);
