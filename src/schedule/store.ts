import { z } from "zod";
import type { ChannelKind } from "../channels/types.js";
import { type Clock, isoNow } from "../clock.js";
import { briefSchema } from "../goals/brief.js";
import { all, type Db, one, run } from "../store/db.js";
import { newId } from "../util/ids.js";
import type { Trigger } from "./cron.js";

export const checkJobSchema = z.strictObject({
  name: z.string().min(1).default("check"),
  command: z.string().min(1),
  expectedExitCode: z.number().int().min(0).max(255).default(0),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
});

export const jobSchema = z.discriminatedUnion("kind", [
  /** Starts a Goal from this Brief each time. */
  z.strictObject({ kind: z.literal("goal"), brief: briefSchema }),
  /**
   * Runs a plain command with no model involved. It only speaks up when the exit code is not the
   * expected one: by starting a Goal from `brief` (with the failure attached), or by telling the user.
   */
  z.strictObject({
    kind: z.literal("script"),
    check: checkJobSchema,
    onFailure: z.enum(["goal", "notify"]),
    brief: briefSchema.optional(),
  }),
]);
export type Job = z.infer<typeof jobSchema>;

export type OverlapPolicy = "skip" | "queue";
export type MissedPolicy = "catch_up" | "skip";
export type Delivery = "all" | "origin";

export interface Schedule {
  id: string;
  name: string;
  trigger: Trigger;
  timezone: string;
  job: Job;
  projectPath: string;
  enabled: boolean;
  /** The next time it is due, or null when paused or finished. */
  nextRun: string | null;
  overlap: OverlapPolicy;
  missedRun: MissedPolicy;
  delivery: Delivery;
  origin: { channel: ChannelKind; conversationId: string } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * pending: claimed, not yet started. queued: waiting for the previous run to end. running: its
 * Goal is in progress. done: its Goal ended (see `outcome`). passed: a script check was fine.
 * skipped and failed carry a `reason`.
 */
export type RunState = "pending" | "queued" | "running" | "done" | "passed" | "skipped" | "failed";

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  source: "scheduled" | "catch_up" | "manual";
  state: RunState;
  reason: string | null;
  goalId: string | null;
  outcome: string | null;
  missedCount: number;
  standingOrderIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow {
  id: string;
  name: string;
  trigger: string;
  timezone: string;
  job: string;
  project_path: string;
  enabled: number;
  next_run: string | null;
  overlap: OverlapPolicy;
  missed_run: MissedPolicy;
  delivery: Delivery;
  origin_channel: ChannelKind | null;
  origin_conversation: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  schedule_id: string;
  scheduled_for: string;
  source: ScheduleRun["source"];
  state: RunState;
  reason: string | null;
  goal_id: string | null;
  outcome: string | null;
  missed_count: number;
  standing_order_ids: string;
  created_at: string;
  updated_at: string;
}

const OPEN: RunState[] = ["pending", "running"];

/** Durable schedules and the run keys that keep a due time from being dispatched twice. */
export class ScheduleStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  insert(input: Omit<Schedule, "id" | "createdAt" | "updatedAt">): Schedule {
    const id = newId("sch");
    const at = isoNow(this.clock);
    run(
      this.db,
      `INSERT INTO schedules (id, name, trigger, timezone, job, project_path, enabled, next_run, overlap,
         missed_run, delivery, origin_channel, origin_conversation, created_at, updated_at)
       VALUES (:id, :name, :trigger, :tz, :job, :project, :enabled, :next, :overlap, :missed, :delivery,
         :channel, :conversation, :at, :at)`,
      {
        id,
        name: input.name,
        trigger: JSON.stringify(input.trigger),
        tz: input.timezone,
        job: JSON.stringify(input.job),
        project: input.projectPath,
        enabled: input.enabled ? 1 : 0,
        next: input.nextRun,
        overlap: input.overlap,
        missed: input.missedRun,
        delivery: input.delivery,
        channel: input.origin?.channel ?? null,
        conversation: input.origin?.conversationId ?? null,
        at,
      },
    );
    return this.get(id);
  }

  /** Replaces every editable field. */
  save(schedule: Schedule): void {
    run(
      this.db,
      `UPDATE schedules SET name = :name, trigger = :trigger, timezone = :tz, job = :job,
         project_path = :project, enabled = :enabled, next_run = :next, overlap = :overlap,
         missed_run = :missed, delivery = :delivery, updated_at = :at WHERE id = :id`,
      {
        id: schedule.id,
        name: schedule.name,
        trigger: JSON.stringify(schedule.trigger),
        tz: schedule.timezone,
        job: JSON.stringify(schedule.job),
        project: schedule.projectPath,
        enabled: schedule.enabled ? 1 : 0,
        next: schedule.nextRun,
        overlap: schedule.overlap,
        missed: schedule.missedRun,
        delivery: schedule.delivery,
        at: isoNow(this.clock),
      },
    );
  }

  setNext(id: string, nextRun: string | null, enabled?: boolean): void {
    run(
      this.db,
      `UPDATE schedules SET next_run = :next, enabled = COALESCE(:enabled, enabled), updated_at = :at WHERE id = :id`,
      {
        id,
        next: nextRun,
        enabled: enabled === undefined ? null : enabled ? 1 : 0,
        at: isoNow(this.clock),
      },
    );
  }

  delete(id: string): boolean {
    return run(this.db, "DELETE FROM schedules WHERE id = :id", { id }) > 0;
  }

