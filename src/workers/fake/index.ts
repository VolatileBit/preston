import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Clock, isoNow, sleep } from "../../clock.js";
import { errorMessage } from "../../log.js";
import { COORDINATOR_RUN_ID } from "../../mcp/names.js";
import type { ToolClient } from "../../mcp/tools.js";
import { AsyncQueue } from "../../util/async-queue.js";
import { spawnTree } from "../../util/process-tree.js";
import type { AdapterFactory } from "../registry.js";
import type {
  AgentDetection,
  AgentKind,
  QuotaKind,
  QuotaReading,
  RunHandle,
  StartRunInput,
  WorkerAdapter,
  WorkerEvent,
} from "../types.js";

/**
 * A scriptable WorkerAdapter for tests. A scenario scripts what the "agent" does on each turn:
 * emit events, call Preston's MCP tools, stall, exit unexpectedly, hit quota or auth errors.
 * Session state is persisted under the home directory, so resume by native Session ID works
 * across daemon restarts. Never offered to users.
 */

export interface FakeScenario {
  coordinator?: FakeScript;
  worker?: FakeScript;
  /**
   * How scripts reach Preston's tools: `direct` calls the daemon in-process; `stdio` launches
   * the MCP server from the Run's launch spec, exactly as a real agent CLI would.
   */
  mcp?: "direct" | "stdio";
  /** What `detect()` reports (asked on every call). Defaults to installed and logged in. */
  detection?: AgentDetection | (() => AgentDetection);
  /** Which agent this fake stands in for (its adapter's `agent`). Defaults to "fake". */
  agent?: AgentKind;
  /** Enables a token-free `readQuota()` that returns these readings (asked on every call). */
  quota?: () => QuotaReading[] | Promise<QuotaReading[]>;
}

/** Returns the turn's final text. Throwing ends the turn as an unexpected failure. */
export type FakeScript = (turn: FakeTurn) => Promise<string | undefined> | string | undefined;

export interface FakeTurn {
  role: "coordinator" | "worker";
  input: StartRunInput;
  sessionId: string;
  resumed: boolean;
  /** 1-based turn number within this Session, counted across restarts. */
  turn: number;
  /** Free-form state persisted with the Session. */
  state: Record<string, unknown>;
  signal: AbortSignal;
  message(text: string): void;
  activity(kind: string, toolRunning?: boolean): void;
  callTool(name: string, args?: Record<string, unknown>): Promise<string>;
  listTools(): Promise<string[]>;
  /** Persists `state` now (it is also saved when the turn ends). */
  save(): void;
  sleep(ms: number): Promise<void>;
  /** Waits until interrupted (or the process dies). */
  stall(): Promise<never>;
  /**
   * Starts a real, idle child process as this turn's agent process (`RunHandle.processId`), in
   * its own process group like a real agent. Interrupting the turn does not stop it, as if the
   * daemon died before it could. With `grandchildPidFile` it also starts a tool of its own and
   * writes that process's ID to the file.
   */
  spawnChild(options?: { grandchildPidFile?: string }): number;
  exitUnexpectedly(code?: number): never;
  quotaBlocked(options?: { bucket?: string; kind?: QuotaKind; resetsAt?: string }): never;
  authError(detail?: string): never;
  fail(error: string, retryable?: boolean): never;
}

export interface FakeCall {
  role: FakeTurn["role"];
  input: StartRunInput;
  sessionId: string;
}

export interface FakeAdapter extends WorkerAdapter {
  /** Every turn started, in order. */
  readonly calls: FakeCall[];
  /** How many times `readQuota()` was called. */
  readonly quotaReads: number;
}

export class FakeToolError extends Error {}

const IDLE_AGENT = "setInterval(() => {}, 1000)";
/** An agent that has started a tool of its own and ignores polite requests to stop. */
const AGENT_WITH_TOOL = `
  const tool = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE_AGENT)}], { stdio: "ignore" });
  require("node:fs").writeFileSync(process.argv[1], String(tool.pid));
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  setInterval(() => {}, 1000);
`;

type Ending =
  | { type: "exit"; code: number }
  | { type: "quota"; bucket: string; kind: QuotaKind; resetsAt?: string | undefined }
  | { type: "auth"; detail: string }
  | { type: "fail"; error: string; retryable: boolean };

