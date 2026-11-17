import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createCodexAdapter } from "../../../src/workers/codex/index.js";
import type { RunHandle, StartRunInput, WorkerEvent } from "../../../src/workers/types.js";
import {
  enoent,
  FakeAppServer,
  FakeCommand,
  type FixtureEntry,
  fakeSpawn,
  type Handler,
  type Json,
  loadFixture,
  loadJsonFixture,
} from "./fake-codex.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;
const NOW = new Date("2026-11-16T06:00:00.000Z");
const WORKDIR = path.join(tmpdir(), "preston-codex-test-work");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  script: FixtureEntry[],
  handlers: Record<string, Handler> = {},
  options: { crlf?: boolean; exitOnStdinEnd?: boolean } = {},
) {
  const servers: FakeAppServer[] = [];
  const { spawn, calls } = fakeSpawn(() => {
    const server = new FakeAppServer(script, handlers, options);
    servers.push(server);
    return server;
  });
  const adapter = createCodexAdapter({
    executable: "codex",
    env: { PATH: "" },
    spawn,
    now: () => NOW,
    shutdownGraceMs: 50,
    interruptTimeoutMs: 200,
  });
  return {
    adapter,
    calls,
    server: () => {
      const server = servers[0];
      if (!server) throw new Error("no app-server was started");
      return server;
    },
  };
}

function input(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    runId: "run-1",
    workdir: WORKDIR,
    prompt: "Reply with the single word ok",
    access: "full",
    ...overrides,
  };
}

