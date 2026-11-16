/**
 * Worker adapter for the user's installed, unmodified Claude Code CLI (ADR 0002).
 *
 * Each Run is one headless invocation:
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *          (--session-id <new uuid> | --resume <id>) [--model m] [--effort e]
 *          [--append-system-prompt-file <tmp>]
 *          (--mcp-config <tmp> --permission-prompt-tool mcp__preston__approve | --permission-prompts none)
 * run in the Run's workdir (Sessions are stored per working directory, so a resume must use the
 * same one). The prompt goes in as one stream-json user message on stdin; stdin is closed after
 * the first `result` so the CLI exits once any background work is done. Preston never reads or
 * passes on the user's credentials: the CLI uses its own login.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
  AgentDetection,
  QuotaReading,
  RunHandle,
  StartRunInput,
  UpdateResult,
  WorkerAdapter,
  WorkerEvent,
} from "../types.js";
import type { TerminalDraft } from "./classify.js";
import {
  launchCommand,
  resolveExecutable,
  runCommand,
  type SpawnedProcess,
  type SpawnFn,
  tail,
} from "./process.js";
import { readingsFromUsageMessage } from "./quota.js";
import { ClaudeStreamMapper } from "./stream.js";

export type { SpawnedProcess, SpawnFn, SpawnOptionsLite } from "./process.js";

/** Name of Preston's MCP server in the config handed to Claude Code. */
export const PRESTON_MCP_SERVER_NAME = "preston";
/**
 * Tool Preston's MCP server must expose for Claude Code's permission prompts (ADR 0003).
 * Claude Code calls it with `{ tool_name, input, tool_use_id }` and expects one text content block
 * whose text is `{"behavior":"allow"}` (optionally with `updatedInput`) or
 * `{"behavior":"deny","message":"<reason>"}`, and no `structuredContent`.
 */
export const PRESTON_PERMISSION_TOOL = "approve";
const PERMISSION_TOOL_FULL_NAME = `mcp__${PRESTON_MCP_SERVER_NAME}__${PRESTON_PERMISSION_TOOL}`;

export interface ClaudeAdapterOptions {
  /** Path or command name of the `claude` executable; found on PATH when omitted. */
  executable?: string;
  /** Environment for the CLI; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Process launcher; defaults to `child_process.spawn`. Injected by tests. */
  spawn?: SpawnFn;
  /** Clock for event timestamps and reset-time parsing. */
  now?: () => Date;
  /** Platform whose launch rules apply; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** How long `interrupt()` waits for a graceful stop before killing. Default 5000 ms. */
  interruptGraceMs?: number;
}

const BASE_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
];

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): WorkerAdapter {
  const env = opts.env ?? process.env;
  const spawn: SpawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const now = opts.now ?? (() => new Date());
  const platform = opts.platform ?? process.platform;
  const graceMs = opts.interruptGraceMs ?? 5000;
  const executable = () => resolveExecutable(opts.executable, env, platform);
  const run = (exe: string, args: string[], timeoutMs: number) =>
    runCommand(spawn, exe, args, { env, platform, timeoutMs });

  async function version(exe: string): Promise<{ version?: string; problem?: string }> {
    const result = await run(exe, ["--version"], 15_000);
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(result.stdout);
    if (result.code === 0 && match?.[1]) return { version: match[1] };
    const why = result.error?.message ?? tail(result.stderr || result.stdout, 200);
    return { problem: `Claude Code is installed but did not start (${why || "no output"}).` };
  }

  return {
    agent: "claude",

    async detect(): Promise<AgentDetection> {
      const exe = executable();
      if (!exe) {
        return {
          installed: false,
          problem:
            "Claude Code isn't installed (no `claude` command found). Install it from https://code.claude.com, then sign in by running `claude`.",
        };
      }
      const v = await version(exe);
      if (v.problem) return { installed: true, path: exe, loggedIn: "unknown", problem: v.problem };
      // `claude auth status --json` is local and non-generative; exit 0 means logged in, 1 means
      // not. Only the `loggedIn` flag is read; account details in the output are discarded.
      const status = await run(exe, ["auth", "status", "--json"], 15_000);
      let loggedIn: boolean | "unknown" = "unknown";
      try {
        const parsed = JSON.parse(status.stdout) as { loggedIn?: unknown };
        if (typeof parsed.loggedIn === "boolean") loggedIn = parsed.loggedIn;
      } catch {
        // Older CLIs without `auth status`: login state cannot be checked cheaply.
      }
      return {
        installed: true,
        path: exe,
        ...(v.version ? { version: v.version } : {}),
        loggedIn,
        ...(loggedIn === false
          ? {
              problem:
                "Claude Code is installed but not signed in. Run `claude` in a terminal and sign in, then try again.",
            }
          : {}),
      };
    },

    startRun(input: StartRunInput): RunHandle {
      return startClaudeRun(input, { spawn, env, now, platform, graceMs, exe: executable() });
    },

    async readQuota(): Promise<QuotaReading[]> {
      const exe = executable();
      if (!exe) throw new Error("Claude Code isn't installed");
      return readUsage(exe, { spawn, env, now, platform });
    },

    async update(): Promise<UpdateResult> {
      const exe = executable();
      if (!exe) return { updated: false, detail: "Claude Code isn't installed." };
      const before = await version(exe);
      const result = await run(exe, ["update"], 10 * 60_000);
      const output = tail(`${result.stdout}\n${result.stderr}`, 400);
      const after = await version(exe);
      const fromTo = {
        ...(before.version ? { fromVersion: before.version } : {}),
        ...(after.version ? { toVersion: after.version } : {}),
      };
      if (after.problem) {
        return { updated: false, ...fromTo, detail: `${after.problem} Updater output: ${output}` };
      }
      if (result.code !== 0) {
        const why = result.error?.message ?? `exit code ${result.code}`;
        return { updated: false, ...fromTo, detail: `claude update failed (${why}): ${output}` };
      }
      const updated = Boolean(before.version && after.version && before.version !== after.version);
      return {
        updated,
        ...fromTo,
        detail: updated
          ? `Updated Claude Code from ${before.version} to ${after.version}.`
          : output || "Claude Code is already up to date.",
      };
    },
  };
}

