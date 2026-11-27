import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { sanitizeInline } from '../core/budget.mjs';
import { recordConfirmPatternProblem } from '../core/config.mjs';
import {
  PWSH_FLAGS_WITH_VALUE,
  executableBaseName,
  extractNestedShellCommands,
  isCandidateCommandWord,
  normalizeShellKind,
  stripExeSuffix,
  tokenizeShellPipelines,
} from './shell-tokens.mjs';

/**
 * Host-independent detector for hard-to-reverse shell commands (2-5), using conservative unquoted-word
 * matching at any position inside a tokenized command segment (plus nested shells, `eval`/`iex`, and `$()`):
 * - Destructive git operations (`push --force` / `-f` / `--force-with-lease` / `--delete` / `--mirror` /
 *   `:branch` / `+refspec`, `reset --hard`, `clean -f`, `checkout -- <path>`, working-tree `restore`,
 *   `branch -D`, `stash drop|clear`, `rebase` excluding in-progress control flags, `filter-branch`,
 *   `reflog expire`, `gc --prune`)
 * - Publishing / deployment (`npm`/`pnpm`/`yarn publish`, `gh release create`, `gh pr merge`,
 *   `gh repo delete`, `docker push`)
 * - Recursive deletion (`rm -r`/`-rf`, `Remove-Item` & aliases `-Recurse`, `rmdir /s` / `rd /s` in `cmd`
 *   context, `del /s` / `erase /s`, `rimraf`, `xargs` recursive delete, `find ... -exec rm -r...`,
 *   `find ... -delete`), except when every target unambiguously resolves underneath a system temporary
 *   directory for that shell's variable syntax
 * - Uninspectable encoded PowerShell commands (`powershell`/`pwsh` `-EncodedCommand` / `-enc` / `-e` / `-ec`)
 * - Destructive SQL executed from the command line (`DROP TABLE`, `DROP DATABASE`, `TRUNCATE`)
 * - User-configured regular expressions (`workSize.confirmCommandPatterns`) with per-pattern (50ms) and
 *   total (200ms) execution timeouts via `node:vm` (timeout asks/denies and reports a config problem)
 */

export const CONFIRM_COMMAND_REASON_MAX_CHARS = 300;
export const CONFIRM_PATTERN_TIMEOUT_MS = 50;
export const CONFIRM_PATTERNS_TOTAL_TIMEOUT_MS = 200;
export const MAX_SHELL_INSPECTION_STEPS = 5000;

const MAX_NESTED_SHELL_DEPTH = 4;

const UNINSPECTABLE_COMMAND_MATCH = Object.freeze({
  rule: 'inspection_limit',
  label: '명령이 너무 길거나 복잡해 검사를 끝내지 못했다',
});

export function createShellInspectionBudget(maxSteps = MAX_SHELL_INSPECTION_STEPS) {
  const limit = typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps > 0
    ? Math.floor(maxSteps)
    : MAX_SHELL_INSPECTION_STEPS;
  return {
    steps: 0,
    maxSteps: limit,
    tokens: 0,
    maxTokens: limit * 4,
    exceeded: false,
  };
}

function consumeInspectionStep(budget, count = 1) {
  if (!budget) return false;
  if (budget.exceeded) return true;
  budget.steps += count;
  if (budget.steps > budget.maxSteps) {
    budget.exceeded = true;
    return true;
  }
  return false;
}

const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
]);

const GIT_PUSH_OPTS_WITH_VALUE = new Set([
  '--repo',
  '--receive-pack',
  '--exec',
  '-o',
  '--push-option',
]);

const GIT_REBASE_IN_PROGRESS_OPTS = new Set([
  '--abort',
  '--continue',
  '--skip',
  '--quit',
  '--edit-todo',
  '--show-current-patch',
]);

const NPM_GLOBAL_OPTS_WITH_VALUE = new Set([
  '--prefix',
  '-C',
  '--userconfig',
  '--globalconfig',
  '--cache',
  '--registry',
  '--tag',
  '--otp',
  '--workspace',
  '-w',
]);

const PWSH_SHELLS = new Set(['powershell', 'pwsh']);

const ARG_CONSUMING_COMMANDS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'findstr',
  'select-string',
  'sls',
]);

const PKG_MANAGER_EXEC_SUBCOMMANDS = Object.freeze({
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['dlx', 'exec']),
  yarn: new Set(['dlx', 'exec']),
  bun: new Set(['x']),
});

const PKG_MANAGER_GLOBAL_OPTS_WITH_VALUE = new Set([
  ...NPM_GLOBAL_OPTS_WITH_VALUE,
  '--cwd',
  '--dir',
  '--filter',
  '-F',
  '--config',
]);

const YARN_FOREACH_OPTS_WITH_VALUE = new Set([
  '--include',
  '--exclude',
  '--from',
  '-j',
  '--jobs',
]);

function findPackageManagerExecSubcommandIndex(bare, words, startIdx) {
  const execSubs = PKG_MANAGER_EXEC_SUBCOMMANDS[bare];
  if (!execSubs) return -1;
  let idx = startIdx;
  while (idx < words.length) {
    const tok = words[idx];
    const t = tok.text;
    if (!tok.quoted && t === '--') return -1;
    if (t === '-h' || t === '--help' || t === '-v' || t === '--version') return -1;
    if (PKG_MANAGER_GLOBAL_OPTS_WITH_VALUE.has(t)) {
      idx += 2;
      continue;
    }
    if (t.startsWith('-')) {
      idx++;
      continue;
    }
    return execSubs.has(t.toLowerCase()) ? idx : -1;
  }
  return -1;
}

function findEmbeddedCommandResumeIndex(bare, words, startIdx) {
  if (bare === 'git') {
    for (let i = startIdx; i < words.length; i++) {
      if (words[i].text.toLowerCase() === 'submodule') {
        for (let j = i + 1; j < words.length; j++) {
          if (words[j].text.toLowerCase() === 'foreach') {
            let lastIdx = j;
            while (lastIdx + 1 < words.length) {
              const nextLower = words[lastIdx + 1].text.toLowerCase();
              if (nextLower === '--recursive' || nextLower === '-q' || nextLower === '--quiet') {
                lastIdx++;
              } else {
                break;
              }
            }
            return lastIdx;
          }
        }
        break;
      }
    }
    for (let i = startIdx; i < words.length; i++) {
      if (words[i].text.toLowerCase() === 'bisect') {
        for (let j = i + 1; j < words.length; j++) {
          if (words[j].text.toLowerCase() === 'run') {
            return j;
          }
        }
        break;
      }
    }
    return -1;
  }

  if (bare === 'yarn') {
    let idx = startIdx;
    while (idx < words.length && words[idx].text.startsWith('-')) {
      idx++;
    }
    if (idx >= words.length) return -1;
    const first = words[idx].text.toLowerCase();
    if (first === 'workspace') {
      return idx + 1 < words.length ? idx + 1 : -1;
    }
    if (first === 'workspaces' && idx + 1 < words.length && words[idx + 1].text.toLowerCase() === 'foreach') {
      let lastIdx = idx + 1;
      while (lastIdx + 1 < words.length && words[lastIdx + 1].text.startsWith('-')) {
        const opt = words[lastIdx + 1].text.toLowerCase();
        lastIdx++;
        if (YARN_FOREACH_OPTS_WITH_VALUE.has(opt) && lastIdx + 1 < words.length) {
          lastIdx++;
        }
      }
      return lastIdx;
    }
    return -1;
  }

  if (bare === 'pnpm') {
    let idx = startIdx;
    while (idx < words.length) {
      const t = words[idx].text;
      if (PKG_MANAGER_GLOBAL_OPTS_WITH_VALUE.has(t)) {
        idx += 2;
        continue;
      }
      if (t.startsWith('-')) {
        idx++;
        continue;
      }
      break;
    }
    if (idx >= words.length) return -1;
    const first = words[idx].text.toLowerCase();
    if (first !== 'recursive' && first !== 'multi' && first !== 'm') return -1;
    idx++;
    while (idx < words.length) {
      const t = words[idx].text;
      if (PKG_MANAGER_GLOBAL_OPTS_WITH_VALUE.has(t)) {
        idx += 2;
        continue;
      }
      if (t.startsWith('-')) {
        idx++;
        continue;
      }
      break;
    }
    if (idx < words.length && words[idx].text.toLowerCase() === 'exec') {
      return idx;
    }
    return -1;
  }

  return -1;
}

