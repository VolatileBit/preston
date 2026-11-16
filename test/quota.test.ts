import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ManualClock } from "../src/clock.js";
import { formatResetTime } from "../src/quota/time.js";
import {
  type FakeAdapter,
  type FakeScript,
  fakeAdapterFactory,
} from "../src/workers/fake/index.js";
import type { QuotaReading } from "../src/workers/types.js";
import {
  advanceUntil,
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  ownerMessage,
  reportingWorker,
  startPreston,
  TEST_CONFIG,
  tempDir,
  waitFor,
} from "./support/harness.js";

const MINUTE = 60_000;
const at = (clock: ManualClock, ms: number) => new Date(clock.now() + ms).toISOString();

/** A worker that does step 1, runs out of quota on its first turn, then finishes. */
function quotaWorker(options: { bucket: string; resetsAt?: () => string | undefined }): FakeScript {
  return async (turn) => {
    const log = join(turn.input.workdir, `work-${turn.sessionId}.log`);
    const step1 = join(turn.input.workdir, `step1-${turn.sessionId}.txt`);
    if (!existsSync(step1)) {
      appendFileSync(log, "step1\n");
      writeFileSync(step1, "done");
    }
    turn.activity("edit");
    if (turn.turn === 1)
      turn.quotaBlocked({ bucket: options.bucket, resetsAt: options.resetsAt?.() });
    appendFileSync(log, "step2\n");
    return reportingWorker(turn);
  };
}

const workerTurns = (p: { fake: FakeAdapter }) => p.fake.calls.filter((c) => c.role === "worker");