async function collect(run: RunHandle): Promise<WorkerEvent[]> {
  const events: WorkerEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

const types = (events: WorkerEvent[]) => events.map((e) => e.type);
const terminalTypes = ["completed", "failed", "quota_blocked", "auth_error"];
const terminals = (events: WorkerEvent[]) => events.filter((e) => terminalTypes.includes(e.type));

function threadIdOf(script: FixtureEntry[]): string {
  return script.find((e) => e.dir === "in" && e.msg.result?.thread)?.msg.result.thread.id;
}

/** Cuts the transcript after `turn/started`, leaving the turn running. */
function untilTurnStarted(script: FixtureEntry[]): FixtureEntry[] {
  return script.slice(0, script.findIndex((e) => e.msg.method === "turn/started") + 1);
}

/**
 * Inserts extra server messages right after the recorded `turn/started` notification. Server
 * requests hold the replay until Preston answers them, as the real turn would.
 */
function afterTurnStarted(script: FixtureEntry[], extra: Json[]): FixtureEntry[] {
  const index = script.findIndex((e) => e.msg.method === "turn/started");
  const inserted = extra.flatMap((msg): FixtureEntry[] =>
    msg.method && msg.id !== undefined
      ? [
          { dir: "in", msg },
          { dir: "out", msg: { id: msg.id } },
        ]
      : [{ dir: "in", msg }],
  );
  return [...script.slice(0, index + 1), ...inserted, ...script.slice(index + 1)];
}

describe("startRun", () => {
  test("performs the initialize handshake as preston", async () => {
    const { adapter, server, calls } = setup(loadFixture("turn-ok"));
    await collect(adapter.startRun(input()));

    expect(calls[0]).toMatchObject({
      args: ["app-server"],
      options: { cwd: WORKDIR, shell: false },
    });
    const [first, second] = server().received;
    expect(first).toMatchObject({
      method: "initialize",
      params: { clientInfo: { name: "preston", version: packageVersion } },
    });
    expect(second).toEqual({ method: "initialized" });
  });

  test("starts a new thread, runs the turn and completes with usage", async () => {
    const script = loadFixture("turn-ok");
    const transcriptDir = mkdtempSync(path.join(tmpdir(), "preston-codex-"));
    tempDirs.push(transcriptDir);
    const transcriptPath = path.join(transcriptDir, "nested", "run.jsonl");
    const { adapter, server } = setup(script, {}, { crlf: true });

    const run = adapter.startRun(
      input({
        transcriptPath,
        mcp: { command: "preston", args: ["mcp", "--token", "t0k"], env: { A: "1" } },
      }),
    );
    const events = await collect(run);

    const threadId = threadIdOf(script);
    expect(await run.sessionId()).toBe(threadId);
    expect(events[0]).toEqual({ type: "started", at: NOW.toISOString(), sessionId: threadId });
    expect(events.at(-1)).toMatchObject({ type: "exited", code: 0 });
    expect(terminals(events)).toEqual([
      {
        type: "completed",
        at: NOW.toISOString(),
        finalText: "ok",
        usage: { inputTokens: 17826, outputTokens: 5, cachedInputTokens: 11264 },
      },
    ]);
    expect(events).toContainEqual({ type: "message", at: NOW.toISOString(), text: "ok" });

    const [start] = server().requests("thread/start");
    expect(start.params).toEqual({
      cwd: WORKDIR,
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      config: {
        "mcp_servers.preston": {
          command: "preston",
          args: ["mcp", "--token", "t0k"],
          env: { A: "1" },
        },
      },
    });
    const [turn] = server().requests("turn/start");
    expect(turn.params).toEqual({
      threadId,
      input: [{ type: "text", text: "Reply with the single word ok", text_elements: [] }],
    });
    expect(server().stdinEnded).toBe(true);

    const transcript = readFileSync(transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(transcript.some((t) => t.dir === "out" && t.msg.method === "turn/start")).toBe(true);
    expect(transcript.some((t) => t.dir === "in" && t.msg.method === "turn/completed")).toBe(true);
  });

  test("passes model and effort only when given", async () => {
    const { adapter, server } = setup(loadFixture("turn-ok"));
    await collect(adapter.startRun(input({ model: "gpt-5.6-luna", effort: "low" })));

    expect(server().requests("thread/start")[0].params.model).toBe("gpt-5.6-luna");
    expect(server().requests("turn/start")[0].params.effort).toBe("low");
  });

  test("appends Preston guidance to the user's own developer instructions", async () => {
    const { adapter, server } = setup(loadFixture("turn-ok"), {
      "config/read": (msg, s) =>
        s.send({ id: msg.id, result: { config: { developer_instructions: "User rules." } } }),
    });
    await collect(adapter.startRun(input({ appendSystemPrompt: "Use ask_preston." })));

    expect(server().requests("config/read")[0].params).toEqual({ cwd: WORKDIR });
    expect(server().requests("thread/start")[0].params.developerInstructions).toBe(
      "User rules.\n\nUse ask_preston.",
    );
  });

  test("uses only Preston guidance when the user has none or config/read fails", async () => {
    const { adapter, server } = setup(loadFixture("turn-ok"));
    await collect(adapter.startRun(input({ appendSystemPrompt: "Use ask_preston." })));

    expect(server().requests("thread/start")[0].params.developerInstructions).toBe(
      "Use ask_preston.",
    );
  });

  test("resumes the stored Session with thread/resume and counts only the new turn", async () => {
    const script = loadFixture("turn-resume");
    const threadId = threadIdOf(script);
    const { adapter, server } = setup(script);

    const run = adapter.startRun(input({ resumeSessionId: threadId }));
    const events = await collect(run);

    expect(server().requests("thread/start")).toEqual([]);
    expect(server().requests("thread/resume")[0].params).toMatchObject({
      threadId,
      cwd: WORKDIR,
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    expect(await run.sessionId()).toBe(threadId);
    // The replayed usage update for the earlier turn must not be counted.
    expect(terminals(events)).toEqual([
      expect.objectContaining({
        type: "completed",
        finalText: "done",
        usage: { inputTokens: 18053, outputTokens: 5, cachedInputTokens: 17920 },
      }),
    ]);
  });

  test("reports a Session that cannot be resumed as a non-retryable failure", async () => {
    const { adapter } = setup(loadFixture("turn-resume"), {
      "thread/resume": (msg, s) =>
        s.send({ id: msg.id, error: { code: -32600, message: "no rollout found for thread id" } }),
    });
    const events = await collect(adapter.startRun(input({ resumeSessionId: "missing-thread" })));

    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: "failed", retryable: false }),
    ]);
    expect((terminals(events)[0] as { error: string }).error).toContain("missing-thread");
    expect(types(events).at(-1)).toBe("exited");
  });

  test("marks activity as toolRunning while a command executes", async () => {
    const { adapter } = setup(loadFixture("turn-approval"));
    const events = await collect(adapter.startRun(input()));

    const activity = events.filter((e) => e.type === "activity");
    const started = activity.find((e) => e.kind === "commandExecution");
    const finished = activity.find((e) => e.kind === "commandExecution_completed");
    expect(started).toMatchObject({ toolRunning: true });
    expect(started?.summary).toContain("ls /tmp/preston-fixture/listme");
    expect(finished).toMatchObject({ toolRunning: false });
    expect(activity.indexOf(started as never)).toBeLessThan(activity.indexOf(finished as never));
  });
});