const XARGS_OPTS_WITH_VALUE = new Set([
  '-I',
  '-L',
  '-n',
  '-P',
  '-s',
  '-a',
  '-d',
  '-E',
  '-J',
  '--arg-file',
  '--delimiter',
  '--eof',
  '--max-args',
  '--max-lines',
  '--max-procs',
  '--max-chars',
  '--process-slot-var',
]);

const GH_GLOBAL_OPTS_WITH_VALUE = new Set(['-R', '--repo', '--hostname']);

const DOCKER_GLOBAL_OPTS_WITH_VALUE = new Set([
  '-H',
  '--host',
  '-c',
  '--context',
  '--config',
  '-l',
  '--log-level',
]);

const DB_CLI_NAMES = new Set([
  'sqlite3',
  'psql',
  'mysql',
  'mariadb',
  'sqlcmd',
  'duckdb',
  'cockroach',
  'clickhouse-client',
  'snowsql',
  'turso',
  'invoke-sqlcmd',
  'invoke-sqlitequery',
]);

const INLINE_EVAL_BINS = new Set(['node', 'python', 'python3', 'py', 'ruby', 'php']);

const SQL_DESTRUCTIVE_RE = /\b(?:DROP\s+(?:TABLE|DATABASE)\b|TRUNCATE\s+TABLE\b|TRUNCATE\s+[A-Za-z_"`[\]][A-Za-z0-9_."`[\]]*\s*(?:;|CASCADE\b|RESTRICT\b|CONTINUE\b|RESTART\b|$))/i;
const SCRIPT_SQL_EXEC_RE = /(?:\.(?:exec|execute|query|run)|execute_sql|cursor\.execute)\s*\([\s\S]*?\b(?:DROP\s+(?:TABLE|DATABASE)\b|TRUNCATE\s+(?:TABLE\b|[A-Za-z_"`[\]]))/i;

let regexVmState = null;

function getRegexVmState() {
  if (!regexVmState) {
    const context = vm.createContext({ re: null, input: '' });
    const script = new vm.Script('re.test(input)');
    regexVmState = { context, script };
  }
  return regexVmState;
}

function clipInline(value, maxChars) {
  const clean = sanitizeInline(value);
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 3) return clean.slice(0, Math.max(0, maxChars));
  return `${clean.slice(0, maxChars - 3)}...`;
}

function getEnvCaseInsensitive(env, name) {
  if (!env || typeof env !== 'object') return '';
  if (typeof env[name] === 'string' && env[name].trim()) return env[name].trim();
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower && typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function getEnvExactOrWin(env, name) {
  if (!env || typeof env !== 'object') return '';
  if (typeof env[name] === 'string' && env[name].trim()) return env[name].trim();
  // On Windows, `TEMP` and `TMP` in `process.env` may appear as `Temp` / `Tmp`; `TMPDIR` is POSIX-named.
  if (process.platform === 'win32' && (name === 'TEMP' || name === 'TMP')) {
    return getEnvCaseInsensitive(env, name);
  }
  return '';
}

function resolveRealPathLenient(targetPath) {
  const resolved = path.resolve(String(targetPath));
  const tail = [];
  let cursor = resolved;
  while (true) {
    try {
      const realCursor = fs.realpathSync.native(cursor);
      return tail.length > 0 ? path.join(realCursor, ...tail.reverse()) : realCursor;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const parent = path.dirname(cursor);
        if (parent === cursor) return resolved;
        tail.push(path.basename(cursor));
        cursor = parent;
        continue;
      }
      return resolved;
    }
  }
}

function comparablePath(p) {
  const real = resolveRealPathLenient(p);
  const norm = process.platform === 'win32'
    ? real.split(/[\\/]+/).map((s) => s.replace(/[. ]+$/, '') || s).join(path.sep).toLowerCase()
    : real;
  const root = path.parse(norm).root;
  return norm.length > root.length ? norm.replace(/[\\/]+$/, '') : norm;
}

function collectSystemTempRoots(env) {
  const roots = new Set();
  const addCandidate = (dir) => {
    if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0')) return;
    const trimmed = dir.trim();
    if (!path.isAbsolute(trimmed)) return;
    roots.add(comparablePath(trimmed));
  };

  addCandidate(os.tmpdir());
  for (const varName of ['TEMP', 'TMP', 'TMPDIR']) {
    addCandidate(getEnvCaseInsensitive(env, varName));
  }
  if (process.platform !== 'win32') {
    addCandidate('/tmp');
    addCandidate('/var/tmp');
    addCandidate('/private/tmp');
  }
  return [...roots];
}