describe("quota exhaustion", () => {
  test("a Worker out of quota waits, is rechecked, and resumes the same Session without redoing work", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const reset = at(clock, 3 * 60 * MINUTE);
    let available = false;
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        quota: (): QuotaReading[] => [
          { bucket: "fake:5h", available, resetsAt: reset, checkedAt: at(clock, 0) },
        ],
        worker: quotaWorker({ bucket: "fake:5h", resetsAt: () => reset }),
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "waiting_for_quota", { what: "quota wait" });
    await waitFor(() => p.owner.texts("notice").length === 1, { what: "the wait notice" });
    expect(p.rt.goals()[0]?.outcome).toBeNull();
    expect(p.owner.texts("notice")[0]).toBe(
      `Waiting: Make the greeting page say hello\nFake agent is out of quota until ${formatResetTime(reset, clock.now())}. I'll continue automatically then.`,
    );

    await clock.advance(16 * MINUTE);
    expect(p.fake.quotaReads).toBe(1);
    expect(p.rt.goals()[0]?.state).toBe("waiting_for_quota");

    available = true;
    await advanceUntil(clock, () => p.rt.goals()[0]?.state !== "waiting_for_quota", 30 * MINUTE);
    const goal = await waitFor(finishedGoal(p.rt), { what: "the goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(p.fake.quotaReads).toBe(2);
    const turns = workerTurns(p);
    expect(turns).toHaveLength(2);
    expect(turns[1]?.sessionId).toBe(turns[0]?.sessionId);
    expect(turns[1]?.input.prompt).toContain("Quota restored; continue from where you stopped");
    expect(readFileSync(join(project, `work-${turns[0]?.sessionId}.log`), "utf8")).toBe(
      "step1\nstep2\n",
    );
    expect(p.owner.texts("notice")).toHaveLength(1);
    expect(p.rt.runs(goal.id)).toHaveLength(1);
  });

  test("an early reset is noticed at the next allowed check, long before the advertised time", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const start = clock.now();
    const reset = at(clock, 4 * 60 * MINUTE);
    const resumedAt: number[] = [];
    const worker = quotaWorker({ bucket: "fake:5h", resetsAt: () => reset });
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        // The provider reset early: the bucket is already available again.
        quota: () => [{ bucket: "fake:5h", available: true, checkedAt: at(clock, 0) }],
        worker: async (turn) => {
          if (turn.turn > 1) resumedAt.push(clock.now());
          return worker(turn);
        },
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "waiting_for_quota");
    await clock.advance(9 * MINUTE);
    expect(p.fake.quotaReads).toBe(0);
    expect(resumedAt).toEqual([]);

    await clock.advance(6 * MINUTE);
    await waitFor(finishedGoal(p.rt));

    expect(p.fake.quotaReads).toBe(1);
    expect(resumedAt).toHaveLength(1);
    const waited = (resumedAt[0] ?? 0) - start;
    expect(waited).toBeGreaterThanOrEqual(10 * MINUTE);
    expect(waited).toBeLessThanOrEqual(15 * MINUTE);
  });

  test("three Runs on one bucket share one monitor and resume staggered", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const reset = at(clock, 20 * MINUTE);
    const resumedAt: number[] = [];
    const worker = quotaWorker({ bucket: "fake:shared", resetsAt: () => reset });
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: async (turn) => {
          if (ownerMessage(turn) !== "go") return "";
          for (const name of ["one", "two", "three"]) {
            await turn.callTool("goal_create", {
              projectPath: project,
              brief: brief({ objective: `Goal ${name}` }),
            });
          }
          return "Started three.";
        },
        // No token-free read: the monitor has to probe.
        worker: async (turn) => {
          if (turn.turn > 1) resumedAt.push(clock.now());
          return worker(turn);
        },
      },
    });

    p.owner.receive("go");
    await waitFor(
      () => p.rt.goals().length === 3 && p.rt.goals().every((g) => g.state === "waiting_for_quota"),
      { what: "all three waiting" },
    );
    expect(p.rt.quota().map((b) => [b.bucket, b.state, b.monitored])).toEqual([
      ["fake:shared", "blocked", true],
    ]);

    await clock.advance(19 * MINUTE);
    expect(resumedAt).toEqual([]);
    await clock.advance(3 * MINUTE);
    await waitFor(() => resumedAt.length === 1, { what: "the probe" });
    await waitFor(() => p.rt.quota()[0]?.state === "available", { what: "the probe to succeed" });
    expect(resumedAt).toHaveLength(1);

    await clock.advance(90_000);
    await waitFor(() => resumedAt.length === 2, { what: "the second resume" });
    await clock.advance(90_000);
    await waitFor(() => resumedAt.length === 3, { what: "the third resume" });
    await waitFor(() => p.rt.goals().every((g) => g.state === "completed"), { what: "all done" });

    const [first = 0, second = 0, third = 0] = resumedAt;
    expect(second - first).toBeGreaterThanOrEqual(90_000);
    expect(third - second).toBeGreaterThanOrEqual(90_000);
    expect(first - Date.parse(reset)).toBeLessThanOrEqual(2 * MINUTE);
    expect(p.rt.goals().map((g) => g.outcome)).toEqual(["verified", "verified", "verified"]);
    // Short waits are not worth a message.
    expect(p.owner.texts("notice")).toEqual([]);
  });

  test("a daemon restart during a quota wait keeps the monitor and the waiting Run", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const reset = at(clock, 3 * 60 * MINUTE);
    let available = false;
    const scenario = {
      coordinator: goalCreatingCoordinator(project),
      quota: (): QuotaReading[] => [
        { bucket: "fake:5h", available, resetsAt: reset, checkedAt: at(clock, 0) },
      ],
      worker: quotaWorker({ bucket: "fake:5h", resetsAt: () => reset }),
    };
    const p = await startPreston({ clock, scenario });
    p.owner.receive("go");
    await waitFor(() => p.owner.texts("notice").length === 1);

    const p2 = await p.restart();
    expect(p2.rt.goals()[0]?.state).toBe("waiting_for_quota");
    expect(p2.rt.quota().map((b) => [b.bucket, b.state, b.monitored])).toEqual([
      ["fake:5h", "blocked", true],
    ]);
    available = true;
    await clock.advance(16 * MINUTE);
    const goal = await waitFor(finishedGoal(p2.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(p2.fake.quotaReads).toBe(1);
    const resumed = workerTurns(p2);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.input.resumeSessionId).toBe(workerTurns(p)[0]?.sessionId);
    // The wait was told once, before the restart; nothing is repeated after it.
    expect(p2.owner.texts("notice")).toEqual([]);
    expect(p2.owner.texts("outcome")).toHaveLength(1);
  });

  test("an ambiguous 429 is a short wait, not a quota suspension", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const start = clock.now();
    let resumedAt = 0;
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        worker: async (turn) => {
          if (turn.turn === 1) turn.fail("API Error: Request rejected (429)", true);
          resumedAt = clock.now();
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "waiting_for_quota");
    const wakeAt = Date.parse(p.rt.goals()[0]?.wakeAt ?? "");
    expect(wakeAt - start).toBeLessThanOrEqual(MINUTE);
    expect(p.rt.quota()).toEqual([]);

    await clock.advance(MINUTE);
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(resumedAt - start).toBe(MINUTE);
    const turns = workerTurns(p);
    expect(turns[1]?.input.resumeSessionId).toBe(turns[0]?.sessionId);
    expect(turns[1]?.input.prompt).toContain("briefly rate-limited");
    expect(p.rt.runs(goal.id)[0]?.recoveries).toBe(0);
    expect(p.owner.texts("notice")).toEqual([]);
  });

  test("a spending limit is never bought around: the user is told once and the Goal waits", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        worker: (turn) => turn.quotaBlocked({ bucket: "fake:spend", kind: "spend_limit" }),
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.owner.texts("notice").length === 1);
    await clock.advance(3 * 60 * MINUTE);

    expect(p.owner.texts("notice")[0]).toContain("has reached its spending limit");
    expect(p.owner.texts("notice")[0]).toContain("I won't buy credits or turn on paid usage");
    expect(p.rt.goals()[0]?.state).toBe("waiting_for_quota");
    // Without a token-free read, a spending limit is not probed automatically.
    expect(workerTurns(p)).toHaveLength(1);
    expect(p.owner.texts("notice")).toHaveLength(1);
  });
});

