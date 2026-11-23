import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  REPO_ROOT,
  atomicWriteText,
  compareTimestamps,
  formatIsoTimestamp,
  isMainModule,
  parseTimestampMs,
} from '../src/core/config.mjs';
import {
  chunkMarkdown,
  extractReferences,
  parseHeadingLine,
  parseMarkdownDoc,
  scanMarkdownLinkTargets,
  scanWikiLinkTargets,
  serializeMarkdownDoc,
} from '../src/core/frontmatter.mjs';
import { decodeCp949Strict, decodeDocBytes } from '../src/core/encoding.mjs';
import { getDuplicateDocIds, syncFromDisk } from '../src/core/db.mjs';
import { CortexStore } from '../src/core/store.mjs';
import { searchMemory } from '../src/core/search.mjs';
import { createMcpServer } from '../src/mcp/server.mjs';
import { createToolRegistry } from '../src/mcp/tools.mjs';
import { createRelayTools } from '../src/relay/tools.mjs';
import { approveProject } from '../src/core/trust.mjs';
import { COMPACT_POINTER_INSTRUCTION } from '../src/hooks/claude.mjs';

function makeTempEnv(prefix = 'herdr-cortex-robust-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  // The project folder of every test environment is approved, as a user would do with cortex-trust.
  approveProject(projectDir, { globalDir });
  fs.mkdirSync(homeDir, { recursive: true });
  return {
    root,
    projectDir,
    globalDir,
    homeDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Environment for child processes: everything the code could write goes to the temp tree.
function childEnv(env) {
  const out = {
    ...process.env,
    HERDR_CORTEX_HOME: env.globalDir,
    HERDR_CORTEX_TEST_HOME: env.homeDir,
    HERDR_CORTEX_PROJECT: env.projectDir,
  };
  delete out.HC_TERMINAL_ID;
  return out;
}

function projectDocsDir(store, month = '2026-11') {
  const tier = store.getTier('project', { create: true });
  const dir = path.join(tier.dir, 'docs', month);
  fs.mkdirSync(dir, { recursive: true });
  return { tier, dir };
}

function makeSeededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function randomString(random, alphabet, maxLen) {
  const len = Math.floor(random() * (maxLen + 1));
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

const UPDATED_AT_LINE_RE = /^updated_at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2})$/m;

// ---------------------------------------------------------------------------------------------
// 1. Entry points launched through a junction / symlink
// ---------------------------------------------------------------------------------------------

test('entry points: main-module check follows junction/symlink paths for all five scripts', () => {
  const env = makeTempEnv('cortex-junction-');
  const link = path.join(env.root, 'src-link');
  const realSrc = path.join(REPO_ROOT, 'src');

  try {
    fs.symlinkSync(realSrc, link, 'junction');

    const run = (relScript, args, input = '') =>
      spawnSync(process.execPath, ['--no-warnings', path.join(link, relScript), ...args], {
        input,
        encoding: 'utf8',
        cwd: env.projectDir,
        env: childEnv(env),
        timeout: 30000,
      });

    // hooks/claude.mjs
    const claude = run(path.join('hooks', 'claude.mjs'), ['pre-compact', '--id', 'herdr-cortex'], '{}');
    assert.equal(claude.status, 0, claude.stderr);
    // PreCompact prints its instruction as plain text (Claude Code does not read JSON from this event)
    assert.equal(claude.stdout, `${COMPACT_POINTER_INSTRUCTION}\n`);

    // hooks/antigravity.mjs (an unknown event still prints an empty JSON object)
    const agy = run(path.join('hooks', 'antigravity.mjs'), ['no-such-event'], '{}');
    assert.equal(agy.status, 0, agy.stderr);
    assert.deepEqual(JSON.parse(agy.stdout.trim()), {});

    // mcp/server.mjs
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });
    const server = run(
      path.join('mcp', 'server.mjs'),
      ['--project', env.projectDir, '--global', env.globalDir, '--prompts', path.join(REPO_ROOT, 'prompts')],
      `${initialize}\n`,
    );
    assert.equal(server.status, 0, server.stderr);
    const initResponse = JSON.parse(server.stdout.trim().split('\n')[0]);
    assert.equal(initResponse.id, 1);
    assert.equal(typeof initResponse.result.serverInfo.name, 'string');

    // embeddings/cli.mjs (provider "none": prints a summary without contacting any service)
    const embed = run(
      path.join('embeddings', 'cli.mjs'),
      ['--project', env.projectDir, '--global', env.globalDir, '--provider', 'none', '--scope', 'project'],
    );
    assert.equal(embed.status, 0, embed.stderr);
    assert.equal(JSON.parse(embed.stdout).provider, null);

    // hooks/installer.mjs (no action: usage error, nothing installed)
    const installer = run(path.join('hooks', 'installer.mjs'), []);
    assert.equal(installer.status, 1);
    assert.match(installer.stderr, /Usage: .*installer\.mjs/);

    // The shared helper: the same file through the link is "main"; another file or a missing argv[1] is not
    const realScript = path.join(realSrc, 'hooks', 'claude.mjs');
    const moduleUrl = pathToFileURL(realScript).href;
    assert.equal(isMainModule(moduleUrl, realScript), true);
    assert.equal(isMainModule(moduleUrl, path.join(link, 'hooks', 'claude.mjs')), true);
    assert.equal(isMainModule(moduleUrl, path.join(link, 'hooks', 'antigravity.mjs')), false);
    assert.equal(isMainModule(moduleUrl, path.join(env.root, 'does-not-exist.mjs')), false);
    assert.equal(isMainModule(moduleUrl, undefined), false);
    assert.equal(isMainModule(moduleUrl, ''), false);
  } finally {
    // Remove the link itself first so cleanup can never follow it into the repository
    try {
      fs.unlinkSync(link);
    } catch {
      try {
        fs.rmdirSync(link);
      } catch {
        // the link was never created
      }
    }
    assert.equal(fs.existsSync(path.join(realSrc, 'core', 'config.mjs')), true);
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Linear-time link / heading scanning
// ---------------------------------------------------------------------------------------------

// The patterns the scanners replace; kept here as the behavioral reference.
function referenceWikiTargets(text) {
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function referenceMarkdownLinkTargets(text) {
  const re = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function referenceHeading(line) {
  const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  return m ? m[2].trim() : null;
}

const SAMPLE_MARKDOWN = [
  '# 설계 메모 [[dec-20261122-sqlite-wal]]',
  '',
  'See [[dec-old-history|the old decision]] and [[know-한글-문서-01]] plus [[ spaced-id ]].',
  'Broken ones: [[]] [[|alias only]] [[unterminated and [[a]] [[b|c]] ]] [[x|y]z]] [[nested [[inner]] outer]].',
  'A triple [[[bracket]]] and a pipe table | a | b | with [[id-in-table|alias | with pipe]].',
  '',
  'Links: [store](src/core/store.mjs) and [db docs](./docs/db.md#schema "Title") and [q](a.md?x=1).',
  'Image ![diagram](docs/diagram.png) is not a link, but [![badge](badge.svg)](docs/ci.md) contains one.',
  'URL [site](https://example.com/a(b)c) and <angle> [angled](<src/with space.md>) and [empty]() and []().',
  'Nested [outer [inner] text](src/nested.md) and [a](b)(c) and [first](one.md)[second](two.md).',
  'Footnote[^1] and reference [ref][label] and escaped \\[not a link\\](x.md).',
  'Multi-line [label that',
  'continues on the next line](src/multi-line.md) and a stray ] ) ( [ at the end.',
  '',
  '```js',
  'const inCode = "[[not-a-link]] [x](y.md)";',
  '```',
  '',
  '## 둘째 제목   ',
  '####### seven hashes is not a heading',
  '#no-space is not a heading',
  '#  ',
  '[^1]: footnote text with [[foot-link]] and [foot](docs/foot.md)',
].join('\n');

test('frontmatter: linear link and heading scanners return exactly what the replaced regexes returned', () => {
  // Real-looking Markdown
  assert.deepEqual(scanWikiLinkTargets(SAMPLE_MARKDOWN), referenceWikiTargets(SAMPLE_MARKDOWN));
  assert.deepEqual(scanMarkdownLinkTargets(SAMPLE_MARKDOWN), referenceMarkdownLinkTargets(SAMPLE_MARKDOWN));
  assert.ok(scanWikiLinkTargets(SAMPLE_MARKDOWN).includes('dec-old-history'));
  assert.ok(scanMarkdownLinkTargets(SAMPLE_MARKDOWN).includes('src/core/store.mjs'));

  for (const line of SAMPLE_MARKDOWN.split('\n')) {
    assert.equal(parseHeadingLine(line), referenceHeading(line), JSON.stringify(line));
  }

  // Extracted references are the ones a reader would expect (fenced code is ignored)
  const refs = extractReferences(SAMPLE_MARKDOWN, {});
  for (const id of ['dec-20261122-sqlite-wal', 'dec-old-history', 'know-한글-문서-01', 'spaced-id', 'b', 'id-in-table', 'foot-link']) {
    assert.ok(refs.linksTo.includes(id), `missing wiki link ${id}`);
  }
  assert.equal(refs.linksTo.includes('not-a-link'), false);
  for (const file of ['src/core/store.mjs', 'docs/db.md', 'a.md', 'badge.svg', 'one.md', 'two.md', 'src/multi-line.md', 'docs/foot.md']) {
    assert.ok(refs.fileLinks.includes(file), `missing file link ${file}`);
  }
  assert.equal(refs.fileLinks.includes('docs/diagram.png'), false);
  assert.equal(refs.fileLinks.some((f) => f.includes('example.com')), false);

  const chunks = chunkMarkdown(SAMPLE_MARKDOWN);
  assert.deepEqual([...new Set(chunks.map((c) => c.heading))], ['설계 메모 [[dec-20261122-sqlite-wal]]', '둘째 제목', '']);

  // Randomized equivalence over the characters that drive the scanners
  const random = makeSeededRandom(20261123);
  const linkAlphabet = ['[', '[', ']', ']', '|', '(', ')', '!', 'a', 'b', ' ', '\n'];
  for (let n = 0; n < 20000; n++) {
    const s = randomString(random, linkAlphabet, 28);
    assert.deepEqual(scanWikiLinkTargets(s), referenceWikiTargets(s), JSON.stringify(s));
    assert.deepEqual(scanMarkdownLinkTargets(s), referenceMarkdownLinkTargets(s), JSON.stringify(s));
  }
  const headingAlphabet = ['#', '#', ' ', ' ', '\t', 'a', 'b', '\r', String.fromCharCode(0x2028), String.fromCharCode(0xa0), 'x'];
  for (let n = 0; n < 20000; n++) {
    const s = randomString(random, headingAlphabet, 12);
    assert.equal(parseHeadingLine(s), referenceHeading(s), JSON.stringify(s));
  }
});

test('frontmatter: 300KB of brackets (or a heading with a long gap) is processed in well under a second', () => {
  const size = 300 * 1024;
  const hostile = {
    'single brackets': '['.repeat(size),
    'double brackets': '[['.repeat(size / 2),
    'unterminated links': '[a]('.repeat(size / 4),
    'unterminated aliases': '[[a|'.repeat(size / 4),
    'image-like prefixes': '![['.repeat(size / 3),
    'heading with a long gap': `# a${' '.repeat(size)}b`,
  };

  for (const [label, body] of Object.entries(hostile)) {
    const started = performance.now();
    const refs = extractReferences(body, {});
    const chunks = chunkMarkdown(body);
    const parsed = parseMarkdownDoc(`---\nid: hostile\ntitle: Hostile\n---\n\n${body}`);
    const elapsed = performance.now() - started;

    assert.deepEqual(refs.linksTo, [], label);
    assert.deepEqual(refs.fileLinks, [], label);
    assert.ok(chunks.length > 0, label);
    assert.equal(parsed.body.length, body.length, label);
    assert.ok(elapsed < 1000, `${label}: took ${elapsed.toFixed(0)}ms`);
  }
});

// ---------------------------------------------------------------------------------------------
// 3. Millisecond timestamps and session ordering
// ---------------------------------------------------------------------------------------------

test('timestamps: millisecond precision, mixed-format comparison, and session_next in creation order', () => {
  const env = makeTempEnv('cortex-ts-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    // Format carries milliseconds
    const stamp = formatIsoTimestamp(new Date(2026, 10, 22, 21, 15, 0, 42));
    assert.match(stamp, /^2026-11-22T21:15:00\.042[+-]\d{2}:\d{2}$/);
    assert.equal(parseTimestampMs(stamp), new Date(2026, 10, 22, 21, 15, 0, 42).getTime());

    // Old second-precision values and other hand-written variants still parse
    assert.equal(parseTimestampMs('2026-11-22T21:15:00+09:00'), Date.UTC(2026, 10, 22, 12, 15, 0));
    assert.equal(parseTimestampMs('2026-11-22T12:15:00Z'), Date.UTC(2026, 10, 22, 12, 15, 0));
    assert.equal(parseTimestampMs('2026-11-22T12:15:00.250Z'), Date.UTC(2026, 10, 22, 12, 15, 0, 250));
    assert.equal(parseTimestampMs('2026-11-22 21:15:00'), new Date(2026, 10, 22, 21, 15, 0).getTime());
    assert.equal(parseTimestampMs('2026-11-22'), new Date(2026, 10, 22).getTime());
    assert.ok(Number.isNaN(parseTimestampMs('not a date')));

    // Comparison is chronological even where plain string order is not
    assert.ok(compareTimestamps('2026-11-22T12:15:00Z', '2026-11-22T12:15:00.500Z') < 0);
    assert.ok(compareTimestamps('2026-11-22T21:15:00+09:00', '2026-11-22T21:15:00.001+09:00') < 0);
    assert.ok(compareTimestamps('2026-11-22T12:00:00+09:00', '2026-11-22T04:00:00+00:00') < 0);
    assert.equal(compareTimestamps('2026-11-22T21:15:00+09:00', '2026-11-22T12:15:00.000Z'), 0);
    assert.ok(compareTimestamps('garbage', '2026-11-22T12:15:00Z') < 0);

    // Documents saved back-to-back whose ids sort in the opposite order
    const ids = ['e-first', 'd-second', 'c-third', 'b-fourth', 'a-fifth'];
    const saved = ids.map((id) =>
      store.saveDoc({ id, type: 'worklog', title: id, summary: 'back-to-back save', session: 'burst' }));
    for (let i = 0; i < saved.length; i++) {
      assert.match(saved[i].created_at, /\.\d{3}[+-]\d{2}:\d{2}$/);
      if (i > 0) assert.ok(compareTimestamps(saved[i - 1].created_at, saved[i].created_at) < 0);
    }

    const tier = store.getTier('project');
    const edgesOf = (session) =>
      tier.db
        .prepare(`
          SELECT e.src, e.dst FROM edges e JOIN docs d ON d.id = e.src
          WHERE e.kind = 'session_next' AND d.session = ?
        `)
        .all(session)
        .map((e) => `${e.src}>${e.dst}`)
        .sort();

    assert.deepEqual(edgesOf('burst'), ['b-fourth>a-fifth', 'c-third>b-fourth', 'd-second>c-third', 'e-first>d-second']);

    // Old and new formats mixed in one session (hand-written files)
    const { dir } = projectDocsDir(store);
    const writeDoc = (id, createdAt) =>
      atomicWriteText(
        path.join(dir, `${id}.md`),
        `---\nid: ${id}\ntype: worklog\ntitle: ${id}\nsummary: mixed formats\nstatus: active\nsession: mixed\ntags: []\ncreated_at: ${createdAt}\nupdated_at: ${createdAt}\n---\n\nbody\n`,
      );
    writeDoc('d-first', '2026-11-22T12:15:00Z');
    writeDoc('c-second', '2026-11-22T21:15:00.250+09:00');
    writeDoc('b-third', '2026-11-22T12:15:00.500Z');
    writeDoc('a-fourth', '2026-11-22T21:15:01+09:00');
    store.sync('project');

    assert.deepEqual(edgesOf('mixed'), ['b-third>a-fourth', 'c-second>b-third', 'd-first>c-second']);
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 4. JSON-RPC batch requests
// ---------------------------------------------------------------------------------------------

test('MCP server: a JSON-RPC batch gets one -32600 error instead of silence (stdio round-trip)', async () => {
  const env = makeTempEnv('cortex-batch-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  let child = null;
  try {
    // Child process over stdio
    child = spawn(
      process.execPath,
      [
        '--no-warnings',
        path.join(REPO_ROOT, 'src', 'mcp', 'server.mjs'),
        '--project', env.projectDir,
        '--global', env.globalDir,
        '--prompts', path.join(REPO_ROOT, 'prompts'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(env) },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`MCP server did not exit. stdout=${stdout} stderr=${stderr}`));
      }, 20000);
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    const batch = [
      { jsonrpc: '2.0', id: 10, method: 'ping' },
      { jsonrpc: '2.0', id: 11, method: 'tools/list' },
    ];
    child.stdin.write(`${JSON.stringify(batch)}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'ping' })}\n`);
    child.stdin.end();
    await exited;

    const responses = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(responses.length, 2, `stdout=${stdout} stderr=${stderr}`);
    assert.equal(responses[0].jsonrpc, '2.0');
    assert.equal(responses[0].id, null);
    assert.equal(responses[0].error.code, -32600);
    assert.match(responses[0].error.message, /batch requests are not supported/i);
    // The server keeps serving after the rejected batch
    assert.equal(responses[1].id, 12);
    assert.deepEqual(responses[1].result, {});

    // Same answer in-process, including for an empty batch
    const server = createMcpServer({ store, includeRelayTools: false });
    const direct = await server.handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    assert.equal(direct.id, null);
    assert.equal(direct.error.code, -32600);
    assert.match(direct.error.message, /batch requests are not supported/i);
    const emptyBatch = await server.handleMessage([]);
    assert.equal(emptyBatch.error.code, -32600);
  } finally {
    if (child) child.kill();
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 5. Duplicate document ids
// ---------------------------------------------------------------------------------------------

test('db: duplicate-id warning is printed once per (id, path) and getDuplicateDocIds lists current duplicates', () => {
  const env = makeTempEnv('cortex-dup-');
  const origErr = console.error;
  const warnings = [];
  console.error = (...args) => warnings.push(args.join(' '));
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const { tier, dir } = projectDocsDir(store);
    assert.deepEqual(getDuplicateDocIds(tier.dir), []);

    const dup = serializeMarkdownDoc({ id: 'dup-id', type: 'knowledge', title: 'Dup', summary: 'Same id twice' }, 'body');
    atomicWriteText(path.join(dir, 'a-first.md'), dup);
    atomicWriteText(path.join(dir, 'b-second.md'), dup);

    const countWarnings = (file) =>
      warnings.filter((w) => w.includes('duplicate document ID "dup-id"') && w.includes(file)).length;

    for (let i = 0; i < 4; i++) syncFromDisk(tier.db, tier.dir);
    store.sync('project');
    store.readDoc({ id: 'dup-id', scope: 'project' });

    assert.equal(countWarnings('b-second.md'), 1, warnings.join('\n'));
    assert.deepEqual(getDuplicateDocIds(tier.dir), [
      { id: 'dup-id', path: 'docs/2026-11/b-second.md', keptPath: 'docs/2026-11/a-first.md' },
    ]);
    // The list is a copy: callers cannot corrupt the registry
    getDuplicateDocIds(tier.dir).pop();
    assert.equal(getDuplicateDocIds(tier.dir).length, 1);

    // A different file with the same id is a new pair: one more warning, both listed
    atomicWriteText(path.join(dir, 'c-third.md'), dup);
    syncFromDisk(tier.db, tier.dir);
    syncFromDisk(tier.db, tier.dir);
    assert.equal(countWarnings('c-third.md'), 1);
    assert.equal(countWarnings('b-second.md'), 1);
    assert.deepEqual(getDuplicateDocIds(tier.dir).map((d) => d.path), [
      'docs/2026-11/b-second.md',
      'docs/2026-11/c-third.md',
    ]);

    // The list reflects the latest sync: resolved duplicates disappear
    fs.unlinkSync(path.join(dir, 'b-second.md'));
    fs.unlinkSync(path.join(dir, 'c-third.md'));
    syncFromDisk(tier.db, tier.dir);
    assert.deepEqual(getDuplicateDocIds(tier.dir), []);
    assert.equal(tier.db.prepare("SELECT path FROM docs WHERE id = 'dup-id'").get().path, 'docs/2026-11/a-first.md');
  } finally {
    console.error = origErr;
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 6. memory_update supersedes + unknown arguments
// ---------------------------------------------------------------------------------------------

test('memory_update: supersedes transitions the old document, records the edge, and reports the same warnings as memory_save', async () => {
  const env = makeTempEnv('cortex-sup-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const registry = createToolRegistry(store, { promptsDir: path.join(REPO_ROOT, 'prompts') });
    const call = (name, args) => registry.callTool(name, args, {});

    const oldBody = 'Old design body that must stay intact.';
    await call('memory_save', { id: 'dec-old', type: 'decision', title: 'Old design', summary: 'old', content: oldBody });
    await call('memory_save', { id: 'dec-new', type: 'decision', title: 'New design', summary: 'new', content: 'New body.' });
    await call('memory_save', { id: 'pref-global', scope: 'global', type: 'knowledge', title: 'Global doc', summary: 'global' });

    const updated = await call('memory_update', { id: 'dec-new', supersedes: 'dec-old' });
    assert.equal(updated.isError, false, JSON.stringify(updated.data));
    assert.equal(updated.data.supersedes, 'dec-old');
    assert.equal(updated.data.supersededTransitioned, 'dec-old');
    assert.equal('supersedesWarning' in updated.data, false);

    const oldDoc = (await call('memory_read', { id: 'dec-old' })).data;
    assert.equal(oldDoc.status, 'superseded');
    assert.equal(oldDoc.content.trim(), oldBody);
    const newDoc = (await call('memory_read', { id: 'dec-new' })).data;
    assert.equal(newDoc.supersedes, 'dec-old');
    assert.equal(newDoc.status, 'active');

    const graph = (await call('memory_graph', { target: 'dec-old', direction: 'in', depth: 1 })).data;
    assert.ok(
      graph.edges.some((e) => e.src === 'dec-new' && e.dst === 'dec-old' && e.kind === 'supersedes'),
      JSON.stringify(graph.edges),
    );

    // Same warnings as memory_save: missing target, and target living in the other scope
    const missing = await call('memory_update', { id: 'dec-new', supersedes: 'no-such-doc' });
    assert.equal(missing.isError, false);
    assert.equal(missing.data.supersededTransitioned, null);
    assert.match(missing.data.supersedesWarning, /"no-such-doc" not found in "project" scope; not transitioned/);

    const otherScope = await call('memory_update', { id: 'dec-new', supersedes: 'pref-global' });
    assert.match(otherScope.data.supersedesWarning, /"pref-global" exists in "global" scope, not "project"; not transitioned/);
    assert.equal((await call('memory_read', { id: 'pref-global', scope: 'global' })).data.status, 'active');

    const viaSave = await call('memory_save', { id: 'dec-third', type: 'decision', title: 'Third', summary: 's', supersedes: 'no-such-doc' });
    assert.equal(viaSave.data.supersedesWarning, missing.data.supersedesWarning);

    const self = await call('memory_update', { id: 'dec-new', supersedes: 'dec-new' });
    assert.equal(self.isError, true);
    assert.match(self.data.message, /cannot supersede itself/);

    // An empty string clears the link (the old document is left as it is)
    const cleared = await call('memory_update', { id: 'dec-new', supersedes: '' });
    assert.equal(cleared.isError, false);
    assert.equal((await call('memory_read', { id: 'dec-new' })).data.supersedes, '');
  } finally {
    store.close();
    env.cleanup();
  }
});

test('tools: unknown arguments are rejected with the allowed list on every tool; _caller_agent_id stays accepted', async () => {
  const env = makeTempEnv('cortex-args-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const hcCalls = [];
    const fakeHc = {
      listTerminals() { hcCalls.push('ls'); return { ok: true, terminals: [] }; },
      getTerminal(id) { hcCalls.push(`get ${id}`); return { ok: false, error: 'not running', code: 'ENOENT' }; },
      sendTrigger(id) { hcCalls.push(`send ${id}`); return { ok: false, error: 'not running' }; },
    };
    const relayTools = createRelayTools({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
      hcClient: fakeHc,
      store,
      getCurrentTerminalId: () => 't1',
    });
    const registry = createToolRegistry(store, {
      promptsDir: path.join(REPO_ROOT, 'prompts'),
      extraTools: relayTools,
    });
    const call = (name, args, meta = {}) => registry.callTool(name, args, meta);

    await call('memory_save', { id: 'doc-1', type: 'todo', title: 'Todo', summary: 'still open' });

    // A typo fails loudly, names the key, and lists what is allowed
    const typo = await call('memory_update', { id: 'doc-1', staus: 'done' });
    assert.equal(typo.isError, true);
    assert.equal(typo.data.error, 'UNKNOWN_ARGUMENT');
    assert.equal(typo.data.tool, 'memory_update');
    assert.deepEqual(typo.data.unknown_arguments, ['staus']);
    assert.ok(typo.data.allowed_arguments.includes('status'));
    assert.ok(typo.data.allowed_arguments.includes('supersedes'));
    assert.match(typo.data.message, /"staus"/);
    assert.match(typo.data.message, /status/);
    assert.equal((await call('memory_read', { id: 'doc-1' })).data.status, 'active');

    // Every tool is checked against its own inputSchema.properties
    const tools = registry.listTools();
    assert.equal(tools.length, 10);
    for (const tool of tools) {
      const res = await call(tool.name, { definitely_not_an_argument: 1, another_bad_one: 2 });
      assert.equal(res.isError, true, tool.name);
      assert.equal(res.data.error, 'UNKNOWN_ARGUMENT', tool.name);
      assert.deepEqual(res.data.unknown_arguments, ['definitely_not_an_argument', 'another_bad_one'], tool.name);
      assert.deepEqual(res.data.allowed_arguments, Object.keys(tool.inputSchema.properties), tool.name);
    }
    // Rejected calls never reached the handlers
    assert.deepEqual(hcCalls, []);
    const rejectedSend = await call('relay_send', { to_terminal_id: 't2', message: 'hi', wakee: 'never' });
    assert.equal(rejectedSend.data.error, 'UNKNOWN_ARGUMENT');
    assert.deepEqual(hcCalls, []);

    // The hook-injected internal key is accepted everywhere (read tools run, write tools stay protected)
    const read = await call('memory_read', { id: 'doc-1', _caller_agent_id: 'subagent-7' });
    assert.equal(read.isError, false);
    assert.equal(read.data.id, 'doc-1');
    assert.equal((await call('memory_overview', { _caller_agent_id: 'subagent-7' })).isError, false);
    assert.equal((await call('memory_search', { query: 'Todo', _caller_agent_id: 'subagent-7' })).isError, false);
    assert.equal((await call('memory_graph', { target: 'doc-1', _caller_agent_id: 'subagent-7' })).isError, false);
    assert.equal((await call('cortex_prompt', { kind: 'core', _caller_agent_id: 'subagent-7' })).isError, false);
    assert.equal((await call('relay_tabs', { _caller_agent_id: 'subagent-7' })).isError, false);
    assert.equal((await call('relay_inbox', { action: 'peek', _caller_agent_id: 'subagent-7' })).isError, false);
    for (const writeTool of ['memory_save', 'memory_update', 'relay_send']) {
      const denied = await call(writeTool, { id: 'doc-1', _caller_agent_id: 'subagent-7' });
      assert.equal(denied.data.error, 'SUBAGENT_WRITE_DENIED', writeTool);
    }

    // Valid arguments still work
    const ok = await call('memory_update', { id: 'doc-1', status: 'done' });
    assert.equal(ok.isError, false);
    assert.equal(ok.data.status, 'done');
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 7. updateDoc across processes
// ---------------------------------------------------------------------------------------------

const APPEND_WORKER_SOURCE = `
const [storeUrl, projectDir, globalDir, workerId, iterations, startAt] = process.argv.slice(2);
const { CortexStore } = await import(storeUrl);
const store = new CortexStore({ projectDir, globalDir, disableVec: true });
try {
  // All workers start hammering at the same moment
  while (Date.now() < Number(startAt)) { /* spin */ }
  for (let i = 0; i < Number(iterations); i++) {
    store.updateDoc({ id: 'shared-doc', scope: 'project', append_content: 'marker-' + workerId + '-' + i + '.' });
  }
} finally {
  store.close();
}
`;

test('store: concurrent updateDoc from several processes loses no update', async () => {
  const env = makeTempEnv('cortex-concurrent-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const saved = store.saveDoc({ id: 'shared-doc', type: 'worklog', title: 'Shared', summary: 'appended by many', content: 'start' });
    const { tier } = projectDocsDir(store);
    const docPath = path.join(tier.dir, saved.path);

    const workerPath = path.join(env.root, 'append-worker.mjs');
    fs.writeFileSync(workerPath, APPEND_WORKER_SOURCE, 'utf8');
    const storeUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'store.mjs')).href;

    const workers = 4;
    const iterations = 25;
    const startAt = Date.now() + 1500;

    const results = await Promise.all(
      Array.from({ length: workers }, (_, w) =>
        new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            ['--no-warnings', workerPath, storeUrl, env.projectDir, env.globalDir, String(w), String(iterations), String(startAt)],
            { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv(env) },
          );
          let stderr = '';
          child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
          child.once('close', (code) => resolve({ code, stderr }));
        })),
    );
    for (const res of results) {
      assert.equal(res.code, 0, res.stderr);
    }

    const finalText = fs.readFileSync(docPath, 'utf8');
    const missing = [];
    for (let w = 0; w < workers; w++) {
      for (let i = 0; i < iterations; i++) {
        if (!finalText.includes(`marker-${w}-${i}.`)) missing.push(`marker-${w}-${i}`);
      }
    }
    assert.deepEqual(missing, [], `${missing.length} of ${workers * iterations} appends were lost`);
    assert.ok(finalText.includes('start'));

    // The index agrees with the file
    const indexed = store.readDoc({ id: 'shared-doc', scope: 'project' });
    assert.equal((indexed.content.match(/marker-\d+-\d+\./g) || []).length, workers * iterations);
  } finally {
    store.close();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 8. Updating hand-written documents
// ---------------------------------------------------------------------------------------------

const HAND_WRITTEN_NESTED = [
  '---',
  'id: hand-nested',
  'type: knowledge',
  'title: Hand written   # inline comment stays',
  'summary: Has nested yaml',
  '# reviewer: do not delete this note',
  'meta:',
  '  owner: kim',
  '  level: 2',
  '  labels:',
  '    - a',
  '    - b',
  'status: active',
  '',
  "tags: ['alpha', \"beta\"]",
  'custom_key: keep me',
  '---',
  '',
  'Body line 1.',
  '',
].join('\n');

test('memory_update on a hand-written document keeps frontmatter lines the parser does not understand', async () => {
  const env = makeTempEnv('cortex-hand-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const registry = createToolRegistry(store, { promptsDir: path.join(REPO_ROOT, 'prompts') });
    const call = (name, args) => registry.callTool(name, args, {});
    const { dir } = projectDocsDir(store);

    // (a) nested YAML, comments, unknown keys, hand formatting; written with CRLF line endings
    const nestedPath = path.join(dir, 'hand-nested.md');
    fs.writeFileSync(nestedPath, HAND_WRITTEN_NESTED.replace(/\n/g, '\r\n'), 'utf8');

    const res = await call('memory_update', { id: 'hand-nested', status: 'done', append_content: 'More.' });
    assert.equal(res.isError, false, JSON.stringify(res.data));

    const after = fs.readFileSync(nestedPath, 'utf8');
    const stamp = UPDATED_AT_LINE_RE.exec(after)?.[1];
    assert.ok(stamp, after);
    assert.equal(
      after,
      [
        '---',
        'id: hand-nested',
        'type: knowledge',
        'title: Hand written   # inline comment stays',
        'summary: Has nested yaml',
        '# reviewer: do not delete this note',
        'meta:',
        '  owner: kim',
        '  level: 2',
        '  labels:',
        '    - a',
        '    - b',
        'status: done',
        '',
        "tags: ['alpha', \"beta\"]",
        'custom_key: keep me',
        `updated_at: ${stamp}`,
        '---',
        '',
        'Body line 1.',
        '',
        'More.',
        '',
      ].join('\n'),
    );

    // A second update changes only what it was asked to change
    const res2 = await call('memory_update', { id: 'hand-nested', tags: ['alpha', 'beta', 'gamma'], due: '2026-12-01' });
    assert.equal(res2.isError, false, JSON.stringify(res2.data));
    const after2 = fs.readFileSync(nestedPath, 'utf8');
    const stamp2 = UPDATED_AT_LINE_RE.exec(after2)[1];
    assert.equal(
      after2,
      after
        .replace("tags: ['alpha', \"beta\"]", 'tags: [alpha, beta, gamma]')
        .replace(`updated_at: ${stamp}`, `due: 2026-12-01\nupdated_at: ${stamp2}`),
    );
    const read = (await call('memory_read', { id: 'hand-nested' })).data;
    assert.equal(read.status, 'done');
    assert.deepEqual(read.tags, ['alpha', 'beta', 'gamma']);

    // Replacing a key whose value continues on lines the parser cannot read is refused, not guessed
    const multiPath = path.join(dir, 'hand-multiline.md');
    const multiText = '---\nid: hand-multiline\ntitle: Multi\nsummary: "first line\n  second line"\nstatus: active\n---\n\nBody.\n';
    fs.writeFileSync(multiPath, multiText, 'utf8');
    const refused = await call('memory_update', { id: 'hand-multiline', summary: 'replaced' });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.error, 'UNSAFE_UPDATE');
    assert.match(refused.data.message, /hand-multiline\.md/);
    assert.match(refused.data.message, /summary/);
    assert.match(refused.data.message, /by hand/);
    assert.equal(fs.readFileSync(multiPath, 'utf8'), multiText);

    // ...while other keys of the same document can still be updated without touching those lines
    const allowed = await call('memory_update', { id: 'hand-multiline', status: 'done' });
    assert.equal(allowed.isError, false, JSON.stringify(allowed.data));
    const multiAfter = fs.readFileSync(multiPath, 'utf8');
    assert.ok(multiAfter.includes('summary: "first line\n  second line"\nstatus: done\n'), multiAfter);

    // The supersede transition preserves hand-written content the same way
    const supersedePath = path.join(dir, 'hand-superseded.md');
    fs.writeFileSync(supersedePath, HAND_WRITTEN_NESTED.replace('id: hand-nested', 'id: hand-superseded'), 'utf8');
    const saved = await call('memory_save', { id: 'dec-replacement', type: 'decision', title: 'Replacement', summary: 's', supersedes: 'hand-superseded' });
    assert.equal(saved.data.supersededTransitioned, 'hand-superseded');
    const supersededText = fs.readFileSync(supersedePath, 'utf8');
    for (const line of ['# reviewer: do not delete this note', 'meta:', '  owner: kim', '    - b', 'custom_key: keep me', 'status: superseded', 'Body line 1.']) {
      assert.ok(supersededText.split('\n').includes(line), `lost line: ${line}`);
    }
  } finally {
    store.close();
    env.cleanup();
  }
});

// "한글 메모장 문서" saved by Notepad as ANSI (code page 949, CRLF), including syllables outside KS X 1001.
const CP949_DOC_HEX =
  '2d2d2d0d0a69643a2063703934392d6e6f74650d0a747970653a206b6e6f776c656467650d0a7469746c653a20c7d1b1db20b8deb8f0c0e520b9aebcad0d0a'
  + '73756d6d6172793a208c63b9e6b0a2c7cfbfcd20c6e9bdc3c4ddb6f320b1d7b8aeb0ed20c1642028c8aec0e520b1dbc0da20c6f7c7d4290d0a'
  + '7374617475733a206163746976650d0a746167733a205bc7d1b1db2c20b8deb8f05d0d0a2d2d2d0d0a0d0a'
  + 'b8deb8f0c0e5bfa1bcad20414e5349b7ce20c0fac0e5c7d120babbb9aec0d4b4cfb4d92e0d0ab5d1c2b020c1d93a209b5894ee20c5d7bdbac6ae2e0d0a';

const CP949_DOC_TEXT = [
  '---',
  'id: cp949-note',
  'type: knowledge',
  'title: 한글 메모장 문서',
  'summary: 똠방각하와 펩시콜라 그리고 햏 (확장 글자 포함)',
  'status: active',
  'tags: [한글, 메모]',
  '---',
  '',
  '메모장에서 ANSI로 저장한 본문입니다.',
  '둘째 줄: 쌰뷁 테스트.',
  '',
].join('\n');

test('encoding: BOM, UTF-8, CP949 (with extension syllables) are detected; anything else is reported unsafe', () => {
  const cp949Bytes = Buffer.from(CP949_DOC_HEX, 'hex');
  const fromCp949 = decodeDocBytes(cp949Bytes);
  assert.equal(fromCp949.safe, true);
  assert.equal(fromCp949.encoding, 'cp949');
  assert.equal(fromCp949.text.replace(/\r\n/g, '\n'), CP949_DOC_TEXT);

  // First and last CP949 extension cells, and the two signs CP949 adds to KS X 1001
  assert.equal(decodeCp949Strict(Buffer.from('8141', 'hex')), String.fromCharCode(0xac02));
  assert.equal(decodeCp949Strict(Buffer.from('c652', 'hex')), String.fromCharCode(0xd7a3));
  assert.equal(decodeCp949Strict(Buffer.from('a2e6a2e7', 'hex')), String.fromCharCode(0x20ac, 0xae));
  assert.equal(decodeCp949Strict(Buffer.from('41c7d142', 'hex')), 'A한B');
  for (const invalid of ['c653', '8140', 'ff41', 'c7', '80', 'ada1']) {
    assert.equal(decodeCp949Strict(Buffer.from(invalid, 'hex')), null, invalid);
  }

  const sample = '제목: 한글 ✓ plain';
  const utf8 = decodeDocBytes(Buffer.from(sample, 'utf8'));
  assert.deepEqual([utf8.safe, utf8.encoding, utf8.text], [true, 'utf-8', sample]);

  const utf8Bom = decodeDocBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample, 'utf8')]));
  assert.deepEqual([utf8Bom.safe, utf8Bom.encoding, utf8Bom.text], [true, 'utf-8', sample]);

  const utf16le = decodeDocBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sample, 'utf16le')]));
  assert.deepEqual([utf16le.safe, utf16le.encoding, utf16le.text], [true, 'utf-16le', sample]);

  const utf16be = decodeDocBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(sample, 'utf16le').swap16()]));
  assert.deepEqual([utf16be.safe, utf16be.encoding, utf16be.text], [true, 'utf-16be', sample]);

  const empty = decodeDocBytes(Buffer.alloc(0));
  assert.deepEqual([empty.safe, empty.text], [true, '']);

  // Not UTF-8 and not CP949; UTF-16 without a BOM; a BOM followed by invalid data
  const garbage = decodeDocBytes(Buffer.concat([Buffer.from('title: x ', 'utf8'), Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x20])]));
  assert.equal(garbage.safe, false);
  assert.equal(garbage.encoding, 'unknown');
  assert.match(garbage.reason, /neither valid UTF-8 nor valid CP949/);
  assert.ok(garbage.text.startsWith('title: x '));

  const utf16NoBom = decodeDocBytes(Buffer.from('plain ascii', 'utf16le'));
  assert.equal(utf16NoBom.safe, false);
  assert.match(utf16NoBom.reason, /NUL/);

  const oddUtf16 = decodeDocBytes(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42]));
  assert.equal(oddUtf16.safe, false);
  const badUtf8Bom = decodeDocBytes(Buffer.from([0xef, 0xbb, 0xbf, 0xc7, 0xd1]));
  assert.equal(badUtf8Bom.safe, false);
});

