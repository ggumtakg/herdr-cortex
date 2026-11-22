import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_TURNS = 5;
export const DEFAULT_RECENT_TURNS_BUDGET = 4500;

const NOISE_PATTERNS = [
  /<command-name>/i,
  /<local-command/i,
  /\[Request interrupted/i,
];

function isNoiseText(text) {
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  return NOISE_PATTERNS.some((re) => re.test(trimmed));
}

function readJsonlLines(filePath) {
  if (!filePath || typeof filePath !== 'string') return [];
  if (!fs.existsSync(filePath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        entries.push({ entry: parsed, lineIndex: i });
      }
    } catch {
      // Ignore partial or corrupt JSONL lines safely
    }
  }
  return entries;
}

function extractTextFromBlockContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
          return item.text.trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function isClaudeClearBoundary(entry) {
  if (entry.subtype === 'clear' || entry.type === 'clear_boundary') return true;
  const rawContent = entry.message?.content ?? entry.content;
  const text = typeof rawContent === 'string'
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n')
      : '';
  const trimmed = text.trim();
  if (/<command-name>\s*\/clear\s*<\/command-name>/i.test(trimmed)) return true;
  if (trimmed === '/clear') return true;
  return false;
}

function isClaudeCompactBoundary(entry) {
  return entry.subtype === 'compact_boundary' || entry.type === 'compact_boundary';
}

function extractClaudeEntryMessage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.isMeta === true || entry.isCompactSummary === true) return null;

  // Keep queued_command entries as user messages
  if (
    entry.type === 'queued_command'
    || entry.subtype === 'queued_command'
    || (entry.type === 'queue-operation' && entry.operation === 'enqueue')
  ) {
    const qText = extractTextFromBlockContent(entry.message?.content ?? entry.content ?? entry.text ?? '');
    if (!qText || isNoiseText(qText)) return null;
    return { role: 'user', text: qText };
  }

  const roleRaw = entry.message?.role || entry.role || (entry.type === 'user' || entry.type === 'assistant' ? entry.type : '');
  const role = String(roleRaw).toLowerCase();
  if (role !== 'user' && role !== 'assistant') return null;

  const content = entry.message?.content ?? entry.content;
  const keptParts = [];

  if (typeof content === 'string') {
    if (!isNoiseText(content)) keptParts.push(content.trim());
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block) continue;
      if (typeof block === 'string') {
        if (!isNoiseText(block)) keptParts.push(block.trim());
        continue;
      }
      if (typeof block !== 'object') continue;
      const bType = String(block.type || '').toLowerCase();

      if (bType === 'text' && typeof block.text === 'string') {
        if (!isNoiseText(block.text)) keptParts.push(block.text.trim());
      } else if (bType === 'tool_result') {
        const resText = extractTextFromBlockContent(block.content);
        if (resText && /The user answered/i.test(resText) && !isNoiseText(resText)) {
          keptParts.push(resText);
        }
      }
      // Explicitly skip tool_use, thinking, redacted_thinking, server_tool_use, etc.
    }
  }

  const combined = keptParts.join('\n').trim();
  if (!combined) return null;
  return { role, text: combined };
}

/**
 * Group linear user/assistant messages into conversation turns ({ user, assistant }).
 */
function groupMessagesIntoTurns(messages) {
  const turns = [];
  let current = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (current && (current.user || current.assistant)) {
        if (!current.assistant && current.user) {
          // Consecutive user inputs (e.g. queued command / user answer) stay separate turns
          turns.push(current);
          current = { user: msg.text, assistant: '' };
        } else {
          turns.push(current);
          current = { user: msg.text, assistant: '' };
        }
      } else {
        current = { user: msg.text, assistant: '' };
      }
    } else if (msg.role === 'assistant') {
      if (!current) {
        current = { user: '', assistant: msg.text };
      } else {
        current.assistant = current.assistant
          ? `${current.assistant}\n\n${msg.text}`
          : msg.text;
      }
    }
  }

  if (current && (current.user || current.assistant)) {
    turns.push(current);
  }
  return turns;
}

function formatSingleTurn(turn, indexLabel) {
  const parts = [`### Turn ${indexLabel}`];
  if (turn.user) parts.push(`**User:** ${turn.user}`);
  if (turn.assistant) parts.push(`**Assistant:** ${turn.assistant}`);
  return parts.join('\n');
}

/**
 * Format recent turns within maxChars, dropping oldest whole turns first so
 * newest turns remain intact.
 */
