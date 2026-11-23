import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_TURNS = 5;
export const DEFAULT_RECENT_TURNS_BUDGET = 4500;
// First tail window read from a transcript (fast on 100MB+ files). When it does not hold enough complete
// records for the requested turns, the window doubles (4 MB, 8 MB, ...) up to MAX_TAIL_BYTES_CAP.
export const DEFAULT_MAX_TAIL_BYTES = 2 * 1024 * 1024;
export const MAX_TAIL_BYTES_CAP = 32 * 1024 * 1024;
// A single transcript record (one JSONL line) larger than this is skipped without being decoded or parsed.
export const MAX_TRANSCRIPT_RECORD_BYTES = 4 * 1024 * 1024;

/**
 * Why no turn could be restored although the transcript has content (`restoreFailure` of the extractors):
 * - RESTORE_FAILURE_RECORD_TOO_LARGE: the window reached its cap without one complete record, or the only
 *   records in reach were larger than the per-record limit.
 * - RESTORE_FAILURE_NO_TURNS_WITHIN_CAP: complete records were read up to the cap, none of them is a turn.
 */
export const RESTORE_FAILURE_RECORD_TOO_LARGE = 'record_too_large';
export const RESTORE_FAILURE_NO_TURNS_WITHIN_CAP = 'no_turns_within_cap';

// ---------------------------------------------------------------------------------------------
// Shared part: tail reading, the common message shape, turn grouping and formatting.
//
// A host adapter ({ name, toMessage(entry), boundaryKind(entry) }) turns one parsed transcript record into
// the common message shape
//   { role: 'user' | 'assistant', text: string, human: boolean }
// or null when the record carries no conversation text. `human` says whether a user-side message was typed
// by the person (always false for assistant messages). Everything outside the adapters is host-independent:
// only a message with `human: true` opens a turn, assistant replies join the turn of the human message
// before them, and user-side messages that the person did not type are left out.
// ---------------------------------------------------------------------------------------------

