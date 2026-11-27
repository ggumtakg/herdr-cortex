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
import { CortexStore } from '../src/core/store.mjs';
import { approveAsUser } from './support/approve.mjs';
import {
  WORK_SIZE_COMPLETED_NOTICE,
  WORK_SIZE_DENY_MAX_CHARS,
  WORK_SIZE_DIR_NAME,
  WORK_SIZE_NOTICE_MAX_CHARS,
  WORK_SIZE_SESSION_NOTICE_MAX_CHARS,
  WORK_SIZE_SESSION_STALE_MS,
  WORK_SIZE_STATE_VERSION,
  commandRunsGitCommit,
  evaluateWorkSizeEdit,
  formatContractFileDenyReason,
  formatFailedRetryDenyReason,
  formatFileDependencyNotice,
  formatPeriodicReminder,
  formatReadVolumeNotice,
  formatUnsavedReminder,
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
  CONFIRM_COMMAND_REASON_MAX_CHARS,
  formatConfirmCommandAskReason,
  formatConfirmCommandDenyReason,
  inspectConfirmableShellCommand,
  isClearlyUnderSystemTemp,
} from '../src/hooks/confirm-commands.mjs';
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
  handleClaudePostToolUseFailure,
  handleClaudePreToolUse,
  handleClaudeSessionStart,
  handleClaudeSubagentStop,
  handleClaudeUserPrompt,
  runClaudeHook,
} from '../src/hooks/claude.mjs';
import {
  ANTIGRAVITY_POST_TOOL_USE_MATCHER,
  ANTIGRAVITY_PRE_TOOL_USE_MATCHER,
  CLAUDE_POST_TOOL_USE_FAILURE_MATCHER,
  CLAUDE_POST_TOOL_USE_MATCHER,
  CLAUDE_PRE_TOOL_USE_MATCHER,
} from '../src/hooks/tool-names.mjs';
import {
  handleAntigravityPostToolUse,
  handleAntigravityPreInvocation,
  handleAntigravityPreToolUse,
  handleAntigravitySessionStart,
  runAntigravityHook,
} from '../src/hooks/antigravity.mjs';
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

    // Commit in projectB clears files, and memory_save clears unsaved markers so clean empty S folder entry is removed
    handleClaudePostToolUse({ cwd: env.projectB, tool_name: 'Bash', tool_input: { command: 'git commit -m "clean b"' } }, opts);
    assert.deepEqual(
      readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-clean')).projects[projectPathKey(env.projectB)]?.files,
      {},
    );
    assert.equal(
      readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-clean')).projects[projectPathKey(env.projectB)]?.unsavedCommitted,
      true,
    );
    handleClaudePostToolUse({ cwd: env.projectB, tool_name: 'mcp__herdr-cortex__memory_save', tool_input: { type: 'worklog' } }, opts);
    let scopeState = readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-clean'));
    assert.equal(scopeState.projects[projectPathKey(env.projectB)], undefined, 'clean empty S folder entry removed');
    assert.equal(scopeState.projects[projectPathKey(env.projectDir)]?.size, 'L');

    // Finish L in projectDir -> transitions to S with completedNoticePending=true -> KEPT until notice is emitted!
    handleClaudeSubagentStop({ cwd: env.projectDir, last_assistant_message: '최종 판정: ACCEPT' }, opts);
    handleClaudePostToolUse({ cwd: env.projectDir, tool_name: 'mcp__herdr-cortex__memory_save', tool_input: { type: 'worklog' } }, opts);
    scopeState = readWorkSizeScopeState(env.globalDir, tabWorkSizeScope('tab-clean'));
    assert.equal(scopeState.projects[projectPathKey(env.projectDir)]?.size, 'S');
    assert.equal(scopeState.projects[projectPathKey(env.projectDir)]?.completedNoticePending, true, 'entry with pending notice is kept');

    // Emit the completion notice on UserPromptSubmit (with reminderEveryTurns: 0 so promptTurns stays 0) -> clean empty S removed!
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { workSize: { reminderEveryTurns: 0 } });
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
    assert.deepEqual(DEFAULT_WORK_SIZE, {
      enabled: true,
      maxFilesPerWindow: 1,
      maxCharsPerFile: 1000,
      reminderEveryTurns: 10,
      readNoticeThreshold: 25,
      maxFailedRetries: 2,
      confirmCommands: true,
      confirmCommandPatterns: [],
      contractFiles: [],
    });
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
    assert.deepEqual(resolveWorkSizeConfig(cfgA), { ...DEFAULT_WORK_SIZE, enabled: true, maxFilesPerWindow: 2, maxCharsPerFile: 300 });
    assert.deepEqual(resolveWorkSizeConfig(cfgB), { ...DEFAULT_WORK_SIZE, enabled: false, maxFilesPerWindow: 2, maxCharsPerFile: 300 });

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
    assert.equal(beforeCheck.events.PostToolUseFailure.state, 'missing');
    assert.equal(beforeCheck.events.SubagentStop.state, 'missing');

    assert.equal(installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, globalDir: env.globalDir, antigravityPresent: false }).ok, true);
    const second = installCortex({ repoRoot: REPO_ROOT, homeDir: env.homeDir, globalDir: env.globalDir, antigravityPresent: false });
    assert.equal(second.claudeSettings.changed, false, 'idempotent re-install');
    assert.equal(checkClaudeHooks({ homeDir: env.homeDir, repoRoot: REPO_ROOT }).ok, true);

    const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(installed.hooks.PostToolUse.length, 2, 'user hook + our PostToolUse hook');
    assert.equal(installed.hooks.PostToolUse[1].matcher, CLAUDE_POST_TOOL_USE_MATCHER);
    assert.equal(installed.hooks.PostToolUseFailure.length, 1);
    assert.equal(installed.hooks.PostToolUseFailure[0].matcher, CLAUDE_POST_TOOL_USE_FAILURE_MATCHER);
    assert.equal(isOwnHook(installed.hooks.PostToolUseFailure[0].hooks[0]), true);
    assert.equal(installed.hooks.SubagentStop.length, 1);
    assert.equal(isOwnHook(installed.hooks.SubagentStop[0].hooks[0]), true);

    assert.deepEqual(runClaudeHook('post-tool-use', {}, { globalDir: env.globalDir }), {});
    assert.deepEqual(runClaudeHook('post-tool-use-failure', {}, { globalDir: env.globalDir }), {});
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

test('work-size 2-1 & 2-2: unsaved reminder once per span + periodic reminder every N prompts + SessionStart reset', () => {
  const env = makeTempEnv('cortex-ws-remind-');
  try {
    const opts = {
      terminalId: 'tab-rem',
      globalDir: env.globalDir,
      homeDir: env.homeDir,
      promptsDir: env.promptsDir,
      env: { HC_TERMINAL_ID: 'tab-rem' },
    };

    // 1. Prompt 1 on a clean tab: no reminder yet
    const p1 = handleClaudeUserPrompt({ session_id: 's1', cwd: env.projectDir }, opts);
    assert.deepEqual(p1, {});

    // Allowed edit during Turn 1
    assert.deepEqual(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'src/a.js', content: 'const a = 1;' } }, opts),
      {},
    );

    // 2. Prompt 2: emits 1-line unsaved reminder (<= 300 chars, Korean, [herdr-cortex] prefix)
    const p2 = handleClaudeUserPrompt({ session_id: 's1', cwd: env.projectDir }, opts);
    const ctx2 = p2.hookSpecificOutput?.additionalContext || '';
    const expectedUnsaved1 = formatUnsavedReminder({ editedFileCount: 1, committed: false });
    assert.equal(ctx2, expectedUnsaved1);
    assert.ok(ctx2.startsWith('[herdr-cortex]'), ctx2);
    assert.ok(!ctx2.includes('\n'), 'unsaved reminder must be a single line');
    assert.ok(ctx2.length <= WORK_SIZE_NOTICE_MAX_CHARS, `len=${ctx2.length}`);
    assert.match(ctx2, /편집 파일 1개/);
    assert.match(ctx2, /커밋 없음/);
    assert.match(ctx2, /memory_save/);

    // 3. Prompts 3..9 in the same unsaved span (including a git commit during Turn 5 without memory_save): no duplicate unsaved reminder!
    for (let turn = 3; turn <= 9; turn++) {
      if (turn === 6) {
        handleClaudePostToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'git commit -m "feat"' } }, opts);
      }
      const pt = handleClaudeUserPrompt({ session_id: 's1', cwd: env.projectDir }, opts);
      assert.deepEqual(pt, {}, `turn ${turn} must not repeat unsaved reminder before periodic turn`);
    }

    // 4. Prompt 10 (periodic turn): repeats unsaved reminder (now with committed=true) AND 2-line periodic reminder!
    const p10 = handleClaudeUserPrompt({ session_id: 's1', cwd: env.projectDir }, opts);
    const ctx10 = p10.hookSpecificOutput?.additionalContext || '';
    const parts10 = ctx10.split('\n\n');
    assert.equal(parts10.length, 2, ctx10);
    assert.equal(parts10[0], formatUnsavedReminder({ editedFileCount: 1, committed: true }));
    assert.match(parts10[0], /커밋 있음/);
    assert.equal(parts10[1], formatPeriodicReminder(readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-rem'), { cwd: env.projectDir })));
    assert.ok(parts10[1].startsWith('[herdr-cortex]'));
    assert.equal(parts10[1].split('\n').length, 2, 'periodic reminder must be two lines');
    assert.ok(parts10[1].length <= WORK_SIZE_NOTICE_MAX_CHARS, `periodic len=${parts10[1].length}`);
    assert.match(parts10[1], /지금 상태: S/);
    assert.match(parts10[1], /memory_save/);

    // 5. Successful memory_save clears unsaved markers; next prompt (11) emits nothing, and prompt 20 emits ONLY periodic reminder!
    handleClaudePostToolUse(
      { cwd: env.projectDir, tool_name: 'mcp__herdr-cortex__memory_save', tool_input: { type: 'worklog', title: 't', summary: 's' } },
      opts,
    );
    assert.deepEqual(handleClaudeUserPrompt({ session_id: 's1', cwd: env.projectDir }, opts), {});

    // Escalate to L so periodic reminder on turn 20 reflects L + remaining conditions
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'big.js', content: 'x'.repeat(1001) } }, opts);
    for (let turn = 12; turn <= 19; turn++) {
      assert.deepEqual(handleClaudeUserPrompt({ session_id: 's1', cwd: env.projectDir }, opts), {});
    }
    const p20 = handleClaudeUserPrompt({ session_id: 's1', cwd: env.projectDir }, opts);
    const ctx20 = p20.hookSpecificOutput?.additionalContext || '';
    assert.ok(ctx20.startsWith('[herdr-cortex]'));
    assert.ok(ctx20.length <= WORK_SIZE_NOTICE_MAX_CHARS);
    assert.match(ctx20, /지금 상태: L\(남은 조건: 검수 ACCEPT, memory_save\)/);

    // 6. SessionStart (`startup`, `clear`, `compact`) resets promptTurns to 0 because HEAD_CORE is re-injected;
    //    `resume` when HEAD_CORE marker is already in transcript does NOT reset promptTurns!
    for (let i = 0; i < 4; i++) {
      handleClaudeUserPrompt({ session_id: 's1', cwd: env.projectDir }, opts);
    }
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-rem'), { cwd: env.projectDir }).promptTurns, 24);

    const transcriptWithCore = path.join(env.root, 'resume-with-core.jsonl');
    fs.writeFileSync(
      transcriptWithCore,
      `${JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'SessionStart', content: '# HEAD 운영 원칙\n본문' } })}\n`,
      'utf8',
    );
    handleClaudeSessionStart(
      { session_id: 's1', source: 'resume', transcript_path: transcriptWithCore, cwd: env.projectDir },
      { ...opts, part: 'context' },
    );
    assert.equal(
      readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-rem'), { cwd: env.projectDir }).promptTurns,
      24,
      'resume with existing HEAD_CORE marker keeps promptTurns',
    );

    handleClaudeSessionStart({ session_id: 's2', source: 'clear', cwd: env.projectDir }, { ...opts, part: 'context' });
    assert.equal(
      readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-rem'), { cwd: env.projectDir }).promptTurns,
      0,
      'SessionStart(clear) resets promptTurns to 0',
    );

    // 7. reminderEveryTurns: 0 disables periodic reminder while still emitting unsaved reminder once
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { workSize: { reminderEveryTurns: 0 } });
    handleClaudePostToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'git commit -m "only commit"' } }, opts);
    const pCommitUnsaved = handleClaudeUserPrompt({ session_id: 's2', cwd: env.projectDir }, opts);
    assert.match(pCommitUnsaved.hookSpecificOutput?.additionalContext || '', /편집 파일 0개, 커밋 있음/);
    for (let i = 0; i < 15; i++) {
      assert.deepEqual(handleClaudeUserPrompt({ session_id: 's2', cwd: env.projectDir }, opts), {});
    }
  } finally {
    env.cleanup();
  }
});

test('work-size 2-3: read volume notice on 26th Read/Grep/Glob, per-turn reset, and zero state I/O when threshold is 0', () => {
  const env = makeTempEnv('cortex-ws-reads-');
  try {
    const opts = { terminalId: 'tab-rd', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-rd' } };
    const statePath = getWorkSizeStatePath(env.globalDir, tabWorkSizeScope('tab-rd'));

    // 1. Threshold = 0: returns {} immediately and never creates or touches state file
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { workSize: { readNoticeThreshold: 0 } });
    for (const tool of ['Read', 'Grep', 'Glob']) {
      assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: tool, tool_input: { path: 'a.js' } }, opts), {});
    }
    assert.equal(fs.existsSync(statePath), false, 'readNoticeThreshold=0 must not touch state file');

    // 2. Default threshold = 25: calls 1..25 are silent, 26th notifies once via additionalContext (no permissionDecision), 27th+ silent
    atomicWriteJson(path.join(env.globalDir, 'config.json'), DEFAULT_CONFIG);
    const tools = ['Read', 'Grep', 'Glob'];
    for (let i = 1; i <= 25; i++) {
      const res = handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: tools[i % 3], tool_input: { file_path: 'a.js' } },
        opts,
      );
      assert.deepEqual(res, {}, `call ${i} <= 25 should be quiet`);
    }

    // Worker and subagent calls do not increment or trigger the counter
    assert.deepEqual(
      handleClaudePreToolUse(
        { cwd: env.projectDir, agent_id: 'sub-r', tool_name: 'Read', tool_input: { file_path: 'a.js' } },
        opts,
      ),
      {},
    );
    assert.deepEqual(
      handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'Grep', tool_input: { pattern: 'x' } },
        { ...opts, env: { HC_TERMINAL_ID: 'tab-rd', HERDR_CORTEX_ROLE: 'worker' } },
      ),
      {},
    );

    const res26 = handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Read', tool_input: { file_path: 'a.js' } }, opts);
    assert.equal(res26.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(res26.hookSpecificOutput?.permissionDecision, undefined, 'must not block or set permissionDecision');
    const notice26 = res26.hookSpecificOutput?.additionalContext || '';
    assert.equal(notice26, formatReadVolumeNotice({ readCount: 26, threshold: 25 }));
    assert.ok(notice26.startsWith('[herdr-cortex]'));
    assert.ok(notice26.length <= WORK_SIZE_NOTICE_MAX_CHARS, `len=${notice26.length}`);
    assert.match(notice26, /26회/);
    assert.match(notice26, /researcher/);
    assert.match(notice26, /원래 목적/);

    for (let i = 27; i <= 30; i++) {
      assert.deepEqual(
        handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Glob', tool_input: { pattern: '*.js' } }, opts),
        {},
        `call ${i} in same turn must not repeat notice`,
      );
    }

    // 3. Next UserPromptSubmit resets turnReads to 0 so a new 26-read burst notifies once again
    handleClaudeUserPrompt({ session_id: 's-r', cwd: env.projectDir }, opts);
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-rd'), { cwd: env.projectDir }).turnReads, 0);
    for (let i = 1; i <= 25; i++) {
      assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Read', tool_input: { file_path: 'a.js' } }, opts), {});
    }
    const resAgain = handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Grep', tool_input: { pattern: 'foo' } }, opts);
    assert.ok(resAgain.hookSpecificOutput?.additionalContext?.includes('26회'));
  } finally {
    env.cleanup();
  }
});