test('memory_update on non-UTF-8 documents: CP949 and UTF-16 are converted to UTF-8, undecodable files are refused', async () => {
  const env = makeTempEnv('cortex-enc-');
  const origErr = console.error;
  console.error = () => {};
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const registry = createToolRegistry(store, { promptsDir: path.join(REPO_ROOT, 'prompts') });
    const call = (name, args) => registry.callTool(name, args, {});
    const { dir } = projectDocsDir(store);
    const strictUtf8 = (filePath) => new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filePath));

    // --- CP949 ---
    const cp949Path = path.join(dir, 'cp949-note.md');
    fs.writeFileSync(cp949Path, Buffer.from(CP949_DOC_HEX, 'hex'));

    // Indexed with the right text, so it can be found
    const before = (await call('memory_read', { id: 'cp949-note' })).data;
    assert.equal(before.title, '한글 메모장 문서');
    assert.equal(before.summary, '똠방각하와 펩시콜라 그리고 햏 (확장 글자 포함)');
    assert.deepEqual(before.tags, ['한글', '메모']);
    const hits = await searchMemory(store, { query: '메모장', scope: 'project' });
    assert.ok(hits.results.some((r) => r.id === 'cp949-note'));

    // An index written before this decoder existed (no marker, garbled row, file untouched) is re-read once
    const tier = store.getTier('project');
    tier.db.prepare("DELETE FROM index_meta WHERE key = 'textDecoderVersion'").run();
    tier.db.prepare("UPDATE docs SET title = 'garbled', hash = 'stale' WHERE id = 'cp949-note'").run();
    assert.equal(store.sync('project').project.addedOrUpdated, 1);
    assert.equal(tier.db.prepare("SELECT title FROM docs WHERE id = 'cp949-note'").get().title, '한글 메모장 문서');
    assert.deepEqual(store.sync('project').project, { addedOrUpdated: 0, statUpdated: 0, deleted: 0 });

    const cpRes = await call('memory_update', { id: 'cp949-note', append_content: '추가 줄' });
    assert.equal(cpRes.isError, false, JSON.stringify(cpRes.data));
    const cpAfter = strictUtf8(cp949Path);
    const cpStamp = UPDATED_AT_LINE_RE.exec(cpAfter)[1];
    assert.equal(
      cpAfter,
      CP949_DOC_TEXT
        .replace('tags: [한글, 메모]\n---', `tags: [한글, 메모]\nupdated_at: ${cpStamp}\n---`)
        .replace('쌰뷁 테스트.\n', '쌰뷁 테스트.\n\n추가 줄\n'),
    );

    // --- UTF-16LE with BOM ---
    const utf16Text = '---\r\nid: utf16-note\r\ntitle: 유니코드 문서\r\nsummary: 메모장 유니코드 저장\r\nstatus: active\r\n---\r\n\r\n본문 첫 줄 ✓\r\n';
    const utf16Path = path.join(dir, 'utf16-note.md');
    fs.writeFileSync(utf16Path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf16Text, 'utf16le')]));

    assert.equal((await call('memory_read', { id: 'utf16-note' })).data.title, '유니코드 문서');
    const u16Res = await call('memory_update', { id: 'utf16-note', status: 'done' });
    assert.equal(u16Res.isError, false, JSON.stringify(u16Res.data));
    const u16After = strictUtf8(utf16Path);
    const u16Stamp = UPDATED_AT_LINE_RE.exec(u16After)[1];
    assert.equal(
      u16After,
      `---\nid: utf16-note\ntitle: 유니코드 문서\nsummary: 메모장 유니코드 저장\nstatus: done\nupdated_at: ${u16Stamp}\n---\n\n본문 첫 줄 ✓\n`,
    );

    // --- Undecodable bytes ---
    const brokenBytes = Buffer.concat([
      Buffer.from('---\nid: broken-bytes\ntitle: Broken bytes doc\nsummary: unknown encoding\nstatus: active\n---\n\nbody ', 'utf8'),
      Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x20]),
      Buffer.from(' tail\n', 'utf8'),
    ]);
    const brokenPath = path.join(dir, 'broken-bytes.md');
    fs.writeFileSync(brokenPath, brokenBytes);

    // Indexing never crashes on it and it stays findable
    assert.doesNotThrow(() => store.sync('project'));
    assert.equal((await call('memory_read', { id: 'broken-bytes' })).data.title, 'Broken bytes doc');

    const refused = await call('memory_update', { id: 'broken-bytes', status: 'done' });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.error, 'UNSAFE_UPDATE');
    assert.match(refused.data.message, /broken-bytes\.md/);
    assert.match(refused.data.message, /neither valid UTF-8 nor valid CP949/);
    assert.match(refused.data.message, /by hand/);
    assert.ok(fs.readFileSync(brokenPath).equals(brokenBytes));
    assert.throws(() => store.updateDoc({ id: 'broken-bytes', status: 'done' }), { code: 'UNSAFE_UPDATE' });

    // Superseding it is refused as a whole: nothing is rewritten and no new document appears
    const supersede = await call('memory_save', { id: 'dec-over-broken', type: 'decision', title: 'T', summary: 's', supersedes: 'broken-bytes' });
    assert.equal(supersede.data.error, 'UNSAFE_UPDATE');
    assert.ok(fs.readFileSync(brokenPath).equals(brokenBytes));
    assert.equal((await call('memory_read', { id: 'dec-over-broken' })).data.error, 'NOT_FOUND');
    const supersedeViaUpdate = await call('memory_update', { id: 'utf16-note', supersedes: 'broken-bytes' });
    assert.equal(supersedeViaUpdate.data.error, 'UNSAFE_UPDATE');
    assert.equal(strictUtf8(utf16Path), u16After);
  } finally {
    console.error = origErr;
    store.close();
    env.cleanup();
  }
});

