import { PassThrough } from "node:stream";
import { expect, inject, test } from "vitest";
import { answers, startDaemon } from "../src/daemon/daemon.js";
import { runTerminal } from "../src/terminal/conversation.js";
import { fakeAdapterFactory } from "../src/workers/fake/index.js";
import { BUILTIN_ADAPTERS } from "../src/workers/registry.js";
import { onCleanup, tempDir, waitFor } from "./support/harness.js";

test("first run: choose the agent, hand setup to the Coordinator, chat, and leave Preston running", async () => {
  const home = tempDir("preston-home");
  const fake = fakeAdapterFactory({
    coordinator: async (turn) => {
      if (turn.input.prompt.includes('kind="setup"')) {
        await turn.callTool("config_update", { patch: { setup: { complete: true } } });
        return "Welcome! You're all set. What would you like done?";
      }
      return "";
    },
  });
  const daemon = await startDaemon({ home, adapters: { ...BUILTIN_ADAPTERS, fake: fake.factory } });
  onCleanup(() => daemon.close());

  const input = new PassThrough();
  const output = new PassThrough();
  let screen = "";
  output.on("data", (chunk) => (screen += chunk));
  const exit = runTerminal({ paths: daemon.paths, cliPath: inject("cliPath"), input, output });

  await waitFor(() => screen.includes("Shall I use Fake agent? [Y/n]"), {
    what: "the agent question",
  });
  expect(screen).toContain("Welcome to Preston. I found Fake agent (fake) on this computer.");
  input.write("\n");
  await waitFor(() => screen.includes("Welcome! You're all set."), {
    what: "the Coordinator's welcome",
  });
  expect(daemon.runtime.config.get()).toMatchObject({
    agents: { enabled: ["fake"] },
    coordinator: { agent: "fake" },
    setup: { complete: true },
  });

  input.write("status\n");
  await waitFor(() => screen.includes("Nothing in progress."), { what: "the status reply" });
  input.end();

  expect(await exit).toBe(0);
  expect(screen).toContain("Preston keeps working in the background.");
  expect(await answers(daemon.paths)).toBe(true);
});
