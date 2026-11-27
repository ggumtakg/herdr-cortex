#!/usr/bin/env node
/**
 * User command line behind `cortex-work`: inspect, release, or reset tab work-size (S/L) state.
 * Usage:
 *   cortex-work status  [--tab <탭 ID>] [--json]
 *   cortex-work release [--tab <탭 ID>] [--all] [--json]
 *   cortex-work reset   [--tab <탭 ID>] [--all] [--json]
 */
import path from 'node:path';
import { isMainModule, projectPathKey, resolveGlobalDir } from '../src/core/config.mjs';
import { isValidTerminalId } from '../src/revive/tracker.mjs';
import {
  WORK_SIZE_COMMAND,
  WORK_SIZE_DELEGATION_TTL_MS,
  getTabDelegation,
  getWorkSizeStatePath,
  listTabWorkSizeStates,
  readWorkSizeScopeState,
  releaseWorkSizeForTab,
  resetWorkSizeWindowForTab,
  resolveWorkSizeProjectRoot,
  tabWorkSizeScope,
} from '../src/hooks/work-size.mjs';

export const WORK_EXIT_OK = 0;
export const WORK_EXIT_ERROR = 2;

export const WORK_CLI_USAGE = [
  `Usage: ${WORK_SIZE_COMMAND} <status|release|reset> [--tab <tabId>] [--all] [--json]`,
  '',
  '  status  [--tab <tabId>]          show per-folder work-size state (S or L) of the tab',
  '  release [--tab <tabId>] [--all]  end L and return the current folder (or --all folders) to S',
  '  reset   [--tab <tabId>] [--all]  keep size (S or L) and clear cumulative file counts for the current folder (or --all)',
  '',
  'The tab defaults to HC_TERMINAL_ID of the current shell, and release/reset default to the current shell folder.',
].join('\n');

function getEnvCaseInsensitive(env, name) {
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(env || {})) {
    if (key.toLowerCase() === lower && typeof val === 'string') return val;
  }
  return '';
}

function parseArgs(argv) {
  const out = {
    command: '',
    tab: undefined,
    all: false,
    json: false,
    globalDir: undefined,
    help: false,
    error: '',
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i] ?? '');
    if (raw === '--json') {
      out.json = true;
    } else if (raw === '--all') {
      out.all = true;
    } else if (raw === '--help' || raw === '-h') {
      out.help = true;
    } else if (raw === '--tab') {
      if (i + 1 >= argv.length) {
        out.error = 'Option --tab requires a tab ID.';
        return out;
      }
      out.tab = String(argv[++i] ?? '');
    } else if (raw.startsWith('--tab=')) {
      out.tab = raw.slice('--tab='.length);
    } else if (raw === '--global') {
      if (i + 1 >= argv.length) {
        out.error = 'Option --global requires a directory path.';
        return out;
      }
      out.globalDir = path.resolve(String(argv[++i] ?? ''));
    } else if (raw.startsWith('--global=')) {
      const dirVal = raw.slice('--global='.length);
      if (!dirVal.trim()) {
        out.error = 'Option --global requires a directory path.';
        return out;
      }
      out.globalDir = path.resolve(dirVal);
    } else if (raw.startsWith('-')) {
      out.error = `Unknown option "${raw}".`;
      return out;
    } else {
      positional.push(raw);
    }
  }

  if (positional.length > 1) {
    out.error = `Unexpected argument "${positional[1]}".`;
    return out;
  }
  out.command = String(positional[0] || '').trim().toLowerCase();
  return out;
}

function sortedFolderEntries(scopeState, currentKey) {
  if (!scopeState || !scopeState.projects) return [];
  return Object.values(scopeState.projects).sort((a, b) => {
    const aCurrent = a.cwdKey === currentKey ? 0 : 1;
    const bCurrent = b.cwdKey === currentKey ? 0 : 1;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    return a.cwd.localeCompare(b.cwd);
  });
}

