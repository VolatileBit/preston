import { describe, expect, test } from "vitest";
import { ManualClock } from "../src/clock.js";
import {
  finishedGoal,
  goalCreatingCoordinator,
  reportingWorker,
  startPreston,
  tempDir,
  waitFor,
} from "./support/harness.js";

describe("the outbox", () => {
  test("a delivery failure never fails the Goal, and status still shows the result", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: { coordinator: goalCreatingCoordinator(project), worker: reportingWorker },
    });
    p.owner.failEverything({ error: "service down", retryable: false });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt));
    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(p.owner.sent).toEqual([]);

    p.owner.stopFailing();
    p.owner.receive("status");
    await waitFor(() => p.owner.texts("reply").length === 1);
    expect(p.owner.texts("reply")[0]).toBe(
      "Recent results:\n- Make the greeting page say hello (verified)",
    );
  });

  test("retries with backoff and delivers in order once the Channel recovers", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const p = await startPreston({
      clock,
      scenario: { coordinator: goalCreatingCoordinator(project), worker: reportingWorker },
    });
    p.owner.failNext(2);

    p.owner.receive("go");
    await waitFor(finishedGoal(p.rt));
    // The failed first message holds back the later ones, so order is kept.
    expect(p.owner.attempts).toBe(1);
    expect(p.owner.sent).toEqual([]);

    await clock.advance(999);
    expect(p.owner.attempts).toBe(1);
    await clock.advance(1); // first retry after 1s fails again
    expect(p.owner.attempts).toBe(2);
    await clock.advance(1_999);
    expect(p.owner.attempts).toBe(2);
    await clock.advance(1); // second retry after 2s succeeds, then the rest follow
    await waitFor(() => p.owner.sent.length === 2);

    expect(p.owner.sent.map((m) => m.kind)).toEqual(["reply", "outcome"]);
  });

  test("holds messages while a Channel is disconnected and sends them when it reconnects", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: { coordinator: goalCreatingCoordinator(project), worker: reportingWorker },
    });
    p.owner.receive("go");
    p.owner.setStatus("disconnected");
    await waitFor(finishedGoal(p.rt));
    const before = p.owner.sent.length;

    p.owner.setStatus("connected");
    await waitFor(() => p.owner.texts("outcome").length === 1);
    expect(p.owner.sent.length).toBeGreaterThan(before);
  });
});
