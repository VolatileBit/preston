import { PassThrough } from "node:stream";
import { expect, inject, test } from "vitest";
import { answers, startDaemon } from "../src/daemon/daemon.js";
import { setLanguage } from "../src/i18n/index.js";
import { runTerminal } from "../src/terminal/conversation.js";
import { fakeAdapterFactory } from "../src/workers/fake/index.js";
import { builtinAdapters } from "../src/workers/registry.js";
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
  // The real adapters, on a PATH where neither agent CLI exists.
  const real = builtinAdapters({ env: { PATH: tempDir("empty-path") } });
  const daemon = await startDaemon({ home, adapters: { ...real, fake: fake.factory } });
  onCleanup(() => daemon.close());

  const input = new PassThrough();
  const output = new PassThrough();
  let screen = "";
  output.on("data", (chunk) => (screen += chunk));
  const exit = runTerminal({
    paths: daemon.paths,
    cliPath: inject("cliPath"),
    input,
    output,
    locale: "en_US.UTF-8",
    startAtLogin: async () => ({ registered: true, changed: false }),
  });

  await waitFor(() => screen.includes("Language / 语言: 1) English  2) 简体中文 [1]"), {
    what: "the language question",
  });
  input.write("\n");
  await waitFor(() => screen.includes("Shall I use Fake agent? [Y/n]"), {
    what: "the agent question",
  });
  expect(screen).toContain("Welcome to Preston. I found Fake agent (fake) on this computer.");
  const setup = daemon.runtime.setup;
  const agents = (await setup.state()).agents;
  expect(agents.map((a) => [a.agent, a.installed])).toEqual([
    ["claude", false],
    ["codex", false],
    ["fake", true],
  ]);
  expect(agents.find((a) => a.agent === "claude")?.problem).toMatch(/Claude Code isn't installed/);
  expect(agents.find((a) => a.agent === "codex")?.problem).toMatch(/Codex isn't installed/);
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

test("a Simplified Chinese choice is saved and the rest of setup is in Chinese", async () => {
  const home = tempDir("preston-home");
  const fake = fakeAdapterFactory({
    coordinator: async (turn) => {
      if (turn.input.prompt.includes('kind="setup"')) {
        await turn.callTool("config_update", { patch: { setup: { complete: true } } });
        // The Coordinator is told to speak Chinese; the fake only proves the guidance arrived.
        return turn.input.appendSystemPrompt?.includes("Simplified Chinese") ? "欢迎！" : "English";
      }
      return "";
    },
  });
  const real = builtinAdapters({ env: { PATH: tempDir("empty-path") } });
  const daemon = await startDaemon({ home, adapters: { ...real, fake: fake.factory } });
  onCleanup(() => daemon.close());
  onCleanup(() => setLanguage("en"));

  const input = new PassThrough();
  const output = new PassThrough();
  let screen = "";
  output.on("data", (chunk) => (screen += chunk));
  const exit = runTerminal({
    paths: daemon.paths,
    cliPath: inject("cliPath"),
    input,
    output,
    locale: "en_US.UTF-8",
    startAtLogin: async () => ({ registered: true, changed: false }),
  });

  await waitFor(() => screen.includes("Language / 语言"), { what: "the language question" });
  input.write("2\n");
  await waitFor(() => screen.includes("使用 Fake agent 吗？[Y/n]"), {
    what: "the Chinese question",
  });
  expect(screen).toContain("欢迎使用 Preston。我在这台电脑上找到了 Fake agent (fake)。");
  input.write("\n");
  await waitFor(() => screen.includes("欢迎！"), { what: "the Coordinator's Chinese welcome" });
  expect(daemon.runtime.config.get().language).toBe("zh-CN");

  input.write("status\n");
  await waitFor(() => screen.includes("目前没有进行中的事项"), { what: "the Chinese status" });
  input.end();
  expect(await exit).toBe(0);
  expect(screen).toContain("Preston 会继续在后台工作");
});

test("the locale suggests the language offered first", async () => {
  const home = tempDir("preston-home");
  const real = builtinAdapters({ env: { PATH: tempDir("empty-path") } });
  const daemon = await startDaemon({
    home,
    adapters: { ...real, fake: fakeAdapterFactory({}).factory },
  });
  onCleanup(() => daemon.close());
  onCleanup(() => setLanguage("en"));
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = "";
  output.on("data", (chunk) => (screen += chunk));
  void runTerminal({
    paths: daemon.paths,
    cliPath: inject("cliPath"),
    input,
    output,
    locale: "zh_CN.UTF-8",
    startAtLogin: async () => ({ registered: true, changed: false }),
  });
  await waitFor(() => screen.includes("[2] "), { what: "Chinese suggested" });
  input.write("1\n");
  await waitFor(() => screen.includes("Shall I use Fake agent?"), { what: "English chosen" });
});
