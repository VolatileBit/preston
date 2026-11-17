/**
 * Contract between Preston and the coding agents it drives (Workers and the Coordinator).
 * Adapters translate a native CLI protocol into these shapes. Keep changes additive.
 */

export type AgentKind = "claude" | "codex" | "fake";

export interface AgentDetection {
  installed: boolean;
  /** Absolute path of the executable that would be run. */
  path?: string;
  version?: string;
  /** Whether the CLI has a usable login; "unknown" when it cannot be checked cheaply. */
  loggedIn?: boolean | "unknown";
  /** Plain-language description of what is wrong, for the setup conversation. */
  problem?: string;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  efforts?: string[];
  isDefault?: boolean;
}

/** Why work cannot proceed for quota reasons. Only these pause a Run as waiting_for_quota. */
export type QuotaKind = "usage_limit" | "rate_limit" | "spend_limit";

export interface QuotaReading {
  /** Provider + account + metered bucket, e.g. "codex:primary" or "claude:five_hour". */
  bucket: string;
  available: boolean | "unknown";
  usedPercent?: number;
  /** ISO timestamp when the bucket is expected to reset, if the provider says. */
  resetsAt?: string;
  checkedAt: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

/** How an agent CLI should launch Preston's MCP server (`preston mcp --token ...`). */
export interface McpLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * What an agent may do on the machine.
 * - `full`: everything the user's own account can do, with no sandbox and no permission prompts
 *   (Workers, ADR 0003).
 * - `tools_only`: nothing but Preston's own MCP tools (the Coordinator, which reads untrusted text).
 */
export type AgentAccess = "full" | "tools_only";

export interface StartRunInput {
  /** Preston's Run ID, for logging and MCP token scoping. */
  runId: string;
  workdir: string;
  /** The user-turn input for this invocation (Brief for a Worker, event/message for the Coordinator). */
  prompt: string;
  /** Resume this native Session instead of starting a new one. */
  resumeSessionId?: string;
  /** Guidance appended to the agent's own system prompt; never replaces native instructions. */
  appendSystemPrompt?: string;
  /** Unset means: inherit the user's own CLI configuration. */
  model?: string;
  effort?: string;
  /** Preston's MCP server for this Run. */
  mcp?: McpLaunchSpec;
  access: AgentAccess;
  /** Where the adapter writes the raw transcript/log for this invocation. */
  transcriptPath?: string;
}

export type WorkerEvent =
  | { type: "started"; at: string; sessionId: string }
  | {
      type: "activity";
      at: string;
      kind: string;
      summary?: string;
      /** True while a tool or shell command is still executing (long silence is then plausible). */
      toolRunning: boolean;
    }
  | { type: "message"; at: string; text: string }
  | {
      type: "quota_blocked";
      at: string;
      bucket: string;
      kind: QuotaKind;
      resetsAt?: string;
      detail?: string;
    }
  | { type: "auth_error"; at: string; detail: string }
  | { type: "completed"; at: string; finalText: string; usage?: TokenUsage }
  | { type: "failed"; at: string; error: string; retryable: boolean }
  | { type: "exited"; at: string; code: number | null; signal?: string | null };

export interface RunHandle {
  /** Ends after a terminal event (`completed`, `failed`, `quota_blocked`, `auth_error`) and `exited`. */
  readonly events: AsyncIterable<WorkerEvent>;
  /** Resolves once the native Session ID is known. */
  sessionId(): Promise<string>;
  interrupt(): Promise<void>;
  /**
   * PID of the agent process serving this turn, once it is running. Preston records it (with the
   * process start identity) so a restarted daemon can terminate agent processes it orphaned.
   */
  processId?(): number | undefined;
}

export interface UpdateResult {
  updated: boolean;
  fromVersion?: string;
  toVersion?: string;
  /** The updater itself failed (as opposed to finding nothing newer). */
  failed?: boolean;
  /** The install is managed by something else (a package manager, an administrator). */
  managedExternally?: boolean;
  detail: string;
}

export interface WorkerAdapter {
  readonly agent: AgentKind;
  detect(): Promise<AgentDetection>;
  startRun(input: StartRunInput): RunHandle;
  /** Token-free quota read, where the provider supports one. */
  readQuota?(): Promise<QuotaReading[]>;
  listModels?(): Promise<ModelInfo[]>;
  /** Bring the CLI up to date using its own updater. Only called when no Run uses this CLI. */
  update?(): Promise<UpdateResult>;
}
