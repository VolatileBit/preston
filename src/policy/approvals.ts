import { MCP_SERVER_NAME } from "../mcp/names.js";
import type { ApprovalDecision, ApprovalRequest } from "../workers/types.js";
import { evaluate, type PolicyAction, type PolicyDecision, type PolicyScope } from "./policy.js";

/**
 * Translates the agents' native approval requests into policy actions and the policy's
 * decision back into their native answers. A Worker's escalations go to the Coordinator
 * (`escalations.ts`); `decide` alone declines them, which is what the Coordinator's own
 * requests get.
 */

export interface ClaudePermissionInput {
  tool_name: string;
  input: Record<string, unknown>;
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
const PLANNING_TOOLS = new Set(["TodoWrite", "Task", "Agent", "ExitPlanMode"]);

export function claudeAction(request: ClaudePermissionInput): PolicyAction {
  const { tool_name: tool, input } = request;
  const str = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;
  if (tool.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return { kind: "preston" };
  if (READ_TOOLS.has(tool))
    return { kind: "read", paths: present(str("file_path"), str("path"), str("notebook_path")) };
  if (WRITE_TOOLS.has(tool))
    return { kind: "write", paths: present(str("file_path"), str("notebook_path")) };
  if (SHELL_TOOLS.has(tool)) return { kind: "command", command: str("command") ?? "" };
  if (NETWORK_TOOLS.has(tool))
    return { kind: "network", summary: str("url") ?? str("query") ?? tool };
  if (PLANNING_TOOLS.has(tool)) return { kind: "preston" };
  return { kind: "other", summary: tool };
}

/**
 * The text result Claude Code's `--permission-prompt-tool` must return: a JSON object
 * `{"behavior":"allow","updatedInput":...}` or `{"behavior":"deny","message":...}`.
 * This is the only place that knows the shape.
 */
export function claudePermissionResult(
  decision: ApprovalDecision,
  request: ClaudePermissionInput,
): string {
  return JSON.stringify(
    decision.allow
      ? { behavior: "allow", updatedInput: request.input }
      : { behavior: "deny", message: decision.reason },
  );
}

/** Maps a Codex App Server approval request (delivered through the adapter) to a policy action. */
export function nativeAction(request: ApprovalRequest): PolicyAction {
  switch (request.kind) {
    case "command":
      return { kind: "command", command: request.command ?? request.summary, cwd: request.cwd };
    case "file_change":
      return { kind: "write", paths: request.paths ?? [] };
    case "network":
      return { kind: "network", summary: request.summary };
    case "other":
      return { kind: "other", summary: request.summary };
  }
}

/** The policy's decision on its own: escalations become denials with a clear reason. */
export function decide(
  action: PolicyAction,
  scope: PolicyScope,
): { decision: ApprovalDecision; policy: PolicyDecision } {
  const policy = evaluate(action, scope);
  if (policy.verdict === "allow") return { decision: { allow: true }, policy };
  return {
    policy,
    decision: {
      allow: false,
      reason:
        `Preston did not approve this because ${policy.reason}. That needs approval beyond this Goal's ` +
        "authority, which Preston cannot grant right now. Continue with work that does not need it, " +
        "and list it under blockers when you call report_result.",
    },
  };
}

function present(...values: (string | undefined)[]): string[] {
  return values.filter((v): v is string => Boolean(v));
}
