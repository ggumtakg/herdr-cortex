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
