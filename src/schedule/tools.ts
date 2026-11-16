import { z } from "zod";
import type { Coordinator } from "../coordinator/coordinator.js";
import { briefSchema } from "../goals/brief.js";
import { ToolError, type ToolRegistry } from "../mcp/tools.js";
import { formatLocal } from "./cron.js";
import { describeSchedule, ScheduleError, type Scheduler } from "./service.js";
import { checkJobSchema, type Job, type Schedule } from "./store.js";

export interface ScheduleToolDeps {
  scheduler: Scheduler;
  coordinator: Pick<Coordinator, "current">;
  /** Throws unless the Coordinator is answering the user. */
  requireOwnerTurn(): void;
}

const id = z.string().min(1).describe("Schedule ID, e.g. sch-3f9a1c0b2d");

const trigger = {
  at: z
    .string()
    .optional()
    .describe(
      "One time: 2026-11-20T09:00 (read in the schedule's time zone) or with an offset such as +08:00 or Z",
    ),
  cron: z
    .string()
    .optional()
    .describe(
      'A repeating pattern "minute hour day-of-month month day-of-week", e.g. "0 9 * * 1-5"',
    ),
  every: z.string().optional().describe('A plain repeat such as "30m", "2h" or "1d" (at least 1m)'),
};

const policies = {
  overlap: z
    .enum(["skip", "queue"])
    .optional()
    .describe("If the previous run is still going: skip this one (default) or wait for it"),
  missedRun: z
    .enum(["catch_up", "skip"])
    .optional()
    .describe(
      "If Preston was not running at the time: run once when back (default, within the catch-up window) or skip",
    ),
  delivery: z
    .enum(["all", "origin"])
    .optional()
    .describe("Where Preston's notes about this schedule go: every Channel (default) or this chat"),
};

const jobFields = {
  brief: briefSchema
    .optional()
    .describe(
      "The Goal to start each time (objective, scope, acceptance criteria, checks, authority)",
    ),
  check: checkJobSchema
    .optional()
    .describe(
      "Instead of a Goal: a plain command run with no model. Only when it fails does anything else happen",
    ),
  onFailure: z
    .enum(["goal", "notify"])
    .optional()
    .describe("With check: start a Goal from brief when it fails, or just tell the user"),
};

