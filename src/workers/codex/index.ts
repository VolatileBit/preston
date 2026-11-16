import type {
  AgentDetection,
  ModelInfo,
  QuotaReading,
  RunHandle,
  StartRunInput,
  UpdateResult,
  WorkerAdapter,
} from "../types.js";
import { quotaReadings, toModelInfo } from "./mapping.js";
import {
  type CodexChild,
  type CodexSpawn,
  defaultSpawn,
  resolveExecutable,
  runCaptured,
  shutdownChild,
} from "./process.js";
import type { GetAccountRateLimitsResponse, ModelListResponse } from "./protocol.js";
import { AppServerConnection, RpcError } from "./rpc.js";
import { startCodexRun } from "./run.js";

export type { CodexChild, CodexSpawn, CodexSpawnOptions } from "./process.js";

export interface CodexAdapterOptions {
  /** Executable name or path; defaults to `codex` found on PATH. */
  executable?: string;
  /** Environment for every Codex process; defaults to Preston's own. */
  env?: NodeJS.ProcessEnv;
  /** Process launcher; tests inject a simulated App Server. */
  spawn?: CodexSpawn;
  now?: () => Date;
  /** Wait at each shutdown step (stdin closed → SIGTERM → SIGKILL). Default 3000 ms. */
  shutdownGraceMs?: number;
  /** Wait for `turn/interrupt` and in-run quota reads. Default 5000 ms. */
  interruptTimeoutMs?: number;
}

const COMMAND_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0];
}

function tail(text: string): string {
  return text.trim().slice(-500);
}

/**
 * Drives the user's installed `codex` CLI through `codex app-server` (ADR 0002). Preston never
 * touches Codex credentials; login state comes from `codex login status`.
 */
export function createCodexAdapter(opts: CodexAdapterOptions = {}): WorkerAdapter {
  const executable = opts.executable ?? "codex";
  const env = opts.env ?? process.env;
  const spawn = opts.spawn ?? defaultSpawn;
  const now = opts.now ?? (() => new Date());
  const shutdownGraceMs = opts.shutdownGraceMs ?? 3000;
  const interruptTimeoutMs = opts.interruptTimeoutMs ?? 5000;
  const resolve = () => resolveExecutable(executable, env);

  async function version(): Promise<string | undefined> {
    const run = await runCaptured(spawn, resolve(), ["--version"], env, COMMAND_TIMEOUT_MS);
    return run.code === 0 ? parseVersion(run.stdout) : undefined;
  }

  /** A short-lived App Server for token-free reads, shut down afterwards. */
  async function withAppServer<T>(fn: (conn: AppServerConnection) => Promise<T>): Promise<T> {
    const exe = resolve();
    let startError: Error | undefined;
    const child: CodexChild = spawn(exe.command, ["app-server"], { env, shell: exe.shell });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.on("exit", (code, signal) => done({ code, signal }));
      child.on("error", (error) => {
        startError = error;
        done({ code: null, signal: null });
      });
    });
    child.stderr.resume();
    const conn: AppServerConnection = new AppServerConnection(child, {
      onNotification: () => {},
      onRequest: (r) => conn.respondError(r.id, -32601, `Preston does not handle ${r.method}`),
    });
    void exited.then(() => conn.close());
    try {
      await conn.initialize();
      return await fn(conn);
    } catch (error) {
      if (startError) throw new Error(`Could not start Codex: ${startError.message}`);
      throw error;
    } finally {
      await shutdownChild(child, exited, shutdownGraceMs);
    }
  }

  return {
    agent: "codex",

    async detect(): Promise<AgentDetection> {
      const exe = resolve();
      const run = await runCaptured(spawn, exe, ["--version"], env, COMMAND_TIMEOUT_MS);
      if (run.error || run.code !== 0) {
        const missing = (run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
        return {
          installed: false,
          ...(exe.path ? { path: exe.path } : {}),
          problem: missing
            ? "Codex isn't installed (no `codex` command was found). Install the Codex CLI, then run `codex login`."
            : `Codex is installed but won't start: ${run.error?.message ?? (tail(run.stderr) || `exit code ${run.code}`)}`,
        };
      }
      const detection: AgentDetection = {
        installed: true,
        ...(exe.path ? { path: exe.path } : {}),
      };
      const found = parseVersion(run.stdout);
      if (found) detection.version = found;

      // Prints to stderr; exits 0 when signed in and 1 with "Not logged in" otherwise.
      const login = await runCaptured(spawn, exe, ["login", "status"], env, COMMAND_TIMEOUT_MS);
      const output = `${login.stdout}\n${login.stderr}`;
      if (login.code === 0) {
        detection.loggedIn = true;
      } else if (/not logged in/i.test(output)) {
        detection.loggedIn = false;
        detection.problem =
          "Codex is installed but not signed in. Run `codex login` in a terminal to sign in.";
      } else {
        detection.loggedIn = "unknown";
      }
      return detection;
    },

    startRun(input: StartRunInput): RunHandle {
      return startCodexRun(input, {
        spawn,
        exe: resolve(),
        env,
        now,
        shutdownGraceMs,
        interruptTimeoutMs,
      });
    },

    async readQuota(): Promise<QuotaReading[]> {
      return withAppServer(async (conn) => {
        try {
          const response = await conn.request<GetAccountRateLimitsResponse>(
            "account/rateLimits/read",
            null,
            REQUEST_TIMEOUT_MS,
          );
          return quotaReadings(response, now().toISOString());
        } catch (error) {
          // API-key logins (and signed-out CLIs) have no plan windows to report.
          if (error instanceof RpcError) return [];
          throw error;
        }
      });
    },

    async listModels(): Promise<ModelInfo[]> {
      return withAppServer(async (conn) => {
        const models: ModelInfo[] = [];
        let cursor: string | null | undefined;
        for (let page = 0; page < 10; page++) {
          const response = await conn.request<ModelListResponse>(
            "model/list",
            cursor ? { cursor } : {},
            REQUEST_TIMEOUT_MS,
          );
          for (const model of response.data ?? []) {
            if (!model.hidden) models.push(toModelInfo(model));
          }
          cursor = response.nextCursor;
          if (!cursor) break;
        }
        return models;
      });
    },

    async update(): Promise<UpdateResult> {
      const fromVersion = await version();
      // The standalone updater honours CODEX_NON_INTERACTIVE; npm/brew installs never prompt.
      const run = await runCaptured(
        spawn,
        resolve(),
        ["update"],
        { ...env, CODEX_NON_INTERACTIVE: "1" },
        UPDATE_TIMEOUT_MS,
      );
      const toVersion = await version();
      const versions = {
        ...(fromVersion ? { fromVersion } : {}),
        ...(toVersion ? { toVersion } : {}),
      };
      if (run.error || run.timedOut || run.code !== 0) {
        const why = run.error
          ? run.error.message
          : run.timedOut
            ? "it timed out"
            : `exit code ${run.code}: ${tail(`${run.stdout}\n${run.stderr}`)}`;
        return { updated: false, ...versions, detail: `codex update failed (${why})` };
      }
      if (!toVersion) {
        return {
          updated: false,
          ...versions,
          detail: "codex update finished but `codex --version` no longer runs",
        };
      }
      const updated = !!fromVersion && fromVersion !== toVersion;
      return {
        updated,
        ...versions,
        detail: updated
          ? `Updated Codex from ${fromVersion} to ${toVersion}`
          : `Codex ${toVersion} is already up to date`,
      };
    },
  };
}