interface RunContext {
  spawn: SpawnFn;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  platform: NodeJS.Platform;
  graceMs: number;
  exe: string | undefined;
}

function startClaudeRun(input: StartRunInput, ctx: RunContext): RunHandle {
  const queue = new EventQueue<WorkerEvent>();
  const at = () => ctx.now().toISOString();
  const mapper = new ClaudeStreamMapper(ctx.now);

  let resolveSession!: (id: string) => void;
  let rejectSession!: (error: Error) => void;
  const session = new Promise<string>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  session.catch(() => {});

  let child: SpawnedProcess | undefined;
  let tempDir: string | undefined;
  let finished = false;
  let interruptRequested = false;
  let closedResolve!: () => void;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  let stderr = "";

  const transcript = input.transcriptPath ? openTranscript(input.transcriptPath) : undefined;

  const finish = async (terminal: TerminalDraft, code: number | null, signal: string | null) => {
    if (finished) return;
    finished = true;
    if (transcript) await new Promise<void>((resolve) => transcript.end(() => resolve()));
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    const id = mapper.knownSessionId;
    if (id) resolveSession(id);
    else rejectSession(new Error("Claude Code exited before reporting a Session ID"));
    queue.push({ ...terminal, at: at() } as WorkerEvent);
    queue.push({ type: "exited", at: at(), code, signal });
    queue.end();
    closedResolve();
  };

  const fail = (error: string) => {
    void finish({ type: "failed", error, retryable: false }, null, null);
  };

  const handle: RunHandle = {
    events: queue,
    sessionId: () => session,
    processId: () => child?.pid,
    interrupt: async () => {
      if (finished || !child || interruptRequested) return closed;
      interruptRequested = true;
      mapper.markInterrupted();
      const proc = child;
      // Graceful first: the stream-json interrupt request, then end of input, then SIGINT
      // (which ends the turn cleanly). On Windows signals terminate abruptly, so skip SIGINT.
      try {
        const request = {
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "interrupt" },
        };
        proc.stdin?.write(`${JSON.stringify(request)}\n`);
        proc.stdin?.end();
      } catch {
        // stdin may already be closed.
      }
      if (ctx.platform !== "win32") proc.kill("SIGINT");
      const timer = setTimeout(() => forceKill(proc, ctx), ctx.graceMs);
      await closed;
      clearTimeout(timer);
    },
  };

  if (!ctx.exe) {
    fail("Claude Code isn't installed (no `claude` command found).");
    return handle;
  }

  const sessionId = input.resumeSessionId ?? randomUUID();
  const args = [...BASE_ARGS];
  args.push(...(input.resumeSessionId ? ["--resume", sessionId] : ["--session-id", sessionId]));
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  try {
    // Text and MCP launch details go through private temp files: system prompts may span lines,
    // which a Windows .cmd shim cannot carry, and the MCP token stays out of the process list.
    if (input.appendSystemPrompt || input.mcp) {
      tempDir = mkdtempSync(join(tmpdir(), "preston-claude-"));
    }
    if (input.appendSystemPrompt && tempDir) {
      const file = join(tempDir, "append-system-prompt.txt");
      writeFileSync(file, input.appendSystemPrompt, { mode: 0o600 });
      args.push("--append-system-prompt-file", file);
    }
    if (input.mcp && tempDir) {
      const file = join(tempDir, "mcp.json");
      const server = {
        type: "stdio",
        command: input.mcp.command,
        args: input.mcp.args,
        ...(input.mcp.env ? { env: input.mcp.env } : {}),
      };
      writeFileSync(file, JSON.stringify({ mcpServers: { [PRESTON_MCP_SERVER_NAME]: server } }), {
        mode: 0o600,
      });
      // No --strict-mcp-config: the user's own MCP servers still load.
      args.push("--mcp-config", file, "--permission-prompt-tool", PERMISSION_TOOL_FULL_NAME);
    } else {
      // Nobody can answer permission prompts, so deny them instead of waiting.
      args.push("--permission-prompts", "none");
    }
    const launch = launchCommand(ctx.exe, args, ctx.env, ctx.platform);
    child = ctx.spawn(launch.command, launch.args, {
      cwd: input.workdir,
      env: ctx.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
  } catch (error) {
    fail(`Could not start Claude Code: ${(error as Error).message}`);
    return handle;
  }

  const proc = child;
  proc.stdin?.on("error", () => {});
  const flushLines = onLines(proc.stdout, (line, raw) => {
    transcript?.write(raw);
    for (const event of mapper.handleLine(line)) {
      if (event.type === "started") resolveSession(event.sessionId);
      queue.push(event);
    }
    if (mapper.sawResult && proc.stdin && !proc.stdin.writableEnded) proc.stdin.end();
  });
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (d: string) => {
    stderr = (stderr + d).slice(-4000);
  });
  proc.on("error", (error) => {
    if (proc.pid === undefined) fail(`Could not start Claude Code: ${error.message}`);
  });
  proc.on("close", (code, signal) => {
    flushLines();
    void finish(mapper.finish({ code, signal, stderr: tail(stderr) }), code, signal);
  });

  const userMessage = { type: "user", message: { role: "user", content: input.prompt } };
  proc.stdin?.write(`${JSON.stringify(userMessage)}\n`);
  return handle;
}

