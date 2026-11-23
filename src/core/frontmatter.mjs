import { isValidId, sanitizeRelFilePath } from './config.mjs';

const CANONICAL_KEYS = [
  'id',
  'type',
  'title',
  'summary',
  'status',
  'session',
  'branch',
  'tags',
  'files',
  'supersedes',
  'derived_from',
  'due',
  'created_at',
  'updated_at',
];

const INLINE_ARRAY_KEYS = new Set(['tags']);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const NEEDS_QUOTING_RE = /^[\s]|[\s]$|[:#\[\]{},&*!|>'"%@`?\\]|^(?:true|false|null|~|yes|no|on|off)$/i;

function stripInlineComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && inDouble && i + 1 < raw.length) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      if (inSingle && raw[i + 1] === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(raw[i - 1])) {
        return raw.slice(0, i).trimEnd();
      }
    }
  }
  return raw.trimEnd();
}

function parseScalar(rawInput) {
  const raw = stripInlineComment(String(rawInput ?? '')).trim();
  if (raw === '' || raw === 'null' || raw === '~') return '';

  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }

  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }

  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (ISO_DATE_RE.test(raw)) return raw;
  if (NUMBER_RE.test(raw)) return Number(raw);
  return raw;
}

function parseInlineArray(rawInput) {
  const raw = stripInlineComment(rawInput).trim();
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];

  const items = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      if (inSingle && inner[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === '\\' && inDouble && i + 1 < inner.length) {
      current += ch + inner[++i];
    } else if (ch === ',' && !inSingle && !inDouble) {
      const val = parseScalar(current);
      if (val !== '') items.push(val);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') {
    const val = parseScalar(current);
    if (val !== '') items.push(val);
  }
  return items;
}

const FRONTMATTER_KEY_RE = /^([A-Za-z0-9_-]+)\s*:(.*)$/;

/**
 * Raised when a document cannot be rewritten without risking loss of content.
 * Callers must not write anything; the file has to be fixed by hand.
 */
export class UnsafeUpdateError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'UnsafeUpdateError';
    this.code = 'UNSAFE_UPDATE';
    this.reason = reason;
  }
}

/**
 * Parse the value of the `key: value` entry that starts at fmLines[i].
 * Returns { value, next } where `next` is the index of the first line after the entry.
 */
function parseFrontmatterValue(fmLines, i, restRaw) {
  const rest = stripInlineComment(restRaw).trim();

  // Block scalar: |, |-, >, >-
  if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
    const folded = rest.startsWith('>');
    const blockLines = [];
    let blockIndent = null;
    let next = i + 1;

    while (next < fmLines.length) {
      const nextLine = fmLines[next];
      if (nextLine.trim() === '') {
        blockLines.push('');
        next++;
        continue;
      }
      const indentMatch = /^(\s+)/.exec(nextLine);
      if (!indentMatch) break;
      const indentLen = indentMatch[1].length;
      if (blockIndent === null) blockIndent = indentLen;
      if (indentLen < blockIndent) break;
      blockLines.push(nextLine.slice(blockIndent));
      next++;
    }

    while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') {
      blockLines.pop();
    }

    let value;
    if (folded) {
      value = blockLines
        .map((l, idx) => {
          if (l === '') return '\n';
          if (idx > 0 && blockLines[idx - 1] !== '') return ` ${l}`;
          return l;
        })
        .join('');
    } else {
      value = blockLines.join('\n');
    }
    return { value, next };
  }

  // Inline array
  if (rest.startsWith('[') && rest.endsWith(']')) {
    return { value: parseInlineArray(rest), next: i + 1 };
  }

  // Empty value: could be followed by a block array (- item), indented or unindented
  if (rest === '') {
    const items = [];
    let j = i + 1;
    while (j < fmLines.length) {
      const nextLine = fmLines[j];
      if (!nextLine.trim()) {
        j++;
        continue;
      }
      if (/^\s*---/.test(nextLine)) break;
      const itemMatch = /^\s*-(?:\s+(.*)|\s*)$/.exec(nextLine);
      if (!itemMatch) break;
      const parsed = parseScalar(itemMatch[1] ?? '');
      if (parsed !== '') items.push(parsed);
      j++;
    }
    if (items.length > 0) {
      return { value: items, next: j };
    }
    return { value: '', next: i + 1 };
  }

  // Regular scalar
  return { value: parseScalar(restRaw), next: i + 1 };
}