function expandLeadingTempVar(rawPath, env, shellKind) {
  // Never fall back to `os.tmpdir()` when the referenced variable is unset in `env`
  // (e.g. unset `$TMPDIR/x` in bash expands to `/x`, NOT a temp directory).
  const resolveConfiguredVar = (varName, { exact = false } = {}) => {
    const val = exact ? getEnvExactOrWin(env, varName) : getEnvCaseInsensitive(env, varName);
    if (!val || (!path.isAbsolute(val) && !(process.platform === 'win32' && /^\/(?:var\/)?tmp(?:\/|$)/i.test(val)))) {
      return '';
    }
    return val;
  };

  if (shellKind === 'powershell') {
    // In PowerShell only `$env:TEMP` / `$env:TMP` / `${env:TEMP}` access environment variables;
    // `$TEMP` is an ordinary PowerShell variable (typically `$null`).
    const m = /^(?:\$env:(TEMP|TMP|TMPDIR)|\$\{env:(TEMP|TMP|TMPDIR)\})(?=[\\/])/i.exec(rawPath);
    if (!m) return rawPath;
    const base = resolveConfiguredVar(m[1] || m[2], { exact: false });
    if (!base) return rawPath;
    return `${base.replace(/[\\/]+$/, '')}${rawPath.slice(m[0].length)}`;
  }

  if (shellKind === 'cmd') {
    const m = /^%(TEMP|TMP)%(?=[\\/])/i.exec(rawPath);
    if (!m) return rawPath;
    const base = resolveConfiguredVar(m[1], { exact: false });
    if (!base) return rawPath;
    return `${base.replace(/[\\/]+$/, '')}${rawPath.slice(m[0].length)}`;
  }

  if (shellKind === 'bash') {
    const m = /^(?:\$\{(TEMP|TMP|TMPDIR)\}|\$(TEMP|TMP|TMPDIR))(?=[\\/])/.exec(rawPath);
    if (!m) return rawPath;
    const base = resolveConfiguredVar(m[1] || m[2], { exact: true });
    if (!base) return rawPath;
    return `${base.replace(/[\\/]+$/, '')}${rawPath.slice(m[0].length)}`;
  }

  // Unknown shell (direct helper call without `shell`): accept shell-standard forms only when set in `env`
  const unknownPatterns = [
    { re: /^(?:\$env:(TEMP|TMP|TMPDIR)|\$\{env:(TEMP|TMP|TMPDIR)\})(?=[\\/])/i, getVar: (m) => m[1] || m[2], exact: false },
    { re: /^%(TEMP|TMP)%(?=[\\/])/i, getVar: (m) => m[1], exact: false },
    { re: /^(?:\$\{(TEMP|TMP|TMPDIR)\}|\$(TEMP|TMP|TMPDIR))(?=[\\/])/, getVar: (m) => m[1] || m[2], exact: true },
  ];
  for (const { re, getVar, exact } of unknownPatterns) {
    const match = re.exec(rawPath);
    if (match) {
      const base = resolveConfiguredVar(getVar(match), { exact });
      if (!base) return rawPath;
      return `${base.replace(/[\\/]+$/, '')}${rawPath.slice(match[0].length)}`;
    }
  }
  return rawPath;
}

/**
 * True when `rawTarget` unambiguously resolves to a path strictly underneath a system temp folder
 * (never the temp root itself, never escaping via `..` or junctions/symlinks, and containing no
 * unexpanded variables, single-quoted unexpanded variables, or command substitutions).
 */
export function isClearlyUnderSystemTemp(rawTarget, { env = process.env, shell = '', singleQuoted = false } = {}) {
  if (typeof rawTarget !== 'string') return false;
  const trimmed = rawTarget.trim();
  if (!trimmed || trimmed.includes('\0')) return false;
  if (trimmed.includes('`') || trimmed.includes('$(')) return false;

  const shellKind = normalizeShellKind(shell);
  const expanded = singleQuoted ? trimmed : expandLeadingTempVar(trimmed, env, shellKind);

  // Git Bash / MSYS `/tmp/<subpath>` and `/var/tmp/<subpath>` on Windows
  if (process.platform === 'win32' && /^\/(?:var\/)?tmp\/.+/i.test(expanded)) {
    const posixNorm = path.posix.normalize(expanded);
    const posixRoot = /^\/var\/tmp(?:\/|$)/i.test(expanded) ? '/var/tmp' : '/tmp';
    if (!posixNorm.startsWith(`${posixRoot}/`)) return false;
    const rel = posixNorm.slice(posixRoot.length + 1);
    if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || rel === '*') return false;
    if (/[$%]/.test(rel)) return false;
    return true;
  }

  // Any remaining variable expansion (`$foo`, `%FOO%`, `~`) means the target is not statically known
  if (/[$%]/.test(expanded) || expanded.startsWith('~')) return false;
  if (!path.isAbsolute(expanded)) return false;

  const normalizedSlashes = expanded.replace(/\//g, path.sep);
  const rawParts = normalizedSlashes.split(path.sep);
  if (rawParts.some((seg) => seg === '..')) {
    const firstWild = rawParts.findIndex((seg) => /[*?[\]]/.test(seg));
    const lastDotDot = rawParts.lastIndexOf('..');
    if (firstWild !== -1 && firstWild < lastDotDot) return false;
  }

  let concretePath = expanded;
  let hadBareRootWildcard = false;
  const splitParts = path.resolve(expanded).split(path.sep);
  const wildIdx = splitParts.findIndex((seg, i) => i > 0 && /[*?[\]]/.test(seg));
  if (wildIdx !== -1) {
    const anchor = splitParts.slice(0, wildIdx).join(path.sep) || path.parse(expanded).root;
    concretePath = anchor;
    if (splitParts[wildIdx] === '*') {
      hadBareRootWildcard = true;
    } else {
      concretePath = path.join(anchor, '__wildcard_child__');
    }
  }

  const targetCmp = comparablePath(concretePath);
  const tempRoots = collectSystemTempRoots(env);

  for (const tempRoot of tempRoots) {
    if (!tempRoot) continue;
    if (targetCmp === tempRoot) {
      if (!hadBareRootWildcard) continue;
      return false;
    }
    const prefix = tempRoot.endsWith(path.sep) ? tempRoot : `${tempRoot}${path.sep}`;
    if (targetCmp.startsWith(prefix)) return true;
  }
  return false;
}

function isTargetUnderTemp(tok, { env, shell, allowTempExemption = true }) {
  if (!allowTempExemption) return false;
  return isClearlyUnderSystemTemp(tok.text, {
    env,
    shell,
    singleQuoted: Boolean(tok.singleQuoted),
  });
}