  find(id: string): Schedule | undefined {
    const row = one<ScheduleRow>(this.db, "SELECT * FROM schedules WHERE id = :id", { id });
    return row ? toSchedule(row) : undefined;
  }

  get(id: string): Schedule {
    const found = this.find(id);
    if (!found) throw new Error(`Unknown schedule ${id}`);
    return found;
  }

  list(): Schedule[] {
    return all<ScheduleRow>(this.db, "SELECT * FROM schedules ORDER BY created_at, rowid").map(
      toSchedule,
    );
  }

  due(nowIso: string): Schedule[] {
    return all<ScheduleRow>(
      this.db,
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= :now ORDER BY next_run, rowid",
      { now: nowIso },
    ).map(toSchedule);
  }

  /** The earliest enabled next run, as epoch ms. */
  earliestNext(): number | undefined {
    const row = one<{ at: string | null }>(
      this.db,
      "SELECT MIN(next_run) AS at FROM schedules WHERE enabled = 1 AND next_run IS NOT NULL",
    );
    return row?.at ? Date.parse(row.at) : undefined;
  }

  // ---- Runs --------------------------------------------------------------------------------

  /** Records a run under its key. Returns undefined when that key was already used. */
  addRun(input: {
    scheduleId: string;
    scheduledFor: string;
    source: ScheduleRun["source"];
    state: RunState;
    reason?: string | undefined;
    missedCount?: number | undefined;
    standingOrderIds?: string[] | undefined;
  }): ScheduleRun | undefined {
    const id = newId("sr");
    const at = isoNow(this.clock);
    const changes = run(
      this.db,
      `INSERT OR IGNORE INTO schedule_runs (id, schedule_id, scheduled_for, source, state, reason, missed_count,
         standing_order_ids, created_at, updated_at)
       VALUES (:id, :schedule, :for, :source, :state, :reason, :missed, :orders, :at, :at)`,
      {
        id,
        schedule: input.scheduleId,
        for: input.scheduledFor,
        source: input.source,
        state: input.state,
        reason: input.reason ?? null,
        missed: input.missedCount ?? 0,
        orders: JSON.stringify(input.standingOrderIds ?? []),
        at,
      },
    );
    return changes ? this.run(id) : undefined;
  }

  update(
    id: string,
    patch: { state?: RunState; reason?: string | null; goalId?: string; outcome?: string | null },
  ): void {
    const sets = ["updated_at = :at"];
    const params: Record<string, string | null> = { id, at: isoNow(this.clock) };
    if (patch.state !== undefined) {
      sets.push("state = :state");
      params.state = patch.state;
    }
    if (patch.reason !== undefined) {
      sets.push("reason = :reason");
      params.reason = patch.reason;
    }
    if (patch.goalId !== undefined) {
      sets.push("goal_id = :goal");
      params.goal = patch.goalId;
    }
    if (patch.outcome !== undefined) {
      sets.push("outcome = :outcome");
      params.outcome = patch.outcome;
    }
    run(this.db, `UPDATE schedule_runs SET ${sets.join(", ")} WHERE id = :id`, params);
  }

  run(id: string): ScheduleRun {
    const row = one<RunRow>(this.db, "SELECT * FROM schedule_runs WHERE id = :id", { id });
    if (!row) throw new Error(`Unknown schedule run ${id}`);
    return toRun(row);
  }

  runs(scheduleId: string, limit: number): ScheduleRun[] {
    return all<RunRow>(
      this.db,
      "SELECT * FROM schedule_runs WHERE schedule_id = :id ORDER BY scheduled_for DESC, rowid DESC LIMIT :limit",
      { id: scheduleId, limit },
    ).map(toRun);
  }

  hasOpen(scheduleId: string): boolean {
    return Boolean(
      one(
        this.db,
        `SELECT 1 AS x FROM schedule_runs WHERE schedule_id = :id AND state IN (${OPEN.map((s) => `'${s}'`).join(",")})`,
        { id: scheduleId },
      ),
    );
  }

  oldestQueued(scheduleId: string): ScheduleRun | undefined {
    const row = one<RunRow>(
      this.db,
      "SELECT * FROM schedule_runs WHERE schedule_id = :id AND state = 'queued' ORDER BY scheduled_for, rowid LIMIT 1",
      { id: scheduleId },
    );
    return row ? toRun(row) : undefined;
  }

  withState(state: RunState): ScheduleRun[] {
    return all<RunRow>(
      this.db,
      "SELECT * FROM schedule_runs WHERE state = :state ORDER BY scheduled_for, rowid",
      { state },
    ).map(toRun);
  }

  scheduleOfGoal(goalId: string): string | undefined {
    return one<{ schedule_id: string }>(
      this.db,
      "SELECT schedule_id FROM schedule_runs WHERE goal_id = :goal",
      { goal: goalId },
    )?.schedule_id;
  }
}

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    trigger: JSON.parse(row.trigger) as Trigger,
    timezone: row.timezone,
    job: jobSchema.parse(JSON.parse(row.job)),
    projectPath: row.project_path,
    enabled: row.enabled === 1,
    nextRun: row.next_run,
    overlap: row.overlap,
    missedRun: row.missed_run,
    delivery: row.delivery,
    origin:
      row.origin_channel && row.origin_conversation
        ? { channel: row.origin_channel, conversationId: row.origin_conversation }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    source: row.source,
    state: row.state,
    reason: row.reason,
    goalId: row.goal_id,
    outcome: row.outcome,
    missedCount: row.missed_count,
    standingOrderIds: JSON.parse(row.standing_order_ids) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
