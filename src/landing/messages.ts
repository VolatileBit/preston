import type { Brief } from "../goals/brief.js";
import type { CheckResult } from "../goals/checks.js";
import type { Goal, WorkerReport } from "../goals/store.js";
import { pick } from "../i18n/index.js";
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
  const reasons = verdict.reasons.join("; ");
  const name = oneLine(goal.brief.objective, 120);
  const publishes = verdict.verdict === "publishes";
  return pick({
    en: `The work on "${name}" is finished and I've checked it.${prUrl ? ` The pull request is ready at ${prUrl}.` : ""} ${
      publishes
        ? `Merging it into ${base} will also publish something: ${reasons}.`
        : `Merging it into ${base} might also publish something, and I can't be sure: ${reasons}.`
    }\nMy recommendation: say yes if you're happy for that to go live now. If you'd rather decide yourself, say no and I'll leave the finished work on branch ${branch}.\nShall I merge it? Reply yes or no.`,
    "zh-CN": `“${name}”的工作已完成，我也检查过了。${prUrl ? `拉取请求已就绪：${prUrl}。` : ""}${
      publishes
        ? `把它合并到 ${base} 还会同时发布一些内容：${reasons}。`
        : `把它合并到 ${base} 可能还会同时发布一些内容，我无法确定：${reasons}。`
    }\n我的建议：如果您愿意让它现在上线，请回答“是”。如果您想自己决定，请回答“否”，我会把完成的工作保留在分支 ${branch} 上。\n要我合并吗？请回复“是”或“否”（yes / no）。`,
  });
}

/** Reads the user's reply to a publish question. Anything unclear counts as no. */
export function parseYesNo(answer: string): "yes" | "no" {
  const english =
    /^\s*(y|yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|merge( it)?|please do|approved?)\b/i;
  // Chinese has no word boundaries; "不" and "否" lead the negatives, which never match here.
  const chinese = /^\s*(是的?|好的?|可以|行|同意|确认|合并|没问题|嗯)(?![不否])/;
  return english.test(answer) || chinese.test(answer) ? "yes" : "no";
}

/** What was not committed, and where the files are when they were kept. */
export function leftOutNote(items: LeftOut[], keptIn: string | null): string {
  const generated = items.filter((i) => i.why === "generated").map((i) => i.path);
  const large = items.filter((i) => i.why === "large_binary");
  const lines: string[] = [];
  if (generated.length) {
    lines.push(
      pick({
        en: `I left out ${list(generated)}: they look like installed or built files rather than your own work, and your project doesn't ignore them. Ignore or add them yourself if that's wrong.`,
        "zh-CN": `我没有包含 ${list(generated)}：它们看起来是安装或构建生成的文件，而不是您自己的工作，而且您的项目没有忽略它们。如果我判断有误，请自行忽略或添加。`,
      }),
    );
  }
  if (large.length) {
    const names = large.map((i) => `${i.path} (${Math.round((i.bytes ?? 0) / 1_048_576)} MB)`);
    const one = large.length === 1;
    lines.push(
      pick({
        en: `I left out the very large file${one ? "" : "s"} ${list(names)}, so ${one ? "it isn't" : "they aren't"} in the merge.${keptIn ? ` ${one ? "It is" : "They are"} still in ${keptIn}.` : ""}`,
        "zh-CN": `我没有包含超大文件 ${list(names)}，所以它们不在这次合并里。${keptIn ? `它们仍保留在 ${keptIn}。` : ""}`,
      }),
    );
  }
  return lines.join("\n");
}

function list(items: string[]): string {
  const shown = items.slice(0, 5).join(", ");
  return items.length > 5
    ? pick({
        en: `${shown} and ${items.length - 5} more`,
        "zh-CN": `${shown} 等另外 ${items.length - 5} 项`,
      })
    : shown;
}

export function nothingToLand(base: string): string {
  return pick({
    en: `There were no file changes to merge into ${base}.`,
    "zh-CN": `没有需要合并到 ${base} 的文件改动。`,
  });
}

export function landedLocally(input: {
  base: string;
  checkout: "updated" | "updated_dirty" | "untouched";
  currentBranch: string | undefined;
  note: string | null;
}): string {
  const lines: string[] = [];
  if (input.checkout === "updated") {
    lines.push(
      pick({
        en: `Merged into ${input.base} on your computer; your project folder is up to date.`,
        "zh-CN": `已在您的电脑上合并到 ${input.base}；您的项目文件夹已是最新。`,
      }),
    );
  } else if (input.checkout === "updated_dirty") {
    lines.push(
      pick({
        en: `Merged into ${input.base} on your computer; your project folder is up to date and your own unsaved edits were left alone.`,
        "zh-CN": `已在您的电脑上合并到 ${input.base}；您的项目文件夹已是最新，您自己尚未保存的修改原样保留。`,
      }),
    );
  } else {
    lines.push(
      pick({
        en: `Merged into ${input.base} on your computer. Because ${
          input.currentBranch ? `you're on ${input.currentBranch}` : "you're not on a branch"
        }, I left your folder exactly as it was; ${input.base} has the new work.`,
        "zh-CN": `已在您的电脑上合并到 ${input.base}。因为${
          input.currentBranch ? `您当前在 ${input.currentBranch} 分支` : "您当前不在任何分支上"
        }，我没有改动您的文件夹；新的工作在 ${input.base} 里。`,
      }),
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
  const updated = input.local === "updated";
  return pick({
    en: `Merged on GitHub: ${input.url}.${
      updated
        ? ` Your copy of ${input.base} on this computer is up to date.`
        : ` Your copy of ${input.base} on this computer hasn't been updated yet; it will catch up the next time you pull.`
    }`,
    "zh-CN": `已在 GitHub 上合并：${input.url}。${
      updated
        ? `这台电脑上的 ${input.base} 已是最新。`
        : `这台电脑上的 ${input.base} 还没有更新；下次执行 pull 时会同步。`
    }`,
  });
}

export function heldMessage(input: {
  branch: string;
  prUrl: string | null;
  worktreePath: string | null;
}): string {
  return pick({
    en: `I didn't merge it, as you said. The finished work is saved on branch ${input.branch}.${input.prUrl ? ` The pull request is open at ${input.prUrl}.` : ""}${input.worktreePath ? ` The files are in ${input.worktreePath}.` : ""}`,
    "zh-CN": `按您的意思，我没有合并。完成的工作保存在分支 ${input.branch} 上。${input.prUrl ? `拉取请求已打开：${input.prUrl}。` : ""}${input.worktreePath ? `文件在 ${input.worktreePath}。` : ""}`,
  });
}

export function unlandedNote(branch: string, worktreePath: string | null): string {
  return pick({
    en: `I haven't merged it, because I couldn't check it myself. The changes are saved on branch ${branch}.${worktreePath ? ` The files are in ${worktreePath}.` : ""}`,
    "zh-CN": `我没有合并，因为我无法亲自检查它。改动保存在分支 ${branch} 上。${worktreePath ? `文件在 ${worktreePath}。` : ""}`,
  });
}

export function inPlaceNote(reason: string): string {
  return pick({
    en: `Because ${reason}, I worked directly in your project folder, as you allowed.`,
    "zh-CN": `因为${reason}，我按您的许可直接在您的项目文件夹里工作。`,
  });
}

function oneLine(text: string, max: number): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
