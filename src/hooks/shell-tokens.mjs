/**
 * Shared shell command-line tokenizer for hook guards (`git commit` window clearing,
 * irreversible command confirmation, `cortex-work` invocation checks, and work-size state checks).
 *
 * Shell-kind aware (`bash`, `powershell`, `cmd`):
 * - In `bash`: ANSI-C `$'...'` and locale `$"..."` quotes, unquoted `\` single-char escapes and line
 *   continuations, pairs of backticks (`substitutions`), `$(...)` and `<(...)` / `>(...)` substitutions,
 *   `${...}` parameter expansions, `<<<` here-strings, and heredocs (`<<` / `<<-`, skipping the body only
 *   when its closing delimiter line is actually present).
 * - In `powershell`: curly quotes (`‘ ’ “ ”`) and en/em-dashes (`– —`) normalized before tokenizing,
 *   backtick `` ` `` escapes the next character (both unquoted and in `"..."` / `@"..."@`) and continues
 *   lines before `\r?\n`; it is NEVER treated as command substitution. `''` escapes `'` inside `'...'`,
 *   `""` / `` `" `` escapes `"` inside `"..."`, `@'...'@` and `@"..."@` parse here-strings, `<#...#>`
 *   skips block comments, and `${name}` keeps braced variable tokens intact.
 * - In `cmd`: leading `@` echo-suppression stripped, single quote `'` and backtick `` ` `` are ordinary
 *   characters, `"` pairs 1-to-1, and unquoted `^` escapes the next character or continues lines before `\r?\n`.
 * - Uncertain boundaries fail open to inspection: unclosed quotes (`'`, `"`, `$'`, `$"`), unclosed
 *   here-strings, unclosed backticks, unclosed `${`, and unclosed `$(` / `<(` / `@(` subexpressions never
 *   swallow the remainder of the command into an uninspected literal token.
 */

export function executableBaseName(word) {
  const s = String(word ?? '');
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return s.slice(cut + 1).toLowerCase();
}

export function stripExeSuffix(baseName) {
  return String(baseName ?? '').replace(/\.(?:exe|cmd|bat|ps1|com)$/i, '');
}

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PWSH_SHELLS = new Set(['powershell', 'pwsh']);

/**
 * Normalize a tool name (`Bash`, `PowerShell`) or shell binary (`bash`, `pwsh`, `cmd.exe`) to
 * `'bash'`, `'powershell'`, `'cmd'`, or `''` (unknown).
 */
export function normalizeShellKind(shell) {
  const raw = String(shell ?? '').trim().toLowerCase();
  if (!raw) return '';
  const bare = stripExeSuffix(executableBaseName(raw));
  if (PWSH_SHELLS.has(bare)) return 'powershell';
  if (POSIX_SHELLS.has(bare)) return 'bash';
  if (bare === 'cmd') return 'cmd';
  return '';
}

function findClosingBashAnsiSingleQuote(command, dollarIdx) {
  // Assumes `command[dollarIdx] === '$'` and `command[dollarIdx + 1] === "'"`
  let k = dollarIdx + 2;
  while (k < command.length) {
    const ch = command[k];
    if (ch === '\\') {
      if (k + 1 >= command.length) return -1;
      k += 2;
      continue;
    }
    if (ch === '\'') return k;
    k++;
  }
  return -1;
}

const ANSI_C_SIMPLE_ESCAPES = Object.freeze({
  '\\': '\\',
  '\'': '\'',
  '"': '"',
  '?': '?',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
});

function decodeBashAnsiSingleQuote(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '\\' || i + 1 >= raw.length) {
      out += raw[i];
      i++;
      continue;
    }
    const esc = raw[i + 1];
    if (Object.prototype.hasOwnProperty.call(ANSI_C_SIMPLE_ESCAPES, esc)) {
      out += ANSI_C_SIMPLE_ESCAPES[esc];
      i += 2;
      continue;
    }
    if (esc === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 2));
      if (m) {
        out += String.fromCharCode(Number.parseInt(m[0], 16));
        i += 2 + m[0].length;
        continue;
      }
    } else if (esc >= '0' && esc <= '7') {
      const m = /^[0-7]{1,3}/.exec(raw.slice(i + 1));
      if (m) {
        out += String.fromCharCode(Number.parseInt(m[0], 8) & 0xff);
        i += 1 + m[0].length;
        continue;
      }
    } else if (esc === 'u' || esc === 'U') {
      const maxDigits = esc === 'u' ? 4 : 8;
      const m = new RegExp(`^[0-9a-fA-F]{1,${maxDigits}}`).exec(raw.slice(i + 2));
      if (m) {
        const cp = Number.parseInt(m[0], 16);
        if (cp <= 0x10ffff) {
          out += String.fromCodePoint(cp);
          i += 2 + m[0].length;
          continue;
        }
      }
    }
    out += `\\${esc}`;
    i += 2;
  }
  return out;
}

function unescapeBashBacktickBody(rawInner, { inDoubleQuote = false } = {}) {
  let out = '';
  let i = 0;
  while (i < rawInner.length) {
    if (rawInner[i] === '\\' && i + 1 < rawInner.length) {
      const next = rawInner[i + 1];
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (next === '\r' && rawInner[i + 2] === '\n') {
        i += 3;
        continue;
      }
      if (next === '$' || next === '`' || next === '\\' || (inDoubleQuote && next === '"')) {
        out += next;
        i += 2;
        continue;
      }
    }
    out += rawInner[i];
    i++;
  }
  return out;
}

function skipBacktickSubstitution(command, startIndex, { inDoubleQuote = false } = {}) {
  // Assumes `command[startIndex] === '`'`
  let i = startIndex + 1;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '\\' && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      const rawInner = command.slice(startIndex + 1, i);
      return {
        end: i + 1,
        inner: unescapeBashBacktickBody(rawInner, { inDoubleQuote }),
        closed: true,
      };
    }
    i++;
  }
  return {
    end: command.length,
    inner: unescapeBashBacktickBody(command.slice(startIndex + 1), { inDoubleQuote }),
    closed: false,
  };
}

