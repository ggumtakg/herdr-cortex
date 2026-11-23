import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT, atomicWriteJson, atomicWriteText, getTrustedProjectsPath, isProjectTrusted } from '../src/core/config.mjs';
import {
  CONFIRM_DIALOG_SCRIPT,
  CONFIRM_DIALOG_SHOW_LINE,
  CONFIRM_DIALOG_TITLE,
  CONFIRM_TERMINAL_PROMPT,
  confirmWithUser,
  resolveWindowsPowerShell,
  showWindowsConfirmDialog,
} from '../src/core/confirm.mjs';
import {
  ACKNOWLEDGED_APPROVALS_FILE,
  APPROVALS_CHANGED_AGENT_NOTE,
  APPROVAL_STATE_FILE_NAMES,
  approveProject,
  describeApprovalsChange,
  formatApprovalsChangedContext,
  formatApprovalsChangedWarning,
  formatProjectNotApprovedNotice,
  formatProjectNotApprovedUserNotice,
  getAcknowledgedApprovalsPath,
  readAcknowledgedApprovals,
} from '../src/core/trust.mjs';
import {
  APPROVE_DIALOG_MEANING,
  TRUST_CLI_USAGE,
  buildAcknowledgeDialogMessage,
  buildApproveDialogMessage,
  runTrustCli,
} from '../src/core/trust-cli.mjs';
import {
  APPROVAL_CHECK_STALE_MS,
  checkApprovalsForSession,
  getApprovalChecksDir,
  pruneApprovalCheckRecords,
} from '../src/hooks/approvals-watch.mjs';
import {
  CLEAR_RECORD_POLL_MS,
  CLEAR_RECORD_WAIT_MS,
  TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE,
  formatStateFileWriteAskReason,
  handleClaudePreToolUse,
  handleClaudeSessionEnd,
  handleClaudeSessionStart,
  handleClaudeUserPrompt,
  renderClaudeHookStdout,
} from '../src/hooks/claude.mjs';
import { handleAntigravityPreInvocation } from '../src/hooks/antigravity.mjs';
import { formatUnindexedNotice, formatUnindexedUserNotice } from '../src/hooks/overview.mjs';
import { serializeMarkdownDoc } from '../src/core/frontmatter.mjs';
import { enqueueMessage } from '../src/relay/inbox.mjs';
import { collectStatus, formatStatus } from '../scripts/cortex-status.mjs';
import { approveAsUser } from './support/approve.mjs';
import { assertNoDialogEnv, makeNoDialogEnv } from './support/no-dialog-env.mjs';

const TRUST_CLI = path.join(REPO_ROOT, 'src', 'core', 'trust-cli.mjs');
const CLAUDE_HOOK = path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs');

