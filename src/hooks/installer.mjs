#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CONFIG,
  REPO_ROOT,
  assertInsideDir,
  atomicWriteJson,
  atomicWriteText,
} from '../core/config.mjs';
import { resolveEffectiveHome } from '../revive/tracker.mjs';

export const AGY_HOOK_KEY = 'herdr-cortex';
export const LEGACY_AGY_HOOK_KEY = 'herdr-revive-tracker';
export const MCP_SERVER_KEY = 'cortex';
export const CLAUDE_HOOK_MARKER = 'herdr-cortex';
export const SKILL_MANAGED_MARKER = '.herdr-cortex-managed';

const CLAUDE_CLEAN_MARKERS = [
  'herdr-cortex',
  'src/hooks/claude.mjs',
  'src\\hooks\\claude.mjs',
  'record-session.mjs',
];

const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'PreCompact',
  'UserPromptSubmit',
  'PreToolUse',
];

function readJsonOrEmpty(filePath) {
  if (!fs.existsSync(filePath)) {
    return { existed: false, data: {} };
  }
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  if (!raw.trim()) {
    return { existed: true, data: {} };
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return { existed: true, data: parsed };
}

function writeJsonWithBackup(filePath, data, existed) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (existed && fs.existsSync(filePath)) {
    const bakPath = `${filePath}.herdr-cortex.bak`;
    if (!fs.existsSync(bakPath)) {
      fs.copyFileSync(filePath, bakPath);
    }
  }
  atomicWriteJson(filePath, data);
}

function isManagedClaudeHookEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => {
    const cmd = typeof h?.command === 'string' ? h.command : '';
    return CLAUDE_CLEAN_MARKERS.some((marker) => cmd.includes(marker));
  });
}

function buildMcpServerEntry(repoRoot) {
  const serverScript = path.join(repoRoot, 'src', 'mcp', 'server.mjs');
  return {
    command: 'node',
    args: ['--no-warnings', serverScript],
  };
}

function updateAntigravityHooks(homeDir, repoRoot, isInstall) {
  const filePath = path.join(homeDir, '.gemini', 'config', 'hooks.json');
  const { existed, data } = readJsonOrEmpty(filePath);
  const agyScript = path.join(repoRoot, 'src', 'hooks', 'antigravity.mjs');

  if (isInstall) {
    delete data[LEGACY_AGY_HOOK_KEY];
    data[AGY_HOOK_KEY] = {
      SessionStart: [
        {
          type: 'command',
          command: `node --no-warnings "${agyScript}" session-start --id ${CLAUDE_HOOK_MARKER}`,
          timeout: 10,
        },
      ],
      PreInvocation: [
        {
          type: 'command',
          command: `node --no-warnings "${agyScript}" pre-invocation --id ${CLAUDE_HOOK_MARKER}`,
          timeout: 10,
        },
      ],
    };
    writeJsonWithBackup(filePath, data, existed);
    return { path: filePath, action: 'installed' };
  }

  let changed = false;
  if (existed && Object.prototype.hasOwnProperty.call(data, AGY_HOOK_KEY)) {
    delete data[AGY_HOOK_KEY];
    changed = true;
  }
  if (existed && Object.prototype.hasOwnProperty.call(data, LEGACY_AGY_HOOK_KEY)) {
    delete data[LEGACY_AGY_HOOK_KEY];
    changed = true;
  }
  if (changed) {
    writeJsonWithBackup(filePath, data, existed);
    return { path: filePath, action: 'removed' };
  }
  return { path: filePath, action: 'skipped' };
}

function updateMcpConfigFile(filePath, repoRoot, isInstall, createIfMissing) {
  if (!isInstall && !fs.existsSync(filePath)) {
    return { path: filePath, action: 'skipped' };
  }
  if (isInstall && !createIfMissing && !fs.existsSync(filePath)) {
    return { path: filePath, action: 'skipped' };
  }

  const { existed, data } = readJsonOrEmpty(filePath);

  if (isInstall) {
    if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
      data.mcpServers = {};
    }
    data.mcpServers[MCP_SERVER_KEY] = buildMcpServerEntry(repoRoot);
    writeJsonWithBackup(filePath, data, existed);
    return { path: filePath, action: 'installed' };
  }

  if (
    existed
    && data.mcpServers
    && typeof data.mcpServers === 'object'
    && Object.prototype.hasOwnProperty.call(data.mcpServers, MCP_SERVER_KEY)
  ) {
    delete data.mcpServers[MCP_SERVER_KEY];
    writeJsonWithBackup(filePath, data, existed);
    return { path: filePath, action: 'removed' };
  }

  return { path: filePath, action: 'skipped' };
}

