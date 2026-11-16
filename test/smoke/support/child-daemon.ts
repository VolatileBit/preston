import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homePaths } from "../../../src/home.js";
import { IpcClient } from "../../../src/ipc/client.js";
import { onCleanup } from "./world.js";

export interface TerminalMessage {
  kind: string;
  text: string;
  at: number;
}

/**
 * Preston's real daemon as a separate OS process (`preston daemon`, the same executable the login
 * service would run) with the real agent adapters, talked to over IPC like the terminal client.
 * It is started directly: nothing is registered with launchd, systemd or the Task Scheduler.
 */
export interface ChildDaemon {
  pid: number;
  child: ChildProcess;
  messages: TerminalMessage[];
  send(text: string): Promise<void>;
  /** SIGKILL: no chance to shut anything down, as in a crash or power cut. */
  kill9(): Promise<void>;
  /** Asks the daemon to shut down through IPC and waits for the process to exit. */
  shutdown(): Promise<void>;
  /** Read-only look at the daemon's database. */
  query<T = Record<string, unknown>>(sql: string, params?: Record<string, string>): T[];
  exited(): boolean;
}

export async function startChildDaemon(home: string): Promise<ChildDaemon> {
  const cli = process.env.PRESTON_SMOKE_CLI;
  if (!cli) throw new Error("PRESTON_SMOKE_CLI is not set; run through `npm run smoke`.");
  const paths = homePaths(home);
  const out = openSync(join(home, "daemon.out"), "a", 0o600);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "daemon"], {
    env: { ...process.env, PRESTON_HOME: home },
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  let exitedFlag = false;
  child.once("exit", () => {
    exitedFlag = true;
  });
  const messages: TerminalMessage[] = [];
  let client: IpcClient | undefined;
  const connect = async () => {
    if (!existsSync(paths.ipcToken)) return undefined;
    try {
      const c = await IpcClient.connect(paths.endpoint, paths.ipcToken);
      await c.request("health");
      return c;
    } catch {
      return undefined;
    }
  };
  const log = () => {
    try {
      return readFileSync(join(home, "daemon.out"), "utf8").slice(-1500);
    } catch {
      return "";
    }
  };
  const deadline = Date.now() + 30_000;
  while (!client && Date.now() < deadline) {
    if (exitedFlag) throw new Error(`The daemon exited at start-up:\n${log()}`);
    client = await connect();
    if (!client) await new Promise((r) => setTimeout(r, 200));
  }
  if (!client) throw new Error(`The daemon did not answer:\n${log()}`);
  client.onNotification((method, params) => {
    if (method === "terminal.message") {
      const { kind, text } = params as { kind: string; text: string };
      messages.push({ kind, text, at: Date.now() });
      console.log(`  terminal <- [${kind}] ${text.replace(/\n/g, " | ")}`);
    }
  });
  await client.request("terminal.attach");

  const waitForExit = () =>
    new Promise<void>((resolve) => {
      if (exitedFlag) resolve();
      else child.once("exit", () => resolve());
    });
  const daemon: ChildDaemon = {
    pid: child.pid as number,
    child,
    messages,
    async send(text) {
      console.log(`  terminal -> ${text.replace(/\n/g, " | ")}`);
      await (client as IpcClient).request("terminal.send", { text });
    },
    async kill9() {
      child.kill("SIGKILL");
      await waitForExit();
    },
    async shutdown() {
      if (exitedFlag) return;
      await (client as IpcClient).request("shutdown").catch(() => undefined);
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      await waitForExit();
      clearTimeout(timer);
    },
    query(sql, params = {}) {
      const db = new DatabaseSync(paths.db, { readOnly: true });
      try {
        return db.prepare(sql).all(params) as never;
      } finally {
        db.close();
      }
    },
    exited: () => exitedFlag,
  };
  onCleanup(async () => {
    if (!exitedFlag) await daemon.shutdown();
  });
  return daemon;
}