function openTranscript(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
  stream.on("error", () => {});
  return stream;
}

function forceKill(proc: SpawnedProcess, ctx: RunContext): void {
  if (ctx.platform === "win32" && proc.pid !== undefined) {
    // Kill the whole tree: with a .cmd shim the direct child is cmd.exe.
    try {
      const killer = ctx.spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      killer.on("error", () => proc.kill());
    } catch {
      proc.kill();
    }
    return;
  }
  proc.kill("SIGKILL");
}

/**
 * Calls `onLine` for each complete stdout line (LF or CRLF), decoding UTF-8 safely across chunk
 * boundaries. `raw` is the line exactly as received, for the transcript. Returns a flush function
 * for a final unterminated line.
 */
function onLines(stream: Readable | null, onLine: (line: string, raw: string) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const drain = () => {
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const raw = buffer.slice(0, index + 1);
      buffer = buffer.slice(index + 1);
      onLine(raw.replace(/\r?\n$/, ""), raw);
      index = buffer.indexOf("\n");
    }
  };
  stream?.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    drain();
  });
  return () => {
    buffer += decoder.end();
    drain();
    if (buffer) {
      const raw = buffer;
      buffer = "";
      onLine(raw.replace(/\r$/, ""), raw);
    }
  };
}

async function readUsage(
  exe: string,
  ctx: Omit<RunContext, "graceMs" | "exe">,
): Promise<QuotaReading[]> {
  const args = [...BASE_ARGS, "--no-session-persistence"];
  const launch = launchCommand(exe, args, ctx.env, ctx.platform);
  const proc = ctx.spawn(launch.command, launch.args, {
    cwd: tmpdir(),
    env: ctx.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  return new Promise<QuotaReading[]>((resolve, reject) => {
    let readings: QuotaReading[] | undefined;
    let authProblem: string | undefined;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (readings) resolve(readings);
      else if (authProblem) reject(new Error(`Claude Code is not signed in: ${authProblem}`));
      else reject(error ?? new Error("Claude Code returned no usage report"));
    };
    const timer = setTimeout(() => {
      proc.kill();
      settle(new Error("Timed out reading Claude Code usage"));
    }, 60_000);
    proc.stdin?.on("error", () => {});
    const flush = onLines(proc.stdout, (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const m = message as Record<string, unknown>;
      if (m.type === "assistant") {
        if (m.error === "authentication_failed") authProblem = "authentication failed";
        readings ??= readingsFromUsageMessage(m, ctx.now().toISOString());
      }
      if (m.type === "result" && proc.stdin && !proc.stdin.writableEnded) proc.stdin.end();
    });
    proc.on("error", (error) => settle(error));
    proc.on("close", () => {
      flush();
      // Accounts without plan limits (for example API keys) have no usage report rows.
      settle();
    });
    const message = { type: "user", message: { role: "user", content: "/usage" } };
    proc.stdin?.write(`${JSON.stringify(message)}\n`);
  });
}

/** Single-consumer async queue backing `RunHandle.events`. */
class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(item: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
