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
  resolveEmbeddingProvider,
  retryFailedEmbeddings,
} from './index.mjs';

function parseArgs(argv) {
  const args = {
    projectDir: process.cwd(),
    globalDir: undefined,
    scope: 'all',
    provider: '',
    model: '',
    maxDocs: 200,
    retryFailed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' && argv[i + 1]) args.projectDir = path.resolve(argv[++i]);
    else if (a === '--global' && argv[i + 1]) args.globalDir = path.resolve(argv[++i]);
    else if (a === '--scope' && argv[i + 1]) args.scope = argv[++i];
    else if (a === '--provider' && argv[i + 1]) args.provider = argv[++i];
    else if (a === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (a === '--max-docs' && argv[i + 1]) args.maxDocs = Number(argv[++i]) || 200;
    else if (a === '--retry-failed') args.retryFailed = true;
  }
  return args;
}

/**
 * Embed pending documents once and print a JSON summary on stdout.
 *
 * Flags: --project <dir>, --global <dir>, --scope project|global|all, --max-docs <n>,
 *   --provider <none|auto|gemini|openai|ollama|onnx>  use this provider for the run (embedding.provider)
 *   --model <name>      model for the provider in use (embedding.<provider>.model)
 *   --retry-failed      first reset the documents that reached the attempt cap, so they are tried again
 *
 * Before any work it prints on stderr which provider is in effect, where documents would be sent and any
 * configuration problem. A project that is excluded by the configuration, or that the user has not approved,
 * is skipped (`reason: "project_disabled"` / `"project_not_approved"`, or `skippedProject` with --scope all);
 * nothing in its .memory/ is read. An unknown provider name, a provider without its API key, or --model without a
 * provider to apply it to ends the run with exit code 1; so does any embedding error.
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
  const breaker = createEmbeddingBreaker();
  const baseOverrides = opts.provider ? { embedding: { provider: opts.provider } } : undefined;

  let config = loadConfig({ projectDir: opts.projectDir, globalDir: opts.globalDir, overrides: baseOverrides });
  let usageError = '';

  if (opts.model) {
    // --model belongs to one provider's block: the one named by --provider, else the one the config selects.
    const named = opts.provider.trim().toLowerCase();
    const target = EMBEDDING_PROVIDER_NAMES.includes(named)
      ? named
      : describeEmbeddingStatus(config, { env, breaker }).provider;
    if (target) {
      config = loadConfig({
        projectDir: opts.projectDir,
        globalDir: opts.globalDir,
        overrides: {
          embedding: {
            ...(opts.provider ? { provider: opts.provider } : {}),
            [target]: { model: opts.model },
          },
        },
      });
    } else if (!injectedProvider) {
      usageError = '--model was given but no embedding provider is in effect; '
        + `add --provider <${EMBEDDING_PROVIDER_NAMES.join('|')}> or set embedding.provider in config.json.`;
    }
  }

  const status = describeEmbeddingStatus(config, { env, breaker });
  for (const line of formatEmbeddingStatus(status)) {
    stderr.write(`[herdr-cortex] ${line}\n`);
  }
  if (usageError) stderr.write(`[herdr-cortex] ${usageError}\n`);

  const configProblems = status.problems.map((problem) => problem.message);
  const blocking = injectedProvider
    ? null
    : status.problems.find((problem) => problem.code === 'unknown_provider' || problem.code === 'missing_api_key');

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

  const store = new CortexStore({ projectDir: opts.projectDir, globalDir: opts.globalDir, config });
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

    if (usageError) {
      reason = 'invalid_arguments';
      error = usageError;
    } else if (blocking) {
      reason = blocking.code === 'unknown_provider' ? 'invalid_provider' : 'no_provider';
      error = blocking.message;
    } else {
      const provider = injectedProvider || (await resolveEmbeddingProvider(config, { env }));
      providerName = provider?.name || null;
      modelName = provider?.model || '';
      if (!provider) reason = 'no_provider';

      const maxIterations = provider ? 1000 : 0;
      for (let iter = 0; iter < maxIterations; iter++) {
        const batchRes = await processPendingEmbeddings(store, {
          scope: effectiveScope,
          provider,
          maxDocs: opts.maxDocs,
          breaker,
        });

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

    const summary = {
      provider: providerName,
      ...(modelName ? { model: modelName } : {}),
      ...(providerName && status.host ? { sendsTo: status.host } : {}),
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
      // Documents the queue stopped retrying (attempt cap); `--retry-failed` gives them a fresh start.
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
