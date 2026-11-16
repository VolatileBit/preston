import { type Clock, isoNow } from "../clock.js";
import { all, type Db, one, run } from "../store/db.js";
import type { LandResult } from "./hooks.js";
import type { ProjectInfo } from "./project.js";
import type { PublishingVerdict } from "./publishing.js";
import type { LeftOut } from "./stage.js";

export interface Workspace {
  goalId: string;
  mode: "worktree" | "in_place";
  repoRoot: string | null;
  /** The worktree's top folder. */
  worktreePath: string | null;
  /** Where the Worker and the checks run (the worktree, plus the Project's folder inside it). */
  workdir: string;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string | null;
  /** Why the work is in place although the Project is a repository. */
  reason: string | null;
  /**
   * `active`: the folder exists. `archived`: the folder was removed to save space and the branch
   * kept. `removed`: folder and branch are gone (the work landed or there was none).
   */
  state: "active" | "archived" | "removed";
}

export type LandingState = "active" | "awaiting_user" | "awaiting_worker" | "done";

export interface LandingRecord {
  goalId: string;
  state: LandingState;
  mode: "pr" | "local" | null;
  modeNote: string | null;
  prNumber: number | null;
  prUrl: string | null;
  questionId: string | null;
  publishing: PublishingVerdict | null;
  decision: "yes" | "no" | null;
  fixAttempts: number;
  ciStartedAt: string | null;
  candidateSha: string | null;
  mergedSha: string | null;
  /** New files committed without: generated folders, large binary files. */
  leftOut: LeftOut[];
  result: LandResult | null;
}

interface WorkspaceRow {
  goal_id: string;
  mode: Workspace["mode"];
  repo_root: string | null;
  worktree_path: string | null;
  workdir: string;
  branch: string | null;
  base_branch: string | null;
  base_sha: string | null;
  reason: string | null;
  state: Workspace["state"];
}

interface LandingRow {
  goal_id: string;
  state: LandingState;
  mode: "pr" | "local" | null;
  mode_note: string | null;
  pr_number: number | null;
  pr_url: string | null;
  question_id: string | null;
  publishing: string | null;
  decision: "yes" | "no" | null;
  fix_attempts: number;
  ci_started_at: string | null;
  candidate_sha: string | null;
  merged_sha: string | null;
  left_out: string | null;
  result: string | null;
}

const LANDING_COLUMNS: Record<string, string> = {
  state: "state",
  mode: "mode",
  modeNote: "mode_note",
  prNumber: "pr_number",
  prUrl: "pr_url",
  questionId: "question_id",
  publishing: "publishing",
  decision: "decision",
  fixAttempts: "fix_attempts",
  ciStartedAt: "ci_started_at",
  candidateSha: "candidate_sha",
  mergedSha: "merged_sha",
  leftOut: "left_out",
  result: "result",
};

