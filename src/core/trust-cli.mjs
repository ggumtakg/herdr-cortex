#!/usr/bin/env node
import path from 'node:path';
import { REPO_ROOT, isMainModule, projectPathKey } from './config.mjs';
import { CONFIRM_DIALOG_TITLE, confirmWithUser } from './confirm.mjs';
import {
  ACKNOWLEDGE_COMMAND,
  PROJECT_APPROVAL_INSTRUCTION,
  TRUST_COMMAND,
  acknowledgeApproval,
  acknowledgeCurrentApprovals,
  acknowledgeRevocation,
  approveProject,
  describeApprovalsChange,
  describeProjectTrust,
  getAcknowledgedApprovalsPath,
  getTrustedProjectsPath,
  listTrustedProjects,
  resolveApprovalTarget,
  revokeProject,
} from './trust.mjs';

export const TRUST_CLI_USAGE = [
  `Usage: ${TRUST_COMMAND} <command> [folder] [--json]`,
  '',
  '  approve [folder]   allow herdr-cortex to read and write the .memory/ of exactly this folder;',
  '                     a confirmation dialog asks first, and only its Yes button approves',
  '  revoke  [folder]   withdraw that approval',
  '  status  [folder]   show whether the folder is approved (exit code 0 = approved, 1 = not approved)',
  '  list               show every approved folder',
  '  acknowledge        accept approvals that were changed without the dialog (asks in a dialog as well)',
  '',
  'The folder defaults to the current directory. An approval covers that one folder only,',
  'never its subfolders or its parent.',
  'Without the shell command: node <herdr-cortex>/src/core/trust-cli.mjs <command> [folder]',
].join('\n');

/** Exit codes: 0 done (for `status`: approved), 1 not approved / not confirmed, 2 usage or runtime error, or nobody could be asked. */
export const TRUST_EXIT_OK = 0;
export const TRUST_EXIT_NOT_APPROVED = 1;
export const TRUST_EXIT_ERROR = 2;

/** One line of the approval dialog on what approval means. */
export const APPROVE_DIALOG_MEANING =
  'Approval lets herdr-cortex read and write the .memory folder of exactly this folder (not its subfolders) '
  + 'and inject what it contains into agent sessions.';

const DIALOG_DECLINE_HINT = 'If you did not ask for this yourself, choose No.';

/** Most folders the `acknowledge` dialog lists per group. */
export const ACKNOWLEDGE_DIALOG_MAX_FOLDERS = 20;

/**
 * Text of the dialog that asks whether one folder may be approved. `realPath` is shown exactly as it will
 * be recorded.
 */
export function buildApproveDialogMessage(realPath) {
  return [
    'Approve this folder for herdr-cortex?',
    '',
    String(realPath),
    '',
    APPROVE_DIALOG_MEANING,
    '',
    DIALOG_DECLINE_HINT,
  ].join('\n');
}

function listForDialog(entries) {
  const lines = entries
    .slice(0, ACKNOWLEDGE_DIALOG_MAX_FOLDERS)
    .map((entry) => `  ${entry.path}${entry.approvedAt ? `  (${entry.approvedAt})` : ''}`);
  if (entries.length > ACKNOWLEDGE_DIALOG_MAX_FOLDERS) {
    lines.push(`  ... and ${entries.length - ACKNOWLEDGE_DIALOG_MAX_FOLDERS} more (see: ${TRUST_COMMAND} list)`);
  }
  return lines;
}

/**
 * Text of the dialog that asks whether approvals changed without the dialog may be accepted
 * (`change` is the result of `describeApprovalsChange`).
 */
export function buildAcknowledgeDialogMessage(change) {
  const lines = ['Accept these changes to the approved project folders of herdr-cortex?', ''];
  if (change.added.length > 0) {
    lines.push('Approved without the confirmation dialog (Yes keeps them approved):', ...listForDialog(change.added), '');
  }
  if (change.removed.length > 0) {
    lines.push('Removed without the confirmation dialog (Yes leaves them not approved):', ...listForDialog(change.removed), '');
  }
  lines.push(APPROVE_DIALOG_MEANING, '', 'If you did not make these changes yourself, choose No.');
  return lines.join('\n');
}

/**
 * The folder a command without a folder argument applies to. `npm run trust` starts scripts in the package
 * folder and passes the folder npm was run from as INIT_CWD, so INIT_CWD is used, but only when this
 * process really is the `trust` script of this package (npm_lifecycle_event is "trust" and the package is
 * this repository's). A shell that was merely started from some npm script still carries those variables;
 * there the default folder is the current directory.
 */
