import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT, atomicWriteJson, atomicWriteText } from '../src/core/config.mjs';
import { CortexStore } from '../src/core/store.mjs';
import {
  isSubagentPayload,
  listSavedSessions,
  readSavedSession,
  recordSession,
} from '../src/revive/tracker.mjs';
import {
  extractAntigravityState,
  extractClaudeRecentTurns,
} from '../src/hooks/recent-turns.mjs';
import {
  CLAUDE_HOOK_MAX_CHARS,
  handleClaudePreCompact,
  handleClaudePreToolUse,
  handleClaudeSessionStart,
  handleClaudeUserPrompt,
} from '../src/hooks/claude.mjs';
import {
  detectAntigravityTranscriptRole,
  handleAntigravityPreInvocation,
  handleAntigravitySessionStart,
} from '../src/hooks/antigravity.mjs';
import {
  AGY_HOOK_KEY,
  LEGACY_AGY_HOOK_KEY,
  MCP_SERVER_KEY,
  installCortex,
  uninstallCortex,
} from '../src/hooks/installer.mjs';
import { enqueueMessage } from '../src/relay/inbox.mjs';
import { approveProject } from '../src/core/trust.mjs';

function makeTempEnv(prefix = 'herdr-cortex-hooks-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  const globalDir = path.join(homeDir, '.herdr-cortex');
  const promptsDir = path.join(root, 'prompts');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  // The project folder of every test environment is approved, as a user would do with cortex-trust.
  approveProject(projectDir, { globalDir });
  fs.mkdirSync(path.join(promptsDir, 'skills', 'start-job'), { recursive: true });

  atomicWriteText(
    path.join(promptsDir, 'HEAD_CORE.md'),
    '# HEAD_CORE\n\n- Stay at low/mid resolution; delegate high-resolution implementation.\n- Prove it by running it.\n',
  );
  atomicWriteText(
    path.join(promptsDir, 'skills', 'start-job', 'SKILL.md'),
    '---\nname: start-job\ndescription: Entry gate skill\n---\n\n# start-job\nEntry gate skill content.\n',
  );

  return {
    root,
    projectDir,
    homeDir,
    globalDir,
    promptsDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeJsonl(filePath, items) {
  const content = items.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n';
  atomicWriteText(filePath, content);
}

test('revive/tracker: subagent guard prevents parent session overwrite, preserves previousSessionId/history, and falls back to legacy store', () => {
  const env = makeTempEnv();
  try {
    // 1. Legacy fallback read before migration
    const legacyFile = path.join(env.homeDir, '.herdr-revive', 'sessions', 'tab-legacy.json');
    atomicWriteJson(legacyFile, {
      terminalId: 'tab-legacy',
      agent: 'antigravity',
      sessionId: 'conv-legacy-1',
      cwd: env.projectDir,
      updatedAt: '2026-11-20T00:00:00.000Z',
    });
    const fallback = readSavedSession('tab-legacy', { globalDir: env.globalDir, legacyHome: env.homeDir });
    assert.equal(fallback.sessionId, 'conv-legacy-1');
    assert.equal(fallback.source, 'legacy');

    // 2. Record initial HEAD session for tab-1
    const r1 = recordSession({
      terminalId: 'tab-1',
      agent: 'claude',
      payload: { session_id: 'sess-1', cwd: env.projectDir },
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
    });
    assert.equal(r1.recorded, true);
    assert.equal(r1.record.sessionId, 'sess-1');
    assert.equal(r1.record.previousSessionId, null);
    assert.deepEqual(r1.record.history, []);

    // 3. Unchanged payload is a fast no-op
    const rSame = recordSession({
      terminalId: 'tab-1',
      agent: 'claude',
      payload: { session_id: 'sess-1', cwd: env.projectDir },
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
    });
    assert.equal(rSame.recorded, false);
    assert.equal(rSame.reason, 'unchanged');

    // 4. CRITICAL SUBAGENT GUARD: Claude agent_id, camelCase agentId, and Antigravity rootConversationId !== conversationId
    const sub1 = recordSession({
      terminalId: 'tab-1',
      agent: 'claude',
      payload: { session_id: 'sess-sub-1', agent_id: 'worker-42', cwd: env.projectDir },
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
    });
    assert.equal(sub1.recorded, false);
    assert.equal(sub1.reason, 'subagent');

    const sub2 = recordSession({
      terminalId: 'tab-1',
      agent: 'claude',
      payload: { session_id: 'sess-sub-2', agentId: 'worker-camel', cwd: env.projectDir },
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
    });
    assert.equal(sub2.recorded, false);
    assert.equal(sub2.reason, 'subagent');

    const sub3 = recordSession({
      terminalId: 'tab-1',
      agent: 'antigravity',
      payload: { conversationId: 'conv-child', rootConversationId: 'conv-root', cwd: env.projectDir },
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
    });
    assert.equal(sub3.recorded, false);
    assert.equal(sub3.reason, 'subagent');

    // Verify parent tab session ID was NEVER overwritten
    const afterSubs = readSavedSession('tab-1', { globalDir: env.globalDir, legacyHome: env.homeDir });
    assert.equal(afterSubs.sessionId, 'sess-1');

    // 5. Session changes (/clear chain) preserve previousSessionId and cap history at 5
    for (let i = 2; i <= 8; i++) {
      const res = recordSession({
        terminalId: 'tab-1',
        agent: 'claude',
        payload: { session_id: `sess-${i}`, cwd: env.projectDir },
        globalDir: env.globalDir,
        legacyHome: env.homeDir,
      });
      assert.equal(res.recorded, true);
    }

    const latest = readSavedSession('tab-1', { globalDir: env.globalDir, legacyHome: env.homeDir });
    assert.equal(latest.sessionId, 'sess-8');
    assert.equal(latest.previousSessionId, 'sess-7');
    assert.deepEqual(latest.history, ['sess-7', 'sess-6', 'sess-5', 'sess-4', 'sess-3']);

    // 6. listSavedSessions merges cortex + legacy
    const all = listSavedSessions({ globalDir: env.globalDir, legacyHome: env.homeDir });
    const ids = all.map((s) => s.terminalId).sort();
    assert.deepEqual(ids, ['tab-1', 'tab-legacy']);
  } finally {
    env.cleanup();
  }
});

test('recent-turns: Claude JSONL filtering, boundary slicing, queued_command/user-answer preservation, and budget cap', () => {
  const env = makeTempEnv();
  try {
    const transcriptPath = path.join(env.root, 'claude-transcript.jsonl');
    writeJsonl(transcriptPath, [
      // Pre-boundary turns (should be sliced off after compact_boundary)
      { type: 'user', message: { role: 'user', content: 'Old pre-compact question' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Old pre-compact answer' }] } },
      { type: 'system', subtype: 'compact_boundary', content: 'Compacted' },

      // Noise entries that MUST be filtered out
      { type: 'user', message: { role: 'user', content: '<command-name>/status</command-name>' } },
      { type: 'user', message: { role: 'user', content: '<local-command-stdout>OK</local-command-stdout>' } },
      { type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } },

      // Turn 1: pure user + assistant with thinking & tool_use stripped
      { type: 'user', message: { role: 'user', content: 'First post-compact question' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret chain of thought' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.mjs' } },
            { type: 'text', text: 'First post-compact answer' },
          ],
        },
      },

      // Turn 2: tool_result with normal output (filtered) + "The user answered..." (kept!)
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'raw file dump should be ignored' },
            { type: 'tool_result', tool_use_id: 't2', content: 'The user answered: Choose SQLite WAL mode.' },
          ],
        },
      },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Confirmed WAL mode.' }] } },

      // Turn 3: queued_command kept as user turn
      { type: 'queued_command', content: 'Queued follow-up task: run unit tests' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Unit tests passed.' }] } },

      // Turns 4, 5, 6 (to verify only last 5 turns are returned)
      { type: 'user', message: { role: 'user', content: 'Turn 4 user' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Turn 4 assistant' }] } },
      { type: 'user', message: { role: 'user', content: 'Turn 5 user' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Turn 5 assistant' }] } },
      { type: 'user', message: { role: 'user', content: 'Turn 6 newest user' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Turn 6 newest assistant' }] } },
    ]);

    const res = extractClaudeRecentTurns(transcriptPath, { maxTurns: 5, maxChars: 4500 });
    assert.equal(res.turns.length, 5);
    assert.doesNotMatch(res.text, /Old pre-compact/);
    assert.doesNotMatch(res.text, /<command-name>/);
    assert.doesNotMatch(res.text, /<local-command/);
    assert.doesNotMatch(res.text, /Request interrupted/);
    assert.doesNotMatch(res.text, /secret chain of thought/);
    assert.doesNotMatch(res.text, /raw file dump/);
    assert.match(res.text, /The user answered: Choose SQLite WAL mode/);
    assert.match(res.text, /Queued follow-up task: run unit tests/);
    assert.match(res.text, /Turn 6 newest assistant/);

    // Tight budget keeps newest turns intact and drops oldest whole turns first
    const tight = extractClaudeRecentTurns(transcriptPath, { maxTurns: 5, maxChars: 220 });
    assert.ok(tight.charCount <= 220);
    assert.match(tight.text, /Turn 6 newest assistant/);
    assert.ok(tight.droppedCount >= 1);

    // Trailing compact_boundary (immediately after compaction) restores segment before it
    const trailingCompactPath = path.join(env.root, 'claude-trailing-compact.jsonl');
    writeJsonl(trailingCompactPath, [
      { type: 'user', message: { role: 'user', content: 'Very old turn' } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', message: { role: 'user', content: 'Recent pre-compact turn' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Recent pre-compact reply' }] } },
      { type: 'system', subtype: 'compact_boundary' },
    ]);
    const trailingRes = extractClaudeRecentTurns(trailingCompactPath);
    assert.equal(trailingRes.turns.length, 1);
    assert.match(trailingRes.text, /Recent pre-compact reply/);
    assert.doesNotMatch(trailingRes.text, /Very old turn/);

    // /clear boundary with post-clear turns excludes turns before /clear
    const clearPath = path.join(env.root, 'claude-clear.jsonl');
    writeJsonl(clearPath, [
      { type: 'user', message: { role: 'user', content: 'Before clear turn' } },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { role: 'user', content: 'After clear turn' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'After clear reply' }] } },
    ]);
    const clearRes = extractClaudeRecentTurns(clearPath);
    assert.equal(clearRes.turns.length, 1);
    assert.doesNotMatch(clearRes.text, /Before clear turn/);
    assert.match(clearRes.text, /After clear reply/);

    // Trailing /clear boundary (0 turns after /clear) restores the segment immediately before /clear
    const trailingClearPath = path.join(env.root, 'claude-trailing-clear.jsonl');
    writeJsonl(trailingClearPath, [
      { type: 'user', message: { role: 'user', content: 'Older segment before first clear' } },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { role: 'user', content: 'Last turn before trailing clear' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Last reply before trailing clear' }] } },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    ]);
    const trailingClearRes = extractClaudeRecentTurns(trailingClearPath);
    assert.equal(trailingClearRes.turns.length, 1);
    assert.match(trailingClearRes.text, /Last reply before trailing clear/);
    assert.doesNotMatch(trailingClearRes.text, /Older segment/);
  } finally {
    env.cleanup();
  }
});