function inspectGitSegment(args) {
  let idx = 0;
  let subcommand = '';
  while (idx < args.length) {
    const arg = args[idx].text;
    if (arg === '--') return null;
    if (arg === '-h' || arg === '--help' || arg === '--version') return null;
    if (arg === '-C' || GIT_GLOBAL_OPTS_WITH_VALUE.has(arg)) {
      idx += 2;
      continue;
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      idx++;
      continue;
    }
    if (arg.startsWith('-')) {
      idx++;
      continue;
    }
    subcommand = arg.toLowerCase();
    idx++;
    break;
  }
  if (!subcommand) return null;

  const subArgs = args.slice(idx);
  const optsBeforeDashDash = [];
  const posArgs = [];
  let afterDashDash = false;
  const afterDashDashArgs = [];

  for (let i = 0; i < subArgs.length; i++) {
    const tok = subArgs[i];
    const t = tok.text;
    if (!afterDashDash && !tok.quoted && t === '--') {
      afterDashDash = true;
      continue;
    }
    if (afterDashDash) {
      afterDashDashArgs.push(t);
      continue;
    }
    if (t === '-h' || t === '--help') return null;
    if (t.startsWith('-')) {
      optsBeforeDashDash.push(t);
      if (subcommand === 'push' && GIT_PUSH_OPTS_WITH_VALUE.has(t)) {
        i++;
      } else if ((subcommand === 'restore' || subcommand === 'checkout') && (t === '-s' || t === '--source' || t === '--pathspec-from-file')) {
        i++;
      }
    } else {
      posArgs.push(t);
    }
  }

  if (subcommand === 'push') {
    if (optsBeforeDashDash.some((o) => o === '-n' || o === '--dry-run')) return null;
    for (const o of optsBeforeDashDash) {
      if (o === '--force' || o === '-f' || /^-[udqv]+f[udqv]*$/.test(o) || /^-[f][udqv]+$/.test(o)) {
        return { rule: 'git_push_force', label: 'git push --force' };
      }
      if (o === '--force-with-lease' || o.startsWith('--force-with-lease=')) {
        return { rule: 'git_push_force_with_lease', label: 'git push --force-with-lease' };
      }
      if (o === '--delete' || o === '-d') {
        return { rule: 'git_push_delete', label: 'git push --delete' };
      }
      if (o === '--mirror') {
        return { rule: 'git_push_mirror', label: 'git push --mirror' };
      }
    }
    // Positional refspecs (`git push <remote> <refspec>...`): `+refspec` forces push, `:branch` deletes remote ref
    for (let i = 1; i < posArgs.length; i++) {
      if (posArgs[i].startsWith('+') && posArgs[i].length > 1) {
        return { rule: 'git_push_force', label: 'git push +refspec (강제 푸시)' };
      }
      if (posArgs[i].startsWith(':') && posArgs[i].length > 1) {
        return { rule: 'git_push_colon_delete', label: 'git push :branch 삭제' };
      }
    }
    return null;
  }

  if (subcommand === 'reset') {
    if (optsBeforeDashDash.includes('--hard')) {
      return { rule: 'git_reset_hard', label: 'git reset --hard' };
    }
    return null;
  }

  if (subcommand === 'clean') {
    if (optsBeforeDashDash.some((o) => o === '-n' || o === '--dry-run' || /^-[A-Za-z]*n[A-Za-z]*$/.test(o))) {
      return null;
    }
    if (optsBeforeDashDash.some((o) => o === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(o))) {
      return { rule: 'git_clean_force', label: 'git clean -f' };
    }
    return null;
  }

  if (subcommand === 'checkout') {
    if (optsBeforeDashDash.some((o) => o === '-b' || o === '-B' || o === '--orphan')) return null;
    if (afterDashDash && afterDashDashArgs.length > 0) {
      return { rule: 'git_checkout_discard', label: 'git checkout -- <경로>' };
    }
    if (optsBeforeDashDash.some((o) => o === '-f' || o === '--force')) {
      return { rule: 'git_checkout_discard', label: 'git checkout --force' };
    }
    if (!afterDashDash && optsBeforeDashDash.length === 0 && posArgs.length === 1 && posArgs[0] === '.') {
      return { rule: 'git_checkout_discard', label: 'git checkout .' };
    }
    return null;
  }

  if (subcommand === 'restore') {
    const hasStaged = optsBeforeDashDash.some(
      (o) => o === '--staged' || /^-[A-Za-z]*S[A-Za-z]*$/.test(o),
    );
    const hasWorktree = optsBeforeDashDash.some(
      (o) => o === '--worktree' || /^-[A-Za-z]*W[A-Za-z]*$/.test(o),
    );
    if (hasStaged && !hasWorktree) return null;
    if (posArgs.length > 0 || afterDashDashArgs.length > 0 || optsBeforeDashDash.some((o) => o.startsWith('--pathspec-from-file'))) {
      return { rule: 'git_restore_worktree', label: 'git restore (작업 폴더 변경 폐기)' };
    }
    return null;
  }

  if (subcommand === 'branch') {
    const hasCapD = optsBeforeDashDash.some((o) => o === '-D' || /^-[A-Za-z]*D[A-Za-z]*$/.test(o));
    const hasDeleteAndForce = optsBeforeDashDash.some((o) => o === '-d' || o === '--delete')
      && optsBeforeDashDash.some((o) => o === '-f' || o === '--force');
    if (hasCapD || hasDeleteAndForce) {
      return { rule: 'git_branch_delete_force', label: 'git branch -D' };
    }
    return null;
  }

  if (subcommand === 'stash') {
    const stashVerb = (posArgs[0] || '').toLowerCase();
    if (stashVerb === 'drop' || stashVerb === 'clear') {
      return { rule: `git_stash_${stashVerb}`, label: `git stash ${stashVerb}` };
    }
    return null;
  }

  if (subcommand === 'rebase') {
    // In-progress rebase control operations (`--abort`, `--continue`, `--skip`, `--quit`,
    // `--edit-todo`, `--show-current-patch`) do not start a new rebase and pass without asking.
    const isInProgressControl =
      posArgs.length === 0
      && !afterDashDash
      && optsBeforeDashDash.some((o) => GIT_REBASE_IN_PROGRESS_OPTS.has(o) || o.startsWith('--show-current-patch='))
      && optsBeforeDashDash.every(
        (o) => GIT_REBASE_IN_PROGRESS_OPTS.has(o)
          || o.startsWith('--show-current-patch=')
          || o === '-v'
          || o === '--verbose'
          || o === '-q'
          || o === '--quiet',
      );
    if (isInProgressControl) return null;
    return { rule: 'git_rebase', label: 'git rebase' };
  }

  if (subcommand === 'filter-branch') {
    return { rule: 'git_filter_branch', label: 'git filter-branch' };
  }

  if (subcommand === 'reflog') {
    const reflogVerb = (posArgs[0] || '').toLowerCase();
    if (reflogVerb === 'expire' || reflogVerb === 'delete') {
      return { rule: 'git_reflog_expire', label: `git reflog ${reflogVerb}` };
    }
    return null;
  }

  if (subcommand === 'gc') {
    if (optsBeforeDashDash.some((o) => o === '--prune' || o.startsWith('--prune='))) {
      return { rule: 'git_gc_prune', label: 'git gc --prune' };
    }
    return null;
  }

  return null;
}

function inspectPwshEncodedSegment(args) {
  for (let i = 0; i < args.length; i++) {
    const lower = args[i].text.toLowerCase();
    if (lower === '--' || lower === '-h' || lower === '--help' || lower === '-?' || lower === '-v' || lower === '--version') {
      return null;
    }
    if (lower === '-file' || lower === '-f' || (lower.length >= 2 && '-command'.startsWith(lower))) {
      return null;
    }
    if (lower === '-ec' || (lower.length >= 2 && '-encodedcommand'.startsWith(lower))) {
      return {
        rule: 'powershell_encoded_command',
        label: 'powershell -EncodedCommand: 인코딩된 명령은 검사할 수 없음',
      };
    }
    if (PWSH_FLAGS_WITH_VALUE.has(lower)) {
      i++;
      continue;
    }
    if (!lower.startsWith('-')) return null;
  }
  return null;
}

function inspectPublishSegment(bare, args) {
  if (bare === 'npm' || bare === 'pnpm' || bare === 'yarn') {
    let idx = 0;
    const subOpts = [];
    const verbs = [];
    while (idx < args.length) {
      const t = args[idx].text;
      if (t === '-h' || t === '--help') return null;
      if (PKG_MANAGER_GLOBAL_OPTS_WITH_VALUE.has(t)) {
        idx += 2;
        continue;
      }
      if (t.startsWith('-')) {
        subOpts.push(t);
        idx++;
        continue;
      }
      verbs.push(t.toLowerCase());
      idx++;
    }
    const isPublish = verbs[0] === 'publish' || (bare === 'yarn' && verbs[0] === 'npm' && verbs[1] === 'publish');
    if (isPublish && !subOpts.includes('--dry-run')) {
      return { rule: `${bare}_publish`, label: `${bare} publish` };
    }
    return null;
  }

  if (bare === 'gh') {
    const words = [];
    for (let i = 0; i < args.length; i++) {
      const t = args[i].text;
      if (t === '-h' || t === '--help') return null;
      if (GH_GLOBAL_OPTS_WITH_VALUE.has(t)) {
        i++;
        continue;
      }
      if (t.startsWith('-')) continue;
      words.push(t.toLowerCase());
      if (words.length >= 2) break;
    }
    const pair = `${words[0] || ''} ${words[1] || ''}`.trim();
    if (pair === 'release create') return { rule: 'gh_release_create', label: 'gh release create' };
    if (pair === 'pr merge') return { rule: 'gh_pr_merge', label: 'gh pr merge' };
    if (pair === 'repo delete') return { rule: 'gh_repo_delete', label: 'gh repo delete' };
    return null;
  }

  if (bare === 'docker') {
    const words = [];
    for (let i = 0; i < args.length; i++) {
      const t = args[i].text;
      if (t === '-h' || t === '--help') return null;
      if (DOCKER_GLOBAL_OPTS_WITH_VALUE.has(t)) {
        i++;
        continue;
      }
      if (t.startsWith('-')) continue;
      words.push(t.toLowerCase());
      if (words.length >= 2) break;
    }
    if (words[0] === 'push' || (words[0] === 'image' && words[1] === 'push')) {
      return { rule: 'docker_push', label: 'docker push' };
    }
  }

  return null;
}

