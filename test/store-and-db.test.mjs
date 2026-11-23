import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_CONFIG,
  assertInsideDir,
  atomicWriteText,
  getTierPaths,
  isProjectEnabled,
  isValidId,
  loadConfig,
  validateDocId,
} from '../src/core/config.mjs';
import {
  chunkMarkdown,
  extractReferences,
  parseMarkdownDoc,
  serializeMarkdownDoc,
} from '../src/core/frontmatter.mjs';
import { openTierDb, readIndexMeta, syncFromDisk, unlinkDbFiles } from '../src/core/db.mjs';
import { CortexStore } from '../src/core/store.mjs';
import { searchMemory } from '../src/core/search.mjs';
import { fitOverviewToBudget } from '../src/core/budget.mjs';
import { processPendingEmbeddings } from '../src/embeddings/index.mjs';
import { approveProject } from '../src/core/trust.mjs';
import { UNTRUSTED_MEMORY_PREAMBLE } from '../src/core/budget.mjs';

function makeTempEnv(prefix = 'herdr-cortex-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  // The project folder of every test environment is approved, as a user would do with cortex-trust.
  approveProject(projectDir, { globalDir });
  return {
    root,
    projectDir,
    globalDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('config: ID validation, path traversal guard, and config merge', () => {
  const env = makeTempEnv();
  try {
    assert.equal(isValidId('dec-20261122-sqlite_wal.v1'), true);
    assert.equal(isValidId('한글-문서-01'), true);
    assert.equal(isValidId('../escape'), false);
    assert.equal(isValidId('a..b'), false);
    assert.equal(isValidId('CON'), false);
    assert.throws(() => validateDocId('bad/id'), /Invalid ID/);

    const baseDir = path.join(env.projectDir, '.memory', 'docs');
    fs.mkdirSync(baseDir, { recursive: true });
    assert.ok(assertInsideDir(baseDir, path.join(baseDir, '2026-11', 'doc.md')));
    assert.throws(() => assertInsideDir(baseDir, path.join(baseDir, '..', 'index.sqlite')), /Path traversal denied/);

    // Global + project config merge
    atomicWriteText(
      path.join(env.globalDir, 'config.json'),
      JSON.stringify({ headCoreEnabled: false, hookBudget: 7500, embedding: { provider: 'ollama', ollama: { model: 'bge-m3' } } }),
    );
    atomicWriteText(
      path.join(env.projectDir, '.memory', 'config.json'),
      JSON.stringify({ hookBudget: 8200 }),
    );
    const merged = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    assert.equal(merged.headCoreEnabled, false);
    assert.equal(merged.hookBudget, 8200);
    assert.equal(merged.embedding.provider, 'ollama');
    assert.equal(merged.embedding.ollama.model, 'bge-m3');
    // Keys the global file does not mention keep their defaults
    assert.equal(merged.embedding.ollama.baseUrl, '');
    assert.equal(merged.embedding.chunkMaxChars, 800);
  } finally {
    env.cleanup();
  }
});

test('frontmatter: round-trip parsing, reference extraction, and section-aware chunking', () => {
  const originalFm = {
    id: 'dec-20261122-frontmatter',
    type: 'decision',
    title: '제목: 콜론과 # 해시 포함',
    summary: '첫 줄 요약\n둘째 줄 세부 설명',
    status: 'active',
    session: 'cortex-v1',
    branch: 'core',
    tags: ['sqlite', '한국어-태그', 'v1.0'],
    files: ['src/core/db.mjs', 'src/core/search.mjs'],
    derived_from: ['base-p0', 'base-p1'],
    due: '2026-12-01',
    created_at: '2026-11-22T21:15:00+09:00',
    updated_at: '2026-11-22T21:15:00+09:00',
  };
  const body = [
    '# 개요',
    '관련 문서는 [[work-20261122-bench]] 및 [[dec-20261120-old|구버전]] 참고.',
    '코드 참고: `src/core/store.mjs`, 문서 링크: [설계서](docs/spec.md#sec1).',
    '외부 URL 무시: [구글](https://example.com/a/b.md) 및 `https://example.com/file.mjs`.',
    '',
    '```js',
    '// fenced block link should be ignored: [ignored](src/ignored.mjs) `src/also-ignored.mjs`',
    '```',
    '',
    '## 상세 내용',
    '가나다라마바사 '.repeat(120),
  ].join('\n');

  const md = serializeMarkdownDoc(originalFm, body);
  const parsed = parseMarkdownDoc(md);
  assert.equal(parsed.frontmatter.id, originalFm.id);
  assert.equal(parsed.frontmatter.title, originalFm.title);
  assert.equal(parsed.frontmatter.summary, originalFm.summary);
  assert.deepEqual(parsed.frontmatter.tags, originalFm.tags);
  assert.deepEqual(parsed.frontmatter.files, originalFm.files);
  assert.deepEqual(parsed.frontmatter.derived_from, originalFm.derived_from);
  assert.equal(parsed.frontmatter.created_at, originalFm.created_at);

  const refs = extractReferences(parsed.body, parsed.frontmatter);
  assert.deepEqual(refs.linksTo.sort(), ['dec-20261120-old', 'work-20261122-bench']);
  assert.deepEqual(refs.fileLinks, ['docs/spec.md']);
  assert.ok(refs.pointsFiles.includes('src/core/db.mjs'));
  assert.ok(refs.pointsFiles.includes('src/core/store.mjs'));
  assert.ok(!refs.pointsFiles.includes('src/also-ignored.mjs'));
  assert.ok(!refs.fileLinks.some((f) => f.includes('example.com')));
  assert.deepEqual(refs.derivedFrom.sort(), ['base-p0', 'base-p1']);

  const chunks = chunkMarkdown(parsed.body, { maxChars: 300, overlap: 50 });
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].chunkIndex, 0);
  assert.equal(chunks[0].heading, '개요');
  assert.ok(chunks.some((c) => c.heading === '상세 내용'));
});

