/**
 * Recognizing shell command lines that only read.
 *
 * The PreToolUse hook asks the user before a shell command touches the approvals files, and it decides that
 * from the text of the command. Reading those files (or the source of the approval command line) is
 * harmless, so a command line that is recognizably read-only is let through without a question.
 *
 * "Recognizably read-only" is deliberately narrow: every simple command of the line (the parts between
 * `|`, `;`, `&`, `&&`, `||` and line breaks) must start with a program from the allow-lists below, and the
 * line must contain no redirection (`<`, `>`), no substitution or grouping (`$(...)`, backticks, parentheses,
 * braces), no comment and no unterminated quote. Whatever is not recognized is simply "not known to be
 * read-only": the caller then keeps its usual, careful behavior.
 */

/** Programs that only read (compared in lower case, an `.exe` ending is ignored, no folder part allowed). */
export const READ_ONLY_SHELL_VERBS = Object.freeze([
  'cat', 'type', 'more', 'less', 'head', 'tail',
  'get-content', 'gc',
  'select-string', 'sls', 'grep', 'rg', 'findstr',
  'ls', 'dir', 'get-childitem', 'gci', 'get-item', 'gi',
  'stat', 'wc',
]);

/** `git <subcommand>` forms that only read (the subcommand must be the first argument). */
export const READ_ONLY_GIT_SUBCOMMANDS = Object.freeze(['diff', 'log', 'show', 'status', 'blame', 'grep']);

const VERB_SET = new Set(READ_ONLY_SHELL_VERBS);
const GIT_SUBCOMMAND_SET = new Set(READ_ONLY_GIT_SUBCOMMANDS);

// Options that make an otherwise read-only program write a file or start another program.
const UNSAFE_OPTION_PREFIXES = Object.freeze({
  git: ['--output', '-O', '--open-files-in-pager', '--ext-diff'],
  rg: ['--pre', '--hostname-bin'],
  less: ['-o', '-O', '--log-file', '-k', '--lesskey', '+'],
  more: ['+'],
});

/**
 * Split a command line into its simple commands: [[word, ...], ...] with quotes removed, or null when the
 * line contains anything beyond plain commands joined by `|`, `;`, `&`, `&&`, `||` or line breaks.
 * One forward pass over the text.
 */
export function splitPlainCommands(command) {
  if (typeof command !== 'string') return null;
  const segments = [];
  let words = [];
  let word = '';
  let hasWord = false;
  let quote = '';

  const endWord = () => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote === '\'') {
      if (ch === '\'') quote = '';
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = '';
      } else if (ch === '`' || (ch === '$' && command[i + 1] === '(')) {
        return null; // substitution inside double quotes
      } else {
        word += ch;
      }
      continue;
    }

    switch (ch) {
      case '\'':
      case '"':
        quote = ch;
        hasWord = true;
        break;
      case ' ':
      case '\t':
        endWord();
        break;
      case '|':
      case ';':
      case '&':
      case '\n':
      case '\r':
        endSegment();
        break;
      case '<':
      case '>':
      case '(':
      case ')':
      case '{':
      case '}':
      case '`':
        return null; // redirection, grouping, substitution
      case '#':
        if (!hasWord) return null; // a comment: not analysed
        word += ch;
        break;
      default:
        word += ch;
        hasWord = true;
    }
  }
  if (quote) return null;
  endSegment();
  return segments;
}

function isReadOnlySegment(words) {
  const first = words[0];
  if (/[\\/]/.test(first)) return false; // only programs called by bare name
  const verb = first.toLowerCase().replace(/\.exe$/, '');
  const args = words.slice(1);

  const unsafe = UNSAFE_OPTION_PREFIXES[verb] || [];
  if (args.some((arg) => unsafe.some((prefix) => arg.startsWith(prefix)))) return false;

  if (verb === 'git') {
    return args.length > 0 && GIT_SUBCOMMAND_SET.has(args[0].toLowerCase());
  }
  return VERB_SET.has(verb);
}

/**
 * True when the command line is recognizably read-only (see the top of this file). False means "not
 * recognized", not "known to write".
 */
export function isReadOnlyShellCommand(command) {
  const segments = splitPlainCommands(command);
  if (!segments || segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}
