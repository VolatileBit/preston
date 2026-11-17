import { pick } from "../i18n/index.js";
import type { Question } from "../questions/questions.js";
import type { Bucket } from "../quota/store.js";
import { formatResetTime } from "../quota/time.js";
import type { Goal, GoalState } from "./store.js";

const STATE_WORDS: Record<GoalState, { en: string; "zh-CN": string }> = {
  queued: { en: "starting", "zh-CN": "正在启动" },
  running: { en: "working", "zh-CN": "进行中" },
  verifying: { en: "checking the result", "zh-CN": "正在检查结果" },
  completed: { en: "done", "zh-CN": "已完成" },
  waiting_for_quota: { en: "waiting for agent quota", "zh-CN": "等待助手额度" },
  waiting_for_user: { en: "waiting for your answer", "zh-CN": "等待您的回答" },
  waiting_for_login: { en: "waiting for you to sign in", "zh-CN": "等待您登录" },
  recovering: { en: "recovering", "zh-CN": "正在恢复" },
  paused: { en: "paused", "zh-CN": "已暂停" },
  blocked: { en: "blocked", "zh-CN": "被阻塞" },
  failed: { en: "failed", "zh-CN": "失败" },
  cancelled: { en: "stopped", "zh-CN": "已停止" },
};

export function describeGoalState(goal: Goal): string {
  if (goal.state === "completed") {
    return goal.outcome === "verified"
      ? pick({ en: "verified", "zh-CN": "已验证" })
      : pick({ en: "unverified", "zh-CN": "未验证" });
  }
  return pick(STATE_WORDS[goal.state]);
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
      return pick({
        en: `${label} needs you to sign in again.`,
        "zh-CN": `${label} 需要您重新登录。`,
      });
    case "spend_blocked":
      return pick({
        en: `${label} has reached its spending limit; I won't buy more.`,
        "zh-CN": `${label} 已达到消费上限；我不会追加购买。`,
      });
    default:
      return bucket.resetsAt && Date.parse(bucket.resetsAt) > now
        ? pick({
            en: `${label} is out of quota until ${formatResetTime(bucket.resetsAt, now)}.`,
            "zh-CN": `${label} 的额度已用完，将在 ${formatResetTime(bucket.resetsAt, now)} 恢复。`,
          })
        : pick({
            en: `${label} is out of quota; I'm checking regularly.`,
            "zh-CN": `${label} 的额度已用完；我会定期检查。`,
          });
  }
}

/** "2 Goals running, 1 waiting for quota." */
function goalCounts(active: Goal[]): string {
  const count = (states: GoalState[]) => active.filter((g) => states.includes(g.state)).length;
  const parts = [
    [count(["queued", "running", "verifying", "recovering"]), { en: "running", "zh-CN": "进行中" }],
    [count(["waiting_for_quota"]), { en: "waiting for quota", "zh-CN": "等待额度" }],
    [count(["waiting_for_login"]), { en: "waiting for you to sign in", "zh-CN": "等待您登录" }],
    [count(["waiting_for_user"]), { en: "waiting for your answer", "zh-CN": "等待您的回答" }],
    [count(["paused"]), { en: "paused", "zh-CN": "已暂停" }],
  ] as const;
  const said = parts.filter(([n]) => n > 0);
  if (!said.length) return pick({ en: "No Goals in progress.", "zh-CN": "目前没有进行中的目标。" });
  const zh = said.map(([n, words]) => `${n} 个${pick(words)}`).join("，");
  const en = said
    .map(([n, words], i) =>
      i === 0 ? `${n} ${n === 1 ? "Goal" : "Goals"} ${words.en}` : `${n} ${words.en}`,
    )
    .join(", ");
  return pick({ en: `${en}.`, "zh-CN": `${zh}。` });
}

/** The deterministic answer to "status". Never calls a model. */
export function statusText(
  goals: Goal[],
  questions: Question[],
  blocks: AgentBlock[] = [],
  now = Date.now(),
  /** The agent a Goal is on, named when the user has more than one. */
  agentOf: (goal: Goal) => string | undefined = () => undefined,
  /** One short line per agent CLI: its version and how keeping it current is going. */
  cliLines: string[] = [],
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
        pick({ en: "In progress:", "zh-CN": "进行中：" }),
        ...active.map((g) => {
          const agent = agentOf(g);
          const on = agent ? pick({ en: `, on ${agent}`, "zh-CN": `，使用 ${agent}` }) : "";
          return `- ${g.brief.objective} (${describeGoalState(g)}${on})`;
        }),
      ].join("\n"),
    );
  }
  const waiting = questions.filter((q) => q.state === "pending_human");
  if (waiting.length) {
    sections.push(
      [
        pick({ en: "Waiting for your answer:", "zh-CN": "等待您的回答：" }),
        ...waiting.map((q) => `- ${q.humanText ?? q.text}`),
      ].join("\n"),
    );
  }
  if (finished.length) {
    sections.push(
      [
        pick({ en: "Recent results:", "zh-CN": "最近的结果：" }),
        ...finished.map((g) => {
          const detail = g.detail && g.state !== "completed" ? ` - ${g.detail}` : "";
          return `- ${g.brief.objective} (${describeGoalState(g)})${detail}`;
        }),
      ].join("\n"),
    );
  }
  const main = sections.length
    ? sections.join("\n\n")
    : pick({
        en: "Nothing in progress. Tell me what you'd like done.",
        "zh-CN": "目前没有进行中的事项。告诉我您想做什么吧。",
      });
  return cliLines.length
    ? `${main}\n\n${pick({ en: "Agent CLIs:", "zh-CN": "助手命令行工具：" })}\n${cliLines.map((l) => `- ${l}`).join("\n")}`
    : main;
}