function isCmdRmdirRecursiveSwitch(tokenText) {
  return /^\/(?:[sS](?:\/[qQ])?|[qQ]\/[sS])$/.test(tokenText);
}

function isCmdRmdirQuietSwitch(tokenText) {
  return /^\/[qQ]$/.test(tokenText);
}

function isCmdDelSwitch(tokenText) {
  // Valid `cmd.exe` `del` / `erase` switches: `/p`, `/f`, `/s`, `/q`, `/a[:attributes]` (possibly chained `/s/q`)
  return /^(?:\/(?:[pPfFsSqQ]|[aA](?::[rRhHsSaAiIlL-]*)?))+$/.test(tokenText);
}

function isCmdDelRecursiveSwitch(tokenText) {
  if (!isCmdDelSwitch(tokenText)) return false;
  return /\/[sS](?=$|\/)/.test(tokenText);
}

function isUnquotedRedirectionOp(tok) {
  if (!tok || tok.quoted) return false;
  return /^(?:\d*>>?|\d*>&\d*|\d*<>?|\d*<&|&>>?|<<<?)$/.test(tok.text);
}

function isUnquotedRedirectionWithTarget(tok) {
  if (!tok || tok.quoted) return false;
  return /^(?:\d*>>?|\d*<>?|&>>?)\S+$/.test(tok.text);
}

function inspectRecursiveDeleteSegment(bare, args, { env, shell = '', allowTempExemption = true } = {}) {
  const shellKind = normalizeShellKind(shell);

  if (bare === 'rm') {
    let recursive = false;
    let afterDashDash = false;
    let hasPwshStyleFlag = false;
    const targetTokens = [];
    for (let i = 0; i < args.length; i++) {
      const tok = args[i];
      const t = tok.text;
      if (!afterDashDash && !tok.quoted && t === '--') {
        afterDashDash = true;
        continue;
      }
      if (isUnquotedRedirectionOp(tok)) {
        if (!t.includes('&')) i++;
        continue;
      }
      if (isUnquotedRedirectionWithTarget(tok)) continue;
      if (!afterDashDash && t.startsWith('-') && t.length > 1) {
        const lower = t.toLowerCase();
        if (lower === '--help' || lower === '-h' || lower === '--version') return null;
        if (lower === '-recurse' || (shellKind === 'powershell' && lower.startsWith('-rec') && !lower.endsWith(':$false'))) {
          recursive = true;
          hasPwshStyleFlag = true;
          continue;
        }
        if (lower === '--recursive' || /^-[rRfFiIvPdW]*[rR][rRfFiIvPdW]*$/.test(t)) {
          recursive = true;
          continue;
        }
        if (lower === '-path' || lower === '-literalpath' || lower === '-lp') {
          hasPwshStyleFlag = true;
          if (i + 1 < args.length) targetTokens.push(args[++i]);
          continue;
        }
        if (lower === '-filter' || lower === '-include' || lower === '-exclude') {
          hasPwshStyleFlag = true;
          i++;
          continue;
        }
        continue;
      }
      targetTokens.push(tok);
    }
    if (!recursive) return null;
    const effectiveShell = shellKind || (hasPwshStyleFlag ? 'powershell' : 'bash');
    if (
      targetTokens.length > 0
      && targetTokens.every((tok) => isTargetUnderTemp(tok, { env, shell: effectiveShell, allowTempExemption }))
    ) {
      return null;
    }
    return { rule: 'rm_recursive', label: '재귀 삭제 (rm -r)' };
  }

  if (bare === 'rimraf') {
    let afterDashDash = false;
    const targetTokens = [];
    for (let i = 0; i < args.length; i++) {
      const tok = args[i];
      const t = tok.text;
      if (!afterDashDash && !tok.quoted && t === '--') {
        afterDashDash = true;
        continue;
      }
      if (isUnquotedRedirectionOp(tok)) {
        if (!t.includes('&')) i++;
        continue;
      }
      if (isUnquotedRedirectionWithTarget(tok)) continue;
      if (!afterDashDash && t.startsWith('-')) {
        const lower = t.toLowerCase();
        if (lower === '-h' || lower === '--help' || lower === '--version') return null;
        if (lower === '-m' || lower === '--max-tries' || lower === '-d' || lower === '--retry-delay' || lower === '--filter') {
          i++;
          continue;
        }
        continue;
      }
      targetTokens.push(tok);
    }
    if (targetTokens.length === 0 && allowTempExemption) return null;
    const effectiveShell = shellKind || 'bash';
    if (
      targetTokens.length > 0
      && targetTokens.every((tok) => isTargetUnderTemp(tok, { env, shell: effectiveShell, allowTempExemption }))
    ) {
      return null;
    }
    return { rule: 'rimraf', label: '재귀 삭제 (rimraf)' };
  }

  if (bare === 'remove-item' || bare === 'ri') {
    let recursive = false;
    const targetTokens = [];
    let hasWildcardFilter = false;
    for (let i = 0; i < args.length; i++) {
      const tok = args[i];
      const t = tok.text;
      if (isUnquotedRedirectionOp(tok)) {
        if (!t.includes('&')) i++;
        continue;
      }
      if (isUnquotedRedirectionWithTarget(tok)) continue;
      const lower = t.toLowerCase();
      if (lower === '-recurse' || lower === '-r' || lower.startsWith('-rec') || lower.startsWith('-recurse:$true')) {
        if (!lower.endsWith(':$false')) recursive = true;
        continue;
      }
      if (lower === '-path' || lower === '-literalpath' || lower === '-lp') {
        if (i + 1 < args.length) {
          const valTok = args[++i];
          for (const part of valTok.text.split(',').map((s) => s.trim()).filter(Boolean)) {
            targetTokens.push({ ...valTok, text: part });
          }
        }
        continue;
      }
      if (lower === '-filter' || lower === '-include' || lower === '-exclude' || lower === '-stream') {
        hasWildcardFilter = true;
        i++;
        continue;
      }
      if (t.startsWith('-')) continue;
      for (const part of t.split(',').map((s) => s.trim()).filter(Boolean)) {
        targetTokens.push({ ...tok, text: part });
      }
    }
    if (!recursive) return null;
    // `Remove-Item` / `ri` is always PowerShell (`$TEMP` is not `$env:TEMP` in PowerShell).
    if (
      !hasWildcardFilter
      && targetTokens.length > 0
      && targetTokens.every((tok) => isTargetUnderTemp(tok, { env, shell: 'powershell', allowTempExemption }))
    ) {
      return null;
    }
    return { rule: 'remove_item_recurse', label: '재귀 삭제 (Remove-Item -Recurse)' };
  }

  if (bare === 'rmdir' || bare === 'rd') {
    let recursive = false;
    let effectiveShell = shellKind || 'cmd';
    const targetTokens = [];
    for (let i = 0; i < args.length; i++) {
      const tok = args[i];
      const t = tok.text;
      if (isUnquotedRedirectionOp(tok)) {
        if (!t.includes('&')) i++;
        continue;
      }
      if (isUnquotedRedirectionWithTarget(tok)) continue;
      const lower = t.toLowerCase();
      // PowerShell alias (`rmdir -Recurse` / `rd -r` / `rd -Rec`)
      if (
        shellKind !== 'bash' && shellKind !== 'cmd'
        && (lower === '-recurse' || lower === '-r' || (lower.startsWith('-rec') && !lower.endsWith(':$false')))
      ) {
        recursive = true;
        effectiveShell = 'powershell';
        continue;
      }
      if (shellKind !== 'bash' && shellKind !== 'cmd' && (lower === '-path' || lower === '-literalpath' || lower === '-lp')) {
        effectiveShell = 'powershell';
        if (i + 1 < args.length) targetTokens.push(args[++i]);
        continue;
      }
      // `/s` is only a recursive switch as a standalone switch in `cmd` context (`cmd /c ...` or unknown shell),
      // never a POSIX path segment (`/c/Users/x/emptydir`, `/s` in bash) or PowerShell path.
      if ((shellKind === 'cmd' || !shellKind) && isCmdRmdirRecursiveSwitch(t)) {
        recursive = true;
        effectiveShell = 'cmd';
        continue;
      }
      if ((shellKind === 'cmd' || !shellKind) && isCmdRmdirQuietSwitch(t)) continue;
      if (t.startsWith('-')) continue;
      targetTokens.push(tok);
    }
    if (!recursive) return null;
    // In `cmd`, `rmdir /s` requires at least one directory target (`rmdir /s` alone is a syntax error).
    if (effectiveShell === 'cmd' && targetTokens.length === 0 && allowTempExemption) return null;
    if (
      targetTokens.length > 0
      && targetTokens.every((tok) => isTargetUnderTemp(tok, { env, shell: effectiveShell, allowTempExemption }))
    ) {
      return null;
    }
    return { rule: 'rmdir_recursive', label: '재귀 삭제 (rmdir /s)' };
  }

  if (bare === 'del' || bare === 'erase') {
    let recursive = false;
    let effectiveShell = shellKind || 'cmd';
    const targetTokens = [];
    for (let i = 0; i < args.length; i++) {
      const tok = args[i];
      const t = tok.text;
      if (isUnquotedRedirectionOp(tok)) {
        if (!t.includes('&')) i++;
        continue;
      }
      if (isUnquotedRedirectionWithTarget(tok)) continue;
      const lower = t.toLowerCase();
      if (
        shellKind !== 'bash' && shellKind !== 'cmd'
        && (lower === '-recurse' || lower === '-r' || (lower.startsWith('-rec') && !lower.endsWith(':$false')))
      ) {
        recursive = true;
        effectiveShell = 'powershell';
        continue;
      }
      if (shellKind !== 'bash' && shellKind !== 'cmd' && (lower === '-path' || lower === '-literalpath' || lower === '-lp')) {
        effectiveShell = 'powershell';
        if (i + 1 < args.length) targetTokens.push(args[++i]);
        continue;
      }
      if (shellKind !== 'bash' && isCmdDelRecursiveSwitch(t)) {
        recursive = true;
        effectiveShell = 'cmd';
        continue;
      }
      if (shellKind !== 'bash' && isCmdDelSwitch(t)) continue;
      if (t.startsWith('-')) continue;
      targetTokens.push(tok);
    }
    if (!recursive) return null;
    if (
      targetTokens.length > 0
      && targetTokens.every((tok) => isTargetUnderTemp(tok, { env, shell: effectiveShell, allowTempExemption }))
    ) {
      return null;
    }
    return { rule: 'del_recursive', label: '재귀 삭제 (del /s)' };
  }

  return null;
}