const NOISE_PATTERNS = [
  /^\s*<command-name>/i,
  /^\s*<local-command/i,
  /^\s*\[Request interrupted/i,
];

// Auxiliary text filter applied to every host's messages (the adapters decide who typed a message).
function isNoiseText(text) {
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  return NOISE_PATTERNS.some((re) => re.test(trimmed));
}

const NEWLINE_BYTE = 0x0a;

/**
 * Incremental tail reader for a JSONL transcript. `extend(windowBytes)` makes the last `windowBytes` of the
 * file available as parsed records; a later call with a larger window reads and parses only the part that
 * was not covered yet. Lines longer than `maxRecordBytes` are counted and skipped without being decoded.
 * Returns null when the path is not a non-empty file.
 */
function openTailReader(filePath, { maxRecordBytes = MAX_TRANSCRIPT_RECORD_BYTES } = {}) {
  if (!filePath || typeof filePath !== 'string') return null;
  let size;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    size = stat.size;
  } catch {
    return null;
  }

  const recordLimit = Number(maxRecordBytes) > 0 ? Number(maxRecordBytes) : Infinity;
  const state = {
    windowStart: size, // file offset of the first byte examined so far
    parsedStart: size, // file offset where the parsed region (whole lines only) begins
    rows: [], // [{ entry, lineIndex }] in file order; lineIndex counts the lines of the parsed region
    pending: null, // bytes of [windowStart, parsedStart): the end of a record that begins before the window
    skippedOversized: 0,
    failed: false,
  };

  const parseLines = (buf, from) => {
    const found = [];
    let lines = 0;
    let pos = from;
    while (pos < buf.length) {
      const nl = buf.indexOf(NEWLINE_BYTE, pos);
      const end = nl === -1 ? buf.length : nl;
      const length = end - pos;
      if (length > recordLimit) {
        state.skippedOversized += 1;
      } else if (length > 0) {
        const line = buf.toString('utf8', pos, end).trim();
        if (line) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object') found.push({ entry: parsed, lineIndex: lines });
          } catch {
            // Ignore partial or corrupt JSONL lines safely
          }
        }
      }
      lines += 1;
      pos = end + 1;
    }
    return { found, lines };
  };

  return {
    get rows() { return state.rows; },
    get skippedOversized() { return state.skippedOversized; },
    get failed() { return state.failed; },
    get coversWholeFile() { return state.parsedStart === 0; },

    extend(windowBytes) {
      const wanted = Number(windowBytes) > 0 ? Number(windowBytes) : size;
      const newStart = Math.max(0, size - wanted);
      if (newStart >= state.windowStart || state.failed) return;

      // Only the bytes in front of what was read before come from disk.
      const length = state.windowStart - newStart;
      const head = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      try {
        const fd = fs.openSync(filePath, 'r');
        try {
          while (bytesRead < length) {
            const n = fs.readSync(fd, head, bytesRead, length - bytesRead, newStart + bytesRead);
            if (n <= 0) break;
            bytesRead += n;
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        state.failed = true;
        return;
      }
      if (bytesRead !== length) {
        state.failed = true;
        return;
      }
      // The bytes between the previous window start and the first parsed line are the end of a record that
      // begins further back. They were kept, so that record is complete once the window reaches its start.
      const chunk = state.pending ? Buffer.concat([head, state.pending]) : head;
      state.windowStart = newStart;

      let from = 0;
      if (newStart > 0) {
        // The window starts at an arbitrary byte: everything up to the first line break belongs to a record
        // that is cut off. (The kept bytes can only end with a line break, so the new ones are searched.)
        const firstNewline = head.indexOf(NEWLINE_BYTE);
        if (firstNewline === -1) {
          state.pending = chunk; // no line starts in the new bytes
          return;
        }
        from = firstNewline + 1;
      } else if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
        from = 3; // UTF-8 byte-order mark
      }
      state.pending = newStart > 0 ? Buffer.from(chunk.subarray(0, from)) : null;

      const { found, lines } = parseLines(chunk, from);
      if (lines > 0) {
        for (const row of state.rows) row.lineIndex += lines;
      }
      state.rows = found.concat(state.rows);
      state.parsedStart = newStart > 0 ? newStart + from : 0;
    },
  };
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

/**
 * Group messages of the common shape into conversation turns ({ user, assistant }).
 * Only a message typed by the person opens a turn; assistant messages join the turn before them (an
 * assistant message with no human message before it in the range forms a turn without a user part).
 */
function groupMessagesIntoTurns(messages) {
  const turns = [];
  let current = null;

  for (const msg of messages) {
    if (!msg || typeof msg.text !== 'string' || isNoiseText(msg.text)) continue;
    const text = msg.text.trim();
    if (msg.role === 'user') {
      if (msg.human !== true) continue; // notifications, other agents' reports, harness text
      if (current && (current.user || current.assistant)) turns.push(current);
      current = { user: text, assistant: '' };
    } else if (msg.role === 'assistant') {
      if (!current) {
        current = { user: '', assistant: text };
      } else {
        current.assistant = current.assistant ? `${current.assistant}\n\n${text}` : text;
      }
    }
  }

  if (current && (current.user || current.assistant)) {
    turns.push(current);
  }
  return turns;
}

/**
 * Turns of the conversation segment the rows end with. `adapter.boundaryKind(entry)` marks records that
 * start a new segment ('compact' | 'clear'); when the last segment is empty the one before it is used.
 * `segmentComplete` is true when that segment starts at a boundary inside `rows`, i.e. reading further back
 * in the file cannot add turns to it.
 */
function selectSegmentTurns(rows, adapter) {
  const boundaries = [];
  if (typeof adapter.boundaryKind === 'function') {
    for (let i = 0; i < rows.length; i++) {
      const kind = adapter.boundaryKind(rows[i].entry);
      if (kind) boundaries.push({ index: i, kind });
    }
  }

  const extractRange = (startIdx, endIdx) => {
    const msgs = [];
    for (let i = startIdx; i < endIdx; i++) {
      const m = adapter.toMessage(rows[i].entry);
      if (m) msgs.push(m);
    }
    return groupMessagesIntoTurns(msgs);
  };

  if (boundaries.length === 0) {
    return { turns: extractRange(0, rows.length), boundaryType: null, segmentComplete: false };
  }

  const lastBoundary = boundaries[boundaries.length - 1];
  let turns = extractRange(lastBoundary.index + 1, rows.length);
  let segmentComplete = true;

  // Immediately after one or more consecutive empty /compact or /clear boundaries,
  // walk backwards across empty boundary segments to restore the last non-empty segment.
  if (turns.length === 0) {
    segmentComplete = false;
    for (let k = boundaries.length - 1; k >= 0; k--) {
      const prevStart = k > 0 ? boundaries[k - 1].index + 1 : 0;
      const candidate = extractRange(prevStart, boundaries[k].index);
      if (candidate.length > 0) {
        turns = candidate;
        segmentComplete = k > 0;
        break;
      }
    }
  }

  return { turns, boundaryType: lastBoundary.kind, segmentComplete };
}

/**
 * Read the tail of a transcript through a host adapter and return the turns of its last segment.
 * The tail window starts at `maxTailBytes` and doubles up to `maxTailBytesCap` until `maxTurns` turns that
 * begin with a human message are in reach (or the segment or the whole file is covered).
 * Returns { rows, turns, boundaryType, restoreFailure }; `restoreFailure` is null or one of the
 * RESTORE_FAILURE_* values, and is only set when no turn at all was found.
 */
function readTranscriptTurns(
  transcriptPath,
  adapter,
  {
    maxTurns = DEFAULT_MAX_TURNS,
    maxTailBytes = DEFAULT_MAX_TAIL_BYTES,
    maxTailBytesCap = MAX_TAIL_BYTES_CAP,
    maxRecordBytes = MAX_TRANSCRIPT_RECORD_BYTES,
  } = {},
) {
  const reader = openTailReader(transcriptPath, { maxRecordBytes });
  if (!reader) return { rows: [], turns: [], boundaryType: null, restoreFailure: null };

  const wantedTurns = Math.max(1, Number(maxTurns) || DEFAULT_MAX_TURNS);
  const firstWindow = Number(maxTailBytes) > 0 ? Number(maxTailBytes) : Infinity;
  const cap = Math.max(firstWindow, Number(maxTailBytesCap) > 0 ? Number(maxTailBytesCap) : 0);

  let windowBytes = firstWindow;
  let selection;
  for (;;) {
    reader.extend(windowBytes);
    selection = selectSegmentTurns(reader.rows, adapter);
    const humanTurns = selection.turns.reduce((n, t) => n + (t.user ? 1 : 0), 0);
    if (
      reader.failed
      || reader.coversWholeFile
      || selection.segmentComplete
      || humanTurns >= wantedTurns
      || windowBytes >= cap
    ) {
      break;
    }
    windowBytes = Math.min(cap, windowBytes * 2);
  }

  let restoreFailure = null;
  if (selection.turns.length === 0 && !reader.failed) {
    if (reader.skippedOversized > 0 || (!reader.coversWholeFile && reader.rows.length === 0)) {
      restoreFailure = RESTORE_FAILURE_RECORD_TOO_LARGE;
    } else if (!reader.coversWholeFile) {
      restoreFailure = RESTORE_FAILURE_NO_TURNS_WITHIN_CAP;
    }
  }

  return {
    rows: reader.rows,
    turns: selection.turns,
    boundaryType: selection.boundaryType,
    restoreFailure,
  };
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
      // Even the single newest turn alone exceeds maxChars -> preserve both turn header/user head
      // AND assistant conclusion (tail) within avail budget.
      const avail = maxChars - heading.length - 2;
      if (avail >= 40) {
        const marker = '\n[...middle trimmed...]\n';
        if (avail > marker.length + 30) {
          const remaining = avail - marker.length;
          const headLimit = Math.max(15, Math.floor(remaining * 0.4));
          const tailLimit = Math.max(15, remaining - headLimit);
          const headRaw = block.slice(0, headLimit);
          const headClean = headRaw.replace(/\s+\S*$/, '').trimEnd() || headRaw.trimEnd();
          const tailRaw = block.slice(block.length - tailLimit);
          const tailClean = tailRaw.replace(/^\S*\s+/, '').trimStart() || tailRaw.trimStart();
          const combined = `${headClean}${marker}${tailClean}`;
          keptReversed.push({
            turn,
            block: combined.length <= avail ? combined : combined.slice(0, avail).trimEnd(),
          });
        } else {
          const suffix = '\n[...trimmed]';
          const sliceLimit = Math.max(20, avail - suffix.length);
          const clipped = block.slice(0, sliceLimit).replace(/\s+\S*$/, '').trimEnd() || block.slice(0, sliceLimit);
          keptReversed.push({ turn, block: `${clipped}${suffix}` });
        }
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
 * Last `maxTurns` turns of a transcript read through `adapter`, formatted within `maxChars`.
 * Returns { turns, text, charCount, droppedCount, boundaryType, candidateTurns, restoreFailure, rows }:
 * `candidateTurns` are the selected turns before the character budget was applied (pass them to
 * `formatRecentTurns` to fit another budget without reading the file again), `restoreFailure` is null or a
 * RESTORE_FAILURE_* value, `rows` are the parsed records of the final window ({ entry, lineIndex }).
 * Options: maxTurns, maxChars, maxTailBytes (first window), maxTailBytesCap, maxRecordBytes.
 */
export function extractRecentTurns(transcriptPath, adapter, options = {}) {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxChars = options.maxChars ?? DEFAULT_RECENT_TURNS_BUDGET;
  const read = readTranscriptTurns(transcriptPath, adapter, { ...options, maxTurns });
  const candidateTurns = read.turns.slice(-Math.max(1, maxTurns));
  const formatted = formatRecentTurns(candidateTurns, { maxChars });
  return {
    ...formatted,
    boundaryType: read.boundaryType,
    candidateTurns,
    restoreFailure: read.restoreFailure,
    rows: read.rows,
  };
}

// ---------------------------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------------------------

const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

/**
 * Remove every `<system-reminder>…</system-reminder>` block from a text (one forward scan, no regex).
 * An opening tag without a closing tag is left as it is.
 */
export function stripSystemReminders(text) {
  if (typeof text !== 'string' || !text.includes(SYSTEM_REMINDER_OPEN)) return typeof text === 'string' ? text : '';
  let out = '';
  let pos = 0;
  for (;;) {
    const start = text.indexOf(SYSTEM_REMINDER_OPEN, pos);
    if (start === -1) break;
    const end = text.indexOf(SYSTEM_REMINDER_CLOSE, start + SYSTEM_REMINDER_OPEN.length);
    if (end === -1) break;
    out += text.slice(pos, start);
    pos = end + SYSTEM_REMINDER_CLOSE.length;
  }
  return out + text.slice(pos);
}

// Text the harness puts on the user side. Only consulted for records that carry no `origin` and no `isMeta`
// marker (older transcripts); the three shared noise patterns apply in addition.
const CLAUDE_HARNESS_TEXT_RE = /^\s*<(?:task-notification|system-reminder|bash-stdout|bash-stderr|user-prompt-submit-hook)[\s>]/i;

// The person's answer to a question the agent asked arrives as a tool result.
const USER_ANSWER_RE = /^\s*(?:The\s+)?user\s+(?:has\s+)?answered/i;

/**
 * Who a user-side Claude Code record is from, as far as its markers say:
 * true = typed by the person, false = not, null = no marker (decide from the text).
 * `marker` is the object that carries `origin` / `isMeta` (the record, or a queued-command attachment).
 */
function claudeHumanMarker(marker) {
  if (!marker || typeof marker !== 'object') return null;
  if (marker.isMeta === true || marker.isCompactSummary === true) return false;
  const kind = marker.origin && typeof marker.origin === 'object' ? marker.origin.kind : undefined;
  if (kind !== undefined && kind !== null) return kind === 'human';
  return null;
}

function claudeUserMessage(content, marker) {
  const marked = claudeHumanMarker(marker);
  const textParts = [];
  const answerParts = [];
  let hasToolResult = false;

  const addText = (raw) => {
    const cleaned = stripSystemReminders(raw).trim();
    if (cleaned && !isNoiseText(cleaned)) textParts.push(cleaned);
  };

  if (typeof content === 'string') {
    addText(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block) continue;
      if (typeof block === 'string') {
        addText(block);
        continue;
      }
      if (typeof block !== 'object') continue;
      const bType = String(block.type || '').toLowerCase();
      if (bType === 'text' && typeof block.text === 'string') {
        addText(block.text);
      } else if (bType === 'tool_result') {
        hasToolResult = true;
        const resText = extractTextFromBlockContent(block.content);
        if (resText && USER_ANSWER_RE.test(resText)) answerParts.push(resText);
      }
      // Explicitly skip tool_use, thinking, images, etc.
    }
  }

  if (textParts.length === 0) {
    // A record made of tool results only is not a human message, except the person's own answer to a
    // question the agent asked.
    if (!hasToolResult || answerParts.length === 0) return null;
    return { role: 'user', text: answerParts.join('\n'), human: marked !== false };
  }

  const text = [...textParts, ...answerParts].join('\n').trim();
  const human = marked === null ? !CLAUDE_HARNESS_TEXT_RE.test(text) : marked;
  return { role: 'user', text, human };
}

function claudeAssistantMessage(content) {
  const parts = [];
  if (typeof content === 'string') {
    if (!isNoiseText(content)) parts.push(content.trim());
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') {
        if (!isNoiseText(block)) parts.push(block.trim());
      } else if (block && typeof block === 'object' && String(block.type || '').toLowerCase() === 'text'
        && typeof block.text === 'string') {
        if (!isNoiseText(block.text)) parts.push(block.text.trim());
      }
      // Explicitly skip tool_use, thinking, redacted_thinking, server_tool_use, etc.
    }
  }
  const text = parts.join('\n').trim();
  return text ? { role: 'assistant', text, human: false } : null;
}

