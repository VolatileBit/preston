/**
 * Appended to a Worker's own system prompt. It adds how to work with Preston and never
 * overrides the agent's native instructions or the Project's own rules.
 */
export const WORKER_GUIDANCE = `You are working on a Goal that Preston, the user's chief of staff, delegated to you. Your own instructions, the Project's rules (such as CLAUDE.md or AGENTS.md) and your safeguards still apply and take precedence; this only adds how to work with Preston.

- Own the whole plan, implement, test and fix cycle. Work autonomously within the Brief.
- If you need a decision you cannot settle from the Brief or the Project, call ask_preston with one clear question. If Preston says the question is parked, finish everything that does not depend on the answer, then end your turn; Preston will resume this session with the answer.
- When the work is finished, or you are genuinely blocked, call report_result with a short summary, the checks you performed, commands Preston can run itself in this folder to verify the result, and any blockers. Preston re-runs the checks itself, so only report what you actually verified.
- Stay inside this folder. Do not publish, deploy, push to shared branches, spend money or delete anything outside the Project unless the Brief's authority explicitly allows it.`;

/** Returned by ask_preston when the answer needs the user. */
export const PARKED_INSTRUCTION =
  "Preston has asked the user and the answer is not available yet. Finish everything that does not depend on the answer, then end your turn without calling report_result. Preston will resume this session with the answer.";

export function answerPrompt(answers: { question: string; answer: string }[]): string {
  const lines = answers.map((a) => `Your question: ${a.question}\nAnswer: ${a.answer}`);
  return `Preston has the answer${answers.length > 1 ? "s" : ""} you were waiting for.\n\n${lines.join("\n\n")}\n\nContinue the Goal. Call report_result when you are finished.`;
}

export const RECOVERY_PROMPT =
  "Preston was interrupted (a restart or an unexpected exit) while you were working on this Goal. Check the current state of the work, continue from where it stands without redoing work that is already done, and call report_result when you are finished.";

export const RESUME_AFTER_PAUSE_PROMPT =
  "The user paused this Goal and has now resumed it. Check the current state of the work, continue, and call report_result when you are finished.";

export const QUOTA_RESUME_PROMPT =
  "Quota restored; continue from where you stopped. Verify the current state of the work first (files, tests, git status) and do not redo work that is already done. Call report_result when you are finished.";

export const SIGNED_IN_RESUME_PROMPT =
  "You are signed in again, so Preston is resuming this Goal. Continue from where you stopped. Verify the current state of the work first and do not redo work that is already done. Call report_result when you are finished.";

export const RATE_LIMIT_RESUME_PROMPT =
  "The provider briefly rate-limited your requests; that has passed. Continue from where you stopped, checking the current state of the work first. Call report_result when you are finished.";

export const STALL_RESUME_PROMPT =
  "Preston stopped your last turn because it showed no activity for a long time. Check the current state of the work, continue from where it stands without redoing finished work, and avoid whatever you were waiting on (for example an interactive prompt or a command that never returns). Call report_result when you are finished.";

export function strategyNotePrompt(note: string): string {
  return `Preston is changing approach on this Goal after repeated stalls. Guidance:\n\n${note}\n\nCheck the current state of the work first, then continue. Call report_result when you are finished.`;
}

/** The first prompt of a new Session that takes over a Goal from another agent or Session. */
export function handoverPrompt(input: {
  brief: string;
  reason: string;
  previousAgent: string;
  previousReport?: string | undefined;
  lastMessage?: string | undefined;
  note?: string | undefined;
}): string {
  const lines = [
    input.brief,
    "",
    `Handover: ${input.previousAgent} worked on this Goal before you and stopped (${input.reason}). Its work so far is in this folder. You are starting a new session, so you do not have its context, and its work may be incomplete or wrong.`,
  ];
  if (input.previousReport) lines.push("", `Its last report: ${input.previousReport}`);
  if (input.lastMessage) lines.push("", `Its last message: ${input.lastMessage}`);
  if (input.note) lines.push("", `Guidance from Preston: ${input.note}`);
  lines.push(
    "",
    "First inspect the current state (git status and diff where there is a repository, the files, and the tests), keep work that is done and correct, then finish the Goal and call report_result.",
  );
  return lines.join("\n");
}

export const REPORT_REMINDER_PROMPT =
  "You ended your turn without calling report_result. If the work is finished, call report_result now. Otherwise continue the Goal and call report_result when you are finished.";

export function briefChangedPrompt(brief: string): string {
  return `The user updated the Brief while you were working. Here is the current Brief:\n\n${brief}\n\nMake sure the work satisfies it, then call report_result again.`;
}

export function failedChecksPrompt(evidence: string): string {
  return `Preston re-ran the verification checks itself and some failed:\n\n${evidence}\n\nFix the cause (do not weaken the checks), then call report_result again.`;
}