function unwrapXargsCommandWords(args) {
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    const t = tok.text;
    if (!tok.quoted && t === '--') {
      return args.slice(i + 1);
    }
    if (t === '--help' || t === '--version') return null;
    if (XARGS_OPTS_WITH_VALUE.has(t)) {
      i += 2;
      continue;
    }
    if (t === '-i' || t === '-e' || t === '-l') {
      // Optional attached value (`-i`, `-i{}`, `-l2`)
      i++;
      continue;
    }
    if (t.startsWith('-')) {
      i++;
      continue;
    }
    return args.slice(i);
  }
  return null;
}

function inspectFindSegment(args, { env, shell, depth, budget }) {
  const shellKind = normalizeShellKind(shell) || 'bash';
  let idx = 0;
  let followsSymlinks = false;
  const startingPoints = [];

  // Leading POSIX `find` flags (`-H`, `-L`, `-P`, `-D <opt>`, `-O<level>`, `-f <path>`)
  while (idx < args.length) {
    const t = args[idx].text;
    if (t === '--help' || t === '--version') return null;
    if (t === '-L' || t === '-H') {
      followsSymlinks = true;
      idx++;
      continue;
    }
    if (t === '-P' || t === '-E' || t === '-X' || t === '-s' || t === '-x' || /^-O[0-3]$/.test(t)) {
      idx++;
      continue;
    }
    if (t === '-D') {
      idx += 2;
      continue;
    }
    if (t === '-f') {
      if (idx + 1 < args.length) startingPoints.push(args[idx + 1]);
      idx += 2;
      continue;
    }
    break;
  }

  // Collect starting-point paths up to the first expression predicate/operator (`-*`, `(`, `)`, `!`, `,`)
  while (idx < args.length) {
    const tok = args[idx];
    const t = tok.text;
    if (!tok.quoted && (t === '!' || t === ',')) break;
    if (t.startsWith('-') && t.length > 1) break;
    startingPoints.push(tok);
    idx++;
  }

  for (let k = idx; k < args.length; k++) {
    if (args[k].text === '-follow') followsSymlinks = true;
  }

  const allStartsUnderTemp =
    !followsSymlinks
    && startingPoints.length > 0
    && startingPoints.every((tok) => isTargetUnderTemp(tok, { env, shell: shellKind, allowTempExemption: true }));

  for (let i = idx; i < args.length; i++) {
    const t = args[i].text;
    if (t === '-delete') {
      if (allStartsUnderTemp) continue;
      return { rule: 'find_delete', label: '재귀 삭제 (find -delete)' };
    }
    if (t === '-exec' || t === '-execdir') {
      const execWords = [];
      let j = i + 1;
      while (j < args.length) {
        const w = args[j];
        if (!w.quoted && (w.text === ';' || w.text === '\\;')) break;
        if (!w.quoted && w.text === '+' && (j + 1 >= args.length || args[j + 1].text === ';' || args[j + 1].text === '\\;')) {
          break;
        }
        execWords.push(w);
        j++;
      }
      i = j;
      if (execWords.length > 0) {
        // Replace `{}` placeholder tokens with non-temp sentinel unless `find` starting points are all under temp
        const mappedWords = execWords.map((w) => {
          if (w.text.includes('{}')) {
            return allStartsUnderTemp && startingPoints[0]
              ? startingPoints[0]
              : { ...w, text: '__find_match_target__', quoted: false, singleQuoted: false };
          }
          return w;
        });
        const res = inspectSegmentWords(mappedWords, {
          env,
          shell: shellKind,
          depth: depth + 1,
          allowTempExemption: true,
          budget,
        });
        if (res.match) return res.match;
      }
    }
  }

  return null;
}

