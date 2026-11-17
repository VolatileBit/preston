import { readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { HomePaths } from "../home.js";
import { stopDaemon } from "./ensure.js";
import { processAlive } from "./lock.js";

export type StopResult = "not_running" | "stopped" | "killed" | "failed";

export interface StopOptions {
  /** How long to wait for the daemon to leave on its own before it is killed. */
  graceMs?: number;
  /** How long to wait after asking it to terminate before forcing it. */
  termMs?: number;
}

/**
 * Stops the background service: asks it to shut down (it saves its work and leaves cleanly),
 * and kills the process named in its lock file if it does not go, or no longer answers.
 */
export async function stopBackgroundService(
  paths: HomePaths,
  options: StopOptions = {},
): Promise<StopResult> {
  const pid = lockedPid(paths);
  const alive = () => pid !== undefined && processAlive(pid);
  const answered = await stopDaemon(paths, options.graceMs ?? 15_000);
  if (answered && !alive()) return pid === undefined ? "not_running" : "stopped";

  if (pid === undefined) return answered ? "not_running" : "failed";
  // It would not go: terminate it, then force it.
  const gone = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!alive()) return true;
      await delay(100);
    }
    return !alive();
  };
  try {
    process.kill(pid, "SIGTERM");
    if (!(await gone(options.termMs ?? 8_000))) {
      process.kill(pid, "SIGKILL");
      if (!(await gone(3_000))) return "failed";
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") return "failed";
  }
  rmSync(paths.lock, { force: true });
  return "killed";
}

function lockedPid(paths: HomePaths): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(paths.lock, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 && processAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}
