/**
 * Schema for Projects' inspected state, each Goal's working copy, and the landing of its work.
 * Appended to the numbered migrations in `src/store/migrations.ts`; never edit it once released.
 */
export const LANDING_MIGRATION = `
  ALTER TABLE projects ADD COLUMN info TEXT;
  ALTER TABLE projects ADD COLUMN inspected_at TEXT;

  CREATE TABLE goal_workspaces (
    goal_id TEXT PRIMARY KEY REFERENCES goals(id),
    mode TEXT NOT NULL,
    repo_root TEXT,
    worktree_path TEXT,
    workdir TEXT NOT NULL,
    branch TEXT,
    base_branch TEXT,
    base_sha TEXT,
    reason TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE landings (
    goal_id TEXT PRIMARY KEY REFERENCES goals(id),
    state TEXT NOT NULL,
    mode TEXT,
    mode_note TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    question_id TEXT,
    publishing TEXT,
    decision TEXT,
    fix_attempts INTEGER NOT NULL DEFAULT 0,
    ci_started_at TEXT,
    candidate_sha TEXT,
    merged_sha TEXT,
    result TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE landing_ops (
    goal_id TEXT NOT NULL REFERENCES goals(id),
    op TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (goal_id, op)
  );
`;
