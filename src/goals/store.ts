import { basename } from "node:path";
import type { ChannelKind } from "../channels/types.js";
import { type Clock, isoNow } from "../clock.js";
import { all, type Db, one, run } from "../store/db.js";
import { newId } from "../util/ids.js";
import type { AgentKind } from "../workers/types.js";
import type { AgentChoice } from "./agents.js";
import { type Brief, briefSchema } from "./brief.js";
import type { CheckResult } from "./checks.js";

export type GoalState =
  | "queued"
  | "running"
  | "verifying"
  | "completed"
  | "waiting_for_quota"
  | "waiting_for_user"
  | "waiting_for_login"
  | "recovering"
  | "paused"
  | "blocked"
  | "failed"
  | "cancelled";

export const TERMINAL_GOAL_STATES: readonly GoalState[] = [
  "completed",
  "blocked",
  "failed",
  "cancelled",
];

export type Outcome = "verified" | "unverified";

/** `active`: a turn is executing. `parked`: waiting (answer, quota, resume). `ended`: done. */
export type RunState = "active" | "parked" | "ended";

/** One tactic Preston tried for a Goal, so it changes strategy instead of repeating itself. */
export interface Attempt {
  at: string;
  runId: string;
  agent: AgentKind;
  tactic:
    | "stall_resume"
    | "strategy_event"
    | "retry_with_note"
    | "fresh_session"
    | "switch_agent"
    | "quota_handover"
    | "report_blocked";
  reason: string;
}

export interface Origin {
  channel: ChannelKind;
  conversationId: string;
}

export interface Goal {
  id: string;
  projectId: string;
  projectPath: string;
  parentGoalId: string | null;
  state: GoalState;
  outcome: Outcome | null;
  brief: Brief;
  /** Plain-language reason for the current state (blocked, failed, paused, waiting). */
  detail: string | null;
  origin: Origin | null;
  wakeAt: string | null;
  /** Tactics tried so far (stall recovery, strategy changes, agent handovers). */
  attempts: Attempt[];
  /** The agent the Goal started on and why. */
  agentChoice: AgentChoice | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface WorkerReport {
  summary: string;
  checksPerformed: string[];
  suggestedVerificationCommands: string[];
  blockers: string[];
  /** Files the user should receive with the result (older reports have none). */
  deliverables?: string[];
}

export interface Run {
  id: string;
  goalId: string;
  agent: AgentKind;
  state: RunState;
  sessionId: string | null;
  workdir: string;
  turns: number;
  recoveries: number;
  fixAttempts: number;
  report: WorkerReport | null;
  /** A report arrived that has not been verified yet. */
  reportPending: boolean;
  /** The Brief changed while this Run was working; tell the Worker at the next turn boundary. */
  briefChanged: boolean;
  transcriptDir: string;
  endReason: string | null;
  /** The quota bucket (or `auth:<agent>`) this parked Run waits for. */
  quotaBucket: string | null;
  /** When the current wait for quota began. */
  waitingSince: string | null;
  /** Consecutive transient rate limits, for the short backoff. */
  rateLimitHits: number;
  /** Stalls since the last strategy change. */
  stalls: number;
  /** A Coordinator event is out to decide how this Run continues. */
  strategyPending: boolean;
  /** The Worker's latest message, kept for a handover checkpoint. */
  lastMessage: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface Verification {
  id: string;
  runId: string;
  passed: boolean;
  results: CheckResult[];
  startedAt: string;
  endedAt: string;
}

interface GoalRow {
  id: string;
  project_id: string;
  project_path: string;
  parent_goal_id: string | null;
  state: GoalState;
  outcome: Outcome | null;
  brief: string;
  state_detail: string | null;
  origin_channel: ChannelKind | null;
  origin_conversation: string | null;
  wake_at: string | null;
  attempts: string;
  agent_choice: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

interface RunRow {
  id: string;
  goal_id: string;
  agent: AgentKind;
  state: RunState;
  session_id: string | null;
  workdir: string;
  turns: number;
  recoveries: number;
  fix_attempts: number;
  report: string | null;
  report_pending: number;
  brief_changed: number;
  transcript_dir: string;
  end_reason: string | null;
  quota_bucket: string | null;
  waiting_since: string | null;
  rate_limit_hits: number;
  stalls: number;
  strategy_pending: number;
  last_message: string | null;
  created_at: string;
  ended_at: string | null;
}

const GOAL_SELECT = `SELECT g.*, p.path AS project_path FROM goals g JOIN projects p ON p.id = g.project_id`;

/** Durable Goal, Run, Session and verification records. */
export class GoalStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  ensureProject(path: string): string {
    const existing = one<{ id: string }>(this.db, "SELECT id FROM projects WHERE path = :path", {
      path,
    });
    if (existing) return existing.id;
    const id = newId("p");
    run(
      this.db,
      "INSERT INTO projects (id, path, name, created_at) VALUES (:id, :path, :name, :at)",
      { id, path, name: basename(path) || path, at: this.now() },
    );
    return id;
  }

