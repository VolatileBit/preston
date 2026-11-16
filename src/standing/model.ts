import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Where a standing order applies. `global` is everywhere; `project` is a folder and everything
 * inside it; `schedule` is the Goals one schedule starts.
 */
export const scopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal("schedule"), scheduleId: z.string().min(1) }),
]);
export type Scope = z.infer<typeof scopeSchema>;

/**
 * When it applies: `always` (the Coordinator and every Goal in scope), `goal` (Workers on Goals
 * in scope), `schedule` (Goals started by a schedule), `message` (the Coordinator, when answering
 * the user). Optional keywords narrow it to Goals whose objective or scope mentions one of them.
 */
export const TRIGGERS = ["always", "goal", "schedule", "message"] as const;
export const triggerSchema = z.strictObject({
  on: z.enum(TRIGGERS).default("always"),
  keywords: z.array(z.string().min(1).max(60)).max(10).default([]),
});

/**
 * The typed flags other modules read through `StandingOrders.effectivePolicy`. Keep this set
 * small; every flag needs a documented default and a consumer.
 */
export const policyFlagsSchema = z.strictObject({
  /** Merging may go ahead without asking even when it would also publish something. */
  "landing.autoMergePublishing": z.boolean().optional(),
});
export type PolicyFlags = z.infer<typeof policyFlagsSchema>;

const line = (max: number) => z.string().trim().min(1).max(max);

export const definitionSchema = z.strictObject({
  title: line(80),
  scope: scopeSchema.default({ kind: "global" }),
  trigger: triggerSchema.prefault({}),
  /** What Preston may do without asking. */
  authority: z.string().trim().max(400).default(""),
  /** Rules about how to work. */
  constraints: z.array(line(240)).max(8).default([]),
  /** When to stop and ask the user. */
  escalation: z.array(line(240)).max(8).default([]),
  policy: policyFlagsSchema.default({}),
});
export type Definition = z.infer<typeof definitionSchema>;

export interface StandingOrder {
  id: string;
  version: number;
  enabled: boolean;
  /** `default` for the orders Preston ships with, otherwise `user`. */
  origin: "default" | "user";
  definition: Definition;
  reason: string;
  /** When this version was recorded. */
  updatedAt: string;
}

export interface OrderVersion {
  version: number;
  enabled: boolean;
  reason: string;
  createdAt: string;
  definition: Definition;
}

/** Where and for whom orders are being gathered. */
export interface OrderContext {
  audience: "worker" | "coordinator";
  projectPath?: string | undefined;
  scheduleId?: string | undefined;
  /** The Goal's objective and scope, matched against keywords. */
  text?: string | undefined;
}

/** What every flag means when no enabled order sets it. */
export interface EffectivePolicy {
  landing: { autoMergePublishing: boolean };
}

/** `global`, `project:<absolute path>` or `schedule:<id>`, as the Coordinator writes scopes. */
export function parseScope(text: string): Scope {
  const value = text.trim();
  if (value === "" || value === "global") return { kind: "global" };
  if (value.startsWith("project:")) {
    const path = value.slice("project:".length).trim();
    if (!isAbsolute(path)) throw new Error("A project scope needs an absolute folder path.");
    return { kind: "project", path };
  }
  if (value.startsWith("schedule:")) {
    const scheduleId = value.slice("schedule:".length).trim();
    if (!scheduleId) throw new Error("A schedule scope needs a schedule ID.");
    return { kind: "schedule", scheduleId };
  }
  throw new Error('Scope must be "global", "project:<absolute folder>" or "schedule:<id>".');
}

export function scopeText(scope: Scope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "project":
      return `project:${scope.path}`;
    case "schedule":
      return `schedule:${scope.scheduleId}`;
  }
}
