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
];
