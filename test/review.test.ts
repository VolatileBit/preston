import { describe, expect, test } from "vitest";
import { FakeChannel } from "../src/channels/fake/index.js";
import { ManualClock } from "../src/clock.js";
import type { Goal, Run, Verification } from "../src/goals/store.js";
import { buildDigest, renderDigest, similarGroups } from "../src/review/digest.js";
import type { FakeScript, FakeTurn } from "../src/workers/fake/index.js";
import {
  brief,
  finishedGoal,
  ownerMessage,
  startPreston,
  tempDir,
  waitFor,
} from "./support/harness.js";

const DAY = 24 * 3_600_000;

const CONFIG = {
  agents: { enabled: ["fake" as const] },
  coordinator: { agent: "fake" as const },
  outbox: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 5 },
  outcomes: { coordinatorWaitMs: 0 },
  review: { enabled: true },
  setup: { complete: true },
};

const goal = (id: string, objective: string, extra: Partial<Goal> = {}): Goal => ({
  id,
  projectId: "p-1",
  projectPath: "/work/site",
  parentGoalId: null,
  state: "completed",
  outcome: "verified",
  brief: { objective, scope: "", acceptanceCriteria: [], checks: [] } as unknown as Goal["brief"],
  detail: null,
  origin: null,
  wakeAt: null,
  attempts: [],
  agentChoice: null,
  createdAt: "2026-11-16T09:00:00.000Z",
  updatedAt: "2026-11-16T10:00:00.000Z",
  endedAt: "2026-11-16T10:00:00.000Z",
  ...extra,
});

const run = (extra: Partial<Run> = {}): Run =>
  ({
    id: "r-1",
    goalId: "g-1",
    stalls: 0,
    recoveries: 0,
    fixAttempts: 0,
    transcriptDir: "/home/.preston/transcripts/r-1",
    ...extra,
  }) as Run;

const WINDOW = [Date.parse("2026-11-16T00:00:00Z"), Date.parse("2026-11-17T00:00:00Z")] as const;

describe("the digest", () => {
  test("a quiet period has no findings", () => {
    const digest = buildDigest(
      {
        goals: [goal("g-1", "Add a contact page to the website")],
        runs: () => [run()],
        verifications: () => [],
        questions: [],
      },
      ...WINDOW,
    );
    expect(digest).toMatchObject({ goals: 1, verified: 1, findings: [] });
    expect(renderDigest(digest)).toContain("Nothing notable");
  });

  test("it names failures, stalls, failed checks and where the transcripts are", () => {
    const failing = { passed: false, command: "npm test", outputTail: "2 failed" };
    const digest = buildDigest(
      {
        goals: [
          goal("g-1", "Fix the login bug", {
            state: "blocked",
            outcome: null,
            detail: "needs a key",
          }),
          goal("g-2", "Update the docs for the API", { outcome: "unverified" }),
          goal("g-3", "Speed up the build", {
            attempts: [
              {
                at: "",
                runId: "r-3",
                agent: "claude",
                tactic: "switch_agent",
                reason: "kept stalling",
              },
            ],
          }),
        ],
        runs: (id) => [
          run({
            id: `r-${id}`,
            stalls: id === "g-3" ? 2 : 0,
            transcriptDir: `/home/.preston/transcripts/r-${id}`,
          }),
        ],
        verifications: (id) =>
          id === "g-1" ? [{ results: [failing, failing] } as unknown as Verification] : [],
        questions: [],
      },
      ...WINDOW,
    );
    const kinds = digest.findings.map((f) => f.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["not_finished", "unverified", "struggle", "failed_checks"]),
    );
    const text = renderDigest(digest);
    expect(text).toContain("needs a key");
    expect(text).toContain("stalled 2×");
    expect(text).toContain("switch_agent");
    expect(text).toContain("npm test");
    expect(text).toContain("/home/.preston/transcripts/r-g-3");
  });

  test("work outside the period is left out", () => {
    const old = goal("g-9", "Old thing", {
      state: "failed",
      updatedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T00:00:00.000Z",
    });
    const digest = buildDigest(
      { goals: [old], runs: () => [], verifications: () => [], questions: [] },
      ...WINDOW,
    );
    expect(digest.goals).toBe(0);
    expect(digest.findings).toEqual([]);
  });

  test("requests that come back are grouped", () => {
    const groups = similarGroups([
      goal("g-1", "Deploy the marketing website to staging"),
      goal("g-2", "Deploy the marketing website to staging again"),
      goal("g-3", "Draw a picture of a sleeping puppy"),
    ]);
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([["g-1", "g-2"]]);
  });
});

