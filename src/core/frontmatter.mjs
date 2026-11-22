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
    if (ch === "'" && !inDouble) {
      if (inSingle && raw[i + 1] === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      if (inDouble && raw[i - 1] === '\\') continue;
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

/**
 * Parse YAML frontmatter and Markdown body from raw UTF-8 text.
 */
export function parseMarkdownDoc(rawText) {
  const normalized = String(rawText ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return { frontmatter: {}, body: normalized };
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
    return { frontmatter: {}, body: normalized };
  }

  const fmLines = lines.slice(1, closeIdx);
  let body = lines.slice(closeIdx + 1).join('\n');
  if (body.startsWith('\n')) body = body.slice(1);

  const frontmatter = {};
  let i = 0;

  while (i < fmLines.length) {
    const line = fmLines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1];
    const restRaw = keyMatch[2];
    const rest = stripInlineComment(restRaw).trim();

    // Block scalar: |, |-, >, >-
    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      const folded = rest.startsWith('>');
      const blockLines = [];
      let blockIndent = null;
      i++;

      while (i < fmLines.length) {
        const nextLine = fmLines[i];
        if (nextLine.trim() === '') {
          blockLines.push('');
          i++;
          continue;
        }
        const indentMatch = /^(\s+)/.exec(nextLine);
        if (!indentMatch) break;
        const indentLen = indentMatch[1].length;
        if (blockIndent === null) blockIndent = indentLen;
        if (indentLen < blockIndent) break;
        blockLines.push(nextLine.slice(blockIndent));
        i++;
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
      frontmatter[key] = value;
      continue;
    }

    // Inline array
    if (rest.startsWith('[') && rest.endsWith(']')) {
      frontmatter[key] = parseInlineArray(rest);
      i++;
      continue;
    }

    // Empty value: could be followed by a block array (- item)
    if (rest === '') {
      const items = [];
      let j = i + 1;
      while (j < fmLines.length) {
        const nextLine = fmLines[j];
        if (!nextLine.trim()) {
          j++;
          continue;
        }
        const itemMatch = /^\s+-\s*(.*)$/.exec(nextLine);
        if (!itemMatch) break;
        const parsed = parseScalar(itemMatch[1]);
        if (parsed !== '') items.push(parsed);
        j++;
      }
      if (items.length > 0) {
        frontmatter[key] = items;
        i = j;
      } else {
        frontmatter[key] = '';
        i++;
      }
      continue;
    }

    // Regular scalar
    frontmatter[key] = parseScalar(restRaw);
    i++;
  }

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
    const val = frontmatter[key];
    if (val === undefined || val === null) continue;

    if (Array.isArray(val)) {
      const clean = val.map((v) => String(v).trim()).filter(Boolean);
      if (clean.length === 0) {
        if (INLINE_ARRAY_KEYS.has(key)) {
          lines.push(`${key}: []`);
        }
        continue;
      }
      if (INLINE_ARRAY_KEYS.has(key) && clean.every((v) => !v.includes('\n'))) {
        lines.push(`${key}: [${clean.map((v) => formatYamlScalar(v)).join(', ')}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of clean) {
          lines.push(`  - ${formatYamlScalar(item)}`);
        }
      }
      continue;
    }

    const strVal = typeof val === 'string' ? val : String(val);
    if (strVal === '' && key !== 'title' && key !== 'summary' && key !== 'due') {
      continue;
    }
    if (strVal === '' && key === 'due') {
      continue;
    }

    if (typeof val === 'string' && val.includes('\n')) {
      lines.push(`${key}: |-`);
      for (const bl of val.replace(/\r\n/g, '\n').split('\n')) {
        lines.push(`  ${bl}`);
      }
      continue;
    }

    lines.push(`${key}: ${formatYamlScalar(val)}`);
  }

  lines.push('---');
  const cleanBody = String(body ?? '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  if (!cleanBody) {
    return `${lines.join('\n')}\n`;
  }
  return `${lines.join('\n')}\n\n${cleanBody.endsWith('\n') ? cleanBody : `${cleanBody}\n`}`;
}

const URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const SOURCE_EXT_RE = /\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|ps1|psm1|psd1|sql|sqlite|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|sh|bash|zsh|yml|yaml|toml|ini|env|css|scss|html|xml|txt|csv)$/i;

function stripFencedCodeBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let fenceMarker = '';

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

function isLikelyFilePath(candidate) {
  if (!candidate || candidate.length > 260) return false;
  if (URL_RE.test(candidate)) return false;
  if (/\s/.test(candidate)) return false;
  if (candidate.startsWith('-')) return false;
  if (candidate.includes('://')) return false;
  // Must have a path separator or a recognized source file extension
  const hasSlash = candidate.includes('/') || candidate.includes('\\');
  const hasExt = SOURCE_EXT_RE.test(candidate);
  if (!hasSlash && !hasExt) return false;
  // Filter out things like "a/b" that are clearly ratios or dates like "2026/11/22"
  if (/^\d{2,4}\/\d{1,2}(?:\/\d{1,4})?$/.test(candidate)) return false;
  if (!hasExt && !/^[a-zA-Z0-9._-]+(?:[\\/][a-zA-Z0-9가-힣._-]+)+$/.test(candidate)) return false;
  return true;
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
  const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = wikiRe.exec(text)) !== null) {
    const id = m[1].trim();
    if (isValidId(id)) {
      linksTo.add(id);
    }
  }

  // 2. [label](path) markdown links (ignore images ![...] and URLs)
  const mdLinkRe = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
  while ((m = mdLinkRe.exec(text)) !== null) {
    const rawTarget = m[1].trim().split(/\s+/)[0].replace(/^<|>$/g, '');
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

  if (typeof frontmatter.supersedes === 'string' && frontmatter.supersedes.trim()) {
    const id = frontmatter.supersedes.trim();
    if (isValidId(id)) supersedes.add(id);
  } else if (Array.isArray(frontmatter.supersedes)) {
    for (const s of frontmatter.supersedes) {
      const id = String(s).trim();
      if (isValidId(id)) supersedes.add(id);
    }
  }

  if (typeof frontmatter.derived_from === 'string' && frontmatter.derived_from.trim()) {
    const id = frontmatter.derived_from.trim();
    if (isValidId(id)) derivedFrom.add(id);
  } else if (Array.isArray(frontmatter.derived_from)) {
    for (const d of frontmatter.derived_from) {
      const id = String(d).trim();
      if (isValidId(id)) derivedFrom.add(id);
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

function splitLongText(text, maxChars, overlap) {
  const chunks = [];
  const safeMax = Math.max(64, maxChars);
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(safeMax / 2)));

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

  const pushSection = () => {
    const text = currentLines.join('\n').trim();
    if (text) {
      sections.push({ heading: currentHeading, text });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      currentLines.push(line);
      continue;
    }

    if (!inFence) {
      const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (headingMatch) {
        pushSection();
        currentHeading = headingMatch[2].trim();
        currentLines.push(line);
        continue;
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