test('recent-turns: Antigravity JSONL extracts latest DONE CHECKPOINT key and last 5 USER_INPUT/PLANNER_RESPONSE turns', () => {
  const env = makeTempEnv();
  try {
    const agyTranscript = path.join(env.root, 'transcript_full.jsonl');
    writeJsonl(agyTranscript, [
      { type: 'USER_INPUT', step_index: 1, userInput: { userResponse: 'wrapper\n<USER_REQUEST>질문 1</USER_REQUEST>\ntrailer' } },
      { type: 'PLANNER_RESPONSE', step_index: 2, plannerResponse: { response: '응답 1', thinking: 'ignored thinking' } },
      { type: 'CHECKPOINT', step_index: 3, status: 'DONE', created_at: '2026-11-22T10:00:00Z' },
      { type: 'USER_EXPLICIT', step_index: 4, text: '<USER_REQUEST>질문 2</USER_REQUEST>' },
      { type: 'PLANNER_RESPONSE', step_index: 5, plannerResponse: { modifiedResponse: '응답 2 수정본' } },
      { type: 'TOOL_CALL', step_index: 6, text: 'ignored tool call' },
      { type: 'CHECKPOINT', step_index: 7, status: 'RUNNING', created_at: '2026-11-22T10:05:00Z' },
      { type: 'USER_INPUT', step_index: 8, userInput: { userResponse: '   ', items: [{ text: '<USER_REQUEST>질문 3</USER_REQUEST>' }] } },
      { type: 'PLANNER_RESPONSE', step_index: 9, plannerResponse: { response: '응답 3' } },
      { type: 'CHECKPOINT', step_index: 10, status: 'DONE', created_at: '2026-11-22T10:10:00Z' },
    ]);

    const state = extractAntigravityState(agyTranscript, { maxTurns: 5, maxChars: 4500 });
    assert.deepEqual(state.latestCheckpoint, {
      key: '10:2026-11-22T10:10:00Z',
      stepIndex: 10,
      createdAt: '2026-11-22T10:10:00Z',
    });
    assert.equal(state.turns.length, 3);
    assert.equal(state.turns[0].user, '질문 1');
    assert.equal(state.turns[1].assistant, '응답 2 수정본');
    assert.equal(state.turns[2].user, '질문 3');
    assert.doesNotMatch(state.text, /ignored thinking/);
    assert.doesNotMatch(state.text, /ignored tool call/);
    assert.doesNotMatch(state.text, /wrapper/);
  } finally {
    env.cleanup();
  }
});

