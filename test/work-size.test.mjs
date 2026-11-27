import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  DEFAULT_CONFIG,
  DEFAULT_WORK_SIZE,
  REPO_ROOT,
  atomicWriteJson,
  atomicWriteText,
  getConfigProblems,
  loadConfig,
  projectPathKey,
  resolveWorkSizeConfig,
} from '../src/core/config.mjs';
import { approveAsUser } from './support/approve.mjs';
import {
  WORK_SIZE_COMPLETED_NOTICE,
  WORK_SIZE_DENY_MAX_CHARS,
  WORK_SIZE_DIR_NAME,
  WORK_SIZE_SESSION_NOTICE_MAX_CHARS,
  WORK_SIZE_SESSION_STALE_MS,
  WORK_SIZE_STATE_VERSION,
  commandRunsGitCommit,
  evaluateWorkSizeEdit,
  getWorkSizeDir,
  getWorkSizeStatePath,
  parseReviewVerdict,
  readWorkSizeScopeState,
  readWorkSizeState,
  resolveWorkSizeProjectRoot,
  resolveWorkSizeScope,
  tabWorkSizeScope,
} from '../src/hooks/work-size.mjs';
import {
  CLAUDE_PROJECT_DIR_ENV,
  SUBAGENT_MEMORY_DIR_DENY_REASON,
  WORK_COMMAND_DENY_REASON,
  WORK_STATE_SHELL_DENY_REASON,
  classifyWorkCommand,
  commandReferencesWorkSizeState,
  formatWorkCommandAskReason,
  formatWorkSizeStateShellAskReason,
  handleClaudePostToolUse,
  handleClaudePreToolUse,
  handleClaudeSessionStart,
  handleClaudeSubagentStop,
  handleClaudeUserPrompt,
  runClaudeHook,
} from '../src/hooks/claude.mjs';
import { CLAUDE_POST_TOOL_USE_MATCHER, CLAUDE_PRE_TOOL_USE_MATCHER } from '../src/hooks/tool-names.mjs';
import { checkClaudeHooks, installCortex, isOwnHook, uninstallCortex } from '../src/hooks/installer.mjs';
import { WORK_CLI_USAGE, WORK_EXIT_ERROR, WORK_EXIT_OK, runWorkCli } from '../scripts/cortex-work.mjs';
import { collectStatus, formatStatus } from '../scripts/cortex-status.mjs';
import { runWorker } from '../scripts/cortex-worker.mjs';

const SYS_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYS_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const HAS_POWERSHELL = process.platform === 'win32' && fs.existsSync(POWERSHELL);
const SKIP_PS = HAS_POWERSHELL ? false : 'Windows PowerShell is not available';
const AUTO_REVIVE = path.join(REPO_ROOT, 'scripts', 'auto-revive.ps1');
const CLAUDE_HOOK_SCRIPT = path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs');

