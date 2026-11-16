# Architecture

How Preston is put together. Product intent lives in the [spec](../specs/20261116-preston-first-release/spec.md), terms in [CONTEXT.md](../CONTEXT.md), and binding decisions in [docs/adr](adr/). Keep this file current when a boundary or contract changes.

## Processes

`preston` is the only user-facing command. One executable (`dist/cli.js`) serves three roles:

| Invocation | Role |
|---|---|
| `preston` | Ensures the daemon is running (registering it to start at login on first run), then opens the terminal Channel: a conversation with the Coordinator. |
| `preston daemon` (internal) | The long-lived runtime. Owns all state, timers, Channels, and agent processes. |
| `preston mcp --token <t>` (internal) | A stdio MCP server that an agent CLI launches. It proxies Preston's tools to the daemon over IPC. The token identifies the caller's role (Coordinator or Worker) and its Run. |

The daemon and its clients talk over a local IPC endpoint: a Unix domain socket at `<home>/preston.sock`, or a named pipe on Windows. Messages are newline-delimited JSON-RPC 2.0. Every connection must authenticate with the secret in `<home>/ipc-token`, which is readable only by the owner.

## Data

`<home>` is `$PRESTON_HOME` if set, otherwise `~/.preston` on every OS. It holds:

- `config.json`: typed, validated config, plain text, mode 0600 (see the Secrets section of the spec). Every change is also recorded as a version in the database so it can be rolled back.
- `preston.db`: SQLite via `node:sqlite`, with no native dependency. It holds Goals, Briefs, Runs, Sessions, events, questions, quota state, the outbox, and config versions. Migrations are forward-only and numbered.
- `logs/` and `transcripts/`: verbose agent output, referenced from the database by path.
- `worktrees/`: one git worktree per coding Goal.

Nothing Preston owns is ever written inside a Project.

## Runtime components (inside the daemon)

```text
 Channels ──inbound──▶ Router ──fixed words──▶ deterministic replies
   ▲                     │
   │                     └─▶ Coordinator (agent Session + coordinator MCP tools)
 Outbox ◀── notifications ◀──┐            │ goal_create / ask_human / config_* …
                             │            ▼
                         Goal engine ──▶ Worker adapters ──▶ claude / codex / fake
                             │  ▲             │ WorkerEvents
                             ▼  └─────────────┘
          Supervisor (timers, stalls, quota monitors, recovery)   Store (SQLite)
```

- **Channels** connect to the outside world and normalise messages. The owner check happens in the Channel, based on its pairing.
- **Router** handles fixed words (`status`, `stop`, `pause`, `resume`) without calling a model, and serialises everything else into Coordinator invocations.
- **Coordinator** is an agent Session (Claude or Codex, through the same adapters as Workers) whose tools are Preston's coordinator MCP tools. Each invocation resumes the persistent Coordinator Session with a new input, such as a user message or a meaningful event. The text of its final reply is sent back to the originating Channel.
- **Goal engine** is the durable state machine for Goals and Runs. It starts Runs, consumes WorkerEvents, handles `ask_preston` and `report_result`, runs verification, and emits notifications.
- **Supervisor** holds the deterministic timers: stall detection, quota rechecks, recovery on startup, and schedules. It never calls a model directly; it raises events to the Coordinator only when judgement is needed.
- **Outbox** delivers every outgoing message durably, retries, and records delivery state. A delivery failure never fails a Goal.

All time-dependent logic takes an injectable clock, so tests can control time.

## Contracts

These are the seams. Tests drive Preston through them, with fake Channels and fake Workers.

- **Channel**: `start(ctx)`, `stop()`, `send(message) → delivery result`, optional `markAnswered(messageRef)`, and `capabilities` (reactions, proactive delivery). It reports inbound messages through `ctx.onMessage`.
- **WorkerAdapter**:
  - `detect()` reports whether the CLI is installed, its version and its login state.
  - `startRun(...)` starts a Run, or resumes one when given a native Session ID. Inputs: workdir, prompt, optional model/effort, and the MCP launch spec. It returns a handle with an async stream of `WorkerEvent`s, the native Session ID, and `interrupt()`.
  - Optional `readQuota()`.
  - Native approval requests are answered by Preston's approval policy ([ADR 0003](adr/0003-preston-answers-native-approval-requests.md)).
- **WorkerEvent** kinds: `started`, `activity` (including whether a tool or command is still running), `message`, `quota_blocked` (bucket, kind, reset time if known), `auth_error`, `completed` (final text and usage), `failed`, `exited`.
- **MCP tools**:
  - Coordinator role: Goals, briefs, answering Workers, `ask_human`, config get/update/history/rollback, status, Channel setup, memory, standing orders and schedules.
  - Worker role: `ask_preston` and `report_result` (summary, checks performed, suggested verification commands, blockers).

## Goal lifecycle

States: `queued → running → verifying → completed`. Side states are `waiting_for_quota`, `waiting_for_user`, `recovering`, `blocked`, `failed` and `cancelled`. A completed Goal carries an outcome of `verified` or `unverified`.

- The worker exiting is never success.
- "Verified" means Preston re-ran the Brief's check commands itself against the current state of the work.
- On startup, every non-terminal Goal is reconciled against reality before anything resumes.

## Testing

- `npm run check` runs typecheck, lint and tests. CI runs it on macOS, Windows and Linux.
- Behaviour tests start a real Preston runtime against a temporary `PRESTON_HOME`, using the fake Channel and the fake Worker adapter. They assert on Channel messages, Goal outcomes and files on disk.
- Agent adapters are tested against recorded CLI transcripts.
- Real-provider smoke tests live under `test/smoke/` and run only through `npm run smoke`, never in CI.