describe("access", () => {
  test("a tools-only agent gets a read-only sandbox", async () => {
    const { adapter, server } = setup(loadFixture("turn-ok"));
    await collect(adapter.startRun(input({ access: "tools_only" })));

    expect(server().requests("thread/start")[0].params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
  });

  test("a full-access agent has anything it still asks for accepted", async () => {
    const { adapter, server } = setup(loadFixture("turn-approval"));
    const events = await collect(adapter.startRun(input()));

    expect(server().received).toContainEqual({ id: 0, result: { decision: "accept" } });
    expect(server().requests("turn/steer")).toEqual([]);
    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: "completed", finalText: "done" }),
    ]);
  });

  test("a tools-only agent is declined and told why", async () => {
    const script = loadFixture("turn-approval");
    const { adapter, server } = setup(script, {
      "turn/steer": (msg, s) =>
        s.send({ id: msg.id, result: { turnId: msg.params.expectedTurnId } }),
    });
    await collect(adapter.startRun(input({ access: "tools_only" })));

    expect(server().received).toContainEqual({ id: 0, result: { decision: "decline" } });
    const [steer] = server().requests("turn/steer");
    expect(steer.params).toMatchObject({ threadId: threadIdOf(script) });
    expect(steer.params.input[0].text).toContain("Preston's own tools only");
  });

  test("answers file-change and permission requests in their own shapes", async () => {
    const script = loadFixture("turn-ok");
    const threadId = threadIdOf(script);
    const turnId = script.find((e) => e.msg.method === "turn/started")?.msg.params.turn.id;
    const scope = { threadId, turnId, startedAtMs: 1 };
    const requests = [
      {
        method: "item/fileChange/requestApproval",
        id: 7,
        params: { ...scope, itemId: "fc1", reason: null },
      },
      {
        method: "item/permissions/requestApproval",
        id: 8,
        params: {
          ...scope,
          itemId: "p1",
          cwd: "/w",
          environmentId: null,
          reason: "fetch deps",
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      },
    ];
    const full = setup(afterTurnStarted(script, requests));
    await collect(full.adapter.startRun(input()));
    expect(full.server().received).toContainEqual({ id: 7, result: { decision: "accept" } });
    expect(full.server().received).toContainEqual({
      id: 8,
      result: { permissions: { network: { enabled: true } }, scope: "turn" },
    });

    const limited = setup(afterTurnStarted(script, requests));
    await collect(limited.adapter.startRun(input({ access: "tools_only" })));
    expect(limited.server().received).toContainEqual({ id: 7, result: { decision: "decline" } });
    expect(limited.server().received).toContainEqual({
      id: 8,
      result: { permissions: {}, scope: "turn" },
    });
  });

  // Seen against codex-cli 0.169.0: every MCP tool call is preceded by this request, and
  // declining it made Preston's own tools (goal_create, report_result...) unusable.
  test("a tools-only agent may call Preston's own MCP tools and nothing else", async () => {
    const script = loadFixture("turn-ok");
    const threadId = threadIdOf(script);
    const turnId = script.find((e) => e.msg.method === "turn/started")?.msg.params.turn.id;
    const ask = (id: number, serverName: string, kind: string) => ({
      method: "mcpServer/elicitation/request",
      id,
      params: {
        threadId,
        turnId,
        serverName,
        mode: "form",
        _meta: { codex_approval_kind: kind, tool_name: "goal_create" },
        message: `Allow the ${serverName} MCP server to run tool "goal_create"?`,
        requestedSchema: { type: "object", properties: {} },
      },
    });
    const asks = [
      ask(21, "preston", "mcp_tool_call"),
      ask(22, "other-server", "mcp_tool_call"),
      ask(23, "preston", "something_else"),
    ];
    const accept = { action: "accept", content: {}, _meta: null };
    const decline = { action: "decline", content: null, _meta: null };

    const limited = setup(afterTurnStarted(script, asks));
    await collect(limited.adapter.startRun(input({ access: "tools_only" })));
    expect(limited.server().received).toContainEqual({ id: 21, result: accept });
    expect(limited.server().received).toContainEqual({ id: 22, result: decline });
    expect(limited.server().received).toContainEqual({ id: 23, result: decline });

    // A Worker may use every MCP server the user has set up.
    const full = setup(afterTurnStarted(script, asks));
    await collect(full.adapter.startRun(input()));
    expect(full.server().received).toContainEqual({ id: 21, result: accept });
    expect(full.server().received).toContainEqual({ id: 22, result: accept });
  });
});

