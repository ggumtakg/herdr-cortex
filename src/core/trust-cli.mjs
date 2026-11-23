#!/usr/bin/env node
import path from 'node:path';
import { isMainModule } from './config.mjs';
import {
  PROJECT_APPROVAL_INSTRUCTION,
  TRUST_COMMAND,
  approveProject,
  describeProjectTrust,
  getTrustedProjectsPath,
  listTrustedProjects,
  revokeProject,
} from './trust.mjs';

export const TRUST_CLI_USAGE = [
  `Usage: ${TRUST_COMMAND} <command> [folder] [--json]`,
  '',
  '  approve [folder]   allow herdr-cortex to read and write the .memory/ of exactly this folder',
  '  revoke  [folder]   withdraw that approval',
  '  status  [folder]   show whether the folder is approved (exit code 0 = approved, 1 = not approved)',
  '  list               show every approved folder',
  '',
  'The folder defaults to the current directory. An approval covers that one folder only,',
  'never its subfolders or its parent.',
  'Without the shell command: node <herdr-cortex>/src/core/trust-cli.mjs <command> [folder]',
].join('\n');

function parseArgs(argv) {
  const out = { command: '', dir: '', json: false, globalDir: undefined, help: false, extra: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--global' && argv[i + 1]) out.globalDir = path.resolve(argv[++i]);
    else positional.push(arg);
  }
  out.command = String(positional[0] || '').trim().toLowerCase();
  out.dir = positional[1] || '';
  out.extra = positional.slice(2);
  return out;
}

/**
 * Command line for project approvals: approve [dir], revoke [dir], status [dir], list.
 * Options: --json (machine-readable output), --global <dir> (global store location, for tests).
 * Returns the process exit code: 0 success (for `status`: approved), 1 `status` of an unapproved folder,
 * 2 usage or runtime error.
 */
export function runTrustCli(
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    globalDir,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const opts = parseArgs(argv);
  const effectiveGlobalDir = opts.globalDir || globalDir;
  const print = (text) => stdout.write(`${text}\n`);
  const printJson = (value) => stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  if (opts.help || !opts.command) {
    (opts.help ? stdout : stderr).write(`${TRUST_CLI_USAGE}\n`);
    return opts.help ? 0 : 2;
  }
  if (opts.extra.length > 0) {
    stderr.write(`Unexpected argument "${opts.extra[0]}".\n${TRUST_CLI_USAGE}\n`);
    return 2;
  }

  const targetDir = opts.dir ? path.resolve(cwd, opts.dir) : path.resolve(cwd);

  try {
    switch (opts.command) {
      case 'approve': {
        const res = approveProject(targetDir, { globalDir: effectiveGlobalDir });
        if (opts.json) {
          printJson({ action: 'approve', ...res });
        } else {
          print(`${res.alreadyApproved ? 'Already approved' : 'Approved'}: ${res.path}`);
          print('herdr-cortex now reads and writes the .memory/ of this folder (not of its subfolders).');
          print('Memory tools use it right away; the memory overview is injected from the next session start.');
        }
        return 0;
      }
      case 'revoke': {
        const res = revokeProject(targetDir, { globalDir: effectiveGlobalDir });
        if (opts.json) {
          printJson({ action: 'revoke', ...res });
        } else {
          print(`${res.revoked ? 'Revoked' : 'Was not approved'}: ${res.path}`);
        }
        return 0;
      }
      case 'status': {
        const res = describeProjectTrust(targetDir, { globalDir: effectiveGlobalDir });
        if (opts.json) {
          printJson({ action: 'status', ...res });
        } else if (res.approved) {
          print(`Approved: ${res.path}${res.approvedAt ? ` (since ${res.approvedAt})` : ''}`);
        } else {
          print(`Not approved: ${res.path}`);
          print(res.hasMemoryDir
            ? 'It contains a .memory/ directory that herdr-cortex does not read or write.'
            : 'It has no .memory/ directory yet; herdr-cortex will not create one until the folder is approved.');
          print(PROJECT_APPROVAL_INSTRUCTION);
        }
        return res.approved ? 0 : 1;
      }
      case 'list': {
        if (opts.dir) {
          stderr.write(`"list" takes no folder argument.\n${TRUST_CLI_USAGE}\n`);
          return 2;
        }
        const projects = listTrustedProjects({ globalDir: effectiveGlobalDir });
        if (opts.json) {
          printJson({ action: 'list', filePath: getTrustedProjectsPath(effectiveGlobalDir), projects });
        } else if (projects.length === 0) {
          print('No approved project folders.');
        } else {
          for (const entry of projects) {
            print(`${entry.approvedAt || '(no date)'}  ${entry.path}`);
          }
        }
        return 0;
      }
      default:
        stderr.write(`Unknown command "${opts.command}".\n${TRUST_CLI_USAGE}\n`);
        return 2;
    }
  } catch (err) {
    stderr.write(`${err?.message || err}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  // `npm run trust` starts scripts in the package folder; INIT_CWD is the folder the user ran npm from.
  const viaNpm = Boolean(process.env.npm_lifecycle_event) && Boolean(process.env.INIT_CWD);
  process.exitCode = runTrustCli(process.argv.slice(2), {
    cwd: viaNpm ? process.env.INIT_CWD : process.cwd(),
  });
}