test('memory_update on a document that starts with a horizontal rule keeps the text between the rules', async () => {
  const env = makeTempEnv('cortex-hr-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const registry = createToolRegistry(store, { promptsDir: path.join(REPO_ROOT, 'prompts') });
    const call = (name, args) => registry.callTool(name, args, {});
    const { dir } = projectDocsDir(store);

    const original = '---\nThis paragraph sits between two horizontal rules.\nIt has no key-value lines\n---\n\nReal content here.\n';

    // Parser: the block is body, not frontmatter
    const parsed = parseMarkdownDoc(original);
    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, original);
    // A real frontmatter block is still recognized
    assert.equal(parseMarkdownDoc('---\ntitle: Real\n---\n\nBody\n').frontmatter.title, 'Real');

    const hrPath = path.join(dir, 'hr-note.md');
    fs.writeFileSync(hrPath, original, 'utf8');

    const before = (await call('memory_read', { id: 'hr-note' })).data;
    assert.match(before.content, /This paragraph sits between two horizontal rules\./);

    const res = await call('memory_update', { id: 'hr-note', append_content: 'Added.' });
    assert.equal(res.isError, false, JSON.stringify(res.data));
    const after = fs.readFileSync(hrPath, 'utf8');
    const stamp = UPDATED_AT_LINE_RE.exec(after)[1];
    assert.equal(
      after,
      `---\nid: hr-note\nupdated_at: ${stamp}\n---\n\n${original}\nAdded.\n`,
    );

    // The result is stable: a further update leaves the original text where it is
    const res2 = await call('memory_update', { id: 'hr-note', status: 'done' });
    assert.equal(res2.isError, false, JSON.stringify(res2.data));
    const after2 = fs.readFileSync(hrPath, 'utf8');
    assert.ok(after2.endsWith(`---\n\n${original}\nAdded.\n`), after2);
    assert.match((await call('memory_read', { id: 'hr-note' })).data.content, /It has no key-value lines/);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('memory_update on tool-written documents changes only the requested fields (byte-for-byte as before)', () => {
  const env = makeTempEnv('cortex-roundtrip-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    const { tier } = projectDocsDir(store);
    store.saveDoc({ id: 'other-doc', type: 'knowledge', title: 'Other', summary: 'target of supersedes' });

    // Each case: update params + the same change applied to the parsed frontmatter/body the old way
    const cases = [
      { params: { status: 'done' }, fm: { status: 'done' } },
      { params: { due: '2026-12-01' }, fm: { due: '2026-12-01' } },
      { params: { session: 's2', branch: 'feature/x' }, fm: { session: 's2', branch: 'feature/x' } },
      { params: { session: '' }, fm: { session: '' } },
      { params: { files: ['src/a.mjs', 'docs/b.md'] }, fm: { files: ['src/a.mjs', 'docs/b.md'] } },
      { params: { tags: [] }, fm: { tags: [] } },
      { params: { tags: ['one', 'two, three', 'x: y'] }, fm: { tags: ['one', 'two, three', 'x: y'] } },
      { params: { derived_from: ['other-doc'] }, fm: { derived_from: ['other-doc'] } },
      { params: { title: 'New: title #1' }, fm: { title: 'New: title #1' } },
      { params: { summary: 'first line\nsecond line' }, fm: { summary: 'first line\nsecond line' } },
      { params: { type: 'decision' }, fm: { type: 'decision' } },
      { params: { supersedes: 'other-doc' }, fm: { supersedes: 'other-doc' } },
      { params: { content: 'Replaced body.\n\n- item' }, body: () => 'Replaced body.\n\n- item' },
      { params: { append_content: 'Appended paragraph.' }, body: (b) => `${b.trimEnd()}\n\nAppended paragraph.` },
      { params: {}, fm: {} },
    ];

    const variants = [
      { title: 'Plain title', summary: 'Plain summary', content: 'Body paragraph.\n\n## Section\nMore text.' },
      {
        title: 'Quoted: needs "escaping" #2',
        summary: 'Multi-line summary\nwith a second line',
        content: '본문에 한글과 [[other-doc]] 링크.\n',
        session: 'sess-1',
        branch: 'P0',
        tags: ['한글', 'needs, quoting'],
        files: ['src/core/store.mjs'],
        derived_from: ['other-doc'],
        due: '2026-11-30',
      },
    ];

    let n = 0;
    for (const variant of variants) {
      for (const testCase of cases) {
        const id = `tool-doc-${n++}`;
        const saved = store.saveDoc({ id, type: 'worklog', ...variant });
        const docPath = path.join(tier.dir, saved.path);
        const beforeText = fs.readFileSync(docPath, 'utf8');

        store.updateDoc({ id, scope: 'project', ...testCase.params });
        const afterText = fs.readFileSync(docPath, 'utf8');

        const before = parseMarkdownDoc(beforeText);
        const stamp = parseMarkdownDoc(afterText).frontmatter.updated_at;
        const expected = serializeMarkdownDoc(
          { ...before.frontmatter, ...(testCase.fm || {}), updated_at: stamp },
          testCase.body ? testCase.body(before.body) : before.body,
        );
        assert.equal(afterText, expected, `${id} ${JSON.stringify(testCase.params)}`);
        assert.notEqual(stamp, before.frontmatter.updated_at);
      }
    }
  } finally {
    store.close();
    env.cleanup();
  }
});