function extractSqlMatchLabel(text) {
  const m = /\b(DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE(?:\s+TABLE)?)\b/i.exec(text);
  return m ? m[1].replace(/\s+/g, ' ').toUpperCase() : 'SQL 삭제/초기화';
}

function isDbCliWordAt(words, index) {
  const bare = stripExeSuffix(executableBaseName(words[index].text));
  if (DB_CLI_NAMES.has(bare)) return true;
  if (bare === 'prisma' && words[index + 1]?.text.toLowerCase() === 'db' && words[index + 2]?.text.toLowerCase() === 'execute') {
    return true;
  }
  if (bare === 'wrangler' && words[index + 1]?.text.toLowerCase() === 'd1' && words[index + 2]?.text.toLowerCase() === 'execute') {
    return true;
  }
  return false;
}

function inspectSqlInPipeline(pipeline, segmentCandidates = null) {
  for (let segIdx = 0; segIdx < pipeline.length; segIdx++) {
    const words = pipeline[segIdx];
    const allowedIndices = segmentCandidates ? segmentCandidates[segIdx] : null;
    for (let i = 0; i < words.length; i++) {
      if (allowedIndices ? !allowedIndices.has(i) : !isCandidateCommandWord(words, i)) continue;
      const bare = stripExeSuffix(executableBaseName(words[i].text));

      if (isDbCliWordAt(words, i)) {
        for (let j = i + 1; j < words.length; j++) {
          if (SQL_DESTRUCTIVE_RE.test(words[j].text)) {
            const sqlKind = extractSqlMatchLabel(words[j].text);
            return { rule: 'sql_destructive', label: `SQL ${sqlKind}` };
          }
        }
        for (let up = 0; up < segIdx; up++) {
          for (const upTok of pipeline[up]) {
            if (SQL_DESTRUCTIVE_RE.test(upTok.text)) {
              const sqlKind = extractSqlMatchLabel(upTok.text);
              return { rule: 'sql_destructive', label: `SQL ${sqlKind}` };
            }
          }
        }
      }

      if (INLINE_EVAL_BINS.has(bare)) {
        for (let j = i + 1; j < words.length; j++) {
          const flag = words[j].text;
          if ((flag === '-e' || flag === '--eval' || flag === '-c' || flag === '-r') && j + 1 < words.length) {
            const code = words[j + 1].text;
            if (SCRIPT_SQL_EXEC_RE.test(code)) {
              const sqlKind = extractSqlMatchLabel(code);
              return { rule: 'sql_destructive', label: `SQL ${sqlKind}` };
            }
          }
        }
      }
    }
  }
  return null;
}

function inspectSegmentWords(words, { env, shell = '', depth = 0, allowTempExemption = true, budget = null } = {}) {
  const candidateIndices = new Set();
  if (words.length === 0) return { match: null, candidateIndices };
  if (depth > MAX_NESTED_SHELL_DEPTH) {
    if (budget) budget.exceeded = true;
    return { match: UNINSPECTABLE_COMMAND_MATCH, candidateIndices };
  }
  if (consumeInspectionStep(budget)) {
    return { match: UNINSPECTABLE_COMMAND_MATCH, candidateIndices };
  }

  for (let i = 0; i < words.length; i++) {
    if (!isCandidateCommandWord(words, i)) continue;
    if (consumeInspectionStep(budget)) {
      return { match: UNINSPECTABLE_COMMAND_MATCH, candidateIndices };
    }
    candidateIndices.add(i);

    const bare = stripExeSuffix(executableBaseName(words[i].text));
    let args;
    const getArgs = () => {
      if (args === undefined) args = words.slice(i + 1);
      return args;
    };

    if (bare === 'git') {
      const gitMatch = inspectGitSegment(getArgs());
      if (gitMatch) return { match: gitMatch, candidateIndices };
    }

    if (PWSH_SHELLS.has(bare)) {
      const encMatch = inspectPwshEncodedSegment(getArgs());
      if (encMatch) return { match: encMatch, candidateIndices };
    }

    if (bare === 'npm' || bare === 'pnpm' || bare === 'yarn' || bare === 'gh' || bare === 'docker') {
      const pubMatch = inspectPublishSegment(bare, getArgs());
      if (pubMatch) return { match: pubMatch, candidateIndices };
    }

    if (
      bare === 'rm' || bare === 'rimraf' || bare === 'remove-item' || bare === 'ri'
      || bare === 'rmdir' || bare === 'rd' || bare === 'del' || bare === 'erase'
    ) {
      const delMatch = inspectRecursiveDeleteSegment(bare, getArgs(), { env, shell, allowTempExemption });
      if (delMatch) return { match: delMatch, candidateIndices };
    }

    if (bare === 'find') {
      const findMatch = inspectFindSegment(getArgs(), { env, shell, depth, budget });
      if (findMatch) return { match: findMatch, candidateIndices };
    }

    if (bare === 'xargs') {
      const innerWords = unwrapXargsCommandWords(getArgs());
      if (innerWords && innerWords.length > 0) {
        // `xargs` appends stdin arguments at runtime, so static temp-folder exemption never applies.
        const xargsRes = inspectSegmentWords(innerWords, {
          env,
          shell,
          depth: depth + 1,
          allowTempExemption: false,
          budget,
        });
        if (xargsRes.match) return { match: xargsRes.match, candidateIndices };
      }
    }

    // Argument-consuming command (`git`, non-exec `npm`/`pnpm`/`yarn`/`bun`, `grep`/`rg`/`Select-String`/...):
    // once its own hard-to-reverse check passed, subsequent words in this segment are its arguments, not commands.
    if (ARG_CONSUMING_COMMANDS.has(bare)) {
      const execSubIdx = findPackageManagerExecSubcommandIndex(bare, words, i + 1);
      if (execSubIdx !== -1) {
        i = execSubIdx;
        continue;
      }
      const resumeIdx = findEmbeddedCommandResumeIndex(bare, words, i + 1);
      if (resumeIdx !== -1) {
        i = resumeIdx;
        continue;
      }
      break;
    }
  }

  for (const nested of extractNestedShellCommands(words, shell, { candidateIndices })) {
    const nestedMatch = inspectCommandBuiltinsRecursive(nested.command, {
      env,
      shell: nested.shell,
      depth: depth + 1,
      budget,
    });
    if (nestedMatch) return { match: nestedMatch, candidateIndices };
  }

  return { match: budget?.exceeded ? UNINSPECTABLE_COMMAND_MATCH : null, candidateIndices };
}

