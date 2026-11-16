import { type Clock, isoNow, type Timer } from "../clock.js";
import type { Config } from "../config/schema.js";
import type { Goal, Run } from "../goals/store.js";
import type { WorkerEvent } from "../workers/types.js";

/**
 * How a Run looks to the supervisor, decided deterministically without a model:
 * - `active`: a turn is running and produced output recently.
 * - `busy_tool`: quiet for longer than the idle threshold, but a tool or command is still running,
 *   so silence is plausible until the longer tool threshold.
 * - `stalled`: a live turn has been silent past its threshold.
 * - `waiting_on_input`: parked until the user (or Coordinator) answers.
 * - `quota_blocked`: parked until its agent has quota (or a login) again.
 * - `exited_unexpectedly`: the last turn ended without a result and is being recovered.
 * - `parked`: between turns for another reason (paused, verifying, deciding).
 * - `ended`.
 */
export type RunHealth =
  | "active"
  | "busy_tool"
  | "stalled"
  | "waiting_on_input"
  | "quota_blocked"
  | "exited_unexpectedly"
  | "parked"
  | "ended";

export interface Liveness {
  lastEventAt: number;
  lastEventKind: string;
  toolRunning: boolean;
}

export function runHealth(input: {
  goal: Goal;
  run: Run;
  live: Liveness | undefined;
  now: number;
  settings: Config["supervision"];
}): RunHealth {
  const { goal, run, live, now, settings } = input;
  if (run.state === "ended") return "ended";
  if (live) {
    const quiet = now - live.lastEventAt;
    if (quiet >= (live.toolRunning ? settings.toolStallMs : settings.idleStallMs)) return "stalled";
    if (live.toolRunning && quiet >= settings.idleStallMs) return "busy_tool";
    return "active";
  }
  switch (goal.state) {
    case "waiting_for_user":
      return "waiting_on_input";
    case "waiting_for_quota":
    case "waiting_for_login":
      return "quota_blocked";
    case "recovering":
      return "exited_unexpectedly";
    default:
      return "parked";
  }
}

export interface StallEvidence {
  at: string;
  lastEventAt: string;
  lastEventKind: string;
  toolRunning: boolean;
  quietMs: number;
  thresholdMs: number;
}

/**
 * Watches live turns for silence. Each WorkerEvent restarts the Run's timer; the threshold is
 * longer while a tool is running. When it fires, `onStall` gets the evidence.
 */
export class StallWatch {
  private watched = new Map<string, Liveness & { timer: Timer | undefined }>();

  constructor(
    private readonly clock: Clock,
    private readonly settings: () => Config["supervision"],
    private readonly onStall: (runId: string, evidence: StallEvidence) => void,
  ) {}

  begin(runId: string): void {
    this.end(runId);
    this.watched.set(runId, {
      lastEventAt: this.clock.now(),
      lastEventKind: "turn_started",
      toolRunning: false,
      timer: undefined,
    });
    this.arm(runId);
  }

  observe(runId: string, event: WorkerEvent): void {
    const entry = this.watched.get(runId);
    if (!entry) return;
    entry.lastEventAt = this.clock.now();
    entry.lastEventKind = event.type === "activity" ? `activity:${event.kind}` : event.type;
    if (event.type === "activity") entry.toolRunning = event.toolRunning;
    this.arm(runId);
  }

  end(runId: string): void {
    this.watched.get(runId)?.timer?.cancel();
    this.watched.delete(runId);
  }

  stopAll(): void {
    for (const id of [...this.watched.keys()]) this.end(id);
  }

  liveness(runId: string): Liveness | undefined {
    const entry = this.watched.get(runId);
    return entry
      ? {
          lastEventAt: entry.lastEventAt,
          lastEventKind: entry.lastEventKind,
          toolRunning: entry.toolRunning,
        }
      : undefined;
  }

  private arm(runId: string): void {
    const entry = this.watched.get(runId);
    if (!entry) return;
    entry.timer?.cancel();
    const settings = this.settings();
    const threshold = entry.toolRunning ? settings.toolStallMs : settings.idleStallMs;
    const due = entry.lastEventAt + threshold - this.clock.now();
    entry.timer = this.clock.setTimeout(() => {
      const current = this.watched.get(runId);
      if (current !== entry) return;
      entry.timer = undefined;
      const now = this.clock.now();
      this.onStall(runId, {
        at: isoNow(this.clock),
        lastEventAt: new Date(entry.lastEventAt).toISOString(),
        lastEventKind: entry.lastEventKind,
        toolRunning: entry.toolRunning,
        quietMs: now - entry.lastEventAt,
        thresholdMs: threshold,
      });
    }, due);
  }
}
