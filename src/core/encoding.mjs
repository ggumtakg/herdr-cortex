/**
 * Text decoding for Markdown documents that may have been written by hand in a non-UTF-8 editor.
 *
 * Detection order:
 *   1. Byte-order mark: UTF-8, UTF-16LE, UTF-16BE
 *   2. Strictly valid UTF-8
 *   3. Strictly valid CP949 (Korean Windows ANSI code page)
 * Anything else is reported as unsafe: callers may index the lossy text, but must not rewrite the file.
 */

function strictDecode(label, bytes) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function inRange(value, lo, hi) {
  return value >= lo && value <= hi;
}

/**
 * Position of a trail byte inside a CP949 extension row, or -1.
 * Rows led by 0x81-0xA0 use trails 0x41-0x5A, 0x61-0x7A, 0x81-0xFE (178 cells);
 * rows led by 0xA1-0xC6 use trails 0x41-0x5A, 0x61-0x7A, 0x81-0xA0 (84 cells).
 */
function cp949ExtensionCell(lead, trail) {
  if (inRange(trail, 0x41, 0x5a)) return trail - 0x41;
  if (inRange(trail, 0x61, 0x7a)) return 26 + (trail - 0x61);
  const lastTrail = lead <= 0xa0 ? 0xfe : 0xa0;
  if (inRange(trail, 0x81, lastTrail)) return 52 + (trail - 0x81);
  return -1;
}

let cp949ExtensionTable = null;

/**
 * Node's `euc-kr` decoder only covers the 2,350 KS X 1001 syllables and turns the CP949 extension
 * bytes into C1 control characters without raising an error. The extension is regular, though:
 * the 8,822 remaining Hangul syllables fill the extension cells in Unicode order.
 * Returns the list of those syllables in cell order, or null when `euc-kr` is unavailable.
 */
function getCp949ExtensionTable() {
  if (cp949ExtensionTable) return cp949ExtensionTable;

  const standardBytes = new Uint8Array(25 * 94 * 2);
  let n = 0;
  for (let lead = 0xb0; lead <= 0xc8; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      standardBytes[n++] = lead;
      standardBytes[n++] = trail;
    }
  }
  const standardText = strictDecode('euc-kr', standardBytes);
  if (standardText === null || standardText.length !== 2350) return null;
  const standard = new Set(standardText);

  const table = [];
  for (let cp = 0xac00; cp <= 0xd7a3; cp++) {
    const ch = String.fromCharCode(cp);
    if (!standard.has(ch)) table.push(ch);
  }
  if (table.length !== 8822) return null;
  cp949ExtensionTable = table;
  return table;
}

function cp949ExtensionChar(lead, trail, table) {
  const cell = cp949ExtensionCell(lead, trail);
  if (cell < 0) return null;
  let index;
  if (lead <= 0xa0) {
    index = (lead - 0x81) * 178 + cell;
  } else {
    index = 32 * 178 + (lead - 0xa1) * 84 + cell;
  }
  return index < table.length ? table[index] : null;
}

/**
 * Strict CP949 decoder. Returns the decoded string, or null when any byte sequence is not valid CP949.
 */
export function decodeCp949Strict(bytes) {
  const table = getCp949ExtensionTable();
  if (!table) return null;

  const parts = [];
  let pendingStart = 0; // start of the current run of bytes the built-in euc-kr decoder understands

  const flush = (end) => {
    if (end <= pendingStart) return true;
    const text = strictDecode('euc-kr', bytes.subarray(pendingStart, end));
    // A replacement or C1 control character means the built-in decoder passed through bytes it did not map.
    if (text === null || /[\u0080-\u009f\uFFFD]/.test(text)) return false;
    parts.push(text);
    return true;
  };

  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i];
    if (lead < 0x80) {
      i++;
      continue;
    }
    if (i + 1 >= bytes.length || !inRange(lead, 0x81, 0xfe)) return null;
    const trail = bytes[i + 1];

    let ext = null;
    if (lead >= 0xa1 && inRange(trail, 0xa1, 0xfe)) {
      // CP949 adds the euro and registered signs to the KS X 1001 area; the built-in decoder lacks them.
      if (lead === 0xa2 && trail === 0xe6) ext = '\u20AC';
      else if (lead === 0xa2 && trail === 0xe7) ext = '\u00AE';
      else {
        i += 2; // KS X 1001 pair, handled by the built-in decoder
        continue;
      }
    } else if (lead <= 0xc6) {
      ext = cp949ExtensionChar(lead, trail, table);
    }
    if (ext === null) return null;
    if (!flush(i)) return null;
    parts.push(ext);
    i += 2;
    pendingStart = i;
  }

  if (!flush(bytes.length)) return null;
  return parts.join('');
}

function unsafeResult(bytes, reason) {
  return {
    text: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8').replace(/^\uFEFF/, ''),
    encoding: 'unknown',
    safe: false,
    reason,
  };
}

/**
 * Decode raw document bytes.
 * Returns { text, encoding, safe, reason }:
 * - safe=true: `text` is an exact decoding (BOM removed) in `encoding` ('utf-8' | 'utf-16le' | 'utf-16be' | 'cp949').
 * - safe=false: the encoding could not be determined; `text` is a lossy UTF-8 reading that is good enough
 *   to index but must never be written back, and `reason` explains why.
 */
export function decodeDocBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
  let text = null;
  let encoding = '';

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = strictDecode('utf-8', bytes);
    encoding = 'utf-8';
    if (text === null) return unsafeResult(bytes, 'it starts with a UTF-8 byte-order mark but contains invalid UTF-8');
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = strictDecode('utf-16le', bytes);
    encoding = 'utf-16le';
    if (text === null) return unsafeResult(bytes, 'it starts with a UTF-16LE byte-order mark but contains invalid UTF-16');
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = strictDecode('utf-16be', bytes);
    encoding = 'utf-16be';
    if (text === null) return unsafeResult(bytes, 'it starts with a UTF-16BE byte-order mark but contains invalid UTF-16');
  } else {
    text = strictDecode('utf-8', bytes);
    encoding = 'utf-8';
    if (text === null) {
      text = decodeCp949Strict(bytes);
      encoding = 'cp949';
    }
    if (text === null) {
      return unsafeResult(bytes, 'its bytes are neither valid UTF-8 nor valid CP949, so the text encoding cannot be determined');
    }
  }

  text = text.replace(/^\uFEFF/, '');
  if (text.includes('\u0000')) {
    return unsafeResult(bytes, 'it contains NUL characters (binary data, or UTF-16 text without a byte-order mark)');
  }
  return { text, encoding, safe: true, reason: '' };
}
