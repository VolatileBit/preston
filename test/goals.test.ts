import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  node,
  reportingWorker,
  startPreston,
  tempDir,
  waitFor,
} from "./support/harness.js";

describe("a Goal from chat to outcome", () => {
  test("acknowledges, runs the Worker, re-runs the checks itself and reports Verified", async () => {
    const project = tempDir("project");
    const check = {
      name: "Preston ran this",
      command: node("require('fs').writeFileSync('checked-by-preston.txt', 'yes')"),
    };
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project, brief({ checks: [check] })),
        worker: reportingWorker,
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(existsSync(join(project, "checked-by-preston.txt"))).toBe(true);
    // Preston sends no acknowledgement of its own: the Coordinator's reply is the only voice.
    expect(p.owner.texts("ack")).toEqual([]);
    expect(p.owner.texts("reply")).toEqual(["Here's the Brief I drafted."]);
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain("Done and verified");
    expect(outcome).toContain("I re-ran the check myself");
    const worker = p.fake.calls.filter((c) => c.role === "worker");
    expect(worker).toHaveLength(1);
    expect(worker[0]?.input.workdir).toBe(project);
    expect(worker[0]?.input.prompt).toContain("Objective: Make the greeting page say hello");
    expect(worker[0]?.input.appendSystemPrompt).toContain("report_result");
  });

  test("reports Unverified when there is no check Preston can run", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project, brief({ checks: [] })),
        worker: reportingWorker,
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "unverified" });
    expect(p.owner.texts("outcome")[0]).toContain("Done, but unverified");
  });

  test("resumes the Worker once with the failure evidence when checks fail", async () => {
    const project = tempDir("project");
    const check = {
      name: "fixed",
      command: node("process.exit(require('fs').existsSync('fixed.txt') ? 0 : 3)"),
    };
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project, brief({ checks: [check] })),
        worker: async (turn) => {
          if (turn.turn > 1) writeFileSync(join(turn.input.workdir, "fixed.txt"), "fixed");
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const turns = p.fake.calls.filter((c) => c.role === "worker");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.input.resumeSessionId).toBe(turns[0]?.sessionId);
    expect(turns[1]?.input.prompt).toContain("fixed (`node -e");
    expect(turns[1]?.input.prompt).toContain("exited with code 3");
    expect(p.rt.verifications(goal.id).map((v) => v.passed)).toEqual([false, true]);
  });

  test("reports the failure after the bounded fix attempt still fails", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(
          project,
          brief({ checks: [{ name: "never", command: node("process.exit(1)") }] }),
        ),
        worker: reportingWorker,
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal.state).toBe("failed");
    expect(p.fake.calls.filter((c) => c.role === "worker")).toHaveLength(2);
    expect(p.owner.texts("outcome")[0]).toContain("My checks still fail");
  });

  test("never treats an unexpected exit as success, and recovers the same Session", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        worker: async (turn) => {
          if (turn.turn === 1) {
            turn.message("All done!");
            turn.exitUnexpectedly(1);
          }
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const turns = p.fake.calls.filter((c) => c.role === "worker");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.input.resumeSessionId).toBe(turns[0]?.sessionId);
    expect(turns[1]?.input.prompt).toContain("Preston was interrupted");
    expect(p.owner.texts("outcome")).toHaveLength(1);
  });

  test("a Worker that keeps exiting ends the Goal as failed, not completed", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        worker: (turn) => turn.exitUnexpectedly(1),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal.state).toBe("failed");
    expect(goal.outcome).toBeNull();
    expect(p.owner.texts("outcome")[0]).toContain("I couldn't finish");
  });

  test("reports Blocked with the Worker's blockers", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project),
        worker: async (turn) => {
          await turn.callTool("report_result", {
            summary: "Need an API key",
            blockers: ["A Stripe API key for the payment page"],
          });
          return "";
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt));

    expect(goal.state).toBe("blocked");
    expect(p.owner.texts("outcome")[0]).toContain("Blocked: Make the greeting page say hello");
    expect(p.owner.texts("outcome")[0]).toContain("A Stripe API key");
  });
});
