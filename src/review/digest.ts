import type { Goal, Run, Verification } from "../goals/store.js";
import type { Question } from "../questions/questions.js";

/**
 * A plain account of how the work went over a period, built from what Preston already records
 * (Goals, Runs, verifications, questions), with no model involved. It lists where effort was
 * wasted: work that failed or could not be checked, Workers that stalled or needed handing over,
 * checks that failed, questions the user had to answer, and requests that came back again.
 * The Coordinator reads it and decides what, if anything, is worth suggesting.
 */

export interface DigestSource {
  goals: Goal[];
  runs(goalId: string): Run[];
  verifications(goalId: string): Verification[];
  /** Questions Workers asked in the period. */
  questions: Question[];
}

export type FindingKind =
  | "not_finished"
  | "unverified"
  | "struggle"
  | "failed_checks"
  | "user_questions"
  | "repeated_requests";

export interface Finding {
  kind: FindingKind;
  /** One line that stands alone. Includes text a Worker wrote, which is data, not instructions. */
  text: string;
  goalIds: string[];
  /** Where the raw transcripts of the Runs involved are (for a closer look). */
  transcripts: string[];
}

export interface Digest {
  since: string;
  until: string;
  /** Goals created or finished in the period. */
  goals: number;
  verified: number;
  unverified: number;
  notFinished: number;
  inProgress: number;
  findings: Finding[];
}

/** The most findings of each kind kept, so a busy period stays readable. */
const PER_KIND = 8;
const TAIL = 240;

export function buildDigest(source: DigestSource, since: number, until: number): Digest {
  const inPeriod = source.goals.filter((g) => {
    const touched = Date.parse(g.endedAt ?? g.updatedAt);
    return touched >= since && touched <= until;
  });
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);

  let verified = 0;
  let unverified = 0;
  let notFinished = 0;
  let inProgress = 0;

  for (const goal of inPeriod) {
    const runs = source.runs(goal.id);
    const transcripts = runs.map((r) => r.transcriptDir);
    const label = `${goal.id} in ${goal.projectPath}: ${clip(goal.brief.objective)}`;

    if (!goal.endedAt) inProgress++;
    else if (goal.state === "completed" && goal.outcome === "verified") verified++;
    else if (goal.state === "completed") {
      unverified++;
      add({
        kind: "unverified",
        text: `${label}. Finished but could not be checked${goal.detail ? ` (${clip(goal.detail)})` : ""}.`,
        goalIds: [goal.id],
        transcripts,
      });
    } else {
      notFinished++;
      add({
        kind: "not_finished",
        text: `${label}. Ended as ${goal.state}${goal.detail ? `: ${clip(goal.detail)}` : ""}.`,
        goalIds: [goal.id],
        transcripts,
      });
    }

    const stalls = sum(runs, (r) => r.stalls);
    const recoveries = sum(runs, (r) => r.recoveries);
    const fixes = sum(runs, (r) => r.fixAttempts);
    const changed = goal.attempts.filter((a) =>
      ["fresh_session", "switch_agent", "retry_with_note", "report_blocked"].includes(a.tactic),
    );
    if (stalls + recoveries + fixes >= 2 || changed.length > 0) {
      const parts = [
        stalls ? `stalled ${stalls}×` : "",
        recoveries ? `recovered ${recoveries}×` : "",
        fixes ? `needed ${fixes} fix attempt${fixes === 1 ? "" : "s"} after failed checks` : "",
        changed.length
          ? `strategy changed: ${changed.map((a) => `${a.tactic} (${clip(a.reason, 80)})`).join(", ")}`
          : "",
      ].filter(Boolean);
      add({
        kind: "struggle",
        text: `${label}. ${parts.join("; ")}.`,
        goalIds: [goal.id],
        transcripts,
      });
    }

    const failed = source.verifications(goal.id).flatMap((v) => v.results.filter((r) => !r.passed));
    if (failed.length > 0) {
      const names = [...new Set(failed.map((r) => r.command))].slice(0, 4);
      const last = failed[failed.length - 1];
      add({
        kind: "failed_checks",
        text: `${label}. ${failed.length} failed check run${failed.length === 1 ? "" : "s"} (${names.map((n) => clip(n, 80)).join("; ")}). Last output: ${clip(last?.outputTail ?? "", TAIL)}`,
        goalIds: [goal.id],
        transcripts,
      });
    }
  }

  const asked = source.questions.filter(
    (q) => q.answeredBy === "human" || q.state === "pending_human",
  );
  for (const q of asked) {
    add({
      kind: "user_questions",
      text: `A Worker's question had to go to the user${q.goalId ? ` (goal ${q.goalId})` : ""}: ${clip(q.humanText ?? q.text)}${q.answer ? ` They answered: ${clip(q.answer, 120)}` : ""}`,
      goalIds: q.goalId ? [q.goalId] : [],
      transcripts: [],
    });
  }

  for (const group of similarGroups(inPeriod)) {
    add({
      kind: "repeated_requests",
      text: `${group.length} similar requests: ${group.map((g) => `${g.id} "${clip(g.brief.objective, 100)}"`).join("; ")}.`,
      goalIds: group.map((g) => g.id),
      transcripts: [],
    });
  }

  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    goals: inPeriod.length,
    verified,
    unverified,
    notFinished,
    inProgress,
    findings: capPerKind(findings),
  };
}