test('work-size 2-4: repeated failed-edit blocking via PostToolUseFailure and resets on success, commit, memory_save, and cortex-work', () => {
  const env = makeTempEnv('cortex-ws-retry-');
  try {
    const opts = { terminalId: 'tab-fail', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-fail' } };
    const readF = () => readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-fail'), { cwd: env.projectDir });

    // 1. Shell failures with zero prior file edits are ignored
    handleClaudePostToolUseFailure(
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' },
      opts,
    );
    assert.equal(readF(), null);

    // 2. Edit F -> user interrupt (`is_interrupt: true`) is NOT counted -> subsequent failure counts once,
    //    and a 2nd failure with NO edit in between does NOT double-increment!
    assert.deepEqual(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/f.js', old_string: 'a', new_string: 'b' } }, opts),
      {},
    );
    handleClaudePostToolUseFailure(
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 130', is_interrupt: true },
      opts,
    );
    assert.deepEqual(readF().failedRetries, {}, 'is_interrupt must not increment failedRetries');

    handleClaudePostToolUseFailure(
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nAssertionError' },
      opts,
    );
    assert.deepEqual(readF().failedRetries, { 'src/f.js': 1 });

    // Second failing command without editing F again -> still 1!
    handleClaudePostToolUseFailure(
      { cwd: env.projectDir, tool_name: 'PowerShell', tool_input: { command: 'npm test' }, error: 'Exit code 1' },
      opts,
    );
    assert.deepEqual(readF().failedRetries, { 'src/f.js': 1 }, 'failure with no edit since previous shell result is ignored');

    // 3. Edit F again -> fail again (count=2) -> 3rd edit of F is DENIED and escalates S -> L!
    assert.deepEqual(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/f.js', old_string: 'b', new_string: 'c' } }, opts),
      {},
    );
    handleClaudePostToolUseFailure(
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' },
      opts,
    );
    assert.deepEqual(readF().failedRetries, { 'src/f.js': 2 });

    const blocked = handleClaudePreToolUse(
      { cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/f.js', old_string: 'c', new_string: 'd' } },
      opts,
    );
    assert.equal(blocked.hookSpecificOutput?.permissionDecision, 'deny');
    const reason = blocked.hookSpecificOutput.permissionDecisionReason;
    assert.equal(reason, formatFailedRetryDenyReason({ file: 'src/f.js', failedCount: 2, escalated: true }));
    assert.ok(reason.startsWith('[herdr-cortex]'));
    assert.ok(reason.length <= WORK_SIZE_NOTICE_MAX_CHARS, `len=${reason.length}`);
    assert.match(reason, /2회/);
    assert.match(reason, /원래 문제/);
    assert.match(reason, /researcher/);
    assert.match(reason, /start-job/);
    assert.match(reason, /cortex-work/);
    assert.equal(readF().size, 'L');
    assert.equal(readF().escalationReason?.rule, 'max_failed_retries');

    // 4. Read-only shell commands (`grep`, `git diff --exit-code`, `ls`) neither increment nor reset failedRetries!
    handleClaudePostToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'git status' } }, opts);
    assert.deepEqual(readF().failedRetries, { 'src/f.js': 2 }, 'read-only shell success must NOT reset failedRetries');

    // Successful non-read-only shell command (`PostToolUse`) resets all failedRetries to {} (while keeping L)
    handleClaudePostToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' } }, opts);
    assert.deepEqual(readF().failedRetries, {});
    assert.equal(readF().size, 'L');
    assert.deepEqual(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/f.js', old_string: 'c', new_string: 'd' } }, opts),
      {},
      'allowed again after shell command succeeded',
    );

    // Read-only failures (`grep` exit 1, `git diff --exit-code` exit 1, `ls nonexistent` exit 2) after an edit
    // must NOT increment failedRetries AND must NOT wipe `editedSinceShell` before a real test command runs!
    for (const roFailCmd of ['grep -n nonexistent_symbol src/f.js', 'git diff --exit-code', 'ls no_such_file']) {
      handleClaudePostToolUseFailure(
        { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: roFailCmd }, error: 'Exit code 1' },
        opts,
      );
      assert.deepEqual(readF().failedRetries, {}, `read-only failure must not count: ${roFailCmd}`);
    }

    // 5. Commit, memory_save, cortex-work reset, and maxFailedRetries=0 each clear/disable failure blocking
    handleClaudePostToolUseFailure({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }, opts);
    assert.deepEqual(readF().failedRetries, { 'src/f.js': 1 }, 'editedSinceShell survived intervening read-only failures');
    handleClaudePostToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'git commit -m "wip"' } }, opts);
    assert.deepEqual(readF().failedRetries, {}, 'git commit clears failedRetries');

    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/f.js', old_string: 'd', new_string: 'e' } }, opts);
    handleClaudePostToolUseFailure({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }, opts);
    assert.deepEqual(readF().failedRetries, { 'src/f.js': 1 });
    handleClaudePostToolUse({ cwd: env.projectDir, tool_name: 'mcp__herdr-cortex__memory_save', tool_input: { type: 'worklog' } }, opts);
    assert.deepEqual(readF().failedRetries, {}, 'memory_save clears failedRetries');

    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/f.js', old_string: 'e', new_string: 'f' } }, opts);
    handleClaudePostToolUseFailure({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }, opts);
    runWorkCli(['reset', '--tab', 'tab-fail'], { env: { HC_TERMINAL_ID: 'tab-fail' }, cwd: env.projectDir, globalDir: env.globalDir, stdout: makeSink(), stderr: makeSink() });
    assert.deepEqual(readF().failedRetries, {}, 'cortex-work reset clears failedRetries');

    atomicWriteJson(path.join(env.globalDir, 'config.json'), { workSize: { maxFailedRetries: 0 } });
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/f.js', old_string: 'a', new_string: 'b' } }, opts), {});
      handleClaudePostToolUseFailure({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }, opts);
    }
    assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/f.js', old_string: 'a', new_string: 'b' } }, opts), {});
  } finally {
    env.cleanup();
  }
});

test('work-size 2-5: hard-to-reverse shell commands ask in main, deny in worker/subagent, exempt temp deletes, and respect config/precedence', () => {
  const env = makeTempEnv('cortex-ws-confirm-');
  const origErr = console.error;
  console.error = () => {};
  try {
    const opts = { terminalId: 'tab-cmd', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-cmd', TEMP: os.tmpdir(), TMP: os.tmpdir() } };
    const tempSub = path.join(os.tmpdir(), 'herdr-cortex-safe-del-sub');

    const mustConfirmCommands = [
      'git push --force origin main',
      'git push -f origin main',
      'git push --force-with-lease origin feat',
      'git push --delete origin old-branch',
      'git push --mirror',
      'git push origin :old-branch',
      'git push origin +main',
      'git push origin +HEAD:refs/heads/main',
      'git reset --hard HEAD~1',
      'git clean -fd',
      'git checkout -- src/a.js',
      'git restore src/a.js',
      'git restore -SW src/a.js',
      'git branch -D feat/old',
      'git stash drop',
      'git stash clear',
      'git rebase main',
      'git rebase -i HEAD~3',
      'git filter-branch -- --all',
      'git reflog expire --expire=now --all',
      'git gc --prune=now',
      'npm publish',
      'gh release create v1.2.0',
      'gh pr merge 42 --squash',
      'gh repo delete org/repo --yes',
      'docker push myorg/app:latest',
      'rm -rf dist',
      'rm -r build',
      'Remove-Item -Recurse -Force dist',
      'cmd /c "rmdir /s /q build"',
      'cmd /c "del /s /q build"',
      'xargs rm -rf < list.txt',
      'find . -name dist -exec rm -rf {} +',
      'find . -name dist -exec rm {} -rf \\;',
      'find ./build -delete',
      'npx rimraf dist',
      'rimraf coverage',
      `rm -rf "${os.tmpdir()}"`,
      `rm -rf "${tempSub}" ./dist`,
      'sqlite3 app.db "DROP TABLE users;"',
      'psql -c "DROP DATABASE staging"',
      'echo "TRUNCATE TABLE audit_logs;" | psql mydb',
      'sh -c "git reset --hard"',
    ];

    const mustPassCommands = [
      'git push',
      'git push origin main',
      'git push -u origin HEAD:feat',
      'git push origin main:main',
      'git reset --soft HEAD~1',
      'git reset HEAD src/a.js',
      'git clean -nd',
      'git clean -fd --dry-run',
      'git checkout main',
      'git checkout -b feat/new',
      'git restore --staged src/a.js',
      'git restore -S src/a.js',
      'git branch -d feat/merged',
      'git stash',
      'git stash pop',
      'git rebase --abort',
      'git rebase --continue',
      'git rebase --skip',
      'git rebase --quit',
      'git rebase --edit-todo',
      'git rebase --show-current-patch',
      'npm publish --dry-run',
      'rm single-file.txt',
      'rm -f single-file.txt',
      'find . -name "*.tmp" -exec rm {} +',
      'rmdir /c/Users/x/emptydir',
      'echo "git push --force && rm -rf / && DROP TABLE users"',
      'git commit -m "docs: warn against git reset --hard and DROP TABLE"',
      `rm -rf "${tempSub}"`,
      `rimraf "${tempSub}"`,
      `find "${tempSub}" -delete`,
      'cmd /c "rmdir /s /q %TEMP%\\cortex-temp-dir"',
    ];

    for (const cmd of mustConfirmCommands) {
      const match = inspectConfirmableShellCommand(cmd, { env: opts.env });
      assert.equal(match.matched, true, `expected match for: ${cmd}`);

      // Main conversation -> ask
      const mainRes = handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } }, opts);
      assert.equal(mainRes.hookSpecificOutput?.permissionDecision, 'ask', `main should ask for: ${cmd}`);
      const askReason = mainRes.hookSpecificOutput.permissionDecisionReason;
      assert.equal(askReason, formatConfirmCommandAskReason(match, cmd));
      assert.ok(askReason.startsWith('[herdr-cortex]'));
      assert.ok(askReason.length <= CONFIRM_COMMAND_REASON_MAX_CHARS, `ask len=${askReason.length}`);

      // Subagent -> deny
      const subRes = handleClaudePreToolUse(
        { cwd: env.projectDir, agent_id: 'sub-c', tool_name: 'Bash', tool_input: { command: cmd } },
        opts,
      );
      assert.equal(subRes.hookSpecificOutput?.permissionDecision, 'deny', `subagent should deny for: ${cmd}`);
      const subReason = subRes.hookSpecificOutput.permissionDecisionReason;
      assert.equal(subReason, formatConfirmCommandDenyReason(match));
      assert.ok(subReason.startsWith('[herdr-cortex]'));
      assert.ok(subReason.length <= CONFIRM_COMMAND_REASON_MAX_CHARS, `deny len=${subReason.length}`);
      assert.match(subReason, /HEAD를 거쳐 사용자 확인/);

      // Worker -> deny
      const workerRes = handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'PowerShell', tool_input: { command: cmd } },
        { ...opts, env: { ...opts.env, HERDR_CORTEX_ROLE: 'worker' } },
      );
      assert.equal(workerRes.hookSpecificOutput?.permissionDecision, 'deny', `worker should deny for: ${cmd}`);
      assert.equal(workerRes.hookSpecificOutput.permissionDecisionReason, subReason);
    }

    for (const cmd of mustPassCommands) {
      assert.equal(inspectConfirmableShellCommand(cmd, { env: opts.env }).matched, false, `must NOT match: ${cmd}`);
      assert.deepEqual(handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } }, opts), {}, `must pass: ${cmd}`);
    }

    assert.equal(isClearlyUnderSystemTemp(tempSub, { env: opts.env }), true);
    assert.equal(isClearlyUnderSystemTemp(os.tmpdir(), { env: opts.env }), false, 'temp root itself is NOT exempted');

    // Shell-specific temp variable rules & `rmdir /s` cmd-context scoping:
    // - PowerShell `$env:TEMP\sub` passes, while `$TEMP\sub` / `$TMP\sub` is NOT an env var in PowerShell -> asks!
    assert.deepEqual(
      handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'PowerShell', tool_input: { command: 'Remove-Item -Recurse -Force "$env:TEMP\\cortex-temp-dir"' } },
        opts,
      ),
      {},
    );
    assert.equal(
      handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'PowerShell', tool_input: { command: 'Remove-Item -Recurse -Force "$TEMP\\cortex-temp-dir"' } },
        opts,
      ).hookSpecificOutput?.permissionDecision,
      'ask',
    );
    assert.equal(
      handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'PowerShell', tool_input: { command: 'rm -rf "$TMP/cortex-temp-dir"' } },
        opts,
      ).hookSpecificOutput?.permissionDecision,
      'ask',
    );
    // - Bash unset `$TMPDIR` is NOT exempted (expands to `/...` in bash!), whereas set `TMPDIR` IS exempted
    assert.equal(
      handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'rm -rf "$TMPDIR/cortex-temp-dir"' } },
        { ...opts, env: { HC_TERMINAL_ID: 'tab-cmd', TEMP: os.tmpdir(), TMP: os.tmpdir() } },
      ).hookSpecificOutput?.permissionDecision,
      'ask',
    );
    assert.deepEqual(
      handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'rm -rf "$TMPDIR/cortex-temp-dir"' } },
        { ...opts, env: { HC_TERMINAL_ID: 'tab-cmd', TEMP: os.tmpdir(), TMP: os.tmpdir(), TMPDIR: os.tmpdir() } },
      ),
      {},
    );
    // - `rmdir /s`: standalone switch in unknown/`cmd` asks, while POSIX paths in Bash (`rmdir /s`, `rmdir /c/Users/x/emptydir`) pass!
    assert.equal(inspectConfirmableShellCommand('rmdir /s /q build', { env: opts.env }).matched, true);
    assert.deepEqual(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'rmdir /s' } }, opts),
      {},
    );
    assert.deepEqual(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'rmdir /c/Users/x/emptydir' } }, opts),
      {},
    );

    // ReDoS protection on `confirmCommandPatterns`: `^(a+)+$` on `'a'.repeat(32) + '!'` finishes quickly,
    // is treated as matched (`ask` in main, `deny` in subagent), and is reported as a config problem!
    atomicWriteJson(path.join(env.globalDir, 'config.json'), {
      workSize: {
        confirmCommands: true,
        confirmCommandPatterns: ['^(a+)+$'],
      },
    });
    const redosCfg = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    assert.equal(
      getConfigProblems(redosCfg).some((p) => p.code === 'invalid_work_size' && p.message.includes('confirmCommandPatterns')),
      true,
    );
    const evilInput = `${'a'.repeat(32)}!`;
    const redosStart = performance.now();
    const redosMain = handleClaudePreToolUse(
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: evilInput } },
      opts,
    );
    const redosMs = performance.now() - redosStart;
    assert.ok(redosMs < 500, `ReDoS pattern must be bounded (<500ms), took ${redosMs.toFixed(1)}ms`);
    assert.equal(redosMain.hookSpecificOutput?.permissionDecision, 'ask');
    assert.equal(
      handleClaudePreToolUse(
        { cwd: env.projectDir, agent_id: 'sub-redos', tool_name: 'Bash', tool_input: { command: evilInput } },
        opts,
      ).hookSpecificOutput?.permissionDecision,
      'deny',
    );
    // Overlapping alternation (`(a|aa)+$`) also times out -> asks and records runtime config problem on `cfg`
    const altCfg = loadConfig({
      projectDir: env.projectDir,
      globalDir: env.globalDir,
      overrides: { workSize: { confirmCommandPatterns: ['^(a|aa)+$'] } },
    });
    const altMatch = inspectConfirmableShellCommand(evilInput, {
      confirmCommandPatterns: altCfg.workSize.confirmCommandPatterns,
      config: altCfg,
    });
    assert.equal(altMatch.matched, true);
    assert.equal(altMatch.timedOut, true);
    assert.equal(
      getConfigProblems(altCfg).some((p) => p.code === 'invalid_work_size' && p.message.includes('exceeded')),
      true,
    );

    // `workSize.enabled: false` still enforces `confirmCommands: true`, while `confirmCommands: false` disables it
    atomicWriteJson(path.join(env.globalDir, 'config.json'), {
      workSize: {
        enabled: false,
        confirmCommands: true,
        confirmCommandPatterns: ['^deploy-prod\\b', '[invalid-regex'],
      },
    });
    const cfgWithCustom = loadConfig({ projectDir: env.projectDir, globalDir: env.globalDir });
    const cfgProblems = getConfigProblems(cfgWithCustom);
    assert.equal(cfgProblems.some((p) => p.code === 'invalid_work_size' && p.message.includes('confirmCommandPatterns[1]')), true);
    assert.equal(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'git push --force' } }, opts)
        .hookSpecificOutput?.permissionDecision,
      'ask',
      'confirmCommands stays active when workSize.enabled is false',
    );
    assert.equal(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'deploy-prod --now' } }, opts)
        .hookSpecificOutput?.permissionDecision,
      'ask',
      'valid custom pattern still works alongside invalid regex',
    );

    atomicWriteJson(path.join(env.globalDir, 'config.json'), { workSize: { confirmCommands: false } });
    assert.deepEqual(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }, opts),
      {},
      'confirmCommands=false turns off 2-5',
    );

    // Precedence: an earlier PreToolUse guard (`subagentTouchesMemoryDir`, `state/work-size`) wins over 2-5
    atomicWriteJson(path.join(env.globalDir, 'config.json'), DEFAULT_CONFIG);
    const subMemCmd = handleClaudePreToolUse(
      { cwd: env.projectDir, agent_id: 'sub-1', tool_name: 'Bash', tool_input: { command: 'rm -rf .memory' } },
      opts,
    );
    assert.equal(subMemCmd.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(subMemCmd.hookSpecificOutput?.permissionDecisionReason, SUBAGENT_MEMORY_DIR_DENY_REASON);
  } finally {
    console.error = origErr;
    env.cleanup();
  }
});

