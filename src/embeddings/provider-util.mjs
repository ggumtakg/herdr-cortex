/**
 * Find the API key for a provider: a literal `apiKey`, else the env var named by `apiKeyEnv`,
 * else the provider's conventional env vars. Also returns where the key came from, so status output
 * can name the source without ever showing the value.
 */
export function resolveApiKey(options = {}, env = process.env, fallbackEnvNames = []) {
  if (options.apiKey) {
    return { apiKey: String(options.apiKey), source: 'config', envName: '' };
  }
  for (const name of [options.apiKeyEnv, ...fallbackEnvNames]) {
    if (typeof name === 'string' && name && env?.[name]) {
      return { apiKey: String(env[name]), source: 'env', envName: name };
    }
  }
  return { apiKey: '', source: '', envName: '' };
}

/**
 * Limits for one `embed()` call. A caller may shorten the timeout and turn retries off for that call
 * (search queries do); otherwise the provider's defaults apply.
 */
export function resolveCallLimits(callOptions = {}, defaults = {}) {
  const timeoutMs = Number(callOptions.timeoutMs) > 0 ? Number(callOptions.timeoutMs) : defaults.timeoutMs;
  const rawRetries = callOptions.maxRetries;
  const maxRetries = Number.isInteger(rawRetries) && rawRetries >= 0 ? rawRetries : defaults.maxRetries;
  return { timeoutMs, maxRetries };
}