function formatUnsavedSummary(entry) {
  const unsavedCount = entry?.unsavedFiles?.length || 0;
  const committed = Boolean(entry?.unsavedCommitted);
  if (unsavedCount === 0 && !committed) return 'no';
  return `yes (edited files: ${unsavedCount}, committed: ${committed ? 'yes' : 'no'}${entry?.unsavedReminded ? ', reminded: yes' : ''})`;
}

function formatFailuresSummary(failedRetries) {
  const items = Object.entries(failedRetries || {});
  if (items.length === 0) return 'none';
  return items.map(([name, count]) => `${name} (${count})`).join(', ');
}

function formatFolderSectionLines(entry, { isCurrent = false, indent = '' } = {}) {
  const lines = [];
  const marker = isCurrent ? ' (current)' : '';
  lines.push(`${indent}Folder    : ${entry.cwd}${marker}`);
  const fileEntries = Object.entries(entry.files || {});
  if (entry.size === 'L') {
    lines.push(`${indent}Work size : L${entry.escalatedAt ? ` (since ${entry.escalatedAt})` : ''}`);
    if (entry.escalationReason?.summary) {
      lines.push(`${indent}Reason    : ${entry.escalationReason.summary}`);
    }
    const remaining = [
      ...(!entry.reviewAccepted ? ['review ACCEPT'] : []),
      ...(!entry.memorySaved ? ['memory_save'] : []),
    ];
    lines.push(
      `${indent}Completion: review ACCEPT=${entry.reviewAccepted ? 'yes' : 'no'}, `
      + `memory_save=${entry.memorySaved ? 'yes' : 'no'}`
      + `${remaining.length > 0 ? ` (remaining: ${remaining.join(', ')})` : ''}`,
    );
  } else {
    lines.push(`${indent}Work size : S (edited files: ${fileEntries.length})`);
  }

  if (fileEntries.length === 0) {
    lines.push(`${indent}Files     : none`);
  } else {
    lines.push(`${indent}Files     : ${fileEntries.map(([name, chars]) => `${name} (${chars} chars)`).join(', ')}`);
  }
  lines.push(`${indent}Failures  : ${formatFailuresSummary(entry.failedRetries)}`);
  lines.push(`${indent}Unsaved   : ${formatUnsavedSummary(entry)}`);
  lines.push(
    `${indent}Counters  : prompts=${entry.promptTurns || 0}, turn reads=${entry.turnReads || 0}`
    + `${entry.turnReadNotified ? ' (notice sent)' : ''}`,
  );
  return lines;
}