test('work-size 2-6: contractFiles glob blocks S and escalates to L; memory-graph dependency notice emits once per window in approved projects', async () => {
  const env = makeTempEnv('cortex-ws-deps-');
  try {
    // 1. Contract files: blocked in S (escalating to L), ordinary limits in L
    atomicWriteJson(path.join(env.globalDir, 'config.json'), {
      workSize: { contractFiles: ['schema/**', 'src/public/*.mjs'] },
    });
    const opts = { terminalId: 'tab-dep', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-dep' } };

    const deniedContract = handleClaudePreToolUse(
      { cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/public/api.mjs', old_string: 'a', new_string: 'b' } },
      opts,
    );
    assert.equal(deniedContract.hookSpecificOutput?.permissionDecision, 'deny');
    const cReason = deniedContract.hookSpecificOutput.permissionDecisionReason;
    assert.equal(
      cReason,
      formatContractFileDenyReason({ file: 'src/public/api.mjs', pattern: 'src/public/*.mjs', commandName: 'cortex-work' }),
    );
    assert.ok(cReason.startsWith('[herdr-cortex]'));
    assert.ok(cReason.length <= WORK_SIZE_NOTICE_MAX_CHARS, `len=${cReason.length}`);
    assert.match(cReason, /src\/public\/\*\.mjs/);
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-dep'), { cwd: env.projectDir }).size, 'L');

    // Now in L, editing the contract file within ordinary 1-file / 1,000-char limit is allowed!
    assert.deepEqual(
      handleClaudePreToolUse(
        { cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'src/public/api.mjs', old_string: 'a', new_string: 'b' } },
        opts,
      ),
      {},
    );

    // 2. Memory graph dependency notice: approved project with active decision/baseline docs
    atomicWriteJson(path.join(env.globalDir, 'config.json'), DEFAULT_CONFIG);
    const store = new CortexStore({ projectDir: env.projectB, globalDir: env.globalDir, disableVec: true });
    let decDoc;
    let baseDoc;
    try {
      decDoc = store.saveDoc({
        scope: 'project',
        type: 'decision',
        title: '공개 설정 형식 계약',
        summary: '설정 키 이름과 기본값 유지',
        content: '본문',
        files: ['src/config-schema.mjs'],
      });
      baseDoc = store.saveDoc({
        scope: 'project',
        type: 'baseline',
        title: 'P0 아키텍처 기준선',
        summary: '기준선 요약',
        content: '본문',
        files: ['src/config-schema.mjs'],
      });
      // Superseded decision and worklog must NOT appear in notice
      const oldDec = store.saveDoc({
        scope: 'project',
        type: 'decision',
        title: '폐기된 옛 결정',
        summary: '옛 요약',
        content: '본문',
        files: ['src/config-schema.mjs'],
      });
      store.updateDoc({ id: oldDec.id, scope: 'project', status: 'superseded' });
      store.saveDoc({
        scope: 'project',
        type: 'worklog',
        title: '일반 작업 로그',
        summary: '작업 로그',
        content: '본문',
        files: ['src/config-schema.mjs'],
      });
      store.saveDoc({
        scope: 'project',
        type: 'decision',
        title: '대소문자 경로 결정',
        summary: 'Mixed case 경로 검증',
        content: '본문',
        files: ['src/Mixed.mjs'],
      });
    } finally {
      store.close();
    }

    const optsB = { terminalId: 'tab-graph', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-graph' } };
    // Unlinked file -> no notice
    assert.deepEqual(
      handleClaudePreToolUse({ cwd: env.projectB, tool_name: 'Write', tool_input: { file_path: 'src/unlinked.mjs', content: '1' } }, optsB),
      {},
    );
    handleClaudePostToolUse({ cwd: env.projectB, tool_name: 'Bash', tool_input: { command: 'git commit -m "clear"' } }, optsB);

    // First edit of linked file -> attaches additionalContext once (<= 300 chars, active decision + baseline only)
    const firstEdit = handleClaudePreToolUse(
      { cwd: env.projectB, tool_name: 'Edit', tool_input: { file_path: 'src/config-schema.mjs', old_string: 'x', new_string: 'y' } },
      optsB,
    );
    assert.equal(firstEdit.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(firstEdit.hookSpecificOutput?.permissionDecision, undefined);
    const depNotice = firstEdit.hookSpecificOutput?.additionalContext || '';
    assert.ok(depNotice.startsWith('[herdr-cortex]'));
    assert.ok(depNotice.length <= WORK_SIZE_NOTICE_MAX_CHARS, `len=${depNotice.length}`);
    assert.ok(depNotice.includes(decDoc.id), depNotice);
    assert.ok(depNotice.includes(baseDoc.id), depNotice);
    assert.ok(!depNotice.includes('폐기된'), depNotice);
    assert.ok(!depNotice.includes('일반 작업 로그'), depNotice);
    assert.match(depNotice, /공개 인터페이스, 설정 형식, 저장 데이터 구조, 훅 동작/);

    // Second edit of same file in same cumulative window -> no duplicate notice
    assert.deepEqual(
      handleClaudePreToolUse(
        { cwd: env.projectB, tool_name: 'Edit', tool_input: { file_path: 'src/config-schema.mjs', old_string: 'y', new_string: 'z' } },
        optsB,
      ),
      {},
    );

    // Slow (>200ms) or throwing graph lookup is skipped without blocking the edit
    handleClaudePostToolUse({ cwd: env.projectB, tool_name: 'Bash', tool_input: { command: 'git commit -m "clear 2"' } }, optsB);
    let clock = 0;
    const timedOutEval = evaluateWorkSizeEdit({
      filePath: 'src/config-schema.mjs',
      addedChars: 5,
      cwd: env.projectB,
      globalDir: env.globalDir,
      terminalId: 'tab-graph',
      dependencyLookupOptions: {
        timeoutMs: 200,
        nowMs: () => {
          clock += 250;
          return clock;
        },
      },
    });
    assert.equal(timedOutEval.action, 'allow');
    assert.equal(timedOutEval.additionalContext, undefined, 'lookup exceeding 200ms is skipped');

    // Unapproved project never reads .memory/index.sqlite even if one exists on disk
    const unapprovedProj = path.join(env.root, 'unapproved-with-db');
    fs.mkdirSync(unapprovedProj, { recursive: true });
    fs.cpSync(path.join(env.projectB, '.memory'), path.join(unapprovedProj, '.memory'), { recursive: true });
    assert.deepEqual(
      handleClaudePreToolUse(
        { cwd: unapprovedProj, tool_name: 'Edit', tool_input: { file_path: 'src/config-schema.mjs', old_string: 'a', new_string: 'b' } },
        { terminalId: 'tab-unapp', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-unapp' } },
      ),
      {},
    );

    // Windows case-insensitive lookup: doc `files: ['src/Mixed.mjs']` is found when editing `src/mixed.mjs`
    if (process.platform === 'win32') {
      atomicWriteJson(path.join(env.globalDir, 'config.json'), {
        workSize: { maxFilesPerWindow: 10, maxCharsPerFile: 10000 },
      });
      handleClaudePostToolUse({ cwd: env.projectB, tool_name: 'Bash', tool_input: { command: 'git commit -m "clear case"' } }, optsB);
      const mixedEdit = handleClaudePreToolUse(
        { cwd: env.projectB, tool_name: 'Edit', tool_input: { file_path: 'src/mixed.mjs', old_string: 'a', new_string: 'b' } },
        optsB,
      );
      assert.match(mixedEdit.hookSpecificOutput?.additionalContext || '', /대소문자 경로 결정/);
    }

    // Exclusively locked `.memory/index.sqlite`: edit hook finishes fast (<500ms) instead of waiting 5s,
    // without modifying or deleting index files!
    const dbPathB = path.join(env.projectB, '.memory', 'index.sqlite');
    const lockerScript = path.join(env.outsideDir, 'hold-exclusive-lock.mjs');
    fs.writeFileSync(
      lockerScript,
      [
        "import { DatabaseSync } from 'node:sqlite';",
        'const db = new DatabaseSync(process.argv[2]);',
        "db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS _lock_probe(x); INSERT INTO _lock_probe VALUES (1);');",
        "process.stdout.write('LOCKED\\n');",
        "setTimeout(() => { try { db.exec('ROLLBACK'); db.close(); } catch {} }, 10000);",
      ].join('\n'),
      'utf8',
    );
    const locker = spawn(process.execPath, ['--no-warnings', lockerScript, dbPathB], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    try {
      await new Promise((resolve, reject) => {
        locker.stdout.once('data', resolve);
        locker.once('error', reject);
      });
      handleClaudePostToolUse({ cwd: env.projectB, tool_name: 'Bash', tool_input: { command: 'git commit -m "clear lock"' } }, optsB);
      const tLock0 = performance.now();
      const lockedEdit = handleClaudePreToolUse(
        { cwd: env.projectB, tool_name: 'Edit', tool_input: { file_path: 'src/config-schema.mjs', old_string: 'a', new_string: 'b' } },
        optsB,
      );
      const lockElapsedMs = performance.now() - tLock0;
      assert.deepEqual(lockedEdit, {}, 'locked index skips notice without blocking edit');
      assert.ok(lockElapsedMs < 500, `locked index lookup must finish well under 500ms, took ${lockElapsedMs.toFixed(1)}ms`);
    } finally {
      locker.kill();
      await new Promise((resolve) => locker.once('close', resolve));
    }

    // Unexpected SQLite schema skips cleanly without creating/modifying/unlinking files
    const oddProj = path.join(env.root, 'odd-schema-proj');
    fs.mkdirSync(path.join(oddProj, '.memory'), { recursive: true });
    approveAsUser(oddProj, { globalDir: env.globalDir });
    const oddDbPath = path.join(oddProj, '.memory', 'index.sqlite');
    const oddInit = spawnSync(
      process.execPath,
      ['--no-warnings', '-e', "import('node:sqlite').then(({DatabaseSync})=>{const d=new DatabaseSync(process.argv[1]);d.exec('CREATE TABLE unrelated(a INT)');d.close();})", oddDbPath],
      { windowsHide: true },
    );
    assert.equal(oddInit.status, 0);
    const oddBeforeStat = fs.statSync(oddDbPath);
    assert.deepEqual(
      handleClaudePreToolUse(
        { cwd: oddProj, tool_name: 'Write', tool_input: { file_path: 'src/a.mjs', content: '1' } },
        { terminalId: 'tab-odd', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-odd' } },
      ),
      {},
    );
    assert.equal(fs.existsSync(oddDbPath), true);
    assert.equal(fs.statSync(oddDbPath).size, oddBeforeStat.size);
  } finally {
    env.cleanup();
  }
});

test('Addendum 1..3 & cortex-work status: narrow classifyWorkCommand, parseReviewVerdict boundaries, release --all hint, and status fields', () => {
  const env = makeTempEnv('cortex-ws-addendum-');
  try {
    const opts = { terminalId: 'tab-add', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 'tab-add' } };

    // Addendum 1: file-mention dev commands pass in main, subagent, and worker
    const devFileCommands = [
      'git add scripts/cortex-work.mjs',
      'node --check scripts/cortex-work.mjs',
      'Get-Content scripts\\cortex-work.mjs',
      'git commit -m "cortex-work release fix"',
    ];
    for (const cmd of devFileCommands) {
      assert.notEqual(classifyWorkCommand(cmd), 'runs-cli', `must not be runs-cli: ${cmd}`);
      assert.deepEqual(
        handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } }, opts),
        {},
        `main must pass: ${cmd}`,
      );
      assert.deepEqual(
        handleClaudePreToolUse({ cwd: env.projectDir, agent_id: 'sub-a', tool_name: 'PowerShell', tool_input: { command: cmd } }, opts),
        {},
        `subagent must pass: ${cmd}`,
      );
      assert.deepEqual(
        handleClaudePreToolUse(
          { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } },
          { ...opts, env: { HC_TERMINAL_ID: 'tab-add', HERDR_CORTEX_ROLE: 'worker' } },
        ),
        {},
        `worker must pass: ${cmd}`,
      );
    }

    // Actual release/reset invocations still ask/deny
    for (const cmd of ['cortex-work release', 'node scripts/cortex-work.mjs reset', 'npm run work -- release']) {
      assert.equal(classifyWorkCommand(cmd), 'runs-cli', cmd);
      assert.equal(
        handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: cmd } }, opts)
          .hookSpecificOutput?.permissionDecision,
        'ask',
      );
      assert.equal(
        handleClaudePreToolUse({ cwd: env.projectDir, agent_id: 'sub-a', tool_name: 'Bash', tool_input: { command: cmd } }, opts)
          .hookSpecificOutput?.permissionDecision,
        'deny',
      );
    }

    // Addendum 2 + 2-4: declarative Korean copula endings, negations, glued ASCII words, comma commentary, and rubric lines
    assert.equal(parseReviewVerdict('판정: NEEDS_FIX입니다'), 'NEEDS_FIX');
    assert.equal(parseReviewVerdict('판정: ACCEPT입니다'), 'ACCEPT');
    assert.equal(parseReviewVerdict('최종 판정: `ACCEPT`입니다.'), 'ACCEPT');
    assert.equal(parseReviewVerdict('판정: ACCEPT임'), 'ACCEPT');
    assert.equal(parseReviewVerdict('판정: ACCEPT하지 않음'), null);
    assert.equal(parseReviewVerdict('최종 판정: `ACCEPT`하지 않음'), null);
    assert.equal(parseReviewVerdict('판정: ACCEPT 불가'), null);
    assert.equal(parseReviewVerdict('판정: ACCEPT 아님'), null);
    assert.equal(parseReviewVerdict('판정: not ACCEPT'), null);
    assert.equal(parseReviewVerdict('Verdict: ACCEPTED'), null);
    assert.equal(parseReviewVerdict('Verdict: ACCEPTABLE'), null);
    assert.equal(parseReviewVerdict('판정: NEEDS_FIX이나 추가 확인 필요'), null);
    assert.equal(parseReviewVerdict('Verdict: NEEDS_FIX, ACCEPT after fix'), 'NEEDS_FIX');
    assert.equal(parseReviewVerdict('Verdict: NEEDS_FIX (ACCEPT 불가)'), 'NEEDS_FIX');
    assert.equal(parseReviewVerdict('판정: ACCEPT (이전 NEEDS_FIX 지적 모두 해소)'), 'ACCEPT');
    assert.equal(parseReviewVerdict('- **판정**: `NEEDS_FIX` — 현 상태로는 `ACCEPT` 불가'), 'NEEDS_FIX');
    // Rubric lines remain null
    assert.equal(parseReviewVerdict('Verdict: ACCEPT | NEEDS_FIX'), null);
    assert.equal(parseReviewVerdict('최종 판정: `ACCEPT` 또는 `NEEDS_FIX`'), null);
    assert.equal(parseReviewVerdict('Verdict: ACCEPT / NEEDS_FIX'), null);
    assert.equal(parseReviewVerdict('Verdict: ACCEPT or NEEDS_FIX'), null);

    // 2-1 shell-aware backtick & unclosed-quote non-swallowing across PowerShell and Bash:
    // (a) Five blocking-regression PowerShell inputs + two-backtick & unclosed-quote variants
    for (const pwshWorkCmd of [
      'Write-Host "`n"; cortex-work release',
      'Write-Host "`n"; cortex-work release; Write-Host "`n"',
      'cortex-work `\n  release',
      'Write-Host "unclosed; cortex-work release',
      "Write-Host 'unclosed; cortex-work release",
    ]) {
      assert.equal(
        handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'PowerShell', tool_input: { command: pwshWorkCmd } }, opts)
          .hookSpecificOutput?.permissionDecision,
        'ask',
        `PowerShell main must ask: ${pwshWorkCmd}`,
      );
      assert.equal(
        handleClaudePreToolUse({ cwd: env.projectDir, agent_id: 'sub-ps', tool_name: 'PowerShell', tool_input: { command: pwshWorkCmd } }, opts)
          .hookSpecificOutput?.permissionDecision,
        'deny',
        `PowerShell subagent must deny: ${pwshWorkCmd}`,
      );
    }

    for (const pwshCommitCmd of [
      'Write-Host "x`n"; git commit -m y',
      'Write-Host "x`n"; git commit -m y; Write-Host "z`n"',
      'git commit `\n  -m y',
      'Write-Host "unclosed; git commit -m y',
    ]) {
      assert.equal(commandRunsGitCommit(pwshCommitCmd, { shell: 'PowerShell' }), true, `PowerShell commit must be detected: ${pwshCommitCmd}`);
    }

    for (const pwshConfirmCmd of [
      'Write-Host "a`nb"; git push --force',
      'Write-Host "a`nb"; git push --force; Write-Host "c`nd"',
      'Remove-Item -Path dist `\n -Recurse -Force',
      'Remove-Item -Path dist `\n -Recurse `\n -Force',
      'git push `\n --force origin main',
      'Write-Host "unclosed; git push --force',
      "Write-Host 'unclosed; Remove-Item -Recurse dist",
    ]) {
      assert.equal(
        handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'PowerShell', tool_input: { command: pwshConfirmCmd } }, opts)
          .hookSpecificOutput?.permissionDecision,
        'ask',
        `PowerShell main must ask: ${pwshConfirmCmd}`,
      );
      assert.equal(
        handleClaudePreToolUse({ cwd: env.projectDir, agent_id: 'sub-ps', tool_name: 'PowerShell', tool_input: { command: pwshConfirmCmd } }, opts)
          .hookSpecificOutput?.permissionDecision,
        'deny',
        `PowerShell subagent must deny: ${pwshConfirmCmd}`,
      );
    }

    // State folder guard with PowerShell backticks & unclosed quotes
    for (const stateShellCmd of [
      'Write-Host "`n"; Remove-Item state/work-size; Write-Host "`n"',
      'Remove-Item st`ate/work-size',
      'echo "unclosed; rm -rf state/work-size',
    ]) {
      assert.equal(
        handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'PowerShell', tool_input: { command: stateShellCmd } }, opts)
          .hookSpecificOutput?.permissionDecision,
        'ask',
        `state folder guard must ask: ${stateShellCmd}`,
      );
    }

    // (b) Bash normal backtick command substitution (`date` passes, `` `git reset --hard` `` asks/denies) & unclosed quote/backtick
    assert.deepEqual(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'echo `date`' } }, opts),
      {},
    );
    assert.equal(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'echo `git reset --hard`' } }, opts)
        .hookSpecificOutput?.permissionDecision,
      'ask',
    );
    assert.equal(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'echo "unclosed; git push --force' } }, opts)
        .hookSpecificOutput?.permissionDecision,
      'ask',
    );
    assert.equal(
      handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'echo `git push --force' } }, opts)
        .hookSpecificOutput?.permissionDecision,
      'ask',
    );

    // 2-6: Direct `node scripts/cortex-work.mjs status` emits NO `ExperimentalWarning` on stderr
    const directWorkRun = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'cortex-work.mjs'), 'status'],
      {
        cwd: env.projectDir,
        env: {
          ...process.env,
          HERDR_CORTEX_TEST_HOME: env.homeDir,
          HERDR_CORTEX_HOME: env.globalDir,
          HC_TERMINAL_ID: 'tab-add',
        },
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.equal(directWorkRun.status, 0);
    assert.doesNotMatch(directWorkRun.stderr, /ExperimentalWarning/);

    // Addendum 3 + 2-7 status fields: seed state in projectDir, then run `cortex-work release` from unrecorded projectB
    handleClaudeUserPrompt({ session_id: 's-st', cwd: env.projectDir }, opts);
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Read', tool_input: { file_path: 'a.js' } }, opts);
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Edit', tool_input: { file_path: 'a.js', old_string: '1', new_string: '2' } }, opts);
    handleClaudePostToolUseFailure({ cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }, opts);
    handleClaudePreToolUse({ cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'b.js', content: 'z'.repeat(100) } }, opts); // escalates projectDir to L

    const stOut = makeSink();
    assert.equal(
      runWorkCli(['status'], { env: { HC_TERMINAL_ID: 'tab-add' }, cwd: env.projectDir, globalDir: env.globalDir, stdout: stOut, stderr: makeSink() }),
      WORK_EXIT_OK,
    );
    assert.match(stOut.text, /Failures\s*:\s*a\.js \(1\)/);
    assert.match(stOut.text, /Unsaved\s*:\s*yes \(edited files: 1, committed: no\)/);
    assert.match(stOut.text, /Counters\s*:\s*prompts=1, turn reads=1/);

    const stJsonOut = makeSink();
    runWorkCli(['status', '--json'], { env: { HC_TERMINAL_ID: 'tab-add' }, cwd: env.projectDir, globalDir: env.globalDir, stdout: stJsonOut, stderr: makeSink() });
    const stJson = JSON.parse(stJsonOut.text);
    assert.deepEqual(stJson.failedRetries, { 'a.js': 1 });
    assert.equal(stJson.unsaved, true);
    assert.equal(stJson.promptTurns, 1);
    assert.equal(stJson.turnReads, 1);

    // Run `cortex-work release` from unrecorded `projectB` -> nothing released, guides user to `projectDir` + `--all`!
    const relOut = makeSink();
    assert.equal(
      runWorkCli(['release'], { env: { HC_TERMINAL_ID: 'tab-add' }, cwd: env.projectB, globalDir: env.globalDir, stdout: relOut, stderr: makeSink() }),
      WORK_EXIT_OK,
    );
    assert.ok(relOut.text.includes(env.projectDir), relOut.text);
    assert.match(relOut.text, /cortex-work release --all/);

    const relJsonOut = makeSink();
    runWorkCli(['release', '--json'], { env: { HC_TERMINAL_ID: 'tab-add' }, cwd: env.projectB, globalDir: env.globalDir, stdout: relJsonOut, stderr: makeSink() });
    const relJson = JSON.parse(relJsonOut.text);
    assert.equal(relJson.changed, false);
    assert.deepEqual(relJson.otherLFolders, [env.projectDir]);
  } finally {
    env.cleanup();
  }
});