function makeTempEnv(prefix = 'herdr-cortex-work-size-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(root, 'home');
  const globalDir = path.join(homeDir, '.herdr-cortex');
  const projectDir = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const outsideDir = path.join(root, 'outside-scratch');
  const promptsDir = path.join(root, 'prompts');

  for (const dir of [homeDir, globalDir, projectDir, projectB, outsideDir, promptsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  approveAsUser(projectDir, { globalDir });
  approveAsUser(projectB, { globalDir });
  atomicWriteText(path.join(promptsDir, 'HEAD_CORE.md'), '# HEAD 운영 원칙\n\n- S만 직접 수행한다.\n');

  return {
    root,
    homeDir,
    globalDir,
    projectDir,
    projectB,
    outsideDir,
    promptsDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function makeSink() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
      return true;
    },
    get text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

function spawnPreToolUseHook(payload, envVars) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', CLAUDE_HOOK_SCRIPT, 'pre-tool-use', '--id', 'herdr-cortex'],
      {
        cwd: payload.cwd,
        env: envVars,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (chunk) => outChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errChunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      let decision = 'allow';
      if (stdout.trim()) {
        const parsed = JSON.parse(stdout);
        decision = parsed?.hookSpecificOutput?.permissionDecision || 'other';
      }
      resolve({ code, stdout, stderr, decision });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test('work-size PreToolUse: exact boundaries (1 file, 1000 vs 1001 chars), tool char calculations, blocked edits excluded from sum, outside & .memory/ ignored, and prior guards run first', () => {
  const env = makeTempEnv('cortex-ws-pre-');
  try {
    const opts = { terminalId: 't1', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 't1' } };
    const readProj = (tid, dir = env.projectDir) => readWorkSizeState(env.globalDir, tabWorkSizeScope(tid), { cwd: dir });
    const callPre = (toolName, toolInput, extraPayload = {}, extraOpts = {}) => handleClaudePreToolUse(
      {
        session_id: 'sess-1',
        cwd: env.projectDir,
        tool_name: toolName,
        tool_input: toolInput,
        ...extraPayload,
      },
      { ...opts, ...extraOpts },
    );

    // 1. Outside-project files (temp brief, sibling folder, junction escaping project) and .memory/ files are NOT counted
    const outsideJunction = path.join(env.projectDir, 'escaped-link');
    let hasJunction = false;
    try {
      fs.symlinkSync(env.outsideDir, outsideJunction, 'junction');
      hasJunction = true;
    } catch (err) {
      if (err?.code !== 'EPERM') throw err;
    }

    const ignoredTargets = [
      path.join(env.outsideDir, 'brief.md'),
      path.join('..', 'outside-scratch', 'plan.md'),
      ...(hasJunction ? [path.join(outsideJunction, 'via-junction.md')] : []),
      path.join(env.projectDir, '.memory', 'docs', '2026-11', 'dec-1.md'),
      '.memory/notes.md',
    ];
    for (const ignoredTarget of ignoredTargets) {
      assert.deepEqual(callPre('Write', { file_path: ignoredTarget, content: 'x'.repeat(5000) }), {});
    }
    assert.equal(readProj('t1'), null, 'ignored paths never create state');

    // 2. Existing PreToolUse guards (.memory/ subagent deny, <globalDir>/state/ ask) run FIRST and do not count
    const subDeny = callPre(
      'Write',
      { file_path: '.memory/docs/a.md', content: 'abc' },
      { agent_id: 'sub-1' },
    );
    assert.equal(subDeny.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(subDeny.hookSpecificOutput.permissionDecisionReason, SUBAGENT_MEMORY_DIR_DENY_REASON);

    const stateAsk = callPre('Write', {
      file_path: path.join(env.globalDir, 'state', 'work-size', 'tab-t1.json'),
      content: '{}',
    });
    assert.equal(stateAsk.hookSpecificOutput?.permissionDecision, 'ask');
    assert.equal(readProj('t1'), null);

    // 3. Cumulative char boundary on 1 file: 600 + 400 = 1000 passes (stays S), +1 = 1001 is denied and escalates S -> L
    assert.deepEqual(callPre('Write', { file_path: path.join(env.projectDir, 'src', 'a.mjs'), content: 'a'.repeat(600) }), {});
    let st = readProj('t1');
    assert.equal(st.size, 'S');
    assert.deepEqual(st.files, { 'src/a.mjs': 600 });

    assert.deepEqual(callPre('Edit', { file_path: 'src/a.mjs', old_string: 'a', new_string: 'b'.repeat(400) }), {});
    st = readProj('t1');
    assert.equal(st.size, 'S');
    assert.deepEqual(st.files, { 'src/a.mjs': 1000 }, 'exact 1,000-char boundary passes');

    const overChar = callPre('Edit', { file_path: 'src/a.mjs', old_string: 'b', new_string: 'c' }, {}, { now: () => Date.parse('2026-11-27T14:00:00.000+09:00') });
    assert.equal(overChar.hookSpecificOutput?.permissionDecision, 'deny');
    const reason1 = overChar.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason1.startsWith('[herdr-cortex]'), reason1);
    assert.ok(reason1.length <= WORK_SIZE_DENY_MAX_CHARS, `deny reason length=${reason1.length}`);
    assert.match(reason1, /1,001자/);
    assert.match(reason1, /1,000자/);
    assert.match(reason1, /L/);
    assert.match(reason1, /워커/);
    assert.match(reason1, /cortex_prompt\(kind: "skill", name: "start-job"\)/);
    assert.match(reason1, /cortex-work/);
    assert.match(reason1, /상태 파일/);
    assert.doesNotMatch(reason1, /commit|커밋/i);

    st = readProj('t1');
    assert.equal(st.size, 'L');
    assert.deepEqual(st.files, { 'src/a.mjs': 1000 }, 'blocked edit is NOT added to cumulative count');
    const firstEscalatedAt = st.escalatedAt;
    const firstReason = st.escalationReason;
    assert.ok(firstEscalatedAt);
    assert.equal(firstReason.rule, 'max_chars_per_file');
    assert.equal(firstReason.projectedChars, 1001);

    // Subsequent blocked edit while already L keeps original escalatedAt and escalationReason
    const secondDeny = callPre('Write', { file_path: 'src/b.mjs', content: 'z' }, {}, { now: () => Date.parse('2026-11-27T15:00:00.000+09:00') });
    assert.equal(secondDeny.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(secondDeny.hookSpecificOutput.permissionDecisionReason, /수정 파일 2개 > 한도 1개/);
    const stAfter = readProj('t1');
    assert.equal(stAfter.escalatedAt, firstEscalatedAt);
    assert.deepEqual(stAfter.escalationReason, firstReason);
    assert.deepEqual(stAfter.files, { 'src/a.mjs': 1000 });

    // 4. MultiEdit, NotebookEdit, and unknown-field fallback (0 chars, still counted as a file!)
    const tab2Opts = { terminalId: 't2', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 't2' } };
    assert.deepEqual(
      callPre(
        'MultiEdit',
        {
          file_path: 'src/multi.mjs',
          edits: [{ old_string: 'x', new_string: '12345' }, { old_string: 'y', new_string: '67890' }],
        },
        {},
        tab2Opts,
      ),
      {},
    );
    assert.deepEqual(readProj('t2').files, { 'src/multi.mjs': 10 });

    const nbDeny = callPre(
      'NotebookEdit',
      { notebook_path: 'notebooks/demo.ipynb', new_source: 'print(1)' },
      {},
      tab2Opts,
    );
    assert.equal(nbDeny.hookSpecificOutput?.permissionDecision, 'deny');

    const tab3Opts = { terminalId: 't3', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 't3' } };
    assert.deepEqual(callPre('NotebookEdit', { notebook_path: 'nb.ipynb', new_source: 'hello-cell' }, {}, tab3Opts), {});
    assert.deepEqual(readProj('t3').files, { 'nb.ipynb': 10 });

    const tab4Opts = { terminalId: 't4', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 't4' } };
    assert.deepEqual(callPre('Write', { file_path: 'src/unknown-shape.mjs' }, {}, tab4Opts), {});
    assert.deepEqual(readProj('t4').files, { 'src/unknown-shape.mjs': 0 });
    assert.equal(
      callPre('Write', { file_path: 'src/second.mjs' }, {}, tab4Opts).hookSpecificOutput?.permissionDecision,
      'deny',
    );
  } finally {
    env.cleanup();
  }
});

test('work-size project root stability across subfolder cwd (with and without CLAUDE_PROJECT_DIR) and per-folder state isolation without overwriting other folders', () => {
  const env = makeTempEnv('cortex-ws-root-');
  try {
    const srcDir = path.join(env.projectDir, 'src');
    const deepDir = path.join(srcDir, 'deep');
    fs.mkdirSync(deepDir, { recursive: true });
    const fileA = path.join(srcDir, 'a.mjs');
    const fileB = path.join(srcDir, 'b.mjs');
    const readme = path.join(env.projectDir, 'README.md');

    // 1. Subfolder cwd preserves L and counts parent-folder files both WITH and WITHOUT CLAUDE_PROJECT_DIR
    for (const [label, tid, extraEnv] of [
      ['with CLAUDE_PROJECT_DIR', 'tab-env-on', { [CLAUDE_PROJECT_DIR_ENV]: env.projectDir }],
      ['without CLAUDE_PROJECT_DIR', 'tab-env-off', {}],
    ]) {
      const hookEnv = { HC_TERMINAL_ID: tid, ...extraEnv };
      const opts = { terminalId: tid, globalDir: env.globalDir, homeDir: env.homeDir, promptsDir: env.promptsDir, env: hookEnv };

      // Step 1: cwd=proj, File A 1,001 chars -> denied, escalates to L (files stays {})
      const step1 = handleClaudePreToolUse(
        { session_id: 's1', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: fileA, content: 'a'.repeat(1001) } },
        opts,
      );
      assert.equal(step1.hookSpecificOutput?.permissionDecision, 'deny', `${label}: step1 deny`);
      let st = readWorkSizeState(env.globalDir, tabWorkSizeScope(tid), { cwd: env.projectDir });
      assert.equal(st.size, 'L', `${label}: step1 L`);
      assert.deepEqual(st.files, {});

      // Step 2: cwd=proj\src, File B 900 chars -> allowed (1st file in empty window), L stays intact on proj!
      const step2 = handleClaudePreToolUse(
        { session_id: 's1', cwd: srcDir, tool_name: 'Write', tool_input: { file_path: fileB, content: 'b'.repeat(900) } },
        opts,
      );
      assert.deepEqual(step2, {}, `${label}: step2 allow`);
      st = readWorkSizeState(env.globalDir, tabWorkSizeScope(tid), { cwd: env.projectDir });
      assert.equal(st.size, 'L', `${label}: L preserved after cd src`);
      assert.deepEqual(st.files, { 'src/b.mjs': 900 });

      // Step 3: cwd=proj, File A 10 chars -> denied (2nd file alongside src/b.mjs!), L still intact
      const step3 = handleClaudePreToolUse(
        { session_id: 's1', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: fileA, content: 'a'.repeat(10) } },
        opts,
      );
      assert.equal(step3.hookSpecificOutput?.permissionDecision, 'deny', `${label}: step3 deny`);

      // Step 4: cwd=proj\src, parent file proj\README.md 5,000 chars -> counted inside proj and denied!
      const step4 = handleClaudePreToolUse(
        { session_id: 's1', cwd: srcDir, tool_name: 'Write', tool_input: { file_path: readme, content: 'r'.repeat(5000) } },
        opts,
      );
      assert.equal(step4.hookSpecificOutput?.permissionDecision, 'deny', `${label}: step4 README denied`);

      // SessionStart (`context`) with cwd=proj\src still shows the L reminder for proj
      const startSub = handleClaudeSessionStart(
        { session_id: 's1', source: 'startup', cwd: srcDir },
        { ...opts, part: 'context' },
      );
      assert.match(startSub.hookSpecificOutput?.additionalContext || '', /진행 중인 L 작업/, `${label}: SessionStart in src`);
    }

    // Also when CLAUDE_PROJECT_DIR is set on a brand-new tab whose VERY FIRST edit starts in cwd=proj\src:
    // parent file proj\README.md is still recognized as inside proj!
    const freshSubDeny = handleClaudePreToolUse(
      { session_id: 's-fresh', cwd: deepDir, tool_name: 'Write', tool_input: { file_path: readme, content: 'r'.repeat(1001) } },
      {
        terminalId: 'tab-first-in-sub',
        globalDir: env.globalDir,
        env: { HC_TERMINAL_ID: 'tab-first-in-sub', [CLAUDE_PROJECT_DIR_ENV]: env.projectDir },
      },
    );
    assert.equal(freshSubDeny.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(
      readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-first-in-sub'), { cwd: env.projectDir }).cwd,
      env.projectDir,
    );

    // Non-existent CLAUDE_PROJECT_DIR falls back cleanly to recorded folder / cwd
    assert.equal(
      resolveWorkSizeProjectRoot({
        cwd: srcDir,
        env: { [CLAUDE_PROJECT_DIR_ENV]: path.join(env.root, 'missing-dir') },
        globalDir: env.globalDir,
        scope: tabWorkSizeScope('tab-env-off'),
      }),
      env.projectDir,
    );

    // 2. Editing in another project (projectB) on the SAME tab keeps projectA's L state intact!
    const multiTab = 'tab-multi';
    const multiOpts = {
      terminalId: multiTab,
      globalDir: env.globalDir,
      homeDir: env.homeDir,
      promptsDir: env.promptsDir,
      env: { HC_TERMINAL_ID: multiTab },
    };

    // Escalate projectA to L
    handleClaudePreToolUse(
      { session_id: 's-a', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(900) } },
      multiOpts,
    );
    assert.equal(
      handleClaudePreToolUse(
        { session_id: 's-a', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'b.js', content: 'y' } },
        multiOpts,
      ).hookSpecificOutput?.permissionDecision,
      'deny',
    );

    // SessionStart in projectB emits NO L notice; editing in projectB starts S in projectB WITHOUT touching projectA!
    const startB = handleClaudeSessionStart(
      { session_id: 's-b', source: 'startup', cwd: env.projectB },
      { ...multiOpts, part: 'context' },
    );
    assert.doesNotMatch(startB.hookSpecificOutput?.additionalContext || '', /진행 중인 L 작업/);

    assert.deepEqual(
      handleClaudePreToolUse(
        { session_id: 's-b', cwd: env.projectB, tool_name: 'Write', tool_input: { file_path: 'other.js', content: 'hello' } },
        multiOpts,
      ),
      {},
    );

    const scopeMulti = readWorkSizeScopeState(env.globalDir, tabWorkSizeScope(multiTab));
    assert.equal(scopeMulti.version, WORK_SIZE_STATE_VERSION);
    assert.equal(Object.keys(scopeMulti.projects).length, 2, 'both folders live side by side in one tab file');
    assert.equal(scopeMulti.projects[projectPathKey(env.projectDir)].size, 'L');
    assert.deepEqual(scopeMulti.projects[projectPathKey(env.projectDir)].files, { 'a.js': 900 });
    assert.equal(scopeMulti.projects[projectPathKey(env.projectB)].size, 'S');
    assert.deepEqual(scopeMulti.projects[projectPathKey(env.projectB)].files, { 'other.js': 5 });

    // Returning to projectA: L is STILL enforced (editing second file c.js is denied, SessionStart shows L notice)
    assert.equal(
      handleClaudePreToolUse(
        { session_id: 's-a2', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'c.js', content: 'z' } },
        multiOpts,
      ).hookSpecificOutput?.permissionDecision,
      'deny',
    );
    const startBackA = handleClaudeSessionStart(
      { session_id: 's-a2', source: 'startup', cwd: env.projectDir },
      { ...multiOpts, part: 'context' },
    );
    assert.match(startBackA.hookSpecificOutput?.additionalContext || '', /진행 중인 L 작업/);

    // 3. Legacy v1 single-folder state file is read into v2 format seamlessly; broken files start fresh; I/O errors fail open
    const v1Path = getWorkSizeStatePath(env.globalDir, tabWorkSizeScope('tab-v1'));
    atomicWriteJson(v1Path, {
      version: 1,
      scopeKind: 'tab',
      scopeId: 'tab-v1',
      cwd: env.projectDir,
      cwdKey: projectPathKey(env.projectDir),
      size: 'L',
      escalatedAt: '2026-11-27T12:00:00.000+09:00',
      escalationReason: { rule: 'max_files', summary: '수정 파일 2개 > 한도 1개' },
      files: { 'legacy.js': 400 },
      reviewAccepted: true,
      reviewAcceptedAt: '2026-11-27T12:05:00.000+09:00',
      memorySaved: false,
      memorySavedAt: null,
      completedNoticePending: false,
      updatedAt: '2026-11-27T12:05:00.000+09:00',
    });
    const migrated = readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-v1'), { cwd: env.projectDir });
    assert.equal(migrated.version, WORK_SIZE_STATE_VERSION);
    assert.equal(migrated.size, 'L');
    assert.equal(migrated.reviewAccepted, true);
    assert.deepEqual(migrated.files, { 'legacy.js': 400 });

    const corruptPath = getWorkSizeStatePath(env.globalDir, tabWorkSizeScope('tab-corrupt'));
    for (const brokenContent of [
      '{ not valid json',
      '[]',
      '{"version":1,"size":"XL","cwd":"x","cwdKey":"x","files":{}}',
      '{"version":2,"projects":{"k":{"size":"S","cwd":"x","cwdKey":"x","files":{"a.js":-5}}}}',
    ]) {
      atomicWriteText(corruptPath, brokenContent);
      assert.equal(readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-corrupt')), null);
      assert.deepEqual(
        handleClaudePreToolUse(
          { session_id: 's-c', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'ok.js', content: '123' } },
          { terminalId: 'tab-corrupt', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-corrupt' } },
        ),
        {},
      );
      assert.deepEqual(
        readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-corrupt'), { cwd: env.projectDir }).files,
        { 'ok.js': 3 },
      );
    }

    const blockedStatePath = getWorkSizeStatePath(env.globalDir, tabWorkSizeScope('tab-ioerr'));
    fs.mkdirSync(blockedStatePath, { recursive: true });
    assert.deepEqual(
      handleClaudePreToolUse(
        { session_id: 's-io', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'big.js', content: 'x'.repeat(5000) } },
        { terminalId: 'tab-ioerr', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-ioerr' } },
      ),
      {},
    );
  } finally {
    env.cleanup();
  }
});

