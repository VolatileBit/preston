import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, inject, test } from "vitest";
import { helpText, parseArgs, usageError } from "../src/cli-args.js";
import { connectToDaemon } from "../src/daemon/ensure.js";
import { stopBackgroundService } from "../src/daemon/stop.js";
import { homePaths } from "../src/home.js";
import { setLanguage } from "../src/i18n/index.js";
import { onCleanup, tempDir } from "./support/harness.js";

afterEach(() => setLanguage("en"));

describe("reading the command line", () => {
  test("`preston` opens and `preston stop` stops; those are the only commands", () => {
    expect(parseArgs([])).toEqual({ kind: "open" });
    expect(parseArgs(["stop"])).toEqual({ kind: "stop" });
  });

  test("-h and --help ask for help, wherever they appear and whatever else is there", () => {
    for (const args of [
      ["-h"],
      ["--help"],
      ["stop", "-h"],
      ["-h", "stop"],
      ["bogus", "--help"],
      ["-xh"],
    ]) {
      expect(parseArgs(args)).toEqual({ kind: "help" });
    }
  });

  test("a mistake is an error, never silently ignored", () => {
    expect(parseArgs(["start"])).toEqual({ kind: "error", message: "unknown command 'start'" });
    expect(parseArgs(["-x"])).toEqual({ kind: "error", message: "invalid option -- 'x'" });
    expect(parseArgs(["--bogus"])).toEqual({
      kind: "error",
      message: "unrecognized option '--bogus'",
    });
    expect(parseArgs(["stop", "now"])).toEqual({
      kind: "error",
      message: "unexpected argument 'now' after 'stop'",
    });
  });

  test("-- ends the options, so what follows is an operand", () => {
    expect(parseArgs(["--", "stop"])).toEqual({ kind: "stop" });
    expect(parseArgs(["--", "-h"])).toEqual({ kind: "error", message: "unknown command '-h'" });
  });

  test("the internal roles still work, and are not in the help", () => {
    expect(parseArgs(["daemon"])).toEqual({ kind: "daemon" });
    expect(parseArgs(["mcp", "--token", "t"])).toEqual({ kind: "mcp", args: ["--token", "t"] });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(helpText()).not.toMatch(/daemon|mcp|--version/);
  });

  test("the help gives the usage synopsis first and the two commands, in either language", () => {
    const en = helpText();
    expect(en.startsWith("Usage: preston\n       preston stop\n       preston -h\n")).toBe(true);
    expect(en).toContain("  stop    Stop the background service.");
    expect(en).toContain("  -h, --help  Show this help and exit.");
    setLanguage("zh-CN");
    expect(helpText().startsWith("用法：preston\n")).toBe(true);
    expect(usageError("unknown command 'x'")).toBe(
      "preston: unknown command 'x'\nUsage: preston | preston stop | preston -h\n",
    );
  });
});

describe("the real executable", () => {
  const cli = inject("cliPath");
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, PRESTON_HOME: tempDir("preston-home") },
    });

  test("-h prints the usage to stdout and exits 0", () => {
    const result = run(["-h"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: preston");
    expect(result.stderr).toBe("");
  });

  test("a mistake prints a one-line complaint and the usage to stderr and exits 2", () => {
    const result = run(["frobnicate"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "preston: unknown command 'frobnicate'\nUsage: preston | preston stop | preston -h\n",
    );
  });

  test("stop with no service running says so and exits 0", () => {
    const result = run(["stop"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Preston's background service is not running.\n");
  });
});

describe("stopping the background service", () => {
  test("a running daemon is asked to shut down; stopping again finds nothing running", async () => {
    const paths = homePaths(tempDir("preston-home"));
    // A real background process, as `preston` starts it (the lock holds its pid, not ours).
    const client = await connectToDaemon(paths, inject("cliPath"));
    client.close();

    expect(await stopBackgroundService(paths, { graceMs: 10_000 })).toBe("stopped");
    expect(await stopBackgroundService(paths, { graceMs: 1_000 })).toBe("not_running");
  });

  test("a process that ignores the request is terminated, then forced", async () => {
    const home = tempDir("preston-home");
    const paths = homePaths(home);
    mkdirSync(paths.root, { recursive: true });
    // Stands in for a hung daemon: it holds the lock, never answers, and ignores SIGTERM.
    const script = join(home, "stubborn.mjs");
    writeFileSync(
      script,
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up');",
    );
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((resolve) => child.stdout?.once("data", resolve));
    writeFileSync(paths.lock, String(child.pid));
    onCleanup(() => void child.kill("SIGKILL"));

    const result = await stopBackgroundService(paths, { graceMs: 300, termMs: 400 });
    expect(result).toBe("killed");
    expect(() => process.kill(child.pid as number, 0)).toThrow();
  });
});