export function resolveTrustCliCwd({ env = process.env, cwd = process.cwd(), repoRoot = REPO_ROOT } = {}) {
  const initCwd = typeof env?.INIT_CWD === 'string' ? env.INIT_CWD.trim() : '';
  if (!initCwd || env.npm_lifecycle_event !== 'trust') return cwd;

  const packageJson = typeof env.npm_package_json === 'string' ? env.npm_package_json.trim() : '';
  if (packageJson) {
    let same = false;
    try {
      same = projectPathKey(packageJson) === projectPathKey(path.join(repoRoot, 'package.json'));
    } catch {
      same = false;
    }
    return same ? initCwd : cwd;
  }
  return env.npm_package_name === 'herdr-cortex' ? initCwd : cwd;
}

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
 * Command line for project approvals: approve [dir], revoke [dir], status [dir], list, acknowledge.
 * Options: --json (machine-readable output), --global <dir> (global store location, for tests).
 *
 * `approve` and `acknowledge` change which folders herdr-cortex trusts, so they ask a person first:
 * `confirm({ action, title, message, paths })` must return { confirmed, via, detail }. The default shows a
 * message box (see `confirm.mjs`); there is no option and no environment variable that skips it. Tests pass
 * their own `confirm`. `revoke`, `status` and `list` ask nothing; a folder that is already approved is
 * reported as such without a dialog.
 *
 * After a confirmed `approve` and after a `revoke`, that one folder is recorded in (or removed from) the
 * acknowledged list; a confirmed `acknowledge` records the whole current list (see `trust.mjs`).
 *
 * Returns the process exit code: 0 success (for `status`: approved), 1 `status` of an unapproved folder or
 * a confirmation that was answered No, 2 usage or runtime error, or nobody could be asked to confirm.
 */