test('work-size stale cleanup: removes >30-day session-*.json files and clean empty S folder entries while preserving pending completion notices until emitted', () => {
  const env = makeTempEnv('cortex-ws-prune-');
  try {
    const wsDir = getWorkSizeDir(env.globalDir);
    fs.mkdirSync(wsDir, { recursive: true });

    const nowMs = Date.parse('2026-11-27T15:00:00.000+09:00');
    const staleTimeSec = Math.floor((nowMs - WORK_SIZE_SESSION_STALE_MS - 60_000) / 1000);
    const freshTimeSec = Math.floor((nowMs - 24 * 60 * 60 * 1000) / 1000);

    const oldSessionPath = path.join(wsDir, 'session-stale-1.json');
    const recentSessionPath = path.join(wsDir, 'session-recent-1.json');
    const oldTabPath = path.join(wsDir, 'tab-oldtab.json');

    for (const p of [oldSessionPath, recentSessionPath, oldTabPath]) {
      atomicWriteJson(p, {
        version: WORK_SIZE_STATE_VERSION,
        scopeKind: p.includes('session-') ? 'session' : 'tab',
        scopeId: 'x',
        updatedAt: '2026-10-01T00:00:00.000Z',
        projects: {
          [projectPathKey(env.projectDir)]: {
            cwd: env.projectDir,
            cwdKey: projectPathKey(env.projectDir),
            size: 'L',
            escalatedAt: '2026-10-01T00:00:00.000Z',
            escalationReason: null,
            files: {},
            reviewAccepted: false,
            reviewAcceptedAt: null,
            memorySaved: false,
            memorySavedAt: null,
            completedNoticePending: false,
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        },
      });
    }
    fs.utimesSync(oldSessionPath, staleTimeSec, staleTimeSec);
    fs.utimesSync(oldTabPath, staleTimeSec, staleTimeSec);
    fs.utimesSync(recentSessionPath, freshTimeSec, freshTimeSec);

    // Seed tab-clean with 2 projects: projectDir (escalate -> L -> complete -> pending notice) and projectB (S with 1 file)
    const opts = { terminalId: 'tab-clean', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-clean' }, now: () => nowMs };
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(1001) } }, opts);
    handleClaudePreToolUse({ cwd: env.projectB, tool_name: 'Write', tool_input: { file_path: 'b.js', content: 'y'.repeat(20) } }, opts);

    // Writing state pruned >30d session-stale-1.json, kept recent session-recent-1.json and tab-oldtab.json!
    assert.equal(fs.existsSync(oldSessionPath), false, 'stale session-*.json (>30d) removed');
    assert.equal(fs.existsSync(recentSessionPath), true, 'recent session-*.json kept');
    assert.equal(fs.existsSync(oldTabPath), true, 'tab-*.json is NOT removed by the 30-day session rule');

    // Commit in projectB (S + empty files + no pending notice) removes projectB's folder entry while keeping projectDir (L)
    handleClaudePostToolUse({ cwd: env.projectB, tool_name: 'Bash', tool_input: { command: 'git commit -m "clean b"' } }, opts);
    let scopeState = readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-clean'));
    assert.equal(scopeState.projects[projectPathKey(env.projectB)], undefined, 'clean empty S folder entry removed');
    assert.equal(scopeState.projects[projectPathKey(env.projectDir)]?.size, 'L');

    // Finish L in projectDir -> transitions to S with completedNoticePending=true -> KEPT until notice is emitted!
    handleClaudeSubagentStop({ cwd: env.projectDir, last_assistant_message: '최종 판정: ACCEPT' }, opts);
    handleClaudePostToolUse({ cwd: env.projectDir, tool_name: 'mcp__herdr-cortex__memory_save', tool_input: { type: 'worklog' } }, opts);
    scopeState = readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-clean'));
    assert.equal(scopeState.projects[projectPathKey(env.projectDir)]?.size, 'S');
    assert.equal(scopeState.projects[projectPathKey(env.projectDir)]?.completedNoticePending, true, 'entry with pending notice is kept');

    // Emit the completion notice on UserPromptSubmit -> now clean empty S -> folder entry (and empty file) removed!
    const promptOut = handleClaudeUserPrompt({ session_id: 's-p', cwd: env.projectDir }, opts);
    assert.equal(promptOut.hookSpecificOutput?.additionalContext, WORK_SIZE_COMPLETED_NOTICE);
    assert.equal(readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-clean')), null, 'removed after notice emitted');
  } finally {
    env.cleanup();
  }
});

