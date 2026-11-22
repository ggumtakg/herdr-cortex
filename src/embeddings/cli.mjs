import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CortexStore } from '../core/store.mjs';
import { loadConfig } from '../core/config.mjs';
import { processPendingEmbeddings, resolveEmbeddingProvider } from './index.mjs';

function parseArgs(argv) {
  const args = { projectDir: process.cwd(), scope: 'all', provider: '', model: '', maxDocs: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' && argv[i + 1]) args.projectDir = path.resolve(argv[++i]);
    else if (a === '--scope' && argv[i + 1]) args.scope = argv[++i];
    else if (a === '--provider' && argv[i + 1]) args.provider = argv[++i];
    else if (a === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (a === '--max-docs' && argv[i + 1]) args.maxDocs = Number(argv[++i]) || 200;
  }
  return args;
}

export async function runEmbedCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const overrides = {};
  if (opts.provider || opts.model) {
    overrides.embedding = {
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    };
  }

  const config = loadConfig({ projectDir: opts.projectDir, overrides });
  const store = new CortexStore({ projectDir: opts.projectDir, config });
  try {
    const provider = await resolveEmbeddingProvider(config);
    const result = await processPendingEmbeddings(store, {
      scope: opts.scope,
      provider,
      maxDocs: opts.maxDocs,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
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
