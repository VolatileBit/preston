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

export function pausedForSignInMessage(goal: Goal, agent: string): string {
  return `Paused: ${goal.brief.objective}\n${agent} needs you to sign in again. Once you have, say "resume".`;
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
