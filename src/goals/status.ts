import type { Question } from "../questions/questions.js";
import type { Goal, GoalState } from "./store.js";

const STATE_WORDS: Record<GoalState, string> = {
  queued: "starting",
  running: "working",
  verifying: "checking the result",
  completed: "done",
  waiting_for_quota: "waiting for agent quota",
  waiting_for_user: "waiting for your answer",
  recovering: "recovering",
  paused: "paused",
  blocked: "blocked",
  failed: "failed",
  cancelled: "stopped",
};

export function describeGoalState(goal: Goal): string {
  if (goal.state === "completed") return goal.outcome === "verified" ? "verified" : "unverified";
  return STATE_WORDS[goal.state];
}

/** The deterministic answer to "status". Never calls a model. */
export function statusText(goals: Goal[], questions: Question[]): string {
  const active = goals.filter((g) => !g.endedAt);
  const finished = goals.filter((g) => g.endedAt).slice(0, 5);
  const sections: string[] = [];
  if (active.length) {
    sections.push(
      [
        "In progress:",
        ...active.map((g) => `- ${g.brief.objective} (${describeGoalState(g)})`),
      ].join("\n"),
    );
  }
  const waiting = questions.filter((q) => q.state === "pending_human");
  if (waiting.length) {
    sections.push(
      ["Waiting for your answer:", ...waiting.map((q) => `- ${q.humanText ?? q.text}`)].join("\n"),
    );
  }
  if (finished.length) {
    sections.push(
      [
        "Recent results:",
        ...finished.map((g) => {
          const detail = g.detail && g.state !== "completed" ? ` - ${g.detail}` : "";
          return `- ${g.brief.objective} (${describeGoalState(g)})${detail}`;
        }),
      ].join("\n"),
    );
  }
  return sections.length
    ? sections.join("\n\n")
    : "Nothing in progress. Tell me what you'd like done.";
}