export function formatRecentTurns(
  turns,
  {
    maxChars = DEFAULT_RECENT_TURNS_BUDGET,
    heading = '## Recent Conversation Turns',
  } = {},
) {
  if (!Array.isArray(turns) || turns.length === 0 || maxChars <= 0) {
    return { turns: [], text: '', charCount: 0, droppedCount: 0 };
  }

  const keptReversed = [];
  let usedChars = heading.length;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const block = formatSingleTurn(turn, i + 1);
    const needed = 2 + block.length;

    if (usedChars + needed <= maxChars) {
      keptReversed.push({ turn, block });
      usedChars += needed;
    } else if (keptReversed.length === 0) {
      // Even the single newest turn alone exceeds maxChars -> trim only this newest turn cleanly at line/word boundary
      const avail = maxChars - heading.length - 2;
      if (avail >= 40) {
        const suffix = '\n[...trimmed]';
        const sliceLimit = Math.max(20, avail - suffix.length);
        const clipped = block.slice(0, sliceLimit).replace(/\s+\S*$/, '').trimEnd() || block.slice(0, sliceLimit);
        keptReversed.push({ turn, block: `${clipped}${suffix}` });
      }
      break;
    } else {
      // Stop adding older turns; keep newest intact
      break;
    }
  }

  if (keptReversed.length === 0) {
    return { turns: [], text: '', charCount: 0, droppedCount: turns.length };
  }

  const kept = keptReversed.reverse();
  // Re-number kept turns cleanly from 1..N while keeping exact formatted text within budget
  const renumberedBlocks = kept.map((item, idx) => {
    const replaced = item.block.replace(/^### Turn \d+/, `### Turn ${idx + 1}`);
    return replaced;
  });
  const text = `${heading}\n\n${renumberedBlocks.join('\n\n')}`;

  return {
    turns: kept.map((k) => k.turn),
    text,
    charCount: text.length,
    droppedCount: turns.length - kept.length,
  };
}

/**
 * Extract last N pure user+assistant turns from a Claude Code JSONL transcript.
 */
export function extractClaudeRecentTurns(
  transcriptPath,
  {
    maxTurns = DEFAULT_MAX_TURNS,
    maxChars = DEFAULT_RECENT_TURNS_BUDGET,
  } = {},
) {
  const rows = readJsonlLines(transcriptPath);
  if (rows.length === 0) {
    return { turns: [], text: '', charCount: 0, droppedCount: 0, boundaryType: null };
  }

  // Locate all compact_boundary and /clear boundaries
  const boundaries = [];
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i].entry;
    if (isClaudeCompactBoundary(e)) {
      boundaries.push({ index: i, kind: 'compact' });
    } else if (isClaudeClearBoundary(e)) {
      boundaries.push({ index: i, kind: 'clear' });
    }
  }

  const extractRange = (startIdx, endIdx) => {
    const msgs = [];
    for (let i = startIdx; i < endIdx; i++) {
      const m = extractClaudeEntryMessage(rows[i].entry);
      if (m) msgs.push(m);
    }
    return groupMessagesIntoTurns(msgs);
  };

  let boundaryType = null;
  let segmentTurns;

  if (boundaries.length === 0) {
    segmentTurns = extractRange(0, rows.length);
  } else {
    const lastBoundary = boundaries[boundaries.length - 1];
    boundaryType = lastBoundary.kind;
    segmentTurns = extractRange(lastBoundary.index + 1, rows.length);

    // Immediately after /compact or /clear writes a trailing boundary, restore the turns right before it
    if (segmentTurns.length === 0 && (lastBoundary.kind === 'compact' || lastBoundary.kind === 'clear')) {
      const prevBoundaryIdx = boundaries.length >= 2 ? boundaries[boundaries.length - 2].index + 1 : 0;
      segmentTurns = extractRange(prevBoundaryIdx, lastBoundary.index);
    }
  }

  const recent = segmentTurns.slice(-Math.max(1, maxTurns));
  const formatted = formatRecentTurns(recent, { maxChars });

  return {
    ...formatted,
    boundaryType,
  };
}

function resolveAntigravityTranscriptPath(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return '';
  const resolved = path.resolve(transcriptPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const fullInDir = path.join(resolved, 'transcript_full.jsonl');
    if (fs.existsSync(fullInDir)) return fullInDir;
    const plainInDir = path.join(resolved, 'transcript.jsonl');
    if (fs.existsSync(plainInDir)) return plainInDir;
    return '';
  }
  if (path.basename(resolved) === 'transcript.jsonl') {
    const siblingFull = path.join(path.dirname(resolved), 'transcript_full.jsonl');
    if (fs.existsSync(siblingFull)) return siblingFull;
  }
  return fs.existsSync(resolved) ? resolved : '';
}

function extractUserRequestTag(text) {
  if (typeof text !== 'string') return '';
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(text);
  if (match) {
    return match[1].trim();
  }
  return text.trim();
}

function getAntigravityStepType(entry) {
  return String(
    entry.type
    || entry.stepType
    || entry.step_type
    || entry.kind
    || '',
  ).toUpperCase();
}

