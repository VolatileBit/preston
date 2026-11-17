import { expect, test } from "vitest";
import { renderInput } from "../src/coordinator/input.js";
import type { Goal } from "../src/goals/store.js";
import { COORDINATOR_GUIDANCE } from "../src/prompts/coordinator.js";

const message = {
  kind: "message" as const,
  message: {
    channel: "discord" as const,
    conversationId: "c",
    senderId: "o",
    isOwner: true,
    text: "is it done?",
    ref: "r",
    receivedAt: "2026-11-17T10:43:00.000Z",
  },
};

function goal(over: Partial<Goal>): Goal {
  return {
    id: "g-1",
    projectPath: "/p",
    state: "running",
    outcome: null,
    endedAt: null,
    brief: { objective: "Create hello.txt" },
    ...over,
  } as Goal;
}

const context = (goals: Goal[]) => ({ time: "t", goals, openQuestions: [] });

test("a Goal that finished since the Coordinator last spoke is shown as finished, not forgotten", () => {
  const prompt = renderInput(
    message,
    context([
      goal({
        state: "completed",
        outcome: "verified",
        endedAt: "2026-11-17T10:42:01.692Z",
      }),
    ]),
  );
  expect(prompt).toContain("No Goals in progress.");
  expect(prompt).toContain(
    "- g-1 (completed, verified, ended 2026-11-17T10:42:01.692Z) in /p: Create hello.txt",
  );
});

test("running Goals are listed as in progress next to recently finished ones", () => {
  const prompt = renderInput(
    message,
    context([
      goal({ id: "g-2", state: "running" }),
      goal({ id: "g-1", state: "completed", outcome: "verified", endedAt: "2026-11-17T10:42:00Z" }),
    ]),
  );
  expect(prompt).toContain("- g-2 (running) in /p: Create hello.txt");
  expect(prompt).not.toContain("No Goals in progress.");
  expect(prompt).toContain("Recently finished:");
});

test("the Coordinator is told its own memory of a Goal can be out of date", () => {
  expect(COORDINATOR_GUIDANCE).toContain("newer than your own memory");
});