/**
 * Parse YAML frontmatter and Markdown body, keeping the original frontmatter lines.
 * Returns { frontmatter, body, hasFrontmatter, entries } where `entries` lists the frontmatter block
 * in file order:
 *   { key, lines }               a `key: value` entry the parser understood (with its value lines)
 *   { key: null, lines, inert }  a line it did not interpret (`inert` = blank line or comment)
 * `renderUpdatedMarkdownDoc` uses the entries to rewrite a document without dropping such lines.
 */
export function parseMarkdownDocDetailed(rawText) {
  const normalized = String(rawText ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const noFrontmatter = () => ({ frontmatter: {}, body: normalized, hasFrontmatter: false, entries: [] });

  if (!/^---[ \t]*(?:\n|$)/.test(normalized)) {
    return noFrontmatter();
  }

  const lines = normalized.split('\n');
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    return noFrontmatter();
  }

  const fmLines = lines.slice(1, closeIdx);

  // A leading `---` ... `---` block without a single `key: value` line is a pair of horizontal
  // rules around ordinary text, not frontmatter: keep the whole file as body.
  if (!fmLines.some((line) => FRONTMATTER_KEY_RE.test(line))) {
    return noFrontmatter();
  }

  let body = lines.slice(closeIdx + 1).join('\n');
  if (body.startsWith('\n')) body = body.slice(1);

  const frontmatter = {};
  const entries = [];
  let i = 0;

  while (i < fmLines.length) {
    const line = fmLines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      entries.push({ key: null, lines: [line], inert: true });
      i++;
      continue;
    }

    const keyMatch = FRONTMATTER_KEY_RE.exec(line);
    if (!keyMatch) {
      entries.push({ key: null, lines: [line], inert: false });
      i++;
      continue;
    }

    const key = keyMatch[1];
    const { value, next } = parseFrontmatterValue(fmLines, i, keyMatch[2]);
    frontmatter[key] = value;
    entries.push({ key, lines: fmLines.slice(i, next) });
    i = next;
  }

  // Coerce numeric document reference fields to strings
  for (const strKey of ['id', 'supersedes']) {
    if (typeof frontmatter[strKey] === 'number') {
      frontmatter[strKey] = String(frontmatter[strKey]);
    }
  }
  if (typeof frontmatter.derived_from === 'number') {
    frontmatter.derived_from = String(frontmatter.derived_from);
  } else if (Array.isArray(frontmatter.derived_from)) {
    frontmatter.derived_from = frontmatter.derived_from.map((v) => String(v));
  }

  return { frontmatter, body, hasFrontmatter: true, entries };
}

/**
 * Parse YAML frontmatter and Markdown body from raw UTF-8 text.
 */
export function parseMarkdownDoc(rawText) {
  const { frontmatter, body } = parseMarkdownDocDetailed(rawText);
  return { frontmatter, body };
}

