/**
 * Maps Claude Code's `--output-format stream-json` messages to WorkerEvents.
 *
 * Message shapes: https://code.claude.com/docs/en/agent-sdk/typescript (SDKMessage) and
 * https://code.claude.com/docs/en/headless, confirmed against recorded 2.1.325 transcripts.
 * Unknown message types and fields are ignored so newer CLI versions keep working.
 *
 * The terminal event is decided by the last `result` (background work can start further turns),
 * or by what was seen before the process exited, and is emitted only once the process has exited.
 */
import type { TokenUsage, WorkerEvent } from "../types.js";
import {
  classifyFailure,
  normaliseResetsAt,
  type RejectedLimit,
  type TerminalDraft,
} from "./classify.js";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export class ClaudeStreamMapper {
  private sessionId: string | undefined;
  private readonly openTools = new Map<string, string>();
  private rejected: RejectedLimit | undefined;
  private heldError: TerminalDraft | undefined;
  private resultTerminal: TerminalDraft | undefined;
  private interrupted = false;
  private lastRetry: string | undefined;

  constructor(private readonly now: () => Date) {}

  get knownSessionId(): string | undefined {
    return this.sessionId;
  }

  get sawResult(): boolean {
    return this.resultTerminal !== undefined;
  }

  markInterrupted(): void {
    this.interrupted = true;
  }

  /** Parses one stdout line. Malformed lines yield no events. */
  handleLine(line: string): WorkerEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObject(message)) return [];
    return this.handleMessage(message);
  }

  private at(): string {
    return this.now().toISOString();
  }

  private handleMessage(m: Json): WorkerEvent[] {
    const events: WorkerEvent[] = [];
    const sid = str(m.session_id);
    if (sid && !this.sessionId) {
      this.sessionId = sid;
      events.push({ type: "started", at: this.at(), sessionId: sid });
    }
    switch (m.type) {
      case "assistant":
        events.push(...this.onAssistant(m));
        break;
      case "user":
        events.push(...this.onUser(m));
        break;
      case "tool_progress": {
        const name = str(m.tool_name) ?? "tool";
        const elapsed = num(m.elapsed_time_seconds);
        events.push({
          type: "activity",
          at: this.at(),
          kind: "tool_progress",
          summary: elapsed === undefined ? `${name} running` : `${name} running (${elapsed}s)`,
          toolRunning: true,
        });
        break;
      }
      case "rate_limit_event":
        this.onRateLimit(m);
        break;
      case "auth_status": {
        const error = str(m.error);
        if (error) this.heldError = { type: "auth_error", detail: error };
        break;
      }
      case "system":
        if (m.subtype === "api_retry") events.push(this.onApiRetry(m));
        break;
      case "result":
        this.onResult(m);
        break;
      default:
        break;
    }
    return events;
  }

  private onAssistant(m: Json): WorkerEvent[] {
    const message = isObject(m.message) ? m.message : {};
    const content = Array.isArray(message.content) ? message.content.filter(isObject) : [];
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => str(b.text) ?? "")
      .join("\n")
      .trim();
    const error = str(m.error);
    if (error) {
      this.heldError = classifyFailure({
        code: error,
        text,
        rejected: this.rejected,
        now: this.now(),
        defaultRetryable: true,
      });
      return [];
    }
    const events: WorkerEvent[] = [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const id = str(block.id);
      const name = str(block.name) ?? "tool";
      if (id) this.openTools.set(id, name);
      events.push({
        type: "activity",
        at: this.at(),
        kind: "tool_use",
        summary: summariseToolUse(name, block.input),
        toolRunning: true,
      });
    }
    if (text && m.parent_tool_use_id == null) {
      events.unshift({ type: "message", at: this.at(), text });
    }
    return events;
  }

  private onUser(m: Json): WorkerEvent[] {
    const message = isObject(m.message) ? m.message : {};
    const content = Array.isArray(message.content) ? message.content.filter(isObject) : [];
    const events: WorkerEvent[] = [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const name = (id && this.openTools.get(id)) || "tool";
      if (id) this.openTools.delete(id);
      events.push({
        type: "activity",
        at: this.at(),
        kind: "tool_result",
        summary: `${name} ${block.is_error === true ? "failed" : "finished"}`,
        toolRunning: this.openTools.size > 0,
      });
    }
    return events;
  }

  private onRateLimit(m: Json): void {
    const info = isObject(m.rate_limit_info) ? m.rate_limit_info : {};
    if (info.status === "rejected") {
      const rateLimitType = str(info.rateLimitType);
      const resetsAt = normaliseResetsAt(info.resetsAt);
      this.rejected = {
        ...(rateLimitType ? { rateLimitType } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      };
    } else if (info.status === "allowed" || info.status === "allowed_warning") {
      this.rejected = undefined;
    }
  }

  private onApiRetry(m: Json): WorkerEvent {
    const category = str(m.error) ?? "unknown";
    const status = num(m.error_status);
    const attempt = num(m.attempt);
    const max = num(m.max_retries);
    this.lastRetry = `${category}${status === undefined ? "" : ` (HTTP ${status})`}`;
    return {
      type: "activity",
      at: this.at(),
      kind: "api_retry",
      summary: `Claude API ${this.lastRetry}; retry ${attempt ?? "?"}/${max ?? "?"}`,
      toolRunning: this.openTools.size > 0,
    };
  }

  private onResult(m: Json): void {
    if (this.interrupted) {
      this.resultTerminal = interruptedFailure();
      return;
    }
    const subtype = str(m.subtype);
    if (m.is_error !== true && subtype === "success") {
      this.resultTerminal = {
        type: "completed",
        finalText: str(m.result) ?? "",
        usage: mapUsage(m),
      };
    } else if (this.heldError) {
      this.resultTerminal = this.heldError;
    } else {
      const errors = Array.isArray(m.errors) ? m.errors.filter((e) => typeof e === "string") : [];
      const text = [str(m.result), ...errors].filter(Boolean).join("\n") || subtype || "";
      this.resultTerminal = classifyFailure({
        text,
        httpStatus: num(m.api_error_status) ?? null,
        rejected: this.rejected,
        now: this.now(),
        defaultRetryable: subtype === "error_during_execution",
      });
    }
    // A later turn (started by background work) is judged on its own.
    this.heldError = undefined;
    this.rejected = undefined;
  }

  /** The terminal event once the process has exited. */
  finish(exit: ExitInfo): TerminalDraft {
    if (this.resultTerminal) return this.resultTerminal;
    if (this.interrupted) return interruptedFailure();
    if (this.heldError) return this.heldError;
    const how =
      exit.signal !== null ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`;
    const stderr = exit.stderr.trim();
    const fromStderr = stderr
      ? classifyFailure({
          text: stderr,
          rejected: this.rejected,
          now: this.now(),
          defaultRetryable: true,
        })
      : undefined;
    if (fromStderr && fromStderr.type !== "failed") return fromStderr;
    const retry = this.lastRetry ? ` after API errors: ${this.lastRetry}` : "";
    return {
      type: "failed",
      error: `Claude Code exited before finishing (${how})${retry}${stderr ? `: ${stderr}` : ""}`,
      retryable: true,
    };
  }
}

function interruptedFailure(): TerminalDraft {
  return { type: "failed", error: "Run interrupted by Preston", retryable: true };
}

function summariseToolUse(name: string, input: unknown): string {
  if (!isObject(input)) return name;
  const detail =
    str(input.command) ??
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.path) ??
    str(input.pattern) ??
    str(input.url) ??
    str(input.query) ??
    str(input.description);
  if (!detail) return name;
  const oneLine = detail.replace(/\s+/g, " ").trim();
  return `${name}: ${oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine}`;
}

/**
 * Token counts for this invocation. `inputTokens` includes cache reads and writes;
 * `cachedInputTokens` is the cache-read share. `total_cost_usd` covers the whole conversation on
 * resume (documented), so the per-invocation `model_usage_since_last_result` costs are preferred.
 */
function mapUsage(m: Json): TokenUsage | undefined {
  const usage = isObject(m.usage) ? m.usage : undefined;
  const result: TokenUsage = {};
  if (usage) {
    const input = num(usage.input_tokens) ?? 0;
    const cacheWrite = num(usage.cache_creation_input_tokens) ?? 0;
    const cacheRead = num(usage.cache_read_input_tokens) ?? 0;
    result.inputTokens = input + cacheWrite + cacheRead;
    result.cachedInputTokens = cacheRead;
    const output = num(usage.output_tokens);
    if (output !== undefined) result.outputTokens = output;
  }
  const sinceLast = isObject(m.model_usage_since_last_result)
    ? Object.values(m.model_usage_since_last_result).filter(isObject)
    : [];
  const costs = sinceLast.map((u) => num(u.costUSD)).filter((c) => c !== undefined);
  const cost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : num(m.total_cost_usd);
  if (cost !== undefined) result.costUsd = cost;
  return Object.keys(result).length > 0 ? result : undefined;
}
