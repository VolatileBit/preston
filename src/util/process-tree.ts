import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

const isWindows = process.platform === "win32";

/**
 * Signals a process and everything it started. On Unix that is its process group, which exists
 * when the process was started with `spawnTree` (it leads a group of its own); a process that
 * leads no group is signalled alone unless `groupOnly`. On Windows a forced kill uses
 * `taskkill /T /F`, which walks the child tree; other signals are not supported there, so false
 * is returned and the caller falls back to the plain signal. True means a signal was sent.
 */
export function killTree(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  options: { groupOnly?: boolean } = {},
): boolean {
  if (isWindows) {
    if (signal !== "SIGKILL") return false;
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => {})
      .unref();
    return true;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // No such group: the process may not lead one.
  }
  if (options.groupOnly) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * `child_process.spawn` for agent processes. On Unix the child leads its own process group, and
 * `kill()` signals that whole group, so tools, shells and servers the agent started do not
 * outlive it when it is interrupted or timed out. On Windows a forced `kill("SIGKILL")` kills the
 * process tree. Never use it for a process that must stay in Preston's own group.
 */
export function spawnTree(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, [...args], { ...options, detached: !isWindows });
  const kill = child.kill.bind(child);
  let signalled = false;
  child.kill = (signal?: NodeJS.Signals | number) => {
    signalled = true;
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (typeof signal !== "number" && child.pid !== undefined) {
      if (killTree(child.pid, signal ?? "SIGTERM", { groupOnly: exited })) return true;
    }
    return kill(signal);
  };
  // Whatever the agent started and left running when it was told to stop goes with it.
  child.once("close", () => {
    if (signalled && child.pid !== undefined) killTree(child.pid, "SIGKILL", { groupOnly: true });
  });
  return child;
}