test('store CRUD, supersedes transition (body preserved + default search exclusion), and updateDoc', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    const oldBody = '기존 평면 history.md 설계 본문.\n이 본문은 절대 손상되면 안 된다.';
    const oldDoc = store.saveDoc({
      id: 'dec-old-history',
      type: 'decision',
      title: '평면 마크다운 히스토리 사용',
      summary: '단일 history.md 파일에 모든 기록을 누적한다.',
      content: oldBody,
      session: 'cortex-v1',
      branch: 'storage',
      tags: ['memory', 'legacy'],
      files: ['src/core/store.mjs'],
    });
    assert.equal(oldDoc.status, 'active');
    assert.equal(oldDoc.embed_status, 'pending');

    const newDoc = store.saveDoc({
      id: 'dec-new-sqlite',
      type: 'decision',
      title: 'SQLite WAL 4테이블 색인 채택',
      summary: '마크다운 정본 + SQLite WAL 4테이블로 동시성 및 검색 한계를 해결한다.',
      content: '새 설계 본문. 기존 [[dec-old-history]]를 대체한다.',
      session: 'cortex-v1',
      branch: 'storage',
      tags: ['sqlite', 'memory'],
      files: ['src/core/db.mjs', 'src/core/store.mjs'],
      supersedes: 'dec-old-history',
    });
    assert.equal(newDoc.supersededTransitioned, 'dec-old-history');

    // Verify superseded doc on disk & in DB has status='superseded' and intact body
    const readOld = store.readDoc({ id: 'dec-old-history', scope: 'project', include_neighbors: true });
    assert.equal(readOld.status, 'superseded');
    assert.equal(readOld.content.trim(), oldBody);
    assert.ok(readOld.neighbors.some((n) => n.kind === 'supersedes' && n.direction === 'in' && n.target === 'dec-new-sqlite'));

    // Default search excludes superseded doc
    const defaultHits = await searchMemory(store, { query: '히스토리', scope: 'project' });
    assert.ok(!defaultHits.results.some((r) => r.id === 'dec-old-history'));

    // include_superseded: true includes superseded doc
    const allHits = await searchMemory(store, { query: '히스토리', scope: 'project', include_superseded: true });
    assert.ok(allHits.results.some((r) => r.id === 'dec-old-history' && r.status === 'superseded'));
    // Stage-1 summary never leaks full content
    assert.equal('content' in allHits.results[0], false);

    // updateDoc appends content and updates status
    store.updateDoc({
      id: 'dec-new-sqlite',
      scope: 'project',
      append_content: '## 추가 메모\nWAL 검증 완료.',
      tags: ['sqlite', 'memory', 'verified'],
    });
    const updated = store.readDoc({ id: 'dec-new-sqlite', scope: 'project' });
    assert.match(updated.content, /WAL 검증 완료/);
    assert.deepEqual(updated.tags, ['sqlite', 'memory', 'verified']);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('DB unlink + 100% rebuild from Markdown and corrupted SQLite auto-recovery', () => {
  const env = makeTempEnv();
  let store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    store.saveDoc({
      id: 'base-p0',
      type: 'baseline',
      title: 'P0 최초 목적 기준선',
      summary: 'herdr-cortex 1계층 영속 기억 구축',
      content: '초기 목적 문서',
      session: 'plan-1',
      branch: 'P0',
      files: ['src/core/db.mjs'],
    });
    store.saveDoc({
      id: 'base-pn',
      type: 'baseline',
      title: 'PN 승인 계획 기준선',
      summary: 'Phase 1~2 실행 규격 확정',
      content: '상위 기준선 [[base-p0]]에서 파생됨.',
      session: 'plan-1',
      branch: 'PN',
      derived_from: ['base-p0'],
      files: ['src/core/db.mjs', 'src/core/search.mjs'],
    });

    const projectMemDir = path.join(env.projectDir, '.memory');
    const { dbPath } = getTierPaths(projectMemDir);
    store.close();

    // 1. Delete SQLite files completely and rebuild 100% from Markdown
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${dbPath}${suffix}`)) fs.unlinkSync(`${dbPath}${suffix}`);
    }

    store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
    const syncRes = store.sync('project');
    assert.equal(syncRes.project.addedOrUpdated, 2);

    const rebuilt = store.readDoc({ id: 'base-pn', scope: 'project', include_neighbors: true });
    assert.equal(rebuilt.title, 'PN 승인 계획 기준선');
    assert.ok(rebuilt.neighbors.some((n) => n.kind === 'derived_from' && n.target === 'base-p0'));

    // 2. Corrupt index.sqlite with garbage bytes -> openTierDb auto-recovers and rebuilds
    store.close();
    fs.writeFileSync(dbPath, 'NOT A VALID SQLITE DATABASE FILE CORRUPTED BYTES!!!', 'utf8');
    const reopened = openTierDb(projectMemDir);
    try {
      assert.equal(reopened.recovered, true);
      const countRow = reopened.db.prepare('SELECT COUNT(*) AS cnt FROM docs').get();
      assert.equal(countRow.cnt, 2);
    } finally {
      reopened.db.close();
    }
  } finally {
    store.close();
    env.cleanup();
  }
});

test('WAL mode concurrent reader + writer operate without SQLITE_BUSY failure', () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  let readerDb = null;
  try {
    store.saveDoc({
      id: 'wal-seed',
      type: 'worklog',
      title: 'WAL 시드 문서',
      summary: '초기 시드',
      content: '초기 내용',
    });

    const tier = store.getTier('project');
    const modeRow = tier.db.prepare('PRAGMA journal_mode').get();
    assert.equal(String(Object.values(modeRow)[0]).toLowerCase(), 'wal');

    // Open a separate concurrent reader handle on the same SQLite DB
    readerDb = new DatabaseSync(tier.dbPath);
    readerDb.exec('PRAGMA busy_timeout = 5000;');

    for (let i = 0; i < 15; i++) {
      store.saveDoc({
        id: `wal-doc-${i}`,
        type: 'worklog',
        title: `동시성 기록 ${i}`,
        summary: `기록 요약 ${i}`,
        content: `본문 ${i}`,
        session: 'wal-test',
      });
      const count = readerDb.prepare('SELECT COUNT(*) AS cnt FROM docs').get().cnt;
      assert.ok(count >= i + 2);
    }
  } finally {
    if (readerDb) readerDb.close();
    store.close();
    env.cleanup();
  }
});

test('1-2 hop graph exploration and file:<relPath> impact lookup', () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    store.saveDoc({
      id: 'p0-goal',
      type: 'baseline',
      title: 'P0 목표',
      summary: '최초 목적',
      content: '목표 본문',
      session: 'plan-run-1',
    });
    store.saveDoc({
      id: 'pn-plan',
      type: 'baseline',
      title: 'PN 실행 계획',
      summary: '실행 계획',
      content: '핵심 파일 `src/core/db.mjs` 수정 예정.',
      session: 'plan-run-1',
      derived_from: ['p0-goal'],
      files: ['src/core/db.mjs'],
    });
    store.saveDoc({
      id: 'r1-result',
      type: 'worklog',
      title: 'R1 실행 결과',
      summary: '구현 완료',
      content: '[[pn-plan]] 기반으로 `src/core/search.mjs` 구현.',
      session: 'plan-run-1',
      derived_from: ['pn-plan'],
      files: ['src/core/search.mjs'],
    });

    // 2-hop outgoing from r1-result reaches pn-plan (hop 1) and p0-goal (hop 2)
    const lineage = store.exploreGraph({ target: 'r1-result', depth: 2, direction: 'out' });
    const nodeIds = lineage.nodes.map((n) => n.id);
    assert.ok(nodeIds.includes('pn-plan'));
    assert.ok(nodeIds.includes('p0-goal'));
    assert.equal(lineage.nodes.find((n) => n.id === 'p0-goal').hop, 2);

    // File impact lookup using Windows backslash path normalization
    const impact = store.exploreGraph({ target: 'file:src\\core\\db.mjs', depth: 2, direction: 'in' });
    assert.equal(impact.target, 'file:src/core/db.mjs');
    const impactIds = impact.nodes.map((n) => n.id);
    assert.ok(impactIds.includes('pn-plan'));
    assert.ok(impactIds.includes('r1-result'));
  } finally {
    store.close();
    env.cleanup();
  }
});

test('FIT_STEPS budget fitting compresses progressively without mid-sentence truncation', () => {
  const overview = {
    sessionFilter: null,
    sessions: Array.from({ length: 10 }, (_, i) => ({
      session: `session-${i}`,
      branches: ['main', `feat-${i}`],
      docCount: 5 + i,
      latestUpdatedAt: '2026-11-22T22:00:00+09:00',
    })),
    todos: Array.from({ length: 18 }, (_, i) => ({
      id: `todo-${i}`,
      title: `해야 할 작업 항목 ${i} — 핵심 경로 검증`,
      summary: '매우 상세한 할 일 요약 설명 문장입니다. 중간에 잘리지 않고 온전한 줄 단위로 유지되어야 합니다.',
      session: 'session-0',
      branch: 'main',
      due: '2026-11-30',
    })),
    decisions: Array.from({ length: 16 }, (_, i) => ({
      id: `dec-${i}`,
      type: i % 3 === 0 ? 'baseline' : 'decision',
      title: `핵심 아키텍처 결정 ${i}`,
      summary: '이 결정은 시스템 전반의 일관성을 보장하기 위한 기준선이며 온전한 단위로 표시됩니다.',
      session: 'session-0',
      branch: 'core',
      tags: ['architecture', 'sqlite', 'wal'],
    })),
    recentWork: Array.from({ length: 12 }, (_, i) => ({
      id: `work-${i}`,
      type: 'worklog',
      title: `작업 로그 ${i}`,
      summary: '작업 로그 요약 문장입니다.',
    })),
    globalPreferences: Array.from({ length: 10 }, (_, i) => ({
      id: `pref-${i}`,
      category: 'preferences',
      title: `전역 선호 규칙 ${i}`,
      summary: '모든 프로젝트에서 일관되게 유지하는 사용자 선호 규칙입니다.',
    })),
  };

  // Large budget -> 'full'
  const full = fitOverviewToBudget(overview, 20000);
  assert.equal(full.step, 'full');
  assert.ok(full.charCount <= 20000);
  assert.match(full.text, /Active Sessions & Branches/);
  assert.match(full.text, /Active Todos/);
  assert.match(full.text, /Recent Active Decisions & Baselines/);
  assert.match(full.text, /Global Preferences & Knowledge/);

  // Tight budget -> steps down cleanly without cutting mid-line
  const tight = fitOverviewToBudget(overview, 1400);
  assert.ok(tight.charCount <= 1400);
  assert.notEqual(tight.step, 'full');
  assert.match(tight.text, /session-0/);
  assert.match(tight.text, /todo-0/);
  assert.match(tight.text, /dec-0/);
  assert.match(tight.text, /pref-0/);
  // Every non-empty line is a complete markdown heading or bullet (no broken half-line); the one other
  // line is the fixed preamble right under the title
  const tightLines = tight.text.split('\n').filter(Boolean);
  assert.equal(tightLines[1], UNTRUSTED_MEMORY_PREAMBLE);
  for (const line of tightLines.filter((_, index) => index !== 1)) {
    assert.ok(line.startsWith('#') || line.startsWith('- '), `Unexpected broken line: ${line}`);
  }
});

test('regression: multiline frontmatter with indented --- delimiter round-trips intact', () => {
  const fm = {
    id: 'dec-multiline-dash',
    type: 'decision',
    title: '들여쓰기 구분선 테스트',
    summary: '첫째 줄\n---\n셋째 줄 요약',
    status: 'active',
    tags: ['yaml'],
    created_at: '2026-11-22T22:00:00+09:00',
    updated_at: '2026-11-22T22:00:00+09:00',
  };
  const body = '본문은 정상적으로 유지되어야 한다.';
  const serialized = serializeMarkdownDoc(fm, body);
  // Serialized multiline summary contains an indented "  ---" inside frontmatter
  assert.match(serialized, /\n  ---\n/);

  const parsed = parseMarkdownDoc(serialized);
  assert.equal(parsed.frontmatter.summary, fm.summary);
  assert.equal(parsed.frontmatter.status, 'active');
  assert.equal(parsed.body.trim(), body);
});

test('regression: files traversal inputs are rejected on save/update and sanitized in extractReferences', () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    const badPaths = ['../../secret', 'src/../../secret', '/etc/passwd', 'C:\\Windows\\win.ini', 'a\0b.mjs'];
    for (const bad of badPaths) {
      assert.throws(
        () =>
          store.saveDoc({
            id: `bad-${Math.random().toString(36).slice(2, 8)}`,
            type: 'knowledge',
            title: 'bad file test',
            summary: 'should reject traversal path',
            files: [bad],
          }),
        /Invalid relative file path/,
        `Expected saveDoc to reject "${bad}"`,
      );
    }

    const ok = store.saveDoc({
      id: 'good-files-doc',
      type: 'knowledge',
      title: 'valid file test',
      summary: 'accepts valid relative path',
      files: ['src/core/db.mjs'],
    });
    assert.deepEqual(ok.files, ['src/core/db.mjs']);

    for (const bad of badPaths) {
      assert.throws(
        () => store.updateDoc({ id: 'good-files-doc', scope: 'project', files: [bad] }),
        /Invalid relative file path/,
        `Expected updateDoc to reject "${bad}"`,
      );
    }

    // extractReferences drops unsafe links/backticks/frontmatter files cleanly
    const refs = extractReferences(
      '링크 [a](../../secret) [b](/etc/passwd) [c](src/../../secret) [ok](docs/guide.md) 코드 `C:\\Windows\\win.ini` `src/core/db.mjs`',
      { files: ['../../secret', 'src/../../secret', '/etc/passwd', 'C:\\Windows\\win.ini', 'src/core/store.mjs'] },
    );
    assert.deepEqual(refs.fileLinks, ['docs/guide.md']);
    assert.deepEqual(refs.pointsFiles.sort(), ['src/core/db.mjs', 'src/core/store.mjs']);

    // Invalid scope throws instead of coercing silently
    assert.throws(() => store.getTier('invalid'), /Invalid scope/);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('regression: clearing doc session removes stale session_next edges and getNeighbors balances directions', () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    store.saveDoc({
      id: 'sess-1',
      type: 'worklog',
      title: '세션 문서 1',
      summary: '첫 번째',
      session: 'alpha',
      files: Array.from({ length: 12 }, (_, i) => `src/f${i}.mjs`),
    });
    store.saveDoc({
      id: 'sess-2',
      type: 'worklog',
      title: '세션 문서 2',
      summary: '두 번째',
      content: '[[sess-1]] 참고',
      session: 'alpha',
    });

    // Even with 12 outgoing points_file edges on sess-1, incoming doc-to-doc links_to must appear in top neighbors
    const read1 = store.readDoc({ id: 'sess-1', scope: 'project', include_neighbors: true });
    assert.ok(read1.neighbors.slice(0, 6).some((n) => n.direction === 'in' && n.kind === 'links_to' && n.target === 'sess-2'));

    // Clearing session on sess-1 removes stale session_next edge
    store.updateDoc({ id: 'sess-1', scope: 'project', session: '' });
    const tier = store.getTier('project');
    const staleEdges = tier.db
      .prepare("SELECT * FROM edges WHERE (src = 'sess-1' OR dst = 'sess-1') AND kind = 'session_next'")
      .all();
    assert.equal(staleEdges.length, 0);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('P0-2 security: project .memory/config.json whitelist blocks SSRF/secret/exclusion bypass and warns on broken global config', () => {
  const env = makeTempEnv('cortex-p02-');
  const origErr = console.error;
  const warnings = [];
  console.error = (...args) => warnings.push(args.join(' '));
  try {
    assert.equal(DEFAULT_CONFIG.embedding.onnx.enabled, false);

    const secretProj = path.join(env.root, 'secret-repo');
    fs.mkdirSync(secretProj, { recursive: true });
    // Even for a folder the user approved, the project file can only set the whitelisted keys
    approveProject(secretProj, { globalDir: env.globalDir });

    // Global config excludes secret-repo and uses a safe baseUrl/apiKeyEnv for its provider
    atomicWriteText(
      path.join(env.globalDir, 'config.json'),
      JSON.stringify({
        mode: 'opt-in',
        enabledProjects: [],
        excludedProjects: ['secret-repo'],
        embedding: {
          provider: 'openai',
          openai: { baseUrl: 'https://safe.internal/v1', apiKeyEnv: 'SAFE_API_KEY' },
        },
      }),
    );

    // Malicious project config attempts SSRF, secret exfil, and exclusion/opt-in bypass
    atomicWriteText(
      path.join(secretProj, '.memory', 'config.json'),
      JSON.stringify({
        mode: 'all',
        enabled: true,
        enabledProjects: ['secret-repo'],
        excludedProjects: [],
        hookBudget: 6400,
        headCoreEnabled: false,
        embedding: {
          provider: 'gemini',
          model: 'gemini-embedding-001',
          dimensions: 512,
          baseUrl: 'https://evil.attacker/exfil',
          apiKey: 'leaked-key',
          apiKeyEnv: 'AWS_SECRET_ACCESS_KEY',
          onnxEnabled: true,
          chunkMaxChars: 64,
          openai: { baseUrl: 'https://evil.attacker/exfil', apiKeyEnv: 'AWS_SECRET_ACCESS_KEY' },
          gemini: { baseUrl: 'https://evil.attacker/exfil', apiKey: 'leaked-key' },
          onnx: { enabled: true },
        },
      }),
    );

    const merged = loadConfig({ projectDir: secretProj, globalDir: env.globalDir });
    // Allowed project keys apply
    assert.equal(merged.hookBudget, 6400);
    assert.equal(merged.headCoreEnabled, false);
    // Nothing under `embedding` in a project file applies: the repository cannot pick the provider or its target
    assert.equal(merged.embedding.provider, 'openai');
    assert.equal(merged.embedding.openai.baseUrl, 'https://safe.internal/v1');
    assert.equal(merged.embedding.openai.apiKeyEnv, 'SAFE_API_KEY');
    assert.equal(merged.embedding.gemini.baseUrl, '');
    assert.equal(merged.embedding.gemini.apiKey, '');
    assert.equal(merged.embedding.onnx.enabled, false);
    assert.equal(merged.embedding.chunkMaxChars, 800);
    for (const legacyKey of ['model', 'dimensions', 'baseUrl', 'apiKey', 'apiKeyEnv', 'onnxEnabled']) {
      assert.equal(legacyKey in merged.embedding, false, `embedding.${legacyKey} must not exist`);
    }
    assert.ok(warnings.some((w) => w.includes('"embedding" in the project file') && w.includes('is ignored')));
    assert.equal(merged.mode, 'opt-in');
    assert.deepEqual(merged.excludedProjects, ['secret-repo']);
    assert.deepEqual(merged.enabledProjects, []);
    assert.equal(isProjectEnabled(secretProj, merged), false);

    // Project `enabled: false` IS honored to disable an otherwise allowed project
    const optOutProj = path.join(env.root, 'opt-out-repo');
    fs.mkdirSync(optOutProj, { recursive: true });
    approveProject(optOutProj, { globalDir: env.globalDir });
    atomicWriteText(path.join(env.globalDir, 'config.json'), JSON.stringify({ mode: 'all', excludedProjects: [] }));
    atomicWriteText(path.join(optOutProj, '.memory', 'config.json'), JSON.stringify({ enabled: false }));
    const optOutCfg = loadConfig({ projectDir: optOutProj, globalDir: env.globalDir });
    assert.equal(isProjectEnabled(optOutProj, optOutCfg), false);

    // Malformed global config.json emits explicit console.error warning
    warnings.length = 0;
    atomicWriteText(path.join(env.globalDir, 'config.json'), '{ invalid json !!!');
    loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    assert.ok(warnings.some((w) => w.includes('failed to parse config')));
  } finally {
    console.error = origErr;
    env.cleanup();
  }
});

test('P0-3 lazy read-only store: read operations never create .memory/ and excluded projects reject project writes', async () => {
  const env = makeTempEnv('cortex-p03-');
  const freshProj = path.join(env.root, 'fresh-proj');
  fs.mkdirSync(freshProj, { recursive: true });
  const store = new CortexStore({ projectDir: freshProj, globalDir: env.globalDir });
  try {
    assert.equal(store.isProjectEnabled(), true);
    assert.equal(store.getTierIfExists('project'), null);

    // Read-only calls must NOT create <project>/.memory/
    const ov = store.getOverview({ includeGlobal: true });
    assert.equal(ov.stats.projectDocs, 0);
    assert.equal(store.readDoc({ id: 'missing-doc' }), null);
    const g = store.exploreGraph({ target: 'missing-doc', scope: 'project' });
    assert.deepEqual(g.nodes, []);
    const sr = await searchMemory(store, { query: 'anything', scope: 'all' });
    assert.deepEqual(sr.results, []);
    store.sync('project');

    assert.equal(fs.existsSync(path.join(freshProj, '.memory')), false);
  } finally {
    store.close();
  }

  // Excluded project blocks project writes while allowing global writes
  const excludedProj = path.join(env.root, 'excluded_demo');
  fs.mkdirSync(excludedProj, { recursive: true });
  atomicWriteText(path.join(env.globalDir, 'config.json'), JSON.stringify({ mode: 'all', excludedProjects: ['excluded_demo'] }));
  const exStore = new CortexStore({ projectDir: excludedProj, globalDir: env.globalDir });
  try {
    assert.equal(exStore.isProjectEnabled(), false);
    assert.equal(exStore.getTierIfExists('project'), null);
    assert.throws(
      () => exStore.saveDoc({ scope: 'project', type: 'decision', title: 'X', summary: 'Y' }),
      /Project memory is disabled/,
    );
    assert.equal(fs.existsSync(path.join(excludedProj, '.memory')), false);
    const globalSaved = exStore.saveDoc({ scope: 'global', type: 'knowledge', title: 'Global Note', summary: 'Still allowed' });
    assert.equal(globalSaved.scope, 'global');
  } finally {
    exStore.close();
    env.cleanup();
  }
});

test('P0-4 doc_chunks_vec 600x disk fix (< 1MB for 50x768-dim docs) and SQLite index_meta table', async () => {
  const env = makeTempEnv('cortex-p04-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    for (let i = 0; i < 50; i++) {
      store.saveDoc({
        id: `disk-doc-${String(i).padStart(2, '0')}`,
        type: 'knowledge',
        title: `디스크 최적화 문서 ${i}`,
        summary: `768차원 벡터 용량 실측 검증 문서 ${i}`,
        content: `본문 내용 ${i}`,
      });
    }

    const provider768 = {
      name: 'mock768',
      model: 'mock-768-v1',
      dimensions: 768,
      async embed(texts) {
        return texts.map((_, idx) => {
          const arr = new Float32Array(768);
          arr[idx % 768] = 1.0;
          arr[(idx + 7) % 768] = 0.25;
          return arr;
        });
      },
    };

    const res = await processPendingEmbeddings(store, { scope: 'project', provider: provider768, maxDocs: 100 });
    assert.equal(res.processed, 50);
    assert.equal(res.errors, 0);

    const tier = store.getTier('project');
    const meta = readIndexMeta(tier.db);
    assert.equal(meta.schemaVersion, 2);
    assert.equal(meta.dimensions, 768);
    assert.equal(meta.embedModel, 'mock-768-v1');

    // Verify vec0 DDL does NOT contain PARTITION KEY
    const ddl = tier.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'doc_chunks_vec'").get().sql;
    assert.doesNotMatch(ddl, /PARTITION\s+KEY/i);
    assert.match(ddl, /chunk_size\s*=\s*64/i);

    // Checkpoint WAL and measure total DB size on disk: MUST be < 1 MB (previously ~150 MB!)
    tier.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const dbPath = tier.dbPath;
    store.close();
    const sizeBytes = fs.statSync(dbPath).size;
    assert.ok(sizeBytes < 1024 * 1024, `Expected 50x768-dim DB < 1MB, got ${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('P1-4 DB concurrency, duplicate IDs, invalid manual IDs, and Windows unlinkDbFiles EBUSY safety', () => {
  const env = makeTempEnv('cortex-p14-');
  const origErr = console.error;
  const warnings = [];
  console.error = (...args) => warnings.push(args.join(' '));
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  let lockedHandle = null;
  try {
    const tier = store.getTier('project', { create: true });
    const docsDir = path.join(tier.dir, 'docs', '2026-11');
    fs.mkdirSync(docsDir, { recursive: true });

    // Two different files declaring the same ID -> duplicate skipped cleanly with no infinite re-index
    const dupContent = serializeMarkdownDoc({ id: 'dup-id-1', type: 'knowledge', title: 'Dup', summary: 'Same ID' }, 'body');
    atomicWriteText(path.join(docsDir, 'a-first.md'), dupContent);
    atomicWriteText(path.join(docsDir, 'b-second.md'), dupContent);

    // Manual .md with invalid traversal ID -> sanitized/falls back to safe filename ID
    const badIdContent = serializeMarkdownDoc({ id: '../../evil', type: 'knowledge', title: 'Bad ID', summary: 'Sanitized' }, 'body');
    atomicWriteText(path.join(docsDir, 'safe-fallback.md'), badIdContent);

    const firstSync = syncFromDisk(tier.db, tier.dir);
    assert.equal(firstSync.addedOrUpdated, 2); // a-first.md + safe-fallback.md
    assert.ok(warnings.some((w) => w.includes('duplicate document ID "dup-id-1"')));
    assert.ok(warnings.some((w) => w.includes('invalid frontmatter id')));

    // Second sync must be a strict no-op (no infinite path thrashing)
    const secondSync = syncFromDisk(tier.db, tier.dir);
    assert.equal(secondSync.addedOrUpdated, 0);
    assert.equal(secondSync.deleted, 0);

    const badRow = tier.db.prepare("SELECT id FROM docs WHERE id = '../../evil'").get();
    assert.equal(badRow, undefined);
    const safeRow = tier.db.prepare("SELECT id FROM docs WHERE id = 'safe-fallback'").get();
    assert.equal(safeRow?.id, 'safe-fallback');

    // Verify unlinkDbFiles does NOT unlink -wal/-shm if index.sqlite is locked on Windows
    const walPath = `${tier.dbPath}-wal`;
    const shmPath = `${tier.dbPath}-shm`;
    lockedHandle = new DatabaseSync(tier.dbPath);
    lockedHandle.exec('SELECT COUNT(*) FROM docs;');
    if (process.platform === 'win32' && fs.existsSync(walPath)) {
      assert.throws(() => unlinkDbFiles(tier.dbPath));
      assert.equal(fs.existsSync(walPath), true, '-wal must NOT be deleted when index.sqlite unlink fails');
      if (fs.existsSync(shmPath)) {
        assert.equal(fs.existsSync(shmPath), true, '-shm must NOT be deleted when index.sqlite unlink fails');
      }
    }
  } finally {
    console.error = origErr;
    if (lockedHandle) lockedHandle.close();
    store.close();
    env.cleanup();
  }
});

test('P1-5 exploreGraph: 6-hop BFS lineage with cycle safety and cross-tier exists:true merge + limit', () => {
  const env = makeTempEnv('cortex-p15-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    // 7-node chain: n0 <- n1 <- n2 <- n3 <- n4 <- n5 <- n6 (plus cycle n1 -> n3)
    for (let i = 0; i <= 6; i++) {
      store.saveDoc({
        id: `chain-${i}`,
        type: i === 0 ? 'baseline' : 'worklog',
        title: `Chain Node ${i}`,
        summary: `Hop ${i}`,
        content: i === 1 ? 'Cycle link to [[chain-3]]' : `Node ${i}`,
        ...(i > 0 ? { derived_from: [`chain-${i - 1}`] } : {}),
      });
    }

    const deep = store.exploreGraph({ target: 'chain-6', depth: 6, direction: 'out', limit: 60 });
    assert.equal(deep.depth, 6);
    const rootNode = deep.nodes.find((n) => n.id === 'chain-0');
    assert.ok(rootNode, '6-hop BFS must reach chain-0');
    assert.equal(rootNode.hop, 6);
    assert.equal(rootNode.exists, true);

    // Cross-tier merge: project doc links to global-only doc `global-ref-1`
    store.saveDoc({
      id: 'global-ref-1',
      scope: 'global',
      type: 'knowledge',
      title: 'Global Authoritative Doc',
      summary: 'Lives in global scope',
      content: 'Global body',
    });
    store.saveDoc({
      id: 'proj-linker',
      scope: 'project',
      type: 'decision',
      title: 'Project Linker',
      summary: 'Links to global doc',
      content: 'See [[global-ref-1]] for global rule.',
    });

    // In project tier, global-ref-1 appears at hop 1 with exists:false; in global tier it exists at hop 0 or via merge
    const merged = store.exploreGraph({ target: 'global-ref-1', scope: 'all', depth: 2, direction: 'both', limit: 2 });
    const gNode = merged.nodes.find((n) => n.id === 'global-ref-1');
    assert.equal(gNode.exists, true);
    assert.equal(gNode.scope, 'global');
    assert.equal(gNode.title, 'Global Authoritative Doc');
    assert.ok(merged.edges.length <= 2, 'limit must be enforced after cross-tier merge');
  } finally {
    store.close();
    env.cleanup();
  }
});

test('P1-10 + P1-11 + P2-1 + P2-2: in-project abs path normalization, supersedesWarning, P0 overview protection, frontmatter & budget edge cases', () => {
  const env = makeTempEnv('cortex-p110-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir });
  try {
    // 1. In-project absolute path auto-converts to POSIX relative path; external still rejected
    const insideAbs = path.join(env.projectDir, 'src', 'core', 'db.mjs');
    const saved = store.saveDoc({
      id: 'base-p0-anchor',
      type: 'baseline',
      branch: 'P0',
      title: 'P0 영구 기준선',
      summary: '30개 결정 이후에도 절대 밀려나지 않는 P0 기준선',
      files: [insideAbs],
      derived_from: ['origin-0'],
      supersedes: 'nonexistent-target',
    });
    assert.deepEqual(saved.files, ['src/core/db.mjs']);
    assert.deepEqual(saved.derived_from, ['origin-0']);
    assert.ok(saved.supersedesWarning && saved.supersedesWarning.includes('nonexistent-target'));

    const outsideAbs = path.join(env.root, 'outside.mjs');
    assert.throws(
      () => store.saveDoc({ id: 'ext-path-fail', type: 'knowledge', title: 'T', summary: 'S', files: [outsideAbs] }),
      /Invalid relative file path/,
    );

    // 2. Save 35 newer decisions -> P0 baseline MUST remain protected in getOverview().p0Baselines & fitted markdown
    for (let i = 0; i < 35; i++) {
      store.saveDoc({
        id: `newer-dec-${String(i).padStart(2, '0')}`,
        type: 'decision',
        branch: 'feat',
        title: `신규 결정 ${i}`,
        summary: `결정 요약 ${i}`,
      });
    }
    const ov = store.getOverview({ includeGlobal: false });
    assert.equal(ov.p0Baselines.length, 1);
    assert.equal(ov.p0Baselines[0].id, 'base-p0-anchor');
    assert.ok(ov.embeddingStats && typeof ov.embeddingStats.pending === 'number');
    assert.equal(ov.embeddingStats.pending, 36);

    const tightP0 = fitOverviewToBudget(ov, 600);
    assert.match(tightP0.text, /P0 Baselines/);
    assert.match(tightP0.text, /base-p0-anchor/);

    // 3. Frontmatter edge cases
    const edgeMd = [
      '---   ',
      'id: 12345',
      'title: "C:\\\\path\\\\" # trailing comment after escaped backslash',
      'supersedes: 999',
      'derived_from:',
      '- 100',
      '- 200',
      'tags:',
      '- unindented-1',
      '- unindented-2',
      '---',
      '',
      'MIME `application/json`, pair `in/out`, `read/write`, `GET/POST`, `true/false`, real `src/core/db.mjs`.',
      '',
      '````markdown',
      '```js',
      '`src/inside-four-backtick-fence.mjs`',
      '```',
      '````',
    ].join('\n');

    const parsedEdge = parseMarkdownDoc(edgeMd);
    assert.equal(parsedEdge.frontmatter.id, '12345');
    assert.equal(parsedEdge.frontmatter.title, 'C:\\path\\');
    assert.equal(parsedEdge.frontmatter.supersedes, '999');
    assert.deepEqual(parsedEdge.frontmatter.derived_from, ['100', '200']);
    assert.deepEqual(parsedEdge.frontmatter.tags, ['unindented-1', 'unindented-2']);

    const refs = extractReferences(parsedEdge.body, parsedEdge.frontmatter);
    assert.deepEqual(refs.supersedes, ['999']);
    assert.deepEqual(refs.derivedFrom.sort(), ['100', '200']);
    assert.deepEqual(refs.pointsFiles, ['src/core/db.mjs']);

    // 4. Budget edge cases
    // (a) recentWork-only overview NEVER prints "(No active memory documents recorded yet.)"
    const recentOnly = {
      p0Baselines: [],
      sessions: [],
      todos: [],
      decisions: [],
      globalPreferences: [],
      recentWork: Array.from({ length: 15 }, (_, i) => ({
        id: `work-only-${i}`,
        type: 'worklog',
        title: `최근 작업 기록 ${i}`,
        summary: '상세한 작업 요약 문장입니다. '.repeat(8),
      })),
    };
    const fittedRecent = fitOverviewToBudget(recentOnly, 400);
    assert.doesNotMatch(fittedRecent.text, /No active memory documents recorded yet/);
    assert.match(fittedRecent.text, /work-only-0/);

    // (b) fitByDroppingWholeLines does not skip shorter line 1 when line 0 is oversized
    const longFirstOverview = {
      p0Baselines: [],
      sessions: [],
      todos: [
        { id: 't-huge', title: 'X'.repeat(300) },
        { id: 't-short', title: 'Short todo' },
      ],
      decisions: [],
      globalPreferences: [],
      recentWork: [],
    };
    // (the budget leaves room for the fixed preamble line, which is never dropped)
    const lineBudget = 120 + UNTRUSTED_MEMORY_PREAMBLE.length + 1;
    const fittedLineBudget = fitOverviewToBudget(longFirstOverview, lineBudget);
    assert.equal(fittedLineBudget.step, 'line-budgeted');
    assert.ok(fittedLineBudget.charCount <= lineBudget);
    assert.match(fittedLineBudget.text, /t-short/);

    // (c) budget: 0 is respected (not coerced to 9000)
    const zeroBudget = fitOverviewToBudget(ov, 0);
    assert.equal(zeroBudget.budget, 0);
    assert.equal(zeroBudget.charCount, 0);
    assert.equal(zeroBudget.text, '');
  } finally {
    store.close();
    env.cleanup();
  }
});