function scanBashHeredocOperator(command, startIndex) {
  // Assumes `command[startIndex] === '<' && command[startIndex + 1] === '<' && command[startIndex + 2] !== '<'`
  let i = startIndex + 2;
  let stripTabs = false;
  if (command[i] === '-') {
    stripTabs = true;
    i++;
  }
  while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i++;
  let delim = '';
  let quotedDelim = false;
  while (i < command.length) {
    const dc = command[i];
    if (dc === '$' && command[i + 1] === '\'') {
      const closeAnsi = findClosingBashAnsiSingleQuote(command, i);
      if (closeAnsi === -1) return { nextIndex: i, spec: null };
      delim += decodeBashAnsiSingleQuote(command.slice(i + 2, closeAnsi));
      quotedDelim = true;
      i = closeAnsi + 1;
      continue;
    }
    if (dc === '$' && command[i + 1] === '"') {
      const closeDq = command.indexOf('"', i + 2);
      if (closeDq === -1) return { nextIndex: i, spec: null };
      delim += command.slice(i + 2, closeDq);
      quotedDelim = true;
      i = closeDq + 1;
      continue;
    }
    if (dc === '\'' || dc === '"') {
      const closeQ = command.indexOf(dc, i + 1);
      if (closeQ === -1) return { nextIndex: i, spec: null };
      delim += command.slice(i + 1, closeQ);
      quotedDelim = true;
      i = closeQ + 1;
      continue;
    }
    if (/[\s;|&<>()\r\n]/.test(dc)) break;
    if (dc === '\\' && i + 1 < command.length) {
      if (command[i + 1] === '\n' || command[i + 1] === '\r') break;
      delim += command[i + 1];
      quotedDelim = true;
      i += 2;
      continue;
    }
    delim += dc;
    i++;
  }
  return {
    nextIndex: i,
    spec: delim ? { delim, stripTabs, quotedDelim } : null,
  };
}

function collectUnquotedHeredocSubstitutions(bodyText) {
  const subs = [];
  let i = 0;
  while (i < bodyText.length) {
    const ch = bodyText[i];
    if (ch === '\\' && i + 1 < bodyText.length) {
      i += 2;
      continue;
    }
    if (ch === '$' && bodyText[i + 1] === '(') {
      const sub = scanBashCommandSubstitution(bodyText, i);
      if (sub.closed) {
        const inner = bodyText.slice(i + 2, sub.end - 1);
        if (inner.trim()) subs.push(inner);
        i = sub.end;
        continue;
      }
      const rest = bodyText.slice(i + 2);
      if (rest.trim()) subs.push(rest);
      break;
    }
    if (ch === '`') {
      const bt = skipBacktickSubstitution(bodyText, i, { inDoubleQuote: false });
      if (bt.inner.trim()) subs.push(bt.inner);
      if (!bt.closed) break;
      i = bt.end;
      continue;
    }
    i++;
  }
  return subs;
}

function skipPendingHeredocBodies(command, startIdx, pendingHeredocs) {
  let i = startIdx;
  const bodySubstitutions = [];
  while (pendingHeredocs.length > 0) {
    const { delim, stripTabs, quotedDelim } = pendingHeredocs.shift();
    if (i >= command.length) break;
    const bodyStart = i;
    let cursor = i;
    let bodyEnd = -1;
    if (command.includes(delim, i)) {
      while (cursor < command.length) {
        const lineStart = cursor;
        const lineEnd = command.indexOf('\n', cursor);
        const rawLine = (lineEnd === -1 ? command.slice(cursor) : command.slice(cursor, lineEnd)).replace(/\r$/, '');
        cursor = lineEnd === -1 ? command.length : lineEnd + 1;
        const candidate = stripTabs ? rawLine.replace(/^\t+/, '') : rawLine;
        if (candidate === delim) {
          bodyEnd = lineStart;
          break;
        }
      }
    }
    // Only skip a heredoc body when its closing delimiter line was actually found; otherwise
    // (e.g. arithmetic `((y = 1<<2))`) leave following lines to be inspected as ordinary commands.
    if (bodyEnd === -1) {
      pendingHeredocs.length = 0;
      break;
    }
    i = cursor;
    if (!quotedDelim && bodyEnd > bodyStart) {
      bodySubstitutions.push(...collectUnquotedHeredocSubstitutions(command.slice(bodyStart, bodyEnd)));
    }
  }
  return { nextIndex: i, bodySubstitutions };
}

