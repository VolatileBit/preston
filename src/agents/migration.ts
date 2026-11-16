/**
 * Schema for what Preston knows about the agent CLIs it keeps current. Appended to the numbered
 * migrations in `src/store/migrations.ts`; never edit it once released.
 */
export const AGENT_CLI_MIGRATION = `
  -- One row per agent CLI: the version last seen, how the last update check went, and why Preston
  -- stopped updating it (needs attention, or installed through a package manager).
  CREATE TABLE agent_cli (
    agent TEXT PRIMARY KEY,
    version TEXT,
    checked_at TEXT,
    result TEXT NOT NULL,
    detail TEXT,
    attention TEXT,
    managed_version TEXT,
    managed_reason TEXT
  );

  -- Every version change Preston saw, by its own update or made outside it.
  CREATE TABLE agent_cli_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    from_version TEXT,
    to_version TEXT NOT NULL,
    how TEXT NOT NULL,
    at TEXT NOT NULL
  );
`;
