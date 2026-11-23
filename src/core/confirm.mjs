import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Asking a person to confirm a decision that an agent must not be able to make for them (approving a
 * project folder, accepting a changed approvals list).
 *
 * On Windows the question is a native message box, started through Windows PowerShell: whoever started the
 * command (the user in a shell, the user through an agent's "!" prefix, an agent through its shell tool),
 * the box appears on the user's screen and only its Yes button confirms. When no box can be shown (not
 * Windows, or PowerShell cannot be started) the question is asked on the terminal, but only when both
 * stdin and stdout are a terminal; otherwise the answer is "not confirmed, could not ask".
 *
 * There is deliberately no environment variable and no command-line option that answers the question or
 * skips it. Tests replace the confirm function in-process (`runTrustCli(argv, { confirm })`).
 */

/** Title of the confirmation message box. */
export const CONFIRM_DIALOG_TITLE = 'herdr-cortex';

/** The word that confirms on the terminal (the whole word, nothing shorter). */
export const CONFIRM_TERMINAL_WORD = 'yes';

/** What the terminal fallback prints after the question. */
export const CONFIRM_TERMINAL_PROMPT = `Type "${CONFIRM_TERMINAL_WORD}" to confirm (anything else cancels): `;

const ANSWER_PREFIX = 'HERDR_CORTEX_CONFIRM=';

/** The one line of the dialog script that shows the box (tests swap it for a line that shows nothing). */
export const CONFIRM_DIALOG_SHOW_LINE =
  '    $answer = [System.Windows.Forms.MessageBox]::Show($owner, [string]$data.message, [string]$data.title, '
  + '[System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, '
  + '[System.Windows.Forms.MessageBoxDefaultButton]::Button2)';

/**
 * The PowerShell script behind the message box. It is a constant: the title and the text (which contain
 * the folder path) are never put into it. They arrive on stdin as base64 of a UTF-8 JSON object, so quotes,
 * `$`, backticks, spaces and non-ASCII characters in a path are data and nothing else.
 * - Yes / No buttons, No is the default button (Button2), warning icon.
 * - The box is owned by a hidden top-most form, so it opens above the other windows.
 * - It prints HERDR_CORTEX_CONFIRM=yes or HERDR_CORTEX_CONFIRM=no; when the box could not be shown it
 *   prints HERDR_CORTEX_CONFIRM=unavailable and exits with code 3.
 */
export const CONFIRM_DIALOG_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  '    $raw = [Console]::In.ReadToEnd()',
  '    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($raw.Trim()))',
  '    $data = $json | ConvertFrom-Json',
  '    Add-Type -AssemblyName System.Windows.Forms',
  '    $owner = New-Object System.Windows.Forms.Form',
  '    $owner.TopMost = $true',
  '    $owner.ShowInTaskbar = $false',
  CONFIRM_DIALOG_SHOW_LINE,
  '    $owner.Dispose()',
  `    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('${ANSWER_PREFIX}yes') } else { [Console]::Out.Write('${ANSWER_PREFIX}no') }`,
  '    exit 0',
  '} catch {',
  '    [Console]::Error.Write($_.Exception.Message)',
  `    [Console]::Out.Write('${ANSWER_PREFIX}unavailable')`,
  '    exit 3',
  '}',
  '',
].join('\r\n');

