/**
 * Recognition of this MCP server's tools by name, shared by the hook handlers and the installer.
 *
 * Claude Code names an MCP tool `mcp__<server>__<tool>`. The server is registered as `herdr-cortex`
 * (`MCP_SERVER_NAME`); installations made before the rename registered it as `cortex`. The hooks recognize
 * the tools under both names (the helpers below), so a setup that has not been re-installed yet keeps working;
 * only the new name is registered by the installer.
 */
export const MCP_SERVER_NAME = 'herdr-cortex';
export const LEGACY_MCP_SERVER_NAME = 'cortex';
export const CORTEX_MCP_SERVER_NAMES = Object.freeze([MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]);

const CORTEX_TOOL_PREFIX_RE = /^(?:mcp__)?(?:herdr-cortex|cortex)__/i;

const CORTEX_DIRECT_TOOLS = new Set([
  'memory_search',
  'memory_read',
  'memory_save',
  'memory_update',
  'memory_graph',
  'memory_overview',
  'relay_tabs',
  'relay_send',
  'relay_inbox',
  'cortex_prompt',
]);

/**
 * Lower-case tool name without the server prefix ("mcp__cortex__memory_save" -> "memory_save",
 * "mcp__herdr-cortex__Memory_Save" -> "memory_save"). A bare name is returned only when it is one of this
 * server's tools. Returns '' for any other tool.
 */
export function cortexToolBaseName(toolName) {
  if (typeof toolName !== 'string') return '';
  const trimmed = toolName.trim();
  if (!trimmed) return '';
  if (CORTEX_TOOL_PREFIX_RE.test(trimmed)) {
    return trimmed.replace(CORTEX_TOOL_PREFIX_RE, '').toLowerCase();
  }
  return CORTEX_DIRECT_TOOLS.has(trimmed) ? trimmed : '';
}

export function isCortexToolName(toolName) {
  if (typeof toolName !== 'string') return false;
  const trimmed = toolName.trim();
  if (!trimmed) return false;
  return CORTEX_DIRECT_TOOLS.has(trimmed) || CORTEX_TOOL_PREFIX_RE.test(trimmed);
}

/** Built-in tools that read or search files; counted per prompt turn for read-volume notices. */
export const FILE_READ_TOOL_NAMES = Object.freeze(['Read', 'Grep', 'Glob']);

/** Built-in tools that write files; a subagent may not point them into a `.memory/` folder. */
export const FILE_WRITE_TOOL_NAMES = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Built-in shell tools; a subagent's command may not reference a `.memory/` folder. */
export const SHELL_TOOL_NAMES = Object.freeze(['Bash', 'PowerShell']);

/** Antigravity built-in file-edit tools (`agy` 1.5.18 observed names). */
export const ANTIGRAVITY_FILE_WRITE_TOOL_NAMES = Object.freeze(['write_file', 'edit_file']);

/** Antigravity built-in shell tool (`agy` 1.5.18 observed name). */
export const ANTIGRAVITY_SHELL_TOOL_NAMES = Object.freeze(['run_command']);

/** Antigravity built-in file-read tool (`agy` 1.5.18 observed name). */
export const ANTIGRAVITY_FILE_READ_TOOL_NAMES = Object.freeze(['read_file']);

const ANTIGRAVITY_COLON_CORTEX_RE = /^(?:mcp__?)?(?:herdr-cortex|cortex)[_./:-]+([a-z0-9_]+)$/i;
const ANTIGRAVITY_MEMORY_SAVE_SUFFIX_RE = /(?:^|[_./:-])memory_save$/i;

/**
 * Inspect an Antigravity `toolCall` (`name` + `args`) to determine whether it invokes one of this MCP server's
 * tools—either directly (`mcp__herdr-cortex__<tool>`, `herdr-cortex:<tool>`, or bare Cortex `<tool>`) or through
 * Antigravity's lazy MCP wrapper (`call_mcp_tool` with `ServerName` in `herdr-cortex` / `cortex`).
 * When `allowMemorySaveSuffix` is `true` (used only by non-blocking `PostToolUse` window clearing), also accepts
 * tool names ending in `memory_save` unless `call_mcp_tool` explicitly names a different server.
 * Returns `{ isCortex, baseName, args }`.
 */