  createGoal(input: {
    projectId: string;
    brief: Brief;
    parentGoalId?: string | undefined;
    origin?: Origin | undefined;
    sourceKey?: string | undefined;
    agentChoice?: AgentChoice | undefined;
  }): Goal {
    const id = newId("g");
    const at = this.now();
    run(
      this.db,
      `INSERT INTO goals (id, project_id, parent_goal_id, state, brief, origin_channel, origin_conversation, source_key, agent_choice, created_at, updated_at)
       VALUES (:id, :project, :parent, 'queued', :brief, :channel, :conversation, :source, :choice, :at, :at)`,
      {
        source: input.sourceKey ?? null,
        choice: input.agentChoice ? JSON.stringify(input.agentChoice) : null,
        id,
        project: input.projectId,
        parent: input.parentGoalId ?? null,
        brief: JSON.stringify(input.brief),
        channel: input.origin?.channel ?? null,
        conversation: input.origin?.conversationId ?? null,
        at,
      },
    );
    return this.goal(id);
  }

  findGoal(id: string): Goal | undefined {
    const row = one<GoalRow>(this.db, `${GOAL_SELECT} WHERE g.id = :id`, { id });
    return row ? toGoal(row) : undefined;
  }

  /** A Goal already created for this idempotency key with this objective (a replayed request). */
  findGoalBySource(sourceKey: string, objective: string): Goal | undefined {
    return all<GoalRow>(this.db, `${GOAL_SELECT} WHERE g.source_key = :key`, { key: sourceKey })
      .map(toGoal)
      .find((g) => g.brief.objective === objective);
  }

  addAttempt(goalId: string, attempt: Omit<Attempt, "at">): void {
    const goal = this.goal(goalId);
    const attempts = [...goal.attempts, { at: this.now(), ...attempt }].slice(-50);
    run(this.db, "UPDATE goals SET attempts = :attempts WHERE id = :id", {
      id: goalId,
      attempts: JSON.stringify(attempts),
    });
  }

  goal(id: string): Goal {
    const goal = this.findGoal(id);
    if (!goal) throw new Error(`Unknown goal ${id}`);
    return goal;
  }

  /** Non-terminal Goals first (oldest first), then the most recently finished ones. */
  listGoals(options: { finishedLimit?: number } = {}): Goal[] {
    const active = all<GoalRow>(
      this.db,
      `${GOAL_SELECT} WHERE g.state NOT IN (${terminalList()}) ORDER BY g.created_at, g.rowid`,
    ).map(toGoal);
    const finished = all<GoalRow>(
      this.db,
      `${GOAL_SELECT} WHERE g.state IN (${terminalList()}) ORDER BY g.ended_at DESC, g.rowid DESC LIMIT :limit`,
      { limit: options.finishedLimit ?? 10 },
    ).map(toGoal);
    return [...active, ...finished];
  }

  activeGoals(): Goal[] {
    return this.listGoals({ finishedLimit: 0 });
  }

  setGoalState(
    id: string,
    state: GoalState,
    extra: { outcome?: Outcome; detail?: string | null; wakeAt?: string | null } = {},
  ): void {
    const terminal = TERMINAL_GOAL_STATES.includes(state);
    run(
      this.db,
      `UPDATE goals SET state = :state, outcome = :outcome, state_detail = :detail, wake_at = :wake,
         updated_at = :at, ended_at = CASE WHEN :terminal THEN :at ELSE NULL END
       WHERE id = :id`,
      {
        id,
        state,
        outcome: extra.outcome ?? null,
        detail: extra.detail ?? null,
        wake: extra.wakeAt ?? null,
        terminal: terminal ? 1 : 0,
        at: this.now(),
      },
    );
  }

