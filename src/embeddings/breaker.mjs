export const DEFAULT_CIRCUIT_BREAK_MS = 300000;

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
]);

/**
 * Mark an error with the kind of embedding failure it represents ('service' | 'document' | 'auth'),
 * for failures whose kind cannot be read from an HTTP status or a network error code.
 */
export function markEmbeddingFailure(err, kind) {
  if (err && typeof err === 'object') err.embeddingFailure = kind;
  return err;
}

export function isEmbeddingTimeoutError(err) {
  const name = String(err?.name || '');
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Sort an embedding failure into one of three kinds:
 *   'auth'     - HTTP 401/403: the credentials are wrong; nothing will work until they are fixed.
 *   'service'  - the service could not be reached or could not answer: timeout, network error, HTTP 408/429/5xx,
 *                or an answer in an unusable shape. Says nothing about the document that was being embedded.
 *   'document' - the request for this particular input was rejected (other HTTP 4xx) or failed in a way
 *                that is not recognizably a service problem.
 */
export function classifyEmbeddingError(err) {
  if (!err) return 'document';
  if (err.embeddingFailure === 'service' || err.embeddingFailure === 'document' || err.embeddingFailure === 'auth') {
    return err.embeddingFailure;
  }

  const status = Number(err.status);
  if (status === 401 || status === 403) return 'auth';
  const msg = String(err.message || '');
  if (!Number.isFinite(status) || status === 0) {
    if (/\b(?:401|403)\b/.test(msg) && /(?:embedding failed|unauthorized|forbidden|api key)/i.test(msg)) return 'auth';
  }
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return 'service';
  if (status >= 400 && status <= 499) return 'document';

  if (isEmbeddingTimeoutError(err)) return 'service';
  const code = String(err.code || err.cause?.code || '');
  if (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_')) return 'service';
  if (err instanceof TypeError && /fetch failed|failed to fetch|network/i.test(msg)) return 'service';

  return 'document';
}

function normalizeCooldown(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_CIRCUIT_BREAK_MS;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_CIRCUIT_BREAK_MS;
}

/**
 * Circuit breaker for the embedding service, meant to be shared by everything in one process that embeds
 * (search queries and the document queue).
 * `recordFailure` opens it for `cooldownMs`; while it is open callers skip embedding instead of waiting on a
 * service that just failed. When the window has passed the next caller may try again: a failure opens it again,
 * a success closes it and notifies `onRecover` listeners so postponed work can be picked up.
 * A cooldown of 0 disables the pause (failures are still recorded).
 */
export function createEmbeddingBreaker({ cooldownMs = DEFAULT_CIRCUIT_BREAK_MS, now = Date.now } = {}) {
  let windowMs = normalizeCooldown(cooldownMs);
  let openUntil = 0;
  let openedAt = 0;
  let tripped = false;
  let lastError = '';
  const listeners = new Set();

  return {
    get cooldownMs() {
      return windowMs;
    },
    setCooldownMs(value) {
      windowMs = normalizeCooldown(value);
    },
    isOpen() {
      return now() < openUntil;
    },
    remainingMs() {
      return Math.max(0, openUntil - now());
    },
    /** True from a failure until the next success, even after the pause has run out. */
    isTripped() {
      return tripped;
    },
    recordFailure(err) {
      tripped = true;
      openedAt = now();
      openUntil = openedAt + windowMs;
      lastError = String(err?.message || err || 'embedding service failure').slice(0, 200);
    },
    /** Returns true when this success closed a tripped breaker. */
    recordSuccess() {
      openUntil = 0;
      if (!tripped) return false;
      tripped = false;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // a listener must never break the embedding call that just succeeded
        }
      }
      return true;
    },
    onRecover(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      openUntil = 0;
      openedAt = 0;
      tripped = false;
      lastError = '';
    },
    describe() {
      const open = now() < openUntil;
      return {
        open,
        remainingMs: open ? openUntil - now() : 0,
        cooldownMs: windowMs,
        openedAt: tripped && openedAt ? new Date(openedAt).toISOString() : '',
        lastError: tripped ? lastError : '',
      };
    },
  };
}

let sharedBreaker = null;

/**
 * The one breaker of this process. Long-lived entry points (the MCP server) pass it to both the search tools
 * and the document queue; `describeEmbeddingStatus` reports its state by default.
 */
export function getSharedEmbeddingBreaker({ cooldownMs } = {}) {
  if (!sharedBreaker) {
    sharedBreaker = createEmbeddingBreaker({ cooldownMs });
  } else if (cooldownMs !== undefined) {
    sharedBreaker.setCooldownMs(cooldownMs);
  }
  return sharedBreaker;
}
