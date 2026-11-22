#!/usr/bin/env node
/**
 * Backwards-compatible wrapper delegating to src/revive/tracker.mjs.
 * Invoked by legacy hooks or manual callers:
 *   node scripts/record-session.mjs <antigravity|claude>
 */
import fs from 'node:fs';
import { recordSession } from '../src/revive/tracker.mjs';

const agentArg = (process.argv[2] || '').toLowerCase();
const isAntigravity = agentArg === 'antigravity';

function finish() {
  if (isAntigravity) {
    process.stdout.write('{}\n');
  }
  process.exit(0);
}

try {
  const raw = fs.readFileSync(0, 'utf8');
  let payload = {};
  if (raw && raw.trim().length > 0) {
    payload = JSON.parse(raw);
  }
  recordSession({
    terminalId: process.env.HC_TERMINAL_ID,
    agent: isAntigravity ? 'antigravity' : 'claude',
    payload,
  });
} catch {
  // Never fail or block the agent CLI
}

finish();
