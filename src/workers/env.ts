/**
 * The environment Preston hands the agent CLIs it starts (Workers and the Coordinator).
 *
 * When `preston` itself is started from inside an agent session (for example from a Claude Code
 * or Codex shell, or by an agent doing setup with computer use), the daemon inherits that
 * session's internal variables. Passed on, they make a nested `claude` refuse to start
 * (`CLAUDECODE`) or attach to the parent's host, IDE or messaging socket, and make a nested
 * `codex` believe it already runs inside a sandbox or a parent thread. Those are removed.
 *
 * Kept on purpose: the user's own configuration and credentials, such as `ANTHROPIC_*`,
 * `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CODEX_HOME`,
 * `CODEX_API_KEY`, `OPENAI_*` and proxy or certificate settings. Names were checked against
 * Claude Code 2.1.325 and codex-cli 0.169.0 (2026-11-16).
 */

const NESTED_SESSION_VARIABLES: readonly RegExp[] = [
  // Claude Code: the nested-session marker and the parent's process, session and host plumbing.
  /^CLAUDECODE$/,
  /^CLAUDE_(PID|EFFORT|SESSION_ID|SESSION_SURFACE)$/,
  /^CLAUDE_(RUNNER_SESSION|BRIDGE|BG_SESSION|AGENT_SDK|INTERNAL)_\w+$/,
  /^CLAUDE_CODE_(ENTRYPOINT\w*|SESSION_\w+|CHILD_SESSION|EXECPATH|SSE_PORT|MESSAGING_\w+)$/,
  /^CLAUDE_CODE_(HOST_\w+|HOSTED_DESKTOP|DESKTOP_\w+|BRIDGE_\w+|REMOTE(_\w+)?)$/,
  /^CLAUDE_CODE_(SDK_\w+|ENABLE_SDK_\w+|EMIT_\w+|USER_DELEGATED_SESSION\w*|SESSIONS_OAUTH_TOKEN)$/,
  /^CLAUDE_CODE_(CLOUD_SESSION_ID|PROJECTS_SESSION|RESUME_FROM_SESSION|TERMINAL_MCP_TOOLS)$/,
  /^CLAUDE_CODE_(ENABLE_ASK_USER_QUESTION_TOOL|EAGER_FLUSH|REPORT_FINDINGS|STARTUP_FAILURE_RESULTS)$/,
  /^CLAUDE_CODE_(\w+_BY_HOST|NOTIFICATIONS_HOST|MCP_APPS_HOST|ACCOUNT_UUID|ORGANIZATION_UUID)$/,
  /^CLAUDE_CODE_(USER_EMAIL|OAUTH_SCOPES)$/,
  /^AI_AGENT$/,
  // Codex: the parent thread and tool call, its sandbox, network proxy and shell snapshot.
  /^_*CODEX_(THREAD_ID|TOOL_CALL_ID|SESSION_ID|PERMISSION_PROFILE|STARTING_DIFF)$/,
  /^_*CODEX_(SANDBOX\w*|NETWORK_\w+|SNAPSHOT_\w+|SHELL_SNAPSHOT_\w+|INTERNAL_\w+)$/,
  /^_*CODEX_(EXEC_SERVER_\w+|DAEMON_TELEMETRY_HANDOFF|MCP_PROTOCOL_VERSION)$/,
  // Set by the npm/bun launcher for its own child; the launcher sets them again when it runs.
  /^CODEX_MANAGED_\w+$/,
];

/** Whether a variable belongs to a parent agent session rather than to the user. */
export function isNestedSessionVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return NESTED_SESSION_VARIABLES.some((pattern) => pattern.test(upper));
}

/** A copy of `env` without the variables of a parent agent session. */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isNestedSessionVariable(name)) out[name] = value;
  }
  return out;
}