function formatYamlScalar(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);

  const str = String(value);
  if (str.includes('\n')) {
    return JSON.stringify(str);
  }
  if (ISO_DATE_RE.test(str)) {
    return str;
  }
  if (NEEDS_QUOTING_RE.test(str) || NUMBER_RE.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

/**
 * Format one frontmatter key as YAML lines. Returns [] when the key is omitted from the output.
 */
function formatFrontmatterEntry(key, val) {
  if (val === undefined || val === null) return [];

  if (Array.isArray(val)) {
    const clean = val.map((v) => String(v).trim()).filter(Boolean);
    if (clean.length === 0) {
      return INLINE_ARRAY_KEYS.has(key) ? [`${key}: []`] : [];
    }
    if (INLINE_ARRAY_KEYS.has(key) && clean.every((v) => !v.includes('\n'))) {
      return [`${key}: [${clean.map((v) => formatYamlScalar(v)).join(', ')}]`];
    }
    const out = [`${key}:`];
    for (const item of clean) {
      out.push(`  - ${formatYamlScalar(item)}`);
    }
    return out;
  }

  const strVal = typeof val === 'string' ? val : String(val);
  if (strVal === '' && key !== 'title' && key !== 'summary') {
    return [];
  }

  if (typeof val === 'string' && val.includes('\n')) {
    const out = [`${key}: |-`];
    for (const bl of val.replace(/\r\n/g, '\n').split('\n')) {
      out.push(`  ${bl}`);
    }
    return out;
  }

  return [`${key}: ${formatYamlScalar(val)}`];
}

function normalizeBodyForWrite(body) {
  return String(body ?? '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
}

function joinFrontmatterAndBody(lines, body) {
  const cleanBody = normalizeBodyForWrite(body);
  if (!cleanBody) {
    return `${lines.join('\n')}\n`;
  }
  return `${lines.join('\n')}\n\n${cleanBody.endsWith('\n') ? cleanBody : `${cleanBody}\n`}`;
}

/**
 * Serialize frontmatter object + Markdown body back to deterministic YAML frontmatter Markdown.
 */
export function serializeMarkdownDoc(frontmatter = {}, body = '') {
  const orderedKeys = [];
  const seen = new Set();

  for (const key of CANONICAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }
  for (const key of Object.keys(frontmatter)) {
    if (!seen.has(key)) {
      orderedKeys.push(key);
    }
  }

  const lines = ['---'];
  for (const key of orderedKeys) {
    for (const line of formatFrontmatterEntry(key, frontmatter[key])) {
      lines.push(line);
    }
  }
  lines.push('---');
  return joinFrontmatterAndBody(lines, body);
}

function frontmatterValuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => String(v) === String(b[i]));
  }
  return a === b;
}

function stripTrailingNewlines(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end--;
  return text.slice(0, end);
}

/**
 * True when the key entry at `index` is followed by indented lines the parser did not interpret
 * (children of a nested mapping, the rest of a multi-line scalar, ...). Those lines belong to the
 * key's value, so replacing the key would silently detach or drop them.
 */
function hasUninterpretedContinuation(entries, index) {
  for (let j = index + 1; j < entries.length; j++) {
    const entry = entries[j];
    if (entry.key !== null) return false;
    if (entry.inert) continue;
    return /^\s/.test(entry.lines[0]);
  }
  return false;
}

function uninterpretedLines(entries) {
  const out = [];
  for (const entry of entries) {
    if (entry.key === null && entry.lines[0].trim() !== '') out.push(entry.lines[0]);
  }
  return out;
}

/**
 * Re-read the rewritten text and confirm that everything the update did not touch is still there:
 * the body, every frontmatter line the parser did not interpret, and the value of every unchanged key.
 */
function assertRewritePreservesContent(parsed, frontmatter, body, text) {
  const reparsed = parseMarkdownDocDetailed(text);
  if (!reparsed.hasFrontmatter) {
    throw new UnsafeUpdateError('the rewritten frontmatter would no longer be recognized as frontmatter');
  }
  if (stripTrailingNewlines(reparsed.body) !== stripTrailingNewlines(normalizeBodyForWrite(body))) {
    throw new UnsafeUpdateError('the document body would not survive the rewrite unchanged');
  }
  const before = uninterpretedLines(parsed.entries);
  const after = uninterpretedLines(reparsed.entries);
  if (before.length !== after.length || before.some((line, i) => line !== after[i])) {
    throw new UnsafeUpdateError('frontmatter lines this tool does not interpret (comments, nested or multi-line YAML) would not survive the rewrite unchanged');
  }
  for (const key of Object.keys(parsed.frontmatter)) {
    const original = parsed.frontmatter[key];
    const untouched = Object.prototype.hasOwnProperty.call(frontmatter, key)
      && frontmatterValuesEqual(original, frontmatter[key]);
    if (untouched && !frontmatterValuesEqual(original, reparsed.frontmatter[key])) {
      throw new UnsafeUpdateError(`frontmatter key "${key}" was not changed but would be read differently after the rewrite`);
    }
  }
}

