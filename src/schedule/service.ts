import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Outbox } from "../channels/outbox.js";
import { type Clock, isoNow, type Timer } from "../clock.js";
import type { ConfigManager } from "../config/config.js";
import type { Brief } from "../goals/brief.js";
import { type CheckResult, runCheck } from "../goals/checks.js";
import type { GoalEngine } from "../goals/engine.js";
import type { GoalStore, Origin } from "../goals/store.js";
import { pick } from "../i18n/index.js";
import { errorMessage, type Logger } from "../log.js";
import { type Db, transaction } from "../store/db.js";
import {
  buildTrigger,
  CronError,
  describeTrigger,
  formatLocal,
  isValidTimeZone,
  nextOccurrence,
  occurrencesBetween,
  systemTimeZone,
  type Trigger,
} from "./cron.js";
import type {
  Delivery,
  Job,
  MissedPolicy,
  OverlapPolicy,
  Schedule,
  ScheduleRun,
  ScheduleStore,
} from "./store.js";

export class ScheduleError extends Error {}

export interface SchedulerDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  store: ScheduleStore;
  goals: GoalStore;
  engine: Pick<GoalEngine, "createGoal">;
  outbox: Outbox;
  config: ConfigManager;
  transcriptsDir: string;
  /** IDs of the standing orders that apply to a Goal a schedule starts (recorded with the run). */
  standingOrderIds?(scope: { projectPath: string; scheduleId: string; text: string }): string[];
}

export interface TriggerInput {
  at?: string | undefined;
  cron?: string | undefined;
  every?: string | undefined;
}

export interface CreateInput {
  name: string;
  trigger: TriggerInput;
  timezone?: string | undefined;
  projectPath: string;
  job: Job;
  overlap?: OverlapPolicy | undefined;
  missedRun?: MissedPolicy | undefined;
  delivery?: Delivery | undefined;
  origin?: Origin | undefined;
}

export type UpdateInput = Partial<
  Pick<CreateInput, "name" | "timezone" | "projectPath" | "overlap" | "missedRun" | "delivery">
> & { trigger?: TriggerInput | undefined; job?: Job | undefined };

export type RunNowResult = {
  result: "started" | "queued" | "skipped";
  run: ScheduleRun;
  reason?: string;
};

/**
 * The deterministic dispatcher for schedules. It owns the timing: one timer on the injected
 * clock, never longer than `tickMs` so that waking from sleep is noticed promptly. It persists
 * each next run, protects against dispatching a due time twice with durable run keys
 * (schedule + scheduled time), applies the overlap and missed-run policies, and starts every
 * triggered run as a distinct Goal through the normal Goal path. No model is involved until a
 * Goal starts.
 *
 * A host that is asleep or off cannot run anything. Work due meanwhile is handled on the first
 * tick after Preston is running again, per the schedule's missed-run policy.
 */
export class Scheduler {
  private timer: Timer | undefined;
  private tasks = new Set<Promise<void>>();
  private stopped = true;

  constructor(private readonly deps: SchedulerDeps) {}

  // ---- Lifecycle ---------------------------------------------------------------------------

  start(): void {
    this.stopped = false;
    // Claimed but never executed (Preston stopped in between): carry on under the same key.
    for (const row of this.deps.store.withState("pending")) this.execute(row);
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    await Promise.allSettled([...this.tasks]);
  }

  /** Looks at the clock now: settles finished runs, dispatches what is due, and sets the next timer. */
  tick(): void {
    if (this.stopped) return;
    try {
      this.reconcile();
      for (const schedule of this.deps.store.due(isoNow(this.deps.clock))) this.handleDue(schedule);
    } catch (err) {
      this.deps.log.error("schedule tick failed", { error: err });
    }
    this.arm();
  }