class TurnEnding extends Error {
  constructor(readonly ending: Ending) {
    super(ending.type);
  }
}

interface SessionFile {
  turns: number;
  workdir: string;
  state: Record<string, unknown>;
}

export interface FakeAdapterOptions {
  scenario: FakeScenario;
  home: string;
  clock: Clock;
  tools: ToolClient;
}

export function createFakeAdapter(options: FakeAdapterOptions): FakeAdapter {
  const sessionsDir = join(options.home, "fake-agent", "sessions");
  const calls: FakeCall[] = [];
  const { detection, quota } = options.scenario;
  let quotaReads = 0;
  return {
    agent: options.scenario.agent ?? "fake",
    calls,
    get quotaReads() {
      return quotaReads;
    },
    detect: async () =>
      (typeof detection === "function" ? detection() : detection) ?? {
        installed: true,
        version: "fake",
        loggedIn: true,
        path: "fake",
      },
    ...(quota
      ? {
          async readQuota() {
            quotaReads++;
            return quota();
          },
        }
      : {}),
    startRun(input) {
      const sessionId = input.resumeSessionId ?? randomUUID();
      const role = input.runId === COORDINATOR_RUN_ID ? "coordinator" : "worker";
      calls.push({ role, input, sessionId });
      return startTurn({ ...options, sessionsDir }, input, sessionId, role);
    },
  };
}

/** Adapter factory for a scenario, for `createRuntime({ adapters: { fake: ... } })`. */
export function fakeAdapterFactory(scenario: FakeScenario): {
  factory: AdapterFactory;
  adapter(): FakeAdapter;
} {
  let built: FakeAdapter | undefined;
  return {
    factory: (ctx) => {
      built = createFakeAdapter({ scenario, home: ctx.home, clock: ctx.clock, tools: ctx.tools });
      return built;
    },
    adapter: () => {
      if (!built) throw new Error("The fake adapter has not been built yet");
      return built;
    },
  };
}