/** A Coordinator that notices the daily review and suggests something, and answers a question about it. */
function reviewingCoordinator(seen: string[], tool: string[] = []): FakeScript {
  return async (turn: FakeTurn) => {
    if (turn.input.prompt.includes('event="daily-review"')) {
      seen.push(turn.input.prompt);
      await turn.callTool("notify_user", {
        text: "Your builds keep stalling. Want a standing order to check the lockfile first?",
      });
      return "";
    }
    if (ownerMessage(turn) === "go") {
      await turn.callTool("goal_create", {
        projectPath: tempDir("project"),
        brief: brief({ checks: [] }),
      });
      return "Started.";
    }
    if (ownerMessage(turn) === "how did it go") {
      tool.push(await turn.callTool("activity_review", { days: 1 }));
      return "Here is how it went.";
    }
    return "";
  };
}

const reportingWithoutChecks: FakeScript = async (turn) => {
  await turn.callTool("report_result", { summary: "Did it.", checksPerformed: [] });
  return "Done.";
};

describe("the daily review", () => {
  test("it wakes the Coordinator when something notable happened, and the user is told", async () => {
    const seen: string[] = [];
    const channel = new FakeChannel();
    const clock = new ManualClock();
    const p = await startPreston({
      clock,
      channels: [channel],
      config: CONFIG,
      scenario: { coordinator: reviewingCoordinator(seen), worker: reportingWithoutChecks },
    });
    channel.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });
    await clock.advance(DAY + 60_000);
    await waitFor(() => seen.length === 1, { what: "the review turn" });

    expect(seen[0]).toContain("could not be checked");
    expect(seen[0]).toContain("Make the greeting page say hello");
    await waitFor(() => channel.texts("notice").some((t) => t.includes("stalling")), {
      what: "the suggestion to reach the user",
    });
  });

  test("a quiet day costs no Coordinator turn", async () => {
    const seen: string[] = [];
    const clock = new ManualClock();
    const p = await startPreston({
      clock,
      config: CONFIG,
      scenario: { coordinator: reviewingCoordinator(seen) },
    });
    await clock.advance(2 * DAY);
    expect(seen).toEqual([]);
    await p.stop();
  });

  test("it can be switched off", async () => {
    const seen: string[] = [];
    const channel = new FakeChannel();
    const clock = new ManualClock();
    const p = await startPreston({
      clock,
      channels: [channel],
      config: { ...CONFIG, review: { enabled: false } },
      scenario: { coordinator: reviewingCoordinator(seen), worker: reportingWithoutChecks },
    });
    channel.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });
    await clock.advance(3 * DAY);
    expect(seen).toEqual([]);
  });

  test("the user can ask how things went", async () => {
    const tool: string[] = [];
    const channel = new FakeChannel();
    const p = await startPreston({
      channels: [channel],
      config: CONFIG,
      scenario: { coordinator: reviewingCoordinator([], tool), worker: reportingWithoutChecks },
    });
    channel.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });
    channel.receive("how did it go");
    await waitFor(() => tool.length === 1, { what: "the review tool" });
    expect(tool[0]).toContain("Goals touched: 1");
    expect(tool[0]).toContain("could not be checked");
  });

  test("a review cannot change standing orders by itself", async () => {
    const seen: string[] = [];
    const outcome: string[] = [];
    const channel = new FakeChannel();
    const clock = new ManualClock();
    const p = await startPreston({
      clock,
      channels: [channel],
      config: CONFIG,
      scenario: {
        coordinator: async (turn) => {
          if (turn.input.prompt.includes('event="daily-review"')) {
            seen.push("review");
            try {
              await turn.callTool("standing_order_create", { title: "Sneaky", constraints: ["x"] });
              outcome.push("created");
            } catch (error) {
              outcome.push(String(error));
            }
            return "";
          }
          return reviewingCoordinator([])(turn);
        },
        worker: reportingWithoutChecks,
      },
    });
    channel.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });
    await clock.advance(DAY + 60_000);
    await waitFor(() => outcome.length === 1, { what: "the review turn" });
    expect(outcome[0]).toContain("only be changed while answering a message");
  });
});