test('fix2: Bash ANSI-C quoting & unquoted backslash invariants, substitution git commit, verdict negations, cmd //c, and PowerShell ${env:TEMP}', () => {
  const env = makeTempEnv('cortex-ws-fix2-');
  try {
    const opts = {
      terminalId: 'tab-fix2',
      globalDir: env.globalDir,
      env: { HC_TERMINAL_ID: 'tab-fix2', TEMP: os.tmpdir(), TMP: os.tmpdir() },
    };

    const callShell = (tool, command, role = 'main') => {
      const payload = {
        session_id: 's-fix2',
        cwd: env.projectDir,
        tool_name: tool,
        tool_input: { command },
        ...(role === 'subagent' ? { agent_id: 'sub-fix2' } : {}),
      };
      const callOpts = role === 'worker'
        ? { ...opts, env: { ...opts.env, HERDR_CORTEX_ROLE: 'worker' } }
        : opts;
      return handleClaudePreToolUse(payload, callOpts);
    };

    // 1 & 2. Bash ANSI-C `$'...'`, unquoted backslash escapes, and non-hiding invariants
    const bashMustGuard = [
      "echo Don\\'t; cortex-work release; echo It\\'s",
      "echo Don\\'t; git push --force; echo It\\'s",
      "echo Don\\'t && rm -rf src && echo It\\'s",
      "git commit -m Don\\'t && git push --force origin main && echo It\\'s",
      'echo \\"; git push --force; echo \\"',
      "echo $'a\\'b'; cortex-work release; echo 'x'",
      "echo $'a\\'b'; git push --force; echo 'x'",
      'echo a\\ b; git reset --hard',
      "echo $'unclosed; git push --force",
      "echo $'unclosed\\'; cortex-work release",
      'echo $"unclosed; git push --force',
      'echo $"a\\"b"; git push --force; echo "x"',
      'echo "${x:-"a\\"b"}"; git push --force; echo "x"',
      'echo ${#x}; git push --force',
      'rm <(echo ok) -rf src',
      "git commit -m \"$(cat <<'EOF'\nDon't worry\nEOF\n)\" && git push --force && echo \"It's done)\"",
      "ls \\'; rm -rf state/work-size; ls \\'",
      "ls $'a\\'b'; git push --force; ls $'c\\'d'",
      'echo "`echo \\"Don\'t\\" && git push --force && echo \\"It\'s\\"`"',
    ];

    for (const cmd of bashMustGuard) {
      assert.equal(
        callShell('Bash', cmd, 'main').hookSpecificOutput?.permissionDecision,
        'ask',
        `Bash main must ask: ${cmd}`,
      );
      assert.equal(
        callShell('Bash', cmd, 'subagent').hookSpecificOutput?.permissionDecision,
        'deny',
        `Bash subagent must deny: ${cmd}`,
      );
      assert.equal(
        callShell('Bash', cmd, 'worker').hookSpecificOutput?.permissionDecision,
        'deny',
        `Bash worker must deny: ${cmd}`,
      );
    }

    const bashMustPass = [
      "echo Don\\'t",
      "echo It\\'s done",
      'git commit -m "it\'s"',
      "echo 'a;b'; ls",
      'find . -name x -exec echo {} \\;',
      "echo $'git push --force'",
      "echo $'it\\'s git push --force'",
      'echo $"git push --force"',
    ];

    for (const cmd of bashMustPass) {
      assert.deepEqual(callShell('Bash', cmd, 'main'), {}, `Bash main must pass: ${cmd}`);
      assert.deepEqual(callShell('Bash', cmd, 'subagent'), {}, `Bash subagent must pass: ${cmd}`);
      assert.deepEqual(callShell('Bash', cmd, 'worker'), {}, `Bash worker must pass: ${cmd}`);
    }

    // 3. `$(...)` and backtick substitutions in `commandRunsGitCommit`, `confirm-commands`, and `cortex-work`
    for (const commitSubCmd of [
      'echo $(git commit -m y)',
      'x=$(git commit -m y)',
      'echo `git commit -m y`',
      'x=`git commit -m y`',
      'echo "$(git commit -m y)"',
    ]) {
      assert.equal(commandRunsGitCommit(commitSubCmd), true, `commit expected (default shell): ${commitSubCmd}`);
      assert.equal(commandRunsGitCommit(commitSubCmd, { shell: 'Bash' }), true, `commit expected (Bash): ${commitSubCmd}`);
    }
    assert.equal(commandRunsGitCommit('echo $(git commit --dry-run -m y)', { shell: 'Bash' }), false);
    assert.equal(
      commandRunsGitCommit('echo $(git -C .. commit -m y)', {
        cwd: env.projectDir,
        projectRoot: env.projectDir,
        shell: 'Bash',
      }),
      false,
    );

    // End-to-end PostToolUse clears window when `git commit` runs inside `$(...)`
    handleClaudePreToolUse(
      { cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'src/sub-commit.js', content: 'abc' } },
      opts,
    );
    assert.deepEqual(
      readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-fix2'), { cwd: env.projectDir }).files,
      { 'src/sub-commit.js': 3 },
    );
    handleClaudePostToolUse(
      { cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'out=$(git commit -m "sub commit")' } },
      opts,
    );
    const afterSubCommit = readWorkSizeState(env.globalDir, tabWorkSizeScope('tab-fix2'), { cwd: env.projectDir });
    assert.deepEqual(afterSubCommit.files, {});
    assert.equal(afterSubCommit.unsavedCommitted, true);

    for (const subGuardCmd of [
      'echo $(git push --force)',
      'x=`rm -rf src`',
      'x=$(cortex-work release)',
      'echo `cortex-work reset`',
    ]) {
      assert.equal(callShell('Bash', subGuardCmd, 'main').hookSpecificOutput?.permissionDecision, 'ask', subGuardCmd);
      assert.equal(callShell('Bash', subGuardCmd, 'subagent').hookSpecificOutput?.permissionDecision, 'deny', subGuardCmd);
    }

    // 4. `parseReviewVerdict` trailing Korean/English negations vs affirmative sentences
    for (const negated of [
      '판정: ACCEPT 하지 않음',
      '판정: ACCEPT 하지 않습니다',
      '판정: ACCEPT 할 수 없음',
      '판정: ACCEPT 할 수 없습니다',
      '판정: ACCEPT 어렵다',
      '판정: ACCEPT 어렵습니다',
      '판정: ACCEPT 어려움',
      '판정: ACCEPT 아니다',
      '판정: ACCEPT 안 함',
      '판정: ACCEPT 못 함',
      '판정: ACCEPT 불가능',
      '판정: `ACCEPT` 하지 않습니다',
      'Verdict: ACCEPT is not possible',
      'Verdict: ACCEPT cannot be given',
    ]) {
      assert.equal(parseReviewVerdict(negated), null, `must NOT read negated verdict as ACCEPT: ${negated}`);
    }

    for (const [input, expected] of [
      ['- **Verdict (판정)**: `ACCEPT (Clean Evaluation)`', 'ACCEPT'],
      ['판정: ACCEPT. 차단 결함은 없습니다', 'ACCEPT'],
      ['판정: ACCEPT — 문제는 없습니다.', 'ACCEPT'],
      ['판정: ACCEPT입니다', 'ACCEPT'],
      ['판정: ACCEPT입니다. 더 고칠 부분은 없습니다.', 'ACCEPT'],
      ['Verdict: NEEDS_FIX (ACCEPT 할 수 없음)', 'NEEDS_FIX'],
    ]) {
      assert.equal(parseReviewVerdict(input), expected, `expected ${expected} for: ${input}`);
    }

    // 5. Git Bash `cmd //c` and `cmd //k` nested command extraction + `cmd` quote/caret rules
    for (const cmdSlashCmd of [
      'cmd //c "rmdir /s /q x"',
      'cmd.exe //c rd /s /q x',
      'cmd //k "del /s /q x"',
      'cmd //c "cortex-work release"',
      'cmd //c "echo Don\'t & rmdir /s /q x & echo It\'s"',
      'cmd //c "echo ^" & git push --force & echo ^""',
    ]) {
      assert.equal(callShell('Bash', cmdSlashCmd, 'main').hookSpecificOutput?.permissionDecision, 'ask', cmdSlashCmd);
      assert.equal(callShell('Bash', cmdSlashCmd, 'subagent').hookSpecificOutput?.permissionDecision, 'deny', cmdSlashCmd);
      assert.equal(callShell('Bash', cmdSlashCmd, 'worker').hookSpecificOutput?.permissionDecision, 'deny', cmdSlashCmd);
    }
    assert.deepEqual(callShell('Bash', 'cmd //c "rmdir /s /q %TEMP%\\cortex-temp-dir"', 'main'), {});

    // 6. PowerShell `${env:TEMP}` braced variable exemption + PowerShell here-strings and block comments
    for (const pwshSafeTemp of [
      'Remove-Item -Recurse ${env:TEMP}\\build',
      'Remove-Item -Recurse -Force "${env:TEMP}\\build"',
      'Remove-Item -Recurse ${env:TMP}/build',
    ]) {
      assert.deepEqual(callShell('PowerShell', pwshSafeTemp, 'main'), {}, `PowerShell temp must pass: ${pwshSafeTemp}`);
    }
    assert.equal(
      callShell('PowerShell', 'Remove-Item -Recurse ${TEMP}\\build', 'main').hookSpecificOutput?.permissionDecision,
      'ask',
    );
    for (const pwshNonHiding of [
      "Write-Host @'\nDon't worry\n'@; git push --force; Write-Host 'x'",
      'Write-Host @"\nSay "hello\n"@; git push --force; Write-Host "x"',
      "Write-Host <# Don't #> hi; git push --force; Write-Host 'x'",
      'Write-Host ${#x}; git push --force',
    ]) {
      assert.equal(callShell('PowerShell', pwshNonHiding, 'main').hookSpecificOutput?.permissionDecision, 'ask', pwshNonHiding);
      assert.equal(callShell('PowerShell', pwshNonHiding, 'subagent').hookSpecificOutput?.permissionDecision, 'deny', pwshNonHiding);
    }
    assert.deepEqual(callShell('PowerShell', "Write-Host @'\nDon't:\ngit push --force\n'@", 'main'), {});
  } finally {
    env.cleanup();
  }
});