/**
 * Rewrite a parsed document (`parseMarkdownDocDetailed` result) with an updated frontmatter object and body.
 *
 * Unlike `serializeMarkdownDoc`, only the keys whose value actually changed are re-formatted. Every other
 * frontmatter line is emitted exactly as it was read, in place: unchanged keys, comments, blank lines,
 * and lines the parser does not understand (nested YAML and the like). New keys are inserted at their
 * canonical position, so a document written by this tool comes out identical to `serializeMarkdownDoc`.
 *
 * Throws `UnsafeUpdateError` instead of returning text when the rewrite could lose content.
 */
export function renderUpdatedMarkdownDoc(parsed, frontmatter = {}, body = '') {
  if (!parsed || !parsed.hasFrontmatter) {
    // No frontmatter block to preserve: the whole original file is the body.
    return serializeMarkdownDoc(frontmatter, body);
  }

  const { entries } = parsed;
  const hasKey = (key) => Object.prototype.hasOwnProperty.call(frontmatter, key);
  const lastEntryOfKey = new Map();
  entries.forEach((entry, idx) => {
    if (entry.key !== null) lastEntryOfKey.set(entry.key, idx);
  });

  const canonicalRank = new Map(CANONICAL_KEYS.map((key, idx) => [key, idx]));
  const newCanonicalKeys = CANONICAL_KEYS.filter((key) => hasKey(key) && !lastEntryOfKey.has(key));
  const newOtherKeys = Object.keys(frontmatter).filter((key) => !canonicalRank.has(key) && !lastEntryOfKey.has(key));

  const lines = ['---'];
  const emit = (entryLines) => {
    for (const line of entryLines) lines.push(line);
  };

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    if (entry.key === null) {
      emit(entry.lines);
      continue;
    }

    const rank = canonicalRank.get(entry.key);
    if (rank !== undefined) {
      while (newCanonicalKeys.length > 0 && canonicalRank.get(newCanonicalKeys[0]) < rank) {
        const key = newCanonicalKeys.shift();
        emit(formatFrontmatterEntry(key, frontmatter[key]));
      }
    }

    // With duplicate keys only the last one is effective; earlier ones are kept as they are.
    const isEffective = lastEntryOfKey.get(entry.key) === idx;
    const unchanged = !isEffective
      || (hasKey(entry.key) && frontmatterValuesEqual(parsed.frontmatter[entry.key], frontmatter[entry.key]));
    if (unchanged) {
      emit(entry.lines);
      continue;
    }

    if (hasUninterpretedContinuation(entries, idx)) {
      throw new UnsafeUpdateError(
        `frontmatter key "${entry.key}" is followed by indented lines this tool does not interpret (nested or multi-line YAML), so replacing its value could detach or drop them`,
      );
    }
    emit(formatFrontmatterEntry(entry.key, frontmatter[entry.key]));
  }

  for (const key of [...newCanonicalKeys, ...newOtherKeys]) {
    emit(formatFrontmatterEntry(key, frontmatter[key]));
  }

  lines.push('---');
  const text = joinFrontmatterAndBody(lines, body);
  assertRewritePreservesContent(parsed, frontmatter, body, text);
  return text;
}

const URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const SOURCE_EXT_RE = /\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|ps1|psm1|psd1|sql|sqlite|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|sh|bash|zsh|yml|yaml|toml|ini|env|css|scss|html|xml|txt|csv)$/i;
const MIME_TYPE_RE = /^(?:application|text|image|audio|video|font|multipart|message|model)\/[a-z0-9.+-]+$/i;
const KNOWN_ROOT_DIR_RE = /^(?:\.github|\.memory|\.claude|\.gemini|src|test|tests|docs|scripts|prompts|bin|lib|pkg|cmd|app|apps|packages|config|public|assets|internal)\//i;

function stripFencedCodeBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (const line of lines) {
    if (!inFence) {
      const openMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (openMatch) {
        inFence = true;
        fenceChar = openMatch[1][0];
        fenceLen = openMatch[1].length;
        continue;
      }
      out.push(line);
    } else {
      const closeMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
    }
  }
  return out.join('\n');
}

function isLikelyFilePath(candidate) {
  if (!candidate || candidate.length > 260) return false;
  if (URL_RE.test(candidate)) return false;
  if (/\s/.test(candidate)) return false;
  if (candidate.startsWith('-')) return false;
  if (candidate.includes('://')) return false;
  if (MIME_TYPE_RE.test(candidate)) return false;

  const hasSlash = candidate.includes('/') || candidate.includes('\\');
  const hasExt = SOURCE_EXT_RE.test(candidate);
  if (!hasSlash && !hasExt) return false;

  // Filter out dates like "2026/11/22" or numeric ratios like "3/4"
  if (/^\d{1,4}\/\d{1,2}(?:\/\d{1,4})?$/.test(candidate)) return false;

  if (!hasExt) {
    if (!/^[a-zA-Z0-9._-]+(?:[\\/][a-zA-Z0-9가-힣._-]+)+$/.test(candidate)) return false;
    const normalized = candidate.replace(/\\/g, '/');
    const parts = normalized.split('/');
    // Reject ALL-CAPS slash pairs like "GET/POST", "CI/CD", "I/O"
    if (parts.length === 2 && /^[A-Z0-9_-]+$/.test(parts[0]) && /^[A-Z0-9_-]+$/.test(parts[1])) {
      return false;
    }
    // For extensionless 2-segment tokens like "in/out", "read/write", "true/false",
    // require either a known project root directory prefix or a dot-segment (e.g. ".github/workflows")
    if (parts.length === 2 && !KNOWN_ROOT_DIR_RE.test(normalized) && !parts.some((p) => p.includes('.'))) {
      return false;
    }
  }
  return true;
}

/**
 * Build a lookup "first index >= from of any character in `chars`" (text.length when there is none).
 * The last answer is cached, so a caller whose `from` only moves forward scans the text once in total.
 */
function makeForwardFinder(text, chars) {
  let cachedFrom = 0;
  let cachedIndex = -1;
  return (from) => {
    if (cachedIndex >= 0 && from >= cachedFrom && from <= cachedIndex) return cachedIndex;
    let i = from;
    while (i < text.length && !chars.includes(text[i])) i++;
    cachedFrom = from;
    cachedIndex = i;
    return i;
  };
}

/**
 * Targets of `[[target]]` / `[[target|alias]]` wiki links, in document order.
 * Linear-time scanner returning exactly the capture group of
 * /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, which backtracks quadratically on long runs of "[".
 */
export function scanWikiLinkTargets(text) {
  const src = String(text ?? '');
  const targets = [];
  const nextStop = makeForwardFinder(src, ']|');
  const nextClose = makeForwardFinder(src, ']');
  let pos = 0;

  while (true) {
    const open = src.indexOf('[[', pos);
    if (open === -1) break;

    const stop = nextStop(open + 2); // end of the target: first "]" or "|"
    let end = -1;
    if (stop > open + 2 && stop < src.length) {
      const close = src[stop] === '|' ? nextClose(stop + 1) : stop;
      if (src[close] === ']' && src[close + 1] === ']') end = close + 2;
    }

    if (end === -1) {
      pos = open + 1;
      continue;
    }
    targets.push(src.slice(open + 2, stop));
    pos = end;
  }
  return targets;
}

