import { z } from "zod";

export const agentKindSchema = z.enum(["claude", "codex", "fake"]);

const modelSettings = {
  /** Unset means: inherit the user's own CLI configuration (or the Coordinator default). */
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
};

/**
 * Preston's config file (`<home>/config.json`). Plain text, owner-only. Unknown keys are
 * rejected so typos are caught; Channel sections are validated by each Channel.
 */
export const configSchema = z.strictObject({
  agents: z
    .strictObject({
      /** Agent CLIs Preston may use, in order of preference. */
      enabled: z.array(agentKindSchema).default([]),
      /** With more than one agent: spread work across them by remaining quota. */
      balanceByQuota: z.boolean().default(false),
    })
    .prefault({}),
  coordinator: z
    .strictObject({
      agent: agentKindSchema.optional(),
      ...modelSettings,
    })
    .prefault({}),
  workers: z.strictObject(modelSettings).prefault({}),
  verification: z
    .strictObject({
      checkTimeoutMs: z.number().int().positive().default(600_000),
      /** How many times a Worker is resumed with failing-check evidence before reporting. */
      maxFixAttempts: z.number().int().min(0).max(5).default(1),
    })
    .prefault({}),
  recovery: z
    .strictObject({
      /** Unexpected exits tolerated per Run before the Goal is reported as failed. */
      maxAttempts: z.number().int().min(0).max(10).default(3),
    })
    .prefault({}),
  questions: z
    .strictObject({
      /** How long `ask_preston` waits for the Coordinator before parking the Worker. */
      workerWaitMs: z.number().int().positive().default(45_000),
    })
    .prefault({}),
  approvals: z
    .strictObject({
      /**
       * How long an escalated approval keeps the Worker waiting for a decision. After that the
       * request is declined for now; a later "allow" resumes the Worker's Session.
       */
      escalationWaitMs: z
        .number()
        .int()
        .positive()
        .default(2 * 60_000),
    })
    .prefault({}),
  quota: z
    .strictObject({
      recheckIntervalMs: z
        .number()
        .int()
        .positive()
        .default(15 * 60_000),
    })
    .prefault({}),
  outbox: z
    .strictObject({
      maxAttempts: z.number().int().positive().default(8),
      baseDelayMs: z.number().int().positive().default(2_000),
      maxDelayMs: z
        .number()
        .int()
        .positive()
        .default(10 * 60_000),
    })
    .prefault({}),
  setup: z
    .strictObject({
      /** Set by the Coordinator once the setup conversation has nothing left to do. */
      complete: z.boolean().default(false),
    })
    .prefault({}),
  /** Per-Channel settings (pairing, credentials), keyed by Channel kind. */
  channels: z.record(z.string(), z.unknown()).default({}),
});

export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return configSchema.parse({});
}