test('fix3: conservative unquoted-word shell inspection, cortex-work HEAD-default + safe exceptions, heredoc closing-line check, PowerShell typography, and non-leading git commit', async () => {
  const shellTokensMod = await import('../src/hooks/shell-tokens.mjs');
  assert.equal('findSegmentCommandIndex' in shellTokensMod, false, 'findSegmentCommandIndex dead code removed');

  const env = makeTempEnv('cortex-ws-fix3-');
  try {
    const opts = {
      terminalId: 'tab-fix3',
      globalDir: env.globalDir,
      env: { HC_TERMINAL_ID: 'tab-fix3', TEMP: os.tmpdir(), TMP: os.tmpdir() },
    };

    const callShell = (tool, command, role = 'main') => {
      const payload = {
        session_id: 's-fix3',
        cwd: env.projectDir,
        tool_name: tool,
        tool_input: { command },
        ...(role === 'subagent' ? { agent_id: 'sub-fix3' } : {}),
      };
      const callOpts = role === 'worker'
        ? { ...opts, env: { ...opts.env, HERDR_CORTEX_ROLE: 'worker' } }
        : opts;
      return handleClaudePreToolUse(payload, callOpts);
    };

    // 1. Must NOT miss (main -> ask, subagent -> deny, worker -> deny)
    const mustGuardPairs = [
      // Six background cases from 3rd review
      ['Bash', 'for f in build dist; do rm -rf "$f"; done'],
      ['Bash', 'if git diff --quiet; then git push --force; fi'],
      ['PowerShell', '$out = git push --force 2>&1'],
      ['Bash', '! cortex-work reset'],
      ['PowerShell', '! cortex-work reset'],
      ['Bash', 'exec cortex-work release'],
      ['Bash', 'cat <<< hello\ncortex-work release'],
      // Loops, keywords, wrappers, redirections
      ['Bash', 'while true; do git reset --hard; done'],
      ['Bash', 'time -p git push --force'],
      ['Bash', 'nice rm -rf x'],
      ['Bash', 'timeout 5 git clean -fd'],
      ['Bash', '2>/dev/null rm -rf x'],
      ['Bash', '>out git push --force'],
      ['Bash', 'env X=1 git push -f'],
      ['Bash', 'sudo rm -rf x'],
      ['Bash', 'nohup git push --force &'],
      // PowerShell assignments, call operator, curly quotes & en/em-dashes, iex, -EncodedCommand, aliases
      ['PowerShell', '$null = git push --force'],
      ['PowerShell', '$r = cortex-work release'],
      ['PowerShell', '& git push --force'],
      ['PowerShell', 'Remove-Item \u2013Recurse src'],
      ['PowerShell', 'Remove-Item \u2014Recurse src'],
      ['PowerShell', "Write-Host 'a\u2019; git push --force; Write-Host 'b'"],
      ['PowerShell', 'Write-Host "a\u201d; git push --force; Write-Host "b"'],
      ['PowerShell', 'iex "git push --force"'],
      ['PowerShell', "Invoke-Expression 'rm -rf src'"],
      ['PowerShell', 'powershell -enc AAAA'],
      ['Bash', 'powershell -enc AAAA'],
      ['PowerShell', 'pwsh -e AAAA'],
      ['PowerShell', 'powershell -ExecutionPolicy Bypass -EncodedCommand AAAA'],
      ['PowerShell', 'del -Recurse src'],
      ['PowerShell', 'rd -Recurse src'],
      ['PowerShell', 'erase -Recurse src'],
      ['PowerShell', 'rmdir src -Recurse'],
      // Publish (npm / pnpm / yarn)
      ['Bash', 'pnpm publish'],
      ['Bash', 'yarn publish'],
      // Nested shells: eval, bash -c, cmd /c (including attached /c"..." and @)
      ['Bash', 'eval "git push --force"'],
      ['Bash', 'bash -c "for f in a; do rm -rf \\$f; done"'],
      ['Bash', 'cmd /c "call cortex-work release"'],
      ['PowerShell', 'cmd /c "call cortex-work release"'],
      ['Bash', 'cmd /c"git push --force"'],
      ['PowerShell', 'cmd /c"git push --force"'],
      ['Bash', 'cmd /c "if 1==1 git push --force"'],
      ['PowerShell', 'cmd /c "if 1==1 git push --force"'],
      ['PowerShell', 'cmd /c "@cortex-work release"'],
      // Here-strings `<<<` and arithmetic shifts `<<` without closing heredoc line
      ['Bash', 'grep foo <<< "$x"\ngit push --force'],
      ['Bash', 'cat <<<x; echo y\ngit push --force'],
      ['Bash', '((y = 1<<2))\ngit push --force'],
      // `cortex-work` conservative default (including unquoted echo / xargs / Start-Process)
      ['Bash', 'echo cortex-work release'],
      ['Bash', 'echo release | xargs cortex-work'],
      ['PowerShell', 'Start-Process cortex-work -ArgumentList release'],
      // All 1st & 2nd review regressions (PowerShell backticks x5, Bash \' x7, $'...')
      ['PowerShell', 'Write-Host "`n"; cortex-work release'],
      ['PowerShell', 'Write-Host "a`nb"; git push --force'],
      ['PowerShell', 'Remove-Item -Path dist `\n -Recurse -Force'],
      ['PowerShell', 'git push `\n --force origin main'],
      ['Bash', "echo Don\\'t; cortex-work release; echo It\\'s"],
      ['Bash', "echo Don\\'t; git push --force; echo It\\'s"],
      ['Bash', "echo Don\\'t && rm -rf src && echo It\\'s"],
      ['Bash', "git commit -m Don\\'t && git push --force origin main && echo It\\'s"],
      ['Bash', 'echo \\"; git push --force; echo \\"'],
      ['Bash', "echo $'a\\'b'; cortex-work release; echo 'x'"],
      ['Bash', 'echo a\\ b; git reset --hard'],
    ];

    for (const [tool, cmd] of mustGuardPairs) {
      const mainRes = callShell(tool, cmd, 'main');
      assert.equal(
        mainRes.hookSpecificOutput?.permissionDecision,
        'ask',
        `[${tool}] main must ask: ${cmd}`,
      );
      const subRes = callShell(tool, cmd, 'subagent');
      assert.equal(
        subRes.hookSpecificOutput?.permissionDecision,
        'deny',
        `[${tool}] subagent must deny: ${cmd}`,
      );
      const workerRes = callShell(tool, cmd, 'worker');
      assert.equal(
        workerRes.hookSpecificOutput?.permissionDecision,
        'deny',
        `[${tool}] worker must deny: ${cmd}`,
      );
    }

    // PowerShell -EncodedCommand reason states that encoded commands cannot be inspected
    const encAsk = callShell('PowerShell', 'powershell -enc AAAA', 'main');
    assert.match(encAsk.hookSpecificOutput.permissionDecisionReason, /인코딩된 명령은 검사할 수 없/);
    const encDeny = callShell('PowerShell', 'powershell -enc AAAA', 'worker');
    assert.match(encDeny.hookSpecificOutput.permissionDecisionReason, /인코딩된 명령은 검사할 수 없/);

    // 2. Must NOT ask (harmless commands + quoted literals + explicit cortex-work safe exceptions)
    const mustPassPairs = [
      ['Bash', 'git push'],
      ['Bash', 'git push origin main'],
      ['Bash', 'git status'],
      ['Bash', 'git add -A'],
      ['Bash', 'git diff'],
      ['Bash', 'git log --grep="git push --force"'],
      ['Bash', 'git stash'],
      ['Bash', 'git checkout -b x'],
      ['Bash', 'git rebase --continue'],
      ['Bash', 'git commit -m "fix: git push --force 버그"'],
      ['Bash', "git commit -m \"$(cat <<'EOF'\nrm -rf build\ncortex-work release\nEOF\n)\""],
      ['Bash', 'grep -rn "rm -rf" .'],
      ['Bash', 'rg "git reset --hard"'],
      ['Bash', 'echo "cortex-work release"'],
      ['Bash', 'rm file.txt'],
      ['Bash', 'rm -f a.txt'],
      ['Bash', 'rm -rf "$TEMP/x"'],
      ['Bash', 'node --test test/x.test.mjs'],
      ['Bash', 'npm test'],
      ['Bash', 'npm install'],
      ['Bash', 'pnpm publish --dry-run'],
      ['Bash', 'yarn publish --dry-run'],
      ['Bash', 'node --no-warnings scripts/cortex-worker.mjs --role developer --agent antigravity --model m --brief b.md'],
      ['Bash', 'git add scripts/cortex-work.mjs'],
      ['Bash', 'node --check scripts/cortex-work.mjs'],
      ['Bash', 'code scripts/cortex-work.mjs'],
      ['Bash', 'cortex-work status'],
      ['Bash', 'cortex-work --help'],
      ['PowerShell', 'Get-ChildItem | Where-Object { $_.Name -like "*.mjs" }'],
      ['PowerShell', 'Select-String -Pattern "git push --force" -Path x'],
      ['PowerShell', 'Write-Host "a`nb"'],
    ];

    for (const [tool, cmd] of mustPassPairs) {
      assert.deepEqual(callShell(tool, cmd, 'main'), {}, `[${tool}] main must pass: ${cmd}`);
      assert.deepEqual(callShell(tool, cmd, 'subagent'), {}, `[${tool}] subagent must pass: ${cmd}`);
      assert.deepEqual(callShell(tool, cmd, 'worker'), {}, `[${tool}] worker must pass: ${cmd}`);
    }

    // 3. `commandRunsGitCommit` with conservative unquoted-word rule anywhere in segment / nested shell
    for (const [sh, cmd] of [
      ['Bash', 'if true; then git commit -m "ok"; fi'],
      ['Bash', 'timeout 5 git commit -m "ok"'],
      ['Bash', 'cat <<< hello\ngit commit -m "ok"'],
      ['Bash', '((y = 1<<2))\ngit commit -m "ok"'],
      ['Bash', 'eval "git commit -m ok"'],
      ['PowerShell', 'Write-Host "x`n"; git commit -m y'],
      ['PowerShell', '$out = git commit -m "ok"'],
      ['PowerShell', "Write-Host 'a\u2019; git commit -m ok; Write-Host 'b'"],
      ['PowerShell', 'cmd /c "call git commit -m ok"'],
    ]) {
      assert.equal(commandRunsGitCommit(cmd, { shell: sh }), true, `[${sh}] commit expected: ${cmd}`);
    }
  } finally {
    env.cleanup();
  }
});

test('fix4: argument-position words after non-destructive git/pkg-manager/grep pass, exec/dlx/wrappers still guard, and inspection/nesting bounds fail closed under 500ms', async () => {
  const shellTokensMod = await import('../src/hooks/shell-tokens.mjs');
  assert.equal('skipCommandSubstitution' in shellTokensMod, false, 'unused skipCommandSubstitution removed');
  assert.equal('extractNestedShellScripts' in shellTokensMod, false, 'unused extractNestedShellScripts removed');
  assert.equal(shellTokensMod.PWSH_FLAGS_WITH_VALUE instanceof Set, true, 'shared PWSH_FLAGS_WITH_VALUE exported');

  const env = makeTempEnv('cortex-ws-fix4-');
  try {
    const opts = {
      terminalId: 'tab-fix4',
      globalDir: env.globalDir,
      env: { HC_TERMINAL_ID: 'tab-fix4', TEMP: os.tmpdir(), TMP: os.tmpdir() },
    };

    const callShell = (tool, command, role = 'main', extraOpts = {}) => {
      const payload = {
        session_id: 's-fix4',
        cwd: env.projectDir,
        tool_name: tool,
        tool_input: { command },
        ...(role === 'subagent' ? { agent_id: 'sub-fix4' } : {}),
      };
      const baseEnv = role === 'worker'
        ? { ...opts.env, HERDR_CORTEX_ROLE: 'worker' }
        : opts.env;
      return handleClaudePreToolUse(payload, { ...opts, env: baseEnv, ...extraOpts });
    };

    // 1. Fix 1: 13 required harmless commands (+ script-name / path-qualified / sibling grep verbs) pass in Bash & PowerShell
    const mustPass13 = [
      'git rm -r --cached node_modules',
      'git rm -r old_dir',
      'git rm -q -r --cached build',
      'pnpm rm -r lodash',
      'npm i -D rimraf cross-env',
      'npm install --save-dev rimraf typescript',
      'yarn add -D rimraf typescript',
      'pnpm add -D rimraf tsx',
      'npm view rimraf version',
      'grep -rn rimraf package.json',
      'grep rimraf -r .',
      'Select-String rimraf package.json',
      'grep -rn docker push .',
    ];
    const extraMustPass = [
      '"C:\\Program Files\\Git\\cmd\\git.exe" rm -r old_dir',
      'pnpm -r rm lodash',
      'npm rm -g rimraf',
      'npm run rm',
      'yarn rimraf',
      'bun add -d rimraf',
      'bun run rm',
      'rg -n rimraf package.json',
      'egrep -rn rimraf .',
      'fgrep rimraf package.json',
      'findstr /s rimraf package.json',
      'sls rimraf package.json',
      // Normal command with hundreds of words and 4 levels of nested substitutions
      `echo ${'word '.repeat(350)}$($($($(echo ok))))`,
      'bash -c "bash -c \'bash -c \\"bash -c echo\\" \'"',
    ];

    for (const cmd of [...mustPass13, ...extraMustPass]) {
      for (const tool of ['Bash', 'PowerShell']) {
        assert.deepEqual(callShell(tool, cmd, 'main'), {}, `[${tool}] main must pass: ${cmd}`);
        assert.deepEqual(callShell(tool, cmd, 'subagent'), {}, `[${tool}] subagent must pass: ${cmd}`);
        assert.deepEqual(callShell(tool, cmd, 'worker'), {}, `[${tool}] worker must pass: ${cmd}`);
      }
    }

    // 2. Fix 1: 15 required dangerous commands (+ remaining tool-executing subcommands & substitutions) ask/deny in Bash & PowerShell
    const mustGuard15 = [
      'sudo rm -rf x',
      'xargs rm -rf',
      'find . -exec rm -rf {} +',
      'then rm -rf x',
      'nice rm -rf x',
      'timeout 5 rm -rf x',
      'docker exec c rm -rf /data',
      'npx rimraf build',
      'pnpm dlx rimraf x',
      'npm exec rimraf x',
      'yarn dlx rimraf x',
      'bunx rimraf x',
      'git status && rm -rf x',
      'git status; rm -rf x',
      'grep foo x | xargs rm -rf',
    ];
    const extraMustGuard = [
      'npm x rimraf x',
      'pnpm exec rimraf x',
      'yarn exec rimraf x',
      'bun x rimraf x',
      'pnpm --filter git dlx rimraf x',
      'npm exec -- rimraf dist',
      'git push --force',
      'git reset --hard',
      'npm publish',
      // `cortex-work` conservative rule remains unchanged
      'cp scripts/cortex-work.mjs backup/',
    ];

    for (const cmd of [...mustGuard15, ...extraMustGuard]) {
      for (const tool of ['Bash', 'PowerShell']) {
        assert.equal(
          callShell(tool, cmd, 'main').hookSpecificOutput?.permissionDecision,
          'ask',
          `[${tool}] main must ask: ${cmd}`,
        );
        assert.equal(
          callShell(tool, cmd, 'subagent').hookSpecificOutput?.permissionDecision,
          'deny',
          `[${tool}] subagent must deny: ${cmd}`,
        );
        assert.equal(
          callShell(tool, cmd, 'worker').hookSpecificOutput?.permissionDecision,
          'deny',
          `[${tool}] worker must deny: ${cmd}`,
        );
      }
    }
    // Command substitution inside `grep` / `git` argument is still inspected
    assert.equal(callShell('Bash', 'grep "$(rm -rf src)" package.json', 'main').hookSpecificOutput?.permissionDecision, 'ask');
    assert.equal(callShell('Bash', 'grep "$(rm -rf src)" package.json', 'subagent').hookSpecificOutput?.permissionDecision, 'deny');

    // 3. Fix 2: 5+ layer nesting and excessive inspection work fail closed (ask in main, deny in subagent/worker)
    //    with reason mentioning complexity/length, and finishhook process under 500ms; `confirmCommands: false` passes.
    const fiveDeepSubst = `${'$('.repeat(5)}echo ok${')'.repeat(5)}`;
    const fiveDeepEval = 'eval "eval \\"eval \'eval `echo ok`\'\\""';
    for (const deepCmd of [fiveDeepSubst, fiveDeepEval]) {
      const mainDeep = callShell('Bash', deepCmd, 'main');
      assert.equal(mainDeep.hookSpecificOutput?.permissionDecision, 'ask', deepCmd);
      assert.match(mainDeep.hookSpecificOutput.permissionDecisionReason, /명령이 너무 길거나 복잡해 검사를 끝내지 못했다/);
      const subDeep = callShell('Bash', deepCmd, 'subagent');
      assert.equal(subDeep.hookSpecificOutput?.permissionDecision, 'deny', deepCmd);
      assert.match(subDeep.hookSpecificOutput.permissionDecisionReason, /명령이 너무 길거나 복잡해 검사를 끝내지 못했다/);
    }

    const boundedInputs = [
      'xargs echo a '.repeat(80),
      'find . -exec '.repeat(80),
      'a '.repeat(50000),
    ];

    const childEnv = {
      ...process.env,
      USERPROFILE: env.homeDir,
      HOME: env.homeDir,
      HERDR_CORTEX_TEST_HOME: env.homeDir,
      HERDR_CORTEX_HOME: env.globalDir,
      HC_TERMINAL_ID: 'tab-fix4',
    };
    delete childEnv.HERDR_CORTEX_ROLE;
    delete childEnv.CLAUDE_PROJECT_DIR;

    // Warm one child process so OS file cache is hot before measuring 500ms process budget
    await spawnPreToolUseHook(
      { session_id: 's-warm', cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: 'echo ok' } },
      childEnv,
    );

    for (const heavyCmd of boundedInputs) {
      const mainInProc = callShell('Bash', heavyCmd, 'main');
      assert.equal(mainInProc.hookSpecificOutput?.permissionDecision, 'ask');
      assert.match(mainInProc.hookSpecificOutput.permissionDecisionReason, /명령이 너무 길거나 복잡해 검사를 끝내지 못했다/);
      assert.equal(callShell('Bash', heavyCmd, 'subagent').hookSpecificOutput?.permissionDecision, 'deny');
      assert.equal(callShell('Bash', heavyCmd, 'worker').hookSpecificOutput?.permissionDecision, 'deny');

      const tMain = performance.now();
      const procMain = await spawnPreToolUseHook(
        { session_id: 's-heavy', cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: heavyCmd } },
        childEnv,
      );
      const mainElapsed = performance.now() - tMain;
      assert.equal(procMain.code, 0);
      assert.equal(procMain.decision, 'ask');
      assert.ok(mainElapsed < 500, `main hook exceeded 500ms (${mainElapsed.toFixed(1)}ms) on len=${heavyCmd.length}`);

      const tSub = performance.now();
      const procSub = await spawnPreToolUseHook(
        { session_id: 's-heavy', agent_id: 'sub-h', cwd: env.projectDir, tool_name: 'Bash', tool_input: { command: heavyCmd } },
        childEnv,
      );
      const subElapsed = performance.now() - tSub;
      assert.equal(procSub.code, 0);
      assert.equal(procSub.decision, 'deny');
      assert.ok(subElapsed < 500, `subagent hook exceeded 500ms (${subElapsed.toFixed(1)}ms) on len=${heavyCmd.length}`);
    }

    // `confirmCommands: false` passes even when exceeding inspection/nesting limits
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { workSize: { confirmCommands: false } });
    for (const cmd of [...boundedInputs, fiveDeepSubst]) {
      assert.deepEqual(callShell('Bash', cmd, 'main'), {});
      assert.deepEqual(callShell('Bash', cmd, 'subagent'), {});
    }
  } finally {
    env.cleanup();
  }
});

