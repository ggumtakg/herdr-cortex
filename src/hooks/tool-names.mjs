/**
 * Recognition of this MCP server's tools by name, shared by the hook handlers and the installer.
 *
 * Claude Code names an MCP tool `mcp__<server>__<tool>`. The server is registered as `cortex` today and
 * will be registered as `herdr-cortex`; both names are accepted everywhere through the helpers below.
 */
export const CORTEX_MCP_SERVER_NAMES = Object.freeze(['herdr-cortex', 'cortex']);

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

/** Built-in tools that write files; a subagent may not point them into a `.memory/` folder. */
export const FILE_WRITE_TOOL_NAMES = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Built-in shell tools; a subagent's command may not reference a `.memory/` folder. */
export const SHELL_TOOL_NAMES = Object.freeze(['Bash', 'PowerShell']);

/**
 * Matcher the installer registers for the Claude Code PreToolUse hook: this server's tools under both
 * server names, plus the file and shell tools the subagent `.memory/` guard inspects.
 */
export const CLAUDE_PRE_TOOL_USE_MATCHER = [
  ...CORTEX_MCP_SERVER_NAMES.map((name) => `mcp__${name}__.*`),
  ...FILE_WRITE_TOOL_NAMES,
  ...SHELL_TOOL_NAMES,
].join('|');
