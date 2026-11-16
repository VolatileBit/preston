import { EventEmitter } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { systemClock } from "../src/clock.js";
import { createLogger, Redactor } from "../src/log.js";
import type { ToolClient } from "../src/mcp/tools.js";
import type { CodexChild, CodexSpawn } from "../src/workers/codex/index.js";
import { ModelCatalog } from "../src/workers/models.js";
import { Adapters, builtinAdapters } from "../src/workers/registry.js";
import type { ModelInfo, WorkerAdapter } from "../src/workers/types.js";
import { ownerMessage, startPreston, TEST_CONFIG, tempDir, waitFor } from "./support/harness.js";
import { fakeSpawn } from "./workers/claude/fake-spawn.js";

/** The environment of a `preston` started from inside a Claude Code and a Codex session. */
const NESTED_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/someone",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SESSION_ID: "parent-session",
  CLAUDE_CODE_SSE_PORT: "4242",
  CLAUDE_CODE_EXECPATH: "/opt/claude",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock",
  CLAUDE_AGENT_SDK_VERSION: "0.3.0",
  CODEX_THREAD_ID: "thread-1",
  CODEX_SANDBOX: "seatbelt",
  CODEX_SANDBOX_NETWORK_DISABLED: "1",
  // The user's own configuration and credentials.
  ANTHROPIC_API_KEY: "sk-ant-user",
  CLAUDE_CONFIG_DIR: "/home/someone/.claude-work",
  CLAUDE_CODE_OAUTH_TOKEN: "user-oauth-token",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CODEX_HOME: "/home/someone/.codex",
  OPENAI_API_KEY: "sk-user",
};

const KEPT = [
  "PATH",
  "HOME",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CODEX_HOME",
  "OPENAI_API_KEY",
];

function adapterContext() {
  const dir = tempDir("agents-log");
  return {
    home: dir,
    clock: systemClock,
    log: createLogger({ dir, clock: systemClock, redactor: new Redactor() }),
    tools: {} as ToolClient,
  };
}

/** A `codex` that answers `--version` and `login status`. */
function codexSpawn(calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[]): CodexSpawn {
  return (_command, args, options) => {
    calls.push({ args, env: options.env });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setImmediate(() => {
      child.stdout.end(args[0] === "--version" ? "codex-cli 0.169.0\n" : "");
      child.stderr.end(args[0] === "login" ? "Logged in using ChatGPT\n" : "");
      child.emit("exit", 0, null);
    });
    return child as unknown as CodexChild;
  };
}