describe("failures and quota", () => {
  test("usageLimitExceeded pauses for quota with the window's reset time", async () => {
    const { adapter } = setup(loadFixture("usage-limit"));
    const events = await collect(adapter.startRun(input()));

    expect(terminals(events)).toEqual([
      {
        type: "quota_blocked",
        at: NOW.toISOString(),
        bucket: "codex:primary",
        kind: "usage_limit",
        resetsAt: new Date(1794822000 * 1000).toISOString(),
        detail: "You've hit your usage limit. Try again later.",
      },
    ]);
    expect(types(events)).not.toContain("completed");
    expect(types(events).at(-1)).toBe("exited");
  });

  test("usageLimitExceeded without a snapshot reads rate limits token-free for the reset", async () => {
    const script = loadFixture("usage-limit").filter(
      (e) => e.msg.method !== "account/rateLimits/updated",
    );
    const limits = loadJsonFixture("rate-limits-read");
    limits.rateLimitsByLimitId.codex.secondary = {
      usedPercent: 100,
      windowDurationMins: 10080,
      resetsAt: 1795400000,
    };
    const { adapter, server } = setup(script, {
      "account/rateLimits/read": (msg, s) => s.send({ id: msg.id, result: limits }),
    });
    const events = await collect(adapter.startRun(input()));

    expect(server().requests("account/rateLimits/read")).toHaveLength(1);
    expect(terminals(events)).toEqual([
      expect.objectContaining({
        type: "quota_blocked",
        kind: "usage_limit",
        bucket: "codex:secondary",
        resetsAt: new Date(1795400000 * 1000).toISOString(),
      }),
    ]);
  });

  test("rateLimitExceeded is a rate limit, not plan usage", async () => {
    const { adapter } = setup(loadFixture("rate-limit"));
    const events = await collect(adapter.startRun(input()));

    expect(terminals(events)).toEqual([
      expect.objectContaining({
        type: "quota_blocked",
        kind: "rate_limit",
        bucket: "codex:rate_limit",
      }),
    ]);
  });

  test("an authentication failure is reported as auth_error, never quota", async () => {
    const { adapter } = setup(loadFixture("auth-failure"));
    const events = await collect(adapter.startRun(input()));

    expect(terminals(events)).toEqual([expect.objectContaining({ type: "auth_error" })]);
    expect(types(events)).not.toContain("quota_blocked");
    // Codex's own reconnect attempts show up as activity, not as failures.
    expect(
      events.filter((e) => e.type === "activity" && e.kind === "retrying").length,
    ).toBeGreaterThan(0);
  });

  test("other turn errors are failures classified by retryability", async () => {
    const script = loadFixture("rate-limit").map((e) =>
      JSON.parse(JSON.stringify(e).replaceAll('"rateLimitExceeded"', '"contextWindowExceeded"')),
    );
    const { adapter } = setup(script);
    const events = await collect(adapter.startRun(input()));

    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: "failed", retryable: false }),
    ]);
  });

  test("ignores unknown notifications and refuses unknown server requests", async () => {
    const script = afterTurnStarted(loadFixture("turn-ok"), [
      { method: "some/futureNotification", params: { threadId: "x" } },
      { method: "item/tool/requestUserInput", id: 41, params: { questions: [] } },
      { not: "a protocol message" },
    ]);
    const { adapter, server } = setup(script);
    const events = await collect(adapter.startRun(input()));

    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: "completed", finalText: "ok" }),
    ]);
    expect(server().received).toContainEqual(
      expect.objectContaining({ id: 41, error: expect.objectContaining({ code: -32601 }) }),
    );
  });

  test("an app-server crash is a retryable failure followed by exited, never completed", async () => {
    const { adapter, server } = setup(untilTurnStarted(loadFixture("turn-ok")));
    const run = adapter.startRun(input());
    const events: WorkerEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === "activity" && event.kind === "turn_started") {
        server().crash(3, "thread 'main' panicked");
      }
    }

    expect(types(events)).not.toContain("completed");
    const [failure] = terminals(events);
    expect(failure).toMatchObject({ type: "failed", retryable: true });
    expect((failure as { error: string }).error).toContain("panicked");
    expect(events.at(-1)).toMatchObject({ type: "exited", code: 3 });
  });

  test("interrupt sends turn/interrupt, ends the Run and shuts the app-server down", async () => {
    const script = loadFixture("turn-ok");
    const turnCompleted = script.find((e) => e.msg.method === "turn/completed")?.msg;
    const { adapter, server } = setup(untilTurnStarted(script), {
      "turn/interrupt": (msg, s) => {
        s.send({ id: msg.id, result: {} });
        s.send({
          ...turnCompleted,
          params: {
            ...turnCompleted.params,
            turn: { ...turnCompleted.params.turn, status: "interrupted" },
          },
        });
      },
    });
    const run = adapter.startRun(input());
    const events: WorkerEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === "activity" && event.kind === "turn_started") await run.interrupt();
    }

    const turnId = script.find((e) => e.msg.method === "turn/started")?.msg.params.turn.id;
    expect(server().requests("turn/interrupt")[0].params).toEqual({
      threadId: threadIdOf(script),
      turnId,
    });
    expect(terminals(events)).toEqual([
      expect.objectContaining({
        type: "failed",
        error: "Interrupted by Preston",
        retryable: false,
      }),
    ]);
    expect(types(events).at(-1)).toBe("exited");
    expect(server().stdinEnded).toBe(true);
  });

  test("interrupt still ends the Run when the app-server ignores it", async () => {
    const { adapter, server } = setup(
      untilTurnStarted(loadFixture("turn-ok")),
      { "turn/interrupt": () => {} },
      { exitOnStdinEnd: false },
    );
    const run = adapter.startRun(input());
    const events: WorkerEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === "activity" && event.kind === "turn_started") await run.interrupt();
    }

    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: "failed", retryable: false }),
    ]);
    expect(server().signals).toContain("SIGTERM");
    expect(types(events).at(-1)).toBe("exited");
  });

  test("spawn failure is a non-retryable failure", async () => {
    const { spawn } = fakeSpawn(() => enoent());
    const adapter = createCodexAdapter({
      executable: "codex",
      env: { PATH: "" },
      spawn,
      now: () => NOW,
    });
    const events = await collect(adapter.startRun(input()));

    expect(types(events)).toEqual(["failed", "exited"]);
    expect(events[0]).toMatchObject({ retryable: false });
    await expect(adapter.startRun(input()).sessionId()).rejects.toThrow();
  });
});