  private arm(): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped) return;
    const { tickMs } = this.deps.config.get().schedules;
    const next = this.deps.store.earliestNext();
    const wait = next === undefined ? tickMs : Math.min(tickMs, next - this.deps.clock.now());
    this.timer = this.deps.clock.setTimeout(() => this.tick(), Math.max(wait, 1_000));
  }

  // ---- Commands ----------------------------------------------------------------------------

  create(input: CreateInput): Schedule {
    const timezone = this.timezone(input.timezone);
    const now = this.deps.clock.now();
    const trigger = this.trigger(input.trigger, timezone, now);
    const projectPath = this.projectPath(input.projectPath);
    this.checkJob(input.job);
    const next = nextOccurrence(trigger, timezone, now);
    return this.deps.store.insert({
      name: input.name.trim(),
      trigger,
      timezone,
      job: input.job,
      projectPath,
      enabled: true,
      nextRun: next === undefined ? null : new Date(next).toISOString(),
      overlap: input.overlap ?? "skip",
      missedRun: input.missedRun ?? "catch_up",
      delivery: input.delivery ?? "all",
      origin: input.origin ?? null,
    });
  }

  update(id: string, patch: UpdateInput): Schedule {
    const current = this.require(id);
    const timezone = patch.timezone ? this.timezone(patch.timezone) : current.timezone;
    const now = this.deps.clock.now();
    const retimed = patch.trigger !== undefined || patch.timezone !== undefined;
    const trigger = patch.trigger ? this.trigger(patch.trigger, timezone, now) : current.trigger;
    const job = patch.job ?? current.job;
    this.checkJob(job);
    const next = retimed ? nextOccurrence(trigger, timezone, now) : undefined;
    const updated: Schedule = {
      ...current,
      name: patch.name?.trim() || current.name,
      trigger,
      timezone,
      job,
      projectPath: patch.projectPath ? this.projectPath(patch.projectPath) : current.projectPath,
      overlap: patch.overlap ?? current.overlap,
      missedRun: patch.missedRun ?? current.missedRun,
      delivery: patch.delivery ?? current.delivery,
    };
    if (retimed) {
      updated.nextRun = next === undefined ? null : new Date(next).toISOString();
      // A finished one-time schedule given a new time is live again.
      if (next !== undefined && current.nextRun === null && !current.enabled)
        updated.enabled = true;
    }
    this.deps.store.save(updated);
    this.tick();
    return this.deps.store.get(id);
  }

  pause(id: string): Schedule {
    this.require(id);
    transaction(this.deps.db, () => {
      this.deps.store.setNext(id, null, false);
      // Something waiting for its turn is dropped; a run in progress is left alone.
      for (const run of this.deps.store.withState("queued")) {
        if (run.scheduleId === id) {
          this.deps.store.update(run.id, { state: "skipped", reason: "paused" });
        }
      }
    });
    return this.deps.store.get(id);
  }

  /** Time spent paused is not caught up: the next run is the next one after now. */
  resume(id: string): Schedule {
    const schedule = this.require(id);
    const next = nextOccurrence(schedule.trigger, schedule.timezone, this.deps.clock.now());
    if (next === undefined) {
      throw new ScheduleError(
        "That schedule has no future time left. Give it a new time with schedule_update.",
      );
    }
    this.deps.store.setNext(id, new Date(next).toISOString(), true);
    this.tick();
    return this.deps.store.get(id);
  }

  delete(id: string): void {
    this.require(id);
    this.deps.store.delete(id);
  }

  list(): Schedule[] {
    return this.deps.store.list();
  }

  require(id: string): Schedule {
    const found = this.deps.store.find(id);
    if (!found) throw new ScheduleError(`There is no schedule ${id}.`);
    return found;
  }

  /** The run history, each with its Goal's current state. */
  history(id: string, limit: number) {
    this.require(id);
    return this.deps.store.runs(id, limit).map((run) => {
      const goal = run.goalId ? this.deps.goals.findGoal(run.goalId) : undefined;
      return {
        ...run,
        goal: goal
          ? { id: goal.id, state: goal.state, outcome: goal.outcome, detail: goal.detail }
          : null,
      };
    });
  }

  /** Runs it now, under the same overlap rule as a timed run. Does not move the next run. */
  runNow(id: string): RunNowResult {
    const schedule = this.require(id);
    const now = this.deps.clock.now();
    let scheduledFor = new Date(now).toISOString();
    // Two requests in the same millisecond would share a key; make the second distinct.
    for (
      let n = 1;
      this.deps.store.runs(id, 1_000).some((r) => r.scheduledFor === scheduledFor);
      n++
    ) {
      scheduledFor = new Date(now + n).toISOString();
    }
    const placed = this.place(schedule, scheduledFor, "manual", 0);
    if (!placed) throw new ScheduleError("That run was already requested.");
    if (placed.execute) this.execute(placed.run);
    const fresh = this.deps.store.run(placed.run.id);
    return {
      result: placed.execute ? "started" : fresh.state === "queued" ? "queued" : "skipped",
      run: fresh,
      ...(fresh.reason ? { reason: fresh.reason } : {}),
    };
  }

  // ---- Dispatch ----------------------------------------------------------------------------

  private handleDue(schedule: Schedule): void {
    const { clock, config, store } = this.deps;
    const now = clock.now();
    const settings = config.get().schedules;
    const grace = settings.tickMs * 2;
    const from = Date.parse(schedule.nextRun as string);
    // Enumerate from just before the stored next run, but never further back than the window
    // (older occurrences are missed under any policy; only their count would differ).
    const start = Math.max(from - 1, now - settings.catchUpWindowMs - 1);
    const due = occurrencesBetween(schedule.trigger, schedule.timezone, start, now);
    const latest = due.at(-1) ?? from;
    const lateness = now - latest;
    const missed = Math.max(0, due.length - 1);
    const following = nextOccurrence(schedule.trigger, schedule.timezone, now);

    const claimed = transaction(this.deps.db, () => {
      const scheduledFor = new Date(latest).toISOString();
      let claim: ScheduleRun | undefined;
      if (lateness <= grace) {
        claim = this.place(schedule, scheduledFor, "scheduled", missed)?.claimed;
      } else if (schedule.missedRun === "catch_up" && lateness <= settings.catchUpWindowMs) {
        claim = this.place(schedule, scheduledFor, "catch_up", missed)?.claimed;
      } else {
        store.addRun({
          scheduleId: schedule.id,
          scheduledFor,
          source: "scheduled",
          state: "skipped",
          reason:
            schedule.missedRun === "skip"
              ? "missed while Preston was not running"
              : "missed by more than the catch-up window",
          missedCount: missed,
        });
      }
      if (following === undefined) store.setNext(schedule.id, null, false);
      else store.setNext(schedule.id, new Date(following).toISOString());
      return claim;
    });
    if (claimed) this.execute(claimed);
  }

  /**
   * Records what happens to one due time under its run key: start it, queue it, or skip it
   * because the previous run is still going. Returns undefined when the key was already used.
   */
  private place(
    schedule: Schedule,
    scheduledFor: string,
    source: ScheduleRun["source"],
    missedCount: number,
  ): { run: ScheduleRun; execute: boolean; claimed: ScheduleRun | undefined } | undefined {
    const { store } = this.deps;
    const base = { scheduleId: schedule.id, scheduledFor, source, missedCount };
    if (store.hasOpen(schedule.id)) {
      const queue = schedule.overlap === "queue" && !store.oldestQueued(schedule.id);
      const run = store.addRun({
        ...base,
        state: queue ? "queued" : "skipped",
        reason: queue
          ? "waiting for the previous run to finish"
          : schedule.overlap === "queue"
            ? "a run is already waiting"
            : "the previous run is still going",
      });
      return run && { run, execute: false, claimed: undefined };
    }
    const run = store.addRun({
      ...base,
      state: "pending",
      standingOrderIds: this.deps.standingOrderIds?.({
        projectPath: schedule.projectPath,
        scheduleId: schedule.id,
        text: schedule.job.kind === "goal" ? briefText(schedule.job.brief) : "",
      }),
    });
    return run && { run, execute: true, claimed: run };
  }

  /** Settles runs whose Goal ended, then starts one that was waiting its turn. */
  private reconcile(): void {
    const { store, goals } = this.deps;
    for (const run of store.withState("running")) {
      const goal = run.goalId ? goals.findGoal(run.goalId) : undefined;
      if (!goal?.endedAt) continue;
      store.update(run.id, { state: "done", outcome: goal.outcome ?? goal.state });
    }
    for (const schedule of store.list()) {
      if (store.hasOpen(schedule.id)) continue;
      const waiting = store.oldestQueued(schedule.id);
      if (!waiting) continue;
      store.update(waiting.id, { state: "pending", reason: null });
      this.execute(store.run(waiting.id));
    }
  }

  private execute(run: ScheduleRun): void {
    const schedule = this.deps.store.find(run.scheduleId);
    if (!schedule || this.stopped) return;
    const { job } = schedule;
    if (job.kind === "goal") {
      this.startGoal(schedule, run, job.brief);
      return;
    }
    const task = this.runScript(schedule, run, job)
      .catch((err) => {
        this.deps.log.error("scheduled check failed to run", {
          scheduleId: schedule.id,
          error: err,
        });
        this.deps.store.update(run.id, { state: "failed", reason: errorMessage(err) });
      })
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private startGoal(schedule: Schedule, run: ScheduleRun, brief: Brief): void {
    const { engine, store, db } = this.deps;
    try {
      const goal = transaction(db, () => {
        const created = engine.createGoal({
          projectPath: schedule.projectPath,
          brief,
          origin: schedule.delivery === "origin" ? (schedule.origin ?? undefined) : undefined,
          sourceKey: `schedule:${schedule.id}:${run.scheduledFor}`,
          // Linked before the first Worker turn so its guidance can include the schedule's orders.
          onCreated: (g) => store.update(run.id, { goalId: g.id, state: "running" }),
        });
        store.update(run.id, { goalId: created.id, state: "running" });
        return created;
      });
      this.deps.log.info("scheduled goal started", { scheduleId: schedule.id, goalId: goal.id });
      if (run.source === "catch_up") {
        this.notify(
          schedule,
          run,
          "caught-up",
          pick({
            en: `I wasn't running when "${schedule.name}" was due (${formatLocal(Date.parse(run.scheduledFor), schedule.timezone)}), so I started it now.`,
            "zh-CN": `“${schedule.name}”到点时我没有在运行（${formatLocal(Date.parse(run.scheduledFor), schedule.timezone)}），所以现在补上了。`,
          }),
        );
      }
    } catch (err) {
      const reason = errorMessage(err);
      store.update(run.id, { state: "failed", reason });
      this.deps.log.warn("scheduled goal could not start", { scheduleId: schedule.id, reason });
      this.notify(
        schedule,
        run,
        "failed",
        pick({
          en: `I couldn't start the scheduled job "${schedule.name}": ${reason}`,
          "zh-CN": `无法启动定时任务“${schedule.name}”：${reason}`,
        }),
      );
    }
  }

  private async runScript(
    schedule: Schedule,
    run: ScheduleRun,
    job: Extract<Job, { kind: "script" }>,
  ): Promise<void> {
    const { clock, transcriptsDir, store } = this.deps;
    const result = await runCheck(
      { name: job.check.name, command: job.check.command, source: "brief" },
      {
        cwd: schedule.projectPath,
        timeoutMs: job.check.timeoutMs,
        clock,
        outputPath: join(transcriptsDir, "schedules", schedule.id, `${run.id}.log`),
      },
    );
    if (this.stopped) return;
    if (!result.timedOut && result.exitCode === job.check.expectedExitCode) {
      store.update(run.id, { state: "passed" });
      return;
    }
    const why = failureText(job, result);
    if (job.onFailure === "goal" && job.brief) {
      const brief: Brief = {
        ...job.brief,
        scope: [
          job.brief.scope,
          why,
          result.outputTail ? `Output:\n${result.outputTail.slice(-1500)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
      this.startGoal(schedule, run, brief);
      return;
    }
    store.update(run.id, { state: "failed", reason: why });
    this.notify(
      schedule,
      run,
      "check-failed",
      `"${schedule.name}": ${why}${result.outputTail ? `\n${result.outputTail.slice(-400)}` : ""}`,
    );
  }

  private notify(schedule: Schedule, run: ScheduleRun, kind: string, text: string): void {
    const item = { kind: "notice" as const, text, dedupeKey: `schedule:${run.id}:${kind}` };
    if (schedule.delivery === "origin" && schedule.origin) {
      this.deps.outbox.enqueue({ ...item, ...schedule.origin });
    } else {
      this.deps.outbox.broadcast(item);
    }
  }

  // ---- Validation --------------------------------------------------------------------------

  private timezone(requested: string | undefined): string {
    const timezone = requested?.trim() || systemTimeZone();
    if (!isValidTimeZone(timezone)) {
      throw new ScheduleError(
        `"${timezone}" is not a time zone name like Europe/London or Asia/Shanghai.`,
      );
    }
    return timezone;
  }

  private trigger(input: TriggerInput, timezone: string, now: number): Trigger {
    try {
      return buildTrigger(input, timezone, now);
    } catch (err) {
      if (err instanceof CronError) throw new ScheduleError(err.message);
      throw err;
    }
  }

  private projectPath(path: string): string {
    if (!isAbsolute(path)) throw new ScheduleError("The project must be an absolute folder path.");
    const resolved = resolve(path);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new ScheduleError(`There is no folder at ${resolved}.`);
    }
    return resolved;
  }

  private checkJob(job: Job): void {
    if (job.kind === "script" && job.onFailure === "goal" && !job.brief) {
      throw new ScheduleError(
        'A check that starts a Goal when it fails needs a Brief for that Goal (or use onFailure "notify").',
      );
    }
  }
}

export function describeSchedule(schedule: Schedule): string {
  return describeTrigger(schedule.trigger, schedule.timezone);
}

function briefText(brief: Brief): string {
  return `${brief.objective}\n${brief.scope}`;
}

function failureText(job: Extract<Job, { kind: "script" }>, result: CheckResult): string {
  const how = result.timedOut
    ? "timed out"
    : `exited with code ${result.exitCode ?? "unknown"} (expected ${job.check.expectedExitCode})`;
  return `The check "${job.check.name}" (${job.check.command}) ${how}.`;
}