function formatRemainingDuration(ms) {
  const totalMinutes = Math.max(0, Math.ceil(Number(ms || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

function buildDelegationPayload(delegated, nowMs) {
  if (!delegated) return null;
  const elapsed = Math.max(0, nowMs - delegated.delegatedAtMs);
  const remainingMs = Math.max(0, WORK_SIZE_DELEGATION_TTL_MS - elapsed);
  return {
    fromTerminalId: delegated.fromTerminalId || null,
    delegatedAt: delegated.delegatedAt,
    remainingMs,
    remainingText: formatRemainingDuration(remainingMs),
  };
}

function formatTabStatusLines(terminalId, entries, currentRoot, currentKey, filePath, delegation = null) {
  const lines = [`Tab       : ${terminalId}`];
  if (delegation) {
    lines.push(
      `Delegated : yes (from ${delegation.fromTerminalId || 'peer'}, `
      + `since ${delegation.delegatedAt}, remaining ${delegation.remainingText})`,
    );
  }
  if (entries.length === 0) {
    lines.push(`Folder    : ${currentRoot} (current)`);
    lines.push('Work size : S (edited files: 0)');
    lines.push('Failures  : none');
    lines.push('Unsaved   : no');
    lines.push('Counters  : prompts=0, turn reads=0');
    if (delegation) {
      lines.push(`State file: ${filePath}`);
    }
    return lines;
  }

  const hasCurrent = entries.some((entry) => entry.cwdKey === currentKey);
  if (!hasCurrent) {
    lines.push(`Current   : ${currentRoot} -> S (edited files: 0, unsaved: no, prompts: 0, turn reads: 0)`);
  }

  const indent = entries.length > 1 ? '  ' : '';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entries.length > 1 && i > 0) lines.push('');
    for (const line of formatFolderSectionLines(entry, { isCurrent: entry.cwdKey === currentKey, indent })) {
      lines.push(line);
    }
  }
  lines.push(`State file: ${filePath}`);
  return lines;
}

export function runWorkCli(
  argv = process.argv.slice(2),
  {
    env = process.env,
    cwd = process.cwd(),
    globalDir,
    stdout = process.stdout,
    stderr = process.stderr,
    now = new Date(),
  } = {},
) {
  const opts = parseArgs(argv);
  const print = (text) => stdout.write(`${text}\n`);
  const printJson = (value) => stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  if (opts.error) {
    stderr.write(`${opts.error}\n${WORK_CLI_USAGE}\n`);
    return WORK_EXIT_ERROR;
  }
  if (opts.help || !opts.command) {
    (opts.help ? stdout : stderr).write(`${WORK_CLI_USAGE}\n`);
    return opts.help ? WORK_EXIT_OK : WORK_EXIT_ERROR;
  }
  if (opts.command !== 'status' && opts.command !== 'release' && opts.command !== 'reset') {
    stderr.write(`Unknown command "${opts.command}".\n${WORK_CLI_USAGE}\n`);
    return WORK_EXIT_ERROR;
  }

  const effectiveGlobalDir = resolveGlobalDir({ globalDir: opts.globalDir || globalDir, env });
  const effectiveCwd = path.resolve(cwd || process.cwd());
  const rawTab = opts.tab !== undefined ? opts.tab : getEnvCaseInsensitive(env, 'HC_TERMINAL_ID');
  const trimmedTab = typeof rawTab === 'string' ? rawTab.trim() : '';

  if (opts.tab !== undefined && !isValidTerminalId(trimmedTab)) {
    stderr.write(`Invalid tab ID "${opts.tab}".\n`);
    return WORK_EXIT_ERROR;
  }

  const nowMs = now instanceof Date ? now.getTime() : (Number(typeof now === 'function' ? now() : now) || Date.now());

  if (!trimmedTab) {
    if (opts.command === 'status') {
      const tabs = listTabWorkSizeStates(effectiveGlobalDir, { now: nowMs });
      if (opts.json) {
        printJson({
          action: 'status',
          terminalId: null,
          tabs: tabs.map((st) => {
            const delegation = buildDelegationPayload(st.delegated, nowMs);
            return {
              terminalId: st.scopeId,
              delegated: Boolean(delegation),
              delegation,
              projects: Object.values(st.projects).map((entry) => ({
                cwd: entry.cwd,
                size: entry.size,
                escalatedAt: entry.escalatedAt,
                escalationReason: entry.escalationReason,
                files: entry.files,
                failedRetries: entry.failedRetries,
                unsaved: entry.unsavedFiles.length > 0 || entry.unsavedCommitted,
                unsavedFiles: entry.unsavedFiles,
                unsavedCommitted: entry.unsavedCommitted,
                unsavedReminded: entry.unsavedReminded,
                promptTurns: entry.promptTurns,
                turnReads: entry.turnReads,
                turnReadNotified: entry.turnReadNotified,
                reviewAccepted: entry.reviewAccepted,
                memorySaved: entry.memorySaved,
              })),
            };
          }),
        });
      } else if (tabs.length === 0) {
        print('Not in a Herdr tab (HC_TERMINAL_ID is not set); no recorded tab work-size state. Pass --tab <tabId>.');
      } else {
        print('Not in a Herdr tab (HC_TERMINAL_ID is not set); recorded tabs:');
        for (const st of tabs) {
          const delegation = buildDelegationPayload(st.delegated, nowMs);
          const delSuffix = delegation
            ? ` [delegated from ${delegation.fromTerminalId || 'peer'}, remaining ${delegation.remainingText}]`
            : '';
          const folderEntries = Object.values(st.projects);
          if (folderEntries.length === 0 && delegation) {
            print(`  ${st.scopeId}: delegated from ${delegation.fromTerminalId || 'peer'} (remaining ${delegation.remainingText})`);
          }
          for (const entry of folderEntries) {
            print(`  ${st.scopeId}: ${entry.size} (${Object.keys(entry.files).length} file(s)) in ${entry.cwd}${delSuffix}`);
          }
        }
      }
      return WORK_EXIT_OK;
    }

    stderr.write(`No tab specified: HC_TERMINAL_ID is not set. Pass --tab <tabId> to "${WORK_SIZE_COMMAND} ${opts.command}".\n`);
    return WORK_EXIT_ERROR;
  }

  if (!isValidTerminalId(trimmedTab)) {
    stderr.write(`Invalid HC_TERMINAL_ID "${trimmedTab}". Pass a valid --tab <tabId>.\n`);
    return WORK_EXIT_ERROR;
  }

  try {
    if (opts.command === 'status') {
      const scope = tabWorkSizeScope(trimmedTab);
      const filePath = getWorkSizeStatePath(effectiveGlobalDir, scope);
      const scopeState = readWorkSizeScopeState(effectiveGlobalDir, scope);
      const activeDelegated = getTabDelegation(scope.id, { globalDir: effectiveGlobalDir, now: nowMs });
      const delegation = activeDelegated
        ? {
            fromTerminalId: activeDelegated.fromTerminalId || null,
            delegatedAt: activeDelegated.delegatedAt,
            remainingMs: activeDelegated.remainingMs,
            remainingText: formatRemainingDuration(activeDelegated.remainingMs),
          }
        : null;
      const currentRoot = resolveWorkSizeProjectRoot({ cwd: effectiveCwd, scopeState });
      const currentKey = projectPathKey(currentRoot);
      const entries = sortedFolderEntries(scopeState, currentKey);
      const currentEntry = scopeState?.projects?.[currentKey] || null;

      if (opts.json) {
        printJson({
          action: 'status',
          terminalId: scope.id,
          filePath,
          exists: entries.length > 0 || Boolean(delegation),
          delegated: Boolean(delegation),
          delegation,
          currentCwd: currentRoot,
          size: currentEntry ? currentEntry.size : 'S',
          cwd: currentEntry ? currentEntry.cwd : currentRoot,
          escalatedAt: currentEntry ? currentEntry.escalatedAt : null,
          escalationReason: currentEntry ? currentEntry.escalationReason : null,
          files: currentEntry ? currentEntry.files : {},
          failedRetries: currentEntry ? currentEntry.failedRetries : {},
          unsaved: Boolean(currentEntry && (currentEntry.unsavedFiles.length > 0 || currentEntry.unsavedCommitted)),
          unsavedFiles: currentEntry ? currentEntry.unsavedFiles : [],
          unsavedCommitted: currentEntry ? currentEntry.unsavedCommitted : false,
          unsavedReminded: currentEntry ? currentEntry.unsavedReminded : false,
          promptTurns: currentEntry ? currentEntry.promptTurns : 0,
          turnReads: currentEntry ? currentEntry.turnReads : 0,
          turnReadNotified: currentEntry ? currentEntry.turnReadNotified : false,
          reviewAccepted: currentEntry ? currentEntry.reviewAccepted : false,
          reviewAcceptedAt: currentEntry ? currentEntry.reviewAcceptedAt : null,
          memorySaved: currentEntry ? currentEntry.memorySaved : false,
          memorySavedAt: currentEntry ? currentEntry.memorySavedAt : null,
          projects: entries.map((entry) => ({
            cwd: entry.cwd,
            cwdKey: entry.cwdKey,
            current: entry.cwdKey === currentKey,
            size: entry.size,
            escalatedAt: entry.escalatedAt,
            escalationReason: entry.escalationReason,
            files: entry.files,
            failedRetries: entry.failedRetries,
            unsaved: entry.unsavedFiles.length > 0 || entry.unsavedCommitted,
            unsavedFiles: entry.unsavedFiles,
            unsavedCommitted: entry.unsavedCommitted,
            unsavedReminded: entry.unsavedReminded,
            promptTurns: entry.promptTurns,
            turnReads: entry.turnReads,
            turnReadNotified: entry.turnReadNotified,
            reviewAccepted: entry.reviewAccepted,
            reviewAcceptedAt: entry.reviewAcceptedAt,
            memorySaved: entry.memorySaved,
            memorySavedAt: entry.memorySavedAt,
            completedNoticePending: entry.completedNoticePending,
          })),
        });
      } else {
        for (const line of formatTabStatusLines(scope.id, entries, currentRoot, currentKey, filePath, delegation)) {
          print(line);
        }
      }
      return WORK_EXIT_OK;
    }

    if (opts.command === 'release') {
      const res = releaseWorkSizeForTab(trimmedTab, {
        globalDir: effectiveGlobalDir,
        cwd: effectiveCwd,
        all: opts.all,
        now,
      });
      if (opts.json) {
        printJson({
          action: 'release',
          terminalId: res.terminalId,
          filePath: res.filePath,
          all: res.all,
          cwd: res.cwd,
          releasedFolders: res.releasedFolders,
          releasedDelegation: Boolean(res.releasedDelegation),
          otherLFolders: res.otherLFolders || [],
          previousSize: res.previousSize,
          size: res.size,
          changed: res.changed,
        });
      } else if (opts.all) {
        if (res.changed) {
          const delNote = res.releasedDelegation ? ' (relay delegation cleared)' : '';
          print(`Released all ${res.releasedFolders.length} folder(s) in tab ${res.terminalId} -> S${delNote}.`);
        } else {
          print(`Tab ${res.terminalId} has no recorded folder state to release.`);
        }
      } else if (res.changed) {
        if (res.releasedFolders.length === 0 && res.releasedDelegation) {
          print(`Released relay delegation for tab ${res.terminalId}.`);
        } else {
          const delNote = res.releasedDelegation ? '; relay delegation cleared' : '';
          print(`Released tab ${res.terminalId} (${res.cwd}): ${res.previousSize} -> S (cumulative edits and L records cleared${delNote}).`);
        }
      } else {
        print(`Tab ${res.terminalId} (${res.cwd}) is already S with no cumulative edits.`);
        if (Array.isArray(res.otherLFolders) && res.otherLFolders.length > 0) {
          print(
            `Other folder(s) in tab ${res.terminalId} are in L: ${res.otherLFolders.join(', ')}. `
            + `Use "${WORK_SIZE_COMMAND} release --all" to release all folders in this tab.`,
          );
        }
      }
      return WORK_EXIT_OK;
    }

    const res = resetWorkSizeWindowForTab(trimmedTab, {
      globalDir: effectiveGlobalDir,
      cwd: effectiveCwd,
      all: opts.all,
      now,
    });
    if (opts.json) {
      printJson({
        action: 'reset',
        terminalId: res.terminalId,
        filePath: res.filePath,
        all: res.all,
        cwd: res.cwd,
        resetFolders: res.resetFolders,
        size: res.size,
        clearedFiles: res.clearedFiles,
        clearedFailures: res.clearedFailures || 0,
        changed: res.changed,
      });
    } else if (opts.all) {
      if (res.changed) {
        print(
          `Reset cumulative file/failure counts across ${res.resetFolders.length} folder(s) in tab ${res.terminalId} `
          + `(cleared ${res.clearedFiles} file(s), ${res.clearedFailures || 0} failure record(s)).`,
        );
      } else {
        print(`Tab ${res.terminalId} has no cumulative file counts to reset.`);
      }
    } else if (res.changed) {
      print(
        `Reset cumulative file counts for tab ${res.terminalId} `
        + `(${res.cwd}: cleared ${res.clearedFiles} file(s)`
        + `${res.clearedFailures ? `, ${res.clearedFailures} failure record(s)` : ''}; size stays ${res.size}).`,
      );
    } else {
      print(`Tab ${res.terminalId} (${res.cwd}) has no cumulative file counts to reset (size is ${res.size}).`);
    }
    return WORK_EXIT_OK;
  } catch (err) {
    stderr.write(`${err?.message || err}\n`);
    return WORK_EXIT_ERROR;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runWorkCli(process.argv.slice(2));
}
