import { describe, expect, test } from "vitest";
import {
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  node,
  startPreston,
  tempDir,
  waitFor,
} from "./support/harness.js";

describe("agent access", () => {
  test("Workers run with full access, the Coordinator with Preston's tools only", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project, brief({ checks: [] })),
        worker: async (turn) => {
          await turn.callTool("report_result", { summary: "Done." });
          return "Done.";
        },
      },
    });

    p.owner.receive("go");
    await waitFor(finishedGoal(p.rt));

    const roles = (role: string) => p.fake.calls.filter((c) => c.role === role);
    expect(roles("worker").length).toBeGreaterThan(0);
    expect(roles("worker").every((c) => c.input.access === "full")).toBe(true);
    expect(roles("coordinator").length).toBeGreaterThan(0);
    expect(roles("coordinator").every((c) => c.input.access === "tools_only")).toBe(true);
  });

  test("Worker-suggested commands run next to the Brief's checks but never make a Goal Verified", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project, brief({ checks: [] })),
        worker: async (turn) => {
          await turn.callTool("report_result", {
            summary: "Done.",
            suggestedVerificationCommands: [node("process.exit(0)"), node("process.exit(0)")],
          });
          return "Done.";
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt));

    const ran = p.rt.verifications(goal.id).flatMap((v) => v.results.map((r) => r.command));
    expect(ran).toEqual([node("process.exit(0)")]);
    expect(goal).toMatchObject({ state: "completed", outcome: "unverified" });
  });
});