describe("authentication errors", () => {
  test("a signed-out agent blocks the Goal with a plain message and recovers after login", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    let signedIn = false;
    const codex = fakeAdapterFactory({
      agent: "codex",
      detection: () => ({ installed: true, loggedIn: signedIn }),
      worker: async (turn) => {
        if (turn.turn === 1) turn.authError("Codex is not signed in or its login expired");
        return reportingWorker(turn);
      },
    });
    const p = await startPreston({
      clock,
      scenario: { coordinator: goalCreatingCoordinator(project) },
      adapters: { codex: codex.factory },
      config: { ...TEST_CONFIG, agents: { enabled: ["codex"] } },
    });

    p.owner.receive("go");
    await waitFor(() => p.owner.texts("notice").length === 1);
    expect(p.owner.texts("notice")[0]).toBe(
      "Blocked until you sign in: Make the greeting page say hello\nCodex is signed out, so I can't continue. Run `codex login` in a terminal. I'll pick it up automatically once you have.",
    );
    expect(p.rt.statusText()).toBe(
      "Codex needs you to sign in again. 1 Goal waiting for you to sign in.\n\nIn progress:\n- Make the greeting page say hello (waiting for you to sign in)",
    );

    await clock.advance(16 * MINUTE);
    expect(p.rt.goals()[0]?.state).toBe("waiting_for_login");

    signedIn = true;
    await advanceUntil(clock, () => p.rt.goals()[0]?.state !== "waiting_for_login", 30 * MINUTE);
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const turns = codex.adapter().calls;
    expect(turns).toHaveLength(2);
    expect(turns[1]?.input.resumeSessionId).toBe(turns[0]?.sessionId);
    expect(turns[1]?.input.prompt).toContain("signed in again");
    expect(p.owner.texts("notice")).toHaveLength(1);
  });
});

describe("agent switching", () => {
  test("a long wait hands the Goal to the other agent with headroom, with a checkpoint", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const reset = at(clock, 3 * 60 * MINUTE);
    const codex = fakeAdapterFactory({
      agent: "codex",
      quota: () => [{ bucket: "codex:primary", available: true, usedPercent: 20, checkedAt: "" }],
      worker: async (turn) => {
        writeFileSync(join(turn.input.workdir, "finished-by-codex.txt"), "yes");
        return reportingWorker(turn);
      },
    });
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        worker: async (turn) => {
          turn.message("Built the page skeleton; the greeting text is still missing.");
          return turn.quotaBlocked({ bucket: "fake:5h", resetsAt: reset });
        },
      },
      adapters: { codex: codex.factory },
      config: { ...TEST_CONFIG, agents: { enabled: ["fake", "codex"], balanceByQuota: true } },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "the goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(existsSync(join(project, "finished-by-codex.txt"))).toBe(true);
    const runs = p.rt.runs(goal.id);
    expect(runs.map((r) => [r.agent, r.endReason])).toEqual([
      ["fake", "quota_handover"],
      ["codex", "completed"],
    ]);
    const [handover] = codex.adapter().calls;
    expect(handover?.input.resumeSessionId).toBeUndefined();
    expect(handover?.input.prompt).toContain("Objective: Make the greeting page say hello");
    expect(handover?.input.prompt).toContain("Fake agent worked on this Goal before you");
    expect(handover?.input.prompt).toContain("the greeting text is still missing");
    expect(handover?.input.prompt).toContain("its work may be incomplete");
    expect(p.owner.texts("notice")).toEqual([
      `Switched to Codex: Make the greeting page say hello\nFake agent is out of quota until ${formatResetTime(reset, clock.now())}, so Codex is continuing from the current state of the work.`,
    ]);
    expect(p.rt.goal(goal.id)?.attempts.map((a) => a.tactic)).toEqual(["quota_handover"]);
  });

  test("without permission to balance across agents, the Goal waits for its own agent", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const codex = fakeAdapterFactory({
      agent: "codex",
      quota: () => [{ bucket: "codex:primary", available: true, usedPercent: 20, checkedAt: "" }],
      worker: reportingWorker,
    });
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        worker: (turn) =>
          turn.quotaBlocked({ bucket: "fake:5h", resetsAt: at(clock, 3 * 60 * MINUTE) }),
      },
      adapters: { codex: codex.factory },
      config: { ...TEST_CONFIG, agents: { enabled: ["fake", "codex"], balanceByQuota: false } },
    });

    p.owner.receive("go");
    await waitFor(() => p.owner.texts("notice").length === 1);

    expect(p.owner.texts("notice")[0]).toContain("Fake agent is out of quota until");
    expect(p.rt.goals()[0]?.state).toBe("waiting_for_quota");
    expect(codex.adapter().calls).toEqual([]);
  });
});