// The project folder starts out NOT approved.
function makeTempEnv(prefix = 'herdr-cortex-confirm-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  const globalDir = path.join(homeDir, '.herdr-cortex');
  const promptsDir = path.join(root, 'prompts');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  atomicWriteText(path.join(promptsDir, 'HEAD_CORE.md'), '# HEAD_CORE\n\n- Delegate high-resolution work.\n');
  return {
    root,
    projectDir,
    homeDir,
    globalDir,
    promptsDir,
    hookOptions(extra = {}) {
      return { terminalId: '', globalDir, legacyHome: homeDir, promptsDir, ...extra };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeSink() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
}

// A confirm function for runTrustCli that records what it was asked and answers as told.
function makeConfirm(answer) {
  const asked = [];
  const confirm = (request) => {
    asked.push(request);
    return typeof answer === 'function' ? answer(request) : answer;
  };
  return { asked, confirm };
}
const YES = { confirmed: true, via: 'dialog', detail: '' };
const NO = { confirmed: false, via: 'dialog', detail: 'the confirmation dialog was answered No (or closed)' };
const NOBODY = { confirmed: false, via: 'none', detail: 'Windows PowerShell could not be started (ENOENT), and this is not an interactive terminal' };

function cli(env, argv, confirm, cwd = env.projectDir) {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = runTrustCli(argv, { cwd, globalDir: env.globalDir, stdout, stderr, ...(confirm ? { confirm } : {}) });
  return { code, out: stdout.text, err: stderr.text };
}

function contextOf(out) {
  return out?.hookSpecificOutput?.additionalContext || '';
}

function agyText(out) {
  return (out?.injectSteps || []).map((step) => step.systemMessage?.systemMessage || '').join('\n\n');
}

function childEnv(env) {
  const out = { ...process.env, HERDR_CORTEX_HOME: env.globalDir, HERDR_CORTEX_TEST_HOME: env.homeDir };
  for (const key of ['HC_TERMINAL_ID', 'npm_lifecycle_event', 'INIT_CWD']) delete out[key];
  return out;
}

const user = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const human = (text) => user(text, { origin: { kind: 'human' } });
const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

function writeJsonl(filePath, items) {
  atomicWriteText(filePath, `${items.map((item) => JSON.stringify(item)).join('\n')}\n`);
}

// ---------------------------------------------------------------------------------------------
// The confirmation itself
// ---------------------------------------------------------------------------------------------

test('confirmation: only a Yes in the dialog confirms; without a dialog the terminal asks for the whole word "yes"; without either nobody is asked', () => {
  const request = { title: 'herdr-cortex', message: 'Approve this folder?\n\nC:\\work\\proj' };
  const never = () => { throw new Error('must not be called'); };

  // The dialog decides when it can be shown
  const shown = [];
  const yes = confirmWithUser(request, { showDialog: (args) => { shown.push(args); return { answer: 'yes', detail: '' }; }, isTerminal: never, readLine: never, write: never });
  assert.deepEqual(yes, { confirmed: true, via: 'dialog', detail: '' });
  assert.deepEqual(shown, [{ title: 'herdr-cortex', message: request.message }]);
  const no = confirmWithUser(request, { showDialog: () => ({ answer: 'no', detail: '' }), isTerminal: never, readLine: never, write: never });
  assert.equal(no.confirmed, false);
  assert.equal(no.via, 'dialog');

  // No dialog, a terminal: the question is printed and only the whole word confirms
  const ask = (typed, showDialog = () => ({ answer: 'unavailable', detail: 'not running on Windows' })) => {
    const written = [];
    const res = confirmWithUser(request, { showDialog, isTerminal: () => true, readLine: () => typed, write: (text) => written.push(text) });
    return { res, written: written.join('') };
  };
  const typedYes = ask('yes');
  assert.deepEqual(typedYes.res, { confirmed: true, via: 'terminal', detail: '' });
  assert.equal(typedYes.written, `${request.message}\n\n${CONFIRM_TERMINAL_PROMPT}`);
  assert.match(CONFIRM_TERMINAL_PROMPT, /^Type "yes" to confirm/);
  assert.equal(ask('  YES \r').res.confirmed, true);
  for (const typed of ['y', 'Y', '', 'ye', 'yes please', 'yess', 'ok', 'true', '1', 'no', null, undefined]) {
    const res = ask(typed).res;
    assert.equal(res.confirmed, false, `typed: ${typed}`);
    assert.equal(res.via, 'terminal');
  }
  // A dialog function that fails counts as "no dialog"
  assert.equal(ask('yes', () => { throw new Error('boom'); }).res.via, 'terminal');
  assert.equal(confirmWithUser(request, { showDialog: () => ({ answer: 'unavailable' }), isTerminal: () => true, readLine: () => { throw new Error('closed'); }, write: () => {} }).confirmed, false);

  // No dialog, no terminal (an agent's shell tool, a pipe): nobody is asked, nothing is confirmed
  const nobody = confirmWithUser(request, { showDialog: () => ({ answer: 'unavailable', detail: 'Windows PowerShell could not be started (ENOENT)' }), isTerminal: () => false, readLine: never, write: never });
  assert.deepEqual(nobody, { confirmed: false, via: 'none', detail: 'Windows PowerShell could not be started (ENOENT), and this is not an interactive terminal' });
  // An answer that is neither yes nor no is never a yes
  for (const answer of ['YES', 'Yes', 'true', '', undefined]) {
    assert.equal(confirmWithUser(request, { showDialog: () => ({ answer }), isTerminal: () => false, readLine: never, write: never }).confirmed, false, String(answer));
  }
});

test('confirmation dialog: a native Yes/No box titled herdr-cortex, No by default, on top; the path travels as data on stdin and never as script text', () => {
  // The script is a constant, plain ASCII, and has what the dialog must have
  assert.equal(CONFIRM_DIALOG_TITLE, 'herdr-cortex');
  assert.equal(/[^\x00-\x7f]/.test(CONFIRM_DIALOG_SCRIPT), false);
  assert.ok(CONFIRM_DIALOG_SCRIPT.includes(CONFIRM_DIALOG_SHOW_LINE));
  assert.match(CONFIRM_DIALOG_SHOW_LINE, /\[System\.Windows\.Forms\.MessageBox\]::Show\(\$owner, \[string\]\$data\.message, \[string\]\$data\.title, /);
  assert.match(CONFIRM_DIALOG_SHOW_LINE, /MessageBoxButtons\]::YesNo/);
  assert.match(CONFIRM_DIALOG_SHOW_LINE, /MessageBoxDefaultButton\]::Button2/, 'No is the default button');
  assert.match(CONFIRM_DIALOG_SCRIPT, /\$owner\.TopMost = \$true/, 'the box opens above other windows');
  assert.match(CONFIRM_DIALOG_SCRIPT, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.match(CONFIRM_DIALOG_SCRIPT, /FromBase64String/);

  const trickyPath = 'C:\\work\\it\'s "quoted" $env:USERPROFILE `whoami` $(calc) ; & del 한글 폴더';
  const message = buildApproveDialogMessage(trickyPath);
  const powershellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  // How the process is started
  const calls = [];
  const fakeSpawn = (result) => (file, args, options) => {
    calls.push({ file, args, options });
    return typeof result === 'function' ? result() : result;
  };
  const run = (result, extra = {}) => showWindowsConfirmDialog(
    { title: CONFIRM_DIALOG_TITLE, message },
    { spawn: fakeSpawn(result), platform: 'win32', powershellPath, ...extra },
  );

  assert.deepEqual(run({ status: 0, stdout: 'HERDR_CORTEX_CONFIRM=yes', stderr: '' }), { answer: 'yes', detail: '' });
  const call = calls[0];
  assert.equal(call.file, powershellPath, 'started by absolute path, never by bare name');
  assert.deepEqual(call.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-Sta', '-OutputFormat', 'Text']);
  assert.equal(call.args[5], '-EncodedCommand');
  assert.equal(Buffer.from(call.args[6], 'base64').toString('utf16le'), CONFIRM_DIALOG_SCRIPT, 'the script text is the constant, unchanged');
  assert.equal(call.args.length, 7);
  for (const text of [CONFIRM_DIALOG_SCRIPT, ...call.args]) {
    assert.equal(text.includes('whoami'), false, 'nothing of the path is in the script or on the command line');
    assert.equal(text.includes('한글'), false);
  }
  assert.deepEqual(JSON.parse(Buffer.from(call.options.input.trim(), 'base64').toString('utf8')), { title: 'herdr-cortex', message });
  assert.match(call.options.input.trim(), /^[A-Za-z0-9+/=]+$/, 'stdin carries base64 only');
  assert.equal(call.options.cwd, path.dirname(powershellPath));
  assert.equal(call.options.timeout, undefined, 'a person decides: there is no timeout');
  assert.equal(call.options.shell, undefined);

  // Reading the answer: only a clean yes is a yes
  assert.equal(run({ status: 0, stdout: 'HERDR_CORTEX_CONFIRM=no', stderr: '' }).answer, 'no');
  assert.equal(run({ status: 0, stdout: 'noise\r\nHERDR_CORTEX_CONFIRM=yes\r\n', stderr: '' }).answer, 'yes');
  for (const result of [
    { status: 1, stdout: 'HERDR_CORTEX_CONFIRM=yes', stderr: '' },
    { status: 3, stdout: 'HERDR_CORTEX_CONFIRM=unavailable', stderr: 'Unable to load System.Windows.Forms' },
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: 'yes', stderr: '' },
    { status: null, stdout: 'HERDR_CORTEX_CONFIRM=yes', stderr: '', signal: 'SIGTERM' },
    { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' },
    null,
  ]) {
    const res = run(result);
    assert.equal(res.answer, 'unavailable', JSON.stringify(result));
    assert.ok(res.detail.length > 0);
  }
  assert.equal(run(() => { throw new Error('EPERM'); }).answer, 'unavailable');
  assert.match(run({ status: 3, stdout: 'HERDR_CORTEX_CONFIRM=unavailable', stderr: 'Unable to load\r\nSystem.Windows.Forms' }).detail, /could not be shown \(exit code 3: Unable to load System\.Windows\.Forms\)/);

  // No Windows, no PowerShell: no dialog, and nothing is started
  const before = calls.length;
  assert.deepEqual(run({ status: 0, stdout: 'HERDR_CORTEX_CONFIRM=yes' }, { platform: 'linux' }), { answer: 'unavailable', detail: 'not running on Windows' });
  assert.equal(run({ status: 0, stdout: 'HERDR_CORTEX_CONFIRM=yes' }, { powershellPath: '' }).answer, 'unavailable');
  assert.equal(calls.length, before);

  // Where PowerShell is looked for: the Windows folder only, never PATH or the current directory
  assert.equal(resolveWindowsPowerShell({ SystemRoot: 'C:\\Windows' }), powershellPath);
  assert.equal(resolveWindowsPowerShell({ SYSTEMROOT: 'C:\\Windows' }), powershellPath);
  assert.equal(resolveWindowsPowerShell({ windir: 'D:\\WinNT' }), 'D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(resolveWindowsPowerShell({ Path: 'C:\\evil;C:\\Windows\\System32' }), '');
  assert.equal(resolveWindowsPowerShell({ SystemRoot: 'relative\\dir' }), '');
  assert.equal(resolveWindowsPowerShell({ SystemRoot: '  ' }), '');
  assert.equal(resolveWindowsPowerShell({}), '');
});

test('confirmation dialog through the real Windows PowerShell (the line that shows the box replaced by a stub): tricky paths arrive intact and the answer comes back', { skip: process.platform === 'win32' && fs.existsSync(resolveWindowsPowerShell()) ? false : 'Windows PowerShell is not available' }, () => {
  // Nothing is displayed: the one line that calls MessageBox.Show is swapped for a line that answers by
  // itself and echoes what it received. Everything else is the real script and the real PowerShell.
  const stubLine = (answer) => `    $answer = [System.Windows.Forms.DialogResult]::${answer}; `
    + "[Console]::Out.WriteLine('SEEN=' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(([string]$data.title) + [char]10 + ([string]$data.message) + [char]10 + $owner.TopMost)))";
  const stubbed = (answer) => {
    const script = CONFIRM_DIALOG_SCRIPT.replace(CONFIRM_DIALOG_SHOW_LINE, stubLine(answer));
    assert.notEqual(script, CONFIRM_DIALOG_SCRIPT);
    assert.equal(script.includes('MessageBox]::Show'), false, 'the stubbed script cannot show a box');
    return script;
  };

  const trickyPath = 'C:\\work\\it\'s "quoted" $env:USERPROFILE `whoami` $(calc) ; & del 한글 폴더';
  const message = buildApproveDialogMessage(trickyPath);
  for (const [answer, expected] of [['No', 'no'], ['Yes', 'yes'], ['Cancel', 'no'], ['None', 'no']]) {
    let seen = '';
    const res = showWindowsConfirmDialog({ title: CONFIRM_DIALOG_TITLE, message }, {
      script: stubbed(answer),
      spawn: (file, args, options) => {
        const out = spawnSync(file, args, { ...options, timeout: 60000 });
        seen = /SEEN=([A-Za-z0-9+/=]+)/.exec(String(out.stdout))?.[1] || '';
        return out;
      },
    });
    assert.deepEqual(res, { answer: expected, detail: '' }, answer);
    assert.equal(Buffer.from(seen, 'base64').toString('utf8'), `herdr-cortex\n${message}\nTrue`, 'title, text and top-most owner as sent');
  }

  // A script that fails before the box is shown reports "unavailable", never an answer
  const broken = CONFIRM_DIALOG_SCRIPT.replace(CONFIRM_DIALOG_SHOW_LINE, "    throw 'no desktop'");
  const failed = showWindowsConfirmDialog({ title: CONFIRM_DIALOG_TITLE, message }, {
    script: broken,
    spawn: (file, args, options) => spawnSync(file, args, { ...options, timeout: 60000 }),
  });
  assert.equal(failed.answer, 'unavailable');
  assert.match(failed.detail, /exit code 3: no desktop/);
});

// ---------------------------------------------------------------------------------------------
// cortex-trust approve asks a person
// ---------------------------------------------------------------------------------------------

test('cortex-trust approve: asks for exactly the real folder path, approves only on a confirmed yes, and has no switch that skips the question', () => {
  const env = makeTempEnv('cortex-confirm-cli-');
  try {
    const realProject = fs.realpathSync.native(env.projectDir);
    const junction = path.join(env.root, 'via-junction');
    fs.symlinkSync(env.projectDir, junction, 'junction');
    const approvalsFile = getTrustedProjectsPath(env.globalDir);

    // The text of the dialog
    const dialogText = buildApproveDialogMessage(realProject);
    assert.equal(dialogText, [
      'Approve this folder for herdr-cortex?',
      '',
      realProject,
      '',
      APPROVE_DIALOG_MEANING,
      '',
      'If you did not ask for this yourself, choose No.',
    ].join('\n'));
    assert.match(APPROVE_DIALOG_MEANING, /read and write the \.memory folder of exactly this folder \(not its subfolders\)/);
    assert.equal(APPROVE_DIALOG_MEANING.includes('\n'), false);
    assert.match(TRUST_CLI_USAGE, /acknowledge/);

    // No: nothing is approved, exit code 1
    const declined = makeConfirm(NO);
    const no = cli(env, ['approve'], declined.confirm);
    assert.equal(no.code, 1);
    assert.match(no.out, /^Not approved: .*\(the confirmation dialog was answered No \(or closed\)\)\. Nothing was changed\./);
    assert.equal(isProjectTrusted(env.projectDir, { globalDir: env.globalDir }), false);
    assert.equal(fs.existsSync(approvalsFile), false);
    assert.equal(declined.asked.length, 1);
    assert.deepEqual(declined.asked[0], { action: 'approve', title: 'herdr-cortex', message: dialogText, paths: [realProject] });

    // Nobody could be asked (no dialog, no terminal): refused with exit code 2
    const nobody = makeConfirm(NOBODY);
    const refused = cli(env, ['approve'], nobody.confirm);
    assert.equal(refused.code, 2);
    assert.match(refused.err, /^Cannot ask for confirmation: Windows PowerShell could not be started \(ENOENT\), and this is not an interactive terminal\. Nothing was changed\. Run "cortex-trust approve" yourself in a terminal window\.\n$/);
    assert.equal(refused.out, '');
    assert.equal(isProjectTrusted(env.projectDir, { globalDir: env.globalDir }), false);
    // ... also when the confirm function fails or answers with something that is not a yes
    for (const answer of [() => { throw new Error('boom'); }, () => undefined, () => null, () => 'yes', () => ({ confirmed: 'yes' }), () => ({ confirmed: 1, via: 'dialog' }), () => false]) {
      const res = cli(env, ['approve'], makeConfirm(answer).confirm);
      assert.notEqual(res.code, 0);
      assert.equal(isProjectTrusted(env.projectDir, { globalDir: env.globalDir }), false);
    }

    // Arguments that look like "skip the question" are not options: they are taken for a folder name
    for (const flag of ['--yes', '-y', '--force', '--no-confirm', '--assume-yes', '/y']) {
      const skip = makeConfirm(NO);
      const res = cli(env, ['approve', flag], skip.confirm);
      assert.equal(res.code, 2, flag);
      assert.equal(skip.asked.length, 0);
      assert.equal(isProjectTrusted(env.projectDir, { globalDir: env.globalDir }), false, flag);
    }
    // ... and the only environment variables the two modules read are the Windows folder (to find
    // PowerShell) and npm's script variables (to find the default folder)
    const source = ['confirm.mjs', 'trust-cli.mjs'].map((name) => fs.readFileSync(path.join(REPO_ROOT, 'src', 'core', name), 'utf8')).join('\n');
    const envNames = new Set();
    for (const match of source.matchAll(/\benv\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) envNames.add(match[1]);
    for (const match of source.matchAll(/envText\(env, '([^']+)'\)/g)) envNames.add(match[1]);
    assert.deepEqual([...envNames].sort(), ['INIT_CWD', 'SystemRoot', 'npm_lifecycle_event', 'npm_package_json', 'npm_package_name', 'windir']);

    // Yes: approved, through a junction too (the dialog shows the folder the junction points to)
    const agreed = makeConfirm(YES);
    const yes = cli(env, ['approve', junction], agreed.confirm, env.root);
    assert.equal(yes.code, 0, yes.err);
    assert.ok(yes.out.startsWith(`Approved: ${realProject}\n`));
    assert.deepEqual(agreed.asked[0].paths, [realProject]);
    assert.ok(agreed.asked[0].message.includes(`\n${realProject}\n`));
    assert.equal(agreed.asked[0].message.includes('via-junction'), false);
    assert.equal(isProjectTrusted(env.projectDir, { globalDir: env.globalDir }), true);
    // ... and recorded as confirmed by a person
    assert.deepEqual(readAcknowledgedApprovals(env.globalDir).map((entry) => entry.path), [realProject]);
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, false);

    // Already approved: said so without a dialog
    const again = makeConfirm(NO);
    const already = cli(env, ['approve'], again.confirm);
    assert.equal(already.code, 0);
    assert.equal(already.out, `Already approved: ${realProject}\n`);
    assert.equal(again.asked.length, 0);
    assert.equal(JSON.parse(cli(env, ['approve', '--json'], again.confirm).out).alreadyApproved, true);

    // status, list and revoke never ask
    const silent = makeConfirm(() => { throw new Error('must not ask'); });
    assert.equal(cli(env, ['status'], silent.confirm).code, 0);
    assert.equal(cli(env, ['list'], silent.confirm).code, 0);
    assert.equal(cli(env, ['revoke'], silent.confirm).code, 0);
    assert.equal(silent.asked.length, 0);
    assert.equal(isProjectTrusted(env.projectDir, { globalDir: env.globalDir }), false);
    assert.deepEqual(readAcknowledgedApprovals(env.globalDir), [], 'a revoked folder leaves the acknowledged list as well');

    // --json: the outcome of the question is part of the output
    const jsonNo = JSON.parse(cli(env, ['approve', '--json'], makeConfirm(NO).confirm).out);
    assert.deepEqual([jsonNo.action, jsonNo.approved, jsonNo.confirmed, jsonNo.confirmedVia, jsonNo.path], ['approve', false, false, 'dialog', realProject]);
    const jsonYes = JSON.parse(cli(env, ['approve', '--json'], makeConfirm({ confirmed: true, via: 'terminal' }).confirm).out);
    assert.deepEqual([jsonYes.action, jsonYes.alreadyApproved, jsonYes.confirmed, jsonYes.confirmedVia, jsonYes.path], ['approve', false, true, 'terminal', realProject]);
  } finally {
    env.cleanup();
  }
});

test('cortex-trust in a child process: status, list and revoke work; approve and acknowledge refuse with exit code 2 when no dialog can be shown and there is no terminal', () => {
  const env = makeTempEnv('cortex-confirm-child-');
  try {
    const other = path.join(env.root, 'other folder');
    fs.mkdirSync(other, { recursive: true });
    approveAsUser(env.projectDir, { globalDir: env.globalDir });

    // Commands that never ask run in an ordinary child process
    const spawnCli = (args, cwd = env.projectDir, extra = {}) => spawnSync(
      process.execPath,
      ['--no-warnings', TRUST_CLI, ...args],
      { cwd, env: childEnv(env), encoding: 'utf8', timeout: 60000, ...extra },
    );
    assert.equal(spawnCli(['status']).status, 0);
    assert.equal(spawnCli(['status'], other).status, 1);
    assert.match(spawnCli(['list']).stdout, /project/);

    // Commands that ask run in a child in which the dialog cannot be started (proved before it is relied
    // on), so the real dialog is never shown by a test
    const noDialogEnv = makeNoDialogEnv(childEnv(env), path.join(env.root, 'empty-windows-folder'));
    assertNoDialogEnv(noDialogEnv);
    const spawnAsking = (args, cwd, extra = {}) => spawnCli(args, cwd, { env: noDialogEnv, ...extra });

    const approve = spawnAsking(['approve'], other);
    assert.equal(approve.status, 2, approve.stdout + approve.stderr);
    assert.match(approve.stderr, /^Cannot ask for confirmation: .*, and this is not an interactive terminal\. Nothing was changed\. Run "cortex-trust approve" yourself in a terminal window\.\r?\n$/);
    if (process.platform === 'win32') {
      assert.match(approve.stderr, /Windows PowerShell could not be started \(ENOENT\)/);
    }
    assert.equal(approve.stdout, '');
    assert.equal(isProjectTrusted(other, { globalDir: env.globalDir }), false);
    // Typing "yes" into a pipe is not a terminal answer
    const piped = spawnAsking(['approve'], other, { input: 'yes\n' });
    assert.equal(piped.status, 2);
    assert.equal(isProjectTrusted(other, { globalDir: env.globalDir }), false);

    // An approval written into the file directly cannot be acknowledged without a person either
    approveProject(other, { globalDir: env.globalDir });
    const acknowledge = spawnAsking(['acknowledge'], env.projectDir);
    assert.equal(acknowledge.status, 2, acknowledge.stdout + acknowledge.stderr);
    assert.match(acknowledge.stderr, /^Cannot ask for confirmation: .*Run "cortex-trust acknowledge" yourself in a terminal window\./);
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, true);

    // revoke needs no confirmation; it also undoes the direct edit
    assert.equal(spawnCli(['revoke'], other).status, 0);
    assert.equal(isProjectTrusted(other, { globalDir: env.globalDir }), false);
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, false);
    assert.match(spawnCli(['acknowledge']).stdout, /^Nothing to acknowledge/);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Approvals changed without the dialog
// ---------------------------------------------------------------------------------------------

test('acknowledged list: approve and revoke record only the folder the person saw; a direct edit stays reported until acknowledge (in a dialog) or undo', () => {
  const env = makeTempEnv('cortex-confirm-ack-');
  try {
    const projectB = path.join(env.root, 'project-b');
    const sneaked = path.join(env.root, 'sneaked in');
    for (const dir of [projectB, sneaked]) fs.mkdirSync(dir, { recursive: true });
    const realA = fs.realpathSync.native(env.projectDir);
    const realB = fs.realpathSync.native(projectB);
    const realSneaked = fs.realpathSync.native(sneaked);
    const ackFile = getAcknowledgedApprovalsPath(env.globalDir);
    assert.equal(ackFile, path.join(env.globalDir, 'state', ACKNOWLEDGED_APPROVALS_FILE));
    assert.deepEqual([...APPROVAL_STATE_FILE_NAMES], ['trusted-projects.json', 'trusted-projects.acknowledged.json']);

    // Nothing approved, nothing acknowledged: no difference
    assert.deepEqual(describeApprovalsChange({ globalDir: env.globalDir }), { changed: false, added: [], removed: [], key: '' });
    assert.equal(formatApprovalsChangedWarning(describeApprovalsChange({ globalDir: env.globalDir })), '');

    // A confirmed approval is acknowledged
    assert.equal(cli(env, ['approve'], makeConfirm(YES).confirm).code, 0);
    const ackData = JSON.parse(fs.readFileSync(ackFile, 'utf8'));
    assert.equal(ackData.version, 1);
    assert.deepEqual(ackData.projects.map((entry) => entry.path), [realA]);
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, false);

    // The approvals file is edited directly (here: by the library function, as an agent could with a file tool)
    const direct = approveProject(sneaked, { globalDir: env.globalDir, now: new Date('2026-11-23T10:20:30.400+09:00') });
    const change = describeApprovalsChange({ globalDir: env.globalDir });
    assert.equal(change.changed, true);
    assert.deepEqual(change.added, [{ path: realSneaked, approvedAt: direct.approvedAt }]);
    assert.deepEqual(change.removed, []);
    assert.match(change.key, /^[0-9a-f]{16}$/);

    // The warning: one line, names the folder and its timestamp, how to undo, how to accept
    const warning = formatApprovalsChangedWarning(change);
    assert.equal(warning, '[herdr-cortex] WARNING: the list of approved project folders was changed without the cortex-trust confirmation dialog. '
      + `Added: "${realSneaked}" (approved at ${direct.approvedAt}). `
      + 'If you did not make this change, undo it: cortex-trust revoke "<folder>" for an added folder, '
      + 'cortex-trust approve "<folder>" for a removed one. To accept the list as it is now: cortex-trust acknowledge.');
    assert.equal(warning.includes('\n'), false);
    assert.equal(formatApprovalsChangedContext(change), `${warning}${APPROVALS_CHANGED_AGENT_NOTE}`);

    // Approving another folder in the dialog acknowledges that folder only ...
    assert.equal(cli(env, ['approve', projectB], makeConfirm(YES).confirm).code, 0);
    assert.deepEqual(readAcknowledgedApprovals(env.globalDir).map((entry) => entry.path), [realA, realB]);
    assert.deepEqual(describeApprovalsChange({ globalDir: env.globalDir }).added.map((entry) => entry.path), [realSneaked]);
    // ... and a revoke (which needs no confirmation) cannot be used to wave the edit through
    assert.equal(cli(env, ['revoke', path.join(env.root, 'never-approved')]).code, 0);
    assert.equal(cli(env, ['revoke', projectB]).code, 0);
    assert.deepEqual(describeApprovalsChange({ globalDir: env.globalDir }).added.map((entry) => entry.path), [realSneaked]);
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).key, change.key, 'the same change keeps its key');

    // list marks it
    const listed = cli(env, ['list']);
    assert.match(listed.out, new RegExp(`${realSneaked.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}  \\[not confirmed in the dialog\\]`));
    assert.match(listed.out, /To accept the list as it is now: cortex-trust acknowledge\n$/);
    assert.deepEqual(JSON.parse(cli(env, ['list', '--json']).out).unacknowledged.added.map((entry) => entry.path), [realSneaked]);

    // acknowledge asks in a dialog that lists the folders; No and "nobody to ask" change nothing
    const ackDialog = buildAcknowledgeDialogMessage(change);
    assert.ok(ackDialog.startsWith('Accept these changes to the approved project folders of herdr-cortex?\n\nApproved without the confirmation dialog (Yes keeps them approved):\n'));
    assert.ok(ackDialog.includes(`  ${realSneaked}  (${direct.approvedAt})\n`));
    assert.ok(ackDialog.endsWith('If you did not make these changes yourself, choose No.'));
    const declined = makeConfirm(NO);
    const ackNo = cli(env, ['acknowledge'], declined.confirm);
    assert.equal(ackNo.code, 1);
    assert.match(ackNo.out, /^Not acknowledged \(.*\)\. Nothing was changed\./);
    assert.deepEqual(declined.asked[0], { action: 'acknowledge', title: 'herdr-cortex', message: ackDialog, paths: [realSneaked] });
    assert.equal(cli(env, ['acknowledge'], makeConfirm(NOBODY).confirm).code, 2);
    assert.equal(cli(env, ['acknowledge', 'some-folder'], makeConfirm(YES).confirm).code, 2);
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, true);

    // Yes: the list as it is now becomes the acknowledged one
    const ackYes = cli(env, ['acknowledge'], makeConfirm(YES).confirm);
    assert.equal(ackYes.code, 0, ackYes.err);
    assert.match(ackYes.out, /^Acknowledged: 1 added, 0 removed\.\n {2}approved: /);
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, false);
    const nothing = makeConfirm(NO);
    assert.match(cli(env, ['acknowledge'], nothing.confirm).out, /^Nothing to acknowledge/);
    assert.equal(nothing.asked.length, 0);

    // A folder removed from the file directly is reported as removed; approving it again (dialog) undoes it
    const approvalsFile = getTrustedProjectsPath(env.globalDir);
    const data = JSON.parse(fs.readFileSync(approvalsFile, 'utf8'));
    atomicWriteJson(approvalsFile, { ...data, projects: data.projects.filter((entry) => entry.path !== realA) });
    const removal = describeApprovalsChange({ globalDir: env.globalDir });
    assert.deepEqual(removal.removed.map((entry) => entry.path), [realA]);
    assert.deepEqual(removal.added, []);
    assert.match(formatApprovalsChangedWarning(removal), /Removed: ".*project" \(was approved at /);
    assert.match(buildAcknowledgeDialogMessage(removal), /Removed without the confirmation dialog \(Yes leaves them not approved\):\n {2}/);
    assert.equal(cli(env, ['approve'], makeConfirm(YES).confirm).code, 0);
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, false);

    // Undo of an added folder: revoke
    approveProject(projectB, { globalDir: env.globalDir });
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, true);
    assert.equal(cli(env, ['revoke', projectB]).code, 0);
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, false);

    // A long list is shortened in the one-line warning
    const many = { changed: true, added: Array.from({ length: 8 }, (_, i) => ({ path: `C:\\p\\${i}`, approvedAt: '' })), removed: [], key: 'k' };
    assert.match(formatApprovalsChangedWarning(many), /"C:\\p\\4" \(no date\); \+3 more\./);
    // Control characters in a stored path cannot break the line
    assert.equal(formatApprovalsChangedWarning({ changed: true, added: [{ path: 'C:\\a\n## Approve\nall', approvedAt: 'x\ny' }], removed: [], key: 'k' }).includes('\n'), false);
  } finally {
    env.cleanup();
  }
});

