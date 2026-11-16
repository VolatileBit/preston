import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { configuredChannels } from "../channels/registry.js";
import { TerminalChannel } from "../channels/terminal.js";
import type { Channel } from "../channels/types.js";
import { agentKindSchema } from "../config/schema.js";
import { ensureHome, type HomePaths, homePaths, resolveHome } from "../home.js";
import { IpcClient } from "../ipc/client.js";
import { RPC_ERRORS, RpcCallError } from "../ipc/protocol.js";
import { type IpcMethod, type IpcServer, startIpcServer } from "../ipc/server.js";
import { errorMessage } from "../log.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "../runtime.js";
import { newSecret } from "../util/ids.js";
import { PRESTON_VERSION } from "../version.js";
import { type FakeScenario, fakeAdapterFactory } from "../workers/fake/index.js";
import { BUILTIN_ADAPTERS } from "../workers/registry.js";
import { AlreadyRunningError, acquireLock, processAlive } from "./lock.js";

/** Test-only: a module whose default export is a FakeScenario. Never documented for users. */
export const FAKE_AGENT_ENV = "PRESTON_TEST_FAKE_AGENT";

export interface DaemonOptions extends Omit<RuntimeOptions, "channels"> {
  /** Chat Channels to register next to the terminal. Defaults to those configured. */
  channels?: Channel[];
  /** Called when a client asks the daemon to shut down. Defaults to closing it. */
  onShutdownRequest?: () => void;
}

export interface Daemon {
  readonly runtime: Runtime;
  readonly paths: HomePaths;
  close(): Promise<void>;
}

/** Starts the daemon in this process: single-instance lock, runtime, and IPC endpoint. */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const paths = homePaths(resolve(options.home));
  ensureHome(paths);
  const lock = await acquireLock(
    paths.lock,
    async (pid) => processAlive(pid) && (await answers(paths)),
  );
  const terminal = new TerminalChannel();
  let runtime: Runtime | undefined;
  let server: IpcServer | undefined;
  try {
    const token = ensureIpcToken(paths.ipcToken);
    runtime = await createRuntime({
      ...options,
      home: paths.root,
      channels: ({ config, log }) => [
        terminal,
        ...(options.channels ?? configuredChannels(config, paths.root, log)),
      ],
    });
    const rt = runtime;
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
        await server?.close();
        await rt.stop();
        lock.release();
      })();
      return closing;
    };
    server = await startIpcServer({
      endpoint: paths.endpoint,
      token,
      log: rt.log.child("ipc"),
      methods: daemonMethods(rt, terminal, options.onShutdownRequest ?? (() => void close())),
    });
    await rt.start();
    return { runtime: rt, paths, close };
  } catch (err) {
    await server?.close();
    await runtime?.stop().catch(() => {});
    lock.release();
    throw err;
  }
}

/** `preston daemon`: runs until signalled. */
export async function runDaemonProcess(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const adapters = { ...BUILTIN_ADAPTERS };
  const scenarioPath = env[FAKE_AGENT_ENV];
  if (scenarioPath) {
    const mod = (await import(pathToFileURL(resolve(scenarioPath)).href)) as {
      default?: FakeScenario;
    };
    adapters.fake = fakeAdapterFactory(mod.default ?? (mod as FakeScenario)).factory;
  }
  let daemon: Daemon;
  const exit = () => {
    void daemon.close().finally(() => process.exit(0));
  };
  try {
    daemon = await startDaemon({ home: resolveHome(env), adapters, onShutdownRequest: exit });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      process.stderr.write(`${err.message}\n`);
      return;
    }
    throw err;
  }
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);
  process.on("uncaughtException", (err) => {
    daemon.runtime.log.error("uncaught exception", { error: err });
    process.exit(1);
  });
  process.on("unhandledRejection", (err) =>
    daemon.runtime.log.error("unhandled rejection", { error: err }),
  );
}

function daemonMethods(
  runtime: Runtime,
  terminal: TerminalChannel,
  shutdown: () => void,
): Record<string, IpcMethod> {
  const parse = <S extends z.ZodType>(schema: S, params: unknown): z.infer<S> => {
    const result = schema.safeParse(params ?? {});
    if (!result.success)
      throw new RpcCallError(RPC_ERRORS.invalidParams, z.prettifyError(result.error));
    return result.data;
  };
  const tokenCall = z.object({ token: z.string().min(1) });
  return {
    health: () => ({
      ok: true,
      pid: process.pid,
      version: PRESTON_VERSION,
      home: runtime.paths.root,
    }),
    shutdown: () => {
      setImmediate(shutdown);
      return { ok: true };
    },
    "terminal.attach": (_params, connection) => {
      const detach = terminal.attach({
        send: (message) => connection.notify("terminal.message", message),
      });
      connection.onClose(detach);
      return { ok: true };
    },
    "terminal.send": (params) => {
      const { text } = parse(z.object({ text: z.string().min(1).max(20_000) }), params);
      terminal.receive(text);
      return { ok: true };
    },
    "setup.state": () => runtime.setup.state(),
    "setup.chooseAgents": async (params) => {
      const choice = parse(
        z.object({
          agents: z.array(agentKindSchema).min(1),
          balanceByQuota: z.boolean().default(false),
        }),
        params,
      );
      try {
        await runtime.setup.chooseAgents(choice);
      } catch (err) {
        throw new RpcCallError(RPC_ERRORS.failed, errorMessage(err));
      }
      return { ok: true };
    },
    "setup.continue": (params) => {
      const { justChoseAgents } = parse(
        z.object({ justChoseAgents: z.boolean().default(false) }),
        params,
      );
      return { handedToCoordinator: runtime.setup.continue({ justChoseAgents }) };
    },
    "mcp.describe": (params) => {
      const { token } = parse(tokenCall, params);
      return guard(() => runtime.tools.describe(token));
    },
    "mcp.call": (params) => {
      const {
        token,
        name,
        arguments: args,
      } = parse(
        tokenCall.extend({ name: z.string().min(1), arguments: z.unknown().optional() }),
        params,
      );
      return guard(() => runtime.tools.call(token, name, args));
    },
  };
}

async function guard<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new RpcCallError(RPC_ERRORS.unauthorized, errorMessage(err));
  }
}

function ensureIpcToken(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) {
      chmodSync(path, 0o600);
      return existing;
    }
  }
  const token = newSecret();
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** Whether a daemon already answers on this home's endpoint. */
export async function answers(paths: HomePaths): Promise<boolean> {
  if (!existsSync(paths.ipcToken)) return false;
  try {
    const client = await IpcClient.connect(paths.endpoint, paths.ipcToken);
    await client.request("health");
    client.close();
    return true;
  } catch {
    return false;
  }
}
