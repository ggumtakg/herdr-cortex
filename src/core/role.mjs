export const ROLE_ENV_VAR = 'HERDR_CORTEX_ROLE';
export const WORKER_ROLE = 'worker';

/**
 * True when `HERDR_CORTEX_ROLE` marks this process as a delegated worker session (`worker`,
 * trimmed and case-insensitive). Missing, non-string, or other values behave as normal sessions.
 * `env` is injectable for tests.
 */
export function isWorkerSession({ env = process.env } = {}) {
  const raw = env && typeof env === 'object' ? env[ROLE_ENV_VAR] : undefined;
  return typeof raw === 'string' && raw.trim().toLowerCase() === WORKER_ROLE;
}