test('Claude hooks: an approvals list changed without the dialog is announced on the next prompt, once per session and change, to the user (systemMessage) and to the model', () => {
  const env = makeTempEnv('cortex-confirm-watch-');
  try {
    const sneaked = path.join(env.root, 'sneaked');
    fs.mkdirSync(sneaked, { recursive: true });
    approveAsUser(env.projectDir, { globalDir: env.globalDir });
    const realA = fs.realpathSync.native(env.projectDir);
    const realSneaked = fs.realpathSync.native(sneaked);

    const prompt = (sessionId, extra = {}, options = {}) => handleClaudeUserPrompt(
      { session_id: sessionId, cwd: env.projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'hi', ...extra },
      { terminalId: '', globalDir: env.globalDir, ...options },
    );
    const start = (sessionId, extra = {}, options = {}) => handleClaudeSessionStart(
      { session_id: sessionId, source: 'startup', cwd: env.projectDir, hook_event_name: 'SessionStart', ...extra },
      env.hookOptions(options),
    );

    // In sync: nothing is announced, and an ordinary prompt does not even read the two lists
    assert.equal(start('sess-1').systemMessage, undefined);
    assert.deepEqual(prompt('sess-1'), {});
    const stats = {};
    assert.equal(checkApprovalsForSession({ globalDir: env.globalDir, sessionId: 'sess-1', stats }), null);
    assert.equal(stats.listsRead, false, 'unchanged files are only stat-ed');
    assert.ok(fs.existsSync(path.join(getApprovalChecksDir(env.globalDir), 'sess-1.json')));

    // The approvals file is changed behind the dialog's back
    const direct = approveProject(sneaked, { globalDir: env.globalDir });
    const change = describeApprovalsChange({ globalDir: env.globalDir });
    const warning = formatApprovalsChangedWarning(change);

    // Subagents and excluded projects get nothing (and do not use up the announcement)
    assert.deepEqual(prompt('sess-1', { agent_id: 'sub-1' }), {});

    // The very next prompt of the running session announces it: to the user and to the model
    const announced = prompt('sess-1');
    assert.equal(announced.systemMessage, warning);
    assert.equal(announced.systemMessage.includes('\n'), false, 'one line');
    assert.ok(announced.systemMessage.includes(`"${realSneaked}" (approved at ${direct.approvedAt})`));
    assert.match(announced.systemMessage, /cortex-trust revoke "<folder>"/);
    assert.match(announced.systemMessage, /cortex-trust acknowledge\.$/);
    assert.deepEqual(announced.hookSpecificOutput, {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${warning}${APPROVALS_CHANGED_AGENT_NOTE}`,
    });
    assert.deepEqual(JSON.parse(renderClaudeHookStdout('user-prompt', announced)), announced, 'systemMessage is a top-level field of the hook output');

    // ... once: the following prompts of that session are quiet again
    assert.deepEqual(prompt('sess-1'), {});
    assert.deepEqual(prompt('sess-1'), {});
    assert.equal(start('sess-1', { source: 'compact' }).systemMessage, undefined, 'the same session is not told twice');

    // A new session is told again, at its start
    const second = start('sess-2');
    assert.equal(second.systemMessage, warning);
    assert.ok(contextOf(second).includes(`${warning}${APPROVALS_CHANGED_AGENT_NOTE}`));
    assert.deepEqual(prompt('sess-2'), {});
    // The split legacy "core" part never carries notices
    assert.equal(start('sess-3', {}, { part: 'core' }).systemMessage, undefined);
    assert.equal(start('sess-3', {}, { part: 'context' }).systemMessage, warning);

    // A different change is a new announcement in the same session
    const approvalsFile = getTrustedProjectsPath(env.globalDir);
    const data = JSON.parse(fs.readFileSync(approvalsFile, 'utf8'));
    atomicWriteJson(approvalsFile, { ...data, projects: data.projects.filter((entry) => entry.path !== realA) });
    const both = prompt('sess-1');
    assert.match(both.systemMessage, /Added: ".*sneaked" \(approved at .*\)\. Removed: ".*project" \(was approved at /);
    assert.deepEqual(prompt('sess-1'), {});

    // Undone (the file is back to what was confirmed): nothing more to say, in any session
    atomicWriteJson(approvalsFile, { ...data, projects: data.projects.filter((entry) => entry.path === realA) });
    assert.equal(describeApprovalsChange({ globalDir: env.globalDir }).changed, false);
    assert.deepEqual(prompt('sess-1'), {});
    assert.equal(start('sess-4').systemMessage, undefined);

    // The same change made again after it was undone is announced again
    approveProject(sneaked, { globalDir: env.globalDir });
    assert.ok(prompt('sess-1').systemMessage.includes(realSneaked));
    // ... until the user accepts it in the dialog
    assert.equal(cli(env, ['acknowledge'], makeConfirm(YES).confirm).code, 0);
    assert.deepEqual(prompt('sess-1'), {});
    assert.equal(start('sess-5').systemMessage, undefined);

    // Without a usable session id the warning cannot be remembered: it is shown every time
    approveProject(path.join(env.root), { globalDir: env.globalDir });
    assert.ok(prompt(undefined).systemMessage);
    assert.ok(prompt(undefined).systemMessage);
    assert.ok(prompt('../../escape').systemMessage);
    assert.deepEqual(fs.readdirSync(getApprovalChecksDir(env.globalDir)).filter((name) => name.includes('escape')), []);

    // Relay messages are still delivered next to the warning; only the warning goes to the user's screen
    enqueueMessage('tab-1', { from_terminal_id: 'tab-2', message: 'RELAY-BODY hello', context_docs: [] }, { globalDir: env.globalDir });
    const withInbox = prompt('sess-6', {}, { terminalId: 'tab-1' });
    assert.match(withInbox.systemMessage, /^\[herdr-cortex\] WARNING: /);
    assert.equal(withInbox.systemMessage.includes('RELAY-BODY'), false);
    assert.ok(contextOf(withInbox).startsWith('[herdr-cortex] WARNING: '));
    assert.ok(contextOf(withInbox).includes('RELAY-BODY hello'));
    // A prompt with relay messages and no warning looks exactly as before
    enqueueMessage('tab-1', { from_terminal_id: 'tab-2', message: 'SECOND-BODY', context_docs: [] }, { globalDir: env.globalDir });
    const inboxOnly = prompt('sess-6', {}, { terminalId: 'tab-1' });
    assert.deepEqual(Object.keys(inboxOnly), ['hookSpecificOutput']);
    assert.ok(contextOf(inboxOnly).includes('SECOND-BODY'));

    // An excluded project gets no hook output at all
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { excludedProjects: [env.projectDir] });
    assert.deepEqual(prompt('sess-7'), {});
    fs.unlinkSync(path.join(env.globalDir, 'config.json'));

    // The real hook process prints the field
    const child = spawnSync(process.execPath, ['--no-warnings', CLAUDE_HOOK, 'user-prompt', '--id', 'herdr-cortex'], {
      input: JSON.stringify({ session_id: 'sess-child', cwd: env.projectDir, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      encoding: 'utf8',
      cwd: env.projectDir,
      env: childEnv(env),
      timeout: 30000,
    });
    assert.equal(child.status, 0, child.stderr);
    const printed = JSON.parse(child.stdout);
    assert.match(printed.systemMessage, /^\[herdr-cortex\] WARNING: the list of approved project folders was changed/);
    assert.equal(printed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');

    // Old check records are pruned when a session starts
    const stale = path.join(getApprovalChecksDir(env.globalDir), 'sess-1.json');
    const old = new Date(Date.now() - APPROVAL_CHECK_STALE_MS - 60_000);
    fs.utimesSync(stale, old, old);
    assert.equal(pruneApprovalCheckRecords(env.globalDir), 1);
    assert.equal(fs.existsSync(stale), false);
    assert.ok(fs.existsSync(path.join(getApprovalChecksDir(env.globalDir), 'sess-2.json')));
  } finally {
    env.cleanup();
  }
});

test('PreToolUse: the acknowledged list is protected like the approvals file', () => {
  const env = makeTempEnv('cortex-confirm-guard-');
  try {
    approveAsUser(env.projectDir, { globalDir: env.globalDir });
    const ackFile = getAcknowledgedApprovalsPath(env.globalDir);
    const subagent = { agent_id: 'sub-1', agent_type: 'general-purpose' };
    const write = (who = {}) => handleClaudePreToolUse(
      { tool_name: 'Write', tool_input: { file_path: ackFile, content: '{}' }, cwd: env.projectDir, ...who },
      { globalDir: env.globalDir },
    );
    assert.equal(write().hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(write().hookSpecificOutput.permissionDecisionReason, formatStateFileWriteAskReason(ackFile, { approvalsFile: true }));
    assert.equal(write(subagent).hookSpecificOutput.permissionDecision, 'deny');

    const shell = (command, who = {}) => handleClaudePreToolUse(
      { tool_name: 'Bash', tool_input: { command }, cwd: env.projectDir, ...who },
      { globalDir: env.globalDir },
    );
    assert.equal(shell(`cp trusted-projects.json ${ACKNOWLEDGED_APPROVALS_FILE}`).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(shell(`rm ${ACKNOWLEDGED_APPROVALS_FILE}`, subagent).hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(shell(`cat ${ACKNOWLEDGED_APPROVALS_FILE}`), {});
    assert.deepEqual(shell('cat trusted-projects.acknowledged.jsonl > x'), {}, 'a longer name is another file');
  } finally {
    env.cleanup();
  }
});

test('Antigravity hooks and cortex-status report the same unacknowledged approvals', async () => {
  const env = makeTempEnv('cortex-confirm-agy-');
  try {
    const sneaked = path.join(env.root, 'sneaked');
    fs.mkdirSync(sneaked, { recursive: true });
    approveAsUser(env.projectDir, { globalDir: env.globalDir });
    const invoke = (convId) => handleAntigravityPreInvocation(
      { conversationId: convId, rootConversationId: convId, cwd: env.projectDir, lastUserInput: 'continue' },
      env.hookOptions(),
    );

    assert.equal(agyText(invoke('conv-1')).includes('WARNING'), false);
    let status = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: {} });
    assert.deepEqual(status.approvals, { count: 1, changed: false, added: [], removed: [] });
    assert.ok(formatStatus(status).includes('Approvals    : 1 folder(s) approved | all confirmed in the dialog'));

    const direct = approveProject(sneaked, { globalDir: env.globalDir });
    const context = formatApprovalsChangedContext(describeApprovalsChange({ globalDir: env.globalDir }));

    // Antigravity has one channel (steps the model reads): the warning is injected there, once per conversation
    assert.ok(agyText(invoke('conv-1')).startsWith(context));
    assert.equal(agyText(invoke('conv-1')).includes('WARNING'), false);
    assert.ok(agyText(invoke('conv-2')).includes(context));

    status = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: {} });
    assert.equal(status.approvals.changed, true);
    assert.deepEqual(status.approvals.added, [{ path: direct.path, approvedAt: direct.approvedAt }]);
    assert.ok(status.warnings.some((line) => line.startsWith('Approvals: the list of approved project folders was changed without the cortex-trust confirmation dialog. Added: "')));
    const lines = formatStatus(status);
    assert.ok(lines.includes('Approvals    : 2 folder(s) approved | CHANGED without the confirmation dialog: 1 added, 0 removed (accept with: cortex-trust acknowledge)'), lines.join('\n'));
    assert.ok(lines.includes(`             : added: ${direct.path} (${direct.approvedAt})`), lines.join('\n'));
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Notices for the user go to the user's screen
// ---------------------------------------------------------------------------------------------

test('SessionStart: what the user should know is also a systemMessage line (not approved, not indexed, turns not restored); routine output is not', () => {
  const env = makeTempEnv('cortex-confirm-notices-');
  try {
    const transcriptDir = path.join(env.root, 'claude-projects', 'C--work-project');
    const transcriptOf = (sessionId) => path.join(transcriptDir, `${sessionId}.jsonl`);
    const writeDoc = (id, body = 'body') => atomicWriteText(
      path.join(env.projectDir, '.memory', 'docs', '2026-11', `${id}.md`),
      serializeMarkdownDoc({ id, type: 'decision', title: `Title of ${id}`, summary: `Summary of ${id}`, status: 'active' }, body),
    );
    writeDoc('dec-small');

    // 1. The folder has a .memory/ but is not approved
    const unapproved = handleClaudeSessionStart({ session_id: 's-1', source: 'startup', cwd: env.projectDir }, env.hookOptions());
    const userLine = formatProjectNotApprovedUserNotice(env.projectDir);
    assert.equal(unapproved.systemMessage, userLine);
    assert.equal(userLine, `[herdr-cortex] Project memory was not loaded: "${env.projectDir}" has a .memory/ folder but is not approved. To approve it, run: cortex-trust approve`);
    assert.ok(contextOf(unapproved).includes(formatProjectNotApprovedNotice(env.projectDir)), 'the model still gets its own, longer notice');
    assert.equal(handleClaudeSessionStart({ session_id: 's-1', source: 'startup', cwd: env.projectDir }, env.hookOptions({ part: 'core' })).systemMessage, undefined);

    // 2. Approved, everything indexed: an ordinary start has no systemMessage at all
    approveAsUser(env.projectDir, { globalDir: env.globalDir });
    const routine = handleClaudeSessionStart({ session_id: 's-2', source: 'startup', cwd: env.projectDir }, env.hookOptions());
    assert.deepEqual(Object.keys(routine), ['hookSpecificOutput']);
    assert.match(contextOf(routine), /Title of dec-small/);

    // 3. A document the hook leaves to the MCP server
    writeDoc('dec-large', 'x'.repeat(4000));
    const deferred = handleClaudeSessionStart(
      { session_id: 's-3', source: 'startup', cwd: env.projectDir },
      env.hookOptions({ indexBudget: { maxFileBytes: 2000 } }),
    );
    assert.match(deferred.systemMessage, /^\[herdr-cortex\] 1 memory document is not indexed yet, so the memory overview and search may be incomplete until the MCP server has indexed them: "docs\/2026-11\/dec-large\.md" \(4 KB, too large to index at session start\)\.$/);
    assert.match(contextOf(deferred), /Memory may be incomplete: 1 document is not indexed yet/);
    const five = Array.from({ length: 5 }, (_, i) => ({ scope: 'project', path: `docs/d${i}.md`, size: 10, reason: 'time_budget' }));
    assert.match(formatUnindexedUserNotice(five), /^\[herdr-cortex\] 5 memory documents are not indexed yet, .*: "docs\/d0\.md" \(10 B, no time left at session start\); "docs\/d1\.md" .*; "docs\/d2\.md" .*; \+2 more\.$/);
    assert.equal(formatUnindexedUserNotice([]), '');
    assert.ok(formatUnindexedNotice(five).length > formatUnindexedUserNotice(five).length);

    // 4. /clear without an identifiable previous session, in a folder that also has an unindexed document:
    //    one line per notice
    atomicWriteText(transcriptOf('s-new'), '');
    const cleared = handleClaudeSessionStart(
      { session_id: 's-new', source: 'clear', transcript_path: transcriptOf('s-new'), cwd: env.projectDir },
      env.hookOptions({ indexBudget: { maxFileBytes: 2000 }, sleep: () => {} }),
    );
    const linesShown = cleared.systemMessage.split('\n');
    assert.equal(linesShown.length, 2);
    assert.match(linesShown[0], /^\[herdr-cortex\] 1 memory document is not indexed yet/);
    assert.equal(linesShown[1], TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE);
    assert.ok(contextOf(cleared).includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE));
    assert.deepEqual(JSON.parse(renderClaudeHookStdout('session-start', cleared)).systemMessage, cleared.systemMessage);

    // 5. Turns that were restored are routine: no line for the user
    writeJsonl(transcriptOf('s-old'), [human('Goal of the old window'), assistant('Reply')]);
    handleClaudeSessionEnd(
      { session_id: 's-old', transcript_path: transcriptOf('s-old'), cwd: env.projectDir, reason: 'clear' },
      { terminalId: '', globalDir: env.globalDir },
    );
    atomicWriteText(transcriptOf('s-next'), '');
    const restored = handleClaudeSessionStart(
      { session_id: 's-next', source: 'clear', transcript_path: transcriptOf('s-next'), cwd: env.projectDir },
      env.hookOptions(),
    );
    assert.match(contextOf(restored), /Goal of the old window/);
    assert.equal(restored.systemMessage, undefined);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// /clear: wait briefly for the clear record
// ---------------------------------------------------------------------------------------------

test('/clear: SessionStart waits up to 2 s (polling every 100 ms) for a clear record that is not there yet, and only then', () => {
  const env = makeTempEnv('cortex-confirm-clearwait-');
  try {
    approveAsUser(env.projectDir, { globalDir: env.globalDir });
    assert.equal(CLEAR_RECORD_WAIT_MS, 2000);
    assert.equal(CLEAR_RECORD_POLL_MS, 100);

    const transcriptDir = path.join(env.root, 'claude-projects', 'C--work-project');
    const transcriptOf = (sessionId) => path.join(transcriptDir, `${sessionId}.jsonl`);
    writeJsonl(transcriptOf('sess-a'), [human('Goal of window A'), assistant('Reply in window A')]);
    const endSessionA = (nowMs) => handleClaudeSessionEnd(
      { session_id: 'sess-a', transcript_path: transcriptOf('sess-a'), cwd: env.projectDir, hook_event_name: 'SessionEnd', reason: 'clear' },
      { terminalId: '', globalDir: env.globalDir, now: () => nowMs },
    );
    let count = 0;
    const startAfterClear = (options = {}, payload = {}) => {
      const sessionId = `sess-new-${++count}`;
      atomicWriteText(transcriptOf(sessionId), '');
      return handleClaudeSessionStart(
        { session_id: sessionId, source: 'clear', transcript_path: transcriptOf(sessionId), cwd: env.projectDir, hook_event_name: 'SessionStart', ...payload },
        env.hookOptions(options),
      );
    };

    // 1. The record appears 300 ms after SessionStart began looking: found on the third look
    const t0 = 1_800_000_000_000;
    let clock = t0;
    const slept = [];
    const late = startAfterClear({
      now: () => clock,
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        if (clock - t0 === 300) endSessionA(clock);
      },
    });
    assert.deepEqual(slept, [100, 100, 100]);
    assert.match(contextOf(late), /Goal of window A/);
    assert.equal(contextOf(late).includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE), false);
    assert.equal(late.systemMessage, undefined);

    // 2. No record ever: it gives up after exactly the limit and says so
    clock = t0;
    slept.length = 0;
    const never = startAfterClear({ now: () => clock, sleep: (ms) => { slept.push(ms); clock += ms; } });
    assert.equal(slept.length, CLEAR_RECORD_WAIT_MS / CLEAR_RECORD_POLL_MS);
    assert.equal(slept.reduce((sum, ms) => sum + ms, 0), CLEAR_RECORD_WAIT_MS);
    assert.ok(contextOf(never).includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE));
    // ... also with a clock that does not move (the wait is counted in time slept)
    slept.length = 0;
    startAfterClear({ now: () => t0, sleep: (ms) => slept.push(ms) });
    assert.equal(slept.reduce((sum, ms) => sum + ms, 0), CLEAR_RECORD_WAIT_MS);
    // ... and the two limits can be set
    slept.length = 0;
    startAfterClear({ now: () => t0, sleep: (ms) => slept.push(ms), clearRecordWaitMs: 250, clearRecordPollMs: 100 });
    assert.deepEqual(slept, [100, 100, 50]);
    slept.length = 0;
    startAfterClear({ now: () => t0, sleep: (ms) => slept.push(ms), clearRecordWaitMs: 0 });
    assert.deepEqual(slept, []);

    // 3. The record is already there: no wait
    const noSleep = () => { throw new Error('must not wait'); };
    endSessionA(t0);
    assert.match(contextOf(startAfterClear({ now: () => t0 + 50, sleep: noSleep })), /Goal of window A/);

    // 4. Two records fit (ambiguous): that is an answer, not "none"; no wait
    writeJsonl(transcriptOf('sess-b'), [human('Goal of window B'), assistant('Reply in window B')]);
    endSessionA(t0);
    handleClaudeSessionEnd(
      { session_id: 'sess-b', transcript_path: transcriptOf('sess-b'), cwd: env.projectDir, reason: 'clear' },
      { terminalId: '', globalDir: env.globalDir, now: () => t0 },
    );
    assert.ok(contextOf(startAfterClear({ now: () => t0 + 50, sleep: noSleep })).includes(TURNS_NOT_RESTORED_UNIDENTIFIED_NOTE));

    // 5. The tab record names the previous session: no wait
    handleClaudeSessionStart(
      { session_id: 'sess-a', source: 'startup', cwd: env.projectDir },
      env.hookOptions({ terminalId: 'tab-5' }),
    );
    atomicWriteText(transcriptOf('sess-after-a'), '');
    const viaTab = handleClaudeSessionStart(
      { session_id: 'sess-after-a', source: 'clear', transcript_path: transcriptOf('sess-after-a'), cwd: env.projectDir },
      env.hookOptions({ terminalId: 'tab-5', now: () => t0 + 500_000, sleep: noSleep }),
    );
    assert.match(contextOf(viaTab), /Goal of window A/);

    // 6. No other kind of session start ever waits
    for (const source of ['startup', 'resume', 'compact', 'fork']) {
      atomicWriteText(transcriptOf(`sess-${source}`), '');
      handleClaudeSessionStart(
        { session_id: `sess-${source}`, source, transcript_path: transcriptOf(`sess-${source}`), cwd: env.projectDir },
        env.hookOptions({ now: () => t0 + 900_000, sleep: noSleep }),
      );
    }
    // ... nor does a subagent, an excluded project, or a /clear whose own transcript already has turns
    startAfterClear({ sleep: noSleep }, { agent_id: 'sub-1' });
    writeJsonl(transcriptOf('sess-has-turns'), [human('Already here'), assistant('Yes')]);
    handleClaudeSessionStart(
      { session_id: 'sess-has-turns', source: 'clear', transcript_path: transcriptOf('sess-has-turns'), cwd: env.projectDir },
      env.hookOptions({ now: () => t0 + 900_000, sleep: noSleep }),
    );
  } finally {
    env.cleanup();
  }
});
