import { describe, expect, test } from "vitest";
import { ManualClock } from "../src/clock.js";
import { type FakeScript, fakeAdapterFactory } from "../src/workers/fake/index.js";
import {
  advanceUntil,
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  node,
  reportingWorker,
  startPreston,
  TEST_CONFIG,
  tempDir,
  waitFor,
} from "./support/harness.js";

const MINUTE = 60_000;

/** The Worker turns started so far, across restarts. */
const workerTurns = (p: { fake: { calls: { role: string }[] } }) =>
  p.fake.calls.filter((c) => c.role === "worker");

describe("restarting Preston in each state of a Goal", () => {
  test("while the Worker is running: the Goal carries on and is reported once", async () => {
    const project = tempDir("project");
    const scenario = (stall: boolean) => ({
      coordinator: goalCreatingCoordinator(project, brief()),
      worker: async (turn: Parameters<typeof reportingWorker>[0]) => {
        if (stall && !turn.resumed) await turn.stall();
        return reportingWorker(turn);
      },
    });
    const p = await startPreston({ scenario: scenario(true) });
    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "running");
    await waitFor(() => p.owner.texts("ack").length === 1);

    const q = await p.restart({ scenario: scenario(false) });
    const goal = await waitFor(finishedGoal(q.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(q.owner.texts("ack")).toEqual([]);
    expect(q.owner.texts("outcome")).toHaveLength(1);
  });

  test("while Preston is checking the result: the checks run again and one outcome is sent", async () => {
    const project = tempDir("project");
    const slow = { name: "slow check", command: node("setTimeout(() => {}, 1500)") };
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project, brief({ checks: [slow] })),
        worker: reportingWorker,
      },
    });
    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "verifying", { what: "verification" });

    const q = await p.restart();
    const goal = await waitFor(finishedGoal(q.rt), { what: "goal to finish", timeoutMs: 15_000 });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(q.rt.verifications(goal.id).filter((v) => v.passed)).toHaveLength(1);
    expect(q.owner.texts("outcome")).toHaveLength(1);
    // The Worker is not asked to do the work again.
    expect(workerTurns(q)).toHaveLength(0);
  });

  test("while paused: it stays paused until the user says resume", async () => {
    const project = tempDir("project");
    const scenario = {
      coordinator: goalCreatingCoordinator(project, brief()),
      worker: async (turn: Parameters<typeof reportingWorker>[0]) => {
        if (!turn.resumed) await turn.stall();
        return reportingWorker(turn);
      },
    };
    const p = await startPreston({ scenario });
    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "running");
    p.owner.receive("pause");
    await waitFor(() => p.rt.goals()[0]?.state === "paused");

    const q = await p.restart();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(q.rt.goals()[0]?.state).toBe("paused");
    expect(workerTurns(q)).toHaveLength(0);

    q.owner.receive("resume");
    const goal = await waitFor(finishedGoal(q.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(q.owner.texts("outcome")).toHaveLength(1);
  });

  test("while waiting for a sign-in: the wait and the one notice survive, and it resumes after login", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    let signedIn = false;
    const codex = fakeAdapterFactory({
      agent: "codex",
      detection: () => ({ installed: true, loggedIn: signedIn }),
      worker: async (turn) => {
        if (turn.turn === 1) turn.authError("Codex is not signed in");
        return reportingWorker(turn);
      },
    });
    const p = await startPreston({
      clock,
      scenario: { coordinator: goalCreatingCoordinator(project, brief()) },
      adapters: { codex: codex.factory },
      config: { ...TEST_CONFIG, agents: { enabled: ["codex"] } },
    });
    p.owner.receive("go");
    await waitFor(() => p.owner.texts("notice").length === 1, { what: "the sign-in notice" });

    const q = await p.restart();
    await waitFor(() => q.rt.goals()[0]?.state === "waiting_for_login");
    expect(q.owner.texts("notice")).toEqual([]);
    signedIn = true;
    await advanceUntil(clock, () => q.rt.goals()[0]?.state !== "waiting_for_login", 40 * MINUTE);
    const goal = await waitFor(finishedGoal(q.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(q.owner.texts("notice")).toEqual([]);
    expect(q.owner.texts("outcome")).toHaveLength(1);
  });

  const blockedWorker: FakeScript = async (turn) => {
    await turn.callTool("report_result", {
      summary: "Cannot continue.",
      blockers: ["I need the production password."],
    });
    return "Blocked.";
  };
  test.each<[string, FakeScript, string]>([
    ["verified", reportingWorker, "completed"],
    ["blocked", blockedWorker, "blocked"],
  ])("after the Goal ended %s: nothing is reported or run again", async (_name, worker, state) => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: { coordinator: goalCreatingCoordinator(project, brief()), worker },
    });
    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });
    expect(goal.state).toBe(state);

    const q = await p.restart();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(q.rt.goal(goal.id)).toMatchObject({ state, outcome: goal.outcome });
    expect(q.owner.texts("outcome")).toEqual([]);
    expect(q.owner.texts("ack")).toEqual([]);
    expect(workerTurns(q)).toHaveLength(0);
  });

  test("after the user stopped it: it stays stopped", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project, brief()),
        worker: (turn) => turn.stall(),
      },
    });
    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "running");
    p.owner.receive("stop");
    await waitFor(() => p.rt.goals()[0]?.state === "cancelled");

    const q = await p.restart();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(q.rt.goals()[0]?.state).toBe("cancelled");
    expect(workerTurns(q)).toHaveLength(0);
  });
});