/** An app-server that only answers initialize plus the given handlers. */
function offlineServer(handlers: Record<string, Handler>) {
  const script: FixtureEntry[] = [
    { dir: "out", msg: { id: 1, method: "initialize" } },
    { dir: "in", msg: { id: 1, result: { userAgent: "preston/0.169.0" } } },
    { dir: "out", msg: { method: "initialized" } },
  ];
  return setup(script, handlers);
}

describe("readQuota", () => {
  test("maps account/rateLimits/read to one reading per window", async () => {
    const limits = loadJsonFixture("rate-limits-read");
    const { adapter, server } = offlineServer({
      "account/rateLimits/read": (msg, s) => s.send({ id: msg.id, result: limits }),
    });

    expect(await adapter.readQuota?.()).toEqual([
      {
        bucket: "codex:primary",
        available: true,
        usedPercent: 1,
        resetsAt: new Date(1795382890 * 1000).toISOString(),
        checkedAt: NOW.toISOString(),
      },
    ]);
    expect(server().stdinEnded).toBe(true);
  });

  test("reports exhausted or blocked windows as unavailable", async () => {
    const limits = loadJsonFixture("rate-limits-read");
    limits.rateLimitsByLimitId.codex.secondary = {
      usedPercent: 100,
      windowDurationMins: 300,
      resetsAt: null,
    };
    limits.rateLimitsByLimitId.gpt_luna = {
      limitId: "gpt_luna",
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1795000000 },
      secondary: null,
      rateLimitReachedType: null,
    };
    const { adapter } = offlineServer({
      "account/rateLimits/read": (msg, s) => s.send({ id: msg.id, result: limits }),
    });

    const readings = await adapter.readQuota?.();
    expect(readings?.map((r) => [r.bucket, r.available])).toEqual([
      ["codex:primary", true],
      ["codex:secondary", false],
      ["codex:gpt_luna:primary", true],
    ]);

    limits.ordinaryUsageAllowed = false;
    const blocked = await offlineServer({
      "account/rateLimits/read": (msg, s) => s.send({ id: msg.id, result: limits }),
    }).adapter.readQuota?.();
    expect(blocked?.every((r) => r.available === false)).toBe(true);
  });

  test("returns no readings when the login exposes none (API key or signed out)", async () => {
    const { adapter } = offlineServer({
      "account/rateLimits/read": (msg, s) =>
        s.send({
          id: msg.id,
          error: {
            code: -32600,
            message: "codex account authentication required to read rate limits",
          },
        }),
    });

    expect(await adapter.readQuota?.()).toEqual([]);
  });
});

