import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type ClaudeAdapterOptions,
  createClaudeAdapter,
} from "../../../src/workers/claude/index.js";
import type { RunHandle, StartRunInput, WorkerEvent } from "../../../src/workers/types.js";
import { argValue, fakeSpawn, fixtureLines, type Script } from "./fake-spawn.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preston-claude-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real file standing in for the `claude` executable, so resolution succeeds. */
function fakeExecutable(name = "claude"): string {
  const path = join(tempDir(), name);
  writeFileSync(path, "");
  chmodSync(path, 0o755);
  return path;
}

function adapterFor(
  handler: (args: readonly string[], command: string) => Script,
  extra: Partial<ClaudeAdapterOptions> = {},
) {
  const fake = fakeSpawn(handler);
  const adapter = createClaudeAdapter({
    executable: fakeExecutable(),
    env: {},
    platform: "linux",
    spawn: fake.spawn,
    ...extra,
  });
  return { adapter, calls: fake.calls };
}

function runInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    runId: "run-1",
    workdir: "/work/project",
    prompt: "Reply with the single word ok",
    access: "full",
    ...overrides,
  };
}

async function collect(handle: RunHandle): Promise<WorkerEvent[]> {
  const events: WorkerEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

const types = (events: WorkerEvent[]) => events.map((e) => e.type);
const find = <T extends WorkerEvent["type"]>(events: WorkerEvent[], type: T) =>
  events.find((e): e is Extract<WorkerEvent, { type: T }> => e.type === type);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("Claude Code adapter: runs", () => {
  test("completes a recorded run and reports text, usage and the Session ID", async () => {
    const { adapter, calls } = adapterFor(() => ({ lines: fixtureLines("recorded-simple.jsonl") }));
    const handle = adapter.startRun(runInput());
    const events = await collect(handle);

    expect(types(events)).toEqual(["started", "message", "completed", "exited"]);
    const completed = find(events, "completed");
    expect(completed?.finalText).toBe("ok");
    expect(completed?.usage?.outputTokens).toBe(4);
    expect(completed?.usage?.inputTokens).toBe(2 + 22961);
    expect(completed?.usage?.costUsd).toBeCloseTo(0.0045944);
    expect(find(events, "exited")).toMatchObject({ code: 0 });

    const call = calls[0];
    expect(call?.args.slice(0, 6)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    const sessionId = argValue(call?.args ?? [], "--session-id");
    expect(sessionId).toMatch(UUID);
    expect(call?.args).not.toContain("--resume");
    expect(await handle.sessionId()).toBe(sessionId);
    expect(find(events, "started")?.sessionId).toBe(sessionId);
    expect(call?.options.cwd).toBe("/work/project");
    expect(call?.child.stdinMessages[0]).toEqual({
      type: "user",
      message: { role: "user", content: "Reply with the single word ok" },
    });
    expect(call?.child.stdinEnded).toBe(true);
  });

  test("inherits the user's model and effort unless they are given", async () => {
    const { adapter, calls } = adapterFor(() => ({ lines: fixtureLines("recorded-simple.jsonl") }));
    await collect(adapter.startRun(runInput()));
    await collect(adapter.startRun(runInput({ model: "sonnet", effort: "high" })));

    expect(calls[0]?.args).not.toContain("--model");
    expect(calls[0]?.args).not.toContain("--effort");
    expect(argValue(calls[1]?.args ?? [], "--model")).toBe("sonnet");
    expect(argValue(calls[1]?.args ?? [], "--effort")).toBe("high");
  });

  test("launches Preston's MCP server, keeping the user's servers", async () => {
    const { adapter, calls } = adapterFor(() => ({ lines: fixtureLines("recorded-simple.jsonl") }));
    await collect(
      adapter.startRun(
        runInput({
          appendSystemPrompt: "You are a Preston Worker.\nReport with report_result.",
          mcp: {
            command: "/usr/bin/node",
            args: ["/opt/preston/cli.js", "mcp", "--token", "t-1"],
            env: { A: "1" },
          },
        }),
      ),
    );
    const call = calls[0];
    const args = call?.args ?? [];
    expect(args).not.toContain("--strict-mcp-config");
    expect(args.join(" ")).not.toContain("t-1");
    expect(JSON.parse(call?.files["--mcp-config"] ?? "{}")).toEqual({
      mcpServers: {
        preston: {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/opt/preston/cli.js", "mcp", "--token", "t-1"],
          env: { A: "1" },
        },
      },
    });
    expect(call?.files["--append-system-prompt-file"]).toBe(
      "You are a Preston Worker.\nReport with report_result.",
    );
  });

  test("a Worker runs with every permission check bypassed", async () => {
    const { adapter, calls } = adapterFor(() => ({ lines: fixtureLines("recorded-simple.jsonl") }));
    await collect(adapter.startRun(runInput()));
    const args = calls[0]?.args ?? [];
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-prompts");
    expect(args).not.toContain("--permission-prompt-tool");
  });

  test("a tools-only agent has no built-in tools, whatever the user's own rules allow", async () => {
    const { adapter, calls } = adapterFor(() => ({ lines: fixtureLines("recorded-simple.jsonl") }));
    await collect(adapter.startRun(runInput({ access: "tools_only" })));
    const args = calls[0]?.args ?? [];
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(argValue(args, "--tools")).toBe("");
    expect(argValue(args, "--permission-prompts")).toBe("none");
    expect(argValue(args, "--allowedTools")).toBe("mcp__preston");
  });

  test("reports tool activity while a tool runs and when it finishes", async () => {
    const { adapter } = adapterFor(() => ({ lines: fixtureLines("recorded-tool.jsonl") }));
    const events = await collect(adapter.startRun(runInput()));

    const activity = events.filter((e) => e.type === "activity");
    expect(activity).toEqual([
      expect.objectContaining({ kind: "tool_use", toolRunning: true, summary: "Bash: ls" }),
      expect.objectContaining({
        kind: "tool_result",
        toolRunning: false,
        summary: "Bash finished",
      }),
    ]);
    expect(types(events)).toEqual([
      "started",
      "activity",
      "activity",
      "message",
      "completed",
      "exited",
    ]);
    expect(find(events, "completed")?.finalText).toBe("a.txt\nb.txt");
  });

  test("resumes a Session by ID from the same working directory", async () => {
    const { adapter, calls } = adapterFor(() => ({ lines: fixtureLines("recorded-resume.jsonl") }));
    const sessionId = "22222222-3333-4444-8555-666666666666";
    const handle = adapter.startRun(
      runInput({ resumeSessionId: sessionId, workdir: "/work/project" }),
    );
    const events = await collect(handle);

    expect(argValue(calls[0]?.args ?? [], "--resume")).toBe(sessionId);
    expect(calls[0]?.args).not.toContain("--session-id");
    expect(calls[0]?.options.cwd).toBe("/work/project");
    expect(await handle.sessionId()).toBe(sessionId);
    expect(find(events, "completed")?.finalText).toBe("2");
  });

  test("writes the raw stdout transcript", async () => {
    const { adapter, calls } = adapterFor(() => ({ lines: fixtureLines("recorded-tool.jsonl") }));
    const transcriptPath = join(tempDir(), "transcripts", "run-1.jsonl");
    await collect(adapter.startRun(runInput({ transcriptPath })));
    expect(readFileSync(transcriptPath, "utf8")).toBe(calls[0]?.child.stdoutText);
  });

  test("ignores malformed and unknown lines and copes with CRLF and split chunks", async () => {
    const recorded = fixtureLines("recorded-simple.jsonl");
    const lines = [
      "not json at all",
      "{broken",
      "[1,2,3]",
      "null",
      '{"type":"brand_new_event","payload":{"x":1}}',
      '{"type":"brand_new_event","note":"multi-byte · résumé split across chunks"}',
      '{"type":"system","subtype":"future_subtype"}',
      ...recorded.slice(0, 2),
      '{"type":"assistant","message":"unexpected shape"}',
      '{"type":"user","message":{"content":"plain text"}}',
      ...recorded.slice(2),
    ];
    const { adapter } = adapterFor(() => ({ lines, eol: "\r\n", chunkBytes: 7 }));
    const events = await collect(adapter.startRun(runInput()));
    expect(types(events)).toEqual(["started", "message", "completed", "exited"]);
    expect(find(events, "completed")?.finalText).toBe("ok");
  });

  test("a crash before a result is a retryable failure, never a completion", async () => {
    const lines = fixtureLines("recorded-tool.jsonl").slice(0, 2);
    const { adapter } = adapterFor(() => ({ lines, code: 1, stderr: "Segmentation fault\n" }));
    const handle = adapter.startRun(runInput());
    const events = await collect(handle);

    expect(types(events)).toEqual(["started", "activity", "failed", "exited"]);
    expect(find(events, "failed")).toMatchObject({ retryable: true });
    expect(find(events, "failed")?.error).toContain("Segmentation fault");
    expect(find(events, "exited")).toMatchObject({ code: 1 });
  });

  test("a process that fails to start yields failed and exited, and no Session ID", async () => {
    const adapter = createClaudeAdapter({
      executable: fakeExecutable(),
      env: {},
      platform: "linux",
      spawn: () => {
        throw new Error("spawn EACCES");
      },
    });
    const handle = adapter.startRun(runInput());
    const events = await collect(handle);
    expect(types(events)).toEqual(["failed", "exited"]);
    expect(find(events, "failed")).toMatchObject({ retryable: false });
    await expect(handle.sessionId()).rejects.toThrow();
  });

  test("a missing CLI yields failed and exited", async () => {
    const adapter = createClaudeAdapter({
      env: { PATH: tempDir(), HOME: tempDir() },
      platform: "linux",
    });
    const events = await collect(adapter.startRun(runInput()));
    expect(types(events)).toEqual(["failed", "exited"]);
    expect(find(events, "failed")?.error).toMatch(/isn't installed/);
  });
});

describe("Claude Code adapter: quota and auth", () => {
  test("a subscription usage limit pauses with the bucket and reset time", async () => {
    const { adapter } = adapterFor(() => ({
      lines: fixtureLines("synthetic-usage-limit.jsonl"),
      code: 1,
    }));
    const events = await collect(adapter.startRun(runInput()));

    expect(types(events)).toEqual(["started", "quota_blocked", "exited"]);
    expect(find(events, "quota_blocked")).toMatchObject({
      kind: "usage_limit",
      bucket: "claude:five_hour",
      resetsAt: "2026-11-16T07:30:00.000Z",
    });
  });

  test("a usage limit known only from its text still gets a reset time", async () => {
    const now = new Date(2026, 10, 18, 10, 0); // Wednesday, local time
    const { adapter } = adapterFor(
      () => ({ lines: fixtureLines("synthetic-usage-limit-text-only.jsonl"), code: 1 }),
      { now: () => now },
    );
    const events = await collect(adapter.startRun(runInput()));
    expect(find(events, "quota_blocked")).toMatchObject({
      kind: "usage_limit",
      bucket: "claude:seven_day",
      resetsAt: new Date(2026, 10, 23, 0, 0).toISOString(), // the next Monday, 12:00am local
    });
  });

  test("transient API rate limiting is a retryable failure, not a usage limit", async () => {
    const { adapter } = adapterFor(() => ({
      lines: fixtureLines("synthetic-transient-429.jsonl"),
      code: 1,
    }));
    const events = await collect(adapter.startRun(runInput()));

    expect(find(events, "quota_blocked")).toBeUndefined();
    expect(find(events, "failed")).toMatchObject({ retryable: true });
    expect(find(events, "failed")?.error).toContain("429");
    const retries = events.filter((e) => e.type === "activity" && e.kind === "api_retry");
    expect(retries).toHaveLength(2);
    expect(types(events).slice(-2)).toEqual(["failed", "exited"]);
  });

  test("a logged-out CLI is an auth error, not quota (recorded)", async () => {
    const { adapter } = adapterFor(() => ({
      lines: fixtureLines("recorded-not-logged-in.jsonl"),
      code: 1,
    }));
    const events = await collect(adapter.startRun(runInput()));

    expect(types(events)).toEqual(["started", "auth_error", "exited"]);
    expect(find(events, "auth_error")?.detail).toBe("Not logged in · Please run /login");
  });

  test("an expired login is an auth error, not quota", async () => {
    const { adapter } = adapterFor(() => ({
      lines: fixtureLines("synthetic-auth-expired.jsonl"),
      code: 1,
    }));
    const events = await collect(adapter.startRun(runInput()));
    expect(types(events)).toEqual(["started", "auth_error", "exited"]);
    expect(find(events, "auth_error")?.detail).toContain("OAuth token has expired");
  });

  test("reads plan quota token-free through /usage", async () => {
    const { adapter, calls } = adapterFor(() => ({ lines: fixtureLines("recorded-usage.jsonl") }), {
      now: () => new Date("2026-11-16T05:43:46.000Z"),
    });
    const readings = await adapter.readQuota?.();

    expect(calls[0]?.args).toContain("--no-session-persistence");
    expect(calls[0]?.child.stdinMessages[0]).toEqual({
      type: "user",
      message: { role: "user", content: "/usage" },
    });
    expect(readings).toEqual([
      {
        bucket: "claude:five_hour",
        available: true,
        usedPercent: 40,
        resetsAt: "2026-11-16T07:30:00.040Z",
        checkedAt: "2026-11-16T05:43:46.000Z",
      },
      {
        bucket: "claude:seven_day",
        available: true,
        usedPercent: 9,
        resetsAt: "2026-11-20T23:00:00.040Z",
        checkedAt: "2026-11-16T05:43:46.000Z",
      },
      {
        bucket: "claude:seven_day_fable",
        available: true,
        usedPercent: 0,
        resetsAt: "2026-11-20T23:00:00.000Z",
        checkedAt: "2026-11-16T05:43:46.000Z",
      },
    ]);
  });

  test("a quota read while logged out fails instead of reporting quota", async () => {
    const { adapter } = adapterFor(() => ({
      lines: fixtureLines("recorded-not-logged-in.jsonl"),
      code: 1,
    }));
    await expect(adapter.readQuota?.()).rejects.toThrow(/not signed in/);
  });
});

describe("Claude Code adapter: interrupt", () => {
  test("interrupts gracefully and ends the event stream", async () => {
    const lines = fixtureLines("recorded-tool.jsonl").slice(0, 2);
    const { adapter, calls } = adapterFor(() => ({ lines, hold: true }));
    const handle = adapter.startRun(runInput());
    const iterator = handle.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    expect((await iterator.next()).value).toMatchObject({ type: "activity", toolRunning: true });

    await handle.interrupt();
    const rest: WorkerEvent[] = [];
    for (let r = await iterator.next(); !r.done; r = await iterator.next()) rest.push(r.value);

    const child = calls[0]?.child;
    expect(child?.stdinMessages[1]).toMatchObject({
      type: "control_request",
      request: { subtype: "interrupt" },
    });
    expect(child?.stdinEnded).toBe(true);
    expect(child?.kills).toEqual(["SIGINT"]);
    expect(types(rest)).toEqual(["failed", "exited"]);
    expect(find(rest, "completed")).toBeUndefined();
  });

  test("kills the process if it ignores the graceful interrupt", async () => {
    const lines = fixtureLines("recorded-tool.jsonl").slice(0, 2);
    const { adapter, calls } = adapterFor(() => ({ lines, hold: true, ignoreSigint: true }), {
      interruptGraceMs: 20,
    });
    const handle = adapter.startRun(runInput());
    await handle.sessionId();
    await handle.interrupt();
    const events = await collect(handle);
    expect(calls[0]?.child.kills).toEqual(["SIGINT", "SIGKILL"]);
    expect(types(events).slice(-2)).toEqual(["failed", "exited"]);
  });

  test("on Windows, skips signals and kills the process tree after the grace period", async () => {
    const lines = fixtureLines("recorded-tool.jsonl").slice(0, 2);
    let held: { kill(signal?: NodeJS.Signals): boolean } | undefined;
    const fake = fakeSpawn((_args, command) =>
      command === "taskkill" ? {} : { lines, hold: true, ignoreSigint: true },
    );
    const adapter = createClaudeAdapter({
      executable: fakeExecutable("claude.exe"),
      env: {},
      platform: "win32",
      interruptGraceMs: 20,
      spawn: (command, args, options) => {
        const child = fake.spawn(command, args, options);
        if (command === "taskkill") held?.kill();
        else held = child;
        return child;
      },
    });
    const handle = adapter.startRun(runInput());
    await handle.sessionId();
    await handle.interrupt();
    const events = await collect(handle);

    const taskkill = fake.calls.find((c) => c.command === "taskkill");
    expect(taskkill?.args).toEqual(["/pid", "4242", "/T", "/F"]);
    expect(fake.calls[0]?.child.kills).not.toContain("SIGINT");
    expect(types(events).slice(-2)).toEqual(["failed", "exited"]);
  });
});

describe("Claude Code adapter: Windows launch", () => {
  test("runs an npm .cmd shim through cmd.exe with escaped arguments", async () => {
    const { adapter, calls } = adapterFor(
      () => ({ lines: fixtureLines("recorded-simple.jsonl") }),
      {
        executable: fakeExecutable("claude.cmd"),
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      },
    );
    const events = await collect(
      adapter.startRun(
        runInput({ model: "claude-sonnet & echo pwned", appendSystemPrompt: "line one\nline two" }),
      ),
    );

    const call = calls[0];
    expect(call?.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(call?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(call?.options.windowsVerbatimArguments).toBe(true);
    const line = call?.args[3] ?? "";
    // Quoted, then metacharacters escaped twice because the shim re-parses its arguments.
    expect(line).toContain('^^^"-p^^^"');
    expect(line).toContain("^&");
    expect(line).not.toMatch(/[^^]&/);
    expect(line).not.toContain("\n");
    expect(find(events, "completed")?.finalText).toBe("ok");
  });

  test("prefers the native claude.exe and falls back to the npm claude.cmd on PATH", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "claude.cmd"), "");
    const version = () => ({ lines: ["2.1.325 (Claude Code)"] });
    const detectWith = () =>
      createClaudeAdapter({
        env: { Path: dir },
        platform: "win32",
        spawn: fakeSpawn(version).spawn,
      }).detect();

    expect((await detectWith()).path).toBe(join(dir, "claude.cmd"));
    writeFileSync(join(dir, "claude.exe"), "");
    expect((await detectWith()).path).toBe(join(dir, "claude.exe"));
  });
});

describe("Claude Code adapter: detect and update", () => {
  const statusOut = (loggedIn: boolean) =>
    JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? "claude.ai" : "none",
      email: "someone@example.com",
    });

  test("detects an installed, signed-in CLI", async () => {
    const { adapter, calls } = adapterFor((args) =>
      args.includes("--version")
        ? { lines: ["2.1.325 (Claude Code)"] }
        : { lines: [statusOut(true)] },
    );
    const detection = await adapter.detect();
    expect(detection).toMatchObject({ installed: true, version: "2.1.325", loggedIn: true });
    expect(detection.problem).toBeUndefined();
    expect(JSON.stringify(detection)).not.toContain("example.com");
    expect(calls.map((c) => c.args)).toEqual([["--version"], ["auth", "status", "--json"]]);
  });

  test("reports a signed-out CLI in plain language", async () => {
    const { adapter } = adapterFor((args) =>
      args.includes("--version")
        ? { lines: ["2.1.325 (Claude Code)"] }
        : { lines: [statusOut(false)], code: 1 },
    );
    const detection = await adapter.detect();
    expect(detection).toMatchObject({ installed: true, loggedIn: false });
    expect(detection.problem).toMatch(/not signed in/);
  });

  test("reports unknown login state when it cannot be checked", async () => {
    const { adapter } = adapterFor((args) =>
      args.includes("--version")
        ? { lines: ["2.1.325 (Claude Code)"] }
        : { lines: [], stderr: "error: unknown command 'auth'", code: 1 },
    );
    expect(await adapter.detect()).toMatchObject({ installed: true, loggedIn: "unknown" });
  });

  test("reports a missing CLI", async () => {
    const adapter = createClaudeAdapter({
      env: { PATH: tempDir(), HOME: tempDir() },
      platform: "linux",
    });
    const detection = await adapter.detect();
    expect(detection.installed).toBe(false);
    expect(detection.problem).toMatch(/isn't installed/);
  });

  test("updates with Claude Code's own updater and reports the versions", async () => {
    let current = "2.1.325";
    const { adapter, calls } = adapterFor((args) => {
      if (args[0] === "update") {
        current = "2.1.330";
        return { lines: ["Successfully updated from 2.1.325 to version 2.1.330"] };
      }
      return { lines: [`${current} (Claude Code)`] };
    });
    const result = await adapter.update?.();
    expect(calls.map((c) => c.args[0])).toEqual(["--version", "update", "--version"]);
    expect(result).toMatchObject({ updated: true, fromVersion: "2.1.325", toVersion: "2.1.330" });
  });

  test("reports a failed update without claiming success", async () => {
    const { adapter } = adapterFor((args) =>
      args[0] === "update"
        ? { lines: [], stderr: "Update failed: permission denied", code: 1 }
        : { lines: ["2.1.325 (Claude Code)"] },
    );
    const result = await adapter.update?.();
    expect(result).toMatchObject({ updated: false, fromVersion: "2.1.325", toVersion: "2.1.325" });
    expect(result?.detail).toContain("permission denied");
  });
});