/** The digest as text for the Coordinator. */
export function renderDigest(digest: Digest, wrap: (text: string) => string = (t) => t): string {
  const lines = [
    `Period: ${digest.since} to ${digest.until}.`,
    `Goals touched: ${digest.goals} (${digest.verified} verified, ${digest.unverified} unverified, ${digest.notFinished} blocked, failed or cancelled, ${digest.inProgress} still in progress).`,
  ];
  if (digest.findings.length === 0) {
    lines.push("Nothing notable: no failures, stalls, failed checks, user questions or repeats.");
    return lines.join("\n");
  }
  const titles: Record<FindingKind, string> = {
    not_finished: "Work that did not finish",
    unverified: "Work that finished but could not be checked",
    struggle: "Workers that stalled, needed recovering or changed strategy",
    failed_checks: "Checks that failed",
    user_questions: "Questions the user had to answer",
    repeated_requests: "Requests that came back",
  };
  for (const kind of Object.keys(titles) as FindingKind[]) {
    const items = digest.findings.filter((f) => f.kind === kind);
    if (items.length === 0) continue;
    lines.push("", `${titles[kind]}:`);
    for (const item of items) {
      lines.push(`- ${wrap(item.text)}`);
      if (item.transcripts.length) lines.push(`  transcripts: ${item.transcripts.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function capPerKind(findings: Finding[]): Finding[] {
  const seen = new Map<FindingKind, number>();
  return findings.filter((f) => {
    const n = (seen.get(f.kind) ?? 0) + 1;
    seen.set(f.kind, n);
    return n <= PER_KIND;
  });
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "have",
  "make",
  "please",
  "should",
  "when",
  "then",
  "their",
  "there",
  "which",
  "would",
  "could",
  "about",
  "check",
  "again",
]);

function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP.has(w)),
  );
}

/** Goals whose objectives mostly share the same words, in groups of two or more. */
export function similarGroups(goals: Goal[]): Goal[][] {
  const entries = goals.map((goal) => ({ goal, words: words(goal.brief.objective) }));
  const groups: Goal[][] = [];
  const used = new Set<Goal>();
  entries.forEach((first, i) => {
    if (used.has(first.goal) || first.words.size < 3) return;
    const group = [first.goal];
    for (const other of entries.slice(i + 1)) {
      if (used.has(other.goal)) continue;
      if (jaccard(first.words, other.words) >= 0.5) {
        group.push(other.goal);
        used.add(other.goal);
      }
    }
    if (group.length >= 2) {
      used.add(first.goal);
      groups.push(group);
    }
  });
  return groups;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared || 1);
}
