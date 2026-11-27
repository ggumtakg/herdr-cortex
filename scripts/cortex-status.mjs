#!/usr/bin/env node
/**
 * The diagnostics behind the `cortex-status` shell command.
 * Usage: node --no-warnings scripts/cortex-status.mjs [--cwd <folder>] [--json]
 *
 * It reads configuration files and the local indexes and makes no network request. To report duplicate
 * document ids it runs the ordinary index sync of the tiers it may open (the same sync every memory tool runs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  GLOBAL_DIR_NAME,
  REPO_ROOT,
  getConfigProblems,
  isMainModule,
  isProjectEnabled,
  loadConfig,
  projectPathKey,
  resolveGlobalDir,
  resolveHomeDir,
  resolveProjectRoot,
  resolveWorkSizeConfig,
} from '../src/core/config.mjs';
import { getDuplicateDocIds, readDeferredIndex } from '../src/core/db.mjs';
import { CortexStore } from '../src/core/store.mjs';
import {
  ACKNOWLEDGE_COMMAND,
  TRUST_COMMAND,
  describeApprovalsChange,
  describeProjectTrust,
  formatApprovalsChangedWarning,
  listTrustedProjects,
} from '../src/core/trust.mjs';
import { describeEmbeddingStatus, formatEmbeddingStatus } from '../src/embeddings/resolve.mjs';
import {
  MCP_SERVER_KEY,
  checkAntigravity,
  checkClaudeHooks,
  checkClaudeMcpRegistration,
  readInstallRecord,
} from '../src/hooks/installer.mjs';
import { countInboxMessages, getInboxRootDir, peekInbox } from '../src/relay/inbox.mjs';
import { isValidTerminalId } from '../src/revive/tracker.mjs';
import { readWorkSizeState, tabWorkSizeScope } from '../src/hooks/work-size.mjs';

const REINSTALL_ADVICE = 'run install.ps1 again';

function withoutConsoleWarnings(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

function nodeVersionOk(version) {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 22 || (major === 22 && Number(match[2]) >= 13);
}

async function checkSqliteVec(repoRoot) {
  try {
    const req = createRequire(path.join(repoRoot, 'package.json'));
    const mod = await import(pathToFileURL(req.resolve('sqlite-vec')).href);
    return typeof mod.load === 'function' ? 'available' : 'installed, but it has no load()';
  } catch (err) {
    return `not available (${err?.code || 'not installed'}): vector search is off until "npm install" is run`;
  }
}

// Why the folder is enabled or not, in a few words.
function describeEnabledRule(config, enabled) {
  if (config.enabled === false) return 'enabled: false in config';
  const mode = String(config.mode || 'all').trim().toLowerCase();
  if (mode === 'opt-in') return enabled ? 'mode=opt-in, listed in enabledProjects' : 'mode=opt-in, not in enabledProjects';
  return enabled ? 'mode=all' : 'matches excludedProjects';
}

function countDocs(tier) {
  const counts = { total: 0, ready: 0, pending: 0, error: 0 };
  try {
    const rows = tier.db.prepare('SELECT embed_status, COUNT(*) AS cnt FROM docs GROUP BY embed_status').all();
    for (const row of rows) {
      const key = String(row.embed_status || 'pending').toLowerCase();
      const count = Number(row.cnt) || 0;
      counts.total += count;
      counts[key] = (counts[key] || 0) + count;
    }
  } catch (err) {
    counts.error_message = String(err?.message || err).slice(0, 120);
  }
  return counts;
}

// One tier of the index: document counts, what a hook left unindexed, duplicate ids.
function inspectTier(store, scope) {
  const dir = store.getTierDir(scope);
  const info = { scope, dir, opened: false, reason: '', docs: null, deferredBefore: 0, deferred: null, duplicates: [], failedSync: 0 };
  let tier;
  try {
    tier = store.getTierIfExists(scope);
  } catch (err) {
    info.reason = String(err?.message || err).slice(0, 160);
    return info;
  }
  if (!tier) {
    if (scope === 'project' && !store.isProjectEnabled()) info.reason = 'excluded by configuration';
    else if (scope === 'project' && !store.isProjectTrusted()) info.reason = 'folder not approved';
    else info.reason = 'nothing stored yet';
    return info;
  }
  info.opened = true;
  info.deferredBefore = readDeferredIndex(dir).count;
  try {
    const result = store.sync(scope)[scope];
    info.failedSync = result?.failed?.length || 0;
  } catch (err) {
    info.syncError = String(err?.message || err).slice(0, 160);
  }
  info.deferred = readDeferredIndex(dir);
  info.duplicates = getDuplicateDocIds(dir);
  info.docs = countDocs(tier);
  return info;
}

function inspectInbox(terminalId, globalDir) {
  const counts = countInboxMessages(terminalId, { globalDir });
  let announced = 0;
  try {
    announced = peekInbox(terminalId, { globalDir }).messages.filter((message) => message.announced).length;
  } catch {
    announced = 0;
  }
  return { terminalId, ...counts, announced };
}

// Every terminal that has anything in the global inbox.
function inspectAllInboxes(globalDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(getInboxRootDir(globalDir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !isValidTerminalId(ent.name)) continue;
    const info = inspectInbox(ent.name, globalDir);
    if (info.pending + info.held + info.broken > 0) out.push(info);
  }
  return out.sort((a, b) => a.terminalId.localeCompare(b.terminalId));
}

/**
 * Gather everything `cortex-status` shows. Options: `repoRoot`, `cwd` (the folder to report on), `homeDir`,
 * `globalDir`, `env` (API keys are looked up by name only; `HC_TERMINAL_ID` selects the tab's inbox; its PATH
 * is searched for `agy`, as the installer does).
 * Returns a plain object (see `formatStatus` for how it is displayed); `warnings` lists what needs attention.
 */
