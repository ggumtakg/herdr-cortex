import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPO_ROOT } from '../src/core/config.mjs';
import { CortexStore } from '../src/core/store.mjs';
import { createToolRegistry, listPromptAssets } from '../src/mcp/tools.mjs';
import { approveAsUser } from './support/approve.mjs';

function makeTempEnv(prefix = 'herdr-cortex-orch-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  // The project folder of every test environment is approved, as a user would do with cortex-trust.
  approveAsUser(projectDir, { globalDir });
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
    assert.ok(coreLines.length >= 25 && coreLines.length <= 40, `HEAD_CORE.md expected ~28-36 lines, got ${coreLines.length}`);
    assert.match(coreDefault.data.content, /해상도 분리/);
    assert.match(coreDefault.data.content, /시야 협소화 예방/);
    assert.match(coreDefault.data.content, /Open Facts/);
    assert.match(coreDefault.data.content, /독립 검수/);
    assert.match(coreDefault.data.content, /실제 실행으로 증명/);
    assert.match(coreDefault.data.content, /Canon Protection/);
    assert.match(coreDefault.data.content, /supersedes/);
    assert.match(coreDefault.data.content, /cortex_prompt/);
    // Deduplicated from SERVER_INSTRUCTIONS: no redundant tool-by-tool relay/skill catalog in HEAD_CORE
    assert.doesNotMatch(coreDefault.data.content, /relay_tabs/);
    assert.doesNotMatch(coreDefault.data.content, /kind: "skill"/);

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
      { name: 'start-job', mustMatch: [/직접 실행/, /delegate/, /independent-review/, /plan-run/, /memory_overview/, /memory_search/, /프로젝트 상대 경로/, /category: "preferences"/] },
      { name: 'product-planning', mustMatch: [/1단계: 문제 정의/, /2단계: 사용자 가치/, /3단계: 유저플로우/, /사용자 통제/] },
      { name: 'delegate', mustMatch: [/Entry Contract/, /contract_conflict/, /coder/, /developer/, /reviewer/, /cortex_prompt/, /프로젝트 상대 경로/, /category: "preferences"/] },
      { name: 'independent-review', mustMatch: [/Verified Facts/, /Open Facts/, /Blockers/, /Minor Notes/, /Verdict/, /ACCEPT/, /NEEDS_FIX/, /P0/] },
      { name: 'plan-run', mustMatch: [/P0/, /C\{k\}-IDEATION/, /C\{k\}-PLAN/, /C\{k\}-PN/, /C\{k\}-R\{k\}/, /C\{k\}-SEED/, /C1-PLAN/, /derived_from/, /memory_graph/, /depth: 8/, /attempt: N\/2/, /01-ideation/, /08-next-direction/] },
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

test('cortex_prompt lists available assets, exposes names in tool description, and appends Available on missing skill/agent', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  const registry = createToolRegistry(store, {
    promptsDir: path.join(REPO_ROOT, 'prompts'),
  });

  try {
    // 1. No arguments returns full asset list in order with non-empty descriptions
    const allRes = await registry.callTool('cortex_prompt', {});
    assert.equal(allRes.isError, false);
    assert.equal(allRes.data.kind, '');
    assert.equal(allRes.data.name, '');
    assert.equal(
      allRes.data.usage,
      'Load one with cortex_prompt(kind, name). plan-run steps: kind "skill", name "plan-run/steps/<file name without .md>".',
    );
    assert.deepEqual(
      allRes.data.assets.map((a) => `${a.kind}:${a.name}`),
      [
        'skill:delegate',
        'skill:independent-review',
        'skill:plan-run',
        'skill:product-planning',
        'skill:start-job',
        'agent:coder',
        'agent:developer',
        'agent:reviewer',
        'standard:DEVELOPMENT_STANDARD',
        'core:HEAD_CORE',
      ],
    );
    for (const asset of allRes.data.assets) {
      assert.equal(typeof asset.description, 'string');
      assert.ok(asset.description.length > 0, `Expected non-empty description for ${asset.kind}:${asset.name}`);
    }

    // 2. kind="skill" or kind="agent" without name lists only that kind
    const skillList = await registry.callTool('cortex_prompt', { kind: 'skill' });
    assert.equal(skillList.isError, false);
    assert.equal(skillList.data.kind, 'skill');
    assert.equal(skillList.data.name, '');
    assert.deepEqual(
      skillList.data.assets.map((a) => a.name),
      ['delegate', 'independent-review', 'plan-run', 'product-planning', 'start-job'],
    );

    const agentList = await registry.callTool('cortex_prompt', { kind: 'agent', name: '   ' });
    assert.equal(agentList.isError, false);
    assert.equal(agentList.data.kind, 'agent');
    assert.equal(agentList.data.name, '');
    assert.deepEqual(
      agentList.data.assets.map((a) => a.name),
      ['coder', 'developer', 'reviewer'],
    );

    // 3. kind="core" and kind="standard" without name still return content
    const coreRes = await registry.callTool('cortex_prompt', { kind: 'core' });
    assert.equal(coreRes.isError, false);
    assert.equal(coreRes.data.path, 'HEAD_CORE.md');
    assert.ok(coreRes.data.content.length > 0);

    const stdRes = await registry.callTool('cortex_prompt', { kind: 'standard' });
    assert.equal(stdRes.isError, false);
    assert.equal(stdRes.data.path, 'DEVELOPMENT_STANDARD.md');
    assert.ok(stdRes.data.content.length > 0);

    // 4. name without kind is an error
    const nameOnly = await registry.callTool('cortex_prompt', { name: 'start-job' });
    assert.equal(nameOnly.isError, true);
    assert.match(nameOnly.data.message, /cortex_prompt requires "kind" when "name" is given/);

    // 5. Unknown skill includes Available: and start-job
    const missingSkill = await registry.callTool('cortex_prompt', { kind: 'skill', name: 'does-not-exist' });
    assert.equal(missingSkill.isError, true);
    assert.match(missingSkill.data.message, /Available:/);
    assert.match(missingSkill.data.message, /start-job/);

    // 6. listPromptAssets on temp promptsDir: folded frontmatter, no frontmatter, CRLF, missing HEAD_CORE
    const tempPrompts = path.join(env.root, 'temp-prompts');
    fs.mkdirSync(path.join(tempPrompts, 'skills', 'x'), { recursive: true });
    fs.mkdirSync(path.join(tempPrompts, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tempPrompts, 'skills', 'x', 'SKILL.md'),
      '---\r\nname: x\r\ndescription: >\r\n  First indented line\r\n  Second indented line\r\n---\r\n\r\n# Skill X\r\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempPrompts, 'agents', 'y.md'),
      '# Agent Y\n\nPlain body description for Y.\nSecond body line.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempPrompts, 'DEVELOPMENT_STANDARD.md'),
      '# Standard\r\n\r\nCRLF standard description.\r\n',
      'utf8',
    );

    const tempAssets = listPromptAssets(tempPrompts);
    assert.deepEqual(tempAssets, [
      { kind: 'skill', name: 'x', description: 'First indented line Second indented line' },
      { kind: 'agent', name: 'y', description: 'Plain body description for Y.' },
      { kind: 'standard', name: 'DEVELOPMENT_STANDARD', description: 'CRLF standard description.' },
    ]);
    assert.equal(tempAssets.some((a) => a.kind === 'core'), false);

    // 7. listTools() exposes skill and agent names in cortex_prompt description
    const promptTool = registry.listTools().find((t) => t.name === 'cortex_prompt');
    assert.ok(promptTool);
    assert.match(promptTool.description, /start-job/);
    assert.match(promptTool.description, /reviewer/);
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

test('Open Facts 5-section parity, step 04 isolation from step 03, and plan-run multi-cycle C{k}-* contracts', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  const registry = createToolRegistry(store, {
    promptsDir: path.join(REPO_ROOT, 'prompts'),
  });

  try {
    // 1. 5-section reviewer schema parity across reviewer.md, independent-review, and plan-run steps 03, 04, 06
    const reviewPrompts = [
      { kind: 'agent', name: 'reviewer' },
      { kind: 'skill', name: 'independent-review' },
      { kind: 'skill', name: 'plan-run/steps/03-minimum-plan-review' },
      { kind: 'skill', name: 'plan-run/steps/04-plan-acceptance' },
      { kind: 'skill', name: 'plan-run/steps/06-result-review' },
    ];
    const fiveSections = [/Verified Facts/, /Open Facts/, /Blockers/, /Minor Notes/, /Verdict/];

    for (const req of reviewPrompts) {
      const res = await registry.callTool('cortex_prompt', req);
      assert.equal(res.isError, false, `Failed loading ${req.kind}:${req.name}`);
      for (const pat of fiveSections) {
        assert.match(res.data.content, pat, `${req.name} missing required 5-section key ${pat}`);
      }
    }

    // 2. Step 04 Inputs must remain strictly isolated from Step 03 review narrative (anti-anchoring)
    const step04 = await registry.callTool('cortex_prompt', { kind: 'skill', name: 'plan-run/steps/04-plan-acceptance' });
    const inputsBlockMatch = step04.data.content.match(/## Inputs[\s\S]*?(?=## Execution)/);
    assert.ok(inputsBlockMatch, '04-plan-acceptance.md missing ## Inputs section');
    assert.doesNotMatch(inputsBlockMatch[0], /03[- ]?minimum|03\s*리뷰|03\s*검수/, '04 Inputs must not inject 03 review narrative');
    assert.match(step04.data.content, /`?03`? 리뷰 맥락과도 분리/);

    // 3. Cycle-numbered branch naming across plan-run steps
    const stepBranchContracts = [
      { step: 'plan-run/steps/01-ideation', patterns: [/branch: "P0"/, /branch: "C\{k\}-IDEATION"/, /C1-IDEATION/] },
      { step: 'plan-run/steps/02-execution-planning', patterns: [/branch: "C\{k\}-PLAN"/, /C1-PLAN/] },
      { step: 'plan-run/steps/04-plan-acceptance', patterns: [/branch: "C\{k\}-PN"/, /C1-PN/] },
      { step: 'plan-run/steps/05-execution', patterns: [/branch: "C\{k\}-R\{k\}"/, /C1-R1/, /attempt: N\/2/] },
      { step: 'plan-run/steps/07-progress-review', patterns: [/depth: 8/, /direction: "out"/, /C\{k\}-IDEATION/, /C\{k\}-R\{k\}/] },
      { step: 'plan-run/steps/08-next-direction', patterns: [/단축 경로/, /LOCAL_CORRECTION/, /attempt: N\/2/, /status: "archived"/, /branch: "C\{k\}-SEED"/, /C1-SEED/] },
    ];

    for (const { step, patterns } of stepBranchContracts) {
      const res = await registry.callTool('cortex_prompt', { kind: 'skill', name: step });
      assert.equal(res.isError, false);
      for (const pat of patterns) {
        assert.match(res.data.content, pat, `${step} missing contract pattern ${pat}`);
      }
    }
  } finally {
    store.close();
    env.cleanup();
  }
});

test('plan-run multi-cycle 5-hop lineage (P0 -> C1-IDEATION -> C1-PLAN -> C1-PN -> C1-R1 -> C1-SEED) and DONE baseline archival', async () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  const registry = createToolRegistry(store, {
    promptsDir: path.join(REPO_ROOT, 'prompts'),
  });

  try {
    // 1. Canonical plan-run cycle 1 lineage with C{k}-* branch naming
    const docs = [
      { id: 'base-mc-p0', branch: 'P0', derived_from: [], title: 'P0 최초 목적' },
      { id: 'base-mc-c1-ideation', branch: 'C1-IDEATION', derived_from: ['base-mc-p0'], title: 'C1 단기 목표' },
      { id: 'base-mc-c1-plan', branch: 'C1-PLAN', derived_from: ['base-mc-c1-ideation'], title: 'C1 실행 규격' },
      { id: 'base-mc-c1-pn', branch: 'C1-PN', derived_from: ['base-mc-p0', 'base-mc-c1-plan'], title: 'C1 수용 기준선' },
      { id: 'base-mc-c1-r1', branch: 'C1-R1', derived_from: ['base-mc-c1-pn'], title: 'C1 실행 결과' },
      { id: 'base-mc-c1-seed', branch: 'C1-SEED', derived_from: ['base-mc-c1-pn', 'base-mc-c1-r1'], title: 'C1 다음 시드' },
    ];

    for (const d of docs) {
      const saved = await registry.callTool('memory_save', {
        id: d.id,
        type: 'baseline',
        session: 'multi-cycle-e2e',
        branch: d.branch,
        derived_from: d.derived_from,
        title: d.title,
        summary: `${d.title} 요약`,
        content: `${d.title} 상세 본문.`,
      });
      assert.equal(saved.isError, false, `Failed saving ${d.id}: ${JSON.stringify(saved)}`);
    }

    // Trace upstream from C1-SEED -> reaches all 5 ancestors including C1-IDEATION and P0
    const upstream = await registry.callTool('memory_graph', {
      target: 'base-mc-c1-seed',
      scope: 'project',
      depth: 8,
      direction: 'out',
    });
    assert.equal(upstream.isError, false);
    const upIds = upstream.data.nodes.map((n) => n.id);
    for (const expected of ['base-mc-c1-r1', 'base-mc-c1-pn', 'base-mc-c1-plan', 'base-mc-c1-ideation', 'base-mc-p0']) {
      assert.ok(upIds.includes(expected), `Expected ${expected} in C1-SEED upstream lineage, got ${JSON.stringify(upIds)}`);
    }

    // Strict linear 5-hop derived_from chain (no session_next shortcut edges): verifies deep traversal cleanly across depth caps
    const linearChain = [
      { id: 'lin-p0', branch: 'P0', derived_from: [] },
      { id: 'lin-c1-ideation', branch: 'C1-IDEATION', derived_from: ['lin-p0'] },
      { id: 'lin-c1-plan', branch: 'C1-PLAN', derived_from: ['lin-c1-ideation'] },
      { id: 'lin-c1-pn', branch: 'C1-PN', derived_from: ['lin-c1-plan'] },
      { id: 'lin-c1-r1', branch: 'C1-R1', derived_from: ['lin-c1-pn'] },
      { id: 'lin-c1-seed', branch: 'C1-SEED', derived_from: ['lin-c1-r1'] },
    ];
    for (const item of linearChain) {
      const res = await registry.callTool('memory_save', {
        id: item.id,
        type: 'baseline',
        branch: item.branch,
        derived_from: item.derived_from,
        title: `Linear ${item.branch}`,
        summary: `Linear ${item.branch} summary`,
      });
      assert.equal(res.isError, false);
    }

    const linUp = await registry.callTool('memory_graph', {
      target: 'lin-c1-seed',
      scope: 'project',
      depth: 8,
      direction: 'out',
    });
    assert.equal(linUp.isError, false);
    const linIds = linUp.data.nodes.map((n) => n.id);
    assert.ok(linIds.includes('lin-c1-r1'));
    assert.ok(linIds.includes('lin-c1-pn'));
    assert.ok(linIds.includes('lin-c1-plan'));
    if (linUp.data.depth >= 5) {
      assert.ok(linIds.includes('lin-c1-ideation'), 'depth >= 5 must reach hop-4 C1-IDEATION');
      assert.ok(linIds.includes('lin-p0'), 'depth >= 5 must reach hop-5 P0');
      assert.equal(linUp.data.nodes.find((n) => n.id === 'lin-p0').hop, 5);
    }

    // 2. DONE baseline archival removes intermediate baselines from active memory_overview
    for (const id of ['base-mc-c1-ideation', 'base-mc-c1-plan', 'base-mc-c1-pn', 'base-mc-c1-r1', 'base-mc-c1-seed']) {
      const arch = await registry.callTool('memory_update', { id, status: 'archived' });
      assert.equal(arch.isError, false);
      assert.equal(arch.data.status, 'archived');
    }

    const overview = await registry.callTool('memory_overview', { session: 'multi-cycle-e2e', include_global: false });
    assert.equal(overview.isError, false);
    const activeIds = [
      ...(overview.data.recentDecisions || []),
      ...(overview.data.activeBaselines || []),
    ].map((d) => d.id);
    assert.ok(!activeIds.includes('base-mc-c1-plan'), 'Archived intermediate baseline must not clutter active overview');
    assert.ok(!activeIds.includes('base-mc-c1-seed'), 'Archived intermediate baseline must not clutter active overview');
  } finally {
    store.close();
    env.cleanup();
  }
});

test('repository purity: prompts/, src/core/, and README.md contain zero hardcoded personal paths, legacy hacks, or private product leaks', () => {
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

  const personalPatterns = [
    { label: 'POSIX /Users/ path', re: /\/Users\/[A-Za-z0-9._-]+/ },
    { label: 'POSIX /home/ path', re: /\/home\/[A-Za-z0-9._-]+/ },
    { label: 'Windows C:\\Users\\ path', re: /C:[\\/]Users[\\/]/i },
    { label: 'Hardcoded workspace path', re: /G:[\\/]herdr-custom-app/i },
    { label: 'Legacy claude -p --resume recursion hack', re: /claude\s+-p\b[^\n]*--resume/i },
    ...(currentUser ? [{ label: 'Current OS username leak', re: new RegExp(`\\b${currentUser}\\b`, 'i') }] : []),
  ];

  const forbiddenPatterns = [
    ...personalPatterns,
    { label: 'Legacy head-agent-core product leak', re: /head-agent-core/i },
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

  // README.md allows MIT attribution link to upstream reference, but must have zero personal paths or usernames
  const readmePath = path.join(REPO_ROOT, 'README.md');
  const readmeText = fs.readFileSync(readmePath, 'utf8');
  for (const { label, re } of personalPatterns) {
    const match = readmeText.match(re);
    if (match) {
      violations.push(`README.md: matched [${label}] -> "${match[0]}"`);
    }
  }

  assert.deepEqual(violations, [], `Purity violations detected:\n${violations.join('\n')}`);
});