describe("listModels", () => {
  test("maps model/list to models with efforts and the default", async () => {
    const models = loadJsonFixture("model-list");
    const { adapter } = offlineServer({
      "model/list": (msg, s) => s.send({ id: msg.id, result: models }),
    });

    const listed = await adapter.listModels?.();
    expect(listed?.[0]).toEqual({
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      isDefault: true,
    });
    expect(listed?.map((m) => m.id)).toContain("gpt-5.6-luna");
    expect(listed?.filter((m) => m.isDefault)).toHaveLength(1);
  });

  test("follows pagination cursors", async () => {
    const models = loadJsonFixture("model-list");
    const { adapter, server } = offlineServer({
      "model/list": (msg, s) =>
        s.send({
          id: msg.id,
          result: msg.params.cursor
            ? { data: models.data.slice(2), nextCursor: null }
            : { data: models.data.slice(0, 2), nextCursor: "page-2" },
        }),
    });

    expect(await adapter.listModels?.()).toHaveLength(models.data.length);
    expect(
      server()
        .requests("model/list")
        .map((r) => r.params),
    ).toEqual([{}, { cursor: "page-2" }]);
  });
});

type CommandResult = { stdout?: string; stderr?: string; code: number } | Error;

function commandAdapter(
  results: Record<string, CommandResult>,
  env: NodeJS.ProcessEnv = { PATH: "" },
) {
  const { spawn, calls } = fakeSpawn((args) => {
    const result = results[args.join(" ")];
    if (!result) throw new Error(`unexpected command: ${args.join(" ")}`);
    return result instanceof Error ? result : new FakeCommand(result);
  });
  return {
    adapter: createCodexAdapter({ executable: "codex", env, spawn, now: () => NOW }),
    calls,
  };
}