function updateClaudeSettings(homeDir, repoRoot, isInstall) {
  const filePath = path.join(homeDir, '.claude', 'settings.json');
  const { existed, data } = readJsonOrEmpty(filePath);
  const claudeScript = path.join(repoRoot, 'src', 'hooks', 'claude.mjs');

  if (!isInstall) {
    let changed = false;
    if (existed && data.hooks && typeof data.hooks === 'object') {
      for (const evt of CLAUDE_HOOK_EVENTS) {
        if (!Array.isArray(data.hooks[evt])) continue;
        const before = data.hooks[evt].length;
        data.hooks[evt] = data.hooks[evt].filter((entry) => !isManagedClaudeHookEntry(entry));
        if (data.hooks[evt].length !== before) changed = true;
        if (data.hooks[evt].length === 0) {
          delete data.hooks[evt];
        }
      }
      if (Object.keys(data.hooks).length === 0) {
        delete data.hooks;
      }
    }
    if (
      existed
      && data.mcpServers
      && typeof data.mcpServers === 'object'
      && Object.prototype.hasOwnProperty.call(data.mcpServers, MCP_SERVER_KEY)
    ) {
      delete data.mcpServers[MCP_SERVER_KEY];
      changed = true;
    }

    if (changed) {
      writeJsonWithBackup(filePath, data, existed);
      return { path: filePath, action: 'removed' };
    }
    return { path: filePath, action: 'skipped' };
  }

  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    data.hooks = {};
  }

  // Strip prior cortex and legacy revive entries for strict idempotency
  for (const evt of CLAUDE_HOOK_EVENTS) {
    const list = Array.isArray(data.hooks[evt]) ? data.hooks[evt] : [];
    data.hooks[evt] = list.filter((entry) => !isManagedClaudeHookEntry(entry));
  }

  data.hooks.SessionStart.push({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `node --no-warnings "${claudeScript}" session-start --id ${CLAUDE_HOOK_MARKER}`,
        timeout: 10,
      },
    ],
  });

  data.hooks.PreCompact.push({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `node --no-warnings "${claudeScript}" pre-compact --id ${CLAUDE_HOOK_MARKER}`,
        timeout: 10,
      },
    ],
  });

  data.hooks.UserPromptSubmit.push({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `node --no-warnings "${claudeScript}" user-prompt --id ${CLAUDE_HOOK_MARKER}`,
        timeout: 10,
      },
    ],
  });

  data.hooks.PreToolUse.push({
    matcher: 'mcp__cortex__.*',
    hooks: [
      {
        type: 'command',
        command: `node --no-warnings "${claudeScript}" pre-tool-use --id ${CLAUDE_HOOK_MARKER}`,
        timeout: 10,
      },
    ],
  });

  writeJsonWithBackup(filePath, data, existed);
  return { path: filePath, action: 'installed' };
}

function syncClaudeSkills(homeDir, repoRoot, isInstall) {
  const skillsDestRoot = path.join(homeDir, '.claude', 'skills');
  const skillsSrcRoot = path.join(repoRoot, 'prompts', 'skills');

  if (!isInstall) {
    const removed = [];
    if (!fs.existsSync(skillsDestRoot)) {
      return { path: skillsDestRoot, action: 'skipped', skills: removed };
    }
    const entries = fs.readdirSync(skillsDestRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith('cortex-')) continue;
      const targetDir = assertInsideDir(skillsDestRoot, ent.name);
      const markerPath = path.join(targetDir, SKILL_MANAGED_MARKER);
      if (fs.existsSync(markerPath)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        removed.push(ent.name);
      }
    }
    return {
      path: skillsDestRoot,
      action: removed.length > 0 ? 'removed' : 'skipped',
      skills: removed,
    };
  }

  if (!fs.existsSync(skillsSrcRoot)) {
    return { path: skillsDestRoot, action: 'skipped', skills: [] };
  }

  const srcEntries = fs.readdirSync(skillsSrcRoot, { withFileTypes: true })
    .filter((ent) => ent.isDirectory());
  if (srcEntries.length === 0) {
    return { path: skillsDestRoot, action: 'skipped', skills: [] };
  }

  fs.mkdirSync(skillsDestRoot, { recursive: true });
  const installed = [];

  for (const ent of srcEntries) {
    const srcDir = assertInsideDir(skillsSrcRoot, ent.name);
    const destName = ent.name.startsWith('cortex-') ? ent.name : `cortex-${ent.name}`;
    const destDir = assertInsideDir(skillsDestRoot, destName);

    if (fs.existsSync(destDir)) {
      const markerPath = path.join(destDir, SKILL_MANAGED_MARKER);
      if (fs.existsSync(markerPath)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      } else {
        // Do not clobber a non-cortex user-authored skill directory
        continue;
      }
    }

    fs.cpSync(srcDir, destDir, { recursive: true });
    // Sync SKILL.md frontmatter `name:` to match the installed cortex-<skill> directory name
    const skillMdPath = path.join(destDir, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const rawSkill = fs.readFileSync(skillMdPath, 'utf8').replace(/^\uFEFF/, '');
      const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(rawSkill);
      if (fmMatch) {
        const fmBody = fmMatch[1];
        const eol = rawSkill.includes('\r\n') ? '\r\n' : '\n';
        const updatedFmBody = /^name\s*:\s*.*$/m.test(fmBody)
          ? fmBody.replace(/^name\s*:\s*.*$/m, `name: ${destName}`)
          : `name: ${destName}${eol}${fmBody}`;
        const updatedSkill = `---${eol}${updatedFmBody}${eol}---${rawSkill.slice(fmMatch[0].length)}`;
        atomicWriteText(skillMdPath, updatedSkill);
      }
    }
    atomicWriteText(path.join(destDir, SKILL_MANAGED_MARKER), `managed-by=herdr-cortex\nsource=${srcDir}\n`);
    installed.push(destName);
  }

  return {
    path: skillsDestRoot,
    action: installed.length > 0 ? 'installed' : 'skipped',
    skills: installed,
  };
}