/**
 * Claude Code record -> common message. Rules for the user side:
 * - `origin.kind === "human"` is the person; any other `origin.kind` (task notifications, reports from
 *   other agents), `isMeta: true` and `isCompactSummary: true` are not.
 * - A record made only of tool results is not, except the person's answer to a question the agent asked.
 * - A record with neither marker (older transcripts) is judged by its text (harness wrappers are not human).
 * - A prompt typed while the agent was busy is stored as a `queued_command` attachment and classified by the
 *   attachment's own markers. `queue-operation` records are skipped: the same text is recorded again as a
 *   user record or an attachment when it is delivered.
 * - `<system-reminder>` blocks embedded in a human message are removed from its text.
 */
function claudeEntryToMessage(entry) {
  if (!entry || typeof entry !== 'object') return null;

  if (entry.type === 'queue-operation') return null;

  if (entry.type === 'attachment') {
    const attachment = entry.attachment;
    if (!attachment || typeof attachment !== 'object' || attachment.type !== 'queued_command') return null;
    return claudeUserMessage(attachment.prompt, attachment);
  }

  if (entry.type === 'queued_command' || entry.subtype === 'queued_command') {
    return claudeUserMessage(entry.message?.content ?? entry.content ?? entry.text ?? '', entry);
  }

  const roleRaw = entry.message?.role || entry.role || (entry.type === 'user' || entry.type === 'assistant' ? entry.type : '');
  const role = String(roleRaw).toLowerCase();
  const content = entry.message?.content ?? entry.content;
  if (role === 'assistant') {
    if (entry.isMeta === true || entry.isCompactSummary === true) return null;
    return claudeAssistantMessage(content);
  }
  if (role === 'user') return claudeUserMessage(content, entry);
  return null;
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

export const CLAUDE_TRANSCRIPT_ADAPTER = Object.freeze({
  name: 'claude',
  toMessage: claudeEntryToMessage,
  boundaryKind(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (isClaudeCompactBoundary(entry)) return 'compact';
    if (isClaudeClearBoundary(entry)) return 'clear';
    return null;
  },
});

/**
 * Extract the last N turns (what the person typed, each with the assistant's replies) from a Claude Code
 * JSONL transcript. See `extractRecentTurns` for the result and the options.
 */
export function extractClaudeRecentTurns(transcriptPath, options = {}) {
  const { rows: _rows, ...result } = extractRecentTurns(transcriptPath, CLAUDE_TRANSCRIPT_ADAPTER, options);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Antigravity adapter
// ---------------------------------------------------------------------------------------------

export function resolveAntigravityTranscriptPath(transcriptPath) {
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

/**
 * Antigravity step -> common message. USER_INPUT / USER_EXPLICIT steps are what the person typed
 * (`human: true`); PLANNER_RESPONSE steps are the assistant's replies. Other steps carry no turn text.
 */
function antigravityEntryToMessage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (extractAntigravityCheckpoint(entry, 0)) return null;
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
    return { role: 'user', text: cleaned, human: true };
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
    return { role: 'assistant', text: cleaned, human: false };
  }

  return null;
}

export const ANTIGRAVITY_TRANSCRIPT_ADAPTER = Object.freeze({
  name: 'antigravity',
  toMessage: antigravityEntryToMessage,
  boundaryKind() {
    return null;
  },
});

/**
 * Extract latest CHECKPOINT (DONE) key (${step_index}:${created_at}) and last N pure
 * USER_INPUT/USER_EXPLICIT + PLANNER_RESPONSE turns from an Antigravity JSONL transcript.
 * The checkpoint is looked up in the window that was read for the turns; pass
 * `maxTailBytesCap: maxTailBytes` to probe the checkpoint without growing the window.
 */
export function extractAntigravityState(transcriptPath, options = {}) {
  const actualPath = resolveAntigravityTranscriptPath(transcriptPath);
  const { rows, ...result } = extractRecentTurns(actualPath, ANTIGRAVITY_TRANSCRIPT_ADAPTER, options);

  let latestCheckpoint = null;
  for (const { entry, lineIndex } of rows) {
    const cp = extractAntigravityCheckpoint(entry, lineIndex);
    if (cp) latestCheckpoint = cp;
  }

  return {
    transcriptPath: actualPath || null,
    latestCheckpoint,
    ...result,
  };
}
