import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isAlive } from "../src/supervisor/processes.js";
import { spawnTree } from "../src/util/process-tree.js";
import { createClaudeAdapter } from "../src/workers/claude/index.js";
import type { SpawnFn } from "../src/workers/claude/process.js";
import { type CodexSpawn, createCodexAdapter } from "../src/workers/codex/index.js";
import type { FakeTurn } from "../src/workers/fake/index.js";
import {
  brief,
  goalCreatingCoordinator,
  onCleanup,
  startPreston,
  tempDir,
  waitFor,
} from "./support/harness.js";

/**
 * An "agent" that starts a tool of its own, records the tool's process ID, and ignores polite
 * requests to stop, the way an agent in the middle of a long command does.
 */
const AGENT = `
  const tool = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  require("node:fs").writeFileSync(process.argv[1], String(tool.pid));
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
`;

const readPid = (file: string) => (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0);

/** Starts the agent whatever the adapter asked to run, so the real process-control code runs. */
const agentSpawn = (file: string) => (command: string, args: readonly string[], options: object) =>
  command === "taskkill"
    ? spawnTree(command, args, options)
    : spawnTree(process.execPath, ["-e", AGENT, file], options);

async function expectGone(pid: number, what: string) {
  await waitFor(() => !isAlive(pid), { what });
}

describe("stopping an agent stops the tools it started", () => {
  test("killing a child started with spawnTree also kills its grandchild", async () => {
    const file = join(tempDir("tree"), "tool.pid");
    const child = spawnTree(process.execPath, ["-e", AGENT, file], { stdio: "ignore" });
    const tool = await waitFor(() => readPid(file), { what: "the tool to start" });
    expect(isAlive(tool)).toBe(true);

    child.kill("SIGKILL");

    await expectGone(tool, "the tool to stop");
    await expectGone(child.pid as number, "the agent to stop");
  });

  test("an agent that exits on a polite stop does not leave a tool that ignores it running", async () => {
    const file = join(tempDir("tree"), "tool.pid");
    const child = spawnTree(
      process.execPath,
      [
        "-e",
        `const tool = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
          'process.on("SIGINT", () => {}); setInterval(() => {}, 1000)',
        )}], { stdio: "ignore" });
        require("node:fs").writeFileSync(process.argv[1], String(tool.pid));
        process.on("SIGINT", () => process.exit(0));
        setInterval(() => {}, 1000);`,
        file,
      ],
      { stdio: "ignore" },
    );
    const tool = await waitFor(() => readPid(file), { what: "the tool to start" });

    child.kill("SIGINT");

    await expectGone(child.pid as number, "the agent to stop");
    await expectGone(tool, "the tool to stop");
  });

  test("interrupting Claude Code ends its tools too", async () => {
    const file = join(tempDir("claude"), "tool.pid");
    const adapter = createClaudeAdapter({
      executable: process.execPath,
      env: {},
      interruptGraceMs: 200,
      spawn: agentSpawn(file) as unknown as SpawnFn,
    });
    const handle = adapter.startRun({ runId: "r", workdir: tempDir("work"), prompt: "go" });
    const tool = await waitFor(() => readPid(file), { what: "the tool to start" });

    await handle.interrupt();

    await expectGone(tool, "the tool to stop");
  });

  test("interrupting Codex ends its tools too", async () => {
    const file = join(tempDir("codex"), "tool.pid");
    const adapter = createCodexAdapter({
      executable: process.execPath,
      env: {},
      shutdownGraceMs: 200,
      interruptTimeoutMs: 200,
      spawn: agentSpawn(file) as unknown as CodexSpawn,
    });
    const handle = adapter.startRun({ runId: "r", workdir: tempDir("work"), prompt: "go" });
    const tool = await waitFor(() => readPid(file), { what: "the tool to start" });

    await handle.interrupt();

    await expectGone(tool, "the tool to stop");
  });

  test("an orphaned agent found after a crash is terminated together with its tools", async () => {
    const project = tempDir("project");
    const file = join(tempDir("orphan"), "tool.pid");
    let agent = 0;
    const scenario = {
      coordinator: goalCreatingCoordinator(project, brief()),
      worker: async (turn: FakeTurn) => {
        agent = turn.spawnChild({ grandchildPidFile: file });
        return turn.stall();
      },
    };
    const p = await startPreston({ scenario });
    // Never leave idle processes behind if an assertion fails first.
    onCleanup(() => {
      for (const pid of [agent, readPid(file)])
        if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
    });
    p.owner.receive("go");
    await waitFor(() => p.rt.trackedProcesses().length === 1 && readPid(file), {
      what: "the agent and its tool",
    });
    const tool = readPid(file);

    await p.restart({ scenario: { ...scenario, worker: () => "" } });

    await expectGone(agent, "the agent to be terminated");
    await expectGone(tool, "its tool to be terminated");
  });
});
