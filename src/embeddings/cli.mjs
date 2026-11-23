import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CortexStore } from '../core/store.mjs';
import { isProjectEnabled, loadConfig } from '../core/config.mjs';
import { processPendingEmbeddings, resolveEmbeddingProvider } from './index.mjs';

function parseArgs(argv) {
  const args = {
    projectDir: process.cwd(),
    globalDir: undefined,
    scope: 'all',
    provider: '',
    model: '',
    maxDocs: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' && argv[i + 1]) args.projectDir = path.resolve(argv[++i]);
    else if (a === '--global' && argv[i + 1]) args.globalDir = path.resolve(argv[++i]);
    else if (a === '--scope' && argv[i + 1]) args.scope = argv[++i];
    else if (a === '--provider' && argv[i + 1]) args.provider = argv[++i];
    else if (a === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (a === '--max-docs' && argv[i + 1]) args.maxDocs = Number(argv[++i]) || 200;
  }
  return args;
}

export async function runEmbedCli(argv = process.argv.slice(2), { provider: injectedProvider = null } = {}) {
  const opts = parseArgs(argv);
  const overrides = {};
  if (opts.provider || opts.model) {
    overrides.embedding = {
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    };
  }

  const config = loadConfig({ projectDir: opts.projectDir, globalDir: opts.globalDir, overrides });
  const projectAllowed = isProjectEnabled(opts.projectDir, config);

  let effectiveScope = opts.scope;
  let skippedProject = false;
  if (!projectAllowed) {
    if (opts.scope === 'project') {
      const skippedRes = {
        provider: null,
        processed: 0,
        chunksIndexed: 0,
        rebuiltTiers: [],
        errors: 0,
        skipped: true,
        reason: 'project_disabled',
      };
      process.stdout.write(`${JSON.stringify(skippedRes, null, 2)}\n`);
      return skippedRes;
    }
    if (opts.scope === 'all') {
      effectiveScope = 'global';
      skippedProject = true;
    }
  }

  const store = new CortexStore({ projectDir: opts.projectDir, globalDir: opts.globalDir, config });
  try {
    const provider = injectedProvider || (await resolveEmbeddingProvider(config));

    let totalProcessed = 0;
    let totalChunks = 0;
    let totalErrors = 0;
    let dimensions = 0;
    let providerName = provider?.name || null;
    let modelName = provider?.model || '';
    let circuitBroken = false;
    let reason = undefined;
    const rebuiltSet = new Set();

    const maxIterations = 1000;
    for (let iter = 0; iter < maxIterations; iter++) {
      const batchRes = await processPendingEmbeddings(store, {
        scope: effectiveScope,
        provider,
        maxDocs: opts.maxDocs,
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

    const summary = {
      provider: providerName,
      ...(modelName ? { model: modelName } : {}),
      dimensions,
      processed: totalProcessed,
      chunksIndexed: totalChunks,
      rebuiltTiers: [...rebuiltSet],
      errors: totalErrors,
      circuitBroken,
      ...(skippedProject ? { skippedProject: true } : {}),
      ...(reason ? { reason } : {}),
    };

    if (totalErrors > 0) {
      process.exitCode = 1;
    }

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runEmbedCli().catch((err) => {
    process.stderr.write(`embed cli error: ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
}
