import { z } from "zod";

const MINUTE = 60_000;
const ms = (fallback: number) => z.number().int().positive().default(fallback);

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
      /** Base interval between token-free quota reads while a bucket is blocked (±jitter). */
      recheckIntervalMs: ms(12.5 * MINUTE),
      /** Base interval between probes (a real resumed turn) when no quota read is available. */
      probeIntervalMs: ms(30 * MINUTE),
      /** Each check that still finds the bucket blocked multiplies the interval by this. */
      backoffFactor: z.number().min(1).max(4).default(1.5),
      maxRecheckIntervalMs: ms(60 * MINUTE),
      /** Spread of each interval, as a fraction of it, so checks do not line up. */
      jitterRatio: z.number().min(0).max(0.5).default(0.2),
      /** Check this long after an advertised reset time. */
      resetGraceMs: ms(MINUTE),
      /** Gap between resuming Runs that waited on the same bucket. */
      resumeStaggerMs: ms(90_000),
      /** First wait after a transient rate limit; doubles per repeat up to the maximum. */
      rateLimitWaitMs: ms(MINUTE),
      rateLimitMaxWaitMs: ms(10 * MINUTE),
      /** A quota wait is told to the user only when it is expected to last longer than this. */
      notifyAfterMs: ms(30 * MINUTE),
      /** A Goal moves to another agent with headroom only when its wait is longer than this. */
      switchAfterMs: ms(60 * MINUTE),
    })
    .prefault({}),
  supervision: z
    .strictObject({
      /** Silence after which a turn with no tool running counts as stalled. */
      idleStallMs: ms(10 * MINUTE),
      /** Silence after which a turn with a tool or command still running counts as stalled. */
      toolStallMs: ms(60 * MINUTE),
      /** Coordinator strategy changes per Goal before Preston reports it as Blocked. */
      maxStrategyChanges: z.number().int().min(0).max(5).default(2),
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
