import type { Brief } from "../goals/brief.js";
import type { CheckResult } from "../goals/checks.js";
import type { Goal, WorkerReport } from "../goals/store.js";
import type { PublishingVerdict } from "./publishing.js";
import type { LeftOut } from "./stage.js";

/** Everything landing tells the user or the Worker, in plain words. */

export function commitMessage(brief: Brief): string {
  const subject = oneLine(brief.objective, 72);
  const criteria = brief.acceptanceCriteria.map((c) => `- ${oneLine(c, 200)}`);
  return criteria.length ? `${subject}\n\nAcceptance criteria:\n${criteria.join("\n")}` : subject;
}

export function mergeCommitMessage(brief: Brief, branch: string): string {
  return `Merge: ${oneLine(brief.objective, 66)}\n\nBranch ${branch}`;
}

export function pullRequestBody(
  goal: Goal,
  report: WorkerReport | null,
  results: CheckResult[],
): string {
  const lines: string[] = [];
  const summary = report?.summary?.trim();
  lines.push("## What changed", summary || goal.brief.objective, "");
  if (goal.brief.acceptanceCriteria.length) {
    lines.push("## What it should do", ...goal.brief.acceptanceCriteria.map((c) => `- ${c}`), "");
  }
  const checks = results.filter((r) => r.source === "brief");
  if (checks.length) {
    lines.push(
      "## How it was checked",
      ...checks.map((c) => `- ${c.name}: ${c.passed ? "passes" : "fails"}`),
      "",
      "These checks were run again on the finished result, including the latest changes to the main branch, before merging.",
    );
  } else {
    lines.push("## How it was checked", "No automatic check was available.");
  }
  return lines.join("\n").slice(0, 6000);
}

export function conflictPrompt(base: string, baseSha: string, files: string[]): string {
  return [
    `Preston is merging your work into ${base}, but ${base} has changed since you started and the changes conflict in:`,
    ...files.map((f) => `- ${f}`),
    "",
    `In this folder, run \`git merge ${baseSha}\`, resolve every conflict so that both sides' intent is kept, run the project's tests, and commit the merge. Stay on your branch and do not push. Then call report_result again. Preston will check the merged result itself.`,
  ].join("\n");
}

export function failedAfterMergePrompt(base: string, evidence: string): string {
  return `Preston combined your work with the latest ${base} and re-ran the checks on the result, and some failed:\n\n${evidence}\n\nFix the cause (do not weaken the checks), commit, then call report_result again.`;
}

export function ciFailedPrompt(names: string[]): string {
  return `Your work was sent to GitHub as a pull request, and these required checks failed there:\n${names.map((n) => `- ${n}`).join("\n")}\n\nFind and fix the cause in this folder (do not weaken the checks), commit, then call report_result again. Preston will send the fix.`;
}

export function commitFailedPrompt(problem: string): string {
  return `Preston tried to save your changes with a Git commit, and Git refused: ${problem}\n\nFix what it complains about (for example a failing commit hook), commit your work, then call report_result again.`;
}

export function publishQuestion(
  goal: Goal,
  verdict: Exclude<PublishingVerdict, { verdict: "none" }>,
  base: string,
  branch: string,
  prUrl: string | null,
): string {
  const why =
    verdict.verdict === "publishes"
      ? `Merging it into ${base} will also publish something: ${verdict.reasons.join("; ")}.`
      : `Merging it into ${base} might also publish something, and I can't be sure: ${verdict.reasons.join("; ")}.`;
  const where = prUrl ? ` The pull request is ready at ${prUrl}.` : "";
  return `The work on "${oneLine(goal.brief.objective, 120)}" is finished and I've checked it.${where} ${why}\nMy recommendation: say yes if you're happy for that to go live now. If you'd rather decide yourself, say no and I'll leave the finished work on branch ${branch}.\nShall I merge it? Reply yes or no.`;
}

/** Reads the user's reply to a publish question. Anything unclear counts as no. */
export function parseYesNo(answer: string): "yes" | "no" {
  return /^\s*(y|yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|merge( it)?|please do|approved?)\b/i.test(
    answer,
  )
    ? "yes"
    : "no";
}

/** What was not committed, and where the files are when they were kept. */
export function leftOutNote(items: LeftOut[], keptIn: string | null): string {
  const generated = items.filter((i) => i.why === "generated").map((i) => i.path);
  const large = items.filter((i) => i.why === "large_binary");
  const lines: string[] = [];
  if (generated.length) {
    lines.push(
      `I left out ${list(generated)}: they look like installed or built files rather than your own work, and your project doesn't ignore them. Ignore or add them yourself if that's wrong.`,
    );
  }
  if (large.length) {
    const names = large.map((i) => `${i.path} (${Math.round((i.bytes ?? 0) / 1_048_576)} MB)`);
    const one = large.length === 1;
    lines.push(
      `I left out the very large file${one ? "" : "s"} ${list(names)}, so ${one ? "it isn't" : "they aren't"} in the merge.${keptIn ? ` ${one ? "It is" : "They are"} still in ${keptIn}.` : ""}`,
    );
  }
  return lines.join("\n");
}

function list(items: string[]): string {
  const shown = items.slice(0, 5).join(", ");
  return items.length > 5 ? `${shown} and ${items.length - 5} more` : shown;
}

export function nothingToLand(base: string): string {
  return `There were no file changes to merge into ${base}.`;
}

export function landedLocally(input: {
  base: string;
  checkout: "updated" | "updated_dirty" | "untouched";
  currentBranch: string | undefined;
  note: string | null;
}): string {
  const lines: string[] = [];
  if (input.checkout === "updated") {
    lines.push(`Merged into ${input.base} on your computer; your project folder is up to date.`);
  } else if (input.checkout === "updated_dirty") {
    lines.push(
      `Merged into ${input.base} on your computer; your project folder is up to date and your own unsaved edits were left alone.`,
    );
  } else {
    const where = input.currentBranch
      ? `you're on ${input.currentBranch}`
      : "you're not on a branch";
    lines.push(
      `Merged into ${input.base} on your computer. Because ${where}, I left your folder exactly as it was; ${input.base} has the new work.`,
    );
  }
  if (input.note) lines.push(input.note);
  return lines.join("\n");
}

export function landedOnGitHub(input: {
  url: string;
  base: string;
  local: "updated" | "behind";
}): string {
  const tail =
    input.local === "updated"
      ? ` Your copy of ${input.base} on this computer is up to date.`
      : ` Your copy of ${input.base} on this computer hasn't been updated yet; it will catch up the next time you pull.`;
  return `Merged on GitHub: ${input.url}.${tail}`;
}

export function heldMessage(input: {
  branch: string;
  prUrl: string | null;
  worktreePath: string | null;
}): string {
  const where = input.prUrl ? ` The pull request is open at ${input.prUrl}.` : "";
  const folder = input.worktreePath ? ` The files are in ${input.worktreePath}.` : "";
  return `I didn't merge it, as you said. The finished work is saved on branch ${input.branch}.${where}${folder}`;
}

export function unlandedNote(branch: string, worktreePath: string | null): string {
  const folder = worktreePath ? ` The files are in ${worktreePath}.` : "";
  return `I haven't merged it, because I couldn't check it myself. The changes are saved on branch ${branch}.${folder}`;
}

export function inPlaceNote(reason: string): string {
  return `Because ${reason}, I worked directly in your project folder, as you allowed.`;
}

function oneLine(text: string, max: number): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
