import path from 'node:path';
import { CortexStore } from '../core/store.mjs';
import {
  EMBEDDING_PROVIDER_NAMES,
  isMainModule,
  isProjectEnabled,
  isProjectTrusted,
  loadConfig,
} from '../core/config.mjs';
import { formatProjectNotApprovedMessage } from '../core/trust.mjs';
import {
  createEmbeddingBreaker,
  describeEmbeddingStatus,
  formatEmbeddingStatus,
  listFailedEmbeddings,
  processPendingEmbeddings,
  resolveTierEmbeddingProviders,
  retryFailedEmbeddings,
} from './index.mjs';

/** The tiers `--scope` accepts (what `processPendingEmbeddings` understands). */
export const EMBED_CLI_SCOPES = Object.freeze(['project', 'global', 'all']);

// The options that take a value, each with what the value is (named when the value is missing).
const VALUE_OPTIONS = Object.freeze({
  '--project': 'a folder',
  '--global': 'a folder',
  '--scope': EMBED_CLI_SCOPES.join(', '),
  '--provider': `none, auto, ${EMBEDDING_PROVIDER_NAMES.join(', ')}`,
  '--model': 'a model name',
  '--max-docs': 'a positive whole number',
});

/**
 * The options of the command line. `problems` lists every value that cannot be used: an option without its
 * value (nothing, or an empty string, follows it), a `--scope` outside EMBED_CLI_SCOPES, a `--max-docs` that
 * is not a positive whole number. A provider name is checked later, together with the one in the config.
 */
function parseArgs(argv) {
  const args = {
    projectDir: process.cwd(),
    globalDir: undefined,
    scope: 'all',
    provider: '',
    model: '',
    maxDocs: 200,
    retryFailed: false,
    problems: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--retry-failed') {
      args.retryFailed = true;
      continue;
    }
    if (!Object.hasOwn(VALUE_OPTIONS, a)) continue;
    const value = argv[i + 1];
    if (value === undefined || value === '') {
      args.problems.push(`${a} needs a value (${VALUE_OPTIONS[a]}).`);
      continue;
    }
    i++;
    if (a === '--project') args.projectDir = path.resolve(value);
    else if (a === '--global') args.globalDir = path.resolve(value);
    else if (a === '--provider') args.provider = value;
    else if (a === '--model') args.model = value;
    else if (a === '--scope') {
      if (EMBED_CLI_SCOPES.includes(value)) args.scope = value;
      else args.problems.push(`--scope must be one of ${EMBED_CLI_SCOPES.join(', ')} (got "${value}").`);
    } else if (a === '--max-docs') {
      if (/^\d+$/.test(value) && Number(value) >= 1 && Number.isSafeInteger(Number(value))) args.maxDocs = Number(value);
      else args.problems.push(`--max-docs must be a positive whole number (got "${value}").`);
    }
  }
  return args;
}

/**
 * Embed pending documents once and print a JSON summary on stdout.
 *
 * Flags: --project <dir>, --global <dir>, --scope project|global|all, --max-docs <n>,
 *   --provider <none|auto|gemini|openai|ollama|onnx>  use this provider for the run (embedding.provider)
 *   --model <name>      model for the provider in use (embedding.<provider>.model)
 *   --retry-failed      first reset the documents the queue gave up on (either reason), so they are tried again
 *
 * The project tier is embedded with this project's settings (global config plus its `projects["<path>"]`
 * entry), the global tier with the global settings alone; --provider / --model are given by the user for
 * this run and apply to both. When the two tiers end up with different providers the status lines and the
 * summary (`tiers`) show both.
 *
 * Before any work it prints on stderr which provider is in effect, where documents would be sent and any
 * configuration problem. A project that is excluded by the configuration, or that the user has not approved,
 * is skipped (`reason: "project_disabled"` / `"project_not_approved"`, or `skippedProject` with --scope all);
 * nothing in its .memory/ is read. An unknown provider name, a provider without its API key, or --model without a
 * provider to apply it to ends the run with exit code 1; so does any embedding error.
 *
 * An option value that cannot be used (see `parseArgs`: an unknown --scope, a --max-docs that is not a positive
 * whole number, an option without its value) ends the run before anything is read or changed: one line on
 * stderr, the summary with `reason: "invalid_arguments"` and `error` naming the allowed values, exit code 1.
 */