test('work-size bypass conditions & config: worker, subagent, excluded project, workSize.enabled=false, per-project overrides, and invalid config reporting', async () => {
  const env = makeTempEnv('cortex-ws-cfg-');
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(DEFAULT_WORK_SIZE, { enabled: true, maxFilesPerWindow: 1, maxCharsPerFile: 1000 });
    assert.deepEqual(DEFAULT_CONFIG.workSize, DEFAULT_WORK_SIZE);

    // 1. Worker session and subagent calls never count or touch state; non-Herdr sessions isolate by session_id
    assert.deepEqual(
      handleClaudePreToolUse(
        { session_id: 's-w', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(5000) } },
        { terminalId: 'tab-w', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-w', HERDR_CORTEX_ROLE: 'worker' } },
      ),
      {},
    );
    assert.deepEqual(
      handleClaudePreToolUse(
        { session_id: 's-sub', agent_id: 'sub-42', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(5000) } },
        { terminalId: 'tab-w', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-w' } },
      ),
      {},
    );
    assert.equal(readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-w')), null);

    assert.equal(
      resolveWorkSizeScope({ terminalId: '', sessionId: 'solo-a' })?.fileName,
      'session-solo-a.json',
    );
    assert.equal(
      handleClaudePreToolUse(
        { session_id: 'solo-a', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(1001) } },
        { terminalId: '', globalDir: env.globalDir, env: {} },
      ).hookSpecificOutput?.permissionDecision,
      'deny',
    );
    assert.deepEqual(
      handleClaudePreToolUse(
        { session_id: 'solo-b', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'b.js', content: 'ok' } },
        { terminalId: '', globalDir: env.globalDir, env: {} },
      ),
      {},
    );

    // 2. Excluded project does nothing
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { excludedProjects: [env.projectDir] });
    assert.deepEqual(
      handleClaudePreToolUse(
        { session_id: 's-ex', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(5000) } },
        { terminalId: 'tab-ex', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-ex' } },
      ),
      {},
    );
    assert.equal(readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-ex')), null);

    // 3. Global workSize + per-project override (`projects["..."].workSize`) + `enabled: false`
    atomicWriteJson(path.join(env.globalDir, 'config.json'), {
      workSize: { enabled: true, maxFilesPerWindow: 2, maxCharsPerFile: 300 },
      projects: {
        [env.projectB]: { workSize: { enabled: false } },
      },
    });
    const cfgA = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    const cfgB = loadConfig({ projectDir: env.projectB, globalDir: env.globalDir });
    assert.deepEqual(resolveWorkSizeConfig(cfgA), { enabled: true, maxFilesPerWindow: 2, maxCharsPerFile: 300 });
    assert.deepEqual(resolveWorkSizeConfig(cfgB), { enabled: false, maxFilesPerWindow: 2, maxCharsPerFile: 300 });

    const optsA = { terminalId: 'tab-cfg', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-cfg' } };
    assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'f1.js', content: 'a'.repeat(300) } }, optsA), {});
    assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'f2.js', content: 'b'.repeat(300) } }, optsA), {});
    assert.equal(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'f3.js', content: 'c' } }, optsA).hookSpecificOutput?.permissionDecision,
      'deny',
    );

    const optsB = { terminalId: 'tab-off', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-off' } };
    assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectB, tool_name: 'Write', tool_input: { file_path: 'huge.js', content: 'x'.repeat(9000) } }, optsB), {});
    handleClaudeSubagentStop({ cwd: env.projectB, last_assistant_message: 'Verdict: ACCEPT' }, optsB);
    handleClaudePostToolUse({ cwd: env.projectB, tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }, optsB);
    assert.equal(fs.existsSync(getWorkSizeStatePath(env.globalDir, tabWorkSizeScope('tab-off'))), false);

    // 4. Invalid workSize values reset to defaults and are reported via getConfigProblems & cortex-status Configuration
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false });
    atomicWriteJson(path.join(env.globalDir, 'config.json'), {
      ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      workSize: { enabled: 'yes', maxFilesPerWindow: 0, maxCharsPerFile: -50, typoKey: 1 },
    });
    const badCfg = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    assert.deepEqual(resolveWorkSizeConfig(badCfg), DEFAULT_WORK_SIZE);
    const problems = getConfigProblems(badCfg);
    assert.equal(problems.length, 4);
    assert.ok(problems.every((p) => p.code === 'invalid_work_size'));

    const status = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: {} });
    const warnText = status.warnings.join('\n');
    assert.match(warnText, /Configuration: workSize\.enabled must be a boolean/);
    assert.match(warnText, /Configuration: workSize\.maxFilesPerWindow must be an integer >= 1/);
    assert.match(warnText, /Configuration: workSize\.maxCharsPerFile must be an integer >= 1/);
    assert.doesNotMatch(warnText, /Embedding configuration:.*workSize/);
  } finally {
    console.error = origErr;
    env.cleanup();
  }
});

test('work-size PostToolUse: git commit detector rejects --allow-empty, outside -C, and outside cwd while clearing in-project commits', () => {
  const env = makeTempEnv('cortex-ws-post-');
  try {
    const subRepo = path.join(env.projectDir, 'packages', 'sub');
    fs.mkdirSync(subRepo, { recursive: true });

    // 1. commandRunsGitCommit syntax positive cases
    const trueCases = [
      'git commit -m "feat: add work size"',
      'git add -A && git commit -am \'fix bug\'',
      'npm test; git commit -m "tested"',
      'git -C D:\\work\\app -c user.name="Kim" commit -m "scoped"',
      '(cd sub && git commit --amend --no-edit)',
      'git commit -m "mention --dry-run and --allow-empty inside commit message"',
      'git commit -m "$(cat <<\'EOF\'\nfeat: heredoc commit\n\nCo-Authored-By: Test\nEOF\n)"',
      '"C:\\Program Files\\Git\\cmd\\git.exe" commit -F msg.txt',
      '& git.exe commit -m "powershell call"',
    ];
    for (const cmd of trueCases) {
      assert.equal(commandRunsGitCommit(cmd), true, `expected true for: ${cmd}`);
    }

    // 2. commandRunsGitCommit syntax negative cases (including --allow-empty!)
    const falseCases = [
      'git commit --allow-empty -m "empty"',
      'git commit -m "empty" --allow-empty',
      'git commit --dry-run -m "check"',
      'git commit -m "check" --dry-run',
      'git commit --dry-run=short',
      'git commit --short',
      'git commit --porcelain',
      'git commit --long',
      'git commit -m"sync" --dry-run',
      'git commit --help',
      'git commit -h',
      'git --version commit -m "no"',
      'echo "git commit -m hello"',
      'printf \'git commit -m hello\\n\'',
      'grep "git commit" src/hooks/work-size.mjs',
      'node -e "console.log(\'git commit -m x\')"',
      '# git commit -m "commented out"',
      'git status && git diff',
      'git log --grep="git commit"',
      'git commit-tree HEAD^{tree}',
      'cat <<\'EOF\' > notes.sh\ngit commit -m "inside heredoc"\nEOF',
      '',
    ];
    for (const cmd of falseCases) {
      assert.equal(commandRunsGitCommit(cmd), false, `expected false for: ${cmd}`);
    }

    // 3. Project-root bound checks on `-C <dir>` and `cwd`
    assert.equal(
      commandRunsGitCommit(`git -C "${subRepo}" commit -m "inside"`, { cwd: env.projectDir, projectRoot: env.projectDir }),
      true,
    );
    assert.equal(
      commandRunsGitCommit('git -C packages/sub commit -m "rel inside"', { cwd: env.projectDir, projectRoot: env.projectDir }),
      true,
    );
    assert.equal(
      commandRunsGitCommit(`git -C "${env.projectB}" commit -m "other"`, { cwd: env.projectDir, projectRoot: env.projectDir }),
      false,
    );
    assert.equal(
      commandRunsGitCommit('git -C .. commit -m "parent"', { cwd: env.projectDir, projectRoot: env.projectDir }),
      false,
    );
    assert.equal(
      commandRunsGitCommit(`git -C${env.projectB} commit -m "attached"`, { cwd: env.projectDir, projectRoot: env.projectDir }),
      false,
    );
    assert.equal(
      commandRunsGitCommit('git commit -m "outside cwd"', { cwd: env.outsideDir, projectRoot: env.projectDir }),
      false,
    );

    // 4. PostToolUse end-to-end: --allow-empty, outside -C, outside cwd (with CLAUDE_PROJECT_DIR), dry-run, and exit_code !== 0 do NOT clear
    const hookEnv = { HC_TERMINAL_ID: 't-post', [CLAUDE_PROJECT_DIR_ENV]: env.projectDir };
    const opts = { terminalId: 't-post', globalDir: env.globalDir, env: hookEnv };
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(700) } }, opts);
    const deny = handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'a.js', new_string: 'y'.repeat(400) } }, opts);
    assert.equal(deny.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-post'), { cwd: env.projectDir }).size, 'L');

    for (const nonClearingPayload of [
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'git commit --allow-empty -m "wip"' } },
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: `git -C "${env.projectB}" commit -m "other"` } },
      { cwd: env.outsideDir, tool_name: 'Bash', tool_input: { command: 'git commit -m "in outside folder"' } },
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'git commit --dry-run -m "x"' } },
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'git commit -m "fail"' }, tool_response: { exit_code: 1 } },
    ]) {
      handleClaudePostToolUse(nonClearingPayload, opts);
      assert.deepEqual(
        readWorkSizeState(env.globalDir, tabWorkSizeScope('t-post'), { cwd: env.projectDir }).files,
        { 'a.js': 700 },
        `must NOT clear window for: ${nonClearingPayload.tool_input.command} (cwd=${nonClearingPayload.cwd})`,
      );
    }

    // Real in-project commit (including from subfolder cwd=packages/sub) clears window while keeping size = L
    handleClaudePostToolUse({ cwd: subRepo, tool_name: 'Bash', tool_input: { command: 'git add . && git commit -m "wip"' } }, opts);
    const afterCommit = readWorkSizeState(env.globalDir, tabWorkSizeScope('t-post'), { cwd: env.projectDir });
    assert.equal(afterCommit.size, 'L');
    assert.deepEqual(afterCommit.files, {});

    assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'b.js', content: 'z'.repeat(100) } }, opts), {});
    assert.deepEqual(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-post'), { cwd: env.projectDir }).files, { 'b.js': 100 });
    assert.equal(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'c.js', content: '1' } }, opts).hookSpecificOutput?.permissionDecision,
      'deny',
    );
  } finally {
    env.cleanup();
  }
});