function scanBashParameterExpansion(command, startIndex, { inDoubleQuote = false } = {}) {
  // Assumes `command.slice(startIndex, startIndex + 2) === '${'`
  let depth = 1;
  let i = startIndex + 2;
  const innerSubs = [];
  while (i < command.length && depth > 0) {
    const ch = command[i];
    if (ch === '\\') {
      if (i + 1 >= command.length) return { end: command.length, closed: false, substitutions: [] };
      i += 2;
      continue;
    }
    if (!inDoubleQuote && ch === '\'') {
      const endSq = command.indexOf('\'', i + 1);
      if (endSq === -1) return { end: command.length, closed: false, substitutions: [] };
      i = endSq + 1;
      continue;
    }
    if (!inDoubleQuote && ch === '$' && command[i + 1] === '\'') {
      const endAnsi = findClosingBashAnsiSingleQuote(command, i);
      if (endAnsi === -1) return { end: command.length, closed: false, substitutions: [] };
      i = endAnsi + 1;
      continue;
    }
    if (ch === '"' || (ch === '$' && command[i + 1] === '"')) {
      const openDq = ch === '$' ? i + 1 : i;
      const dq = scanBashDoubleQuote(command, openDq);
      if (dq.closeIdx === -1) return { end: command.length, closed: false, substitutions: [] };
      innerSubs.push(...dq.substitutions);
      i = dq.closeIdx + 1;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      const sub = scanBashCommandSubstitution(command, i);
      if (!sub.closed) return { end: command.length, closed: false, substitutions: [] };
      if (sub.end >= i + 3) {
        const inner = command.slice(i + 2, sub.end - 1);
        if (inner.trim()) innerSubs.push(inner);
      }
      i = sub.end;
      continue;
    }
    if (ch === '$' && command[i + 1] === '{') {
      depth++;
      i += 2;
      continue;
    }
    if (ch === '`') {
      const bt = skipBacktickSubstitution(command, i, { inDoubleQuote });
      if (!bt.closed) return { end: command.length, closed: false, substitutions: [] };
      if (bt.inner.trim()) innerSubs.push(bt.inner);
      i = bt.end;
      continue;
    }
    if (ch === '}') {
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return { end: i, closed: depth === 0, substitutions: innerSubs };
}

function scanBashCommandSubstitution(command, startIndex) {
  // Assumes `command[startIndex + 1] === '('` (for `$(`, `<(`, or `>(`)
  let depth = 1;
  let i = startIndex + 2;
  let atWordStart = true;
  const pendingHeredocs = [];

  while (i < command.length && depth > 0) {
    const ch = command[i];

    if (ch === '$' && command[i + 1] === '\'') {
      const endAnsi = findClosingBashAnsiSingleQuote(command, i);
      if (endAnsi === -1) return { end: command.length, closed: false };
      i = endAnsi + 1;
      atWordStart = false;
      continue;
    }

    if (ch === '$' && command[i + 1] === '"') {
      const endDq = findClosingBashDoubleQuote(command, i + 1);
      if (endDq === -1) return { end: command.length, closed: false };
      i = endDq + 1;
      atWordStart = false;
      continue;
    }

    if (ch === '\'') {
      const endSq = command.indexOf('\'', i + 1);
      if (endSq === -1) return { end: command.length, closed: false };
      i = endSq + 1;
      atWordStart = false;
      continue;
    }

    if (ch === '"') {
      const endDq = findClosingBashDoubleQuote(command, i);
      if (endDq === -1) return { end: command.length, closed: false };
      i = endDq + 1;
      atWordStart = false;
      continue;
    }

    if (ch === '`') {
      const bt = skipBacktickSubstitution(command, i, { inDoubleQuote: false });
      if (!bt.closed) return { end: command.length, closed: false };
      i = bt.end;
      atWordStart = false;
      continue;
    }

    if (ch === '$' && command[i + 1] === '{') {
      const param = scanBashParameterExpansion(command, i, { inDoubleQuote: false });
      if (!param.closed) return { end: command.length, closed: false };
      i = param.end;
      atWordStart = false;
      continue;
    }

    if (ch === '<' && command[i + 1] === '<') {
      if (command[i + 2] === '<') {
        while (i < command.length && command[i] === '<') i++;
        atWordStart = true;
        continue;
      }
      const hd = scanBashHeredocOperator(command, i);
      if (hd.spec) pendingHeredocs.push(hd.spec);
      i = hd.nextIndex;
      atWordStart = true;
      continue;
    }

    if (ch === '#' && atWordStart) {
      while (i < command.length && command[i] !== '\n') i++;
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && command[i + 1] === '\n') i += 2;
      else i++;
      atWordStart = true;
      if (pendingHeredocs.length > 0) {
        const skipped = skipPendingHeredocBodies(command, i, pendingHeredocs);
        i = skipped.nextIndex;
      }
      continue;
    }

    if (ch === '\\') {
      if (i + 1 >= command.length) return { end: command.length, closed: false };
      if (command[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (command[i + 1] === '\r' && command[i + 2] === '\n') {
        i += 3;
        continue;
      }
      i += 2;
      atWordStart = false;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === ';' || ch === '|' || ch === '&') {
      atWordStart = true;
      i++;
      continue;
    }

    if (ch === '(') {
      depth++;
      atWordStart = true;
      i++;
      continue;
    }

    if (ch === ')') {
      depth--;
      atWordStart = true;
      i++;
      continue;
    }

    atWordStart = false;
    i++;
  }
  return { end: i, closed: depth === 0 };
}

function scanBashDoubleQuote(command, openIdx) {
  let k = openIdx + 1;
  let text = '';
  const subs = [];
  while (k < command.length) {
    const ch = command[k];
    if (ch === '\\' && k + 1 < command.length) {
      const next = command[k + 1];
      if (next === '\n') {
        k += 2;
        continue;
      }
      if (next === '\r' && command[k + 2] === '\n') {
        k += 3;
        continue;
      }
      if (next === '"' || next === '\\' || next === '$' || next === '`') {
        text += next;
        k += 2;
        continue;
      }
    }
    if (ch === '$' && command[k + 1] === '(') {
      const sub = scanBashCommandSubstitution(command, k);
      if (!sub.closed) return { closeIdx: -1, text: '', substitutions: [] };
      text += command.slice(k, sub.end);
      if (sub.end >= k + 3) {
        const inner = command.slice(k + 2, sub.end - 1);
        if (inner.trim()) subs.push(inner);
      }
      k = sub.end;
      continue;
    }
    if (ch === '$' && command[k + 1] === '{') {
      const param = scanBashParameterExpansion(command, k, { inDoubleQuote: true });
      if (!param.closed) return { closeIdx: -1, text: '', substitutions: [] };
      text += command.slice(k, param.end);
      subs.push(...param.substitutions);
      k = param.end;
      continue;
    }
    if (ch === '`') {
      const bt = skipBacktickSubstitution(command, k, { inDoubleQuote: true });
      if (!bt.closed) return { closeIdx: -1, text: '', substitutions: [] };
      text += command.slice(k, bt.end);
      if (bt.inner.trim()) subs.push(bt.inner);
      k = bt.end;
      continue;
    }
    if (ch === '"') {
      return { closeIdx: k, text, substitutions: subs };
    }
    text += ch;
    k++;
  }
  return { closeIdx: -1, text: '', substitutions: [] };
}

function findClosingBashDoubleQuote(command, openIdx) {
  return scanBashDoubleQuote(command, openIdx).closeIdx;
}

function findClosingPwshSingleQuote(command, openIdx) {
  let k = openIdx + 1;
  while (k < command.length) {
    if (command[k] === '\'') {
      if (command[k + 1] === '\'') {
        k += 2;
        continue;
      }
      return k;
    }
    k++;
  }
  return -1;
}

function scanPwshSingleHereString(command, atIdx) {
  // Assumes `command[atIdx] === '@' && command[atIdx + 1] === "'"`
  let k = atIdx + 2;
  if (command[k] === '\r' && command[k + 1] === '\n') k += 2;
  else if (command[k] === '\n' || command[k] === '\r') k += 1;
  else return null; // Not a PowerShell here-string (`@'` must be followed directly by a newline)

  const bodyStart = k;
  let atLineStart = true;
  let lineBreakBefore = bodyStart;
  while (k < command.length) {
    if (atLineStart && command[k] === '\'' && command[k + 1] === '@') {
      return {
        closed: true,
        text: command.slice(bodyStart, lineBreakBefore),
        end: k + 2,
      };
    }
    if (command[k] === '\r' && command[k + 1] === '\n') {
      lineBreakBefore = k;
      k += 2;
      atLineStart = true;
      continue;
    }
    if (command[k] === '\n' || command[k] === '\r') {
      lineBreakBefore = k;
      k += 1;
      atLineStart = true;
      continue;
    }
    atLineStart = false;
    k++;
  }
  return { closed: false, text: '', end: command.length };
}

function scanPwshDoubleHereString(command, atIdx) {
  // Assumes `command[atIdx] === '@' && command[atIdx + 1] === '"'`
  let k = atIdx + 2;
  if (command[k] === '\r' && command[k + 1] === '\n') k += 2;
  else if (command[k] === '\n' || command[k] === '\r') k += 1;
  else return null; // Not a PowerShell here-string (`@"` must be followed directly by a newline)

  let out = '';
  const subs = [];
  let atLineStart = true;
  while (k < command.length) {
    const ch = command[k];
    if (atLineStart && ch === '"' && command[k + 1] === '@') {
      return {
        closed: true,
        text: out.replace(/\r?\n$/, ''),
        substitutions: subs,
        end: k + 2,
      };
    }
    if (ch === '`') {
      if (k + 1 >= command.length) return { closed: false, text: '', substitutions: [], end: command.length };
      if (command[k + 1] === '\r' && command[k + 2] === '\n') {
        k += 3;
        atLineStart = false;
        continue;
      }
      if (command[k + 1] === '\n' || command[k + 1] === '\r') {
        k += 2;
        atLineStart = false;
        continue;
      }
      out += command[k + 1];
      atLineStart = false;
      k += 2;
      continue;
    }
    if (ch === '$' && command[k + 1] === '(') {
      const sub = scanPwshSubexpression(command, k);
      if (!sub.closed) return { closed: false, text: '', substitutions: [], end: command.length };
      out += command.slice(k, sub.end);
      if (sub.end >= k + 3) {
        const inner = command.slice(k + 2, sub.end - 1);
        if (inner.trim()) subs.push(inner);
      }
      atLineStart = false;
      k = sub.end;
      continue;
    }
    if (ch === '\r' && command[k + 1] === '\n') {
      out += '\r\n';
      k += 2;
      atLineStart = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      out += ch;
      k += 1;
      atLineStart = true;
      continue;
    }
    out += ch;
    atLineStart = false;
    k++;
  }
  return { closed: false, text: '', substitutions: [], end: command.length };
}

function scanPwshBracedVariable(command, startIndex) {
  // Assumes `command.slice(startIndex, startIndex + 2) === '${'`
  let k = startIndex + 2;
  while (k < command.length) {
    const ch = command[k];
    if (ch === '`') {
      if (k + 1 >= command.length || command[k + 1] === '\n' || command[k + 1] === '\r') return -1;
      k += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === '{') return -1;
    if (ch === '}') return k > startIndex + 2 ? k : -1;
    k++;
  }
  return -1;
}

function scanPwshSubexpression(command, startIndex) {
  // Assumes `command[startIndex + 1] === '('` (for `$(` or `@(`)
  let depth = 1;
  let i = startIndex + 2;
  let atTokenStart = true;
  while (i < command.length && depth > 0) {
    const ch = command[i];
    if (ch === '<' && command[i + 1] === '#') {
      const closeBlk = command.indexOf('#>', i + 2);
      if (closeBlk === -1) return { end: command.length, closed: false };
      i = closeBlk + 2;
      atTokenStart = true;
      continue;
    }
    if (ch === '#' && atTokenStart) {
      while (i < command.length && command[i] !== '\n') i++;
      continue;
    }
    if (ch === '@' && command[i + 1] === '\'') {
      const hs = scanPwshSingleHereString(command, i);
      if (hs) {
        if (!hs.closed) return { end: command.length, closed: false };
        i = hs.end;
        atTokenStart = false;
        continue;
      }
    }
    if (ch === '@' && command[i + 1] === '"') {
      const hs = scanPwshDoubleHereString(command, i);
      if (hs) {
        if (!hs.closed) return { end: command.length, closed: false };
        i = hs.end;
        atTokenStart = false;
        continue;
      }
    }
    if (ch === '$' && command[i + 1] === '{') {
      const closeBrace = scanPwshBracedVariable(command, i);
      if (closeBrace === -1) return { end: command.length, closed: false };
      i = closeBrace + 1;
      atTokenStart = false;
      continue;
    }
    if (ch === '\'') {
      const endSq = findClosingPwshSingleQuote(command, i);
      if (endSq === -1) return { end: command.length, closed: false };
      i = endSq + 1;
      atTokenStart = false;
      continue;
    }
    if (ch === '"') {
      const endDq = findClosingPwshDoubleQuote(command, i);
      if (endDq === -1) return { end: command.length, closed: false };
      i = endDq + 1;
      atTokenStart = false;
      continue;
    }
    if (ch === '`') {
      if (i + 1 >= command.length) return { end: command.length, closed: false };
      i += command[i + 1] === '\r' && command[i + 2] === '\n' ? 3 : 2;
      atTokenStart = false;
      continue;
    }
    if ((ch === '$' || ch === '@') && command[i + 1] === '(') {
      depth++;
      i += 2;
      atTokenStart = true;
      continue;
    }
    if (ch === '(') {
      depth++;
      atTokenStart = true;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      atTokenStart = true;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ';' || ch === '|' || ch === '&' || ch === '{' || ch === '}') {
      atTokenStart = true;
      i++;
      continue;
    }
    atTokenStart = false;
    i++;
  }
  return { end: i, closed: depth === 0 };
}

function findClosingPwshDoubleQuote(command, openIdx) {
  let k = openIdx + 1;
  while (k < command.length) {
    const ch = command[k];
    if (ch === '`') {
      if (k + 1 >= command.length) return -1;
      k += 2;
      continue;
    }
    if (ch === '$' && command[k + 1] === '(') {
      const sub = scanPwshSubexpression(command, k);
      if (!sub.closed) return -1;
      k = sub.end;
      continue;
    }
    if (ch === '"') {
      if (command[k + 1] === '"') {
        k += 2;
        continue;
      }
      return k;
    }
    k++;
  }
  return -1;
}

function normalizePowerShellText(command) {
  return command
    .replace(/[\u2018\u2019\u201a\u201b]/g, '\'')
    .replace(/[\u201c\u201d\u201e]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-');
}

const PWSH_UNICODE_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/**
 * Parse `command` into pipelines of simple command segments:
 *   `[ [ [ { text, quoted, whollyQuoted, singleQuoted, substitutions }, ... ], ... ], ... ]`
 * Each outer array item is one pipeline (`cmd1 | cmd2`), and each inner array item is one simple
 * command segment's words.
 */
export function tokenizeShellPipelines(rawCommand, { shell = '', budget = null } = {}) {
  if (typeof rawCommand !== 'string' || !rawCommand) return [];
  if (budget?.exceeded) return [];

  const kind = normalizeShellKind(shell) || 'bash';
  const command = kind === 'powershell' ? normalizePowerShellText(rawCommand) : rawCommand;
  let lastCloseParen = -2;
  let lastCloseBrace = -2;
  const getLastCloseParen = () => {
    if (lastCloseParen === -2) lastCloseParen = command.lastIndexOf(')');
    return lastCloseParen;
  };
  const getLastCloseBrace = () => {
    if (lastCloseBrace === -2) lastCloseBrace = command.lastIndexOf('}');
    return lastCloseBrace;
  };
  const pipelines = [];
  let currentPipeline = [];
  let words = [];
  let text = '';
  let hasToken = false;
  let wasQuoted = false;
  let sawUnquotedChar = false;
  let sawNonSingleQuoted = false;
  let substitutions = [];
  let quote = '';
  const pendingHeredocs = [];

  const flushWord = () => {
    if (hasToken) {
      if (budget) {
        budget.tokens = (budget.tokens || 0) + 1;
        if (budget.maxTokens && budget.tokens > budget.maxTokens) {
          budget.exceeded = true;
        }
      }
      words.push({
        text,
        quoted: wasQuoted,
        whollyQuoted: wasQuoted && !sawUnquotedChar,
        singleQuoted: wasQuoted && !sawNonSingleQuoted,
        substitutions,
      });
    }
    text = '';
    hasToken = false;
    wasQuoted = false;
    sawUnquotedChar = false;
    sawNonSingleQuoted = false;
    substitutions = [];
  };

  const flushSegmentToPipeline = () => {
    flushWord();
    if (words.length > 0) {
      currentPipeline.push(words);
    }
    words = [];
  };

  const flushPipeline = () => {
    flushSegmentToPipeline();
    if (currentPipeline.length > 0) {
      pipelines.push(currentPipeline);
    }
    currentPipeline = [];
  };

  let i = 0;
  while (i < command.length) {
    if (budget?.exceeded) break;
    const ch = command[i];

    if (quote === '\'') {
      if (kind === 'powershell' && ch === '\'' && command[i + 1] === '\'') {
        text += '\'';
        i += 2;
        continue;
      }
      if (ch === '\'') quote = '';
      else text += ch;
      i++;
      continue;
    }

    if (quote === '"') {
      if (kind === 'powershell') {
        if (ch === '`' && i + 1 < command.length) {
          if (command[i + 1] === '\r' && command[i + 2] === '\n') {
            i += 3;
            continue;
          }
          if (command[i + 1] === '\n' || command[i + 1] === '\r') {
            i += 2;
            continue;
          }
          text += command[i + 1];
          i += 2;
          continue;
        }
        if (ch === '$' && command[i + 1] === '(') {
          const sub = scanPwshSubexpression(command, i);
          text += command.slice(i, sub.end);
          if (sub.closed && sub.end >= i + 3) {
            const inner = command.slice(i + 2, sub.end - 1);
            if (inner.trim()) substitutions.push(inner);
          }
          i = sub.end;
          continue;
        }
        if (ch === '"') {
          if (command[i + 1] === '"') {
            text += '"';
            i += 2;
            continue;
          }
          quote = '';
        } else {
          text += ch;
        }
        i++;
        continue;
      }

      // `cmd`: every `"` toggles quote state 1-to-1
      if (ch === '"') {
        quote = '';
      } else {
        text += ch;
      }
      i++;
      continue;
    }

    // `cmd` leading `@` echo-suppression operator (`@git push --force`, `@cortex-work release`)
    if (kind === 'cmd' && ch === '@' && !hasToken && words.length === 0) {
      i++;
      continue;
    }

    // PowerShell block comment `<# ... #>`
    if (kind === 'powershell' && ch === '<' && command[i + 1] === '#') {
      flushWord();
      const closeBlk = command.indexOf('#>', i + 2);
      i = closeBlk !== -1 ? closeBlk + 2 : i + 2;
      continue;
    }

    // PowerShell here-strings `@'\n...\n'@` and `@"\n...\n"@`
    if (kind === 'powershell' && ch === '@' && (command[i + 1] === '\'' || command[i + 1] === '"')) {
      if (command[i + 1] === '\'') {
        const hs = scanPwshSingleHereString(command, i);
        if (hs) {
          if (hs.closed) {
            text += hs.text;
            hasToken = true;
            wasQuoted = true;
            i = hs.end;
          } else {
            i += 2;
          }
          continue;
        }
      } else {
        const hs = scanPwshDoubleHereString(command, i);
        if (hs) {
          if (hs.closed) {
            text += hs.text;
            substitutions.push(...hs.substitutions);
            hasToken = true;
            wasQuoted = true;
            sawNonSingleQuoted = true;
            i = hs.end;
          } else {
            i += 2;
          }
          continue;
        }
      }
    }

    // Bash ANSI-C quoting `$'...'`
    if (kind === 'bash' && ch === '$' && command[i + 1] === '\'') {
      const closeAnsi = findClosingBashAnsiSingleQuote(command, i);
      if (closeAnsi !== -1) {
        text += decodeBashAnsiSingleQuote(command.slice(i + 2, closeAnsi));
        hasToken = true;
        wasQuoted = true;
        i = closeAnsi + 1;
        continue;
      }
      // Unclosed `$'` — do not treat as quoted so following commands remain inspectable.
      i += 2;
      continue;
    }

    // Bash locale translation quoting `$"..."`
    if (kind === 'bash' && ch === '$' && command[i + 1] === '"') {
      const dq = scanBashDoubleQuote(command, i + 1);
      if (dq.closeIdx !== -1) {
        text += dq.text;
        substitutions.push(...dq.substitutions);
        hasToken = true;
        wasQuoted = true;
        sawNonSingleQuoted = true;
        i = dq.closeIdx + 1;
        continue;
      }
      i += 2;
      continue;
    }

    // POSIX `<<<` here-string vs `<<` / `<<-` heredoc operator
    if (kind === 'bash' && ch === '<' && command[i + 1] === '<') {
      flushWord();
      if (command[i + 2] === '<') {
        while (i < command.length && command[i] === '<') i++;
        continue;
      }
      const hd = scanBashHeredocOperator(command, i);
      if (hd.spec) pendingHeredocs.push(hd.spec);
      i = hd.nextIndex;
      continue;
    }

    if (kind !== 'cmd' && ch === '\'') {
      const closeIdx = kind === 'powershell'
        ? findClosingPwshSingleQuote(command, i)
        : command.indexOf('\'', i + 1);
      if (closeIdx !== -1) {
        quote = '\'';
        hasToken = true;
        wasQuoted = true;
      }
      // If unclosed (`closeIdx === -1`), do not swallow remaining tokens into a quoted string.
      i++;
      continue;
    }

    if (ch === '"') {
      if (kind === 'bash') {
        const dq = scanBashDoubleQuote(command, i);
        if (dq.closeIdx !== -1) {
          text += dq.text;
          substitutions.push(...dq.substitutions);
          hasToken = true;
          wasQuoted = true;
          sawNonSingleQuoted = true;
          i = dq.closeIdx + 1;
          continue;
        }
        // Unclosed `"` — skip the stray `"` so following commands/flags stay inspectable.
        i++;
        continue;
      }

      const closeIdx = kind === 'powershell'
        ? findClosingPwshDoubleQuote(command, i)
        : command.indexOf('"', i + 1);
      if (closeIdx !== -1) {
        quote = '"';
        hasToken = true;
        wasQuoted = true;
        sawNonSingleQuoted = true;
      }
      i++;
      continue;
    }

    // Braced variable / parameter expansion (`${env:TEMP}` in PowerShell, `${TMPDIR}` / `${x:-...}` in Bash)
    if (kind !== 'cmd' && ch === '$' && command[i + 1] === '{') {
      if (kind === 'powershell') {
        const closeBrace = i + 2 <= getLastCloseBrace() ? scanPwshBracedVariable(command, i) : -1;
        if (closeBrace !== -1) {
          text += command.slice(i, closeBrace + 1);
          hasToken = true;
          sawUnquotedChar = true;
          sawNonSingleQuoted = true;
          i = closeBrace + 1;
          continue;
        }
      } else {
        const param = i + 2 <= getLastCloseBrace()
          ? scanBashParameterExpansion(command, i, { inDoubleQuote: false })
          : { end: command.length, closed: false, substitutions: [] };
        if (param.closed) {
          text += command.slice(i, param.end);
          substitutions.push(...param.substitutions);
          hasToken = true;
          sawUnquotedChar = true;
          sawNonSingleQuoted = true;
          i = param.end;
          continue;
        }
        flushPipeline();
        i += 2;
        continue;
      }
    }

    // Command/process/array subexpressions (`$(...)` in Bash/PowerShell, `<(...)`/`>(...)` in Bash, `@(...)` in PowerShell)
    if (
      (kind !== 'cmd' && ch === '$' && command[i + 1] === '(')
      || (kind === 'bash' && (ch === '<' || ch === '>') && command[i + 1] === '(')
      || (kind === 'powershell' && ch === '@' && command[i + 1] === '(')
    ) {
      const sub = i + 2 <= getLastCloseParen()
        ? (kind === 'powershell' ? scanPwshSubexpression(command, i) : scanBashCommandSubstitution(command, i))
        : { end: command.length, closed: false };
      if (sub.closed) {
        text += command.slice(i, sub.end);
        hasToken = true;
        sawUnquotedChar = true;
        sawNonSingleQuoted = true;
        if (sub.end >= i + 3) {
          const inner = command.slice(i + 2, sub.end - 1);
          if (inner.trim()) substitutions.push(inner);
        }
        i = sub.end;
        continue;
      }
      // Unclosed `$(` / `<(` / `@(` — never swallow the remainder as an argument word.
      flushPipeline();
      i += 2;
      continue;
    }

    if (ch === '`') {
      if (kind === 'powershell') {
        if (command[i + 1] === '\n' || command[i + 1] === '\r') {
          i += command[i + 1] === '\r' && command[i + 2] === '\n' ? 3 : 2;
          continue;
        }
        if (i + 1 < command.length) {
          text += command[i + 1];
          hasToken = true;
          sawUnquotedChar = true;
          sawNonSingleQuoted = true;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      if (kind === 'bash') {
        const bt = skipBacktickSubstitution(command, i, { inDoubleQuote: false });
        if (bt.closed) {
          text += command.slice(i, bt.end);
          hasToken = true;
          sawUnquotedChar = true;
          sawNonSingleQuoted = true;
          if (bt.inner.trim()) {
            substitutions.push(bt.inner);
          }
          i = bt.end;
          continue;
        }
        // Unclosed backtick in bash: if followed by a line break, treat as line continuation; otherwise
        // split the pipeline so any command after the stray backtick remains inspectable.
        if (command[i + 1] === '\n' || command[i + 1] === '\r') {
          i += command[i + 1] === '\r' && command[i + 2] === '\n' ? 3 : 2;
          continue;
        }
        flushPipeline();
        i++;
        continue;
      }
      // `cmd`: backtick is an ordinary character (falls through below)
    }

    if (ch === ' ' || ch === '\t' || (kind === 'powershell' && PWSH_UNICODE_SPACE_RE.test(ch))) {
      flushWord();
      i++;
      continue;
    }

    // PowerShell variable assignment without spaces (`$out=git push --force`)
    if (kind === 'powershell' && ch === '=' && hasToken && !wasQuoted && text.startsWith('$')) {
      flushWord();
      words.push({ text: '=', quoted: false, whollyQuoted: false, singleQuoted: false, substitutions: [] });
      i++;
      continue;
    }

    if (kind !== 'cmd' && ch === '#' && !hasToken) {
      while (i < command.length && command[i] !== '\n') i++;
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      flushPipeline();
      if (ch === '\r' && command[i + 1] === '\n') i += 2;
      else i++;
      // Skip heredoc bodies queued on the line that just ended (only when closing delimiter line exists)
      if (pendingHeredocs.length > 0 && i < command.length) {
        const skipped = skipPendingHeredocBodies(command, i, pendingHeredocs);
        i = skipped.nextIndex;
        if (skipped.bodySubstitutions.length > 0) {
          pipelines.push([[{
            text: '',
            quoted: true,
            whollyQuoted: true,
            singleQuoted: false,
            substitutions: skipped.bodySubstitutions,
          }]]);
        }
      }
      continue;
    }

    if (ch === '|' && command[i + 1] !== '|') {
      flushSegmentToPipeline();
      i++;
      if (command[i] === '&') i++; // `|&`
      continue;
    }

    // Keep `{}` placeholder token intact (`find ... -exec rm {} -rf +`, `xargs -I {} ...`)
    if (ch === '{' && command[i + 1] === '}') {
      text += '{}';
      hasToken = true;
      sawUnquotedChar = true;
      sawNonSingleQuoted = true;
      i += 2;
      continue;
    }

    // In POSIX shells `{` and `}` only group commands when standalone words (`{ cmd; }`), keeping
    // in-word braces (`git -c x={y}`, `HEAD@{1}`, `stash@{0}`, `rm -{r,f}`) intact.
    if (kind === 'bash' && (ch === '{' || ch === '}')) {
      if (!hasToken && (i + 1 >= command.length || /[\s;|&()\r\n]/.test(command[i + 1]))) {
        flushPipeline();
        i++;
        continue;
      }
      text += ch;
      hasToken = true;
      sawUnquotedChar = true;
      sawNonSingleQuoted = true;
      i++;
      continue;
    }

    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      flushPipeline();
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i += 2;
      else i++;
      continue;
    }

    // bash: outside quotes a backslash makes the next character literal (`\;`, `\'`, `\"`, `\ `). Without
    // this, `echo Don\'t; <command>; echo It\'s` would read the two `\'` as one quoted string and hide the
    // command between them. A backslash before a line break is a continuation (handled below).
    if (
      kind === 'bash' && ch === '\\' && i + 1 < command.length
      && command[i + 1] !== '\n' && command[i + 1] !== '\r'
    ) {
      text += command[i + 1];
      hasToken = true;
      sawUnquotedChar = true;
      sawNonSingleQuoted = true;
      i += 2;
      continue;
    }

    // cmd: outside quotes a caret `^` escapes the next character (`^"`, `^&`, `^|`, `^^`) so `^"` never
    // opens a double-quoted string. A caret before a line break is a continuation (handled below).
    if (
      kind === 'cmd' && ch === '^' && i + 1 < command.length
      && command[i + 1] !== '\n' && command[i + 1] !== '\r'
    ) {
      text += command[i + 1];
      hasToken = true;
      sawUnquotedChar = true;
      sawNonSingleQuoted = true;
      i += 2;
      continue;
    }

    if (
      ((kind === 'bash' && ch === '\\') || (kind === 'cmd' && ch === '^'))
      && i + 1 < command.length
      && (command[i + 1] === '\n' || command[i + 1] === '\r')
    ) {
      i += command[i + 1] === '\r' && command[i + 2] === '\n' ? 3 : 2;
      continue;
    }

    text += ch;
    hasToken = true;
    sawUnquotedChar = true;
    sawNonSingleQuoted = true;
    i++;
  }

  flushPipeline();
  return pipelines;
}

export function tokenizeShellSegments(command, options) {
  return tokenizeShellPipelines(command, options).flat();
}

/**
 * True when `words[index]` can act as a trigger command word in conservative unquoted-word inspection:
 * - any unquoted word (`!tok.quoted`) that is neither a flag (`-...`) nor an inline `KEY=VALUE` assignment;
 * - a wholly-quoted executable path at the start of a segment (`"C:\\...\\git.exe" ...`) or right after
 *   PowerShell/POSIX call/dot operators (`&`, `.`, `source`).
 */
export function isCandidateCommandWord(words, index) {
  const tok = words[index];
  if (!tok || !tok.text) return false;
  if (tok.text.startsWith('-')) return false;
  if (!tok.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.text)) return false;
  if (!tok.quoted) return true;
  if (!tok.whollyQuoted) return false;
  if (index === 0) return true;
  const prev = words[index - 1];
  return Boolean(prev && !prev.quoted && (prev.text === '&' || prev.text === '.' || prev.text === 'source'));
}

export const PWSH_FLAGS_WITH_VALUE = new Set([
  '-executionpolicy',
  '-ep',
  '-outputformat',
  '-of',
  '-inputformat',
  '-if',
  '-windowstyle',
  '-w',
  '-configurationname',
]);

function isPwshEncodedCommandFlag(lower) {
  return lower === '-ec' || (lower.length >= 2 && '-encodedcommand'.startsWith(lower));
}

function joinShellScriptArgs(tailArgs, { attached = '' } = {}) {
  if (!attached && tailArgs.length === 1) {
    return tailArgs[0].text.trim();
  }
  const parts = [];
  if (attached) parts.push(attached);
  for (const w of tailArgs) {
    if (w.quoted && /\s/.test(w.text)) {
      parts.push(`"${w.text}"`);
    } else {
      parts.push(w.text);
    }
  }
  return parts.join(' ').trim();
}

/**
 * Extract nested shell command strings executed inside `words` together with their inner shell kind
 * (`{ command, shell }`), covering `sh -c` / `bash -lc`, `cmd /c` / `/k` / `//c` / `/c"..."`,
 * `powershell` / `pwsh` `-c` / `-Command`, `eval`, `iex` / `Invoke-Expression`, and `$(...)` / backtick
 * command substitutions regardless of where the shell verb appears in `words`.
 */
export function extractNestedShellCommands(words, outerShell = '', { candidateIndices = null } = {}) {
  const outerKind = normalizeShellKind(outerShell) || 'bash';
  const nested = [];

  for (const tok of words) {
    if (Array.isArray(tok.substitutions) && tok.substitutions.length > 0) {
      for (const sub of tok.substitutions) {
        if (typeof sub === 'string' && sub.trim()) {
          nested.push({ command: sub, shell: outerKind });
        }
      }
    }
  }

  for (let k = 0; k < words.length; k++) {
    if (candidateIndices ? !candidateIndices.has(k) : !isCandidateCommandWord(words, k)) continue;

    const bare = stripExeSuffix(executableBaseName(words[k].text));

    if (POSIX_SHELLS.has(bare)) {
      for (let i = k + 1; i < words.length; i++) {
        const a = words[i].text;
        if (a === '--') break;
        if (a === '-c' || /^-[A-Za-z]*c$/.test(a)) {
          if (i + 1 < words.length && words[i + 1].text.trim()) {
            nested.push({ command: words[i + 1].text, shell: 'bash' });
          }
          break;
        }
        if (a === '-O' || a === '+O' || a === '--rcfile' || a === '--init-file') {
          i++;
          continue;
        }
        if (!a.startsWith('-')) break;
      }
      continue;
    }

    if (bare === 'cmd') {
      for (let i = k + 1; i < words.length; i++) {
        const m = /^\/{1,2}[ck]([\s\S]*)$/i.exec(words[i].text);
        if (m) {
          const rest = joinShellScriptArgs(words.slice(i + 1), { attached: m[1].trim() });
          if (rest) nested.push({ command: rest, shell: 'cmd' });
          break;
        }
      }
      continue;
    }

    if (PWSH_SHELLS.has(bare)) {
      for (let i = k + 1; i < words.length; i++) {
        const lower = words[i].text.toLowerCase();
        if (lower === '-file' || lower === '-f' || isPwshEncodedCommandFlag(lower)) {
          break;
        }
        if (lower.length >= 2 && '-command'.startsWith(lower)) {
          const rest = joinShellScriptArgs(words.slice(i + 1));
          if (rest) nested.push({ command: rest, shell: 'powershell' });
          break;
        }
        if (PWSH_FLAGS_WITH_VALUE.has(lower)) {
          i++;
          continue;
        }
        if (lower.startsWith('-')) continue;
        const rest = joinShellScriptArgs(words.slice(i));
        if (rest) nested.push({ command: rest, shell: 'powershell' });
        break;
      }
      continue;
    }

    if (bare === 'eval' && outerKind !== 'cmd') {
      let start = k + 1;
      if (words[start] && !words[start].quoted && words[start].text === '--') start++;
      if (start < words.length) {
        const rest = words.slice(start).map((w) => w.text).join(' ').trim();
        if (rest) {
          nested.push({ command: rest, shell: outerKind === 'powershell' ? 'powershell' : 'bash' });
        }
      }
      continue;
    }

    if (bare === 'iex' || bare === 'invoke-expression') {
      let i = k + 1;
      while (i < words.length) {
        const lower = words[i].text.toLowerCase();
        if (lower.length >= 2 && '-command'.startsWith(lower)) {
          i++;
          break;
        }
        if (lower.startsWith('-')) {
          i++;
          continue;
        }
        break;
      }
      if (i < words.length) {
        const rest = words[i].text.trim();
        if (rest) nested.push({ command: rest, shell: 'powershell' });
      }
    }
  }

  return nested;
}