export function runTrustCli(
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    globalDir,
    stdout = process.stdout,
    stderr = process.stderr,
    confirm = (request) => confirmWithUser(request),
  } = {},
) {
  const opts = parseArgs(argv);
  const effectiveGlobalDir = opts.globalDir || globalDir;
  const print = (text) => stdout.write(`${text}\n`);
  const printJson = (value) => stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  if (opts.help || !opts.command) {
    (opts.help ? stdout : stderr).write(`${TRUST_CLI_USAGE}\n`);
    return opts.help ? TRUST_EXIT_OK : TRUST_EXIT_ERROR;
  }
  if (opts.extra.length > 0) {
    stderr.write(`Unexpected argument "${opts.extra[0]}".\n${TRUST_CLI_USAGE}\n`);
    return TRUST_EXIT_ERROR;
  }

  const targetDir = opts.dir ? path.resolve(cwd, opts.dir) : path.resolve(cwd);

  // Ask a person; reports the outcome when it is not a yes and returns the exit code to end with (or 0).
  const askToConfirm = (request, { jsonBase, declinedText }) => {
    let answer;
    try {
      answer = confirm(request);
    } catch (err) {
      answer = { confirmed: false, via: 'none', detail: String(err?.message || err) };
    }
    const confirmed = answer === true || answer?.confirmed === true;
    if (confirmed) return { code: TRUST_EXIT_OK, via: answer?.via || 'dialog' };

    const via = answer?.via === 'dialog' || answer?.via === 'terminal' ? answer.via : 'none';
    const detail = typeof answer?.detail === 'string' ? answer.detail : '';
    if (via === 'none') {
      const message = `Cannot ask for confirmation: ${detail || 'no confirmation dialog could be shown'}. `
        + `Nothing was changed. Run "${TRUST_COMMAND} ${request.action}" yourself in a terminal window.`;
      if (opts.json) printJson({ ...jsonBase, confirmed: false, confirmedVia: via, reason: message });
      stderr.write(`${message}\n`);
      return { code: TRUST_EXIT_ERROR, via };
    }
    if (opts.json) printJson({ ...jsonBase, confirmed: false, confirmedVia: via, reason: detail });
    else print(`${declinedText}${detail ? ` (${detail})` : ''}. Nothing was changed.`);
    return { code: TRUST_EXIT_NOT_APPROVED, via };
  };

  try {
    switch (opts.command) {
      case 'approve': {
        const realPath = resolveApprovalTarget(targetDir);
        const before = describeProjectTrust(realPath, { globalDir: effectiveGlobalDir });
        if (before.approved) {
          if (opts.json) {
            printJson({
              action: 'approve',
              path: before.path,
              approvedAt: before.approvedAt,
              alreadyApproved: true,
              filePath: getTrustedProjectsPath(effectiveGlobalDir),
            });
          } else {
            print(`Already approved: ${before.path}`);
          }
          return TRUST_EXIT_OK;
        }

        const asked = askToConfirm(
          { action: 'approve', title: CONFIRM_DIALOG_TITLE, message: buildApproveDialogMessage(realPath), paths: [realPath] },
          { jsonBase: { action: 'approve', path: realPath, approved: false }, declinedText: `Not approved: ${realPath}` },
        );
        if (asked.code !== TRUST_EXIT_OK) return asked.code;

        const res = approveProject(realPath, { globalDir: effectiveGlobalDir });
        acknowledgeApproval(res.path, { globalDir: effectiveGlobalDir });
        if (opts.json) {
          printJson({ action: 'approve', ...res, confirmed: true, confirmedVia: asked.via });
        } else {
          print(`${res.alreadyApproved ? 'Already approved' : 'Approved'}: ${res.path}`);
          print('herdr-cortex now reads and writes the .memory/ of this folder (not of its subfolders).');
          print('Memory tools use it right away; the memory overview is injected from the next session start.');
        }
        return TRUST_EXIT_OK;
      }
      case 'revoke': {
        const res = revokeProject(targetDir, { globalDir: effectiveGlobalDir });
        acknowledgeRevocation(targetDir, { globalDir: effectiveGlobalDir });
        if (opts.json) {
          printJson({ action: 'revoke', ...res });
        } else {
          print(`${res.revoked ? 'Revoked' : 'Was not approved'}: ${res.path}`);
        }
        return TRUST_EXIT_OK;
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
        return res.approved ? TRUST_EXIT_OK : TRUST_EXIT_NOT_APPROVED;
      }
      case 'list': {
        if (opts.dir) {
          stderr.write(`"list" takes no folder argument.\n${TRUST_CLI_USAGE}\n`);
          return TRUST_EXIT_ERROR;
        }
        const projects = listTrustedProjects({ globalDir: effectiveGlobalDir });
        const change = describeApprovalsChange({ globalDir: effectiveGlobalDir });
        const unconfirmed = new Set(change.added.map((entry) => entry.path));
        if (opts.json) {
          printJson({
            action: 'list',
            filePath: getTrustedProjectsPath(effectiveGlobalDir),
            projects,
            unacknowledged: { added: change.added, removed: change.removed },
          });
        } else if (projects.length === 0 && !change.changed) {
          print('No approved project folders.');
        } else {
          if (projects.length === 0) print('No approved project folders.');
          for (const entry of projects) {
            print(`${entry.approvedAt || '(no date)'}  ${entry.path}${unconfirmed.has(entry.path) ? '  [not confirmed in the dialog]' : ''}`);
          }
          for (const entry of change.removed) {
            print(`(removed without the dialog)  ${entry.path}`);
          }
          if (change.changed) print(`To accept the list as it is now: ${ACKNOWLEDGE_COMMAND}`);
        }
        return TRUST_EXIT_OK;
      }
      case 'acknowledge': {
        if (opts.dir) {
          stderr.write(`"acknowledge" takes no folder argument.\n${TRUST_CLI_USAGE}\n`);
          return TRUST_EXIT_ERROR;
        }
        const change = describeApprovalsChange({ globalDir: effectiveGlobalDir });
        if (!change.changed) {
          if (opts.json) {
            printJson({ action: 'acknowledge', changed: false, added: [], removed: [], filePath: getAcknowledgedApprovalsPath(effectiveGlobalDir) });
          } else {
            print('Nothing to acknowledge: every approved folder was confirmed in the dialog.');
          }
          return TRUST_EXIT_OK;
        }

        const asked = askToConfirm(
          {
            action: 'acknowledge',
            title: CONFIRM_DIALOG_TITLE,
            message: buildAcknowledgeDialogMessage(change),
            paths: [...change.added, ...change.removed].map((entry) => entry.path),
          },
          {
            jsonBase: { action: 'acknowledge', changed: true, added: change.added, removed: change.removed, acknowledged: false },
            declinedText: 'Not acknowledged',
          },
        );
        if (asked.code !== TRUST_EXIT_OK) return asked.code;

        // Acknowledge exactly what the dialog showed: if the list changed again meanwhile, the rest stays reported.
        const after = describeApprovalsChange({ globalDir: effectiveGlobalDir });
        if (after.key !== change.key) {
          stderr.write('The approvals list changed while the dialog was open. Nothing was acknowledged; run the command again.\n');
          return TRUST_EXIT_ERROR;
        }
        const res = acknowledgeCurrentApprovals({ globalDir: effectiveGlobalDir });
        if (opts.json) {
          printJson({
            action: 'acknowledge',
            changed: true,
            added: change.added,
            removed: change.removed,
            acknowledged: true,
            confirmedVia: asked.via,
            filePath: res.filePath,
          });
        } else {
          print(`Acknowledged: ${change.added.length} added, ${change.removed.length} removed.`);
          for (const entry of change.added) print(`  approved: ${entry.path}`);
          for (const entry of change.removed) print(`  not approved any more: ${entry.path}`);
        }
        return TRUST_EXIT_OK;
      }
      default:
        stderr.write(`Unknown command "${opts.command}".\n${TRUST_CLI_USAGE}\n`);
        return TRUST_EXIT_ERROR;
    }
  } catch (err) {
    stderr.write(`${err?.message || err}\n`);
    return TRUST_EXIT_ERROR;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runTrustCli(process.argv.slice(2), { cwd: resolveTrustCliCwd() });
}
