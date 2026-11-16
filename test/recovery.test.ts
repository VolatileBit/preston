import { describe, expect, test } from "vitest";
import { ManualClock } from "../src/clock.js";
import { formatResetTime } from "../src/quota/time.js";
import { isAlive } from "../src/supervisor/processes.js";
import { type FakeAdapter, fakeAdapterFactory } from "../src/workers/fake/index.js";
import {
  advanceUntil,
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  onCleanup,
  ownerMessage,
  reportingWorker,
  startPreston,
  TEST_CONFIG,
  tempDir,
  waitFor,
} from "./support/harness.js";

const MINUTE = 60_000;
const coordinatorTurns = (fake: FakeAdapter) => fake.calls.filter((c) => c.role === "coordinator");

describe("the Coordinator out of quota", () => {
  test("status still answers plainly, and messages queue and are answered after recovery", async () => {
    const clock = new ManualClock();
    const project = tempDir("project");
    const reset = new Date(clock.now() + 3 * 60 * MINUTE).toISOString();
    let blocked = false;
    const codex = fakeAdapterFactory({
      agent: "codex",
      quota: () => [{ bucket: "codex:primary", available: !blocked, checkedAt: "" }],
      coordinator: async (turn) => {
        const text = ownerMessage(turn);
        if (text === "go") return goalCreatingCoordinator(project)(turn);
        if (blocked) return turn.quotaBlocked({ bucket: "codex:primary", resetsAt: reset });
        return `Answer to: ${text}`;
      },
    });
    const p = await startPreston({
      clock,
      scenario: {
        worker: async (turn) => {
          turn.activity("npm test", true);
          return turn.stall();
        },
      },
      adapters: { codex: codex.factory },
      config: { ...TEST_CONFIG, coordinator: { agent: "codex" } },
    });

    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "running");
    blocked = true;
    p.owner.receive("how is it going?");
    await waitFor(() => p.owner.texts("reply").length === 2);
    const until = formatResetTime(reset, clock.now());
    const queued = `My own agent (Codex) is out of quota until ${until}, so I'll answer this when it's back. You can still say status, stop, pause or resume.`;
    expect(p.owner.texts("reply")[1]).toBe(queued);

    p.owner.receive("status");
    p.owner.receive("also add a footer");
    await waitFor(() => p.owner.texts("reply").length === 4);
    expect(p.owner.texts("reply")[2]).toBe(
      `Codex is out of quota until ${until}. 1 Goal running.\n\nIn progress:\n- Make the greeting page say hello (working)`,
    );
    expect(p.owner.texts("reply")[3]).toBe(queued);
    // Queued without spending a Coordinator turn on it.
    expect(coordinatorTurns(codex.adapter())).toHaveLength(2);

    blocked = false;
    await advanceUntil(clock, () => p.owner.texts("reply").length >= 5, 20 * MINUTE, MINUTE);
    await waitFor(() => p.owner.texts("reply").length === 6, { what: "the queued answers" });

    expect(p.owner.texts("reply").slice(4)).toEqual([
      "Answer to: how is it going?",
      "Answer to: also add a footer",
    ]);
    expect(coordinatorTurns(codex.adapter())).toHaveLength(4);
    expect(p.rt.statusText()).toBe("In progress:\n- Make the greeting page say hello (working)");
  });

  test("another allowed agent with headroom answers at once", async () => {
    const clock = new ManualClock();
    const codex = fakeAdapterFactory({
      agent: "codex",
      quota: () => [{ bucket: "codex:primary", available: false, checkedAt: "" }],
      coordinator: (turn) => turn.quotaBlocked({ bucket: "codex:primary" }),
    });
    const p = await startPreston({
      clock,
      scenario: { coordinator: (turn) => `Fake agent here: ${ownerMessage(turn)}` },
      adapters: { codex: codex.factory },
      config: {
        ...TEST_CONFIG,
        agents: { enabled: ["codex", "fake"], balanceByQuota: true },
        coordinator: { agent: "codex" },
      },
    });

    p.owner.receive("first");
    await waitFor(() => p.owner.texts("reply").length === 1);
    p.owner.receive("second");
    await waitFor(() => p.owner.texts("reply").length === 2);

    expect(p.owner.texts("reply")[0]).toContain("out of quota");
    expect(p.owner.texts("reply")[1]).toBe("Fake agent here: second");
    expect(coordinatorTurns(codex.adapter())).toHaveLength(1);
  });
});

describe("crash and restart recovery", () => {
  test("a message whose Coordinator turn was cut off by a crash is answered exactly once", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: async (turn) => {
          await turn.callTool("goal_create", { projectPath: project, brief: brief() });
          return turn.stall(); // The daemon dies before this turn finishes.
        },
        worker: reportingWorker,
      },
    });
    const ref = p.owner.receive("build the greeting page");
    await waitFor(() => p.rt.goals().length === 1);

    const replay = {
      coordinator: async (turn: Parameters<typeof reportingWorker>[0]) => {
        const text = ownerMessage(turn);
        if (text === "build the greeting page") {
          // Replayed: the Goal it already created is returned, not created again.
          await turn.callTool("goal_create", { projectPath: project, brief: brief() });
          return "On it.";
        }
        return `Answer to: ${text}`;
      },
      worker: reportingWorker,
    };
    const p2 = await p.restart({ scenario: replay });
    await waitFor(() => p2.owner.texts("reply").length === 1);
    p2.owner.receive("build the greeting page", { ref }); // The Channel delivers it again.
    p2.owner.receive("ping");
    await waitFor(() => p2.owner.texts("reply").length === 2);

    expect(p2.owner.texts("reply")).toEqual(["On it.", "Answer to: ping"]);
    const turns = coordinatorTurns(p2.fake);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.input.prompt).toContain("Preston was interrupted while handling this message");
    expect(p2.rt.goals()).toHaveLength(1);
    await waitFor(finishedGoal(p2.rt));

    const p3 = await p2.restart({ scenario: replay });
    p3.owner.receive("ping again");
    await waitFor(() => p3.owner.texts("reply").length === 1);
    expect(p3.owner.texts("reply")).toEqual(["Answer to: ping again"]);
    expect(coordinatorTurns(p3.fake)).toHaveLength(1);
  });

  test("an orphaned agent process is terminated on restart before its Session resumes", async () => {
    const project = tempDir("project");
    let orphan = 0;
    onCleanup(() => {
      if (orphan && isAlive(orphan)) process.kill(orphan, "SIGKILL");
    });
    const scenario = {
      coordinator: goalCreatingCoordinator(project),
      worker: async (turn: Parameters<typeof reportingWorker>[0]) => {
        if (turn.turn === 1) {
          orphan = turn.spawnChild();
          turn.activity("long build", true);
          return turn.stall();
        }
        return reportingWorker(turn);
      },
    };
    const p = await startPreston({ clock: new ManualClock(), scenario });
    p.owner.receive("go");
    await waitFor(() => p.rt.trackedProcesses().length === 1, { what: "the agent process" });
    expect(p.rt.trackedProcesses()[0]?.pid).toBe(orphan);
    expect(isAlive(orphan)).toBe(true);

    const p2 = await p.restart();
    await waitFor(() => !isAlive(orphan), { what: "the orphan to be terminated" });
    const goal = await waitFor(finishedGoal(p2.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(p2.rt.trackedProcesses()).toEqual([]);
    const resumed = p2.fake.calls.filter((c) => c.role === "worker");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.input.prompt).toContain("Preston was interrupted");
    expect(p2.owner.texts("outcome")).toHaveLength(1);
  });
});