test('work-size review verdicts (including 최종 판정 & Final verdict + canonical list item), L completion, NEEDS_FIX reset, and cortex-worker reviewer', async () => {
  const env = makeTempEnv('cortex-ws-lifecycle-');
  try {
    // 1. parseReviewVerdict: canonical list item + Final verdict / 최종 판정 + headings vs false positives
    assert.equal(parseReviewVerdict('- **Verdict (판정)**: `ACCEPT (Clean Evaluation)`'), 'ACCEPT');
    assert.equal(parseReviewVerdict('- **Verdict (판정: `ACCEPT` | `NEEDS_FIX`)**: `NEEDS_FIX`'), 'NEEDS_FIX');
    assert.equal(parseReviewVerdict('- **Verdict (판정)**:\n  - NEEDS_FIX'), 'NEEDS_FIX');
    assert.equal(parseReviewVerdict('Verdict: ACCEPT'), 'ACCEPT');
    assert.equal(parseReviewVerdict('판정: ACCEPT'), 'ACCEPT');
    assert.equal(parseReviewVerdict('최종 판정: ACCEPT'), 'ACCEPT');
    assert.equal(parseReviewVerdict('최종판정: NEEDS_FIX'), 'NEEDS_FIX');
    assert.equal(parseReviewVerdict('## 최종 판정\nACCEPT'), 'ACCEPT');
    assert.equal(parseReviewVerdict('## 최종 판정\n\n`NEEDS_FIX` — 차단 결함 1건'), 'NEEDS_FIX');
    assert.equal(parseReviewVerdict('Final verdict: ACCEPT'), 'ACCEPT');
    assert.equal(parseReviewVerdict('## Final Verdict\nNEEDS_FIX'), 'NEEDS_FIX');
    assert.equal(parseReviewVerdict('- **Final Verdict (최종 판정)**: `ACCEPT`'), 'ACCEPT');
    assert.equal(parseReviewVerdict('- **판정**: NEEDS_FIX — Blocker 1건'), 'NEEDS_FIX');
    assert.equal(parseReviewVerdict('## 5. Verdict (판정)\n\n`ACCEPT (Clean Evaluation)`\n'), 'ACCEPT');
    assert.equal(parseReviewVerdict('### 판정\n- **NEEDS_FIX**'), 'NEEDS_FIX');

    for (const nonVerdict of [
      '본문에 ACCEPT라는 낱말만 있는 글입니다. NEEDS_FIX라는 단어도 있습니다.',
      '이전 검수자는 최종 판정을 ACCEPT로 내렸다.',
      'We should ACCEPT this trade-off and move forward.',
      '이 문서는 한국어 꼴("판정: ACCEPT")을 설명합니다.',
      '```markdown\n최종 판정: ACCEPT\n```',
      '> 최종 판정: ACCEPT',
      '최종 판정: `ACCEPT` 또는 `NEEDS_FIX`',
      'Final verdict: ACCEPTED',
      '',
    ]) {
      assert.equal(parseReviewVerdict(nonVerdict), null, `must not match false positive: ${nonVerdict}`);
    }

    const opts = {
      terminalId: 't-rev',
      globalDir: env.globalDir,
      homeDir: env.homeDir,
      promptsDir: env.promptsDir,
      env: { HC_TERMINAL_ID: 't-rev' },
    };
    const readRev = () => readWorkSizeState(env.globalDir, tabWorkSizeScope('t-rev'), { cwd: env.projectDir });

    // Verdict while still in S is ignored
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: '123' } }, opts);
    handleClaudeSubagentStop({ cwd: env.projectDir, agent_id: 'sub-rev-0', last_assistant_message: '최종 판정: ACCEPT' }, opts);
    assert.equal(readRev().reviewAccepted, false);

    // Escalate to L
    handleClaudePreToolUse(
      { cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'b.js', content: '456' } },
      { ...opts, now: () => Date.parse('2026-11-27T14:20:00.000+09:00') },
    );
    assert.equal(readRev().size, 'L');

    // 2. SessionStart (`context`) injects L reminder <= 300 chars; `core` does not
    const startCore = handleClaudeSessionStart({ session_id: 's1', source: 'startup', cwd: env.projectDir }, { ...opts, part: 'core' });
    assert.doesNotMatch(startCore.hookSpecificOutput?.additionalContext || '', /진행 중인 L 작업/);

    for (const source of ['startup', 'clear', 'compact', 'resume']) {
      const startCtx = handleClaudeSessionStart(
        { session_id: `s-${source}`, source, cwd: env.projectDir },
        { ...opts, part: 'context' },
      );
      const ctx = startCtx.hookSpecificOutput?.additionalContext || '';
      const noticeLine = ctx.split('\n\n').find((sec) => sec.includes('진행 중인 L 작업'));
      assert.ok(noticeLine, `expected L notice on SessionStart(${source})`);
      assert.ok(noticeLine.length <= WORK_SIZE_SESSION_NOTICE_MAX_CHARS, `notice length=${noticeLine.length}`);
      assert.match(noticeLine, /남은 조건: 검수 ACCEPT, memory_save/);
      assert.match(noticeLine, /start-job/);
    }

    // 3. SubagentStop ACCEPT alone does NOT finish L; subsequent NEEDS_FIX wipes ACCEPT!
    handleClaudeSubagentStop(
      { cwd: env.projectDir, agent_id: 'sub-rev-1', agent_type: 'general-purpose', last_assistant_message: '## 최종 판정\nACCEPT' },
      opts,
    );
    let st = readRev();
    assert.equal(st.size, 'L');
    assert.equal(st.reviewAccepted, true);
    assert.equal(st.memorySaved, false);

    const midCtx = handleClaudeSessionStart({ session_id: 's-mid', source: 'startup', cwd: env.projectDir }, { ...opts, part: 'context' })
      .hookSpecificOutput.additionalContext;
    assert.match(midCtx, /남은 조건: memory_save\./);

    handleClaudeSubagentStop(
      { cwd: env.projectDir, agent_id: 'sub-rev-2', last_assistant_message: 'Final verdict: NEEDS_FIX' },
      opts,
    );
    assert.equal(readRev().reviewAccepted, false);

    // Failed memory_save text response does NOT count; real memory_save records memorySaved
    handleClaudePostToolUse(
      {
        cwd: env.projectDir,
        tool_name: 'mcp__herdr-cortex__memory_save',
        tool_input: { type: 'worklog' },
        tool_response: [{ type: 'text', text: 'Error: title is required' }],
      },
      opts,
    );
    assert.equal(readRev().memorySaved, false);

    handleClaudePostToolUse(
      { cwd: env.projectDir, tool_name: 'mcp__herdr-cortex__memory_save', tool_input: { type: 'worklog', title: 't', summary: 's' } },
      opts,
    );
    st = readRev();
    assert.equal(st.size, 'L');
    assert.equal(st.memorySaved, true);
    assert.equal(st.reviewAccepted, false);

    // 4. `cortex-worker --role reviewer` records ACCEPT for caller's HC_TERMINAL_ID -> both conditions met -> L finishes!
    const binDir = path.join(env.root, 'fake-bin');
    fs.mkdirSync(binDir, { recursive: true });
    const runnerJs = path.join(binDir, 'claude-fake.mjs');
    fs.writeFileSync(
      runnerJs,
      'process.stdout.write("- **Verdict (판정)**: `ACCEPT (Clean Evaluation)`\\n");\n',
      'utf8',
    );
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${runnerJs}" %*\r\n`, 'utf8');
    } else {
      fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${runnerJs}" "$@"\n`, { mode: 0o755 });
    }
    const briefPath = path.join(env.outsideDir, 'review-brief.md');
    fs.writeFileSync(briefPath, '검수 지시 본문\n', 'utf8');

    const workerExit = await runWorker(
      ['--role', 'reviewer', '--agent', 'claude', '--model', 'opus', '--brief', briefPath, '--cwd', env.projectDir],
      {
        cwd: env.projectDir,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
          SystemRoot: SYS_ROOT,
          ComSpec: process.env.ComSpec || path.join(SYS_ROOT, 'System32', 'cmd.exe'),
          TEMP: env.outsideDir,
          TMP: env.outsideDir,
          HC_TERMINAL_ID: 't-rev',
          HERDR_CORTEX_HOME: env.globalDir,
          HERDR_CORTEX_TEST_HOME: env.homeDir,
        },
        stdout: makeSink(),
        stderr: makeSink(),
      },
    );
    assert.equal(workerExit, 0);

    st = readRev();
    assert.equal(st.size, 'S', 'both memory_save and reviewer ACCEPT recorded -> back to S');
    assert.equal(st.completedNoticePending, true);

    const prompt1 = handleClaudeUserPrompt({ session_id: 's-end', cwd: env.projectDir }, opts);
    assert.equal(prompt1.hookSpecificOutput?.additionalContext, WORK_SIZE_COMPLETED_NOTICE);
    assert.equal(prompt1.systemMessage, undefined);

    const prompt2 = handleClaudeUserPrompt({ session_id: 's-end', cwd: env.projectDir }, opts);
    assert.deepEqual(prompt2, {}, 'completion notice is emitted only once');
  } finally {
    env.cleanup();
  }
});