/**
 * Targets of `[label](target)` Markdown links (images `![...](...)` excluded), in document order.
 * Linear-time scanner returning exactly the capture group of
 * /(?<!!)\[[^\]]+\]\(([^)]+)\)/g, which backtracks quadratically on long runs of "[" or "[a](".
 */
export function scanMarkdownLinkTargets(text) {
  const src = String(text ?? '');
  const targets = [];
  const nextBracketClose = makeForwardFinder(src, ']');
  const nextParenClose = makeForwardFinder(src, ')');
  let pos = 0;

  while (true) {
    const open = src.indexOf('[', pos);
    if (open === -1) break;
    pos = open + 1;
    if (open > 0 && src[open - 1] === '!') continue;

    const close = nextBracketClose(open + 1); // label must be non-empty and followed by "("
    if (close === open + 1 || close >= src.length || src[close + 1] !== '(') continue;

    const paren = nextParenClose(close + 2); // target must be non-empty
    if (paren === close + 2 || paren >= src.length) continue;

    targets.push(src.slice(close + 2, paren));
    pos = paren + 1;
  }
  return targets;
}

/**
 * Heading text of an ATX heading line (`# Title`), or null when the line is not a heading.
 * Linear-time equivalent of /^(#{1,6})\s+(.+?)\s*$/ followed by trimming the capture; that pattern
 * backtracks quadratically on a heading with a long run of spaces in the middle.
 */
export function parseHeadingLine(line) {
  const prefix = /^#{1,6}\s/.exec(line);
  if (!prefix) return null;
  const rest = line.slice(prefix[0].length);
  const text = rest.trim();
  // `.` never matches a line terminator, so the original pattern rejects a heading that contains one.
  if (text === '') return /[^\r\u2028\u2029]/.test(rest) ? '' : null;
  return /[\r\u2028\u2029]/.test(text) ? null : text;
}

/**
 * Extract structured references from Markdown body and frontmatter:
 * - linksTo: [[doc-id]] wikilinks
 * - fileLinks: [label](path) markdown links (ignoring URLs)
 * - codeFiles: `path` inline code file references (ignoring URLs)
 * - pointsFiles: union of frontmatter.files + codeFiles
 * - supersedes: string[]
 * - derivedFrom: string[]
 */