test('hooks/claude: SessionStart (compact, 9000-char cap, core/context split, subagent skip), PreCompact, UserPromptSubmit, and PreToolUse anti-spoofing', () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    // Seed large memory dataset to exercise 9,000-char non-truncating budget protection
    for (let i = 0; i < 20; i++) {
      store.saveDoc({
        id: `dec-budget-${i}`,
        type: 'decision',
        title: `아키텍처 결정 ${i} — 훅 예산 보호 검증`,
        summary: '각 항목은 문장 중간에서 잘리지 않고 온전한 줄 단위로 축약되어야 한다. '.repeat(3),
        session: 'cortex-v1',
        branch: 'hooks',
      });
    }
    store.close();

    // Enqueue a peer relay message for tab-c1
    enqueueMessage('tab-c1', {
      from_terminal_id: 'tab-peer',
      message: 'Please review PR #42 after compaction.',
      context_docs: ['dec-budget-0'],
    }, { globalDir: env.globalDir });

    // Write a Claude transcript
    const transcriptPath = path.join(env.root, 'claude-compact.jsonl');
    writeJsonl(transcriptPath, [
      { type: 'user', message: { role: 'user', content: 'Let us verify hooks budget' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hooks budget check ready.' }] } },
    ]);

    // 1. Subagent SessionStart is completely skipped (no context, no revive write)
    const subOut = handleClaudeSessionStart(
      { session_id: 'sub-sess', agent_id: 'worker-1', cwd: env.projectDir },
      { terminalId: 'tab-c1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(subOut, {});
    assert.equal(readSavedSession('tab-c1', { globalDir: env.globalDir, legacyHome: env.homeDir }), null);

    // 2. HEAD SessionStart on source="compact" injects HEAD_CORE + inbox + overview + recent turns <= 9000 chars
    const headOut = handleClaudeSessionStart(
      { session_id: 'head-sess-1', source: 'compact', transcript_path: transcriptPath, cwd: env.projectDir },
      { terminalId: 'tab-c1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.equal(headOut.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = headOut.hookSpecificOutput.additionalContext;
    assert.ok(ctx.length <= CLAUDE_HOOK_MAX_CHARS, `Expected <= ${CLAUDE_HOOK_MAX_CHARS}, got ${ctx.length}`);
    assert.match(ctx, /# HEAD_CORE/);
    assert.match(ctx, /Incoming Herdr Relay Messages/);
    assert.match(ctx, /Please review PR #42/);
    assert.match(ctx, /Cortex Memory Overview/);
    assert.match(ctx, /Hooks budget check ready/);
    assert.equal(readSavedSession('tab-c1', { globalDir: env.globalDir, legacyHome: env.homeDir }).sessionId, 'head-sess-1');

    // 3. Split mode: part="core" vs part="context"
    const coreOnly = handleClaudeSessionStart(
      { session_id: 'head-sess-1', cwd: env.projectDir },
      { part: 'core', terminalId: 'tab-c1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.match(coreOnly.hookSpecificOutput.additionalContext, /# HEAD_CORE/);
    assert.doesNotMatch(coreOnly.hookSpecificOutput.additionalContext, /Cortex Memory Overview/);

    const contextOnly = handleClaudeSessionStart(
      { session_id: 'head-sess-1', cwd: env.projectDir },
      { part: 'context', terminalId: 'tab-c1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.doesNotMatch(contextOnly.hookSpecificOutput.additionalContext, /# HEAD_CORE/);
    assert.match(contextOnly.hookSpecificOutput.additionalContext, /Cortex Memory Overview/);

    // 4. PreCompact outputs top-level continue + single-line systemMessage (NO hookSpecificOutput)
    const preCompact = handleClaudePreCompact();
    assert.equal(preCompact.continue, true);
    assert.equal('hookSpecificOutput' in preCompact, false);
    assert.equal(preCompact.systemMessage.includes('\n'), false);
    assert.match(preCompact.systemMessage, /cortex/i);

    // 4b. SessionStart(source="clear") with empty new <newSessionId>.jsonl falls back to sibling <previousSessionId>.jsonl
    const transcriptDir = path.join(env.root, 'claude-sessions');
    const prevTranscript = path.join(transcriptDir, 'head-sess-1.jsonl');
    const newEmptyTranscript = path.join(transcriptDir, 'head-sess-2.jsonl');
    writeJsonl(prevTranscript, [
      { type: 'user', message: { role: 'user', content: 'Before /clear important goal' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Before /clear assistant reply' }] } },
    ]);
    atomicWriteText(newEmptyTranscript, '');

    // Run split core then context (matches installed Claude SessionStart hooks)
    const clearCoreOut = handleClaudeSessionStart(
      { session_id: 'head-sess-2', source: 'clear', transcript_path: newEmptyTranscript, cwd: env.projectDir },
      { part: 'core', terminalId: 'tab-c1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.match(clearCoreOut.hookSpecificOutput.additionalContext, /# HEAD_CORE/);

    const clearCtxOut = handleClaudeSessionStart(
      { session_id: 'head-sess-2', source: 'clear', transcript_path: newEmptyTranscript, cwd: env.projectDir },
      { part: 'context', terminalId: 'tab-c1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.match(clearCtxOut.hookSpecificOutput.additionalContext, /Before \/clear important goal/);
    assert.match(clearCtxOut.hookSpecificOutput.additionalContext, /Before \/clear assistant reply/);

    // 5. UserPromptSubmit drains inbox for HEAD and skips subagent
    enqueueMessage('tab-c1', {
      from_terminal_id: 'tab-2',
      message: 'Urgent build alert',
    }, { globalDir: env.globalDir });
    const subPrompt = handleClaudeUserPrompt(
      { agent_id: 'sub-9', cwd: env.projectDir },
      { terminalId: 'tab-c1', globalDir: env.globalDir },
    );
    assert.deepEqual(subPrompt, {});

    const headPrompt = handleClaudeUserPrompt(
      { cwd: env.projectDir },
      { terminalId: 'tab-c1', globalDir: env.globalDir },
    );
    assert.equal(headPrompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(headPrompt.hookSpecificOutput.additionalContext, /Urgent build alert/);

    // Second UserPromptSubmit is empty (already acked)
    const emptyPrompt = handleClaudeUserPrompt(
      { cwd: env.projectDir },
      { terminalId: 'tab-c1', globalDir: env.globalDir },
    );
    assert.deepEqual(emptyPrompt, {});

    // 6. PreToolUse subagent denial & anti-spoofing:
    // (a) Subagent calling write-protected tools gets permissionDecision: 'deny' directly
    for (const writeCall of [
      { tool_name: 'mcp__cortex__memory_save', tool_input: { type: 'decision', title: 't', summary: 's', _caller_agent_id: '' } },
      { tool_name: 'mcp__cortex__memory_update', tool_input: { id: 'dec-1', status: 'done' } },
      { tool_name: 'mcp__cortex__relay_send', tool_input: { to_terminal_id: 't2', message: 'hi' } },
      { tool_name: 'mcp__cortex__relay_inbox', tool_input: { action: 'ack', message_id: 'all' } },
    ]) {
      const denied = handleClaudePreToolUse({ ...writeCall, agent_id: 'real-subagent-77' });
      assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    }

    // (b) Subagent calling read-only cortex tool gets real host agent_id injected and NEVER permissionDecision: 'allow'
    const subRead = handleClaudePreToolUse({
      tool_name: 'mcp__cortex__memory_search',
      agent_id: 'real-subagent-77',
      tool_input: { query: 'wal', _caller_agent_id: '' },
    });
    assert.equal(subRead.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(subRead.hookSpecificOutput.updatedInput._caller_agent_id, 'real-subagent-77');
    assert.equal('permissionDecision' in subRead.hookSpecificOutput, false);

    const subPeek = handleClaudePreToolUse({
      tool_name: 'mcp__cortex__relay_inbox',
      agent_id: 'real-subagent-77',
      tool_input: { action: 'peek' },
    });
    assert.equal(subPeek.hookSpecificOutput.updatedInput._caller_agent_id, 'real-subagent-77');
    assert.equal('permissionDecision' in subPeek.hookSpecificOutput, false);

    // (c) HEAD with LLM-injected _caller_agent_id gets stripped cleanly (without permissionDecision: 'allow')
    const spoofHead = handleClaudePreToolUse({
      tool_name: 'mcp__cortex__memory_save',
      tool_input: { type: 'decision', title: 't', summary: 's', _caller_agent_id: 'fake-id' },
    });
    assert.equal('_caller_agent_id' in spoofHead.hookSpecificOutput.updatedInput, false);
    assert.equal('permissionDecision' in spoofHead.hookSpecificOutput, false);

    // (d) Clean HEAD call needs no rewrite
    const cleanHead = handleClaudePreToolUse({
      tool_name: 'mcp__cortex__memory_save',
      tool_input: { type: 'decision', title: 't', summary: 's' },
    });
    assert.deepEqual(cleanHead, {});

    // (e) Non-cortex tool ignored
    const nonCortex = handleClaudePreToolUse({
      tool_name: 'Bash',
      agent_id: 'real-subagent-77',
      tool_input: { command: 'ls' },
    });
    assert.deepEqual(nonCortex, {});

    // (f) PreCompact skips subagents
    assert.deepEqual(handleClaudePreCompact({ agent_id: 'sub-1', cwd: env.projectDir }, { globalDir: env.globalDir }), {});

    // (g) SessionStart on resume/fork skips duplicate HEAD_CORE while keeping overview
    const resumeOut = handleClaudeSessionStart(
      { session_id: 'head-sess-2', source: 'resume', cwd: env.projectDir },
      { terminalId: 'tab-c1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.doesNotMatch(resumeOut.hookSpecificOutput.additionalContext, /# HEAD_CORE/);
    assert.match(resumeOut.hookSpecificOutput.additionalContext, /Cortex Memory Overview/);

    // (h) Non-Herdr /clear fallback (no HC_TERMINAL_ID) scans sibling *.jsonl by mtime
    const nonHerdrDir = path.join(env.root, 'non-herdr-claude');
    const olderSibling = path.join(nonHerdrDir, 'prev-non-herdr.jsonl');
    const newBlankClear = path.join(nonHerdrDir, 'brand-new-clear.jsonl');
    writeJsonl(olderSibling, [
      { type: 'user', message: { role: 'user', content: 'Non-Herdr pre-clear goal' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Non-Herdr pre-clear reply' }] } },
    ]);
    atomicWriteText(newBlankClear, '');
    const nonHerdrClear = handleClaudeSessionStart(
      { session_id: 'brand-new-clear', source: 'clear', transcript_path: newBlankClear, cwd: env.projectDir },
      { terminalId: '', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.match(nonHerdrClear.hookSpecificOutput.additionalContext, /Non-Herdr pre-clear goal/);
    assert.match(nonHerdrClear.hookSpecificOutput.additionalContext, /Non-Herdr pre-clear reply/);

    // 7. CLI child-process smoke test for pre-compact (including UTF-8 BOM stripping)
    const cliRes = spawnSync(
      process.execPath,
      ['--no-warnings', path.join(REPO_ROOT, 'src', 'hooks', 'claude.mjs'), 'pre-compact', '--id', 'herdr-cortex'],
      { input: '\uFEFF{}', encoding: 'utf8' },
    );
    assert.equal(cliRes.status, 0);
    const parsedCli = JSON.parse(cliRes.stdout.trim());
    assert.equal(parsedCli.continue, true);
    assert.equal('hookSpecificOutput' in parsedCli, false);
    assert.match(parsedCli.systemMessage, /Compaction pointer/i);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('hooks/antigravity: SessionStart subagent skip, PreInvocation /compact pointer, CHECKPOINT once-restore, and inbox drain', () => {
  const env = makeTempEnv();
  const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
  try {
    store.saveDoc({
      id: 'dec-agy-1',
      type: 'decision',
      title: 'Antigravity 체크포인트 자동 복구',
      summary: 'CHECKPOINT DONE 변화 감지 시 맥락과 직전 5턴을 1회 복원한다.',
    });
    store.close();

    // 1. Subagent SessionStart skipped (conversationId !== rootConversationId)
    const subStart = handleAntigravitySessionStart(
      { conversationId: 'conv-sub-1', rootConversationId: 'conv-root-1', cwd: env.projectDir },
      { terminalId: 'tab-a1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(subStart, {});
    assert.equal(readSavedSession('tab-a1', { globalDir: env.globalDir, legacyHome: env.homeDir }), null);

    // 2. Root SessionStart records session and injects HEAD_CORE + overview as separate injectSteps
    const rootStart = handleAntigravitySessionStart(
      { conversationId: 'conv-root-1', rootConversationId: 'conv-root-1', cwd: env.projectDir },
      { terminalId: 'tab-a1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.equal(rootStart.injectSteps.length, 2);
    const startCombined = rootStart.injectSteps.map((s) => s.systemMessage.systemMessage).join('\n\n');
    assert.match(rootStart.injectSteps[0].systemMessage.systemMessage, /# HEAD_CORE/);
    assert.match(rootStart.injectSteps[1].systemMessage.systemMessage, /Antigravity 체크포인트 자동 복구/);
    assert.ok(startCombined.length <= 9000);
    assert.equal(readSavedSession('tab-a1', { globalDir: env.globalDir, legacyHome: env.homeDir }).sessionId, 'conv-root-1');

    // 3. PreInvocation with /compact (including arguments) injects 1-line compact pointer (without duplicating HEAD_CORE)
    const compactOut = handleAntigravityPreInvocation(
      {
        conversationId: 'conv-root-1',
        rootConversationId: 'conv-root-1',
        cwd: env.projectDir,
        lastUserInput: ' /compact focus on recent work ',
      },
      { terminalId: 'tab-a1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.equal(compactOut.injectSteps.length, 1);
    assert.match(compactOut.injectSteps[0].systemMessage.systemMessage, /Compaction pointer/i);

    // 4. PreInvocation detects new CHECKPOINT (DONE) -> restores once as separate injectSteps -> persists JSON state -> does NOT duplicate next turn
    const transcriptFull = path.join(env.root, 'transcript_full.jsonl');
    writeJsonl(transcriptFull, [
      { type: 'USER_INPUT', step_index: 1, userInput: { userResponse: '<USER_REQUEST>체크포인트 직전 요청</USER_REQUEST>' } },
      { type: 'PLANNER_RESPONSE', step_index: 2, plannerResponse: { response: '체크포인트 직전 응답' } },
      { type: 'CHECKPOINT', step_index: 3, status: 'DONE', created_at: '2026-11-22T12:00:00Z' },
    ]);

    const firstCp = handleAntigravityPreInvocation(
      {
        conversationId: 'conv-root-1',
        rootConversationId: 'conv-root-1',
        cwd: env.projectDir,
        transcriptFullPath: transcriptFull,
      },
      { terminalId: 'tab-a1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.equal(firstCp.injectSteps.length, 3); // HEAD_CORE, overview, recentTurns
    const cpCombined = firstCp.injectSteps.map((s) => s.systemMessage.systemMessage).join('\n\n');
    assert.match(firstCp.injectSteps[0].systemMessage.systemMessage, /# HEAD_CORE/);
    assert.match(firstCp.injectSteps[1].systemMessage.systemMessage, /Antigravity 체크포인트 자동 복구/);
    assert.match(firstCp.injectSteps[2].systemMessage.systemMessage, /체크포인트 직전 요청/);
    assert.match(firstCp.injectSteps[2].systemMessage.systemMessage, /체크포인트 직전 응답/);
    assert.ok(cpCombined.length <= 9000);

    const cpFile = path.join(env.projectDir, '.memory', 'state', 'checkpoints', 'conv-root-1.json');
    const cpJson = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
    assert.equal(cpJson.started, true);
    assert.equal(cpJson.checkpoint, '3:2026-11-22T12:00:00Z');

    // Next turn with same checkpoint -> no duplicate restore
    const secondCp = handleAntigravityPreInvocation(
      {
        conversationId: 'conv-root-1',
        rootConversationId: 'conv-root-1',
        cwd: env.projectDir,
        transcriptFullPath: transcriptFull,
      },
      { terminalId: 'tab-a1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(secondCp, {});

    // 5. PreInvocation drains relay inbox
    enqueueMessage('tab-a1', {
      from_terminal_id: 'tab-claude',
      message: 'Cross-tab relay handoff ready',
    }, { globalDir: env.globalDir });
    const inboxOut = handleAntigravityPreInvocation(
      {
        conversationId: 'conv-root-1',
        rootConversationId: 'conv-root-1',
        cwd: env.projectDir,
        transcriptFullPath: transcriptFull,
      },
      { terminalId: 'tab-a1', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.match(inboxOut.injectSteps[0].systemMessage.systemMessage, /Cross-tab relay handoff ready/);

    // 6. CLI child-process always emits valid JSON (even on empty payload)
    const cliRes = spawnSync(
      process.execPath,
      ['--no-warnings', path.join(REPO_ROOT, 'src', 'hooks', 'antigravity.mjs'), 'pre-invocation'],
      {
        input: JSON.stringify({ conversationId: 'sub', rootConversationId: 'root' }),
        encoding: 'utf8',
        env: { ...process.env, HERDR_CORTEX_HOME: env.globalDir },
      },
    );
    assert.equal(cliRes.status, 0);
    assert.deepEqual(JSON.parse(cliRes.stdout.trim()), {});
  } finally {
    store.close();
    env.cleanup();
  }
});

test('hooks/installer: idempotent install/uninstall round-trip preserves existing user configs, removes legacy revive hooks, and manages skills', () => {
  const env = makeTempEnv();
  try {
    // Seed pre-existing user configs + legacy revive entries
    const agyHooksPath = path.join(env.homeDir, '.gemini', 'config', 'hooks.json');
    atomicWriteJson(agyHooksPath, {
      'user-custom-group': { SessionStart: [{ type: 'command', command: 'echo custom' }] },
      [LEGACY_AGY_HOOK_KEY]: { SessionStart: [{ type: 'command', command: 'node record-session.mjs antigravity' }] },
    });

    const agyMcpPath = path.join(env.homeDir, '.gemini', 'antigravity-cli', 'mcp_config.json');
    atomicWriteJson(agyMcpPath, {
      mcpServers: {
        existingServer: { command: 'npx', args: ['existing-mcp'] },
      },
    });

    const claudeSettingsPath = path.join(env.homeDir, '.claude', 'settings.json');
    atomicWriteJson(claudeSettingsPath, {
      theme: 'dark',
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo keep-me' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'node "G:\\old\\scripts\\record-session.mjs" claude' }] },
        ],
      },
    });

    const claudeJsonPath = path.join(env.homeDir, '.claude.json');
    atomicWriteJson(claudeJsonPath, {
      numStartups: 5,
      mcpServers: {
        otherMcp: { command: 'python', args: ['other.py'] },
      },
    });

    // Also add a non-cortex user skill that must NEVER be touched
    const userSkillDir = path.join(env.homeDir, '.claude', 'skills', 'user-own-skill');
    atomicWriteText(path.join(userSkillDir, 'SKILL.md'), '# User own skill\n');

    // Run install TWICE to verify strict idempotency
    const res1 = installCortex({ repoRoot: env.root, homeDir: env.homeDir });
    const res2 = installCortex({ repoRoot: env.root, homeDir: env.homeDir });
    assert.equal(res1.antigravityHooks.action, 'installed');
    assert.equal(res2.claudeSettings.action, 'installed');

    // Verify backups created
    assert.equal(fs.existsSync(`${agyHooksPath}.herdr-cortex.bak`), true);
    assert.equal(fs.existsSync(`${agyMcpPath}.herdr-cortex.bak`), true);
    assert.equal(fs.existsSync(`${claudeSettingsPath}.herdr-cortex.bak`), true);
    assert.equal(fs.existsSync(`${claudeJsonPath}.herdr-cortex.bak`), true);

    // Verify Antigravity hooks: herdr-cortex added, legacy removed, user-custom preserved
    const agyHooks = JSON.parse(fs.readFileSync(agyHooksPath, 'utf8'));
    assert.ok(agyHooks[AGY_HOOK_KEY]);
    assert.equal(LEGACY_AGY_HOOK_KEY in agyHooks, false);
    assert.ok(agyHooks['user-custom-group']);

    // Verify Antigravity MCP: cortex added, existingServer preserved
    const agyMcp = JSON.parse(fs.readFileSync(agyMcpPath, 'utf8'));
    assert.ok(agyMcp.mcpServers[MCP_SERVER_KEY]);
    assert.ok(agyMcp.mcpServers.existingServer);

    // Verify Claude settings: single unified SessionStart hook (no 2-process split race), all 4 hooks added once
    const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    assert.equal(claudeSettings.theme, 'dark');
    assert.equal(claudeSettings.hooks.SessionStart.length, 2); // echo keep-me + cortex
    const cortexStartEntry = claudeSettings.hooks.SessionStart.find((e) => e.hooks.some((h) => h.command.includes('herdr-cortex')));
    assert.equal(cortexStartEntry.hooks.length, 1);
    assert.match(cortexStartEntry.hooks[0].command, /session-start --id herdr-cortex/);
    assert.equal(claudeSettings.hooks.PreCompact.length, 1);
    assert.equal(claudeSettings.hooks.UserPromptSubmit.length, 1);
    assert.equal(claudeSettings.hooks.PreToolUse.length, 1);
    assert.equal(
      claudeSettings.hooks.SessionStart.some((e) => e.hooks.some((h) => h.command.includes('record-session.mjs'))),
      false,
    );

    // Verify Claude MCP: cortex added, otherMcp and numStartups preserved
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    assert.equal(claudeJson.numStartups, 5);
    assert.ok(claudeJson.mcpServers[MCP_SERVER_KEY]);
    assert.ok(claudeJson.mcpServers.otherMcp);

    // Verify managed skill installed AND frontmatter name: synced to cortex-start-job
    const managedSkillPath = path.join(env.homeDir, '.claude', 'skills', 'cortex-start-job', 'SKILL.md');
    assert.equal(fs.existsSync(managedSkillPath), true);
    const syncedSkillMd = fs.readFileSync(managedSkillPath, 'utf8');
    assert.match(syncedSkillMd, /^name:\s*cortex-start-job$/m);

    // Run uninstall -> removes only cortex entries and preserves all user entries
    uninstallCortex({ repoRoot: env.root, homeDir: env.homeDir });

    const agyHooksAfter = JSON.parse(fs.readFileSync(agyHooksPath, 'utf8'));
    assert.equal(AGY_HOOK_KEY in agyHooksAfter, false);
    assert.ok(agyHooksAfter['user-custom-group']);

    const agyMcpAfter = JSON.parse(fs.readFileSync(agyMcpPath, 'utf8'));
    assert.equal(MCP_SERVER_KEY in agyMcpAfter.mcpServers, false);
    assert.ok(agyMcpAfter.mcpServers.existingServer);

    const claudeSettingsAfter = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    assert.equal(claudeSettingsAfter.theme, 'dark');
    assert.equal(claudeSettingsAfter.hooks.SessionStart.length, 1);
    assert.equal(claudeSettingsAfter.hooks.SessionStart[0].hooks[0].command, 'echo keep-me');
    assert.equal('PreCompact' in claudeSettingsAfter.hooks, false);
    assert.equal('UserPromptSubmit' in claudeSettingsAfter.hooks, false);
    assert.equal('PreToolUse' in claudeSettingsAfter.hooks, false);

    const claudeJsonAfter = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    assert.equal(MCP_SERVER_KEY in claudeJsonAfter.mcpServers, false);
    assert.ok(claudeJsonAfter.mcpServers.otherMcp);

    assert.equal(fs.existsSync(path.join(env.homeDir, '.claude', 'skills', 'cortex-start-job')), false);
    assert.equal(fs.existsSync(path.join(userSkillDir, 'SKILL.md')), true);
  } finally {
    env.cleanup();
  }
});

test('project scoping: excludedProjects and opt-in mode suppress hook injections while keeping revive tracking intact', () => {
  const env = makeTempEnv('cortex-scope-');
  try {
    const excludedProj = path.join(env.root, 'excluded_app');
    const excludedSub = path.join(excludedProj, 'packages', 'web');
    const allowedProj = path.join(env.root, 'allowed_app');
    fs.mkdirSync(excludedSub, { recursive: true });
    fs.mkdirSync(allowedProj, { recursive: true });

    // Configure global exclusion by folder name
    fs.writeFileSync(
      path.join(env.globalDir, 'config.json'),
      JSON.stringify({ mode: 'all', excludedProjects: ['excluded_app'], headCoreEnabled: true }, null, 2),
      'utf8',
    );

    // Excluded project (and its subdirectory): Claude & Antigravity hooks return {} with zero injection,
    // while revive session tracking still records cleanly.
    const clStartExcl = handleClaudeSessionStart(
      { session_id: 'cl-excl-1', cwd: excludedSub, source: 'startup' },
      { terminalId: 'tab-excl-cl', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(clStartExcl, {});
    assert.equal(readSavedSession('tab-excl-cl', { globalDir: env.globalDir, legacyHome: env.homeDir })?.sessionId, 'cl-excl-1');
    assert.equal(fs.existsSync(path.join(excludedSub, '.memory')), false);

    const clCompactExcl = handleClaudePreCompact({ cwd: excludedProj }, { globalDir: env.globalDir });
    assert.deepEqual(clCompactExcl, {});

    const agStartExcl = handleAntigravitySessionStart(
      { conversationId: 'ag-excl-1', rootConversationId: 'ag-excl-1', cwd: excludedProj },
      { terminalId: 'tab-excl-ag', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(agStartExcl, {});
    assert.equal(readSavedSession('tab-excl-ag', { globalDir: env.globalDir, legacyHome: env.homeDir })?.sessionId, 'ag-excl-1');

    const agPreExcl = handleAntigravityPreInvocation(
      { conversationId: 'ag-excl-1', rootConversationId: 'ag-excl-1', cwd: excludedProj, lastUserInput: '/compact' },
      { terminalId: 'tab-excl-ag', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(agPreExcl, {});

    // Non-excluded project still receives full HEAD_CORE + PreCompact pointer
    const clStartAllowed = handleClaudeSessionStart(
      { session_id: 'cl-ok-1', cwd: allowedProj, source: 'startup' },
      { terminalId: 'tab-ok-cl', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.match(clStartAllowed.hookSpecificOutput.additionalContext, /# HEAD_CORE/);

    const clCompactAllowed = handleClaudePreCompact({ cwd: allowedProj }, { globalDir: env.globalDir });
    assert.equal(clCompactAllowed.continue, true);

    // Switch to opt-in mode -> only listed enabledProjects activate
    fs.writeFileSync(
      path.join(env.globalDir, 'config.json'),
      JSON.stringify({ mode: 'opt-in', enabledProjects: [allowedProj], excludedProjects: [] }, null, 2),
      'utf8',
    );
    assert.deepEqual(handleClaudePreCompact({ cwd: excludedProj }, { globalDir: env.globalDir }), {});
    assert.equal(handleClaudePreCompact({ cwd: allowedProj }, { globalDir: env.globalDir }).continue, true);
  } finally {
    env.cleanup();
  }
});

test('P0-1 regression: Antigravity transcript role probe blocks subagents without rootConversationId, defers unknown SessionStart, and never creates .memory/ on uninitialized projects', () => {
  const env = makeTempEnv('cortex-agy-sub-');
  try {
    // 1. detectAntigravityTranscriptRole classifies missing/empty, subagent [Message], and root USER_INPUT accurately
    assert.equal(detectAntigravityTranscriptRole(path.join(env.root, 'missing.jsonl')), 'unknown');

    const emptyTranscript = path.join(env.root, 'empty.jsonl');
    atomicWriteText(emptyTranscript, '');
    assert.equal(detectAntigravityTranscriptRole(emptyTranscript), 'unknown');

    const subTranscript = path.join(env.root, 'subagent-transcript.jsonl');
    writeJsonl(subTranscript, [
      {
        type: 'SYSTEM_MESSAGE',
        step_index: 0,
        text: '[Message] timestamp=2026-11-23T02:48:11Z sender=b8cfadc9-4bc6-41e7-98bf-e120094cd671 priority=MESSAGE_PRIORITY_HIGH content=Run audit task',
      },
    ]);
    assert.equal(detectAntigravityTranscriptRole(subTranscript), 'subagent');

    const rootTranscript = path.join(env.root, 'root-transcript.jsonl');
    writeJsonl(rootTranscript, [
      { type: 'USER_INPUT', step_index: 0, userInput: { userResponse: '<USER_REQUEST>Build feature</USER_REQUEST>' } },
      {
        type: 'SYSTEM_MESSAGE',
        step_index: 1,
        text: '[Message] timestamp=2026-11-23T02:50:00Z sender=worker-12345678 content=Worker reply',
      },
    ]);
    assert.equal(detectAntigravityTranscriptRole(rootTranscript), 'root');

    // 2. Real Antigravity SessionStart (no rootConversationId, empty transcript) defers to PreInvocation
    const deferredStart = handleAntigravitySessionStart(
      { conversationId: 'conv-head-real', transcriptPath: emptyTranscript, cwd: env.projectDir },
      { terminalId: 't14', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(deferredStart, {});
    assert.equal(readSavedSession('t14', { globalDir: env.globalDir, legacyHome: env.homeDir }), null);

    // 3. First root PreInvocation (no rootConversationId, transcript has USER_INPUT) injects HEAD_CORE once
    //    and stores checkpoint under globalDir (NEVER creating <project>/.memory/ on uninitialized project!)
    const rootPre1 = handleAntigravityPreInvocation(
      { conversationId: 'conv-head-real', transcriptPath: rootTranscript, cwd: env.projectDir, lastUserInput: 'Build feature' },
      { terminalId: 't14', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.ok(rootPre1.injectSteps.length >= 1);
    assert.match(rootPre1.injectSteps[0].systemMessage.systemMessage, /# HEAD_CORE/);
    assert.equal(readSavedSession('t14', { globalDir: env.globalDir, legacyHome: env.homeDir })?.sessionId, 'conv-head-real');
    assert.equal(fs.existsSync(path.join(env.projectDir, '.memory')), false);
    assert.equal(fs.existsSync(path.join(env.globalDir, 'state', 'checkpoints', 'conv-head-real.json')), true);

    // Second root PreInvocation does NOT duplicate HEAD_CORE
    const rootPre2 = handleAntigravityPreInvocation(
      { conversationId: 'conv-head-real', transcriptPath: rootTranscript, cwd: env.projectDir, lastUserInput: 'Next step' },
      { terminalId: 't14', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(rootPre2, {});

    // 4. Subagent PreInvocation (NO rootConversationId! Only transcript has [Message] sender=...)
    //    MUST return {} and MUST NOT overwrite parent t14.json!
    const subPre = handleAntigravityPreInvocation(
      { conversationId: 'conv-sub-real', transcriptPath: subTranscript, cwd: env.projectDir },
      { terminalId: 't14', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.deepEqual(subPre, {});
    assert.equal(readSavedSession('t14', { globalDir: env.globalDir, legacyHome: env.homeDir })?.sessionId, 'conv-head-real');

    // 5. tracker.mjs expanded subagent fields + strict sessionId validation
    assert.equal(isSubagentPayload({ parentConversationId: 'parent-1' }), true);
    assert.equal(isSubagentPayload({ parent_session_id: 'parent-2' }), true);
    const badSid = recordSession({
      terminalId: 't14',
      agent: 'claude',
      payload: { session_id: 'abc; Start-Process calc', cwd: env.projectDir },
      globalDir: env.globalDir,
      legacyHome: env.homeDir,
    });
    assert.equal(badSid.recorded, false);
    assert.equal(badSid.reason, 'invalid_session_id');
    assert.equal(readSavedSession('t14', { globalDir: env.globalDir, legacyHome: env.homeDir })?.sessionId, 'conv-head-real');
  } finally {
    env.cleanup();
  }
});

test('P1-3 & P2-6 regression: recent-turns tail-reads >2MB JSONL, anchors noise patterns, preserves User has answered, skips consecutive empty boundaries, and preserves tail conclusion', () => {
  const env = makeTempEnv('cortex-tail-');
  try {
    // 1. >2.2MB JSONL transcript: tail-read skips old head and cleanly extracts final turns
    const bigPath = path.join(env.root, 'huge.jsonl');
    const fillerLine = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'X'.repeat(1000) } })}\n`;
    const chunks = [];
    for (let i = 0; i < 2300; i++) chunks.push(fillerLine); // ~2.4MB
    chunks.push(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Mentioning <command-name> mid-sentence is valid' } })}\n`);
    chunks.push(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Final tail answer preserved' }] } })}\n`);
    chunks.push(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'User has answered: Ship Option B.' }] },
    })}\n`);
    chunks.push(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Proceeding with Option B.' }] } })}\n`);
    fs.writeFileSync(bigPath, chunks.join(''), 'utf8');

    const tailRes = extractClaudeRecentTurns(bigPath, { maxTurns: 2, maxChars: 4500 });
    assert.equal(tailRes.turns.length, 2);
    assert.match(tailRes.text, /Mentioning <command-name> mid-sentence is valid/);
    assert.match(tailRes.text, /User has answered: Ship Option B/);
    assert.match(tailRes.text, /Proceeding with Option B/);

    // 2. Multiple consecutive empty compact_boundary entries walk back to last non-empty segment
    const multiBoundaryPath = path.join(env.root, 'multi-boundary.jsonl');
    writeJsonl(multiBoundaryPath, [
      { type: 'user', message: { role: 'user', content: 'Real turn before double compact' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Real reply before double compact' }] } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'system', subtype: 'compact_boundary' },
    ]);
    const multiRes = extractClaudeRecentTurns(multiBoundaryPath);
    assert.equal(multiRes.turns.length, 1);
    assert.match(multiRes.text, /Real reply before double compact/);

    // 3. Oversized single turn trimming preserves BOTH user question (head) AND assistant conclusion (tail)
    const hugeSinglePath = path.join(env.root, 'huge-single.jsonl');
    writeJsonl(hugeSinglePath, [
      { type: 'user', message: { role: 'user', content: 'HEAD_QUESTION_MARKER explain architecture' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${'middle detail '.repeat(120)} FINAL_CONCLUSION_MARKER` }],
        },
      },
    ]);
    const trimmed = extractClaudeRecentTurns(hugeSinglePath, { maxTurns: 1, maxChars: 240 });
    assert.ok(trimmed.charCount <= 240, `Expected <= 240, got ${trimmed.charCount}`);
    assert.match(trimmed.text, /HEAD_QUESTION_MARKER/);
    assert.match(trimmed.text, /FINAL_CONCLUSION_MARKER/);
  } finally {
    env.cleanup();
  }
});

test('Post-review regression: P0-only baseline renders in Claude and Antigravity hooks', () => {
  const env = makeTempEnv('cortex-p0only-');
  try {
    const store = new CortexStore({ projectDir: env.projectDir, globalDir: env.globalDir, disableVec: true });
    try {
      store.saveDoc({
        id: 'base-p0-only',
        type: 'baseline',
        title: 'Sole P0 Baseline',
        summary: 'Only document in this project is a P0 baseline.',
        tags: ['P0'],
      });
    } finally {
      store.close();
    }

    const claudeOut = handleClaudeSessionStart(
      { session_id: 'head-p0-only', cwd: env.projectDir },
      { part: 'context', terminalId: 'tab-p0', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    assert.match(claudeOut.hookSpecificOutput?.additionalContext || '', /Sole P0 Baseline/);

    const agyTranscript = path.join(env.root, 'agy-p0-only.jsonl');
    writeJsonl(agyTranscript, [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: 'Check P0 baseline' }] } },
    ]);
    const agyOut = handleAntigravityPreInvocation(
      { conversationId: 'conv-p0-only', transcriptPath: agyTranscript, cwd: env.projectDir },
      { terminalId: 'tab-p0-agy', globalDir: env.globalDir, legacyHome: env.homeDir, promptsDir: env.promptsDir },
    );
    const agyText = (agyOut.injectSteps || []).map((s) => s.systemMessage?.systemMessage || '').join('\n');
    assert.match(agyText, /Sole P0 Baseline/);
  } finally {
    env.cleanup();
  }
});
