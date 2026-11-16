import { spawn } from "node:child_process";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { startDaemon } from "../src/daemon/daemon.js";
import { AlreadyRunningError } from "../src/daemon/lock.js";
import { homePaths } from "../src/home.js";
import { onCleanup, tempDir } from "./support/harness.js";

/** A live process that is not a daemon: it holds a pid but never answers on the endpoint. */
function livePid(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  onCleanup(() => {
    child.kill();
  });
  return child.pid as number;
}

// The login service and `preston` may both start the daemon at once; the one that loses the
// lock must not take over while the winner is still starting up.
test("a daemon that is still starting keeps its lock", async () => {
  const home = tempDir("preston-home");
  const paths = homePaths(home);
  writeFileSync(paths.lock, String(livePid()));

  await expect(startDaemon({ home, adapters: {} })).rejects.toBeInstanceOf(AlreadyRunningError);
});

test("a lock whose process is gone is taken over at once", async () => {
  const home = tempDir("preston-home");
  const paths = homePaths(home);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise((resolve) => child.once("exit", resolve));
  writeFileSync(paths.lock, String(pid));

  const daemon = await startDaemon({ home, adapters: {} });
  onCleanup(() => daemon.close());

  expect(daemon.paths.root).toBe(home);
  expect(readFileSync(paths.lock, "utf8")).toBe(String(process.pid));
});

test("a lock held for long by a process that never answers is taken over", async () => {
  const home = tempDir("preston-home");
  const paths = homePaths(home);
  writeFileSync(paths.lock, String(livePid()));
  const old = new Date(Date.now() - 60_000);
  utimesSync(paths.lock, old, old);

  const daemon = await startDaemon({ home, adapters: {} });
  onCleanup(() => daemon.close());

  expect(daemon.paths.root).toBe(home);
});