function startTurn(
  options: FakeAdapterOptions & { sessionsDir: string },
  input: StartRunInput,
  sessionId: string,
  role: FakeTurn["role"],
): RunHandle {
  const queue = new AsyncQueue<WorkerEvent>();
  const abort = new AbortController();
  const at = () => isoNow(options.clock);
  const sessionPath = join(options.sessionsDir, `${sessionId}.json`);
  let mcp: Client | undefined;
  let childPid: number | undefined;

  const run = async () => {
    let session: SessionFile;
    if (input.resumeSessionId) {
      if (!existsSync(sessionPath)) {
        queue.push({
          type: "failed",
          at: at(),
          error: `No session ${sessionId}`,
          retryable: false,
        });
        queue.push({ type: "exited", at: at(), code: 1 });
        return;
      }
      session = JSON.parse(readFileSync(sessionPath, "utf8")) as SessionFile;
    } else {
      session = { turns: 0, workdir: input.workdir, state: {} };
    }
    session.turns += 1;
    const save = () => {
      mkdirSync(options.sessionsDir, { recursive: true });
      writeFileSync(`${sessionPath}.tmp`, JSON.stringify(session));
      renameSync(`${sessionPath}.tmp`, sessionPath);
    };
    save();
    queue.push({ type: "started", at: at(), sessionId });

    const token = tokenFrom(input);
    const toolsVia = options.scenario.mcp ?? "direct";
    const connect = async (): Promise<Client> => {
      if (mcp) return mcp;
      if (!input.mcp) throw new FakeToolError("No MCP server was provided for this turn");
      const client = new Client({ name: "preston-fake-agent", version: "0" });
      await client.connect(
        new StdioClientTransport({
          command: input.mcp.command,
          args: input.mcp.args,
          env: { ...(process.env as Record<string, string>), ...input.mcp.env },
          stderr: "pipe",
        }),
      );
      mcp = client;
      return client;
    };

    const end = (ending: Ending): never => {
      throw new TurnEnding(ending);
    };
    const turn: FakeTurn = {
      role,
      input,
      sessionId,
      resumed: Boolean(input.resumeSessionId),
      turn: session.turns,
      state: session.state,
      signal: abort.signal,
      message: (text) => queue.push({ type: "message", at: at(), text }),
      activity: (kind, toolRunning = false) =>
        queue.push({ type: "activity", at: at(), kind, toolRunning }),
      async callTool(name, args = {}) {
        queue.push({ type: "activity", at: at(), kind: `tool:${name}`, toolRunning: true });
        if (toolsVia === "stdio") {
          const result = (await (await connect()).callTool({ name, arguments: args })) as {
            content: { type: string; text?: string }[];
            isError?: boolean;
          };
          const text = result.content.map((c) => c.text ?? "").join("");
          if (result.isError) throw new FakeToolError(text);
          return text;
        }
        if (!token) throw new FakeToolError("No Preston token was provided for this turn");
        const result = await options.tools.call(token, name, args);
        if (result.isError) throw new FakeToolError(result.text);
        return result.text;
      },
      async listTools() {
        if (toolsVia === "stdio")
          return (await (await connect()).listTools()).tools.map((t) => t.name);
        if (!token) throw new FakeToolError("No Preston token was provided for this turn");
        return options.tools.describe(token).tools.map((t) => t.name);
      },
      save,
      sleep: (ms) => sleep(options.clock, ms, abort.signal),
      stall: () =>
        new Promise<never>((_, reject) =>
          abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true }),
        ),
      spawnChild({ grandchildPidFile } = {}) {
        const child = spawnTree(
          process.execPath,
          grandchildPidFile ? ["-e", AGENT_WITH_TOOL, grandchildPidFile] : ["-e", IDLE_AGENT],
          { stdio: "ignore", windowsHide: true },
        );
        child.unref();
        childPid = child.pid;
        queue.push({ type: "activity", at: at(), kind: "spawned", toolRunning: false });
        return child.pid as number;
      },
      exitUnexpectedly: (code = 1) => end({ type: "exit", code }),
      quotaBlocked: (o = {}) =>
        end({
          type: "quota",
          bucket: o.bucket ?? "fake:default",
          kind: o.kind ?? "usage_limit",
          resetsAt: o.resetsAt,
        }),
      authError: (detail = "Not logged in") => end({ type: "auth", detail }),
      fail: (error, retryable = true) => end({ type: "fail", error, retryable }),
    };

    const script =
      (role === "coordinator" ? options.scenario.coordinator : options.scenario.worker) ??
      (() => "");
    try {
      const finalText = (await script(turn)) ?? "";
      save();
      queue.push({ type: "completed", at: at(), finalText });
      queue.push({ type: "exited", at: at(), code: 0 });
    } catch (err) {
      save();
      if (abort.signal.aborted) {
        queue.push({ type: "failed", at: at(), error: "interrupted", retryable: true });
        queue.push({ type: "exited", at: at(), code: null, signal: "SIGINT" });
      } else if (err instanceof TurnEnding) {
        pushEnding(queue, err.ending, at());
      } else {
        queue.push({ type: "failed", at: at(), error: errorMessage(err), retryable: true });
        queue.push({ type: "exited", at: at(), code: 1 });
      }
    }
  };

  void run()
    .catch((err) => {
      queue.push({ type: "failed", at: at(), error: errorMessage(err), retryable: true });
    })
    .finally(async () => {
      await mcp?.close().catch(() => {});
      queue.end();
    });

  return {
    events: queue,
    sessionId: async () => sessionId,
    processId: () => childPid,
    async interrupt() {
      abort.abort(new Error("interrupted"));
    },
  };
}

function pushEnding(queue: AsyncQueue<WorkerEvent>, ending: Ending, at: string): void {
  switch (ending.type) {
    case "exit":
      queue.push({ type: "exited", at, code: ending.code });
      return;
    case "quota":
      queue.push({
        type: "quota_blocked",
        at,
        bucket: ending.bucket,
        kind: ending.kind,
        resetsAt: ending.resetsAt,
      });
      break;
    case "auth":
      queue.push({ type: "auth_error", at, detail: ending.detail });
      break;
    case "fail":
      queue.push({ type: "failed", at, error: ending.error, retryable: ending.retryable });
      break;
  }
  queue.push({ type: "exited", at, code: 1 });
}

function tokenFrom(input: StartRunInput): string | undefined {
  const args = input.mcp?.args ?? [];
  const index = args.indexOf("--token");
  return index >= 0 ? args[index + 1] : undefined;
}
