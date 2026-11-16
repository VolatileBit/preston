import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import type {
  ApprovalDecision,
  RunHandle,
  StartRunInput,
  TokenUsage,
  WorkerEvent,
} from "../types.js";
import { classifyTurnError, normaliseApproval } from "./mapping.js";
import {
  type CodexChild,
  type CodexSpawn,
  type ResolvedExecutable,
  shutdownChild,
} from "./process.js";
import type {
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  ThreadItem,
  TokenUsageBreakdown,
  Turn,
  TurnError,
} from "./protocol.js";
import {
  AppServerConnection,
  ConnectionClosedError,
  type IncomingNotification,
  type IncomingRequest,
  RpcError,
} from "./rpc.js";

export interface RunDeps {
  spawn: CodexSpawn;
  exe: ResolvedExecutable;
  env: NodeJS.ProcessEnv;
  now(): Date;
  /** How long to wait at each shutdown step (stdin closed, then SIGTERM, then SIGKILL). */
  shutdownGraceMs: number;
  /** How long `interrupt()` waits for the App Server to acknowledge and finish the turn. */
  interruptTimeoutMs: number;
}

/** Item types that represent a tool or command doing work, during which silence is expected. */
const TOOL_ITEMS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "collabAgentToolCall",
  "imageGeneration",
  "sleep",
]);

type Exit = { code: number | null; signal: NodeJS.Signals | null };

class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function delay(ms: number): { promise: Promise<void>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function describeItem(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return item.command;
    case "fileChange":
      return item.changes?.length
        ? `Editing ${item.changes.map((c) => c.path).join(", ")}`
        : undefined;
    case "mcpToolCall":
      return item.server && item.tool ? `${item.server}.${item.tool}` : item.tool;
    case "dynamicToolCall":
      return item.tool;
    case "webSearch":
      return item.query;
    default:
      return undefined;
  }
}

function stderrTail(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `: ${trimmed.slice(-500)}` : "";
}

class CodexRun implements RunHandle {
  readonly events = new EventQueue<WorkerEvent>();
  private child: CodexChild | undefined;
  private conn: AppServerConnection | undefined;
  private transcript: WriteStream | undefined;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private terminal = false;
  private interruptRequested = false;
  private finishing = false;
  private spawnError: Error | undefined;
  private stderr = "";
  private lastError: TurnError | undefined;
  private lastAgentText: string | undefined;
  private usage:
    | Required<Pick<TokenUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">>
    | undefined;
  private readonly runningTools = new Set<string>();
  private readonly fileChangePaths = new Map<string, string[]>();
  private readonly snapshots = new Map<string, RateLimitSnapshot>();
  private readonly early: IncomingNotification[] = [];
  private readonly session: Promise<string>;
  private resolveSession!: (id: string) => void;
  private rejectSession!: (error: Error) => void;
  private readonly terminalReached: Promise<void>;
  private markTerminal!: () => void;
  private readonly done: Promise<void>;
  private markDone!: () => void;
  private exited: Promise<Exit> | undefined;

  constructor(
    private readonly input: StartRunInput,
    private readonly deps: RunDeps,
  ) {
    this.session = new Promise<string>((resolve, reject) => {
      this.resolveSession = resolve;
      this.rejectSession = reject;
    });
    this.session.catch(() => {});
    this.terminalReached = new Promise((resolve) => {
      this.markTerminal = resolve;
    });
    this.done = new Promise((resolve) => {
      this.markDone = resolve;
    });
    this.openTranscript();
    void this.main();
  }

  sessionId(): Promise<string> {
    return this.session;
  }