test('cortex-work per-folder & --all CLI, shell guards (work-size state folder + cortex-work), and cortex-status subfolder lookup', async () => {
  const env = makeTempEnv('cortex-ws-cli-');
  try {
    installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, antigravityPresent: false });
    const srcDir = path.join(env.projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const opts = { terminalId: 't9', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 't9' } };
    const wsDir = getWorkSizeDir(env.globalDir);

    // 1. PreToolUse guard on shell commands touching `state/work-size` (works even when workSize.enabled is false!)
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { workSize: { enabled: false } });
    const stateModifyShellCmds = [
      `Remove-Item "${wsDir}\\*"`,
      `rm -f "${wsDir.replace(/\\/g, '/')}/tab-t9.json"`,
      'rm -f ~/.herdr-cortex/state/work-size/tab-t9.json',
      `echo {} > "${wsDir}\\tab-t9.json"`,
      'Set-Content "$env:USERPROFILE\\.herdr-cortex\\state\\work-size\\tab-t9.json" "{}"',
      'node -e "require(\'fs\').rmSync(process.env.USERPROFILE+\'/.herdr-cortex/state/work-size\',{recursive:true})"',
      'cat ~/.herdr-cortex/state/work-size/tab-t9.json && rm ~/.herdr-cortex/state/work-size/tab-t9.json',
    ];
    const stateReadOnlyShellCmds = [
      `cat "${wsDir.replace(/\\/g, '/')}/tab-t9.json"`,
      `Get-Content "${wsDir}\\tab-t9.json"`,
      'ls ~/.herdr-cortex/state/work-size',
      `Get-ChildItem "${wsDir}"`,
    ];

    for (const cmd of stateModifyShellCmds) {
      assert.equal(commandReferencesWorkSizeState(cmd, env.globalDir), true, cmd);
      const mainRes = handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } }, opts);
      assert.equal(mainRes.hookSpecificOutput?.permissionDecision, 'ask', `main should ask on state shell: ${cmd}`);
      assert.equal(mainRes.hookSpecificOutput.permissionDecisionReason, formatWorkSizeStateShellAskReason(cmd));

      const subRes = handleClaudePreToolUse(
        { cwd: env.projectDir, agent_id: 'sub-1', tool_name: 'PowerShell', tool_input: { command: cmd } },
        opts,
      );
      assert.equal(subRes.hookSpecificOutput?.permissionDecision, 'deny', `subagent should deny on state shell: ${cmd}`);
      assert.equal(subRes.hookSpecificOutput.permissionDecisionReason, WORK_STATE_SHELL_DENY_REASON);

      const workerRes = handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } },
        { ...opts, env: { HC_TERMINAL_ID: 't9', HERDR_CORTEX_ROLE: 'worker' } },
      );
      assert.equal(workerRes.hookSpecificOutput?.permissionDecision, 'deny', `worker should deny on state shell: ${cmd}`);
      assert.equal(workerRes.hookSpecificOutput.permissionDecisionReason, WORK_STATE_SHELL_DENY_REASON);
    }

    for (const cmd of stateReadOnlyShellCmds) {
      assert.equal(commandReferencesWorkSizeState(cmd, env.globalDir), true, cmd);
      assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } }, opts), {});
      assert.deepEqual(
        handleClaudePreToolUse({ cwd: env.projectDir, agent_id: 'sub-1', tool_name: 'PowerShell', tool_input: { command: cmd } }, opts),
        {},
      );
    }
    atomicWriteJson(path.join(env.globalDir, 'config.json'), DEFAULT_CONFIG);

    // 2. PreToolUse guard on `cortex-work` shell commands (including --all)
    const askCommands = [
      'cortex-work release',
      'cortex-work release --all',
      'cortex-work reset',
      'cortex-work reset --all',
      'cortex-work release --tab t9',
      'cortex-work.ps1 reset --tab t9',
      'node scripts/cortex-work.mjs release',
      `node --no-warnings "${path.join(REPO_ROOT, 'scripts', 'cortex-work.mjs')}" reset --all`,
      'powershell -NoProfile -Command "cortex-work release"',
      'cortex-work status && cortex-work release',
      'cortex-work',
      'cortex-work --global D:\\other status',
    ];
    const passCommands = [
      'cortex-work status',
      'cortex-work status --json',
      'cortex-work status --all',
      'cortex-work status --tab t9 --json',
      'cortex-work --tab=t9 status',
      'node --no-warnings scripts/cortex-work.mjs status --tab t9',
      'cat scripts/cortex-work.mjs',
      'git diff scripts/cortex-work.mjs',
    ];

    for (const cmd of askCommands) {
      assert.equal(classifyWorkCommand(cmd), 'runs-cli', cmd);
      const mainRes = handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } }, opts);
      assert.equal(mainRes.hookSpecificOutput?.permissionDecision, 'ask');
      assert.equal(mainRes.hookSpecificOutput.permissionDecisionReason, formatWorkCommandAskReason(cmd));

      const subRes = handleClaudePreToolUse(
        { cwd: env.projectDir, agent_id: 'sub-1', tool_name: 'PowerShell', tool_input: { command: cmd } },
        opts,
      );
      assert.equal(subRes.hookSpecificOutput?.permissionDecision, 'deny');
      assert.equal(subRes.hookSpecificOutput.permissionDecisionReason, WORK_COMMAND_DENY_REASON);

      const workerRes = handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } },
        { ...opts, env: { HC_TERMINAL_ID: 't9', HERDR_CORTEX_ROLE: 'worker' } },
      );
      assert.equal(workerRes.hookSpecificOutput?.permissionDecision, 'deny');
      assert.equal(workerRes.hookSpecificOutput.permissionDecisionReason, WORK_COMMAND_DENY_REASON);
    }

    for (const cmd of passCommands) {
      assert.equal(classifyWorkCommand(cmd), 'read-only', cmd);
      assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } }, opts), {});
    }

    // 3. Seed L state in BOTH projectDir and projectB on tab t9
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(600) } }, opts);
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'b.js', content: 'y'.repeat(100) } }, opts);
    handleClaudePreToolUse({ cwd: env.projectB, tool_name: 'Write', tool_input: { file_path: 'p.js', content: 'p'.repeat(500) } }, opts);
    handleClaudePreToolUse({ cwd: env.projectB, tool_name: 'Write', tool_input: { file_path: 'q.js', content: 'q'.repeat(100) } }, opts);

    // `cortex-status` reflects the current folder (including when invoked from subfolder `projectDir/src`!)
    const statusSub = await collectStatus({
      repoRoot: REPO_ROOT,
      cwd: srcDir,
      homeDir: env.homeDir,
      env: { HC_TERMINAL_ID: 't9' },
    });
    assert.equal(statusSub.workSize.size, 'L');
    assert.ok(formatStatus(statusSub).includes('Work size    : tab t9: L (files in window=1, waiting for: review ACCEPT, memory_save)'));

    // 4. `cortex-work` CLI: per-folder status, folder-scoped reset/release (including from subfolder), and `--all`
    const runCli = (argv, cliCwd = env.projectDir, cliEnv = { HC_TERMINAL_ID: 't9' }) => {
      const out = makeSink();
      const err = makeSink();
      const code = runWorkCli(argv, { env: cliEnv, cwd: cliCwd, globalDir: env.globalDir, stdout: out, stderr: err });
      return { code, out: out.text, err: err.text };
    };

    assert.match(WORK_CLI_USAGE, /cortex-work <status\|release\|reset>/);
    assert.equal(runCli(['--help']).code, WORK_EXIT_OK);
    assert.equal(runCli(['unknown']).code, WORK_EXIT_ERROR);
    assert.equal(runCli(['release'], env.projectDir, {}).code, WORK_EXIT_ERROR);

    const stText = runCli(['status'], srcDir).out;
    assert.ok(stText.includes(`${env.projectDir} (current)`), stText);
    assert.ok(stText.includes(env.projectB), stText);

    const stJson = JSON.parse(runCli(['status', '--json'], srcDir).out);
    assert.equal(stJson.size, 'L');
    assert.deepEqual(stJson.files, { 'a.js': 600 });
    assert.equal(stJson.projects.length, 2);

    // `reset` from subfolder `srcDir` clears ONLY projectDir's files, leaving projectB's files intact!
    const resetSub = JSON.parse(runCli(['reset', '--json'], srcDir).out);
    assert.equal(resetSub.clearedFiles, 1);
    assert.deepEqual(readWorkSizeState(env.globalDir, tabWorkSizeScope('t9'), { cwd: env.projectDir }).files, {});
    assert.deepEqual(readWorkSizeState(env.globalDir, tabWorkSizeScope('t9'), { cwd: env.projectB }).files, { 'p.js': 500 });

    // `release` from subfolder `srcDir` releases ONLY projectDir to S, leaving projectB in L!
    const releaseSub = JSON.parse(runCli(['release', '--json'], srcDir).out);
    assert.equal(releaseSub.previousSize, 'L');
    assert.equal(releaseSub.size, 'S');
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('t9'), { cwd: env.projectDir }), null);
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('t9'), { cwd: env.projectB }).size, 'L');

    // `cortex-status` in projectDir now shows S while projectB still shows L!
    const statusAfterReleaseA = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectDir, homeDir: env.homeDir, env: { HC_TERMINAL_ID: 't9' } });
    assert.equal(statusAfterReleaseA.workSize.size, 'S');
    const statusStillLB = await collectStatus({ repoRoot: REPO_ROOT, cwd: env.projectB, homeDir: env.homeDir, env: { HC_TERMINAL_ID: 't9' } });
    assert.equal(statusStillLB.workSize.size, 'L');

    // Re-add an edit in projectDir, then test `reset --all` and `release --all` across both folders!
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'x.js', content: 'x'.repeat(200) } }, opts);
    const resetAll = JSON.parse(runCli(['reset', '--all', '--json'], env.outsideDir).out);
    assert.equal(resetAll.all, true);
    assert.equal(resetAll.clearedFiles, 2, 'cleared files in both projectDir and projectB');
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('t9'), { cwd: env.projectB }).size, 'L');

    const releaseAll = JSON.parse(runCli(['release', '--all', '--json'], env.outsideDir).out);
    assert.equal(releaseAll.all, true);
    assert.equal(releaseAll.previousSize, 'L');
    assert.equal(releaseAll.size, 'S');
    assert.equal(readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('t9')), null);

    const stAfterText = runCli(['status']).out;
    assert.match(stAfterText, /Work size : S \(edited files: 0\)/);
  } finally {
    env.cleanup();
  }
});

