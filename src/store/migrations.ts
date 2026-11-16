import { LANDING_MIGRATION } from "../landing/migration.js";

/**
 * Forward-only, numbered schema migrations. Migration N is `MIGRATIONS[N - 1]` and the applied
 * version is kept in `PRAGMA user_version`. Never edit a released migration; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: Projects, Goals with their Brief, Runs, Sessions, verification, questions, outbox,
  //    events and config versions.
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    parent_goal_id TEXT REFERENCES goals(id),
    state TEXT NOT NULL,
    outcome TEXT,
    brief TEXT NOT NULL,
    state_detail TEXT,
    origin_channel TEXT,
    origin_conversation TEXT,
    wake_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX goals_by_state ON goals(state);

  CREATE TABLE sessions (
    agent TEXT NOT NULL,
    native_id TEXT NOT NULL,
    role TEXT NOT NULL,
    workdir TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (agent, native_id)
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    agent TEXT NOT NULL,
    state TEXT NOT NULL,
    session_id TEXT,
    workdir TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    recoveries INTEGER NOT NULL DEFAULT 0,
    fix_attempts INTEGER NOT NULL DEFAULT 0,
    report TEXT,
    report_pending INTEGER NOT NULL DEFAULT 0,
    brief_changed INTEGER NOT NULL DEFAULT 0,
    transcript_dir TEXT NOT NULL,
    end_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX runs_by_goal ON runs(goal_id);

  CREATE TABLE verifications (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    passed INTEGER NOT NULL,
    results TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL
  );

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    goal_id TEXT REFERENCES goals(id),
    run_id TEXT REFERENCES runs(id),
    asked_by TEXT NOT NULL,
    text TEXT NOT NULL,
    human_text TEXT,
    state TEXT NOT NULL,
    answer TEXT,
    answered_by TEXT,
    answered_via TEXT,
    answer_delivered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    escalated_at TEXT,
    answered_at TEXT
  );
  CREATE INDEX questions_by_state ON questions(state);

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT UNIQUE,
    channel TEXT NOT NULL,
    conversation_id TEXT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to TEXT,
    goal_id TEXT,
    question_id TEXT,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    delivered_ref TEXT,
    marked_answered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX outbox_by_state ON outbox(state, next_attempt_at);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    goal_id TEXT,
    run_id TEXT,
    type TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX events_by_goal ON events(goal_id);

  CREATE TABLE config_versions (
    version INTEGER PRIMARY KEY,
    config TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 2: Escalated approvals. Each is linked to a Worker question, which parks and resumes the Run.
  `
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    question_id TEXT NOT NULL UNIQUE REFERENCES questions(id),
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    policy_reason TEXT NOT NULL,
    state TEXT NOT NULL,
    decided_by TEXT,
    decision_reason TEXT,
    worker_told TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX approvals_by_state ON approvals(state);
  `,
  // 3: Quota buckets and their checks, supervision counters on Runs, Goal attempts and
  //    idempotency keys, tracked agent processes, and durable inbound owner messages.
  `
  CREATE TABLE quota_buckets (
    bucket TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    state TEXT NOT NULL,
    resets_at TEXT,
    blocked_at TEXT,
    next_check_at TEXT,
    failed_checks INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    evidence TEXT,
    coordinator_waiting INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE quota_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket TEXT NOT NULL,
    at TEXT NOT NULL,
    method TEXT NOT NULL,
    result TEXT NOT NULL,
    cost TEXT,
    detail TEXT
  );
  CREATE INDEX quota_checks_by_bucket ON quota_checks(bucket);

  ALTER TABLE runs ADD COLUMN quota_bucket TEXT;
  ALTER TABLE runs ADD COLUMN waiting_since TEXT;
  ALTER TABLE runs ADD COLUMN rate_limit_hits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN stalls INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN strategy_pending INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN last_message TEXT;
  CREATE INDEX runs_by_quota_bucket ON runs(quota_bucket);

  ALTER TABLE goals ADD COLUMN attempts TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE goals ADD COLUMN source_key TEXT;
  CREATE INDEX goals_by_source_key ON goals(source_key);

  CREATE TABLE agent_processes (
    pid INTEGER NOT NULL,
    identity TEXT NOT NULL,
    owner TEXT NOT NULL,
    agent TEXT NOT NULL,
    started_at TEXT NOT NULL,
    PRIMARY KEY (pid, identity)
  );

  CREATE TABLE inbound_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    ref TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    text TEXT NOT NULL,
    received_at TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    handled_at TEXT,
    UNIQUE (channel, ref)
  );
  CREATE INDEX inbound_by_state ON inbound_messages(state);
  `, // 4: Standing orders (versioned), schedules with their run keys, and the memory search index
  //    (the Markdown files are the source of truth; the FTS table is created in code when the
  //    SQLite build supports FTS5).
  `
  CREATE TABLE standing_order_versions (
    order_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    origin TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    definition TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (order_id, version)
  );

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    timezone TEXT NOT NULL,
    job TEXT NOT NULL,
    project_path TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    next_run TEXT,
    overlap TEXT NOT NULL,
    missed_run TEXT NOT NULL,
    delivery TEXT NOT NULL,
    origin_channel TEXT,
    origin_conversation TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    scheduled_for TEXT NOT NULL,
    source TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    goal_id TEXT REFERENCES goals(id),
    outcome TEXT,
    missed_count INTEGER NOT NULL DEFAULT 0,
    standing_order_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (schedule_id, scheduled_for)
  );
  CREATE INDEX schedule_runs_by_state ON schedule_runs(state);
  CREATE INDEX schedule_runs_by_goal ON schedule_runs(goal_id);

  CREATE TABLE memory_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    scope TEXT NOT NULL,
    text TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    UNIQUE (kind, ref)
  );
  CREATE INDEX memory_docs_by_scope ON memory_docs(kind, scope);
  `,
  // 5: Projects' inspected state, Goal working copies (worktrees) and landing of the work.
  LANDING_MIGRATION,
  // 6: What landing left out of a commit (generated folders, large binary files).
  `
  ALTER TABLE landings ADD COLUMN left_out TEXT;
  `,
];
