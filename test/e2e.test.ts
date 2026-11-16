import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, inject, test } from "vitest";
import { homePaths } from "../src/home.js";
import { IpcClient } from "../src/ipc/client.js";
import { node, onCleanup, tempDir, waitFor } from "./support/harness.js";

/** Runs the built `preston daemon` as a separate process with the fake agent scenario. */
function spawnDaemon(home: string, scenario: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", inject("cliPath"), "daemon"],
    {
      env: { ...process.env, PRESTON_HOME: home, PRESTON_TEST_FAKE_AGENT: scenario },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  onCleanup(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  Object.defineProperty(child, "output", { get: () => output });
  return child;
}

async function connect(home: string): Promise<IpcClient> {
  const paths = homePaths(home);
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await IpcClient.connect(paths.endpoint, paths.ipcToken);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function attachTerminal(client: IpcClient, messages: { kind: string; text: string }[]) {
  client.onNotification((method, params) => {
    if (method === "terminal.message") messages.push(params as { kind: string; text: string });
  });
  await client.request("terminal.attach");
}

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) =>
    child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
  );

test("a Goal survives the daemon being killed mid-Run and still completes Verified", {
  timeout: 60_000,
}, async () => {
  const home = tempDir("preston-e2e");
  const project = tempDir("project");
  const started = join(home, "worker-started");
  const scenario = join(tempDir("scenario"), "scenario.mjs");
  writeFileSync(
    scenario,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const message = (turn) => /<preston-input kind="owner-message"[^>]*>\\n([\\s\\S]*?)\\n<\\/preston-input>/.exec(turn.input.prompt)?.[1];
export default {
  coordinator: async (turn) => {
    if (message(turn) !== "build it") return "";
    await turn.callTool("goal_create", {
      projectPath: ${JSON.stringify(project)},
      brief: { objective: "Create result.txt", checks: [{ name: "result exists", command: ${JSON.stringify(node("require('fs').accessSync('result.txt')"))} }] },
    });
    return "I drafted the Brief and started.";
  },
  worker: async (turn) => {
    if (!turn.resumed) {
      writeFileSync(${JSON.stringify(started)}, "1");
      await turn.stall();
    }
    writeFileSync(join(turn.input.workdir, "result.txt"), "done");
    await turn.callTool("report_result", { summary: "Created result.txt" });
    return "Done.";
  },
};
`,
  );

  const first = spawnDaemon(home, scenario);
  const client = await connect(home);
  const before: { kind: string; text: string }[] = [];
  await attachTerminal(client, before);
  const setup = await client.request<{
    needsAgents: boolean;
    agents: { agent: string; installed: boolean }[];
  }>("setup.state");
  expect(setup.needsAgents).toBe(true);
  expect(setup.agents.filter((a) => a.installed).map((a) => a.agent)).toEqual(["fake"]);
  await client.request("setup.chooseAgents", { agents: ["fake"] });

  await client.request("terminal.send", { text: "build it" });
  await waitFor(() => before.some((m) => m.kind === "reply"), {
    what: "the Coordinator's reply",
    timeoutMs: 15_000,
  });
  await waitFor(() => existsSync(started), { what: "the Worker to start", timeoutMs: 15_000 });
  expect(before.map((m) => m.kind)).toEqual(["ack", "reply"]);

  first.kill("SIGKILL");
  await exited(first);
  expect(existsSync(join(project, "result.txt"))).toBe(false);

  const second = spawnDaemon(home, scenario);
  const client2 = await connect(home);
  const after: { kind: string; text: string }[] = [];
  await attachTerminal(client2, after);
  await waitFor(() => after.some((m) => m.kind === "outcome"), {
    what: "the outcome",
    timeoutMs: 20_000,
  });

  expect(after).toEqual([
    {
      kind: "outcome",
      text: "Done and verified: Create result.txt\nI re-ran the check myself and it passes.\nSummary: Created result.txt",
    },
  ]);
  expect(readFileSync(join(project, "result.txt"), "utf8")).toBe("done");

  await client2.request("shutdown");
  await exited(second);
  expect(second.exitCode).toBe(0);
  expect(existsSync(homePaths(home).lock)).toBe(false);
});

test("a second daemon for the same home exits and leaves the first one running", {
  timeout: 30_000,
}, async () => {
  const home = tempDir("preston-e2e");
  const scenario = join(tempDir("scenario"), "scenario.mjs");
  writeFileSync(scenario, "export default {};\n");
  const first = spawnDaemon(home, scenario);
  const client = await connect(home);

  const second = spawnDaemon(home, scenario);
  await exited(second);

  expect(second.exitCode).toBe(0);
  expect((second as unknown as { output: string }).output).toContain("already running");
  expect(await client.request<{ pid: number }>("health")).toMatchObject({ pid: first.pid });
  await client.request("shutdown");
  await exited(first);
});