test('work-size concurrency & lock resilience: parallel hook processes never lose cumulative edits, stale locks are replaced, and held locks fail open', async () => {
  const env = makeTempEnv('cortex-ws-conc-');
  try {
    const srcDir = path.join(env.projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const baseHookEnv = {
      ...process.env,
      USERPROFILE: env.homeDir,
      HOME: env.homeDir,
      HERDR_CORTEX_TEST_HOME: env.homeDir,
      HERDR_CORTEX_HOME: env.globalDir,
    };
    delete baseHookEnv.HERDR_CORTEX_ROLE;
    delete baseHookEnv.CLAUDE_PROJECT_DIR;

    // 1. Spawn real concurrent PreToolUse hook processes on the same tab:
    //    (a) 2 different files in parallel -> exactly 1 allowed + 1 denied, state is L with 1 file (never both allowed!)
    for (let round = 0; round < 4; round++) {
      const tid = `t-par-diff-${round}`;
      const childEnv = { ...baseHookEnv, HC_TERMINAL_ID: tid };
      const results = await Promise.all([
        spawnPreToolUseHook(
          { session_id: 's-par', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: path.join(srcDir, 'p1.mjs'), content: 'a'.repeat(10) } },
          childEnv,
        ),
        spawnPreToolUseHook(
          { session_id: 's-par', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: path.join(srcDir, 'p2.mjs'), content: 'b'.repeat(10) } },
          childEnv,
        ),
      ]);
      assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
      const decisions = results.map((r) => r.decision).sort();
      assert.deepEqual(decisions, ['allow', 'deny'], `round ${round}: expected 1 allow + 1 deny, got ${decisions}`);
      const st = readWorkSizeState(env.globalDir, tabWorkSizeScope(tid), { cwd: env.projectDir });
      assert.equal(st.size, 'L');
      assert.equal(Object.keys(st.files).length, 1);
    }

    //    (b) 4 concurrent edits of 200 chars each to the SAME file -> all 4 allowed, cumulative count is 800 (no lost update!)
    {
      const tid = 't-par-same';
      const childEnv = { ...baseHookEnv, HC_TERMINAL_ID: tid };
      const fileA = path.join(srcDir, 'same.mjs');
      const results = await Promise.all(
        [0, 1, 2, 3].map(() => spawnPreToolUseHook(
          { session_id: 's-same', cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: fileA, old_string: 'x', new_string: 'y'.repeat(200) } },
          childEnv,
        )),
      );
      assert.ok(results.every((r) => r.code === 0 && r.decision === 'allow'), JSON.stringify(results));
      const st = readWorkSizeState(env.globalDir, tabWorkSizeScope(tid), { cwd: env.projectDir });
      assert.equal(st.size, 'S');
      assert.deepEqual(st.files, { 'src/same.mjs': 800 });
    }

    // No leftover `.lock` or `.recover` files remain after concurrent runs
    const leftovers = fs.readdirSync(getWorkSizeDir(env.globalDir)).filter((name) => !name.endsWith('.json'));
    assert.deepEqual(leftovers, []);

    // 2. Leftover stale lock (dead PID or expired timestamp) is replaced and normal counting proceeds
    const staleScope = tabWorkSizeScope('t-stale-lock');
    const staleLockPath = `${getWorkSizeStatePath(env.globalDir, staleScope)}.lock`;
    fs.writeFileSync(
      staleLockPath,
      JSON.stringify({ pid: 99999999, acquiredAt: Date.now() - 60_000, token: 'dead-tok' }),
      'utf8',
    );
    const staleRes = evaluateWorkSizeEdit({
      filePath: path.join(srcDir, 'after-stale.mjs'),
      addedChars: 1200,
      cwd: env.projectDir,
      globalDir: env.globalDir,
      terminalId: 't-stale-lock',
    });
    assert.equal(staleRes.action, 'deny', 'stale lock is replaced so threshold enforcement still works');
    assert.equal(fs.existsSync(staleLockPath), false, 'lock cleaned up after release');

    // 3. Active lock that cannot be acquired does NOT hang or block — fails open (`pass`)!
    const heldScope = tabWorkSizeScope('t-held-lock');
    const heldLockPath = `${getWorkSizeStatePath(env.globalDir, heldScope)}.lock`;
    fs.writeFileSync(
      heldLockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() + 60_000, token: 'live-held-tok' }),
      'utf8',
    );
    const t0 = Date.now();
    const heldHookRes = handleClaudePreToolUse(
      { session_id: 's-held', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: path.join(srcDir, 'huge.mjs'), content: 'z'.repeat(5000) } },
      { terminalId: 't-held-lock', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 't-held-lock' } },
    );
    const elapsedMs = Date.now() - t0;
    assert.deepEqual(heldHookRes, {}, 'active unacquirable lock passes without blocking tool call');
    assert.ok(elapsedMs < 2000, `fail-open completed promptly (${elapsedMs}ms)`);
    assert.equal(fs.existsSync(heldLockPath), true, 'live lock owned by another holder is not deleted');
    fs.unlinkSync(heldLockPath);
  } finally {
    env.cleanup();
  }
});