  updateBrief(id: string, brief: Brief): void {
    run(this.db, "UPDATE goals SET brief = :brief, updated_at = :at WHERE id = :id", {
      id,
      brief: JSON.stringify(brief),
      at: this.now(),
    });
    run(
      this.db,
      "UPDATE runs SET brief_changed = 1, updated_at = :at WHERE goal_id = :id AND state != 'ended'",
      { id, at: this.now() },
    );
  }

  createRun(input: {
    goalId: string;
    agent: AgentKind;
    workdir: string;
    transcriptDir: (runId: string) => string;
  }): Run {
    const id = newId("r");
    const at = this.now();
    run(
      this.db,
      `INSERT INTO runs (id, goal_id, agent, state, workdir, transcript_dir, created_at, updated_at)
       VALUES (:id, :goal, :agent, 'parked', :workdir, :transcripts, :at, :at)`,
      {
        id,
        goal: input.goalId,
        agent: input.agent,
        workdir: input.workdir,
        transcripts: input.transcriptDir(id),
        at,
      },
    );
    return this.run(id);
  }

  findRun(id: string): Run | undefined {
    const row = one<RunRow>(this.db, "SELECT * FROM runs WHERE id = :id", { id });
    return row ? toRun(row) : undefined;
  }

  run(id: string): Run {
    const found = this.findRun(id);
    if (!found) throw new Error(`Unknown run ${id}`);
    return found;
  }

  /** The agent that handled the Project's most recent Run, for stickiness. */
  lastAgentForProject(path: string): AgentKind | undefined {
    return one<{ agent: AgentKind }>(
      this.db,
      `SELECT r.agent FROM runs r JOIN goals g ON g.id = r.goal_id JOIN projects p ON p.id = g.project_id
       WHERE p.path = :path ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
      { path },
    )?.agent;
  }

  /** The Goal's Run that has not ended, if any. */
  currentRun(goalId: string): Run | undefined {
    const row = one<RunRow>(
      this.db,
      "SELECT * FROM runs WHERE goal_id = :goal AND state != 'ended' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      { goal: goalId },
    );
    return row ? toRun(row) : undefined;
  }

  /** A Run on this agent has a turn executing, or is between turns of a Goal that is working. */
  usesAgent(agent: AgentKind): boolean {
    return (
      one(
        this.db,
        `SELECT 1 AS used FROM runs r JOIN goals g ON g.id = r.goal_id
         WHERE r.agent = :agent AND r.state != 'ended'
           AND (r.state = 'active' OR g.state IN ('queued', 'running', 'verifying', 'recovering'))
         LIMIT 1`,
        { agent },
      ) !== undefined
    );
  }

  /** Parked Runs waiting on a quota bucket whose Goal still waits for it, longest wait first. */
  waitingRuns(bucket: string): Run[] {
    return all<RunRow>(
      this.db,
      `SELECT r.* FROM runs r JOIN goals g ON g.id = r.goal_id
       WHERE r.quota_bucket = :bucket AND r.state = 'parked'
         AND g.state IN ('waiting_for_quota', 'waiting_for_login')
       ORDER BY r.waiting_since, r.rowid`,
      { bucket },
    ).map(toRun);
  }

  /** Runs a Coordinator decision is pending for. */
  strategyPendingRuns(): Run[] {
    return all<RunRow>(
      this.db,
      "SELECT * FROM runs WHERE strategy_pending = 1 AND state != 'ended' ORDER BY rowid",
    ).map(toRun);
  }

  runsForGoal(goalId: string): Run[] {
    return all<RunRow>(this.db, "SELECT * FROM runs WHERE goal_id = :goal ORDER BY rowid", {
      goal: goalId,
    }).map(toRun);
  }

  updateRun(
    id: string,
    patch: Partial<{
      state: RunState;
      sessionId: string;
      turns: number;
      recoveries: number;
      fixAttempts: number;
      report: WorkerReport;
      reportPending: boolean;
      briefChanged: boolean;
      endReason: string;
      quotaBucket: string | null;
      waitingSince: string | null;
      rateLimitHits: number;
      stalls: number;
      strategyPending: boolean;
      lastMessage: string;
      workdir: string;
    }>,
  ): void {
    const columns: Record<string, string> = {
      state: "state",
      sessionId: "session_id",
      turns: "turns",
      recoveries: "recoveries",
      fixAttempts: "fix_attempts",
      report: "report",
      reportPending: "report_pending",
      briefChanged: "brief_changed",
      endReason: "end_reason",
      quotaBucket: "quota_bucket",
      waitingSince: "waiting_since",
      rateLimitHits: "rate_limit_hits",
      stalls: "stalls",
      strategyPending: "strategy_pending",
      lastMessage: "last_message",
      workdir: "workdir",
    };
    const sets: string[] = ["updated_at = :at"];
    const params: Record<string, string | number | null> = { id, at: this.now() };
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = :${key}`);
      params[key] =
        value === null
          ? null
          : typeof value === "boolean"
            ? Number(value)
            : typeof value === "object"
              ? JSON.stringify(value)
              : value;
    }
    if (patch.state === "ended") sets.push("ended_at = :at");
    run(this.db, `UPDATE runs SET ${sets.join(", ")} WHERE id = :id`, params);
  }