/** The Coordinator's tools for timed work. */
export function registerScheduleTools(registry: ToolRegistry, deps: ScheduleToolDeps): void {
  const { scheduler } = deps;
  const roles = ["coordinator"] as const;
  const guarded = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ScheduleError) throw new ToolError(err.message);
      throw err;
    }
  };

  registry.add({
    name: "schedule_create",
    description:
      "Schedule work for a time or a repeat. When it is due Preston starts a new Goal from the Brief (or runs a plain check that only matters when it fails). Preston keeps the timing itself, so it keeps working while you are not running. Give exactly one of at, cron or every. The result says when it will first run: tell the user, with the time zone.",
    roles,
    input: z.strictObject({
      name: z.string().min(1).max(80),
      ...trigger,
      timezone: z
        .string()
        .optional()
        .describe("IANA name such as Europe/London; defaults to this computer's time zone"),
      projectPath: z.string().min(1).describe("Absolute path of the Project folder"),
      ...jobFields,
      ...policies,
    }),
    handler: (args) => {
      deps.requireOwnerTurn();
      return guarded(() => {
        const replyTo = deps.coordinator.current()?.replyTo;
        const schedule = scheduler.create({
          name: args.name,
          trigger: { at: args.at, cron: args.cron, every: args.every },
          timezone: args.timezone,
          projectPath: args.projectPath,
          job: toJob(args),
          overlap: args.overlap,
          missedRun: args.missedRun,
          delivery: args.delivery,
          origin: replyTo
            ? { channel: replyTo.channel, conversationId: replyTo.conversationId }
            : undefined,
        });
        return summarise(schedule);
      });
    },
  });

  registry.add({
    name: "schedule_update",
    description:
      "Change a schedule. Only pass what changes. Changing the time or time zone recomputes the next run from now. Passing brief or check replaces the job.",
    roles,
    input: z.strictObject({
      id,
      name: z.string().min(1).max(80).optional(),
      ...trigger,
      timezone: z.string().optional(),
      projectPath: z.string().min(1).optional(),
      ...jobFields,
      ...policies,
    }),
    handler: (args) => {
      deps.requireOwnerTurn();
      return guarded(() => {
        const hasTrigger =
          args.at !== undefined || args.cron !== undefined || args.every !== undefined;
        const current = scheduler.require(args.id);
        const job = args.brief || args.check ? toJob(args, current.job) : undefined;
        return summarise(
          scheduler.update(args.id, {
            name: args.name,
            trigger: hasTrigger ? { at: args.at, cron: args.cron, every: args.every } : undefined,
            timezone: args.timezone,
            projectPath: args.projectPath,
            job,
            overlap: args.overlap,
            missedRun: args.missedRun,
            delivery: args.delivery,
          }),
        );
      });
    },
  });

  registry.add({
    name: "schedule_list",
    description: "Every schedule with when it runs next.",
    roles,
    input: z.strictObject({}),
    handler: () => ({ schedules: scheduler.list().map(summarise) }),
  });

  registry.add({
    name: "schedule_pause",
    description:
      "Stop a schedule from running until it is resumed. Time spent paused is not caught up.",
    roles,
    input: z.strictObject({ id }),
    handler: ({ id: scheduleId }) => {
      deps.requireOwnerTurn();
      return guarded(() => summarise(scheduler.pause(scheduleId)));
    },
  });

  registry.add({
    name: "schedule_resume",
    description: "Start a paused schedule again from its next time.",
    roles,
    input: z.strictObject({ id }),
    handler: ({ id: scheduleId }) => {
      deps.requireOwnerTurn();
      return guarded(() => summarise(scheduler.resume(scheduleId)));
    },
  });

  registry.add({
    name: "schedule_delete",
    description:
      "Delete a schedule and its run history. Goals it already started are not affected.",
    roles,
    input: z.strictObject({ id }),
    handler: ({ id: scheduleId }) => {
      deps.requireOwnerTurn();
      return guarded(() => {
        scheduler.delete(scheduleId);
        return { deleted: scheduleId };
      });
    },
  });

  registry.add({
    name: "schedule_history",
    description:
      "What happened on recent due times: started, skipped (and why), caught up, and how each Goal ended.",
    roles,
    input: z.strictObject({ id, limit: z.number().int().min(1).max(50).default(10) }),
    handler: ({ id: scheduleId, limit }) =>
      guarded(() => ({
        runs: scheduler.history(scheduleId, limit).map((r) => ({
          scheduledFor: r.scheduledFor,
          source: r.source,
          state: r.state,
          reason: r.reason,
          missedBefore: r.missedCount,
          outcome: r.outcome,
          goal: r.goal,
          standingOrders: r.standingOrderIds,
        })),
      })),
  });

  registry.add({
    name: "schedule_run_now",
    description:
      "Run a schedule once right now, without moving its next time. It follows the same overlap rule as a timed run.",
    roles,
    input: z.strictObject({ id }),
    handler: ({ id: scheduleId }) => {
      deps.requireOwnerTurn();
      return guarded(() => {
        const result = scheduler.runNow(scheduleId);
        return { result: result.result, reason: result.reason, goalId: result.run.goalId };
      });
    },
  });
}

function toJob(
  args: {
    brief?: z.infer<typeof briefSchema> | undefined;
    check?: z.infer<typeof checkJobSchema> | undefined;
    onFailure?: "goal" | "notify" | undefined;
  },
  fallback?: Job,
): Job {
  if (args.check) {
    const onFailure = args.onFailure ?? (args.brief ? "goal" : "notify");
    return { kind: "script", check: args.check, onFailure, brief: args.brief };
  }
  if (args.brief) return { kind: "goal", brief: args.brief };
  if (fallback) return fallback;
  throw new ToolError("Give a brief (the Goal to start) or a check (a plain command to run).");
}

function summarise(schedule: Schedule) {
  const next = schedule.nextRun ? Date.parse(schedule.nextRun) : undefined;
  return {
    id: schedule.id,
    name: schedule.name,
    when: describeSchedule(schedule),
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    nextRun: schedule.nextRun,
    nextRunLocal: next === undefined ? null : formatLocal(next, schedule.timezone),
    project: schedule.projectPath,
    job:
      schedule.job.kind === "goal"
        ? { kind: "goal", objective: schedule.job.brief.objective }
        : {
            kind: "check",
            command: schedule.job.check.command,
            expectedExitCode: schedule.job.check.expectedExitCode,
            onFailure: schedule.job.onFailure,
          },
    overlap: schedule.overlap,
    missedRun: schedule.missedRun,
    delivery: schedule.delivery,
  };
}
