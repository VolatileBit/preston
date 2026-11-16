import { describe, expect, test } from "vitest";
import { FakeChannel } from "../src/channels/fake/index.js";
import type { FakeScript } from "../src/workers/fake/index.js";
import {
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  ownerMessage,
  startPreston,
  tempDir,
  waitFor,
  workerQuestionId,
} from "./support/harness.js";

/** Escalates every Worker question; records the user's reply to the open question. */
function relayingCoordinator(project: string): FakeScript {
  return goalCreatingCoordinator(project, brief(), async (turn) => {
    const questionId = workerQuestionId(turn);
    if (questionId) {
      await turn.callTool("ask_human", {
        questionId,
        question: "Which colour should the button be? I'd suggest blue.",
      });
      return "";
    }
    const text = ownerMessage(turn);
    if (!text) return "";
    const status = JSON.parse(await turn.callTool("status")) as { openQuestions: { id: string }[] };
    const open = status.openQuestions[0];
    if (!open) {
      return "That question was already answered.";
    }
    await turn.callTool("answer_worker", { questionId: open.id, answer: text });
    return "Thanks, passing that on.";
  });
}

const askingWorker: FakeScript = async (turn) => {
  if (turn.turn === 1) {
    const reply = await turn.callTool("ask_preston", { question: "Blue or green button?" });
    turn.state.firstReply = reply;
    return "Parked until I hear back.";
  }
  await turn.callTool("report_result", {
    summary: `Used the answer. ${turn.input.prompt.includes("Answer: Blue") ? "blue" : "unknown"}`,
  });
  return "Done.";
};

describe("questions that need the user", () => {
  test("reach every Channel, the first answer wins, others get a reaction, and the Run resumes in the same Session", async () => {
    const project = tempDir("project");
    const discord = new FakeChannel({ kind: "discord", reactions: true });
    const slack = new FakeChannel({ kind: "slack", reactions: true });
    const wechat = new FakeChannel({ kind: "wechat", reactions: false });
    const p = await startPreston({
      channels: [discord, slack, wechat],
      scenario: { coordinator: relayingCoordinator(project), worker: askingWorker },
    });

    discord.receive("go");
    await waitFor(() => wechat.texts("question").length > 0, { what: "question on every Channel" });
    for (const channel of [discord, slack, wechat]) {
      expect(channel.texts("question")).toEqual([
        'Preston needs your decision on "Make the greeting page say hello":\nWhich colour should the button be? I\'d suggest blue.',
      ]);
    }
    await waitFor(() => p.rt.goals()[0]?.state === "waiting_for_user", { what: "the Run to park" });

    slack.receive("Blue");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });
    wechat.receive("Green");
    await waitFor(() => wechat.texts("reply").length > 0, { what: "late answer reply" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const worker = p.fake.calls.filter((c) => c.role === "worker");
    expect(worker).toHaveLength(2);
    expect(worker[1]?.input.resumeSessionId).toBe(worker[0]?.sessionId);
    expect(worker[1]?.input.prompt).toContain("Your question: Blue or green button?\nAnswer: Blue");
    expect(p.rt.runs(goal.id)[0]?.report?.summary).toContain("blue");

    // Reactions only where the question was delivered and the Channel supports them.
    const discordQuestion = discord.sent.find((m) => m.kind === "question");
    expect(discord.reactions).toEqual([discordQuestion?.ref]);
    expect(slack.reactions).toEqual([]);
    expect(wechat.reactions).toEqual([]);
    // Nothing else is sent to the other Channels about the answer.
    expect(discord.sent.map((m) => m.kind)).toEqual(["ack", "reply", "question", "outcome"]);
    expect(wechat.texts("reply")).toEqual(["That question was already answered."]);
  });

  test("a Worker gets the Coordinator's answer directly when it can answer", async () => {
    const project = tempDir("project");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(project, brief(), async (turn) => {
          const questionId = workerQuestionId(turn);
          if (questionId)
            await turn.callTool("answer_worker", {
              questionId,
              answer: "Use green, per the Brief.",
            });
          return "";
        }),
        worker: async (turn) => {
          const answer = await turn.callTool("ask_preston", { question: "Which colour?" });
          await turn.callTool("report_result", { summary: `Got: ${answer}` });
          return "Done.";
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt));

    expect(p.rt.runs(goal.id)[0]?.report?.summary).toBe("Got: Use green, per the Brief.");
    expect(p.fake.calls.filter((c) => c.role === "worker")).toHaveLength(1);
    expect(p.owner.texts("question")).toEqual([]);
  });

  test("a parked question survives a restart and the answer still resumes the same Session", async () => {
    const project = tempDir("project");
    const scenario = { coordinator: relayingCoordinator(project), worker: askingWorker };
    const first = await startPreston({ scenario });
    first.owner.receive("go");
    await waitFor(() => first.rt.goals()[0]?.state === "waiting_for_user");
    const firstSession = first.fake.calls.find((c) => c.role === "worker")?.sessionId;

    const second = await first.restart();
    expect(second.rt.openQuestions()).toHaveLength(1);
    second.owner.receive("Blue");
    const goal = await waitFor(finishedGoal(second.rt));

    expect(goal.outcome).toBe("verified");
    const resumed = second.fake.calls.filter((c) => c.role === "worker");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.input.resumeSessionId).toBe(firstSession);
    // The acknowledgement and question were not sent again after the restart.
    expect(second.owner.texts("ack")).toEqual([]);
    expect(second.owner.texts("question")).toEqual([]);
  });
});