test('fix5: embedded-command subcommands (git submodule foreach/bisect run, yarn workspace/workspaces foreach, pnpm recursive exec) and pnpm --filter/-F publish guard in Bash & PowerShell', () => {
  const env = makeTempEnv('cortex-ws-fix5-');
  try {
    const opts = {
      terminalId: 'tab-fix5',
      globalDir: env.globalDir,
      env: { HC_TERMINAL_ID: 'tab-fix5', TEMP: os.tmpdir(), TMP: os.tmpdir() },
    };

    const callShell = (tool, command, role = 'main') => {
      const payload = {
        session_id: 's-fix5',
        cwd: env.projectDir,
        tool_name: tool,
        tool_input: { command },
        ...(role === 'subagent' ? { agent_id: 'sub-fix5' } : {}),
      };
      const baseEnv = role === 'worker'
        ? { ...opts.env, HERDR_CORTEX_ROLE: 'worker' }
        : opts.env;
      return handleClaudePreToolUse(payload, { ...opts, env: baseEnv });
    };

    const mustGuard = [
      'git submodule foreach --recursive git reset --hard',
      'git submodule foreach --recursive git clean -fdx',
      'git submodule foreach git reset --hard',
      'git submodule foreach rm -rf x',
      'git bisect run rm -rf x',
      'yarn workspaces foreach --all npm publish',
      'yarn workspaces foreach -A --topological npm publish --tolerate-republish',
      'yarn workspace @scope/a npm publish --access public',
      'yarn workspace a npm publish',
      'yarn workspaces foreach -A exec rm -rf dist',
      'yarn workspace web exec rm -rf dist',
      'pnpm recursive exec rm -rf dist',
      'pnpm --filter a publish',
      'pnpm -F a publish',
      'pnpm -r --filter ./packages/** publish',
    ];

    for (const cmd of mustGuard) {
      for (const tool of ['Bash', 'PowerShell']) {
        const match = inspectConfirmableShellCommand(cmd, { env: opts.env, shell: tool });
        assert.equal(match.matched, true, `[${tool}] expected match for: ${cmd}`);
        assert.ok(match.rule, `[${tool}] expected rule for: ${cmd}`);
        assert.equal(
          callShell(tool, cmd, 'main').hookSpecificOutput?.permissionDecision,
          'ask',
          `[${tool}] main must ask: ${cmd}`,
        );
        assert.equal(
          callShell(tool, cmd, 'subagent').hookSpecificOutput?.permissionDecision,
          'deny',
          `[${tool}] subagent must deny: ${cmd}`,
        );
        assert.equal(
          callShell(tool, cmd, 'worker').hookSpecificOutput?.permissionDecision,
          'deny',
          `[${tool}] worker must deny: ${cmd}`,
        );
      }
    }

    const mustPass = [
      'git submodule update --init --recursive',
      'git submodule foreach git status',
      'git submodule status',
      'git bisect start',
      'git bisect good',
      'yarn workspace a build',
      'yarn workspaces foreach -A run build',
      'yarn workspaces list',
      'pnpm recursive install',
      'pnpm --filter a build',
      'pnpm -F a test',
      'pnpm --filter a publish --dry-run',
      'git rm -r --cached node_modules',
      'npm i -D rimraf cross-env',
      'grep -rn rimraf package.json',
    ];

    for (const cmd of mustPass) {
      for (const tool of ['Bash', 'PowerShell']) {
        assert.equal(
          inspectConfirmableShellCommand(cmd, { env: opts.env, shell: tool }).matched,
          false,
          `[${tool}] must NOT match: ${cmd}`,
        );
        assert.deepEqual(callShell(tool, cmd, 'main'), {}, `[${tool}] main must pass: ${cmd}`);
        assert.deepEqual(callShell(tool, cmd, 'subagent'), {}, `[${tool}] subagent must pass: ${cmd}`);
        assert.deepEqual(callShell(tool, cmd, 'worker'), {}, `[${tool}] worker must pass: ${cmd}`);
      }
    }
  } finally {
    env.cleanup();
  }
});

