import type { Question } from "../questions/questions.js";
import type { Bucket } from "../quota/store.js";
import { formatResetTime } from "../quota/time.js";
import type { Goal, GoalState } from "./store.js";

const STATE_WORDS: Record<GoalState, string> = {
  queued: "starting",
  running: "working",
  verifying: "checking the result",
  completed: "done",
  waiting_for_quota: "waiting for agent quota",
  waiting_for_user: "waiting for your answer",
  waiting_for_login: "waiting for you to sign in",
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

/** An agent that cannot work right now, for the status header. */
export interface AgentBlock {
  label: string;
  bucket: Bucket;
}

/** "Codex is out of quota until 3:40pm." */
export function describeAgentBlock(block: AgentBlock, now: number): string {
  const { label, bucket } = block;
  switch (bucket.state) {
    case "auth_broken":
      return `${label} needs you to sign in again.`;
    case "spend_blocked":
      return `${label} has reached its spending limit; I won't buy more.`;
    default:
      return bucket.resetsAt && Date.parse(bucket.resetsAt) > now
        ? `${label} is out of quota until ${formatResetTime(bucket.resetsAt, now)}.`
        : `${label} is out of quota; I'm checking regularly.`;
  }
}

/** "2 Goals running, 1 waiting for quota." */
function goalCounts(active: Goal[]): string {
  const count = (states: GoalState[]) => active.filter((g) => states.includes(g.state)).length;
  const parts = [
    [count(["queued", "running", "verifying", "recovering"]), "running"],
    [count(["waiting_for_quota"]), "waiting for quota"],
    [count(["waiting_for_login"]), "waiting for you to sign in"],
    [count(["waiting_for_user"]), "waiting for your answer"],
    [count(["paused"]), "paused"],
  ] as const;
  const said = parts.filter(([n]) => n > 0);
  if (!said.length) return "No Goals in progress.";
  return `${said
    .map(([n, words], i) =>
      i === 0 ? `${n} ${n === 1 ? "Goal" : "Goals"} ${words}` : `${n} ${words}`,
    )
    .join(", ")}.`;
}

/** The deterministic answer to "status". Never calls a model. */
export function statusText(
  goals: Goal[],
  questions: Question[],
  blocks: AgentBlock[] = [],
  now = Date.now(),
  /** The agent a Goal is on, named when the user has more than one. */
  agentOf: (goal: Goal) => string | undefined = () => undefined,
): string {
  const active = goals.filter((g) => !g.endedAt);
  const finished = goals.filter((g) => g.endedAt).slice(0, 5);
  const sections: string[] = [];
  if (blocks.length) {
    sections.push([...blocks.map((b) => describeAgentBlock(b, now)), goalCounts(active)].join(" "));
  }
  if (active.length) {
    sections.push(
      [
        "In progress:",
        ...active.map((g) => {
          const agent = agentOf(g);
          return `- ${g.brief.objective} (${describeGoalState(g)}${agent ? `, on ${agent}` : ""})`;
        }),
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
