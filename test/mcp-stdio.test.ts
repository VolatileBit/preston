import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, inject, test } from "vitest";
import { FakeChannel } from "../src/channels/fake/index.js";
import { startDaemon } from "../src/daemon/daemon.js";
import { type FakeTurn, fakeAdapterFactory } from "../src/workers/fake/index.js";
import {
  finishedGoal,
  goalCreatingCoordinator,
  onCleanup,
  TEST_CONFIG,
  tempDir,
  waitFor,
} from "./support/harness.js";

test("agents reach Preston's tools through the real `preston mcp` stdio server", {
  timeout: 30_000,
}, async () => {
  const home = tempDir("preston-home");
  const project = tempDir("project");
  const seen: Record<string, unknown> = {};
  const fake = fakeAdapterFactory({
    mcp: "stdio",
    coordinator: async (turn: FakeTurn) => {
      seen.coordinatorTools = await turn.listTools();
      return goalCreatingCoordinator(project)(turn);
    },
    worker: async (turn: FakeTurn) => {
      seen.workerTools = await turn.listTools();
      seen.allow = JSON.parse(
        await turn.callTool("approve", {
          tool_name: "Write",
          input: { file_path: join(project, "a.txt"), content: "x" },
        }),
      );
      seen.deny = JSON.parse(
        await turn.callTool("approve", { tool_name: "Bash", input: { command: "git push" } }),
      );
      seen.mcp = turn.input.mcp;
      await turn.callTool("report_result", { summary: "Done over stdio." });
      return "Done.";
    },
  });
  const owner = new FakeChannel();
  const daemon = await startDaemon({
    home,
    adapters: { fake: fake.factory },
    channels: [owner],
    initialConfig: TEST_CONFIG,
    mcpCommand: { command: process.execPath, args: [inject("cliPath")] },
  });
  onCleanup(() => daemon.close());

  owner.receive("go");
  const goal = await waitFor(finishedGoal(daemon.runtime), { timeoutMs: 20_000 });

  expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
  expect(seen.workerTools).toEqual(["ask_preston", "report_result", "approve"]);
  expect(seen.coordinatorTools).toEqual(
    expect.arrayContaining([
      "goal_create",
      "answer_worker",
      "ask_human",
      "config_rollback",
      "approve",
    ]),
  );
  expect(seen.coordinatorTools).not.toContain("report_result");
  expect(seen.allow).toEqual({
    behavior: "allow",
    updatedInput: { file_path: join(project, "a.txt"), content: "x" },
  });
  expect(seen.deny).toMatchObject({ behavior: "deny" });
  expect(daemon.runtime.runs(goal.id)[0]?.report?.summary).toBe("Done over stdio.");

  // The Run's token was revoked when its turn ended.
  const spec = seen.mcp as { command: string; args: string[]; env: Record<string, string> };
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...process.env, ...spec.env } as Record<string, string>,
    }),
  );
  const result = (await client.callTool({
    name: "report_result",
    arguments: { summary: "late" },
  })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("not valid");
  await client.close();
});
