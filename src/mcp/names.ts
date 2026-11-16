/**
 * Names agent adapters need when wiring Preston's MCP server into a CLI.
 * Claude Code: `--mcp-config` with server `MCP_SERVER_NAME`, and
 * `--permission-prompt-tool mcp__<MCP_SERVER_NAME>__<PERMISSION_TOOL>` (ADR 0003).
 */
export const MCP_SERVER_NAME = "preston";
export const PERMISSION_TOOL = "approve";
export const CLAUDE_PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_NAME}__${PERMISSION_TOOL}`;

/** `StartRunInput.runId` used for Coordinator invocations, which are not Runs. */
export const COORDINATOR_RUN_ID = "coordinator";
