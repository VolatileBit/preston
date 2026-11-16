import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureHome, type HomePaths } from "../home.js";
import { IpcClient } from "../ipc/client.js";

const START_TIMEOUT_MS = 20_000;
const POLL_MS = 150;

/**
 * Connects to the daemon, starting it in the background first if it is not running.
 * The daemon is detached, so it keeps running after this client exits.
 */
export async function connectToDaemon(paths: HomePaths, cliPath: string): Promise<IpcClient> {
  const existing = await tryConnect(paths);
  if (existing) return existing;

  ensureHome(paths);
  const outputPath = join(paths.logs, "daemon.out");
  const output = openSync(outputPath, "a", 0o600);
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", cliPath, "daemon"],
    {
      detached: true,
      stdio: ["ignore", output, output],
      windowsHide: true,
      env: { ...process.env, PRESTON_HOME: paths.root },
    },
  );
  closeSync(output);
  let exited: number | null | undefined;
  child.once("exit", (code) => {
    exited = code;
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(POLL_MS);
    const client = await tryConnect(paths);
    if (client) return client;
    // A non-zero exit means it failed; zero means another instance won the race.
    if (exited !== undefined && exited !== 0) break;
  }
  throw new Error(`Preston's background service did not start.\n${tail(outputPath)}`);
}

async function tryConnect(paths: HomePaths): Promise<IpcClient | undefined> {
  if (!existsSync(paths.ipcToken)) return undefined;
  try {
    const client = await IpcClient.connect(paths.endpoint, paths.ipcToken);
    await client.request("health");
    return client;
  } catch {
    return undefined;
  }
}

function tail(path: string): string {
  try {
    return readFileSync(path, "utf8").trim().split("\n").slice(-10).join("\n");
  } catch {
    return "";
  }
}