function ensureGlobalCortexDir(homeDir) {
  const globalDir = path.join(homeDir, '.herdr-cortex');
  fs.mkdirSync(path.join(globalDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(globalDir, 'docs'), { recursive: true });
  const cfgPath = path.join(globalDir, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    atomicWriteJson(cfgPath, DEFAULT_CONFIG);
  }
  return { globalDir, configPath: cfgPath };
}

/**
 * Install herdr-cortex hooks, MCP configs, global dirs, and Claude skills safely.
 */
export function installCortex({
  repoRoot = REPO_ROOT,
  homeDir,
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedHome = resolveEffectiveHome(homeDir);

  const globalInit = ensureGlobalCortexDir(resolvedHome);
  const antigravityHooks = updateAntigravityHooks(resolvedHome, resolvedRoot, true);
  const antigravityMcpPrimary = updateMcpConfigFile(
    path.join(resolvedHome, '.gemini', 'antigravity-cli', 'mcp_config.json'),
    resolvedRoot,
    true,
    true,
  );
  const antigravityMcpSecondary = updateMcpConfigFile(
    path.join(resolvedHome, '.gemini', 'config', 'mcp_config.json'),
    resolvedRoot,
    true,
    false,
  );
  const claudeSettings = updateClaudeSettings(resolvedHome, resolvedRoot, true);
  const claudeMcp = updateMcpConfigFile(
    path.join(resolvedHome, '.claude.json'),
    resolvedRoot,
    true,
    true,
  );
  const skills = syncClaudeSkills(resolvedHome, resolvedRoot, true);

  return {
    action: 'install',
    homeDir: resolvedHome,
    repoRoot: resolvedRoot,
    globalInit,
    antigravityHooks,
    antigravityMcp: [antigravityMcpPrimary, antigravityMcpSecondary],
    claudeSettings,
    claudeMcp,
    skills,
  };
}

/**
 * Uninstall herdr-cortex hooks, MCP entries, and managed skills cleanly,
 * preserving all pre-existing user entries.
 */
export function uninstallCortex({
  repoRoot = REPO_ROOT,
  homeDir,
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedHome = resolveEffectiveHome(homeDir);

  const antigravityHooks = updateAntigravityHooks(resolvedHome, resolvedRoot, false);
  const antigravityMcpPrimary = updateMcpConfigFile(
    path.join(resolvedHome, '.gemini', 'antigravity-cli', 'mcp_config.json'),
    resolvedRoot,
    false,
    false,
  );
  const antigravityMcpSecondary = updateMcpConfigFile(
    path.join(resolvedHome, '.gemini', 'config', 'mcp_config.json'),
    resolvedRoot,
    false,
    false,
  );
  const claudeSettings = updateClaudeSettings(resolvedHome, resolvedRoot, false);
  const claudeMcp = updateMcpConfigFile(
    path.join(resolvedHome, '.claude.json'),
    resolvedRoot,
    false,
    false,
  );
  const skills = syncClaudeSkills(resolvedHome, resolvedRoot, false);

  return {
    action: 'uninstall',
    homeDir: resolvedHome,
    repoRoot: resolvedRoot,
    antigravityHooks,
    antigravityMcp: [antigravityMcpPrimary, antigravityMcpSecondary],
    claudeSettings,
    claudeMcp,
    skills,
  };
}

function logSummary(res) {
  const tag = (action) => (action === 'skipped' ? '[SKIP]' : '[OK]');
  console.log(`${tag(res.antigravityHooks.action)} Antigravity hooks (${res.antigravityHooks.action}): ${res.antigravityHooks.path}`);
  for (const m of res.antigravityMcp) {
    if (m.action !== 'skipped') {
      console.log(`[OK] Antigravity MCP (${m.action}): ${m.path}`);
    }
  }
  console.log(`${tag(res.claudeSettings.action)} Claude Code hooks (${res.claudeSettings.action}): ${res.claudeSettings.path}`);
  console.log(`${tag(res.claudeMcp.action)} Claude Code MCP (${res.claudeMcp.action}): ${res.claudeMcp.path}`);
  if (res.skills.skills.length > 0) {
    console.log(`[OK] Claude Code skills (${res.skills.action}): ${res.skills.skills.join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const action = (process.argv[2] || '').trim().toLowerCase();
  const repoRoot = process.argv[3] ? path.resolve(process.argv[3]) : REPO_ROOT;

  if (action !== 'install' && action !== 'uninstall') {
    console.error('Usage: node --no-warnings src/hooks/installer.mjs <install|uninstall> [repoRoot]');
    process.exit(1);
  }

  const result = action === 'install'
    ? installCortex({ repoRoot })
    : uninstallCortex({ repoRoot });
  logSummary(result);
}
