import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ManualClock } from "../src/clock.js";
import type { FakeAdapter, FakeTurn } from "../src/workers/fake/index.js";
import {
  advanceUntil,
  finishedGoal,
  goalCreatingCoordinator,
  reportingWorker,
  startPreston,
  tempDir,
  waitFor,
} from "./support/harness.js";

const MINUTE = 60_000;
const workerTurns = (p: { fake: FakeAdapter }) => p.fake.calls.filter((c) => c.role === "worker");
const stallEvents = (p: { fake: FakeAdapter }) =>
  p.fake.calls.filter((c) => c.input.prompt.includes('event="repeated-stall"'));
const eventGoalId = (turn: FakeTurn) => /goal="(g-[0-9a-f]+)"/.exec(turn.input.prompt)?.[1];

describe("stall supervision", () => {
  test("a silent turn with no tool running is interrupted and its Session resumed once", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        worker: async (turn) => {
          if (turn.turn === 1) {
            turn.activity("thinking");
            await turn.stall();
          }
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "running" && workerTurns(p).length === 1);
    const goalId = p.rt.goals()[0]?.id ?? "";
    const runId = p.rt.runs(goalId)[0]?.id ?? "";
    await clock.advance(5 * MINUTE);
    expect(p.rt.runHealth(runId)).toBe("active");

    await advanceUntil(clock, () => workerTurns(p).length === 2, 6 * MINUTE, MINUTE);
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const [first, second] = workerTurns(p);
    expect(second?.input.resumeSessionId).toBe(first?.sessionId);
    expect(second?.input.prompt).toContain("showed no activity for a long time");
    const dir = join(p.home, "transcripts", runId);
    const evidence = readdirSync(dir).filter((f) => f.startsWith("stall-"));
    expect(evidence).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, evidence[0] ?? ""), "utf8"))).toMatchObject({
      lastEventKind: "activity:thinking",
      toolRunning: false,
      thresholdMs: 10 * MINUTE,
    });
    expect(goal.attempts.map((a) => a.tactic)).toEqual(["stall_resume"]);
    expect(stallEvents(p)).toEqual([]);
    // Noticing and handling the first stall asked the Coordinator nothing.
    expect(p.fake.calls.filter((c) => c.role === "coordinator")).toHaveLength(1);
  });

  test("a long-running tool is not flagged as stalled before the longer threshold", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        worker: async (turn) => {
          if (turn.turn === 1) {
            turn.activity("npm run build", true);
            await turn.stall();
          }
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    await waitFor(() => workerTurns(p).length === 1 && p.rt.goals()[0]?.state === "running");
    const runId = p.rt.runs(p.rt.goals()[0]?.id ?? "")[0]?.id ?? "";
    await clock.advance(30 * MINUTE);
    expect(p.rt.runHealth(runId)).toBe("busy_tool");
    await clock.advance(29 * MINUTE);
    expect(workerTurns(p)).toHaveLength(1);

    await advanceUntil(clock, () => workerTurns(p).length === 2, 2 * MINUTE, MINUTE);
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(goal.attempts.map((a) => a.tactic)).toEqual(["stall_resume"]);
  });

  test("a repeated stall raises one Coordinator event, then Blocked rather than a loop", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const p = await startPreston({
      clock,
      scenario: {
        // The Coordinator looks at the event but decides nothing.
        coordinator: goalCreatingCoordinator(project, undefined, () => ""),
        worker: async (turn) => {
          turn.activity("waiting for an interactive prompt");
          return turn.stall();
        },
      },
    });

    p.owner.receive("go");
    await waitFor(() => workerTurns(p).length === 1);
    await advanceUntil(clock, () => workerTurns(p).length === 2, 11 * MINUTE, MINUTE);
    await advanceUntil(clock, () => stallEvents(p).length === 1, 11 * MINUTE, MINUTE);
    const goal = await waitFor(finishedGoal(p.rt));
    await clock.advance(2 * 60 * MINUTE);

    expect(goal.state).toBe("blocked");
    expect(p.owner.texts("outcome")).toHaveLength(1);
    expect(p.owner.texts("outcome")[0]).toContain("stalled repeatedly");
    expect(stallEvents(p)).toHaveLength(1);
    expect(workerTurns(p)).toHaveLength(2);
    expect(p.rt.goal(goal.id)?.attempts.map((a) => a.tactic)).toEqual([
      "stall_resume",
      "strategy_event",
    ]);
  });

  test("the Coordinator can change strategy: a fresh Session seeded with its guidance", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(project, undefined, async (turn) => {
          const goalId = eventGoalId(turn);
          if (!goalId) return "";
          await turn.callTool("goal_change_strategy", {
            goalId,
            action: "fresh_session",
            note: "Run the installer with --yes; it was waiting for input.",
          });
          return "Restarted with a different approach.";
        }),
        worker: async (turn) => {
          if (turn.input.prompt.includes("--yes")) return reportingWorker(turn);
          turn.activity("installing");
          return turn.stall();
        },
      },
    });

    p.owner.receive("go");
    await waitFor(() => workerTurns(p).length === 1);
    await advanceUntil(clock, () => workerTurns(p).length === 3, 25 * MINUTE, MINUTE);
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const turns = workerTurns(p);
    expect(turns[2]?.input.resumeSessionId).toBeUndefined();
    expect(turns[2]?.input.prompt).toContain("Objective: Make the greeting page say hello");
    expect(p.rt.runs(goal.id).map((r) => r.endReason)).toEqual(["fresh_session", "completed"]);
    expect(p.rt.goal(goal.id)?.attempts.map((a) => a.tactic)).toEqual([
      "stall_resume",
      "strategy_event",
      "fresh_session",
    ]);
  });
});