test('Antigravity PreToolUse & PostToolUse: unconditional decision safety & exit 0, limits/L escalation, ask-not-allow, non-counting sessions, workspacePaths[0] root, confirmCommands force_ask/deny, error-only failure counting, and MCP memory_save', () => {
  const env = makeTempEnv('cortex-ws-agy-tools-');
  const agyHookScript = path.join(REPO_ROOT, 'src', 'hooks', 'antigravity-tool-entry.mjs');
  try {
    // 1. Registered matchers match observed Antigravity tools and skip unrelated / other-server tools on PreToolUse
    const preRe = new RegExp(`^(?:${ANTIGRAVITY_PRE_TOOL_USE_MATCHER})$`);
    const postRe = new RegExp(`^(?:${ANTIGRAVITY_POST_TOOL_USE_MATCHER})$`);
    for (const name of ['write_file', 'edit_file', 'run_command', 'read_file', 'call_mcp_tool', 'mcp__herdr-cortex__memory_save', 'mcp__cortex__memory_save', 'herdr-cortex:memory_save', 'memory_save']) {
      assert.equal(preRe.test(name), true, `PreToolUse matcher must match: ${name}`);
    }
    for (const name of ['run_command', 'call_mcp_tool', 'mcp__herdr-cortex__memory_save', 'herdr-cortex:memory_save', 'memory_save', 'mcp__other__memory_save']) {
      assert.equal(postRe.test(name), true, `PostToolUse matcher must match: ${name}`);
    }
    for (const unrelated of ['search_web', 'ask_question', 'update_steps', 'invoke_subagent', 'mcp__other__memory_save', 'other_server:memory_save']) {
      assert.equal(preRe.test(unrelated), false, `PreToolUse matcher must skip: ${unrelated}`);
    }
    for (const unrelated of ['search_web', 'ask_question', 'update_steps', 'invoke_subagent']) {
      assert.equal(postRe.test(unrelated), false, `PostToolUse matcher must skip: ${unrelated}`);
    }

    // 2. CLI subprocess safety: ALWAYS emits valid decision JSON + exit code 0 on empty stdin, malformed JSON,
    //    unknown tools, missing toolCall fields, and unwritable work-size state folder
    const baseChildEnv = {
      ...process.env,
      HERDR_CORTEX_TEST_HOME: env.homeDir,
      HERDR_CORTEX_HOME: env.globalDir,
      HC_TERMINAL_ID: 't-agy-safe',
    };
    delete baseChildEnv.HERDR_CORTEX_ROLE;

    const runCliPre = (rawInput, extraEnv = {}) => spawnSync(
      process.execPath,
      ['--no-warnings', agyHookScript, 'pre-tool-use', '--id', 'herdr-cortex'],
      {
        cwd: env.projectDir,
        env: { ...baseChildEnv, ...extraEnv },
        input: rawInput,
        encoding: 'utf8',
        windowsHide: true,
      },
    );

    const brokenGlobalDir = path.join(env.root, 'unwritable-global');
    fs.mkdirSync(path.join(brokenGlobalDir, 'state'), { recursive: true });
    // Put a regular file at `<global>/state/work-size` so mkdirSync/lock inside work-size fails!
    fs.writeFileSync(path.join(brokenGlobalDir, 'state', 'work-size'), 'blocking-file', 'utf8');

    for (const [label, stdinText, extraEnv] of [
      ['empty stdin', '', {}],
      ['whitespace stdin', '   \r\n ', {}],
      ['malformed JSON', '{not valid json', {}],
      ['JSON array', '[1,2,3]', {}],
      ['JSON primitive', '"hello"', {}],
      ['missing toolCall', JSON.stringify({ conversationId: 'c1', rootConversationId: 'c1', cwd: env.projectDir }), {}],
      ['null toolCall', JSON.stringify({ conversationId: 'c1', rootConversationId: 'c1', toolCall: null }), {}],
      ['missing toolCall.name', JSON.stringify({ conversationId: 'c1', rootConversationId: 'c1', toolCall: { id: '1', args: {} } }), {}],
      ['null toolCall.args', JSON.stringify({ conversationId: 'c1', rootConversationId: 'c1', cwd: env.projectDir, toolCall: { id: '1', name: 'write_file', args: null } }), {}],
      ['unknown tool', JSON.stringify({ conversationId: 'c1', rootConversationId: 'c1', cwd: env.projectDir, toolCall: { id: '1', name: 'search_web', args: { query: 'test' } } }), {}],
      ['unwritable state directory', JSON.stringify({
        conversationId: 'c1',
        rootConversationId: 'c1',
        cwd: env.projectDir,
        workspacePaths: [env.projectDir],
        lastUserInput: 'edit file',
        toolCall: { id: '1', name: 'write_file', args: { Path: path.join(env.projectDir, 'a.js'), Content: 'x'.repeat(2000) } },
      }), { HERDR_CORTEX_HOME: brokenGlobalDir }],
    ]) {
      const res = runCliPre(stdinText, extraEnv);
      assert.equal(res.status, 0, `${label}: exit code must be 0 (stderr=${res.stderr})`);
      const parsed = JSON.parse(res.stdout.trim());
      assert.deepEqual(parsed, { decision: 'ask' }, `${label}: must fall back to {"decision":"ask"}`);
    }

    // In-process exception safety: throwing inside options (`now` throwing) still returns {"decision":"ask"}
    const thrownRes = runAntigravityHook(
      'pre-tool-use',
      {
        conversationId: 'c1',
        rootConversationId: 'c1',
        cwd: env.projectDir,
        workspacePaths: [env.projectDir],
        toolCall: { id: '1', name: 'write_file', args: { Path: path.join(env.projectDir, 'a.js'), Content: 'abc' } },
      },
      {
        globalDir: env.globalDir,
        terminalId: 't-agy-safe',
        now: () => {
          throw new Error('boom inside clock');
        },
      },
    );
    assert.deepEqual(thrownRes, { decision: 'ask' });
    assert.deepEqual(runAntigravityHook('post-tool-use', null, {}), {});

    // 3. Non-counting sessions: worker, subagent, unknown role, excluded project, workSize.enabled=false
    const hooksConfigDir = path.join(env.homeDir, '.gemini', 'config');
    fs.mkdirSync(hooksConfigDir, { recursive: true });
    const opts = { terminalId: 't-agy-main', globalDir: env.globalDir, env: { HC_TERMINAL_ID: 't-agy-main', TEMP: os.tmpdir(), TMP: os.tmpdir() } };
    const bigWriteCall = { id: 'tc-big', name: 'write_file', args: { Path: path.join(env.projectDir, 'big.js'), Content: 'x'.repeat(2500) } };

    // Unknown role (no rootConversationId, no transcript, empty lastUserInput) -> passes as ask without counting
    assert.deepEqual(
      handleAntigravityPreToolUse({ conversationId: 'c-unk', cwd: env.projectDir, workspacePaths: [env.projectDir], toolCall: bigWriteCall }, opts),
      { decision: 'ask' },
    );
    // Subagent (rootConversationId !== conversationId, or subagent message in lastUserInput) -> passes without counting
    assert.deepEqual(
      handleAntigravityPreToolUse({ conversationId: 'c-sub', rootConversationId: 'c-root', cwd: env.projectDir, workspacePaths: [env.projectDir], toolCall: bigWriteCall }, opts),
      { decision: 'ask' },
    );
    assert.deepEqual(
      handleAntigravityPreToolUse({
        conversationId: 'c-sub2',
        cwd: env.projectDir,
        workspacePaths: [env.projectDir],
        lastUserInput: '[Message] timestamp=2026-11-27T00:00:00Z sender=parent12345 content=do task',
        toolCall: bigWriteCall,
      }, opts),
      { decision: 'ask' },
    );
    // Worker session -> passes without counting
    assert.deepEqual(
      handleAntigravityPreToolUse(
        { conversationId: 'c-root', rootConversationId: 'c-root', cwd: env.projectDir, workspacePaths: [env.projectDir], toolCall: bigWriteCall },
        { ...opts, env: { ...opts.env, HERDR_CORTEX_ROLE: 'worker' } },
      ),
      { decision: 'ask' },
    );
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-main'), { cwd: env.projectDir }), null);

    // Excluded project & workSize.enabled: false -> passes without counting
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { excludedProjects: [env.projectDir] });
    assert.deepEqual(
      handleAntigravityPreToolUse({ conversationId: 'c-root', rootConversationId: 'c-root', cwd: env.projectDir, workspacePaths: [env.projectDir], toolCall: bigWriteCall }, opts),
      { decision: 'ask' },
    );
    atomicWriteJson(path.join(env.globalDir, 'config.json'), { workSize: { enabled: false } });
    assert.deepEqual(
      handleAntigravityPreToolUse({ conversationId: 'c-root', rootConversationId: 'c-root', cwd: env.projectDir, workspacePaths: [env.projectDir], toolCall: bigWriteCall }, opts),
      { decision: 'ask' },
    );
    atomicWriteJson(path.join(env.globalDir, 'config.json'), DEFAULT_CONFIG);
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-main'), { cwd: env.projectDir }), null);

    // 4. workspacePaths[0] takes precedence over cwd (e.g. hooks.json folder); missing workspacePaths[0] falls back
    assert.equal(
      resolveWorkSizeProjectRoot({ cwd: hooksConfigDir, workspacePaths: [env.projectDir, env.projectB] }),
      env.projectDir,
    );
    assert.equal(
      resolveWorkSizeProjectRoot({ cwd: env.projectB, workspacePaths: [path.join(env.root, 'no-such-ws'), env.projectDir] }),
      env.projectB,
    );

    // 5. Limits, ask-not-allow, S -> L escalation, PostToolUse error-only failure counting, git commit, and MCP memory_save
    const srcSubdir = path.join(env.projectDir, 'src');
    fs.mkdirSync(srcSubdir, { recursive: true });
    const rootBase = {
      conversationId: 'c-root',
      cwd: srcSubdir,
      workspacePaths: [env.projectDir],
      lastUserInput: 'implement feature',
    };
    const fileA = path.join(env.projectDir, 'src', 'a.js');
    const fileB = path.join(env.projectDir, 'src', 'b.js');

    const w1 = handleAntigravityPreToolUse(
      { ...rootBase, cwd: hooksConfigDir, toolCall: { id: '1', name: 'write_file', args: { Path: fileA, Content: 'a'.repeat(600), Overwrite: true } } },
      opts,
    );
    assert.deepEqual(w1, { decision: 'ask' }, 'pass must be ask, NEVER allow');
    const e1 = handleAntigravityPreToolUse(
      { ...rootBase, cwd: hooksConfigDir, toolCall: { id: '2', name: 'edit_file', args: { Path: fileA, Target: 'a', Replacement: 'b'.repeat(400) } } },
      opts,
    );
    assert.deepEqual(e1, { decision: 'ask' }, 'exact 1,000-char boundary passes as ask');

    const over = handleAntigravityPreToolUse(
      { ...rootBase, cwd: hooksConfigDir, toolCall: { id: '3', name: 'edit_file', args: { Path: fileA, Target: 'b', Replacement: 'c' } } },
      opts,
    );
    assert.equal(over.decision, 'deny');
    assert.match(over.reason, /1,001자/);
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-main'), { cwd: env.projectDir }).size, 'L');

    // PostToolUse on run_command: empty `error: ""` is NOT counted as failure, and `git commit` outside project does NOT clear
    handleAntigravityPostToolUse(
      { ...rootBase, error: '', toolCall: { id: '4', name: 'run_command', args: { CommandLine: 'npm test', WaitMsBeforeAsync: 5000, toolSummary: 'Test' } } },
      opts,
    );
    assert.deepEqual(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-main'), { cwd: env.projectDir }).failedRetries, {});

    handleAntigravityPostToolUse(
      { ...rootBase, cwd: hooksConfigDir, error: '', toolCall: { id: '5-out', name: 'run_command', args: { CommandLine: 'git commit -m "outside"' } } },
      opts,
    );
    assert.deepEqual(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-main'), { cwd: env.projectDir }).files, { 'src/a.js': 1000 });

    // In-project `git commit` (from project or subfolder `srcSubdir`) clears cumulative window!
    handleAntigravityPostToolUse(
      { ...rootBase, error: '', toolCall: { id: '5', name: 'run_command', args: { CommandLine: 'git commit -m "clear"' } } },
      opts,
    );
    assert.deepEqual(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-main'), { cwd: env.projectDir }).files, {});

    for (let attempt = 1; attempt <= 2; attempt++) {
      assert.deepEqual(
        handleAntigravityPreToolUse(
          { ...rootBase, toolCall: { id: `f-${attempt}`, name: 'edit_file', args: { Path: fileB, Target: 'x', Replacement: 'y' } } },
          opts,
        ),
        { decision: 'ask' },
      );
      handleAntigravityPostToolUse(
        { ...rootBase, error: 'Command failed with exit code 1', toolCall: { id: `r-${attempt}`, name: 'run_command', args: { CommandLine: 'npm test' } } },
        opts,
      );
    }
    const failBlocked = handleAntigravityPreToolUse(
      { ...rootBase, toolCall: { id: 'f-3', name: 'edit_file', args: { Path: fileB, Target: 'x', Replacement: 'z' } } },
      opts,
    );
    assert.equal(failBlocked.decision, 'deny');
    assert.match(failBlocked.reason, /명령 실패가 2회 되풀이/);

    // MCP `memory_save` via Antigravity `call_mcp_tool` AND via `*memory_save` suffix clears window & records memorySaved!
    handleAntigravityPostToolUse(
      {
        ...rootBase,
        error: '',
        toolCall: {
          id: 'mcp-1',
          name: 'call_mcp_tool',
          args: { ServerName: 'herdr-cortex', ToolName: 'memory_save', Arguments: { type: 'worklog', title: 't', summary: 's' } },
        },
      },
      opts,
    );
    const afterMcpSave = readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-main'), { cwd: env.projectDir });
    assert.deepEqual(afterMcpSave.files, {});
    assert.deepEqual(afterMcpSave.failedRetries, {});
    assert.equal(afterMcpSave.memorySaved, true);

    // Suffix `herdr-cortex_memory_save` with non-empty `error` does NOT clear; empty `error` DOES clear
    handleAntigravityPreToolUse(
      { ...rootBase, toolCall: { id: 'w-b', name: 'write_file', args: { Path: fileB, Content: 'hello' } } },
      opts,
    );
    handleAntigravityPostToolUse(
      { ...rootBase, error: 'MCP tool error', toolCall: { id: 'mcp-err', name: 'custom_memory_save', args: {} } },
      opts,
    );
    assert.deepEqual(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-main'), { cwd: env.projectDir }).files, { 'src/b.js': 5 });
    handleAntigravityPostToolUse(
      { ...rootBase, error: '', toolCall: { id: 'mcp-ok', name: 'custom_memory_save', args: {} } },
      opts,
    );
    assert.deepEqual(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-main'), { cwd: env.projectDir }).files, {});

    // 6. Hard-to-reverse commands on `run_command`: `force_ask` in main, `deny` in subagent & worker, `ask` for safe commands
    const hardCmd = 'git reset --hard HEAD~1';
    const mainHard = handleAntigravityPreToolUse(
      { ...rootBase, toolCall: { id: 'sh-1', name: 'run_command', args: { CommandLine: hardCmd } } },
      opts,
    );
    assert.equal(mainHard.decision, 'force_ask');
    assert.match(mainHard.reason, /되돌리기 어려운 셸 명령/);

    const subHard = handleAntigravityPreToolUse(
      { ...rootBase, rootConversationId: 'other-root', toolCall: { id: 'sh-2', name: 'run_command', args: { CommandLine: hardCmd } } },
      opts,
    );
    assert.equal(subHard.decision, 'deny');

    const workerHard = handleAntigravityPreToolUse(
      { ...rootBase, toolCall: { id: 'sh-3', name: 'run_command', args: { CommandLine: hardCmd } } },
      { ...opts, env: { ...opts.env, HERDR_CORTEX_ROLE: 'worker' } },
    );
    assert.equal(workerHard.decision, 'deny');

    const safeShell = handleAntigravityPreToolUse(
      { ...rootBase, toolCall: { id: 'sh-4', name: 'run_command', args: { CommandLine: 'git status' } } },
      opts,
    );
    assert.deepEqual(safeShell, { decision: 'ask' });
  } finally {
    env.cleanup();
  }
});

test('Cross-host state continuity (Claude Code <-> Antigravity) and deferred non-blocking notices in next PreInvocation within hookBudget', () => {
  const env = makeTempEnv('cortex-ws-cross-host-');
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    // Seed an active decision referencing `src/dep.js` in SQLite index so dependency notice triggers on first edit
    store.saveDoc({
      id: 'dec-agy-dep',
      type: 'decision',
      title: 'Dep Contract',
      summary: 'Keep src/dep.js output stable',
      files: ['src/dep.js'],
    });
    store.close();

    const sharedOpts = {
      terminalId: 't-shared',
      globalDir: env.globalDir,
      homeDir: env.homeDir,
      promptsDir: env.promptsDir,
      env: { HC_TERMINAL_ID: 't-shared' },
    };

    // 1. Accumulate 600 chars in Claude Code, then switch to Antigravity in the SAME tab -> state continues seamlessly!
    assert.deepEqual(
      handleClaudePreToolUse(
        { session_id: 'cl-1', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'src/dep.js', content: 'x'.repeat(600) } },
        sharedOpts,
      ).hookSpecificOutput?.permissionDecision,
      undefined,
    );

    const agyDeny = handleAntigravityPreToolUse(
      {
        conversationId: 'agy-1',
        rootConversationId: 'agy-1',
        cwd: env.projectDir,
        workspacePaths: [env.projectDir],
        lastUserInput: 'continue in agy',
        toolCall: { id: '1', name: 'edit_file', args: { Path: path.join(env.projectDir, 'src', 'dep.js'), Target: 'x', Replacement: 'y'.repeat(500) } },
      },
      sharedOpts,
    );
    assert.equal(agyDeny.decision, 'deny');
    assert.match(agyDeny.reason, /1,100자/);
    assert.equal(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-shared'), { cwd: env.projectDir }).size, 'L');

    // Switching back to Claude Code in the same tab sees L escalated by Antigravity!
    const claudeStart = handleClaudeSessionStart({ session_id: 'cl-2', source: 'startup', cwd: env.projectDir }, { ...sharedOpts, part: 'context' });
    assert.match(claudeStart.hookSpecificOutput?.additionalContext || '', /진행 중인 L 작업/);
    assert.equal(
      handleClaudePreToolUse(
        { session_id: 'cl-2', cwd: env.projectDir, tool_name: 'Write', tool_input: { file_path: 'src/second.js', content: 'z' } },
        sharedOpts,
      ).hookSpecificOutput?.permissionDecision,
      'deny',
    );

    // Antigravity SessionStart ALSO shows the unfinished L notice
    const agyStart = handleAntigravitySessionStart(
      { conversationId: 'agy-start-1', rootConversationId: 'agy-start-1', cwd: env.projectDir, workspacePaths: [env.projectDir] },
      sharedOpts,
    );
    const agyStartTexts = (agyStart.injectSteps || []).map((s) => s.systemMessage.systemMessage);
    assert.ok(agyStartTexts.some((t) => t.includes('진행 중인 L 작업')));

    // 2. Non-blocking notices (dependency notice, read-volume notice, unsaved/periodic reminders, L completion notice)
    //    are queued and emitted ONCE in the next `PreInvocation` within `hookBudget`, then cleared!
    atomicWriteJson(path.join(env.globalDir, 'config.json'), {
      hookBudget: 4000,
      workSize: { readNoticeThreshold: 2, reminderEveryTurns: 2 },
    });
    const noticeOpts = {
      terminalId: 't-agy-notices',
      globalDir: env.globalDir,
      homeDir: env.homeDir,
      promptsDir: env.promptsDir,
      env: { HC_TERMINAL_ID: 't-agy-notices' },
    };
    const convBase = {
      conversationId: 'agy-notice-conv',
      rootConversationId: 'agy-notice-conv',
      cwd: env.projectDir,
      workspacePaths: [env.projectDir],
    };

    // Turn 1 startup PreInvocation
    handleAntigravityPreInvocation({ ...convBase, initialNumSteps: 0, invocationNum: 0, lastUserInput: 'Turn 1 prompt' }, noticeOpts);

    // Edit `src/dep.js` (queues dependency notice) + 3 `read_file` calls in same turn (3rd > threshold 2 -> queues read notice)
    assert.deepEqual(
      handleAntigravityPreToolUse(
        { ...convBase, lastUserInput: 'Turn 1 prompt', toolCall: { id: 'e1', name: 'write_file', args: { Path: path.join(env.projectDir, 'src', 'dep.js'), Content: 'abc' } } },
        noticeOpts,
      ),
      { decision: 'ask' },
    );
    for (let r = 1; r <= 3; r++) {
      assert.deepEqual(
        handleAntigravityPreToolUse(
          { ...convBase, lastUserInput: 'Turn 1 prompt', toolCall: { id: `r-${r}`, name: 'read_file', args: { Path: path.join(env.projectDir, 'src', 'dep.js') } } },
          noticeOpts,
        ),
        { decision: 'ask' },
      );
    }

    // Mid-turn PreInvocation (`invocationNum: 1`, same `initialNumSteps: 0` and `lastUserInput`) flushes BOTH queued notices once!
    const midTurn = handleAntigravityPreInvocation(
      { ...convBase, initialNumSteps: 0, invocationNum: 1, lastUserInput: 'Turn 1 prompt' },
      noticeOpts,
    );
    const midTexts = (midTurn.injectSteps || []).map((s) => s.systemMessage.systemMessage);
    assert.ok(midTexts.some((t) => t.includes('dec-agy-dep')), `expected dependency notice in: ${JSON.stringify(midTexts)}`);
    assert.ok(midTexts.some((t) => t.includes('읽기·검색 도구를 3회 호출')), `expected read notice in: ${JSON.stringify(midTexts)}`);
    assert.ok(midTexts.reduce((acc, s) => acc + s.length, 0) <= 4000, 'within hookBudget');

    // Immediately following mid-turn PreInvocation (`invocationNum: 2`) does NOT repeat them!
    const midTurn2 = handleAntigravityPreInvocation(
      { ...convBase, initialNumSteps: 0, invocationNum: 2, lastUserInput: 'Turn 1 prompt' },
      noticeOpts,
    );
    assert.deepEqual(midTurn2, {});

    // Turn 2 (`initialNumSteps: 5`, new user turn, 2nd prompt -> `reminderEveryTurns: 2`): emits unsaved + periodic reminders!
    const turn2 = handleAntigravityPreInvocation(
      { ...convBase, initialNumSteps: 5, invocationNum: 0, lastUserInput: 'Turn 2 prompt' },
      noticeOpts,
    );
    const turn2Texts = (turn2.injectSteps || []).map((s) => s.systemMessage.systemMessage);
    assert.ok(turn2Texts.some((t) => t.includes('미저장 활동(편집 파일 1개')), `expected unsaved reminder: ${JSON.stringify(turn2Texts)}`);
    assert.ok(turn2Texts.some((t) => t.includes('지금 상태: S')), `expected periodic reminder: ${JSON.stringify(turn2Texts)}`);

    // Escalate to L, record review ACCEPT + memory_save -> next PreInvocation emits WORK_SIZE_COMPLETED_NOTICE once!
    const esc = handleAntigravityPreToolUse(
      { ...convBase, lastUserInput: 'Turn 2 prompt', toolCall: { id: 'e2', name: 'write_file', args: { Path: path.join(env.projectDir, 'src', 'other.js'), Content: 'xyz' } } },
      noticeOpts,
    );
    assert.equal(esc.decision, 'deny');
    handleClaudeSubagentStop({ cwd: env.projectDir, last_assistant_message: '최종 판정: ACCEPT' }, noticeOpts);
    handleAntigravityPostToolUse(
      {
        ...convBase,
        error: '',
        lastUserInput: 'Turn 2 prompt',
        toolCall: { id: 'ms-1', name: 'call_mcp_tool', args: { ServerName: 'herdr-cortex', ToolName: 'memory_save', Arguments: { type: 'worklog' } } },
      },
      noticeOpts,
    );

    const afterComplete = handleAntigravityPreInvocation(
      { ...convBase, initialNumSteps: 5, invocationNum: 3, lastUserInput: 'Turn 2 prompt' },
      noticeOpts,
    );
    const completeTexts = (afterComplete.injectSteps || []).map((s) => s.systemMessage.systemMessage);
    assert.deepEqual(completeTexts, [WORK_SIZE_COMPLETED_NOTICE]);
    assert.deepEqual(
      handleAntigravityPreInvocation({ ...convBase, initialNumSteps: 5, invocationNum: 4, lastUserInput: 'Turn 2 prompt' }, noticeOpts),
      {},
    );
  } finally {
    try { store.close(); } catch { /* already closed */ }
    env.cleanup();
  }
});

test('Antigravity tool entry resilience (broken module copy), UNC/long-path fast guard, MCP server-name scoping, and dual-shell run_command inspection', () => {
  const env = makeTempEnv('cortex-ws-agy-fix-');
  try {
    // 1. `antigravity-tool-entry.mjs` has ONLY `node:` static imports
    const entrySrcPath = path.join(REPO_ROOT, 'src', 'hooks', 'antigravity-tool-entry.mjs');
    const entrySrc = fs.readFileSync(entrySrcPath, 'utf8');
    const staticImports = [...entrySrc.matchAll(/^\s*import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(staticImports.length >= 1, 'expected at least one built-in import');
    for (const spec of staticImports) {
      assert.ok(spec.startsWith('node:'), `antigravity-tool-entry.mjs must only statically import node: built-ins, saw "${spec}"`);
    }

    // 2. Break modules inside an isolated temporary copy of `src/` (syntax error, missing export, top-level throw,
    //    missing file, invalid return value) and run `antigravity-tool-entry.mjs` as a real child process
    const copyRoot = path.join(env.root, 'repo-copy');
    fs.cpSync(path.join(REPO_ROOT, 'src'), path.join(copyRoot, 'src'), { recursive: true });
    const copyEntry = path.join(copyRoot, 'src', 'hooks', 'antigravity-tool-entry.mjs');
    const childEnv = {
      ...process.env,
      HERDR_CORTEX_TEST_HOME: env.homeDir,
      HERDR_CORTEX_HOME: env.globalDir,
      HC_TERMINAL_ID: 't-entry-copy',
    };
    delete childEnv.HERDR_CORTEX_ROLE;

    const samplePayload = JSON.stringify({
      conversationId: 'c1',
      rootConversationId: 'c1',
      cwd: env.projectDir,
      workspacePaths: [env.projectDir],
      lastUserInput: 'edit file',
      toolCall: { id: '1', name: 'write_file', args: { Path: path.join(env.projectDir, 'a.js'), Content: 'abc' } },
    });

    const runCopyEntry = (eventArg, stdinInput = samplePayload, extraEnv = {}) => spawnSync(
      process.execPath,
      ['--no-warnings', copyEntry, eventArg, '--id', 'herdr-cortex'],
      { cwd: env.projectDir, env: { ...childEnv, ...extraEnv }, input: stdinInput, encoding: 'utf8', windowsHide: true },
    );

    const mutations = [
      {
        label: 'syntax error in work-size.mjs',
        rel: 'src/hooks/work-size.mjs',
        mutate: (s) => `${s}\nconst = ;\n`,
      },
      {
        label: 'syntax error in confirm-commands.mjs',
        rel: 'src/hooks/confirm-commands.mjs',
        mutate: (s) => `${s}\nfunction broken( { \n`,
      },
      {
        label: 'syntax error in antigravity.mjs',
        rel: 'src/hooks/antigravity.mjs',
        mutate: (s) => `${s}\nexport const = 1;\n`,
      },
      {
        label: 'missing export in tool-names.mjs',
        rel: 'src/hooks/tool-names.mjs',
        mutate: (s) => s.replace('export const ANTIGRAVITY_SHELL_TOOL_NAMES', 'const ANTIGRAVITY_SHELL_TOOL_NAMES'),
      },
      {
        label: 'missing runAntigravityHook export in antigravity.mjs',
        rel: 'src/hooks/antigravity.mjs',
        mutate: (s) => s.replace('export function runAntigravityHook', 'function runAntigravityHook'),
      },
      {
        label: 'top-level exception + console.log noise in work-size.mjs',
        rel: 'src/hooks/work-size.mjs',
        mutate: (s) => `console.log('STDOUT_POLLUTION_ATTEMPT');\nthrow new Error('top-level module crash');\n${s}`,
      },
      {
        label: 'invalid PreToolUse return shape ({}) from antigravity.mjs',
        rel: 'src/hooks/antigravity.mjs',
        mutate: (s) => s.replace('export function runAntigravityHook(', 'export function runAntigravityHook() { return {}; }\nfunction _origRun('),
      },
    ];

    for (const m of mutations) {
      const targetFile = path.join(copyRoot, m.rel);
      const orig = fs.readFileSync(targetFile, 'utf8');
      try {
        fs.writeFileSync(targetFile, m.mutate(orig), 'utf8');
        const preRes = runCopyEntry('pre-tool-use');
        assert.equal(preRes.status, 0, `${m.label} (pre): exit 0`);
        assert.equal(preRes.stdout, '{"decision":"ask"}\n', `${m.label} (pre): exact single-line JSON on stdout`);
        assert.equal(preRes.stderr.trim().split(/\r?\n/).length, 1, `${m.label} (pre): 1 diagnostic line on stderr`);

        const postRes = runCopyEntry('post-tool-use');
        assert.equal(postRes.status, 0, `${m.label} (post): exit 0`);
        assert.equal(postRes.stdout, '{}\n', `${m.label} (post): exact {} on stdout`);
      } finally {
        fs.writeFileSync(targetFile, orig, 'utf8');
      }
    }

    // Missing `antigravity.mjs` file altogether
    const agyCopyFile = path.join(copyRoot, 'src', 'hooks', 'antigravity.mjs');
    const agyOrigBytes = fs.readFileSync(agyCopyFile);
    try {
      fs.unlinkSync(agyCopyFile);
      const preMissing = runCopyEntry('pre-tool-use');
      assert.equal(preMissing.status, 0);
      assert.equal(preMissing.stdout, '{"decision":"ask"}\n');
      assert.equal(preMissing.stderr.trim().split(/\r?\n/).length, 1);

      const postMissing = runCopyEntry('post-tool-use');
      assert.equal(postMissing.status, 0);
      assert.equal(postMissing.stdout, '{}\n');
    } finally {
      fs.writeFileSync(agyCopyFile, agyOrigBytes);
    }

    // Hanging Promise (`new Promise(() => {})`) in handler: safety timer stays ref'd and emits fallback JSON with exit 0
    try {
      const agyOrigText = agyOrigBytes.toString('utf8');
      fs.writeFileSync(
        agyCopyFile,
        agyOrigText.replace('export function runAntigravityHook(', 'export function runAntigravityHook() { return new Promise(() => {}); }\nfunction _origRun('),
        'utf8',
      );
      const preHang = runCopyEntry('pre-tool-use', samplePayload, { HERDR_CORTEX_ENTRY_TIMEOUT_MS: '300' });
      assert.equal(preHang.status, 0, 'hanging promise (pre): exit 0');
      assert.equal(preHang.stdout, '{"decision":"ask"}\n', 'hanging promise (pre): fallback JSON');

      const postHang = runCopyEntry('post-tool-use', samplePayload, { HERDR_CORTEX_ENTRY_TIMEOUT_MS: '300' });
      assert.equal(postHang.status, 0, 'hanging promise (post): exit 0');
      assert.equal(postHang.stdout, '{}\n', 'hanging promise (post): fallback {}');
    } finally {
      fs.writeFileSync(agyCopyFile, agyOrigBytes);
    }

    // Dynamic import calling `process.exit(3)` mid-load: exit handler emits fallback JSON and resets exit code to 0
    try {
      const agyOrigText = agyOrigBytes.toString('utf8');
      fs.writeFileSync(agyCopyFile, `process.exit(3);\n${agyOrigText}`, 'utf8');
      const preExit = runCopyEntry('pre-tool-use');
      assert.equal(preExit.status, 0, 'mid-import process.exit(3) (pre): exit 0');
      assert.equal(preExit.stdout, '{"decision":"ask"}\n', 'mid-import process.exit(3) (pre): fallback JSON');

      const postExit = runCopyEntry('post-tool-use');
      assert.equal(postExit.status, 0, 'mid-import process.exit(3) (post): exit 0');
      assert.equal(postExit.stdout, '{}\n', 'mid-import process.exit(3) (post): fallback {}');
    } finally {
      fs.writeFileSync(agyCopyFile, agyOrigBytes);
    }

    // 3. UNC (`\\...`) and overlong (>1,024 chars, including 32,000 chars) `Path` inputs bypass path resolution cleanly & fast
    const opts = {
      terminalId: 't-agy-fix',
      globalDir: env.globalDir,
      env: { HC_TERMINAL_ID: 't-agy-fix', TEMP: os.tmpdir(), TMP: os.tmpdir() },
    };
    const rootBase = {
      conversationId: 'c-fix',
      rootConversationId: 'c-fix',
      cwd: env.projectDir,
      workspacePaths: [env.projectDir],
      lastUserInput: 'do task',
    };
    const uncPath = '\\\\192.0.2.1\\unreachable-share\\f.js';
    const over1kPath = path.join(env.projectDir, `${'a'.repeat(1100)}.js`);
    const path32k = `C:\\${'a\\'.repeat(16000)}f.js`;

    for (const slowPath of [uncPath, over1kPath, path32k]) {
      for (const toolName of ['write_file', 'edit_file', 'read_file']) {
        const t0 = performance.now();
        const res = handleAntigravityPreToolUse(
          {
            ...rootBase,
            toolCall: { id: 'slow-1', name: toolName, args: { Path: slowPath, Content: 'x'.repeat(2000), Replacement: 'y'.repeat(2000) } },
          },
          opts,
        );
        const elapsed = performance.now() - t0;
        assert.deepEqual(res, { decision: 'ask' }, `${toolName} on len=${slowPath.length}`);
        assert.ok(elapsed < 50, `${toolName} must skip path resolution immediately, took ${elapsed.toFixed(1)}ms`);
      }
    }
    // Subprocess check on UNC path finishes well within bound (<1500ms) instead of 21s SMB timeout
    const uncSubStart = performance.now();
    const uncSub = runCopyEntry('pre-tool-use', JSON.stringify({
      ...rootBase,
      toolCall: { id: 'unc-sub', name: 'write_file', args: { Path: uncPath, Content: 'x' } },
    }));
    const uncSubElapsed = performance.now() - uncSubStart;
    assert.equal(uncSub.status, 0);
    assert.equal(uncSub.stdout, '{"decision":"ask"}\n');
    assert.ok(uncSubElapsed < 1500, `UNC subprocess must finish fast, took ${uncSubElapsed.toFixed(0)}ms`);

    // Relative `Path` with UNC `cwd` or combined length > 1,024 chars also fast-fails without hitting filesystem
    const relUncStart = performance.now();
    const relUncRes = handleAntigravityPreToolUse(
      {
        ...rootBase,
        cwd: '\\\\192.0.2.9\\share\\proj',
        workspacePaths: ['\\\\192.0.2.9\\share\\proj'],
        toolCall: { id: 'unc-rel', name: 'write_file', args: { Path: 'src\\f.js', Content: 'x'.repeat(2000) } },
      },
      opts,
    );
    const relUncElapsed = performance.now() - relUncStart;
    assert.deepEqual(relUncRes, { decision: 'ask' });
    assert.ok(relUncElapsed < 500, `relative Path under UNC cwd must finish fast, took ${relUncElapsed.toFixed(1)}ms`);

    const overlongCombinedCwd = path.join(env.projectDir, 'd'.repeat(600));
    const overlongCombinedRes = handleAntigravityPreToolUse(
      {
        ...rootBase,
        cwd: overlongCombinedCwd,
        toolCall: { id: 'long-rel', name: 'write_file', args: { Path: `${'s'.repeat(500)}.js`, Content: 'x'.repeat(2000) } },
      },
      opts,
    );
    assert.deepEqual(overlongCombinedRes, { decision: 'ask' });

    // 4. MCP tool name scoping: other servers' `memory_save` NEVER triggers `deny` (subagent) or `force_ask` (other project),
    //    while `herdr-cortex`/`cortex` DOES; suffix-only `memory_save` is only accepted by `PostToolUse`
    const otherProj = path.join(env.root, 'other-project');
    fs.mkdirSync(otherProj, { recursive: true });
    for (const foreignCall of [
      { id: 'f1', name: 'mcp__other-notes__memory_save', args: { project_dir: otherProj } },
      { id: 'f2', name: 'other_server:memory_save', args: { project_dir: otherProj } },
      { id: 'f3', name: 'custom_memory_save', args: { project_dir: otherProj } },
      { id: 'f4', name: 'call_mcp_tool', args: { ServerName: 'other-notes', ToolName: 'memory_save', Arguments: { project_dir: otherProj } } },
    ]) {
      assert.deepEqual(
        handleAntigravityPreToolUse({ ...rootBase, rootConversationId: 'parent-conv', toolCall: foreignCall }, opts),
        { decision: 'ask' },
        `foreign ${foreignCall.name} must NOT be denied in subagent`,
      );
      assert.deepEqual(
        handleAntigravityPreToolUse({ ...rootBase, toolCall: foreignCall }, opts),
        { decision: 'ask' },
        `foreign ${foreignCall.name} must NOT force_ask in main`,
      );
    }

    for (const ownCall of [
      { id: 'o1', name: 'mcp__herdr-cortex__memory_save', args: { project_dir: otherProj } },
      { id: 'o2', name: 'mcp__cortex__memory_save', args: { project_dir: otherProj } },
      { id: 'o3', name: 'herdr-cortex:memory_save', args: { project_dir: otherProj } },
      { id: 'o4', name: 'memory_save', args: { project_dir: otherProj } },
      { id: 'o5', name: 'call_mcp_tool', args: { ServerName: 'herdr-cortex', ToolName: 'memory_save', Arguments: { project_dir: otherProj } } },
    ]) {
      assert.equal(
        handleAntigravityPreToolUse({ ...rootBase, rootConversationId: 'parent-conv', toolCall: ownCall }, opts).decision,
        'deny',
        `own ${ownCall.name} must be denied in subagent`,
      );
      assert.equal(
        handleAntigravityPreToolUse({ ...rootBase, toolCall: ownCall }, opts).decision,
        'force_ask',
        `own ${ownCall.name} must force_ask on other project_dir`,
      );
    }

    // `call_mcp_tool` naming another server does NOT clear window on PostToolUse either
    handleAntigravityPreToolUse(
      { ...rootBase, toolCall: { id: 'w1', name: 'write_file', args: { Path: path.join(env.projectDir, 'keep.js'), Content: 'abc' } } },
      opts,
    );
    handleAntigravityPostToolUse(
      {
        ...rootBase,
        error: '',
        toolCall: { id: 'f-post', name: 'call_mcp_tool', args: { ServerName: 'other-notes', ToolName: 'memory_save', Arguments: {} } },
      },
      opts,
    );
    assert.deepEqual(readWorkSizeState(env.globalDir, tabWorkSizeScope('t-agy-fix'), { cwd: env.projectDir }).files, { 'keep.js': 3 });

    // 5. Dual-shell interpretation on Antigravity `run_command`: both PowerShell backtick and Bash `\'` forms guard
    const dualShellDangerous = [
      'Write-Host "a`nb"; git push --force',
      "echo Don\\'t; git push --force; echo It\\'s",
    ];
    for (const cmd of dualShellDangerous) {
      assert.equal(
        handleAntigravityPreToolUse({ ...rootBase, toolCall: { id: 'ds-m', name: 'run_command', args: { CommandLine: cmd } } }, opts).decision,
        'force_ask',
        `Antigravity main must force_ask: ${cmd}`,
      );
      assert.equal(
        handleAntigravityPreToolUse(
          { ...rootBase, rootConversationId: 'other-root', toolCall: { id: 'ds-s', name: 'run_command', args: { CommandLine: cmd } } },
          opts,
        ).decision,
        'deny',
        `Antigravity subagent must deny: ${cmd}`,
      );
      assert.equal(
        handleAntigravityPreToolUse(
          { ...rootBase, toolCall: { id: 'ds-w', name: 'run_command', args: { CommandLine: cmd } } },
          { ...opts, env: { ...opts.env, HERDR_CORTEX_ROLE: 'worker' } },
        ).decision,
        'deny',
        `Antigravity worker must deny: ${cmd}`,
      );
    }
  } finally {
    env.cleanup();
  }
});