describe("the real agent adapters", () => {
  test("start the agent CLIs without the parent agent session's variables", async () => {
    const dir = tempDir("claude-bin");
    const claudeExe = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    writeFileSync(claudeExe, "");
    chmodSync(claudeExe, 0o755);
    const claude = fakeSpawn((args) =>
      args[0] === "--version"
        ? { lines: ["2.1.325 (Claude Code)"] }
        : { lines: ['{"loggedIn":true}'] },
    );
    const codexCalls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const factories = builtinAdapters({
      env: NESTED_ENV,
      claude: { executable: claudeExe, spawn: claude.spawn },
      codex: { spawn: codexSpawn(codexCalls) },
    });
    const adapters = new Adapters(factories, adapterContext());

    const detected = await adapters.detectAll();

    expect(detected.map((d) => [d.agent, d.detection.installed, d.detection.version])).toEqual([
      ["claude", true, "2.1.325"],
      ["codex", true, "0.169.0"],
    ]);
    const envs = [...claude.calls.map((c) => c.options.env ?? {}), ...codexCalls.map((c) => c.env)];
    expect(envs).toHaveLength(4);
    for (const env of envs) expect(Object.keys(env).sort()).toEqual([...KEPT].sort());
  });

  test("a missing executable is reported as not installed, in plain words", async () => {
    const empty = tempDir("empty-path");
    const adapters = new Adapters(builtinAdapters({ env: { PATH: empty } }), adapterContext());
    const detected = await adapters.detectAll();
    expect(detected).toEqual([
      expect.objectContaining({
        agent: "claude",
        label: "Claude Code",
        detection: expect.objectContaining({
          installed: false,
          problem: expect.stringMatching(/^Claude Code isn't installed/),
        }),
      }),
      expect.objectContaining({
        agent: "codex",
        label: "Codex",
        detection: expect.objectContaining({
          installed: false,
          problem: expect.stringMatching(/^Codex isn't installed/),
        }),
      }),
    ]);
  });
});

const OFFERED: ModelInfo[] = [
  { id: "fast-1", displayName: "Fast 1", efforts: ["low", "medium"], isDefault: true },
  { id: "deep-2", displayName: "Deep 2", efforts: ["medium", "high"] },
];

describe("model settings", () => {
  test("config_update refuses a model the agent doesn't offer and keeps the previous config", async () => {
    const results: string[] = [];
    const p = await startPreston({
      wrapAdapter: (adapter) => ({ ...adapter, listModels: async () => OFFERED }),
      scenario: {
        coordinator: async (turn) => {
          const text = ownerMessage(turn);
          if (!text) return "";
          results.push(
            await turn
              .callTool("config_update", { patch: JSON.parse(text) })
              .catch((err: Error) => `error: ${err.message}`),
          );
          return "ok";
        },
      },
    });
    const before = p.rt.config.history(100).length;

    p.owner.receive(JSON.stringify({ coordinator: { model: "imaginary-9" } }));
    p.owner.receive(JSON.stringify({ workers: { model: "deep-2", effort: "low" } }));
    p.owner.receive(JSON.stringify({ workers: { model: "deep-2", effort: "high" } }));
    await waitFor(() => results.length === 3, { what: "three updates" });

    expect(results[0]).toBe(
      "error: I didn't change anything. \"imaginary-9\" isn't one of the models your Fake agent account offers. It offers: fast-1 (Fast 1), deep-2 (Deep 2).",
    );
    expect(results[1]).toBe(
      "error: I didn't change anything. Deep 2 doesn't offer \"low\" effort. Choose one of: medium, high.",
    );
    expect(JSON.parse(results[2] as string).config.workers).toEqual({
      model: "deep-2",
      effort: "high",
    });
    expect(p.rt.config.get().coordinator.model).toBeUndefined();
    expect(p.rt.config.history(100)).toHaveLength(before + 1);
  });

  test("Claude model names and efforts are checked by shape", async () => {
    const empty = tempDir("empty-path");
    const adapters = new Adapters(builtinAdapters({ env: { PATH: empty } }), adapterContext());
    const catalog = new ModelCatalog({ adapters, clock: systemClock, log: adapterContext().log });
    expect(await catalog.check("claude", "sonnet", "xhigh")).toEqual({ ok: true });
    expect(await catalog.check("claude", "claude-sonnet-5-5", "medium")).toEqual({ ok: true });
    expect(await catalog.check("claude", "gpt-6.1-sol")).toMatchObject({ ok: false });
    expect(await catalog.check("claude", undefined, "ultra")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("low, medium, high, xhigh, max"),
    });
  });

  test("the Coordinator's defaults resolve to provider models, falling back with a note", async () => {
    const codex = (models: ModelInfo[]): WorkerAdapter => ({
      agent: "codex",
      detect: async () => ({ installed: true }),
      startRun: () => {
        throw new Error("not used");
      },
      listModels: async () => models,
    });
    const catalog = (models: ModelInfo[], env: NodeJS.ProcessEnv = {}) =>
      new ModelCatalog({
        adapters: new Adapters(
          {
            codex: () => codex(models),
            claude: () => ({ ...codex([]), agent: "claude", listModels: undefined }),
          },
          adapterContext(),
        ),
        clock: systemClock,
        log: adapterContext().log,
        env,
      });

    const sol: ModelInfo = {
      id: "gpt-6.1-sol",
      efforts: ["low", "medium", "high"],
      isDefault: true,
    };
    expect(await catalog([sol]).coordinator("codex", {})).toEqual({
      model: "gpt-6.1-sol",
      effort: "medium",
      note: undefined,
    });
    const other: ModelInfo = {
      id: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      efforts: ["high"],
      isDefault: true,
    };
    const fallback = await catalog([other]).coordinator("codex", {});
    expect(fallback).toEqual({
      model: undefined,
      effort: undefined,
      note: '"gpt-6.1-sol" isn\'t offered on your Codex account, so I think with your own Codex default (GPT-6 Astra) instead. GPT-6 Astra doesn\'t offer "medium" effort, so I use its default.',
    });
    expect(await catalog([]).coordinator("claude", {})).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
    expect(
      await catalog([], { CLAUDE_CODE_USE_VERTEX: "1" }).coordinator("claude", {}),
    ).toMatchObject({ model: "sonnet", note: expect.stringContaining("latest Sonnet") });
  });
});

test("the Coordinator thinks with the configured model when it is offered", async () => {
  const p = await startPreston({
    wrapAdapter: (adapter) => ({ ...adapter, listModels: async () => OFFERED }),
    scenario: { coordinator: () => "hi" },
    config: { ...TEST_CONFIG, coordinator: { agent: "fake", model: "deep-2", effort: "high" } },
  });
  p.owner.receive("hello");
  const turn = await waitFor(() => p.fake.calls.find((c) => c.role === "coordinator"));
  expect(turn.input).toMatchObject({ model: "deep-2", effort: "high" });
});