export async function collectStatus({
  repoRoot = REPO_ROOT,
  cwd = process.cwd(),
  homeDir,
  globalDir,
  env = process.env,
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedHome = resolveHomeDir(homeDir);
  // A home directory given explicitly keeps its own store; otherwise the usual lookup applies.
  const resolvedGlobal = resolveGlobalDir({ globalDir, homeDir });
  const folder = path.resolve(cwd);
  const warnings = [];

  // Node
  const record = readInstallRecord(resolvedGlobal) || readInstallRecord(path.join(resolvedHome, GLOBAL_DIR_NAME));
  const recordedNode = typeof record?.nodePath === 'string' ? record.nodePath : '';
  const node = {
    running: process.execPath,
    version: process.version,
    versionOk: nodeVersionOk(process.version),
    recorded: recordedNode,
    recordedExists: Boolean(recordedNode) && fs.existsSync(recordedNode),
    installedAt: typeof record?.installedAt === 'string' ? record.installedAt : '',
  };
  if (!node.versionOk) warnings.push(`Node ${node.version} is too old; herdr-cortex needs 22.13 or newer.`);
  if (!record) warnings.push(`No install record found (${REINSTALL_ADVICE}).`);
  else if (!node.recordedExists) {
    warnings.push(`The Node path recorded at install time does not exist: ${recordedNode} (${REINSTALL_ADVICE}).`);
  }

  // Registrations
  const claudeHooks = checkClaudeHooks({ homeDir: resolvedHome, repoRoot: resolvedRoot });
  if (!claudeHooks.readable) {
    warnings.push(`Claude Code settings: ${claudeHooks.settingsPath} ${claudeHooks.error}.`);
  } else {
    for (const [event, info] of Object.entries(claudeHooks.events)) {
      for (const problem of info.problems) {
        warnings.push(`Claude Code hook ${event}: ${problem.message} (${REINSTALL_ADVICE}).`);
      }
    }
  }

  const claudeMcp = checkClaudeMcpRegistration({ homeDir: resolvedHome, repoRoot: resolvedRoot });
  if (!claudeMcp.readable) {
    warnings.push(`Claude Code MCP: ${claudeMcp.configPath} ${claudeMcp.error}.`);
  } else if (!claudeMcp.registered) {
    warnings.push(
      `Claude Code MCP: no server named "${MCP_SERVER_KEY}" in ${claudeMcp.configPath}`
      + `${claudeMcp.legacyRegistered ? ' (only the old name "cortex")' : ''}. `
      + `Close every Claude Code window, then ${REINSTALL_ADVICE}.`,
    );
  } else if (!claudeMcp.ours) {
    warnings.push(`Claude Code MCP: the server named "${MCP_SERVER_KEY}" does not start herdr-cortex (${claudeMcp.nodePath} ${claudeMcp.scriptPath}).`);
  } else {
    if (!path.isAbsolute(claudeMcp.nodePath)) {
      warnings.push(`Claude Code MCP: the server is started as "${claudeMcp.nodePath}" by name, which only works while node is on PATH (${REINSTALL_ADVICE}).`);
    } else if (!claudeMcp.nodeExists) {
      warnings.push(`Claude Code MCP: the recorded Node path does not exist: ${claudeMcp.nodePath} (${REINSTALL_ADVICE}).`);
    }
    if (!claudeMcp.scriptExists) {
      warnings.push(`Claude Code MCP: the server script does not exist: ${claudeMcp.scriptPath} (${REINSTALL_ADVICE}).`);
    } else if (!claudeMcp.thisRepo) {
      warnings.push(`Claude Code MCP: the server runs from another folder: ${claudeMcp.scriptPath}.`);
    }
    if (claudeMcp.legacyRegistered) {
      warnings.push(`Claude Code MCP: the old entry "cortex" is still registered next to "${MCP_SERVER_KEY}" (${REINSTALL_ADVICE}).`);
    }
  }

  const antigravity = checkAntigravity({ homeDir: resolvedHome, repoRoot: resolvedRoot, env });
  if (antigravity.present) {
    if (!antigravity.readable) warnings.push(`Antigravity hooks: ${antigravity.hooksPath} ${antigravity.error}.`);
    for (const [event, info] of Object.entries(antigravity.events)) {
      for (const problem of info.problems) {
        warnings.push(`Antigravity hook ${event}: ${problem.message} (${REINSTALL_ADVICE}).`);
      }
    }
    if (antigravity.mcp.state !== 'ok') {
      warnings.push(`Antigravity MCP: ${antigravity.mcp.state.replace(/_/g, ' ')} in ${antigravity.mcp.path} (${REINSTALL_ADVICE}).`);
    }
  }

  // This folder, configuration, embedding
  const { config, globalConfig } = withoutConsoleWarnings(() => ({
    config: loadConfig({ projectDir: folder, globalDir: resolvedGlobal }),
    globalConfig: loadConfig({ globalDir: resolvedGlobal }),
  }));
  const trust = describeProjectTrust(folder, { globalDir: resolvedGlobal });
  const enabled = isProjectEnabled(folder, config);
  const project = {
    path: folder,
    approved: trust.approved,
    approvedAt: trust.approvedAt,
    hasMemoryDir: trust.hasMemoryDir,
    enabled,
    rule: describeEnabledRule(config, enabled),
    headCoreEnabled: config.headCoreEnabled !== false,
    hookBudget: config.hookBudget,
  };

  // Approvals: the whole list, and what in it was never confirmed in the dialog (or vanished without it)
  const approvalsChange = describeApprovalsChange({ globalDir: resolvedGlobal });
  const approvals = {
    count: listTrustedProjects({ globalDir: resolvedGlobal }).length,
    changed: approvalsChange.changed,
    added: approvalsChange.added,
    removed: approvalsChange.removed,
  };
  if (approvals.changed) {
    warnings.push(formatApprovalsChangedWarning(approvalsChange).replace(/^\[herdr-cortex\] WARNING: /, 'Approvals: '));
  }

  const store = new CortexStore({ projectDir: folder, globalDir: resolvedGlobal, config, globalConfig, disableVec: true });
  let tiers;
  let embedding;
  try {
    tiers = withoutConsoleWarnings(() => [inspectTier(store, 'project'), inspectTier(store, 'global')]);
    embedding = describeEmbeddingStatus(config, { env, globalConfig, store });
  } finally {
    store.close();
  }
  for (const tier of tiers) {
    if (tier.duplicates.length > 0) {
      const shown = tier.duplicates.slice(0, 5).map((dup) => `${dup.id} (${dup.path}, kept ${dup.keptPath})`).join('; ');
      warnings.push(`${tier.scope} memory: ${tier.duplicates.length} document(s) skipped because their id is already used: ${shown}.`);
    }
    if (tier.deferred && tier.deferred.count > 0) {
      const shown = tier.deferred.files.slice(0, 5).map((file) => `${file.path} (${file.reason})`).join('; ');
      warnings.push(`${tier.scope} memory: ${tier.deferred.count} document(s) are not indexed yet: ${shown}.`);
    }
    if (tier.syncError) warnings.push(`${tier.scope} memory: the index could not be updated (${tier.syncError}).`);
  }

  const configProblems = [...new Set([
    ...getConfigProblems(config).map((problem) => problem.message),
    ...getConfigProblems(globalConfig).map((problem) => problem.message),
  ])];
  const globalConfigPath = path.join(resolvedGlobal, 'config.json');
  if (fs.existsSync(globalConfigPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8').replace(/^﻿/, ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('it must contain a JSON object');
    } catch (err) {
      configProblems.push(`${globalConfigPath} is ignored: ${err.message}`);
    }
  }
  // The embedding lines repeat the embedding problems; non-embedding config problems belong under Configuration.
  const nonEmbeddingMessages = new Set([
    ...getConfigProblems(config).filter((problem) => problem.code === 'invalid_work_size').map((problem) => problem.message),
    ...getConfigProblems(globalConfig).filter((problem) => problem.code === 'invalid_work_size').map((problem) => problem.message),
  ]);
  const embeddingLines = formatEmbeddingStatus(embedding);
  const embeddingProblemLines = embeddingLines.filter(
    (line) => /^embedding config problem/.test(line) && ![...nonEmbeddingMessages].some((msg) => line.includes(msg)),
  );
  for (const line of embeddingProblemLines) warnings.push(line.replace(/^embedding config problem/, 'Embedding configuration'));
  for (const message of configProblems) {
    if (!embeddingProblemLines.some((line) => line.includes(message))) warnings.push(`Configuration: ${message}`);
  }

  // Relay inbox (global store)
  const terminalId = String(env.HC_TERMINAL_ID || '').trim();
  const relay = { terminalId: '', inbox: null, others: [], inboxRoot: getInboxRootDir(resolvedGlobal) };
  if (terminalId && isValidTerminalId(terminalId)) {
    relay.terminalId = terminalId;
    relay.inbox = inspectInbox(terminalId, resolvedGlobal);
  } else {
    relay.others = inspectAllInboxes(resolvedGlobal);
  }

  // Work size (current tab in this folder, or recorded ancestor folder containing `folder`)
  const validTabId = terminalId && isValidTerminalId(terminalId) ? terminalId : '';
  const activeWorkState = validTabId
    ? readWorkSizeState(resolvedGlobal, tabWorkSizeScope(validTabId), { cwd: folder })
    : null;
  const wsConfigForFolder = activeWorkState && projectPathKey(activeWorkState.cwd) !== projectPathKey(resolveProjectRoot(folder))
    ? withoutConsoleWarnings(() => loadConfig({ projectDir: activeWorkState.cwd, globalDir: resolvedGlobal }))
    : config;
  const workSizeCfg = resolveWorkSizeConfig(wsConfigForFolder);
  const workSize = {
    enabled: workSizeCfg.enabled,
    maxFilesPerWindow: workSizeCfg.maxFilesPerWindow,
    maxCharsPerFile: workSizeCfg.maxCharsPerFile,
    terminalId: validTabId,
    size: activeWorkState ? activeWorkState.size : 'S',
    filesInWindow: activeWorkState ? Object.keys(activeWorkState.files).length : 0,
    escalatedAt: activeWorkState?.escalatedAt || null,
    reviewAccepted: activeWorkState ? activeWorkState.reviewAccepted : false,
    memorySaved: activeWorkState ? activeWorkState.memorySaved : false,
  };

  return {
    repoRoot: resolvedRoot,
    homeDir: resolvedHome,
    globalDir: resolvedGlobal,
    globalDirExists: fs.existsSync(resolvedGlobal),
    node,
    sqliteVec: await checkSqliteVec(resolvedRoot),
    claudeHooks,
    claudeMcp,
    antigravity,
    project,
    approvals,
    embedding,
    embeddingLines: embeddingLines.filter((line) => !/^embedding config problem/.test(line)),
    tiers,
    relay,
    workSize,
    configProblems,
    warnings,
  };
}

function label(name) {
  return `${name.padEnd(13)}: `;
}

function formatEvents(events) {
  return Object.entries(events).map(([event, info]) => `${event}=${info.state}`).join(' ');
}

function formatTier(tier) {
  const head = `${tier.scope.padEnd(7)}`;
  if (!tier.opened) return `${head} not read (${tier.reason})`;
  const docs = tier.docs || { total: 0, ready: 0, pending: 0, error: 0 };
  const deferred = tier.deferred?.count || 0;
  const caughtUp = tier.deferredBefore > deferred ? ` (${tier.deferredBefore - deferred} indexed by this check)` : '';
  return `${head} docs=${docs.total} (embedded ${docs.ready}, pending ${docs.pending}, error ${docs.error})`
    + ` | not indexed=${deferred}${caughtUp} | duplicate ids=${tier.duplicates.length}`;
}

/** Render `collectStatus()` output as terminal lines (plain ASCII apart from paths and document ids). */
export function formatStatus(status) {
  const lines = ['=== herdr-cortex status ==='];
  lines.push(`${label('Repo')}${status.repoRoot}`);
  lines.push(`${label('Global store')}${status.globalDir}${status.globalDirExists ? '' : ' (does not exist yet)'}`);

  const node = status.node;
  lines.push(`${label('Node')}${node.version} ${node.versionOk ? 'OK' : 'TOO OLD (need >= 22.13)'} | ${node.running}`);
  if (node.recorded) {
    const same = node.recorded.toLowerCase() === node.running.toLowerCase();
    lines.push(`${label('  recorded')}${same ? 'same path' : node.recorded} (${node.recordedExists ? 'exists' : 'MISSING'})`);
  } else {
    lines.push(`${label('  recorded')}none (no install record)`);
  }
  lines.push(`${label('sqlite-vec')}${status.sqliteVec}`);

  lines.push(`${label('Claude hooks')}${status.claudeHooks.readable ? formatEvents(status.claudeHooks.events) : 'settings.json unreadable'}`);
  const mcp = status.claudeMcp;
  let mcpText;
  if (!mcp.readable) mcpText = '.claude.json unreadable';
  else if (!mcp.registered) mcpText = `"${MCP_SERVER_KEY}" NOT registered`;
  else if (!mcp.ours) mcpText = `"${MCP_SERVER_KEY}" is registered, but it is not this tool`;
  else {
    const nodeState = !path.isAbsolute(mcp.nodePath) ? 'by name' : (mcp.nodeExists ? 'ok' : 'MISSING');
    mcpText = `"${MCP_SERVER_KEY}" registered (node ${nodeState}, server.mjs ${mcp.scriptExists ? 'ok' : 'MISSING'})`;
  }
  lines.push(`${label('Claude MCP')}${mcpText}`);

  // Present or not is decided the way the installer decides it; the line names the sign that was found.
  const agy = status.antigravity;
  const agySign = agy.detectedBy === 'path' ? '"agy" on PATH' : '~/.gemini folder';
  lines.push(`${label('Antigravity')}${agy.present
    ? `${agy.readable ? formatEvents(agy.events) : 'hooks.json unreadable'} | MCP=${agy.mcp.state} | found by: ${agySign}`
    : 'not found (no "agy" on PATH and no ~/.gemini folder)'}`);

  const project = status.project;
  lines.push(`${label('This folder')}${project.path}`);
  lines.push(`${label('  approved')}${project.approved
    ? `yes${project.approvedAt ? ` (since ${project.approvedAt})` : ''}`
    : `no (approve with: ${TRUST_COMMAND} approve)`}`);
  lines.push(`${label('  enabled')}${project.enabled ? 'yes' : 'no'} (${project.rule}) | headCore=${project.headCoreEnabled ? 'on' : 'off'} | hookBudget=${project.hookBudget}`);

  const approvals = status.approvals;
  if (approvals) {
    lines.push(`${label('Approvals')}${approvals.count} folder(s) approved | ${approvals.changed
      ? `CHANGED without the confirmation dialog: ${approvals.added.length} added, ${approvals.removed.length} removed (accept with: ${ACKNOWLEDGE_COMMAND})`
      : 'all confirmed in the dialog'}`);
    for (const entry of approvals.added) lines.push(`${label('')}added: ${entry.path}${entry.approvedAt ? ` (${entry.approvedAt})` : ''}`);
    for (const entry of approvals.removed) lines.push(`${label('')}removed: ${entry.path}${entry.approvedAt ? ` (${entry.approvedAt})` : ''}`);
  }

  for (const line of status.embeddingLines) {
    lines.push(`${label('Embedding')}${line.replace(/^embedding:?\s*/, '')}`);
  }
  for (const tier of status.tiers) lines.push(`${label('Index')}${formatTier(tier)}`);

  const relay = status.relay;
  const formatInbox = (inbox) => `pending=${inbox.pending}${inbox.announced > 0 ? ` (${inbox.announced} announced, waiting for ack)` : ''}`
    + `, held=${inbox.held}, broken=${inbox.broken}`;
  if (relay.inbox) {
    lines.push(`${label('Relay inbox')}tab ${relay.terminalId}: ${formatInbox(relay.inbox)}`);
  } else if (relay.others.length > 0) {
    lines.push(`${label('Relay inbox')}not in a Herdr tab (HC_TERMINAL_ID is not set); inboxes with messages:`);
    for (const inbox of relay.others) lines.push(`${label('')}tab ${inbox.terminalId}: ${formatInbox(inbox)}`);
  } else {
    lines.push(`${label('Relay inbox')}not in a Herdr tab (HC_TERMINAL_ID is not set); no inbox holds messages`);
  }

  const ws = status.workSize;
  if (ws) {
    if (!ws.enabled) {
      lines.push(`${label('Work size')}off (workSize.enabled is false)`);
    } else if (!ws.terminalId) {
      lines.push(`${label('Work size')}not in a Herdr tab (HC_TERMINAL_ID is not set); limit=${ws.maxFilesPerWindow} file(s), ${ws.maxCharsPerFile} chars`);
    } else if (ws.size === 'L') {
      const pending = [
        ...(!ws.reviewAccepted ? ['review ACCEPT'] : []),
        ...(!ws.memorySaved ? ['memory_save'] : []),
      ].join(', ') || 'none';
      lines.push(`${label('Work size')}tab ${ws.terminalId}: L (files in window=${ws.filesInWindow}, waiting for: ${pending})`);
    } else {
      lines.push(`${label('Work size')}tab ${ws.terminalId}: S (files in window=${ws.filesInWindow}, limit=${ws.maxFilesPerWindow} file(s), ${ws.maxCharsPerFile} chars)`);
    }
  }

  lines.push(`${label('Config')}${status.configProblems.length === 0 ? 'no problems' : `${status.configProblems.length} problem(s), see below`}`);

  if (status.warnings.length === 0) {
    lines.push(`${label('Result')}everything checked is in order`);
  } else {
    lines.push(`Needs attention (${status.warnings.length}):`);
    for (const warning of status.warnings) lines.push(`  ! ${warning}`);
  }
  return lines;
}

function parseArgs(argv) {
  const out = { cwd: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd' && argv[i + 1]) out.cwd = path.resolve(argv[++i]);
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const status = await collectStatus({ cwd: args.cwd });
  if (args.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  else process.stdout.write(`${formatStatus(status).join('\n')}\n`);
}