/** Durable records of Projects' inspected state, Goal working copies and landings. */
export class LandingStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  // ---- Projects ----------------------------------------------------------------------------

  saveProjectInfo(projectId: string, info: ProjectInfo): void {
    run(this.db, "UPDATE projects SET info = :info, inspected_at = :at WHERE id = :id", {
      id: projectId,
      info: JSON.stringify(info),
      at: info.inspectedAt,
    });
  }

  projects(): {
    id: string;
    path: string;
    name: string;
    createdAt: string;
    info: ProjectInfo | null;
    activeGoals: number;
    totalGoals: number;
  }[] {
    return all<{
      id: string;
      path: string;
      name: string;
      created_at: string;
      info: string | null;
      active: number;
      total: number;
    }>(
      this.db,
      `SELECT p.id, p.path, p.name, p.created_at, p.info,
         (SELECT COUNT(*) FROM goals g WHERE g.project_id = p.id AND g.ended_at IS NULL) AS active,
         (SELECT COUNT(*) FROM goals g WHERE g.project_id = p.id) AS total
       FROM projects p ORDER BY p.created_at, p.rowid`,
    ).map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      createdAt: r.created_at,
      info: r.info ? (JSON.parse(r.info) as ProjectInfo) : null,
      activeGoals: r.active,
      totalGoals: r.total,
    }));
  }

  // ---- Working copies ----------------------------------------------------------------------

  workspace(goalId: string): Workspace | undefined {
    const row = one<WorkspaceRow>(this.db, "SELECT * FROM goal_workspaces WHERE goal_id = :id", {
      id: goalId,
    });
    return row
      ? {
          goalId: row.goal_id,
          mode: row.mode,
          repoRoot: row.repo_root,
          worktreePath: row.worktree_path,
          workdir: row.workdir,
          branch: row.branch,
          baseBranch: row.base_branch,
          baseSha: row.base_sha,
          reason: row.reason,
          state: row.state,
        }
      : undefined;
  }

  saveWorkspace(w: Omit<Workspace, "state"> & { state?: Workspace["state"] }): void {
    const at = isoNow(this.clock);
    run(
      this.db,
      `INSERT INTO goal_workspaces (goal_id, mode, repo_root, worktree_path, workdir, branch, base_branch, base_sha, reason, state, created_at, updated_at)
       VALUES (:goal, :mode, :root, :path, :workdir, :branch, :base, :sha, :reason, :state, :at, :at)
       ON CONFLICT (goal_id) DO UPDATE SET mode = :mode, repo_root = :root, worktree_path = :path,
         workdir = :workdir, branch = :branch, base_branch = :base, base_sha = :sha, reason = :reason,
         state = :state, updated_at = :at`,
      {
        goal: w.goalId,
        mode: w.mode,
        root: w.repoRoot,
        path: w.worktreePath,
        workdir: w.workdir,
        branch: w.branch,
        base: w.baseBranch,
        sha: w.baseSha,
        reason: w.reason,
        state: w.state ?? "active",
        at,
      },
    );
  }

  /** Working copies whose folders still exist. */
  activeWorktrees(): Workspace[] {
    return all<{ goal_id: string }>(
      this.db,
      "SELECT goal_id FROM goal_workspaces WHERE mode = 'worktree' AND state = 'active' ORDER BY created_at, rowid",
    )
      .map((r) => this.workspace(r.goal_id))
      .filter((w): w is Workspace => w !== undefined);
  }

  setWorkspaceState(goalId: string, state: Workspace["state"]): void {
    run(
      this.db,
      "UPDATE goal_workspaces SET state = :state, updated_at = :at WHERE goal_id = :id",
      { id: goalId, state, at: isoNow(this.clock) },
    );
  }

  // ---- Landings ----------------------------------------------------------------------------

  landing(goalId: string): LandingRecord | undefined {
    const row = one<LandingRow>(this.db, "SELECT * FROM landings WHERE goal_id = :id", {
      id: goalId,
    });
    return row ? toLanding(row) : undefined;
  }

  landingByQuestion(questionId: string): LandingRecord | undefined {
    const row = one<LandingRow>(this.db, "SELECT * FROM landings WHERE question_id = :id", {
      id: questionId,
    });
    return row ? toLanding(row) : undefined;
  }

  ensureLanding(goalId: string): LandingRecord {
    run(
      this.db,
      "INSERT OR IGNORE INTO landings (goal_id, state, updated_at) VALUES (:id, 'active', :at)",
      { id: goalId, at: isoNow(this.clock) },
    );
    return this.landing(goalId) as LandingRecord;
  }

  updateLanding(
    goalId: string,
    patch: Partial<{
      state: LandingState;
      mode: "pr" | "local" | null;
      modeNote: string | null;
      prNumber: number;
      prUrl: string;
      questionId: string | null;
      publishing: PublishingVerdict | null;
      decision: "yes" | "no" | null;
      fixAttempts: number;
      ciStartedAt: string | null;
      candidateSha: string;
      mergedSha: string;
      leftOut: LeftOut[];
      result: LandResult | null;
    }>,
  ): void {
    const sets = ["updated_at = :at"];
    const params: Record<string, string | number | null> = { id: goalId, at: isoNow(this.clock) };
    for (const [key, value] of Object.entries(patch)) {
      const column = LANDING_COLUMNS[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = :${key}`);
      params[key] = value === null || typeof value !== "object" ? value : JSON.stringify(value);
    }
    run(this.db, `UPDATE landings SET ${sets.join(", ")} WHERE goal_id = :id`, params);
  }

  /** Records a durable operation once; returns false when it was already recorded. */
  recordOp(goalId: string, op: string, detail?: string): boolean {
    return (
      run(
        this.db,
        "INSERT OR IGNORE INTO landing_ops (goal_id, op, detail, at) VALUES (:goal, :op, :detail, :at)",
        { goal: goalId, op, detail: detail ?? null, at: isoNow(this.clock) },
      ) > 0
    );
  }

  hasOp(goalId: string, op: string): boolean {
    return Boolean(
      one(this.db, "SELECT 1 AS x FROM landing_ops WHERE goal_id = :goal AND op = :op", {
        goal: goalId,
        op,
      }),
    );
  }

  ops(goalId: string): string[] {
    return all<{ op: string }>(
      this.db,
      "SELECT op FROM landing_ops WHERE goal_id = :goal ORDER BY rowid",
      { goal: goalId },
    ).map((r) => r.op);
  }
}

function toLanding(row: LandingRow): LandingRecord {
  return {
    goalId: row.goal_id,
    state: row.state,
    mode: row.mode,
    modeNote: row.mode_note,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    questionId: row.question_id,
    publishing: row.publishing ? (JSON.parse(row.publishing) as PublishingVerdict) : null,
    decision: row.decision,
    fixAttempts: row.fix_attempts,
    ciStartedAt: row.ci_started_at,
    candidateSha: row.candidate_sha,
    mergedSha: row.merged_sha,
    leftOut: row.left_out ? (JSON.parse(row.left_out) as LeftOut[]) : [],
    result: row.result ? (JSON.parse(row.result) as LandResult) : null,
  };
}
