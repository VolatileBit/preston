import type { AgentKind } from "../workers/types.js";
import type { CheckResult } from "./checks.js";
import type { Goal, WorkerReport } from "./store.js";

/** Everything Preston tells the user about Goals unprompted: short and plain. */

export function ackMessage(goal: Goal): string {
  return `On it: ${goal.brief.objective}\nI'll let you know when it's done.`;
}

export function verifiedMessage(
  goal: Goal,
  results: CheckResult[],
  report: WorkerReport | null,
): string {
  const checks = results.filter((r) => r.source === "brief");
  return [
    `Done and verified: ${goal.brief.objective}`,
    `I re-ran ${checks.length === 1 ? "the check" : `all ${checks.length} checks`} myself and ${checks.length === 1 ? "it passes" : "they pass"}.`,
    summaryLine(report),
  ]
    .filter(Boolean)
    .join("\n");
}

export function unverifiedMessage(goal: Goal, report: WorkerReport | null): string {
  return [
    `Done, but unverified: ${goal.brief.objective}`,
    "There was no check I could run myself, so please take a look.",
    summaryLine(report),
  ]
    .filter(Boolean)
    .join("\n");
}

export function blockedMessage(goal: Goal, reason: string): string {
  return `Blocked: ${goal.brief.objective}\n${reason}`;
}

export function failedMessage(goal: Goal, reason: string): string {
  return `I couldn't finish: ${goal.brief.objective}\n${reason}`;
}

/** Told once when a quota wait is expected to delay a Goal noticeably. */
export function quotaWaitMessage(goal: Goal, agent: string, until: string | undefined): string {
  return until
    ? `Waiting: ${goal.brief.objective}\n${agent} is out of quota until ${until}. I'll continue automatically then.`
    : `Waiting: ${goal.brief.objective}\n${agent} is out of quota and didn't say when it resets. I'm checking regularly and will continue automatically.`;
}

export function spendLimitMessage(goal: Goal, agent: string): string {
  return `Waiting: ${goal.brief.objective}\n${agent} has reached its spending limit. I won't buy credits or turn on paid usage. I'll continue when it has quota again; if you raise the limit yourself, say "resume".`;
}

export function signInMessage(goal: Goal, agent: string, how: string): string {
  return `Blocked until you sign in: ${goal.brief.objective}\n${agent} is signed out, so I can't continue. ${how} I'll pick it up automatically once you have.`;
}

export function handoverMessage(
  goal: Goal,
  from: string,
  to: string,
  until: string | undefined,
): string {
  const wait = until ? ` until ${until}` : "";
  return `Switched to ${to}: ${goal.brief.objective}\n${from} is out of quota${wait}, so ${to} is continuing from the current state of the work.`;
}

export function failedChecksEvidence(results: CheckResult[]): string {
  return results
    .filter((r) => !r.passed)
    .map((r) => {
      const why = r.timedOut ? "timed out" : `exited with code ${r.exitCode ?? "unknown"}`;
      const tail = r.outputTail ? `\n${r.outputTail.slice(-1500)}` : "";
      return `- ${r.name} (\`${r.command}\`) ${why}${tail}`;
    })
    .join("\n");
}

function summaryLine(report: WorkerReport | null): string {
  if (!report?.summary) return "";
  const summary = report.summary.trim().replace(/\s+/g, " ");
  return `Summary: ${summary.length > 300 ? `${summary.slice(0, 297)}...` : summary}`;
}

/** How to sign an agent in again, in plain words. */
export function signInHow(agent: AgentKind): string {
  switch (agent) {
    case "claude":
      return "Run `claude` in a terminal and sign in.";
    case "codex":
      return "Run `codex login` in a terminal.";
    default:
      return "Sign the agent in again.";
  }
}