test('installer & PowerShell cortex-work: registers/upgrades/removes PostToolUse + SubagentStop and exposes folder-aware cortex-work in auto-revive.ps1', { skip: SKIP_PS }, () => {
  const env = makeTempEnv('cortex-ws-install-ps-');
  try {
    const settingsPath = path.join(env.homeDir, '.claude', 'settings.json');
    const claudeScript = path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs');
    const userPostHook = { type: 'command', command: 'echo custom-post-hook', timeout: 5 };
    atomicWriteJson(settingsPath, {
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: process.execPath, args: ['--no-warnings', claudeScript, 'session-start', 'core', '--id', 'herdr-cortex'], timeout: 10 }] },
          { matcher: '', hooks: [{ type: 'command', command: process.execPath, args: ['--no-warnings', claudeScript, 'session-start', 'context', '--id', 'herdr-cortex'], timeout: 10 }] },
        ],
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: process.execPath, args: ['--no-warnings', claudeScript, 'session-end', '--id', 'herdr-cortex'], timeout: 5 }] }],
        PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: process.execPath, args: ['--no-warnings', claudeScript, 'pre-compact', '--id', 'herdr-cortex'], timeout: 10 }] }],
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: process.execPath, args: ['--no-warnings', claudeScript, 'user-prompt', '--id', 'herdr-cortex'], timeout: 10 }] }],
        PreToolUse: [{ matcher: CLAUDE_PRE_TOOL_USE_MATCHER, hooks: [{ type: 'command', command: process.execPath, args: ['--no-warnings', claudeScript, 'pre-tool-use', '--id', 'herdr-cortex'], timeout: 10 }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [userPostHook] }],
      },
    });

    const beforeCheck = checkClaudeHooks({ homeDir: env.homeDir, repoRoot: REPO_ROOT });
    assert.equal(beforeCheck.ok, false);
    assert.equal(beforeCheck.events.PostToolUse.state, 'missing');
    assert.equal(beforeCheck.events.SubagentStop.state, 'missing');

    assert.equal(installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, globalDir: env.globalDir, antigravityPresent: false }).ok, true);
    const second = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, globalDir: env.globalDir, antigravityPresent: false });
    assert.equal(second.claudeSettings.changed, false, 'idempotent re-install');
    assert.equal(checkClaudeHooks({ homeDir: env.homeDir, repoRoot: REPO_ROOT }).ok, true);

    const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(installed.hooks.PostToolUse.length, 2, 'user hook + our PostToolUse hook');
    assert.equal(installed.hooks.PostToolUse[1].matcher, CLAUDE_POST_TOOL_USE_MATCHER);
    assert.equal(installed.hooks.SubagentStop.length, 1);
    assert.equal(isOwnHook(installed.hooks.SubagentStop[0].hooks[0]), true);

    assert.deepEqual(runClaudeHook('post-tool-use', {}, { globalDir: env.globalDir }), {});
    assert.deepEqual(runClaudeHook('subagent-stop', {}, { globalDir: env.globalDir }), {});

    // PowerShell `cortex-work` honors PowerShell's Set-Location (`cd`) when releasing a single folder
    handleClaudePreToolUse(
      { cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x'.repeat(1001) } },
      { terminalId: 't1', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 't1' } },
    );
    handleClaudePreToolUse(
      { cwd: env.projectB, tool_name: 'Write', tool_input: { file_path: 'b.js', content: 'y'.repeat(1001) } },
      { terminalId: 't1', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 't1' } },
    );

    const driver = path.join(env.root, 'ps-work-driver.ps1');
    const psOutFile = path.join(env.root, 'ps-work-out.json');
    fs.writeFileSync(
      driver,
      [
        'param([string]$Loader, [string]$ProjA, [string]$OutFile)',
        '. $Loader',
        'Set-Location -LiteralPath $ProjA',
        '$cmd = Get-Command cortex-work -ErrorAction Stop',
        '$global:LASTEXITCODE = 0',
        '$rel = (cortex-work release --tab t1 --json | Out-String)',
        '$st = (cortex-work status --tab t1 --json | Out-String)',
        '$payload = [ordered]@{ name = $cmd.Name; exitCode = $global:LASTEXITCODE; releaseOut = $rel; statusOut = $st }',
        '[System.IO.File]::WriteAllText($OutFile, (ConvertTo-Json -InputObject $payload -Depth 5), (New-Object System.Text.UTF8Encoding($false)))',
      ].join('\r\n'),
      'utf8',
    );
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (/^(path|userprofile|home|HC_TERMINAL_ID|HERDR_CORTEX_ROLE|HERDR_CORTEX_HOME|HERDR_CORTEX_TEST_HOME|HERDR_REVIVE_TEST_HOME|CLAUDE_PROJECT_DIR)$/i.test(key)) {
        delete childEnv[key];
      }
    }
    childEnv.PATH = [path.join(SYS_ROOT, 'System32'), SYS_ROOT, path.join(SYS_ROOT, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
    childEnv.USERPROFILE = env.homeDir;
    childEnv.HOME = env.homeDir;
    childEnv.HERDR_CORTEX_TEST_HOME = env.homeDir;
    childEnv.HERDR_CORTEX_HOME = env.globalDir;

    const psRes = spawnSync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver, '-Loader', AUTO_REVIVE, '-ProjA', env.projectDir, '-OutFile', psOutFile],
      {
        cwd: env.outsideDir,
        encoding: 'utf8',
        windowsHide: true,
        env: childEnv,
      },
    );
    assert.equal(psRes.status, 0, `${psRes.stdout}\n${psRes.stderr}`);
    const psWrapper = JSON.parse(fs.readFileSync(psOutFile, 'utf8'));
    assert.equal(psWrapper.name, 'cortex-work');
    assert.equal(psWrapper.exitCode, 0, psWrapper.statusOut);
    const parsedRelease = JSON.parse(psWrapper.releaseOut);
    assert.equal(parsedRelease.action, 'release');
    assert.equal(parsedRelease.previousSize, 'L');
    const parsedStatus = JSON.parse(psWrapper.statusOut);
    assert.equal(parsedStatus.size, 'S', 'projectDir released to S');
    assert.equal(parsedStatus.projects.length, 1, 'projectB remained in L untouched');
    assert.equal(parsedStatus.projects[0].cwd, env.projectB);

    assert.equal(uninstallCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, globalDir: env.globalDir }).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [userPostHook] }],
      },
    });
  } finally {
    env.cleanup();
  }
});