export async function runEmbedCli(
  argv = process.argv.slice(2),
  {
    provider: injectedProvider = null,
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const opts = parseArgs(argv);
  if (opts.problems.length > 0) {
    // A command line that cannot be understood: no config is loaded, no store is opened, nothing is reset.
    const summary = {
      provider: null,
      dimensions: 0,
      processed: 0,
      chunksIndexed: 0,
      rebuiltTiers: [],
      errors: 0,
      circuitBroken: false,
      reason: 'invalid_arguments',
      error: opts.problems.join(' '),
    };
    stderr.write(`[herdr-cortex] ${summary.error}\n`);
    process.exitCode = 1;
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }
  const breaker = createEmbeddingBreaker();
  const baseOverrides = opts.provider ? { embedding: { provider: opts.provider } } : undefined;

  let config = loadConfig({ projectDir: opts.projectDir, globalDir: opts.globalDir, overrides: baseOverrides });
  // The global tier's settings: the global config without this project's overlay.
  let globalConfig = loadConfig({ globalDir: opts.globalDir, overrides: baseOverrides });
  let usageError = '';

  if (opts.model) {
    // --model belongs to one provider's block: the one named by --provider, else the one the config selects.
    const named = opts.provider.trim().toLowerCase();
    const target = EMBEDDING_PROVIDER_NAMES.includes(named)
      ? named
      : describeEmbeddingStatus(config, { env, breaker }).provider;
    if (target) {
      const overrides = {
        embedding: {
          ...(opts.provider ? { provider: opts.provider } : {}),
          [target]: { model: opts.model },
        },
      };
      config = loadConfig({ projectDir: opts.projectDir, globalDir: opts.globalDir, overrides });
      globalConfig = loadConfig({ globalDir: opts.globalDir, overrides });
    } else if (!injectedProvider) {
      usageError = '--model was given but no embedding provider is in effect; '
        + `add --provider <${EMBEDDING_PROVIDER_NAMES.join('|')}> or set embedding.provider in config.json.`;
    }
  }

  const status = describeEmbeddingStatus(config, { env, breaker, globalConfig });
  for (const line of formatEmbeddingStatus(status)) {
    stderr.write(`[herdr-cortex] ${line}\n`);
  }
  if (usageError) stderr.write(`[herdr-cortex] ${usageError}\n`);

  // What each tier is embedded with (`status.globalTier` is present only when the two differ).
  const tierStatus = {
    project: status,
    global: status.globalTier ? describeEmbeddingStatus(globalConfig, { env, breaker }) : status,
  };
  const configProblems = [
    ...status.problems.map((problem) => problem.message),
    ...(status.globalTier?.problems || []).map((problem) => `global memory: ${problem.message}`),
  ];
  const isBlocking = (problem) => problem.code === 'unknown_provider' || problem.code === 'missing_api_key';

  const emit = (summary) => {
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  };

  const projectEnabled = isProjectEnabled(opts.projectDir, config);
  // An unapproved project is skipped the same way an excluded one is; exclusion is reported first.
  const projectNotApproved = projectEnabled && !isProjectTrusted(opts.projectDir, { globalDir: opts.globalDir });
  const projectAllowed = projectEnabled && !projectNotApproved;

  let effectiveScope = opts.scope;
  let skippedProject = false;
  if (!projectAllowed) {
    if (projectNotApproved && opts.scope !== 'global') {
      stderr.write(`[herdr-cortex] ${formatProjectNotApprovedMessage(opts.projectDir)}\n`);
    }
    if (opts.scope === 'project') {
      return emit({
        provider: null,
        processed: 0,
        chunksIndexed: 0,
        rebuiltTiers: [],
        errors: 0,
        skipped: true,
        reason: projectNotApproved ? 'project_not_approved' : 'project_disabled',
        ...(configProblems.length > 0 ? { configProblems } : {}),
      });
    }
    if (opts.scope === 'all') {
      effectiveScope = 'global';
      skippedProject = true;
    }
  }

  const scopesInRun = effectiveScope === 'all' ? ['project', 'global'] : [effectiveScope];
  // A provider that is named but cannot be used stops the run, for whichever tier of this run it concerns.
  const blocking = injectedProvider
    ? null
    : scopesInRun.flatMap((s) => tierStatus[s].problems).find(isBlocking) || null;

  const store = new CortexStore({ projectDir: opts.projectDir, globalDir: opts.globalDir, config, globalConfig });
  try {
    const retryReset = opts.retryFailed ? retryFailedEmbeddings(store, { scope: effectiveScope }) : null;

    let totalProcessed = 0;
    let totalChunks = 0;
    let totalErrors = 0;
    let dimensions = 0;
    let providerName = null;
    let modelName = '';
    let circuitBroken = false;
    let reason = undefined;
    let error = '';
    const rebuiltSet = new Set();
    const tierSummaries = {}; // per tier: provider, model, dimensions and counts, summed over the batches

    if (usageError) {
      reason = 'invalid_arguments';
      error = usageError;
    } else if (blocking) {
      reason = blocking.code === 'unknown_provider' ? 'invalid_provider' : 'no_provider';
      error = blocking.message;
    } else {
      const providers = injectedProvider
        ? { project: injectedProvider, global: injectedProvider }
        : await resolveTierEmbeddingProviders(store, { env, scopes: scopesInRun });
      const firstProvider = scopesInRun.map((s) => providers[s]).find(Boolean) || null;
      providerName = firstProvider?.name || null;
      modelName = firstProvider?.model || '';
      if (!firstProvider) reason = 'no_provider';

      const maxIterations = firstProvider ? 1000 : 0;
      for (let iter = 0; iter < maxIterations; iter++) {
        const batchRes = await processPendingEmbeddings(store, {
          scope: effectiveScope,
          providers,
          maxDocs: opts.maxDocs,
          breaker,
        });

        for (const [tierScope, tierRes] of Object.entries(batchRes.tiers || {})) {
          const seen = tierSummaries[tierScope] || { provider: null, model: '', dimensions: 0, processed: 0, chunksIndexed: 0, errors: 0 };
          tierSummaries[tierScope] = {
            provider: tierRes.provider || seen.provider,
            model: tierRes.model || seen.model,
            dimensions: tierRes.dimensions || seen.dimensions,
            processed: seen.processed + (tierRes.processed || 0),
            chunksIndexed: seen.chunksIndexed + (tierRes.chunksIndexed || 0),
            errors: seen.errors + (tierRes.errors || 0),
          };
        }

        if (batchRes.provider) providerName = batchRes.provider;
        if (batchRes.model) modelName = batchRes.model;
        if (batchRes.dimensions) dimensions = batchRes.dimensions;
        if (batchRes.reason) reason = batchRes.reason;
        for (const t of batchRes.rebuiltTiers || []) rebuiltSet.add(t);

        totalProcessed += batchRes.processed || 0;
        totalChunks += batchRes.chunksIndexed || 0;
        totalErrors += batchRes.errors || 0;

        if (batchRes.circuitBroken) {
          circuitBroken = true;
          break;
        }
        if (batchRes.reason === 'no_provider') {
          break;
        }
        // Stop when no more docs were processed in this batch
        if ((batchRes.processed || 0) === 0) {
          break;
        }
      }
    }

    // Host of the tier whose provider is named at the top of the summary.
    const primaryScope = scopesInRun.find((s) => tierSummaries[s]?.provider) || scopesInRun[0];
    const primaryHost = tierStatus[primaryScope]?.host || null;
    for (const [tierScope, tierSummary] of Object.entries(tierSummaries)) {
      const host = tierStatus[tierScope]?.host;
      if (tierSummary.provider && host && !injectedProvider) tierSummary.sendsTo = host;
    }
    const tiersDiffer = Boolean(status.globalTier) && !injectedProvider;

    const summary = {
      provider: providerName,
      ...(modelName ? { model: modelName } : {}),
      ...(providerName && primaryHost ? { sendsTo: primaryHost } : {}),
      // Present when the project tier and the global tier are embedded with different settings.
      ...(tiersDiffer ? { tiers: tierSummaries } : {}),
      dimensions,
      processed: totalProcessed,
      chunksIndexed: totalChunks,
      rebuiltTiers: [...rebuiltSet],
      errors: totalErrors,
      circuitBroken,
      ...(skippedProject ? { skippedProject: true } : {}),
      ...(skippedProject && projectNotApproved ? { projectNotApproved: true } : {}),
      ...(reason ? { reason } : {}),
      ...(error ? { error } : {}),
      // Documents the queue stopped retrying, each with the reason (`document_errors`: the document itself
      // failed 3 times; `service_failures`: the service failed 10 times on it); `--retry-failed` resets both.
      failedDocuments: listFailedEmbeddings(store, { scope: effectiveScope }),
      ...(retryReset ? { retryReset } : {}),
      ...(configProblems.length > 0 ? { configProblems } : {}),
    };

    if (totalErrors > 0 || error) {
      process.exitCode = 1;
    }

    return emit(summary);
  } finally {
    store.close();
  }
}

if (isMainModule(import.meta.url)) {
  runEmbedCli().catch((err) => {
    process.stderr.write(`embed cli error: ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
}
