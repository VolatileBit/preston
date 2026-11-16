import { type Clock, isoNow } from "../clock.js";
import { all, type Db, one, run } from "../store/db.js";
import type { AgentKind } from "../workers/types.js";

/**
 * - `unknown`: never checked. `available`: the last check or signal says work can proceed.
 * - `blocked`: a usage limit ran out. `spend_blocked`: a spending limit was reached (Preston never
 *   buys more). `auth_broken`: the agent's login stopped working (bucket `auth:<agent>`).
 */
export type BucketState = "unknown" | "available" | "blocked" | "auth_broken" | "spend_blocked";

export const BLOCKED_STATES: readonly BucketState[] = ["blocked", "auth_broken", "spend_blocked"];

export interface Bucket {
  bucket: string;
  agent: AgentKind;
  state: BucketState;
  resetsAt: string | null;
  blockedAt: string | null;
  nextCheckAt: string | null;
  failedChecks: number;
  lastCheckedAt: string | null;
  /** What the agent said when it was blocked. */
  evidence: string | null;
  /** The Coordinator itself is waiting for this bucket. */
  coordinatorWaiting: boolean;
}

export type CheckMethod = "signal" | "read" | "login" | "probe";
export type CheckResult = "available" | "blocked" | "unknown" | "error" | "started";

export interface QuotaCheck {
  bucket: string;
  at: string;
  method: CheckMethod;
  result: CheckResult;
  cost: unknown;
  detail: string | null;
}

interface BucketRow {
  bucket: string;
  agent: AgentKind;
  state: BucketState;
  resets_at: string | null;
  blocked_at: string | null;
  next_check_at: string | null;
  failed_checks: number;
  last_checked_at: string | null;
  evidence: string | null;
  coordinator_waiting: number;
}

/** Durable per-bucket quota state and the log of every check and probe. */
export class QuotaStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  get(bucket: string): Bucket | undefined {
    const row = one<BucketRow>(this.db, "SELECT * FROM quota_buckets WHERE bucket = :bucket", {
      bucket,
    });
    return row ? toBucket(row) : undefined;
  }

  list(): Bucket[] {
    return all<BucketRow>(this.db, "SELECT * FROM quota_buckets ORDER BY bucket").map(toBucket);
  }

  /** Records a block (a signal from an agent turn, or a failed check). */
  block(input: {
    bucket: string;
    agent: AgentKind;
    state: Exclude<BucketState, "unknown" | "available">;
    resetsAt?: string | undefined;
    evidence?: string | undefined;
    failedChecks: number;
    coordinator?: boolean;
  }): Bucket {
    const at = isoNow(this.clock);
    const existing = this.get(input.bucket);
    const stillBlocked = existing && BLOCKED_STATES.includes(existing.state);
    // The newest signal wins; without a reset time, one already known for this block stays.
    const keep = input.resetsAt ?? (stillBlocked ? existing.resetsAt : null);
    run(
      this.db,
      `INSERT INTO quota_buckets (bucket, agent, state, resets_at, blocked_at, failed_checks, evidence, coordinator_waiting, updated_at)
       VALUES (:bucket, :agent, :state, :resets, :at, :failed, :evidence, :coord, :at)
       ON CONFLICT (bucket) DO UPDATE SET agent = :agent, state = :state, resets_at = :resets,
         blocked_at = COALESCE(CASE WHEN state IN ('blocked', 'auth_broken', 'spend_blocked') THEN blocked_at END, :at),
         failed_checks = :failed, evidence = COALESCE(:evidence, evidence),
         coordinator_waiting = MAX(coordinator_waiting, :coord), updated_at = :at`,
      {
        bucket: input.bucket,
        agent: input.agent,
        state: input.state,
        resets: keep ?? null,
        at,
        failed: input.failedChecks,
        evidence: input.evidence?.slice(0, 2000) ?? null,
        coord: input.coordinator ? 1 : 0,
      },
    );
    return this.get(input.bucket) as Bucket;
  }

  update(
    bucket: string,
    patch: Partial<{
      state: BucketState;
      resetsAt: string | null;
      nextCheckAt: string | null;
      failedChecks: number;
      lastCheckedAt: string;
      coordinatorWaiting: boolean;
    }>,
  ): void {
    const columns: Record<string, string> = {
      state: "state",
      resetsAt: "resets_at",
      nextCheckAt: "next_check_at",
      failedChecks: "failed_checks",
      lastCheckedAt: "last_checked_at",
      coordinatorWaiting: "coordinator_waiting",
    };
    const sets = ["updated_at = :at"];
    const params: Record<string, string | number | null> = { bucket, at: isoNow(this.clock) };
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = :${key}`);
      params[key] = typeof value === "boolean" ? Number(value) : value;
    }
    run(this.db, `UPDATE quota_buckets SET ${sets.join(", ")} WHERE bucket = :bucket`, params);
  }

  recordCheck(
    check: Omit<QuotaCheck, "at" | "cost" | "detail"> & { cost?: unknown; detail?: string },
  ) {
    run(
      this.db,
      `INSERT INTO quota_checks (bucket, at, method, result, cost, detail)
       VALUES (:bucket, :at, :method, :result, :cost, :detail)`,
      {
        bucket: check.bucket,
        at: isoNow(this.clock),
        method: check.method,
        result: check.result,
        cost: check.cost === undefined ? null : JSON.stringify(check.cost),
        detail: check.detail?.slice(0, 1000) ?? null,
      },
    );
  }

  checks(bucket: string): QuotaCheck[] {
    return all<{
      bucket: string;
      at: string;
      method: CheckMethod;
      result: CheckResult;
      cost: string | null;
      detail: string | null;
    }>(this.db, "SELECT * FROM quota_checks WHERE bucket = :bucket ORDER BY id", { bucket }).map(
      (r) => ({ ...r, cost: r.cost ? JSON.parse(r.cost) : null }),
    );
  }
}

function toBucket(row: BucketRow): Bucket {
  return {
    bucket: row.bucket,
    agent: row.agent,
    state: row.state,
    resetsAt: row.resets_at,
    blockedAt: row.blocked_at,
    nextCheckAt: row.next_check_at,
    failedChecks: row.failed_checks,
    lastCheckedAt: row.last_checked_at,
    evidence: row.evidence,
    coordinatorWaiting: row.coordinator_waiting === 1,
  };
}