function inspectCommandBuiltinsRecursive(command, { env, shell = '', depth = 0, budget = null } = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (depth > MAX_NESTED_SHELL_DEPTH) {
    if (budget) budget.exceeded = true;
    return UNINSPECTABLE_COMMAND_MATCH;
  }
  if (consumeInspectionStep(budget)) return UNINSPECTABLE_COMMAND_MATCH;

  const pipelines = tokenizeShellPipelines(command, { shell, budget });
  if (budget?.exceeded) return UNINSPECTABLE_COMMAND_MATCH;

  for (const pipeline of pipelines) {
    const segmentCandidates = [];
    for (const words of pipeline) {
      const segRes = inspectSegmentWords(words, { env, shell, depth, allowTempExemption: true, budget });
      if (segRes.match) return segRes.match;
      if (budget?.exceeded) return UNINSPECTABLE_COMMAND_MATCH;
      segmentCandidates.push(segRes.candidateIndices);
    }

    const sqlMatch = inspectSqlInPipeline(pipeline, segmentCandidates);
    if (sqlMatch) return sqlMatch;
  }

  return budget?.exceeded ? UNINSPECTABLE_COMMAND_MATCH : null;
}

function evaluateCustomPatterns(
  command,
  confirmCommandPatterns,
  {
    config,
    patternTimeoutMs = CONFIRM_PATTERN_TIMEOUT_MS,
    totalTimeoutMs = CONFIRM_PATTERNS_TOTAL_TIMEOUT_MS,
    nowMs = () => performance.now(),
  } = {},
) {
  if (!Array.isArray(confirmCommandPatterns) || confirmCommandPatterns.length === 0) return null;

  const perLimit = typeof patternTimeoutMs === 'number' && Number.isFinite(patternTimeoutMs) && patternTimeoutMs > 0
    ? patternTimeoutMs
    : CONFIRM_PATTERN_TIMEOUT_MS;
  const totalLimit = typeof totalTimeoutMs === 'number' && Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0
    ? totalTimeoutMs
    : CONFIRM_PATTERNS_TOTAL_TIMEOUT_MS;

  const state = getRegexVmState();
  const totalStart = nowMs();

  for (let idx = 0; idx < confirmCommandPatterns.length; idx++) {
    const pattern = confirmCommandPatterns[idx];
    if (typeof pattern !== 'string' || !pattern.trim()) continue;

    let re;
    try {
      re = new RegExp(pattern);
    } catch {
      continue;
    }

    const elapsedTotal = Math.max(0, nowMs() - totalStart);
    if (elapsedTotal >= totalLimit) {
      recordConfirmPatternProblem(config, { pattern, index: idx, timeoutMs: totalLimit });
      return {
        matched: true,
        timedOut: true,
        rule: 'custom_pattern_timeout',
        label: `사용자 지정 패턴 시간 초과(설정 확인) /${clipInline(pattern, 30)}/`,
        customPattern: pattern,
      };
    }

    const remaining = Math.max(1, Math.ceil(totalLimit - elapsedTotal));
    const vmTimeout = Math.max(1, Math.min(Math.ceil(perLimit), remaining));
    const singleStart = nowMs();
    let isMatch = false;
    let timedOut = false;

    try {
      state.context.re = re;
      state.context.input = command;
      isMatch = Boolean(state.script.runInContext(state.context, { timeout: vmTimeout }));
    } catch (err) {
      if (err && (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /timed out/i.test(String(err.message || '')))) {
        timedOut = true;
      } else {
        continue;
      }
    } finally {
      state.context.re = null;
      state.context.input = '';
    }

    if (!timedOut && nowMs() - singleStart > perLimit) {
      timedOut = true;
    }

    if (timedOut) {
      recordConfirmPatternProblem(config, { pattern, index: idx, timeoutMs: perLimit });
      return {
        matched: true,
        timedOut: true,
        rule: 'custom_pattern_timeout',
        label: `사용자 지정 패턴 시간 초과(설정 확인) /${clipInline(pattern, 30)}/`,
        customPattern: pattern,
      };
    }

    if (isMatch) {
      return {
        matched: true,
        rule: 'custom_pattern',
        label: `사용자 지정 패턴 /${clipInline(pattern, 40)}/`,
        customPattern: pattern,
      };
    }
  }

  return null;
}

/**
 * Inspect a shell command line for hard-to-reverse operations.
 * Returns `{ matched: false }` or `{ matched: true, rule, label, customPattern?, timedOut? }`.
 */
export function inspectConfirmableShellCommand(
  command,
  {
    confirmCommands = true,
    confirmCommandPatterns = [],
    env = process.env,
    shell = '',
    config,
    patternTimeoutMs = CONFIRM_PATTERN_TIMEOUT_MS,
    totalTimeoutMs = CONFIRM_PATTERNS_TOTAL_TIMEOUT_MS,
    nowMs,
    budget,
    maxInspectionSteps = MAX_SHELL_INSPECTION_STEPS,
  } = {},
) {
  if (!confirmCommands) return { matched: false };
  if (typeof command !== 'string' || !command.trim()) return { matched: false };

  const effectiveBudget = budget || createShellInspectionBudget(maxInspectionSteps);
  if (effectiveBudget.exceeded) {
    return { matched: true, ...UNINSPECTABLE_COMMAND_MATCH };
  }

  const shellKind = normalizeShellKind(shell);
  let builtin = inspectCommandBuiltinsRecursive(command, {
    env,
    shell: shellKind,
    depth: 0,
    budget: effectiveBudget,
  });
  if (!builtin && !shellKind && /[`\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u2013\u2014\u2015]/.test(command)) {
    // When caller did not specify the shell kind and PowerShell-specific backticks or typography appear,
    // also inspect under PowerShell rules.
    builtin = inspectCommandBuiltinsRecursive(command, {
      env,
      shell: 'powershell',
      depth: 0,
      budget: effectiveBudget,
    });
  }
  if (builtin) {
    return { matched: true, ...builtin };
  }

  const customMatch = evaluateCustomPatterns(command, confirmCommandPatterns, {
    config,
    patternTimeoutMs,
    totalTimeoutMs,
    nowMs,
  });
  if (customMatch) return customMatch;

  return { matched: false };
}

export function formatConfirmCommandAskReason(match, command) {
  const shortLabel = clipInline(match?.label || '되돌리기 어려운 명령', 56);
  const shortCmd = clipInline(command || '', 120);
  const text = `[herdr-cortex] 되돌리기 어려운 셸 명령(${shortLabel})입니다: "${shortCmd}". 의도한 실행인지 확인한 뒤 허용하세요.`;
  return clipInline(text, CONFIRM_COMMAND_REASON_MAX_CHARS);
}

export function formatConfirmCommandDenyReason(match) {
  const shortLabel = clipInline(match?.label || '되돌리기 어려운 명령', 56);
  const text =
    `[herdr-cortex] 되돌리기 어려운 셸 명령(${shortLabel})은 워커·서브에이전트에서 실행할 수 없습니다. `
    + '되돌리기 어려운 명령은 HEAD를 거쳐 사용자 확인을 받으세요.';
  return clipInline(text, CONFIRM_COMMAND_REASON_MAX_CHARS);
}