function envText(env, name) {
  if (!env || typeof env !== 'object') return '';
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? env[key] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * Absolute path of Windows PowerShell (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`).
 * It is never looked up by bare name: that would search the current directory and PATH, where a repository
 * could plant its own `powershell.exe`. Returns '' when the Windows folder is not known.
 */
export function resolveWindowsPowerShell(env = process.env) {
  const systemRoot = envText(env, 'SystemRoot') || envText(env, 'windir');
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return '';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Show the confirmation message box and wait for the answer (there is no timeout: a person decides).
 * Returns { answer, detail }: answer is 'yes', 'no', or 'unavailable' when no box could be shown (not
 * Windows, PowerShell not found or not startable, the script failed before showing it); `detail` says why.
 * `spawn`, `powershellPath`, `script`, `platform` and `env` are injectable for tests; no test may call this
 * with the real script.
 */
export function showWindowsConfirmDialog(
  { title = CONFIRM_DIALOG_TITLE, message = '' } = {},
  {
    spawn = spawnSync,
    platform = process.platform,
    env = process.env,
    powershellPath = resolveWindowsPowerShell(env),
    script = CONFIRM_DIALOG_SCRIPT,
  } = {},
) {
  if (platform !== 'win32') return { answer: 'unavailable', detail: 'not running on Windows' };
  if (!powershellPath) return { answer: 'unavailable', detail: 'the Windows folder (SystemRoot) is not known' };

  const payload = Buffer.from(JSON.stringify({ title: String(title), message: String(message) }), 'utf8').toString('base64');
  let res;
  try {
    res = spawn(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-Sta', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {
        input: `${payload}\n`,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // The box belongs to no folder: never start in the caller's directory.
        cwd: path.dirname(powershellPath),
      },
    );
  } catch (err) {
    return { answer: 'unavailable', detail: `Windows PowerShell could not be started (${err?.code || err?.message || err})` };
  }
  if (!res || res.error) {
    return {
      answer: 'unavailable',
      detail: `Windows PowerShell could not be started (${res?.error?.code || res?.error?.message || 'no result'})`,
    };
  }

  const stdout = typeof res.stdout === 'string' ? res.stdout : String(res.stdout ?? '');
  const at = stdout.lastIndexOf(ANSWER_PREFIX);
  const answer = at === -1 ? '' : stdout.slice(at + ANSWER_PREFIX.length).trim().toLowerCase();
  if (answer === 'yes' && res.status === 0) return { answer: 'yes', detail: '' };
  if (answer === 'no' && res.status === 0) return { answer: 'no', detail: '' };
  const stderr = (typeof res.stderr === 'string' ? res.stderr : String(res.stderr ?? '')).replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    answer: 'unavailable',
    detail: `the confirmation dialog could not be shown (exit code ${res.status ?? 'none'}${stderr ? `: ${stderr}` : ''})`,
  };
}

// One line from a file descriptor, read synchronously (the command line is synchronous).
function readLineSync(fd = 0) {
  const chunk = Buffer.alloc(1);
  const bytes = [];
  for (;;) {
    let count;
    try {
      count = fs.readSync(fd, chunk, 0, 1, null);
    } catch (err) {
      if (err?.code === 'EAGAIN') continue;
      if (err?.code === 'EOF') break;
      throw err;
    }
    if (count === 0 || chunk[0] === 0x0a) break;
    bytes.push(chunk[0]);
  }
  return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
}

/**
 * Ask a person to confirm. `request` is { title, message } (the message names exactly what is confirmed).
 * Returns { confirmed, via, detail }:
 * - via 'dialog'  : the message box was shown; confirmed only when Yes was chosen;
 * - via 'terminal': no box could be shown and stdin and stdout are a terminal; confirmed only when the
 *                   whole word "yes" was typed;
 * - via 'none'    : nobody could be asked (confirmed is false, `detail` says why).
 * Everything it touches is injectable: `showDialog`, `isTerminal`, `readLine`, `write`.
 */
export function confirmWithUser(
  request = {},
  {
    showDialog = showWindowsConfirmDialog,
    isTerminal = () => Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
    readLine = () => readLineSync(0),
    write = (text) => process.stdout.write(text),
  } = {},
) {
  const title = typeof request.title === 'string' && request.title ? request.title : CONFIRM_DIALOG_TITLE;
  const message = String(request.message ?? '');

  let shown;
  try {
    shown = showDialog({ title, message });
  } catch (err) {
    shown = { answer: 'unavailable', detail: String(err?.message || err) };
  }
  if (shown?.answer === 'yes') return { confirmed: true, via: 'dialog', detail: '' };
  if (shown?.answer === 'no') return { confirmed: false, via: 'dialog', detail: 'the confirmation dialog was answered No (or closed)' };

  const whyNoDialog = shown?.detail || 'no confirmation dialog could be shown';
  if (!isTerminal()) {
    return { confirmed: false, via: 'none', detail: `${whyNoDialog}, and this is not an interactive terminal` };
  }

  write(`${message}\n\n${CONFIRM_TERMINAL_PROMPT}`);
  let typed = '';
  try {
    typed = String(readLine() ?? '');
  } catch {
    typed = '';
  }
  const confirmed = typed.trim().toLowerCase() === CONFIRM_TERMINAL_WORD;
  return {
    confirmed,
    via: 'terminal',
    detail: confirmed ? '' : `the answer was not the word "${CONFIRM_TERMINAL_WORD}"`,
  };
}
