import { type Clock, isoNow, type Timer } from "../clock.js";
import type { Config } from "../config/schema.js";
import { errorMessage, type Logger } from "../log.js";
import type { AgentKind, QuotaKind, WorkerAdapter } from "../workers/types.js";
import { nextCheckDelay } from "./schedule.js";
import {
  BLOCKED_STATES,
  type Bucket,
  type BucketState,
  type CheckMethod,
  QuotaStore,
} from "./store.js";

export { QuotaStore };

/** A Run (by ID) or the Coordinator, whichever is waiting for or probing a bucket. */
export type QuotaOwner = string;
export const COORDINATOR_OWNER: QuotaOwner = "coordinator";

export function authBucket(agent: AgentKind): string {
  return `auth:${agent}`;
}

export interface QuotaDeps {
  store: QuotaStore;
  clock: Clock;
  log: Logger;
  settings(): Config["quota"];
  adapter(kind: AgentKind): WorkerAdapter | undefined;
  /** Runs waiting on this bucket, longest wait first. */
  waitingRuns(bucket: string): string[];
  /** Resumes a Run that waited on a bucket; false if it no longer waits. */
  resumeRun(runId: string, probe: boolean): boolean;
  /** Resumes the Coordinator's queued work (only the oldest item for a probe); false if none. */
  resumeCoordinator(probe: boolean): boolean;
  /** A check found the bucket still blocked: Goals may be told or handed to another agent. */
  stillBlocked(bucket: Bucket): void;
}

/** Whether an agent can take new work, and when it is expected back if not and known. */
export interface Headroom {
  ok: boolean;
  resetsAt?: number | undefined;
}

type Observation = { result: "available" | "blocked" | "unknown"; resetsAt?: string | undefined };

/**
 * One monitor per quota bucket, shared by every Run (and the Coordinator) waiting on it. While a
 * bucket is blocked it is rechecked on a jittered, backed-off schedule, earlier near its
 * advertised reset, with the agent's token-free read where there is one (`readQuota`, or
 * `detect` for a broken login). Without a read, a conservative probe resumes one waiting turn.
 * When the bucket is available again, waiters resume one at a time, `resumeStaggerMs` apart.
 * Everything is persisted, so a restart picks the schedule up where it was. No model calls.
 */
export class QuotaMonitor {
  private timers = new Map<string, Timer>();
  private staggers = new Map<string, Timer>();
  private probes = new Map<string, { owner: QuotaOwner; startedAt: number }>();
  private checking = new Set<string>();
  private stopped = true;

  constructor(private readonly deps: QuotaDeps) {}