function extractAntigravityCheckpoint(entry, lineIndex) {
  const stepType = getAntigravityStepType(entry);
  const isCheckpoint =
    stepType === 'CHECKPOINT'
    || stepType.endsWith('_CHECKPOINT')
    || Boolean(entry.checkpoint && typeof entry.checkpoint === 'object');
  if (!isCheckpoint) return null;

  const status = String(
    entry.status
    || entry.stepStatus
    || entry.step_status
    || entry.metadata?.status
    || entry.checkpoint?.status
    || '',
  ).toUpperCase();

  if (status !== 'DONE' && !status.endsWith('_DONE')) return null;

  const stepIndex =
    entry.step_index
    ?? entry.stepIndex
    ?? entry.index
    ?? entry.metadata?.stepIndex
    ?? entry.metadata?.step_index
    ?? lineIndex;
  const createdAt = String(
    entry.created_at
    || entry.createdAt
    || entry.metadata?.createdAt
    || entry.metadata?.created_at
    || entry.timestamp
    || '',
  ).trim();

  return {
    key: `${stepIndex}:${createdAt}`,
    stepIndex,
    createdAt,
  };
}

function extractAntigravityMessage(entry) {
  const stepType = getAntigravityStepType(entry);

  // USER_INPUT / USER_EXPLICIT
  if (
    stepType === 'USER_INPUT'
    || stepType === 'USER_EXPLICIT'
    || stepType.endsWith('_USER_INPUT')
    || stepType.endsWith('_USER_EXPLICIT')
    || entry.userInput
    || entry.user_input
  ) {
    const ui = entry.userInput || entry.user_input || {};
    let rawText = '';
    if (typeof ui.userResponse === 'string' && ui.userResponse.trim()) {
      rawText = ui.userResponse;
    } else if (Array.isArray(ui.items)) {
      rawText = ui.items
        .map((it) => (typeof it === 'string' ? it : it?.text || ''))
        .filter(Boolean)
        .join('\n');
    } else if (typeof entry.text === 'string') {
      rawText = entry.text;
    } else if (typeof entry.content === 'string') {
      rawText = entry.content;
    } else if (Array.isArray(entry.content)) {
      rawText = extractTextFromBlockContent(entry.content);
    }

    const cleaned = extractUserRequestTag(rawText);
    if (!cleaned || isNoiseText(cleaned)) return null;
    return { role: 'user', text: cleaned };
  }

  // PLANNER_RESPONSE
  if (
    stepType === 'PLANNER_RESPONSE'
    || stepType.endsWith('_PLANNER_RESPONSE')
    || entry.plannerResponse
    || entry.planner_response
  ) {
    const pr = entry.plannerResponse || entry.planner_response || {};
    const rawText =
      (typeof pr.modifiedResponse === 'string' && pr.modifiedResponse.trim() ? pr.modifiedResponse : '')
      || (typeof pr.response === 'string' && pr.response.trim() ? pr.response : '')
      || (typeof pr.text === 'string' && pr.text.trim() ? pr.text : '')
      || (typeof entry.response === 'string' && entry.response.trim() ? entry.response : '')
      || (typeof entry.text === 'string' && entry.text.trim() ? entry.text : '')
      || (typeof entry.content === 'string' && entry.content.trim() ? entry.content : '');

    const cleaned = rawText.trim();
    if (!cleaned || isNoiseText(cleaned)) return null;
    return { role: 'assistant', text: cleaned };
  }

  return null;
}

/**
 * Extract latest CHECKPOINT (DONE) key (${step_index}:${created_at}) and last N pure
 * USER_INPUT/USER_EXPLICIT + PLANNER_RESPONSE turns from an Antigravity JSONL transcript.
 */
export function extractAntigravityState(
  transcriptPath,
  {
    maxTurns = DEFAULT_MAX_TURNS,
    maxChars = DEFAULT_RECENT_TURNS_BUDGET,
  } = {},
) {
  const actualPath = resolveAntigravityTranscriptPath(transcriptPath);
  const rows = readJsonlLines(actualPath);
  if (rows.length === 0) {
    return {
      transcriptPath: actualPath || null,
      latestCheckpoint: null,
      turns: [],
      text: '',
      charCount: 0,
      droppedCount: 0,
    };
  }

  let latestCheckpoint = null;
  const messages = [];

  for (const { entry, lineIndex } of rows) {
    const cp = extractAntigravityCheckpoint(entry, lineIndex);
    if (cp) {
      latestCheckpoint = cp;
      continue;
    }
    const msg = extractAntigravityMessage(entry);
    if (msg) {
      messages.push(msg);
    }
  }

  const allTurns = groupMessagesIntoTurns(messages);
  const recent = allTurns.slice(-Math.max(1, maxTurns));
  const formatted = formatRecentTurns(recent, { maxChars });

  return {
    transcriptPath: actualPath,
    latestCheckpoint,
    ...formatted,
  };
}
