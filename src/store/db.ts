import { chmodSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type Clock, isoNow } from "../clock.js";
import { MIGRATIONS } from "./migrations.js";

export type Db = DatabaseSync;
export type SqlParams = Record<string, SQLInputValue>;

/** Opens (creating if needed) Preston's SQLite database and applies pending migrations. */
export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort; the home directory is already owner-only.
    }
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Preston's database is from a newer version (schema ${current}); update Preston to continue.`,
    );
  }
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version - 1] as string);
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}

/** Runs `fn` atomically. Nested calls join the outer transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function all<T>(db: Db, sql: string, params: SqlParams = {}): T[] {
  return db.prepare(sql).all(params) as T[];
}

export function one<T>(db: Db, sql: string, params: SqlParams = {}): T | undefined {
  return db.prepare(sql).get(params) as T | undefined;
}

export function run(db: Db, sql: string, params: SqlParams = {}): number {
  return Number(db.prepare(sql).run(params).changes);
}

/** Appends to the durable event log (an audit trail of what Preston did and why). */
export function recordEvent(
  db: Db,
  clock: Clock,
  type: string,
  ref: { goalId?: string | null; runId?: string | null },
  data?: unknown,
): void {
  run(
    db,
    "INSERT INTO events (at, goal_id, run_id, type, data) VALUES (:at, :goal, :run, :type, :data)",
    {
      at: isoNow(clock),
      goal: ref.goalId ?? null,
      run: ref.runId ?? null,
      type,
      data: data === undefined ? null : JSON.stringify(data),
    },
  );
}