  /** Resumes monitoring from persisted state. */
  start(): void {
    this.stopped = false;
    for (const bucket of this.deps.store.list()) {
      if (!this.hasWaiters(bucket)) continue;
      if (isBlocked(bucket.state)) {
        const at = bucket.nextCheckAt ? Date.parse(bucket.nextCheckAt) : this.deps.clock.now();
        this.schedule(bucket, Math.max(at, this.deps.clock.now()));
      } else if (bucket.state === "available") {
        this.stagger(bucket.bucket, 0);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [...this.timers.values(), ...this.staggers.values()]) timer.cancel();
    this.timers.clear();
    this.staggers.clear();
    this.probes.clear();
  }

  /** A Run's turn ended because its quota ran out (or its spending limit was reached). */
  runBlocked(input: {
    owner: QuotaOwner;
    agent: AgentKind;
    bucket: string;
    kind: Exclude<QuotaKind, "rate_limit">;
    resetsAt?: string | undefined;
    detail?: string | undefined;
  }): Bucket {
    const state: BucketState = input.kind === "spend_limit" ? "spend_blocked" : "blocked";
    return this.block({ ...input, state });
  }

  /** The agent's login stopped working. Monitored through `detect()`. */
  authBroken(input: { owner: QuotaOwner; agent: AgentKind; detail?: string | undefined }): Bucket {
    return this.block({ ...input, bucket: authBucket(input.agent), state: "auth_broken" });
  }

  /** A waiting Run (or the Coordinator) made progress, which ends a probe successfully. */
  progress(owner: QuotaOwner): void {
    for (const [name, probe] of this.probes) {
      if (probe.owner !== owner) continue;
      this.probes.delete(name);
      this.deps.store.recordCheck({
        bucket: name,
        method: "probe",
        result: "available",
        cost: { turns: 1, durationMs: this.deps.clock.now() - probe.startedAt },
      });
      const bucket = this.deps.store.get(name);
      if (bucket && isBlocked(bucket.state)) this.available(bucket, "probe");
    }
  }

  /** A turn ended without progress or a new block: a probe through it told nothing. */
  turnEnded(owner: QuotaOwner): void {
    for (const [name, probe] of this.probes) {
      if (probe.owner !== owner) continue;
      this.probes.delete(name);
      this.deps.store.recordCheck({
        bucket: name,
        method: "probe",
        result: "unknown",
        cost: { turns: 1, durationMs: this.deps.clock.now() - probe.startedAt },
      });
    }
  }

  /** The worst current block for an agent: one that someone waits on or that has not reset. */
  activeBlock(agent: AgentKind): Bucket | undefined {
    const now = this.deps.clock.now();
    const rank: Record<string, number> = { auth_broken: 3, spend_blocked: 2, blocked: 1 };
    return this.deps.store
      .list()
      .filter(
        (b) =>
          b.agent === agent &&
          isBlocked(b.state) &&
          (this.hasWaiters(b) || (b.resetsAt !== null && Date.parse(b.resetsAt) > now)),
      )
      .sort(
        (a, b) =>
          (rank[b.state] ?? 0) - (rank[a.state] ?? 0) ||
          (b.resetsAt ?? "").localeCompare(a.resetsAt ?? ""),
      )[0];
  }

  /** The bucket the Coordinator waits on for this agent, if any. */
  coordinatorBlock(agent: AgentKind): Bucket | undefined {
    return this.deps.store
      .list()
      .find((b) => b.agent === agent && b.coordinatorWaiting && isBlocked(b.state));
  }

  /** Whether an agent can take on work now: nothing blocks it and its quota read has room. */
  async headroom(agent: AgentKind): Promise<boolean> {
    return (await this.headroomInfo(agent)).ok;
  }

  /**
   * Headroom, and when the agent is expected to have quota again (milliseconds) if it has none
   * and that is known. "Room" means below `quota.headroomPercent` of every metered window.
   */
  async headroomInfo(agent: AgentKind): Promise<Headroom> {
    const known = this.headroomKnown(agent);
    const adapter = this.deps.adapter(agent);
    if (!known.ok || !adapter?.readQuota) return known;
    try {
      const { headroomPercent } = this.deps.settings();
      const full = (await adapter.readQuota()).filter(
        (r) => r.available === false || (r.usedPercent ?? 0) >= headroomPercent,
      );
      const resets = full.flatMap((r) => parseTime(r.resetsAt) ?? []);
      return { ok: full.length === 0, resetsAt: resets.length ? Math.min(...resets) : undefined };
    } catch (err) {
      this.deps.log.warn("quota read failed", { agent, error: errorMessage(err) });
      return { ok: false };
    }
  }

  /** Headroom as far as Preston already knows (blocks and logins), without reading quota. */
  headroomKnown(agent: AgentKind): Headroom {
    if (!this.deps.adapter(agent)) return { ok: false };
    const block = this.activeBlock(agent);
    return block ? { ok: false, resetsAt: parseTime(block.resetsAt) } : { ok: true };
  }

  list(): (Bucket & { monitored: boolean })[] {
    return this.deps.store.list().map((b) => ({ ...b, monitored: this.timers.has(b.bucket) }));
  }

  /**
   * The user said "resume": recheck spending limits and logins now, probing if needed (the
   * user has presumably raised the limit or signed in). Returns the agents rechecked.
   */
  recheckForUser(): AgentKind[] {
    const agents = new Set<AgentKind>();
    for (const bucket of this.deps.store.list()) {
      if (bucket.state !== "spend_blocked" && bucket.state !== "auth_broken") continue;
      if (!this.hasWaiters(bucket)) continue;
      agents.add(bucket.agent);
      void this.check(bucket.bucket, true);
    }
    return [...agents];
  }

  // ---- Internals ---------------------------------------------------------------------------

  private block(input: {
    owner: QuotaOwner;
    agent: AgentKind;
    bucket: string;
    state: Exclude<BucketState, "unknown" | "available">;
    resetsAt?: string | undefined;
    detail?: string | undefined;
  }): Bucket {
    const { store, clock } = this.deps;
    const existing = store.get(input.bucket);
    const probe = this.probes.get(input.bucket);
    const failedProbe = probe?.owner === input.owner;
    if (failedProbe && probe) {
      this.probes.delete(input.bucket);
      store.recordCheck({
        bucket: input.bucket,
        method: "probe",
        result: "blocked",
        cost: { turns: 1, durationMs: clock.now() - probe.startedAt },
        detail: input.detail,
      });
    }
    const wasBlocked = existing !== undefined && isBlocked(existing.state);
    const bucket = store.block({
      bucket: input.bucket,
      agent: input.agent,
      state: input.state,
      resetsAt: input.resetsAt,
      evidence: input.detail,
      failedChecks: (wasBlocked ? existing.failedChecks : 0) + (failedProbe ? 1 : 0),
      coordinator: input.owner === COORDINATOR_OWNER,
    });
    store.recordCheck({
      bucket: input.bucket,
      method: "signal",
      result: "blocked",
      detail: input.detail,
    });
    this.staggers.get(input.bucket)?.cancel();
    this.staggers.delete(input.bucket);
    const computed = this.computeNext(bucket);
    const scheduled = bucket.nextCheckAt ? Date.parse(bucket.nextCheckAt) : Number.NaN;
    const keep = !failedProbe && this.timers.has(input.bucket) && scheduled <= computed;
    if (!keep) this.schedule(bucket, computed);
    this.deps.log.info("quota blocked", {
      bucket: input.bucket,
      state: input.state,
      resetsAt: bucket.resetsAt,
      owner: input.owner,
    });
    return store.get(input.bucket) as Bucket;
  }

  private computeNext(bucket: Bucket): number {
    const now = this.deps.clock.now();
    return (
      now +
      nextCheckDelay({
        bucket: bucket.bucket,
        now,
        resetsAt: bucket.resetsAt,
        failedChecks: bucket.failedChecks,
        canRead: this.canRead(bucket),
        settings: this.deps.settings(),
      })
    );
  }

  private schedule(bucket: Bucket, at = this.computeNext(bucket)): void {
    if (this.stopped) return;
    const { clock, store } = this.deps;
    store.update(bucket.bucket, { nextCheckAt: new Date(at).toISOString() });
    this.timers.get(bucket.bucket)?.cancel();
    this.timers.set(
      bucket.bucket,
      clock.setTimeout(() => {
        this.timers.delete(bucket.bucket);
        void this.check(bucket.bucket, false);
      }, at - clock.now()),
    );
  }

  private async check(name: string, forceProbe: boolean): Promise<void> {
    if (this.stopped || this.checking.has(name)) return;
    this.checking.add(name);
    try {
      const { store } = this.deps;
      let bucket = store.get(name);
      if (!bucket || !isBlocked(bucket.state)) return;
      if (!this.hasWaiters(bucket)) {
        // Nobody waits any more (Goals cancelled); stop monitoring until something blocks again.
        this.timers.get(name)?.cancel();
        this.timers.delete(name);
        store.update(name, { nextCheckAt: null });
        return;
      }
      if (this.probes.has(name)) {
        this.schedule(bucket);
        return;
      }
      const seen = await this.observe(bucket);
      if (this.stopped) return;
      bucket = store.get(name);
      if (!bucket || !isBlocked(bucket.state)) return;
      store.update(name, { lastCheckedAt: isoNow(this.deps.clock) });
      if (seen.result === "available") {
        this.available(bucket, "read");
        return;
      }
      const mayProbe = bucket.state !== "spend_blocked" || forceProbe;
      if (seen.result === "unknown" && mayProbe) {
        this.probe(bucket);
        this.schedule(store.get(name) as Bucket);
        return;
      }
      store.update(name, {
        failedChecks: bucket.failedChecks + 1,
        resetsAt: seen.resetsAt ?? bucket.resetsAt,
      });
      const updated = store.get(name) as Bucket;
      this.schedule(updated);
      this.deps.stillBlocked(updated);
    } catch (err) {
      this.deps.log.error("quota check failed", { bucket: name, error: err });
    } finally {
      this.checking.delete(name);
    }
  }

  /** A token-free look at the bucket. Recorded as a check. */
  private async observe(bucket: Bucket): Promise<Observation> {
    const adapter = this.deps.adapter(bucket.agent);
    const record = (method: CheckMethod, seen: Observation | "error", detail?: string) => {
      this.deps.store.recordCheck({
        bucket: bucket.bucket,
        method,
        result: seen === "error" ? "error" : seen.result,
        ...(detail ? { detail } : {}),
      });
      return seen === "error" ? ({ result: "unknown" } as const) : seen;
    };
    if (!adapter) return record("read", "error", "agent not available");
    if (bucket.state === "auth_broken") {
      try {
        const detection = await adapter.detect();
        const result =
          detection.loggedIn === true
            ? "available"
            : detection.loggedIn === false
              ? "blocked"
              : "unknown";
        return record("login", { result }, detection.problem);
      } catch (err) {
        return record("login", "error", errorMessage(err));
      }
    }
    if (!adapter.readQuota) return { result: "unknown" };
    try {
      const reading = (await adapter.readQuota()).find((r) => r.bucket === bucket.bucket);
      const result =
        reading?.available === true
          ? "available"
          : reading?.available === false
            ? "blocked"
            : "unknown";
      return record("read", { result, resetsAt: reading?.resetsAt });
    } catch (err) {
      return record("read", "error", errorMessage(err));
    }
  }

  /** Resumes one waiter to find out whether the bucket works again. */
  private probe(bucket: Bucket): void {
    if (this.probes.has(bucket.bucket)) return;
    const startedAt = this.deps.clock.now();
    let owner: QuotaOwner | undefined;
    if (bucket.coordinatorWaiting && this.deps.resumeCoordinator(true)) {
      owner = COORDINATOR_OWNER;
    } else {
      owner = this.deps.waitingRuns(bucket.bucket).find((id) => this.deps.resumeRun(id, true));
    }
    if (!owner) return;
    this.probes.set(bucket.bucket, { owner, startedAt });
    this.deps.store.recordCheck({ bucket: bucket.bucket, method: "probe", result: "started" });
    this.deps.log.info("quota probe", { bucket: bucket.bucket, owner });
  }

  private available(bucket: Bucket, via: CheckMethod): void {
    this.deps.store.update(bucket.bucket, {
      state: "available",
      failedChecks: 0,
      nextCheckAt: null,
      resetsAt: null,
    });
    this.timers.get(bucket.bucket)?.cancel();
    this.timers.delete(bucket.bucket);
    this.deps.log.info("quota available", { bucket: bucket.bucket, via });
    // A successful probe already resumed one waiter; the next one follows after the gap.
    this.stagger(bucket.bucket, via === "probe" ? this.deps.settings().resumeStaggerMs : 0);
  }

  /** Resumes waiters one at a time, stopping if the bucket blocks again. */
  private stagger(name: string, firstDelay: number): void {
    if (this.staggers.has(name) || this.stopped) return;
    const step = () => {
      this.staggers.delete(name);
      const { store } = this.deps;
      const bucket = store.get(name);
      if (this.stopped || bucket?.state !== "available") return;
      let resumed = false;
      if (bucket.coordinatorWaiting) {
        store.update(name, { coordinatorWaiting: false });
        resumed = this.deps.resumeCoordinator(false);
      }
      if (!resumed) {
        resumed = this.deps.waitingRuns(name).some((id) => this.deps.resumeRun(id, false));
      }
      const next = store.get(name);
      if (resumed && next && this.hasWaiters(next)) {
        this.staggers.set(
          name,
          this.deps.clock.setTimeout(step, this.deps.settings().resumeStaggerMs),
        );
      }
    };
    if (firstDelay > 0) this.staggers.set(name, this.deps.clock.setTimeout(step, firstDelay));
    else step();
  }

  private hasWaiters(bucket: Bucket): boolean {
    return bucket.coordinatorWaiting || this.deps.waitingRuns(bucket.bucket).length > 0;
  }

  private canRead(bucket: Bucket): boolean {
    if (bucket.state === "auth_broken") return true;
    return Boolean(this.deps.adapter(bucket.agent)?.readQuota);
  }
}

function isBlocked(state: BucketState): boolean {
  return BLOCKED_STATES.includes(state);
}

function parseTime(iso: string | null | undefined): number | undefined {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}