  recordSession(
    agent: AgentKind,
    nativeId: string,
    role: "worker" | "coordinator",
    workdir: string,
  ): void {
    run(
      this.db,
      `INSERT INTO sessions (agent, native_id, role, workdir, created_at, last_used_at)
       VALUES (:agent, :id, :role, :workdir, :at, :at)
       ON CONFLICT (agent, native_id) DO UPDATE SET last_used_at = :at`,
      { agent, id: nativeId, role, workdir, at: this.now() },
    );
  }

  latestSession(role: "worker" | "coordinator", agent: AgentKind): string | undefined {
    return one<{ native_id: string }>(
      this.db,
      "SELECT native_id FROM sessions WHERE role = :role AND agent = :agent ORDER BY last_used_at DESC, rowid DESC LIMIT 1",
      { role, agent },
    )?.native_id;
  }

  addVerification(v: Omit<Verification, "id"> & { goalId: string }): void {
    run(
      this.db,
      `INSERT INTO verifications (id, goal_id, run_id, passed, results, started_at, ended_at)
       VALUES (:id, :goal, :run, :passed, :results, :started, :ended)`,
      {
        id: newId("v"),
        goal: v.goalId,
        run: v.runId,
        passed: v.passed ? 1 : 0,
        results: JSON.stringify(v.results),
        started: v.startedAt,
        ended: v.endedAt,
      },
    );
  }

  verifications(goalId: string): Verification[] {
    return all<{
      id: string;
      run_id: string;
      passed: number;
      results: string;
      started_at: string;
      ended_at: string;
    }>(this.db, "SELECT * FROM verifications WHERE goal_id = :goal ORDER BY rowid", {
      goal: goalId,
    }).map((r) => ({
      id: r.id,
      runId: r.run_id,
      passed: r.passed === 1,
      results: JSON.parse(r.results) as CheckResult[],
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  }

  private now(): string {
    return isoNow(this.clock);
  }
}

function terminalList(): string {
  return TERMINAL_GOAL_STATES.map((s) => `'${s}'`).join(", ");
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    projectId: row.project_id,
    projectPath: row.project_path,
    parentGoalId: row.parent_goal_id,
    state: row.state,
    outcome: row.outcome,
    brief: briefSchema.parse(JSON.parse(row.brief)),
    detail: row.state_detail,
    origin:
      row.origin_channel && row.origin_conversation
        ? { channel: row.origin_channel, conversationId: row.origin_conversation }
        : null,
    wakeAt: row.wake_at,
    attempts: JSON.parse(row.attempts) as Attempt[],
    agentChoice: row.agent_choice ? (JSON.parse(row.agent_choice) as AgentChoice) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    goalId: row.goal_id,
    agent: row.agent,
    state: row.state,
    sessionId: row.session_id,
    workdir: row.workdir,
    turns: row.turns,
    recoveries: row.recoveries,
    fixAttempts: row.fix_attempts,
    report: row.report ? (JSON.parse(row.report) as WorkerReport) : null,
    reportPending: row.report_pending === 1,
    briefChanged: row.brief_changed === 1,
    transcriptDir: row.transcript_dir,
    endReason: row.end_reason,
    quotaBucket: row.quota_bucket,
    waitingSince: row.waiting_since,
    rateLimitHits: row.rate_limit_hits,
    stalls: row.stalls,
    strategyPending: row.strategy_pending === 1,
    lastMessage: row.last_message,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}
