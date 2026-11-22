import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPO_ROOT } from '../src/core/config.mjs';
import { CortexStore } from '../src/core/store.mjs';
import { createToolRegistry } from '../src/mcp/tools.mjs';

function makeTempEnv(prefix = 'herdr-cortex-orch-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  return {
    root,
    projectDir,
    globalDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function collectFilesRecursive(dirPath) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursive(abs));
    } else if (entry.isFile()) {
      results.push(abs);
    }
  }
  return results;
}

test('cortex_prompt loads HEAD_CORE, DEVELOPMENT_STANDARD, all 5 skills, all 8 plan-run steps, and all 3 agents without traversal leaks', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  const registry = createToolRegistry(store, {
    promptsDir: path.join(REPO_ROOT, 'prompts'),
  });

  try {
    // 1. HEAD_CORE (default & explicit)
    const coreDefault = await registry.callTool('cortex_prompt', { kind: 'core' });
    assert.equal(coreDefault.isError, false);
    assert.equal(coreDefault.data.path, 'HEAD_CORE.md');
    const coreLines = coreDefault.data.content.trim().split(/\r?\n/);
    assert.ok(coreLines.length >= 25 && coreLines.length <= 50, `HEAD_CORE.md expected ~35-45 lines, got ${coreLines.length}`);
    assert.match(coreDefault.data.content, /해상도 분리/);
    assert.match(coreDefault.data.content, /독립 검수/);
    assert.match(coreDefault.data.content, /실제 실행으로 증명/);
    assert.match(coreDefault.data.content, /supersedes/);

    const coreExplicit = await registry.callTool('cortex_prompt', { kind: 'core', name: 'HEAD_CORE' });
    assert.equal(coreExplicit.isError, false);
    assert.equal(coreExplicit.data.content, coreDefault.data.content);

    // 2. DEVELOPMENT_STANDARD (7 principles)
    const stdRes = await registry.callTool('cortex_prompt', { kind: 'standard' });
    assert.equal(stdRes.isError, false);
    assert.equal(stdRes.data.path, 'DEVELOPMENT_STANDARD.md');
    for (let i = 1; i <= 7; i++) {
      assert.match(stdRes.data.content, new RegExp(`^## ${i}\\.`, 'm'), `Missing principle ${i} in DEVELOPMENT_STANDARD.md`);
    }
    assert.match(stdRes.data.content, /Clean Evaluation/);

    // 3. All 5 unified skills
    const expectedSkills = [
      { name: 'start-job', mustMatch: [/직접 실행/, /delegate/, /independent-review/, /plan-run/, /memory_overview/, /memory_search/] },
      { name: 'product-planning', mustMatch: [/1단계: 문제 정의/, /2단계: 사용자 가치/, /3단계: 유저플로우/, /사용자 통제/] },
      { name: 'delegate', mustMatch: [/Entry Contract/, /contract_conflict/, /coder/, /developer/, /reviewer/, /cortex_prompt/] },
      { name: 'independent-review', mustMatch: [/Verified Facts/, /Blockers/, /Minor Notes/, /ACCEPT/, /NEEDS_FIX/, /P0/] },
      { name: 'plan-run', mustMatch: [/P0/, /SEED/, /PN/, /derived_from/, /memory_graph/, /01-ideation/, /08-next-direction/] },
    ];

    for (const skill of expectedSkills) {
      const res = await registry.callTool('cortex_prompt', { kind: 'skill', name: skill.name });
      assert.equal(res.isError, false, `Failed loading skill "${skill.name}": ${JSON.stringify(res)}`);
      assert.equal(res.data.path, `skills/${skill.name}/SKILL.md`);
      for (const pattern of skill.mustMatch) {
        assert.match(res.data.content, pattern, `Skill "${skill.name}" missing expected pattern ${pattern}`);
      }
    }

    // 4. All 8 plan-run step files (01..08)
    const planSteps = [
      'plan-run/steps/01-ideation',
      'plan-run/steps/02-execution-planning',
      'plan-run/steps/03-minimum-plan-review',
      'plan-run/steps/04-plan-acceptance',
      'plan-run/steps/05-execution',
      'plan-run/steps/06-result-review',
      'plan-run/steps/07-progress-review',
      'plan-run/steps/08-next-direction',
    ];

    for (const stepName of planSteps) {
      const res = await registry.callTool('cortex_prompt', { kind: 'skill', name: stepName });
      assert.equal(res.isError, false, `Failed loading step "${stepName}": ${JSON.stringify(res)}`);
      assert.equal(res.data.path, `skills/${stepName}.md`);
      assert.match(res.data.content, /## Trigger/);
      assert.match(res.data.content, /## Inputs/);
      assert.match(res.data.content, /## Execution/);
      assert.match(res.data.content, /## Output/);
      assert.match(res.data.content, /## Next Step/);
      const stepLines = res.data.content.trim().split(/\r?\n/);
      assert.ok(stepLines.length >= 20 && stepLines.length <= 55, `Step "${stepName}" expected compact ~25-45 lines, got ${stepLines.length}`);
    }

    // 5. All 3 worker agents
    const expectedAgents = [
      { name: 'coder', mustMatch: [/contract_conflict/, /프리플라이트/] },
      { name: 'developer', mustMatch: [/DEVELOPMENT_STANDARD/, /contract_conflict/, /실제 실행으로 증명/] },
      { name: 'reviewer', mustMatch: [/수정 권한 0/, /Verified Facts/, /Open Facts/, /ACCEPT \(Clean Evaluation\)/] },
    ];

    for (const agent of expectedAgents) {
      const res = await registry.callTool('cortex_prompt', { kind: 'agent', name: agent.name });
      assert.equal(res.isError, false, `Failed loading agent "${agent.name}": ${JSON.stringify(res)}`);
      assert.equal(res.data.path, `agents/${agent.name}.md`);
      for (const pattern of agent.mustMatch) {
        assert.match(res.data.content, pattern, `Agent "${agent.name}" missing expected pattern ${pattern}`);
      }
    }

    // 6. Subagent can still read prompts via cortex_prompt
    const subRead = await registry.callTool(
      'cortex_prompt',
      { kind: 'agent', name: 'reviewer' },
      { agent_id: 'review-subagent-1' },
    );
    assert.equal(subRead.isError, false);

    // 7. Path traversal & invalid inputs are blocked cleanly
    const traversalCases = [
      { kind: 'skill', name: '../../package.json' },
      { kind: 'agent', name: '..\\..\\package.json' },
      { kind: 'standard', name: '../README.md' },
      { kind: 'core', name: 'HEAD_CORE\0.md' },
      { kind: 'unknown', name: 'HEAD_CORE' },
      { kind: 'skill', name: 'nonexistent-skill' },
    ];

    for (const bad of traversalCases) {
      const res = await registry.callTool('cortex_prompt', bad);
      assert.equal(res.isError, true, `Expected error for ${JSON.stringify(bad)}`);
    }
  } finally {
    store.close();
    env.cleanup();
  }
});

test('plan-run baseline lineage E2E: P0 -> PLAN -> PN -> RESULT traced bidirectionally via memory_graph', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  const registry = createToolRegistry(store, {
    promptsDir: path.join(REPO_ROOT, 'prompts'),
  });

  try {
    // Subagent cannot write canonical baseline docs
    const denied = await registry.callTool(
      'memory_save',
      {
        id: 'base-subagent-denied',
        type: 'baseline',
        title: '서브에이전트 무단 저장 시도',
        summary: '차단되어야 한다',
      },
      { agent_id: 'worker-01' },
    );
    assert.equal(denied.isError, true);
    assert.equal(denied.errorCode, 'SUBAGENT_WRITE_DENIED');

    // HEAD saves P0 -> PLAN -> PN -> RESULT
    const p0 = await registry.callTool('memory_save', {
      id: 'base-p0-orchestration',
      type: 'baseline',
      session: 'plan-run-e2e',
      branch: 'P0',
      title: 'P0 최초 목적 기준선',
      summary: '호스트 중립 8단계 plan-run 파이프라인 구축',
      content: '원래 사용자 목적 및 확정 제약.',
      tags: ['plan-run', 'P0'],
    });
    assert.equal(p0.isError, false);

    const plan = await registry.callTool('memory_save', {
      id: 'base-plan-cycle1',
      type: 'baseline',
      session: 'plan-run-e2e',
      branch: 'PLAN',
      derived_from: ['base-p0-orchestration'],
      title: 'PLAN 1사이클 실행 규격',
      summary: '핵심 단계 및 검증 범위 정의',
      content: '[[base-p0-orchestration]] 기반 실행 규격.',
      files: ['prompts/HEAD_CORE.md'],
    });
    assert.equal(plan.isError, false);

    const pn = await registry.callTool('memory_save', {
      id: 'base-pn-cycle1',
      type: 'baseline',
      session: 'plan-run-e2e',
      branch: 'PN',
      derived_from: ['base-p0-orchestration', 'base-plan-cycle1'],
      title: 'PN 독립 수용 완료 기준선',
      summary: '03 최소성 검수 및 04 독립 수용 완료',
      content: '수용 완료된 1사이클 실행 기준선.',
      files: ['prompts/HEAD_CORE.md', 'prompts/DEVELOPMENT_STANDARD.md'],
    });
    assert.equal(pn.isError, false);

    const result = await registry.callTool('memory_save', {
      id: 'base-result-r1',
      type: 'baseline',
      session: 'plan-run-e2e',
      branch: 'Rn',
      derived_from: ['base-pn-cycle1'],
      title: 'R1 실행 결과 및 실측 근거',
      summary: '구현 및 대표 경로 실행 검증 통과',
      content: '실제 실행 검증 통과 기록.',
      files: ['prompts/HEAD_CORE.md', 'prompts/DEVELOPMENT_STANDARD.md'],
    });
    assert.equal(result.isError, false);

    // Trace upstream (out) from RESULT -> PN (hop 1) -> P0 & PLAN (hop 2)
    const upstream = await registry.callTool('memory_graph', {
      target: 'base-result-r1',
      scope: 'project',
      depth: 3,
      direction: 'out',
    });
    assert.equal(upstream.isError, false);
    const upIds = upstream.data.nodes.map((n) => n.id);
    assert.ok(upIds.includes('base-pn-cycle1'));
    assert.ok(upIds.includes('base-plan-cycle1'));
    assert.ok(upIds.includes('base-p0-orchestration'));
    assert.equal(upstream.data.nodes.find((n) => n.id === 'base-pn-cycle1').hop, 1);
    assert.equal(upstream.data.nodes.find((n) => n.id === 'base-p0-orchestration').hop, 2);
    assert.ok(
      upstream.data.edges.some(
        (e) => e.src === 'base-result-r1' && e.dst === 'base-pn-cycle1' && e.kind === 'derived_from',
      ),
    );
    assert.ok(
      upstream.data.edges.some(
        (e) => e.src === 'base-pn-cycle1' && e.dst === 'base-plan-cycle1' && e.kind === 'derived_from',
      ),
    );
    assert.ok(
      upstream.data.edges.some(
        (e) => e.src === 'base-pn-cycle1' && e.dst === 'base-p0-orchestration' && e.kind === 'derived_from',
      ),
    );

    // Trace downstream (in) from P0 -> PLAN & PN (hop 1) -> RESULT (hop 2)
    const downstream = await registry.callTool('memory_graph', {
      target: 'base-p0-orchestration',
      scope: 'project',
      depth: 3,
      direction: 'in',
    });
    assert.equal(downstream.isError, false);
    const downIds = downstream.data.nodes.map((n) => n.id);
    assert.ok(downIds.includes('base-plan-cycle1'));
    assert.ok(downIds.includes('base-pn-cycle1'));
    assert.ok(downIds.includes('base-result-r1'));
    assert.equal(downstream.data.nodes.find((n) => n.id === 'base-result-r1').hop, 2);

    // Trace bidirectional (both) from PN reaches both ancestors (P0, PLAN) and descendant (RESULT)
    const both = await registry.callTool('memory_graph', {
      target: 'base-pn-cycle1',
      scope: 'project',
      depth: 2,
      direction: 'both',
    });
    assert.equal(both.isError, false);
    const bothIds = both.data.nodes.map((n) => n.id);
    assert.ok(bothIds.includes('base-p0-orchestration'));
    assert.ok(bothIds.includes('base-plan-cycle1'));
    assert.ok(bothIds.includes('base-result-r1'));
  } finally {
    store.close();
    env.cleanup();
  }
});

test('repository purity: prompts/ and src/core/ contain zero hardcoded personal paths, legacy hacks, or private product leaks', () => {
  const scanDirs = [
    path.join(REPO_ROOT, 'prompts'),
    path.join(REPO_ROOT, 'src', 'core'),
  ];

  const files = scanDirs.flatMap((dir) => collectFilesRecursive(dir));
  assert.ok(files.length >= 20, `Expected at least 20 files across prompts/ and src/core/, found ${files.length}`);

  const currentUser = (() => {
    try {
      const u = os.userInfo().username;
      return u && u.length >= 3 ? u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    } catch {
      return '';
    }
  })();

  const forbiddenPatterns = [
    { label: 'POSIX /Users/ path', re: /\/Users\/[A-Za-z0-9._-]+/ },
    { label: 'POSIX /home/ path', re: /\/home\/[A-Za-z0-9._-]+/ },
    { label: 'Windows C:\\Users\\ path', re: /C:[\\/]Users[\\/]/i },
    { label: 'Hardcoded workspace path', re: /G:[\\/]herdr-custom-app/i },
    { label: 'Legacy claude -p --resume recursion hack', re: /claude\s+-p\b[^\n]*--resume/i },
    { label: 'Legacy head-agent-core product leak', re: /head-agent-core/i },
    ...(currentUser ? [{ label: 'Current OS username leak', re: new RegExp(`\\b${currentUser}\\b`, 'i') }] : []),
  ];

  const violations = [];
  for (const absFile of files) {
    const relFile = path.relative(REPO_ROOT, absFile).replace(/\\/g, '/');
    const text = fs.readFileSync(absFile, 'utf8');
    for (const { label, re } of forbiddenPatterns) {
      const match = text.match(re);
      if (match) {
        violations.push(`${relFile}: matched [${label}] -> "${match[0]}"`);
      }
    }
  }

  assert.deepEqual(violations, [], `Purity violations detected:\n${violations.join('\n')}`);
});