export function extractReferences(content, frontmatter = {}) {
  const text = stripFencedCodeBlocks(content);

  const linksTo = new Set();
  const fileLinks = new Set();
  const codeFiles = new Set();
  const pointsFiles = new Set();
  const supersedes = new Set();
  const derivedFrom = new Set();

  // 1. [[doc-id]] or [[doc-id|alias]]
  for (const target of scanWikiLinkTargets(text)) {
    const id = target.trim();
    if (isValidId(id)) {
      linksTo.add(id);
    }
  }

  // 2. [label](path) markdown links (ignore images ![...] and URLs)
  let m;
  for (const target of scanMarkdownLinkTargets(text)) {
    const rawTarget = target.trim().split(/\s+/)[0].replace(/^<|>$/g, '');
    if (!rawTarget || URL_RE.test(rawTarget)) continue;
    const withoutFragment = rawTarget.split('#')[0].split('?')[0];
    if (!withoutFragment) continue;
    const sanitized = sanitizeRelFilePath(withoutFragment);
    if (sanitized) {
      fileLinks.add(sanitized);
    }
  }

  // 3. `path` inline code references
  const codeRe = /`([^`\n]+)`/g;
  while ((m = codeRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (isLikelyFilePath(candidate)) {
      const sanitized = sanitizeRelFilePath(candidate);
      if (sanitized) {
        codeFiles.add(sanitized);
        pointsFiles.add(sanitized);
      }
    }
  }

  // 4. Frontmatter files, supersedes, derived_from
  if (Array.isArray(frontmatter.files)) {
    for (const f of frontmatter.files) {
      const sanitized = sanitizeRelFilePath(String(f));
      if (sanitized) {
        pointsFiles.add(sanitized);
      }
    }
  } else if (typeof frontmatter.files === 'string' && frontmatter.files.trim()) {
    const sanitized = sanitizeRelFilePath(frontmatter.files);
    if (sanitized) {
      pointsFiles.add(sanitized);
    }
  }

  if (typeof frontmatter.supersedes === 'string' || typeof frontmatter.supersedes === 'number') {
    const id = String(frontmatter.supersedes).trim();
    if (id && isValidId(id)) supersedes.add(id);
  } else if (Array.isArray(frontmatter.supersedes)) {
    for (const s of frontmatter.supersedes) {
      const id = String(s).trim();
      if (id && isValidId(id)) supersedes.add(id);
    }
  }

  if (typeof frontmatter.derived_from === 'string' || typeof frontmatter.derived_from === 'number') {
    const id = String(frontmatter.derived_from).trim();
    if (id && isValidId(id)) derivedFrom.add(id);
  } else if (Array.isArray(frontmatter.derived_from)) {
    for (const d of frontmatter.derived_from) {
      const id = String(d).trim();
      if (id && isValidId(id)) derivedFrom.add(id);
    }
  }

  return {
    linksTo: [...linksTo],
    fileLinks: [...fileLinks],
    codeFiles: [...codeFiles],
    pointsFiles: [...pointsFiles],
    supersedes: [...supersedes],
    derivedFrom: [...derivedFrom],
  };
}

export function splitLongText(text, maxChars, overlap) {
  const chunks = [];
  const safeMax = Math.max(32, maxChars);
  const safeOverlap = Math.max(0, Math.min(overlap ?? 0, Math.floor(safeMax / 2)));

  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + safeMax);

    if (end < text.length) {
      // Prefer paragraph break, then line break, then sentence/space break
      const slice = text.slice(start, end);
      const minCut = Math.floor(safeMax * 0.4);
      let cut = slice.lastIndexOf('\n\n');
      if (cut < minCut) cut = slice.lastIndexOf('\n');
      if (cut < minCut) cut = slice.lastIndexOf('. ');
      if (cut < minCut) cut = slice.lastIndexOf(' ');
      if (cut >= minCut) {
        end = start + cut + 1;
      }
    }

    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;

    const nextStart = end - safeOverlap;
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

/**
 * Section-aware Markdown chunker.
 * Splits by headings first, then splits oversized sections with overlap.
 * Returns [{ chunkIndex, heading, text }].
 */
export function chunkMarkdown(content, { maxChars = 800, overlap = 100 } = {}) {
  const normalized = String(content ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const sections = [];
  let currentHeading = '';
  let currentLines = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  const pushSection = () => {
    const text = currentLines.join('\n').trim();
    if (text) {
      sections.push({ heading: currentHeading, text });
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (!inFence) {
      const openMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (openMatch) {
        inFence = true;
        fenceChar = openMatch[1][0];
        fenceLen = openMatch[1].length;
        currentLines.push(line);
        continue;
      }
      const headingText = parseHeadingLine(line);
      if (headingText !== null) {
        pushSection();
        currentHeading = headingText;
        currentLines.push(line);
        continue;
      }
    } else {
      const closeMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
    }

    currentLines.push(line);
  }
  pushSection();

  const chunks = [];
  let chunkIndex = 0;

  for (const section of sections) {
    if (section.text.length <= maxChars) {
      chunks.push({
        chunkIndex: chunkIndex++,
        heading: section.heading,
        text: section.text,
      });
    } else {
      const pieces = splitLongText(section.text, maxChars, overlap);
      for (const piece of pieces) {
        chunks.push({
          chunkIndex: chunkIndex++,
          heading: section.heading,
          text: piece,
        });
      }
    }
  }

  return chunks;
}