describe("detect", () => {
  test("reports the resolved path, version and login state", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preston-codex-bin-"));
    tempDirs.push(dir);
    const file = path.join(dir, process.platform === "win32" ? "codex.exe" : "codex");
    writeFileSync(file, "");
    chmodSync(file, 0o755);
    const { adapter, calls } = commandAdapter(
      {
        "--version": { stdout: "codex-cli 0.169.0\n", code: 0 },
        "login status": { stderr: "Logged in using ChatGPT\n", code: 0 },
      },
      { PATH: dir },
    );

    expect(await adapter.detect()).toEqual({
      installed: true,
      path: file,
      version: "0.169.0",
      loggedIn: true,
    });
    expect(calls.every((c) => c.command === file && c.options.shell === false)).toBe(true);
  });

  test("explains a missing login in plain language", async () => {
    const { adapter } = commandAdapter({
      "--version": { stdout: "codex-cli 0.169.0\n", code: 0 },
      "login status": { stderr: "Not logged in\n", code: 1 },
    });

    const detection = await adapter.detect();
    expect(detection).toMatchObject({ installed: true, loggedIn: false });
    expect(detection.problem).toContain("codex login");
  });

  test("reports a missing CLI as not installed", async () => {
    const { adapter } = commandAdapter({ "--version": enoent() });

    const detection = await adapter.detect();
    expect(detection.installed).toBe(false);
    expect(detection.problem).toContain("isn't installed");
  });
});

describe("update", () => {
  test("runs Codex's own updater non-interactively and reports both versions", async () => {
    let updated = false;
    const { spawn, calls } = fakeSpawn((args) => {
      if (args[0] === "update") {
        updated = true;
        return new FakeCommand({ stdout: "Updating Codex\n", code: 0 });
      }
      return new FakeCommand({ stdout: `codex-cli ${updated ? "0.170.0" : "0.169.0"}\n`, code: 0 });
    });
    const adapter = createCodexAdapter({ executable: "codex", env: { PATH: "" }, spawn });

    expect(await adapter.update?.()).toEqual({
      updated: true,
      fromVersion: "0.169.0",
      toVersion: "0.170.0",
      detail: "Updated Codex from 0.169.0 to 0.170.0",
    });
    expect(calls.find((c) => c.args[0] === "update")?.options.env.CODEX_NON_INTERACTIVE).toBe("1");
  });

  test("reports a failed update without claiming success", async () => {
    const { adapter } = commandAdapter({
      "--version": { stdout: "codex-cli 0.169.0\n", code: 0 },
      update: { stderr: "network unreachable\n", code: 1 },
    });

    const result = await adapter.update?.();
    expect(result).toMatchObject({ updated: false, fromVersion: "0.169.0", toVersion: "0.169.0" });
    expect(result?.detail).toContain("network unreachable");
  });
});
