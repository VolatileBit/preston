import { z } from "zod";

export const checkSchema = z.strictObject({
  name: z.string().min(1).describe("Short plain-language name, e.g. 'tests pass'"),
  command: z
    .string()
    .min(1)
    .describe("Shell command Preston runs itself in the Project folder; exit code 0 means pass"),
});

/** The agreed statement of a Goal. */
export const briefSchema = z.strictObject({
  objective: z.string().min(1).describe("The outcome, in one or two plain sentences"),
  scope: z.string().default("").describe("What is in and out of scope"),
  acceptanceCriteria: z
    .array(z.string().min(1))
    .default([])
    .describe("Criteria checkable without a human"),
  checks: z.array(checkSchema).default([]).describe("Executable checks for the criteria"),
  authority: z
    .string()
    .default(
      "Work inside the Project only. Do not publish, deploy, push, spend money, or delete anything outside the Project.",
    )
    .describe("Limits of authority: what the Worker may do without asking"),
});

export type Brief = z.infer<typeof briefSchema>;
export type Check = z.infer<typeof checkSchema>;

/** The Brief as the Worker's first prompt. */
export function renderBrief(goalId: string, brief: Brief): string {
  const lines = [`Goal ${goalId}`, "", `Objective: ${brief.objective}`];
  if (brief.scope) lines.push("", `Scope: ${brief.scope}`);
  if (brief.acceptanceCriteria.length) {
    lines.push("", "Acceptance criteria:", ...brief.acceptanceCriteria.map((c) => `- ${c}`));
  }
  if (brief.checks.length) {
    lines.push(
      "",
      "Preston will verify the result itself by running these commands in this folder:",
      ...brief.checks.map((c) => `- ${c.name}: ${c.command}`),
    );
  }
  lines.push("", `Authority: ${brief.authority}`);
  lines.push(
    "",
    "Own the plan, implementation and testing. When you are finished, or genuinely blocked, call report_result.",
  );
  return lines.join("\n");
}
