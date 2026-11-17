import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeChannel } from "../src/channels/fake/index.js";
import { ManualClock } from "../src/clock.js";
import type { FakeScript, FakeTurn } from "../src/workers/fake/index.js";
import {
  finishedGoal,
  goalCreatingCoordinator,
  ownerMessage,
  startPreston,
  tempDir,
  waitFor,
} from "./support/harness.js";

/** Config with the Coordinator given its normal three minutes to speak about a finished Goal. */
const CONFIG = {
  agents: { enabled: ["fake" as const] },
  coordinator: { agent: "fake" as const },
  outbox: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 5 },
  setup: { complete: true },
};

const picture = () => {
  const dir = mkdtempSync(join(tmpdir(), "preston-outcome-"));
  const path = join(dir, "puppy.png");
  writeFileSync(path, "PNG");
  return path;
};

/** The worker reports the Goal done and hands in `file`. */
const workerWith =
  (file?: string): FakeScript =>
  async (turn) => {
    await turn.callTool("report_result", {
      summary: "Drew a puppy.",
      checksPerformed: ["looked at it"],
      ...(file ? { deliverables: [file] } : {}),
    });
    return "Done.";
  };

const isOutcomeEvent = (turn: FakeTurn) => turn.input.prompt.includes('event="goal-ended"');
const eventGoal = (turn: FakeTurn) => /goal="(g-[^"]+)"/.exec(turn.input.prompt)?.[1] ?? "";

/** A Coordinator that creates a Goal on "go" and answers the end of it with `onOutcome`. */
function coordinatorThat(
  project: string,
  onOutcome: (turn: FakeTurn, goalId: string) => Promise<unknown>,
  prompts: string[] = [],
): FakeScript {
  const creating = goalCreatingCoordinator(project);
  return async (turn) => {
    if (isOutcomeEvent(turn)) {
      prompts.push(turn.input.prompt);
      await onOutcome(turn, eventGoal(turn));
      return "";
    }
    return creating(turn);
  };
}

async function finished(p: Awaited<ReturnType<typeof startPreston>>) {
  // Verification runs real commands, so wait for it in real time.
  await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });
}

