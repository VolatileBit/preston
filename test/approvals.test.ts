import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import type { FakeScript, FakeTurn } from "../src/workers/fake/index.js";
import {
  approvalRequestId,
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  ownerMessage,
  startPreston,
  TEST_CONFIG,
  tempDir,
  waitFor,
} from "./support/harness.js";

const PUSH = { tool_name: "Bash", input: { command: "git push origin main" } };

/** A Worker that asks to push on its first turn, records the answer, then reports. */
function pushingWorker(answers: unknown[]): FakeScript {
  return async (turn: FakeTurn) => {
    if (turn.turn === 1) {
      answers.push(JSON.parse(await turn.callTool("approve", PUSH)));
      if ((answers.at(-1) as { message?: string }).message?.includes("escalated")) {
        return "Did everything else; waiting to hear about the push.";
      }
    }
    await turn.callTool("report_result", { summary: `Turn ${turn.turn}.` });
    return "Done.";
  };
}

function approvals(home: string) {
  const db = new DatabaseSync(join(home, "preston.db"), { readOnly: true });
  try {
    return db.prepare("SELECT state, decided_by, worker_told, summary FROM approvals").all();
  } finally {
    db.close();
  }
}

describe("escalated approvals", () => {
  test("the Coordinator allows a request within the Brief's authority while the Worker waits", async () => {
    const project = tempDir("project");
    const answers: unknown[] = [];
    let event = "";
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(
          project,
          brief({ authority: "May push to main." }),
          async (turn) => {
            const approvalId = approvalRequestId(turn);
            if (!approvalId) return "";
            event = turn.input.prompt;
            await turn.callTool("approval_decide", {
              approvalId,
              allow: true,
              reason: "the Brief allows pushing to main",
            });
            return "";
          },
          { approvals: "pass" },
        ),
        worker: pushingWorker(answers),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });

    expect(answers).toEqual([{ behavior: "allow", updatedInput: PUSH.input }]);
    expect(event).toContain("run `git push origin main`");
    expect(event).toContain("it publishes commits (git push)");
    expect(event).toContain("The Brief's authority: May push to main.");
    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    // Answered in the native reply, so the Worker was not resumed for it.
    expect(p.fake.calls.filter((c) => c.role === "worker")).toHaveLength(1);
    expect(approvals(p.home)).toEqual([
      {
        state: "allowed",
        decided_by: "coordinator",
        worker_told: "decision",
        summary: "run `git push origin main`",
      },
    ]);
  });

  test("a declined request is denied with the Coordinator's reason", async () => {
    const project = tempDir("project");
    const answers: unknown[] = [];
    const p = await startPreston({
      scenario: { coordinator: goalCreatingCoordinator(project), worker: pushingWorker(answers) },
    });

    p.owner.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });

    expect(answers).toEqual([
      { behavior: "deny", message: "Not approved: the Brief's authority does not cover it" },
    ]);
    expect(approvals(p.home)).toMatchObject([{ state: "denied", decided_by: "coordinator" }]);
  });

  test("without a decision in time the Worker carries on; the user's later yes resumes the same Session", async () => {
    const project = tempDir("project");
    const answers: unknown[] = [];
    const coordinator = goalCreatingCoordinator(
      project,
      brief(),
      async (turn) => {
        const approvalId = approvalRequestId(turn);
        if (approvalId) {
          const questionId = /questionId "(q-[0-9a-f]+)"/.exec(turn.input.prompt)?.[1];
          await turn.callTool("ask_human", {
            questionId,
            question: "The worker wants to push to main. Allow it? I'd say yes.",
          });
          return "";
        }
        if (ownerMessage(turn)?.trim() === "yes") {
          const status = JSON.parse(await turn.callTool("status")) as {
            openQuestions: { id: string }[];
          };
          await turn.callTool("approval_decide", {
            approvalId: status.openQuestions[0]?.id,
            allow: true,
            reason: "the user said yes",
          });
          return "Thanks, the worker can push now.";
        }
        return "";
      },
      { approvals: "pass" },
    );
    const p = await startPreston({
      scenario: { coordinator, worker: pushingWorker(answers) },
      config: { ...TEST_CONFIG, approvals: { escalationWaitMs: 150 } },
    });

    p.owner.receive("go");
    await waitFor(() => p.owner.texts("question").length > 0, { what: "the question" });
    expect(p.owner.texts("question")[0]).toContain("The worker wants to push to main.");
    await waitFor(() => p.rt.goals()[0]?.state === "waiting_for_user", { what: "the Run to park" });
    expect(answers[0]).toMatchObject({ behavior: "deny" });
    expect((answers[0] as { message: string }).message).toMatch(
      /^Preston has escalated this request \(approval a-[0-9a-f]+: run `git push origin main`\)/,
    );

    p.owner.receive("yes");
    const goal = await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const worker = p.fake.calls.filter((c) => c.role === "worker");
    expect(worker).toHaveLength(2);
    expect(worker[1]?.input.resumeSessionId).toBe(worker[0]?.sessionId);
    expect(worker[1]?.input.prompt).toContain(
      "Approved (the user said yes). You may now run `git push origin main`.",
    );
    expect(approvals(p.home)).toEqual([
      {
        state: "allowed",
        decided_by: "human",
        worker_told: "escalated",
        summary: "run `git push origin main`",
      },
    ]);
  });

  test("the Coordinator cannot decide an approval it already put to the user", async () => {
    const project = tempDir("project");
    const answers: unknown[] = [];
    let refusal = "";
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(
          project,
          brief(),
          async (turn) => {
            const approvalId = approvalRequestId(turn);
            if (!approvalId) return "";
            const questionId = /questionId "(q-[0-9a-f]+)"/.exec(turn.input.prompt)?.[1];
            await turn.callTool("ask_human", { questionId, question: "Allow the push?" });
            refusal = await turn
              .callTool("approval_decide", { approvalId, allow: true, reason: "sure" })
              .catch((err: Error) => err.message);
            return "";
          },
          { approvals: "pass" },
        ),
        worker: pushingWorker(answers),
      },
      config: { ...TEST_CONFIG, approvals: { escalationWaitMs: 100 } },
    });

    p.owner.receive("go");
    await waitFor(() => refusal, { what: "the refusal" });
    expect(refusal).toMatch(/is waiting for the user/);
    await waitFor(() => answers.length > 0);
    expect(answers[0]).toMatchObject({ behavior: "deny" });
  });
});