export function resolveAntigravityCortexTool(toolName, rawArgs = {}, { allowMemorySaveSuffix = false } = {}) {
  const safeArgs = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const trimmed = typeof toolName === 'string' ? toolName.trim() : '';
  if (!trimmed) return { isCortex: false, baseName: '', args: safeArgs };

  if (trimmed === 'call_mcp_tool') {
    const serverName = String(safeArgs.ServerName ?? safeArgs.serverName ?? safeArgs.server_name ?? '')
      .trim()
      .toLowerCase();
    if (!CORTEX_MCP_SERVER_NAMES.includes(serverName)) {
      return { isCortex: false, baseName: '', args: safeArgs };
    }
    const innerTool = String(safeArgs.ToolName ?? safeArgs.toolName ?? safeArgs.tool_name ?? '')
      .trim()
      .toLowerCase();
    const rawInnerArgs = safeArgs.Arguments ?? safeArgs.arguments;
    const innerArgs = rawInnerArgs && typeof rawInnerArgs === 'object' && !Array.isArray(rawInnerArgs)
      ? rawInnerArgs
      : {};
    return { isCortex: Boolean(innerTool), baseName: innerTool, args: innerArgs };
  }

  const directBase = cortexToolBaseName(trimmed);
  if (directBase) {
    return { isCortex: true, baseName: directBase, args: safeArgs };
  }

  const sepMatch = ANTIGRAVITY_COLON_CORTEX_RE.exec(trimmed);
  if (sepMatch) {
    return { isCortex: true, baseName: sepMatch[1].toLowerCase(), args: safeArgs };
  }

  if (allowMemorySaveSuffix && ANTIGRAVITY_MEMORY_SAVE_SUFFIX_RE.test(trimmed)) {
    return { isCortex: true, baseName: 'memory_save', args: safeArgs };
  }

  return { isCortex: false, baseName: '', args: safeArgs };
}

/**
 * Matcher the installer registers for the Claude Code PreToolUse hook: this server's tools (under the name
 * the installer registers), plus the file-write, shell, and file-read tools inspected by `.memory/` and
 * work-size guards.
 */
export const CLAUDE_PRE_TOOL_USE_MATCHER = [
  `mcp__${MCP_SERVER_NAME}__.*`,
  ...FILE_WRITE_TOOL_NAMES,
  ...SHELL_TOOL_NAMES,
  ...FILE_READ_TOOL_NAMES,
].join('|');

/**
 * Matcher the installer registers for the Claude Code PostToolUse hook: shell tools (to detect `git commit`
 * and clear failed-edit retry counts on shell success) and this server's `memory_save` tool.
 */
export const CLAUDE_POST_TOOL_USE_MATCHER = [
  ...SHELL_TOOL_NAMES,
  `mcp__${MCP_SERVER_NAME}__memory_save`,
].join('|');

/**
 * Matcher the installer registers for the Claude Code PostToolUseFailure hook: shell tools whose non-zero
 * exit codes increment per-file failed-edit retry counts.
 */
export const CLAUDE_POST_TOOL_USE_FAILURE_MATCHER = SHELL_TOOL_NAMES.join('|');

/**
 * Matcher the installer registers for the Antigravity PreToolUse hook: observed edit, shell, and read tools,
 * plus this server's MCP tools (via `call_mcp_tool`, `herdr-cortex`/`cortex` prefix, or bare Cortex tool names).
 */
export const ANTIGRAVITY_PRE_TOOL_USE_MATCHER = [
  ...ANTIGRAVITY_FILE_WRITE_TOOL_NAMES,
  ...ANTIGRAVITY_SHELL_TOOL_NAMES,
  ...ANTIGRAVITY_FILE_READ_TOOL_NAMES,
  'call_mcp_tool',
  `(?:mcp__?)?(?:${MCP_SERVER_NAME}|${LEGACY_MCP_SERVER_NAME}).*`,
  ...CORTEX_DIRECT_TOOLS,
].join('|');

/**
 * Matcher the installer registers for the Antigravity PostToolUse hook: shell tool (`run_command`) and this
 * server's `memory_save` MCP tool (direct, suffix, or via `call_mcp_tool`).
 */
export const ANTIGRAVITY_POST_TOOL_USE_MATCHER = [
  ...ANTIGRAVITY_SHELL_TOOL_NAMES,
  'call_mcp_tool',
  `(?:mcp__?)?(?:${MCP_SERVER_NAME}|${LEGACY_MCP_SERVER_NAME}).*`,
  '.*memory_save',
].join('|');
