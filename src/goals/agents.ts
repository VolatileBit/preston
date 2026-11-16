import type { AgentKind } from "../workers/types.js";

/** Which agent a new Goal goes to, and why (shown in status, in plain words). */
export interface AgentChoice {
  agent: AgentKind;
  reason: string;
}

/** What is known about one of the agents the user allowed. */
export interface AgentCandidate {
  agent: AgentKind;
  label: string;
  /** Not blocked, and not nearly out of quota. */
  headroom: boolean;
  /** When the agent is expected to have quota again (milliseconds), if known. */
  resetsAt?: number | undefined;
}

/**
 * Deterministic choice among the agents the user enabled (candidates are in their order of
 * preference). With quota balancing it prefers an agent with headroom, and among those the one
 * used last for this Project, so its Sessions and context stay useful. When none has headroom,
 * the one that gets quota back first; an unknown reset counts as last. It never goes outside the
 * candidates, so Preston never moves work to an agent the user did not enable.
 */
export function selectAgent(
  candidates: AgentCandidate[],
  options: { balance: boolean; lastUsed?: AgentKind | undefined },
): AgentChoice {
  const first = candidates[0];
  if (!first) throw new Error("There is no agent to choose from.");
  if (candidates.length === 1)
    return { agent: first.agent, reason: `${first.label} is your agent` };
  if (!options.balance) {
    return { agent: first.agent, reason: `${first.label} is the agent you chose first` };
  }
  const ready = candidates.filter((c) => c.headroom);
  if (ready.length) {
    const sticky = ready.find((c) => c.agent === options.lastUsed);
    const pick = sticky ?? ready[0] ?? first;
    const others = candidates.filter((c) => c !== pick && !c.headroom).map((c) => c.label);
    const why = sticky
      ? `${pick.label} has quota to spare and worked on this project last`
      : others.length
        ? `${pick.label} has quota to spare; ${others.join(" and ")} ${others.length === 1 ? "is" : "are"} out or nearly out`
        : `${pick.label} has quota to spare`;
    return { agent: pick.agent, reason: why };
  }
  const unknown = Number.MAX_SAFE_INTEGER;
  const soonest = [...candidates].sort(
    (a, b) => (a.resetsAt ?? unknown) - (b.resetsAt ?? unknown),
  )[0] as AgentCandidate;
  return {
    agent: soonest.agent,
    reason: `every agent is out of quota, and ${soonest.label} is the first expected back`,
  };
}
