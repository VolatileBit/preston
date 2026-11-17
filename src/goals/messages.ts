import { pick } from "../i18n/index.js";
import type { AgentKind } from "../workers/types.js";
import type { CheckResult } from "./checks.js";
import type { Goal, WorkerReport } from "./store.js";

/** Everything Preston tells the user about Goals unprompted: short and plain. */

export function verifiedMessage(
  goal: Goal,
  results: CheckResult[],
  report: WorkerReport | null,
): string {
  const checks = results.filter((r) => r.source === "brief");
  const one = checks.length === 1;
  return [
    pick({
      en: `Done and verified: ${goal.brief.objective}`,
      "zh-CN": `已完成并验证：${goal.brief.objective}`,
    }),
    pick({
      en: `I re-ran ${one ? "the check" : `all ${checks.length} checks`} myself and ${one ? "it passes" : "they pass"}.`,
      "zh-CN": `我亲自重新运行了${one ? "这项检查" : `全部 ${checks.length} 项检查`}，${one ? "它通过了" : "全部通过"}。`,
    }),
    summaryLine(report),
  ]
    .filter(Boolean)
    .join("\n");
}

export function unverifiedMessage(goal: Goal, report: WorkerReport | null): string {
  return [
    pick({
      en: `Done, but unverified: ${goal.brief.objective}`,
      "zh-CN": `已完成，但未验证：${goal.brief.objective}`,
    }),
    pick({
      en: "There was no check I could run myself, so please take a look.",
      "zh-CN": "我没有可以亲自运行的检查，所以请您自己看一下。",
    }),
    summaryLine(report),
  ]
    .filter(Boolean)
    .join("\n");
}

export function blockedMessage(goal: Goal, reason: string): string {
  return pick({
    en: `Blocked: ${goal.brief.objective}\n${reason}`,
    "zh-CN": `被阻塞：${goal.brief.objective}\n${reason}`,
  });
}

export function failedMessage(goal: Goal, reason: string): string {
  return pick({
    en: `I couldn't finish: ${goal.brief.objective}\n${reason}`,
    "zh-CN": `未能完成：${goal.brief.objective}\n${reason}`,
  });
}

/** Told once when a quota wait is expected to delay a Goal noticeably. */
export function quotaWaitMessage(goal: Goal, agent: string, until: string | undefined): string {
  return pick({
    en: until
      ? `Waiting: ${goal.brief.objective}\n${agent} is out of quota until ${until}. I'll continue automatically then.`
      : `Waiting: ${goal.brief.objective}\n${agent} is out of quota and didn't say when it resets. I'm checking regularly and will continue automatically.`,
    "zh-CN": until
      ? `等待中：${goal.brief.objective}\n${agent} 的额度已用完，将在 ${until} 恢复。届时我会自动继续。`
      : `等待中：${goal.brief.objective}\n${agent} 的额度已用完，且没有说明何时重置。我会定期检查，恢复后自动继续。`,
  });
}

export function spendLimitMessage(goal: Goal, agent: string): string {
  return pick({
    en: `Waiting: ${goal.brief.objective}\n${agent} has reached its spending limit. I won't buy credits or turn on paid usage. I'll continue when it has quota again; if you raise the limit yourself, say "resume".`,
    "zh-CN": `等待中：${goal.brief.objective}\n${agent} 已达到消费上限。我不会购买额度或开启付费用量。额度恢复后我会继续；如果您自己提高了上限，请说“resume”。`,
  });
}

export function signInMessage(goal: Goal, agent: string, how: string): string {
  return pick({
    en: `Blocked until you sign in: ${goal.brief.objective}\n${agent} is signed out, so I can't continue. ${how} I'll pick it up automatically once you have.`,
    "zh-CN": `需要您登录后才能继续：${goal.brief.objective}\n${agent} 已退出登录，我无法继续。${how} 您登录后我会自动接着做。`,
  });
}

export function handoverMessage(
  goal: Goal,
  from: string,
  to: string,
  until: string | undefined,
): string {
  return pick({
    en: `Switched to ${to}: ${goal.brief.objective}\n${from} is out of quota${until ? ` until ${until}` : ""}, so ${to} is continuing from the current state of the work.`,
    "zh-CN": `已切换到 ${to}：${goal.brief.objective}\n${from} 的额度已用完${until ? `（${until} 恢复）` : ""}，所以由 ${to} 从当前进度继续。`,
  });
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
  const text = summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
  return pick({ en: `Summary: ${text}`, "zh-CN": `摘要：${text}` });
}

/** How to sign an agent in again, in plain words. */
export function signInHow(agent: AgentKind): string {
  switch (agent) {
    case "claude":
      return pick({
        en: "Run `claude` in a terminal and sign in.",
        "zh-CN": "请在终端运行 `claude` 并登录。",
      });
    case "codex":
      return pick({
        en: "Run `codex login` in a terminal.",
        "zh-CN": "请在终端运行 `codex login`。",
      });
    default:
      return pick({ en: "Sign the agent in again.", "zh-CN": "请重新登录该助手。" });
  }
}