describe("who tells the user a Goal ended", () => {
  test("the Coordinator tells them in its own words, and Preston's standard message is withdrawn", async () => {
    const file = picture();
    const prompts: string[] = [];
    const channel = new FakeChannel();
    const clock = new ManualClock();
    const p = await startPreston({
      clock,
      channels: [channel],
      config: CONFIG,
      scenario: {
        coordinator: coordinatorThat(
          tempDir("project"),
          (turn, goalId) =>
            turn.callTool("notify_user", { goalId, text: "小狗画好啦！", paths: [file] }),
          prompts,
        ),
        worker: workerWith(file),
      },
    });
    channel.receive("go");
    await finished(p);
    await waitFor(() => channel.texts("notice").length === 1, {
      what: "the Coordinator's message",
    });
    await clock.advance(10 * 60_000);

    const notice = channel.sent.find((m) => m.kind === "notice");
    expect(notice).toMatchObject({
      text: "小狗画好啦！",
      files: [{ path: file, name: "puppy.png" }],
    });
    // Preston's own "Done and verified" never goes out, and there is no "On it" either.
    expect(channel.texts("outcome")).toEqual([]);
    expect(channel.texts("ack")).toEqual([]);
    expect(prompts[0]).toContain("verified");
    expect(prompts[0]).toContain(file);
    expect(prompts[0]).toContain("Drew a puppy.");
    expect(prompts[0]).toContain("Done and verified");
  });

  test("if the Coordinator says nothing, Preston's standard message goes out after the wait", async () => {
    const channel = new FakeChannel();
    const clock = new ManualClock();
    const p = await startPreston({
      clock,
      channels: [channel],
      config: CONFIG,
      scenario: {
        coordinator: coordinatorThat(tempDir("project"), async () => undefined),
        worker: workerWith(),
      },
    });
    channel.receive("go");
    await finished(p);
    await clock.advance(2 * 60_000);
    expect(channel.texts("outcome")).toEqual([]);

    await clock.advance(61_000);
    await waitFor(() => channel.texts("outcome").length === 1, { what: "the fallback message" });
    expect(channel.texts("outcome")[0]).toContain("Done and verified");
  });

  test("the Coordinator can stay silent on purpose", async () => {
    const channel = new FakeChannel();
    const clock = new ManualClock();
    const p = await startPreston({
      clock,
      channels: [channel],
      config: CONFIG,
      scenario: {
        coordinator: coordinatorThat(tempDir("project"), (turn, goalId) =>
          turn.callTool("notify_user", { goalId }),
        ),
        worker: workerWith(),
      },
    });
    channel.receive("go");
    await finished(p);
    await clock.advance(30 * 60_000);
    expect(channel.texts("outcome")).toEqual([]);
    expect(channel.texts("notice")).toEqual([]);
    // The result is still there for when the user asks.
    expect(p.rt.goals()[0]).toMatchObject({ state: "completed", outcome: "verified" });
  });

  test("a message held until morning waits, and nothing behind it is held back", async () => {
    const channel = new FakeChannel();
    const clock = new ManualClock();
    const morning = new Date(clock.now() + 9 * 3_600_000).toISOString();
    const p = await startPreston({
      clock,
      channels: [channel],
      config: CONFIG,
      scenario: {
        coordinator: coordinatorThat(tempDir("project"), (turn, goalId) =>
          turn.callTool("notify_user", {
            goalId,
            text: "Good morning! The puppy is done.",
            holdUntil: morning,
          }),
        ),
        worker: workerWith(),
      },
    });
    channel.receive("go");
    await finished(p);
    await waitFor(() => p.rt.coordinatorBusy() === false, { what: "the Coordinator to finish" });
    await clock.advance(60 * 60_000);
    expect(channel.texts("notice")).toEqual([]);

    // Other messages still get through while that one waits.
    channel.receive("status");
    await waitFor(() => channel.texts("reply").some((t) => t.includes("Recent results")), {
      what: "a reply during the quiet time",
    });
    expect(channel.texts("notice")).toEqual([]);

    await clock.advance(9 * 3_600_000);
    await waitFor(() => channel.texts("notice").length === 1, { what: "the morning message" });
    expect(channel.texts("notice")[0]).toBe("Good morning! The puppy is done.");
    expect(channel.texts("outcome")).toEqual([]);
  });

  test("with the wait set to 0, Preston's own message goes out at once and the Coordinator is not asked", async () => {
    const prompts: string[] = [];
    const channel = new FakeChannel();
    const p = await startPreston({
      channels: [channel],
      config: { ...CONFIG, outcomes: { coordinatorWaitMs: 0 } },
      scenario: {
        coordinator: coordinatorThat(tempDir("project"), async () => undefined, prompts),
        worker: workerWith(),
      },
    });
    channel.receive("go");
    await finished(p);
    await waitFor(() => channel.texts("outcome").length === 1, { what: "Preston's message" });
    expect(prompts).toEqual([]);
  });
});

describe("notify_user", () => {
  async function tool(input: Record<string, unknown>) {
    const results: string[] = [];
    const channel = new FakeChannel();
    await startPreston({
      channels: [channel],
      scenario: {
        coordinator: async (turn: FakeTurn) => {
          if (!ownerMessage(turn)) return "";
          try {
            results.push(await turn.callTool("notify_user", input));
          } catch (err) {
            results.push(`error: ${(err as Error).message}`);
          }
          return "ok";
        },
      },
    });
    channel.receive("do it");
    await waitFor(() => results.length === 1, { what: "notify_user" });
    return { result: results[0] as string, channel };
  }

  test("a plain message goes to the conversation being answered", async () => {
    const { result, channel } = await tool({ text: "Heads up." });
    expect(JSON.parse(result)).toMatchObject({ queued: true });
    await waitFor(() => channel.texts("notice").includes("Heads up."), { what: "the notice" });
  });

  test("it needs something to say, a real Goal, a sensible hold and a message for files", async () => {
    expect((await tool({})).result).toMatch(/^error: Give the text to send/);
    expect((await tool({ goalId: "g-nope", text: "x" })).result).toBe(
      "error: There is no Goal g-nope.",
    );
    const far = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
    expect((await tool({ text: "x", holdUntil: far })).result).toMatch(/more than 7 days/);
    expect((await tool({ paths: ["/tmp/x"], goalId: "g-1" })).result).toMatch(
      /Files need a message/,
    );
  });
});