  async interrupt(): Promise<void> {
    if (!this.terminal) {
      this.interruptRequested = true;
      const conn = this.conn;
      if (conn && this.threadId && this.turnId) {
        const wait = delay(this.deps.interruptTimeoutMs);
        await Promise.race([
          conn
            .request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId })
            .then(() => this.terminalReached)
            .catch(() => {}),
          wait.promise,
        ]);
        wait.cancel();
      }
      this.emitTerminal({
        type: "failed",
        at: this.at(),
        error: "Interrupted by Preston",
        retryable: false,
      });
    }
    await this.done;
  }

  private at(): string {
    return this.deps.now().toISOString();
  }

  private openTranscript(): void {
    const file = this.input.transcriptPath;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      this.transcript = createWriteStream(file, { flags: "a" });
      this.transcript.on("error", () => {
        this.transcript = undefined;
      });
    } catch {
      this.transcript = undefined;
    }
  }

  private record(dir: "in" | "out" | "stderr", line: string): void {
    if (!this.transcript) return;
    let msg: unknown = line;
    if (dir !== "stderr") {
      try {
        msg = JSON.parse(line);
      } catch {}
    }
    this.transcript.write(`${JSON.stringify({ at: this.at(), dir, msg })}\n`);
  }

  private async main(): Promise<void> {
    const { exe, env } = this.deps;
    let child: CodexChild;
    try {
      child = this.deps.spawn(exe.command, ["app-server"], {
        cwd: this.input.workdir,
        env,
        shell: exe.shell,
      });
    } catch (error) {
      this.spawnError = error as Error;
      this.onExit({ code: null, signal: null });
      return;
    }
    this.child = child;
    this.exited = new Promise<Exit>((resolve) => {
      child.on("exit", (code, signal) => {
        // 'exit' can precede the last stdout data (say, a final turn/completed); drain it first.
        const settle = () => resolve({ code, signal });
        if (child.stdout.readableEnded) return settle();
        child.stdout.once("end", settle);
        setTimeout(settle, 200).unref();
      });
      child.on("error", (error) => {
        this.spawnError = error;
        resolve({ code: null, signal: null });
      });
    });
    void this.exited.then((exit) => this.onExit(exit));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
      this.record("stderr", chunk);
    });

    const conn = new AppServerConnection(child, {
      onNotification: (n) => this.onNotification(n),
      onRequest: (r) => void this.onRequest(r),
      onTraffic: (dir, line) => this.record(dir, line),
    });
    this.conn = conn;

    try {
      await conn.initialize();
      const params = await this.threadParams(conn);
      const resumeId = this.input.resumeSessionId;
      const response = resumeId
        ? await conn.request<{ thread: { id: string } }>("thread/resume", {
            threadId: resumeId,
            ...params,
            excludeTurns: true,
          })
        : await conn.request<{ thread: { id: string } }>("thread/start", params);
      const threadId = response.thread.id;
      this.threadId = threadId;
      this.events.push({ type: "started", at: this.at(), sessionId: threadId });
      this.resolveSession(threadId);
      if (this.interruptRequested || this.terminal) return;

      const turn = await conn.request<{ turn: Turn }>("turn/start", {
        threadId,
        input: [{ type: "text", text: this.input.prompt, text_elements: [] }],
        ...(this.input.effort ? { effort: this.input.effort } : {}),
      });
      this.setTurn(turn.turn.id);
    } catch (error) {
      if (this.terminal || error instanceof ConnectionClosedError) return; // onExit reports it.
      const message = error instanceof Error ? error.message : String(error);
      // Protocol-level rejections (unknown thread, invalid model) won't fix themselves on retry.
      this.emitTerminal({
        type: "failed",
        at: this.at(),
        error: resumeFailure(this.input.resumeSessionId, error) ?? message,
        retryable: !(error instanceof RpcError),
      });
    }
  }

  /** Thread settings shared by start and resume; anything unset inherits ~/.codex/config.toml. */
  private async threadParams(conn: AppServerConnection): Promise<Record<string, unknown>> {
    const { model, mcp, workdir } = this.input;
    const params: Record<string, unknown> = {
      cwd: workdir,
      // ADR 0003: keep Codex's sandbox and have its approval requests come to Preston.
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    };
    if (model) params.model = model;
    const developerInstructions = await this.developerInstructions(conn);
    if (developerInstructions) params.developerInstructions = developerInstructions;
    if (mcp) {
      // A dotted key adds one server; a nested `mcp_servers` table would replace the user's.
      params.config = {
        "mcp_servers.preston": {
          command: mcp.command,
          args: mcp.args,
          ...(mcp.env ? { env: mcp.env } : {}),
        },
      };
    }
    return params;
  }

  /** Appends Preston's guidance to the user's own `developer_instructions` instead of replacing it. */
  private async developerInstructions(conn: AppServerConnection): Promise<string | undefined> {
    const guidance = this.input.appendSystemPrompt?.trim();
    if (!guidance) return undefined;
    let own: string | undefined;
    try {
      const read = await conn.request<{ config?: { developer_instructions?: string | null } }>(
        "config/read",
        { cwd: this.input.workdir },
      );
      own = read.config?.developer_instructions?.trim() || undefined;
    } catch (error) {
      if (error instanceof ConnectionClosedError) throw error;
    }
    return own ? `${own}\n\n${guidance}` : guidance;
  }

  private setTurn(turnId: string): void {
    if (this.turnId) return;
    this.turnId = turnId;
    for (const n of this.early.splice(0)) this.onNotification(n);
  }

  private onNotification({ method, params }: IncomingNotification): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "account/rateLimits/updated") {
      const snapshot = p.rateLimits as RateLimitSnapshot | undefined;
      if (snapshot) this.snapshots.set(snapshot.limitId ?? "codex", snapshot);
      return;
    }
    if (this.terminal || !this.threadId || p.threadId !== this.threadId) return;
    const turnOf = (p.turnId as string | undefined) ?? (p.turn as Turn | undefined)?.id;
    if (turnOf !== undefined) {
      if (method === "turn/started" && !this.turnId) this.setTurn(turnOf);
      if (!this.turnId) {
        // Arrived before turn/start answered; it may also belong to an earlier turn (resume).
        this.early.push({ method, params });
        return;
      }
      if (turnOf !== this.turnId) return;
    }
    this.onTurnNotification(method, p);
  }

  private onTurnNotification(method: string, p: Record<string, unknown>): void {
    const toolRunning = () => this.runningTools.size > 0;
    switch (method) {
      case "turn/started":
        this.events.push({
          type: "activity",
          at: this.at(),
          kind: "turn_started",
          toolRunning: false,
        });
        return;
      case "item/started": {
        const item = p.item as ThreadItem | undefined;
        if (!item || item.type === "userMessage") return;
        if (TOOL_ITEMS.has(item.type)) this.runningTools.add(item.id);
        if (item.type === "fileChange" && item.changes) {
          this.fileChangePaths.set(
            item.id,
            item.changes.map((c) => c.path),
          );
        }
        const summary = describeItem(item);
        this.events.push({
          type: "activity",
          at: this.at(),
          kind: item.type,
          ...(summary ? { summary } : {}),
          toolRunning: toolRunning(),
        });
        return;
      }
      case "item/completed": {
        const item = p.item as ThreadItem | undefined;
        if (!item || item.type === "userMessage") return;
        this.runningTools.delete(item.id);
        if (item.type === "agentMessage") {
          if (item.text) {
            this.lastAgentText = item.text;
            this.events.push({ type: "message", at: this.at(), text: item.text });
          }
          return;
        }
        const summary = describeItem(item);
        this.events.push({
          type: "activity",
          at: this.at(),
          kind: `${item.type}_completed`,
          ...(summary ? { summary } : {}),
          toolRunning: toolRunning(),
        });
        return;
      }
      case "thread/tokenUsage/updated": {
        // `last` is one model request; a turn may make several, so sum them for the turn.
        const last = (p.tokenUsage as { last?: TokenUsageBreakdown } | undefined)?.last;
        if (!last) return;
        const usage = this.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        usage.inputTokens += last.inputTokens ?? 0;
        usage.outputTokens += last.outputTokens ?? 0;
        usage.cachedInputTokens += last.cachedInputTokens ?? 0;
        this.usage = usage;
        return;
      }
      case "error": {
        const error = p.error as TurnError | undefined;
        if (p.willRetry) {
          this.events.push({
            type: "activity",
            at: this.at(),
            kind: "retrying",
            ...(error?.message ? { summary: error.message } : {}),
            toolRunning: toolRunning(),
          });
        } else if (error) {
          this.lastError = error;
        }
        return;
      }
      case "turn/completed":
        void this.finishTurn(p.turn as Turn);
        return;
      default:
        return; // Unknown or uninteresting notifications are ignored.
    }
  }

  private async finishTurn(turn: Turn): Promise<void> {
    if (this.finishing || this.terminal) return;
    this.finishing = true;
    if (turn.status === "completed") {
      const fromTurn = [...(turn.items ?? [])]
        .reverse()
        .find((i) => i.type === "agentMessage")?.text;
      this.emitTerminal({
        type: "completed",
        at: this.at(),
        finalText: fromTurn ?? this.lastAgentText ?? "",
        ...(this.usage ? { usage: { ...this.usage } } : {}),
      });
      return;
    }
    if (turn.status === "interrupted") {
      this.emitTerminal({
        type: "failed",
        at: this.at(),
        error: this.interruptRequested ? "Interrupted by Preston" : "Codex interrupted the turn",
        retryable: !this.interruptRequested,
      });
      return;
    }
    const error = turn.error ?? this.lastError;
    if (error?.codexErrorInfo === "usageLimitExceeded") await this.refreshRateLimits();
    const failure = classifyTurnError(error, this.snapshots.values());
    this.emitTerminal({ ...failure, at: this.at() });
  }

  /** Token-free read so a usage-limit pause carries the real reset time, when not already known. */
  private async refreshRateLimits(): Promise<void> {
    const known = [...this.snapshots.values()].some((s) =>
      [s.primary, s.secondary].some((w) => w && w.usedPercent >= 100),
    );
    if (known || !this.conn) return;
    try {
      const read = await this.conn.request<GetAccountRateLimitsResponse>(
        "account/rateLimits/read",
        null,
        this.deps.interruptTimeoutMs,
      );
      const byId = Object.values(read.rateLimitsByLimitId ?? {}).filter(
        (s): s is RateLimitSnapshot => !!s,
      );
      // The multi-bucket view supersedes the single-bucket `rateLimits` mirror.
      for (const s of byId.length ? byId : read.rateLimits ? [read.rateLimits] : []) {
        this.snapshots.set(s.limitId ?? "codex", s);
      }
    } catch {
      // The pause still happens, just without a reset time.
    }
  }

  private async onRequest(request: IncomingRequest): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const approval = normaliseApproval(request.method, request.params, this.fileChangePaths);
    if (!approval) {
      if (request.method === "mcpServer/elicitation/request") {
        conn.respond(request.id, { action: "decline", content: null, _meta: null });
      } else {
        conn.respondError(request.id, -32601, `Preston does not handle ${request.method}`);
      }
      return;
    }
    let decision: ApprovalDecision;
    if (!this.input.onApproval) {
      decision = { allow: false, reason: "Preston has no approval handler for this Run" };
    } else {
      try {
        decision = await this.input.onApproval(approval.request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        decision = { allow: false, reason: `Preston could not check this request: ${message}` };
      }
    }
    conn.respond(request.id, approval.result(decision));
    if (
      !decision.allow &&
      !approval.carriesReason &&
      this.threadId &&
      this.turnId &&
      !this.terminal
    ) {
      // v2 declines carry no reason, so tell the agent why within the same turn.
      conn
        .request("turn/steer", {
          threadId: this.threadId,
          expectedTurnId: this.turnId,
          input: [
            {
              type: "text",
              text: `Preston declined your request (${approval.request.summary}): ${decision.reason}`,
              text_elements: [],
            },
          ],
        })
        .catch(() => {});
    }
  }

  private emitTerminal(event: WorkerEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.events.push(event);
    this.markTerminal();
    this.rejectSession(new Error("Run ended before a Codex thread was started"));
    if (this.child && this.exited) {
      void shutdownChild(this.child, this.exited, this.deps.shutdownGraceMs);
    }
  }

  private onExit(exit: Exit): void {
    this.conn?.close();
    if (!this.terminal) {
      const notFound = (this.spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      const error = this.spawnError
        ? notFound
          ? `Could not start Codex: "${this.deps.exe.command}" was not found`
          : `Could not start Codex: ${this.spawnError.message}`
        : `codex app-server exited unexpectedly (code ${exit.code ?? "none"}${
            exit.signal ? `, signal ${exit.signal}` : ""
          })${stderrTail(this.stderr)}`;
      this.emitTerminal({ type: "failed", at: this.at(), error, retryable: !notFound });
    }
    this.events.push({ type: "exited", at: this.at(), code: exit.code, signal: exit.signal });
    // Consumers may read the transcript as soon as the events end, so flush it first. `close`
    // fires after `finish` and also after a write error, so this cannot hang.
    const transcript = this.transcript;
    this.transcript = undefined;
    const finish = () => {
      this.events.end();
      this.markDone();
    };
    if (transcript) {
      transcript.once("close", finish);
      transcript.end();
    } else {
      finish();
    }
  }
}

function resumeFailure(resumeId: string | undefined, error: unknown): string | undefined {
  if (!resumeId || !(error instanceof RpcError) || error.method !== "thread/resume")
    return undefined;
  return `Could not resume Codex Session ${resumeId}: ${error.message}`;
}

export function startCodexRun(input: StartRunInput, deps: RunDeps): RunHandle {
  return new CodexRun(input, deps);
}
