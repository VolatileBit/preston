# Architecture

How Preston is put together. Product intent lives in the [spec](../specs/20261116-preston-first-release/spec.md), terms in [CONTEXT.md](../CONTEXT.md), and binding decisions in [docs/adr](adr/). Keep this file current when a boundary or contract changes.

## Processes

`preston` is the only user-facing command. One executable (`dist/cli.js`) serves three roles:

| Invocation | Role |
|---|---|
| `preston` | Ensures the daemon is running (starting it detached if needed; registering it to start at login is a later slice, behind `src/daemon/start-at-login.ts`), runs the deterministic agent-choice step if no agent is configured, then opens the terminal Channel: a conversation with the Coordinator. Ctrl+C leaves the conversation; the daemon keeps running. |
| `preston daemon` (internal) | The long-lived runtime. Owns all state, timers, Channels, and agent processes. |
| `preston mcp --token <t>` (internal) | A stdio MCP server that an agent CLI launches. It proxies Preston's tools to the daemon over IPC. The token identifies the caller's role (Coordinator or Worker) and its Run. |

The daemon and its clients talk over a local IPC endpoint: a Unix domain socket at `<home>/preston.sock` (in the temp directory if that path would be too long), or a named pipe on Windows. Messages are newline-delimited JSON-RPC 2.0. Every connection must first call `auth` with the secret in `<home>/ipc-token`, which is readable only by the owner. A lock file (`<home>/daemon.lock`) keeps one daemon per home; a lock whose process is gone or no longer answers is taken over.

IPC methods: `health`, `shutdown`, `terminal.attach` / `terminal.send` (replies arrive as `terminal.message` notifications), `setup.state` / `setup.chooseAgents` / `setup.continue`, and `mcp.describe` / `mcp.call` for the MCP proxy.

## Data

`<home>` is `$PRESTON_HOME` if set, otherwise `~/.preston` on every OS. It holds:

- `config.json`: typed, validated config, plain text, mode 0600 (see the Secrets section of the spec). Every change is also recorded as a version in the database so it can be rolled back.
- `channels/<kind>.json`: state a chat Channel updates by itself (WeChat's long-poll cursor and context tokens), mode 0600. It is kept out of `config.json` so frequent updates do not become config versions and a rollback never rewinds it.
- `preston.db`: SQLite via `node:sqlite`, with no native dependency. It holds Goals, Briefs, Runs, Sessions, events, questions, escalated approvals, quota state, the outbox, and config versions. Migrations are forward-only and numbered.
- `logs/` and `transcripts/`: `logs/preston.log` is structured JSON lines with secrets masked; `transcripts/<runId>/` holds agent transcripts and check output, referenced from the database by path.
- `coordinator/`: the working directory of the Coordinator's agent Session.
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

- **Channels** connect to the outside world and normalise messages. The owner check happens in the Channel, based on its pairing. The terminal is always registered; Discord, Slack and WeChat are built from `config.channels` (`src/channels/chat.ts`) and rebuilt when their section changes (config_update, rollback, channel_configure). Changes a Channel makes itself (a pairing result, a cursor) are saved without rebuilding it. `ctx.notifyHost` goes to a `HostNotifier` (`RuntimeOptions.notifyHost`); without one it is only logged.
- **Router** handles fixed words (`status`, `stop`, `pause`, `resume`) without calling a model, and serialises everything else into Coordinator invocations. While a Channel's pairing waits for an answer in a conversation (WeChat's phone number), the owner's next message there goes to the pairing instead.
- **Coordinator** is an agent Session (Claude or Codex, through the same adapters as Workers) whose tools are Preston's coordinator MCP tools. Each invocation resumes the persistent Coordinator Session with a new input, such as a user message or a meaningful event. The text of its final reply is sent back to the originating Channel. Its model and effort default to Sonnet 5.5 (`claude-sonnet-5-5`; the `sonnet` alias on Bedrock, Vertex or Foundry) or GPT-6.1 Sol (`gpt-6.1-sol`), Medium; a model the account does not offer (Codex `model/list`) falls back to the user's own default with a note shown in `agents_status`.
- **Goal engine** is the durable state machine for Goals and Runs. It starts Runs, consumes WorkerEvents, handles `ask_preston` and `report_result`, runs verification, and emits notifications.
- **Supervisor** holds the deterministic timers: stall detection, quota rechecks, recovery on startup, and schedules. It never calls a model directly; it raises events to the Coordinator only when judgement is needed.
- **Outbox** delivers every outgoing message durably, retries, and records delivery state. A delivery failure never fails a Goal. Items are attempted only while their Channel is connected, in order per Channel, with exponential backoff; dedupe keys make acknowledgements, questions and outcomes go out once, even across restarts. Routing: replies and the Goal acknowledgement go to the originating conversation; questions and final outcomes go to every registered Channel. When a question is answered, undelivered copies are withdrawn and delivered copies on Channels with reactions are marked answered; nothing else is sent.

All time-dependent logic takes an injectable clock, so tests can control time.

## Contracts

These are the seams. Tests drive Preston through them, with fake Channels and fake Workers.

- **Channel**: `start(ctx)`, `stop()`, `send(message) → delivery result`, optional `markAnswered(messageRef)`, and `capabilities` (reactions, proactive delivery). It reports inbound messages through `ctx.onMessage`.
- **WorkerAdapter**:
  - `detect()` reports whether the CLI is installed, its version and its login state.
  - `startRun(...)` starts a Run, or resumes one when given a native Session ID. Inputs: workdir, prompt, optional model/effort, and the MCP launch spec. It returns a handle with an async stream of `WorkerEvent`s, the native Session ID, and `interrupt()`.
  - Optional `readQuota()`.
  - Native approval requests are answered by Preston's approval policy ([ADR 0003](adr/0003-preston-answers-native-approval-requests.md)).
  - Every process the built-in adapters start gets the daemon's environment without a parent agent session's variables (`src/workers/env.ts`: `CLAUDECODE`, Claude Code session, host and SDK plumbing, Codex thread, sandbox and shell-snapshot variables). The user's own configuration and credentials are kept.
- **WorkerEvent** kinds: `started`, `activity` (including whether a tool or command is still running), `message`, `quota_blocked` (bucket, kind, reset time if known), `auth_error`, `completed` (final text and usage), `failed`, `exited`.
- **Adapter and Channel registration**: `src/workers/registry.ts` (`builtinAdapters()` / `BUILTIN_ADAPTERS`: the Claude Code and Codex adapters, factories receiving `AdapterContext`) and `src/channels/registry.ts` (`CHAT_CHANNELS`: per kind, a settings schema, the credentials the user pastes, the keys kept as Channel state, the setup guide, and a factory receiving the settings and a `persist` callback). The terminal Channel is always registered. When the test-only `PRESTON_TEST_FAKE_AGENT` names a scenario module, the daemon uses only the fake adapter.
- **PairingIO**: `show(text)`, optional `prompt(question, { secret })`, `signal`. Pairing runs in the background (`src/setup/pairing.ts`): `show` and `prompt` talk to the conversation that asked for it, the outcome's `configPatch` is saved, and the Coordinator gets a setup event.
- **MCP tools**: owned by the daemon. `preston mcp` asks the daemon which tools its token may see and forwards calls; it holds no logic. Tokens are minted per agent turn, kept in memory, and revoked when the turn ends, so a daemon restart invalidates all of them. Coordinator invocations use `StartRunInput.runId = "coordinator"`. Claude's permission prompt tool is `mcp__preston__approve`.
  - Coordinator role: Goals, briefs, answering Workers, `ask_human`, `approval_decide`, config get/update/history/rollback, status, setup (`agents_status`, `channel_status`, `channel_setup_guide`, `channel_configure`, `channel_pair`, `channel_remove`), and later memory, standing orders and schedules. `config_update` checks a change before saving it: newly enabled agents must be installed, models and efforts must be offered (Codex lists them; Claude names and efforts are checked by shape; a Worker model must work for every enabled agent), and Channel settings must be valid. A refused change leaves the config as it was. Tokens given to `channel_configure` are masked in results and logs.
  - Worker role: `ask_preston` and `report_result` (summary, checks performed, suggested verification commands, blockers).

## Goal lifecycle

States: `queued → running → verifying → completed`. Side states are `waiting_for_quota`, `waiting_for_user`, `recovering`, `paused`, `blocked`, `failed` and `cancelled`; `completed`, `blocked`, `failed` and `cancelled` are terminal. A completed Goal carries an outcome of `verified` or `unverified`. A Run is `active` (a turn is executing), `parked` (between turns, waiting for an answer, quota or resume) or `ended`; one Run can span several turns of the same native Session.

- The worker exiting is never success. A turn that ends without `completed` is recovered (resume the Session with a recovery note, or restart from the Brief without one), up to `recovery.maxAttempts`, then the Goal fails.
- After `report_result` and a completed turn, Preston runs the Brief's checks plus Worker-suggested commands that the approval policy classes as routine. "Verified" needs at least one Brief check and every check passing; suggested commands alone give "Unverified". Failing checks resume the Worker with the evidence up to `verification.maxFixAttempts` times. Reported blockers end the Goal as Blocked.
- `ask_preston` waits up to `questions.workerWaitMs` for the Coordinator, otherwise (or once escalated to the user) it tells the Worker to finish independent work and end its turn. The answer resumes the same Session.
- On startup, every non-terminal Goal is reconciled against reality before anything resumes: running Runs are recovered, verification is re-run, pending Coordinator questions are raised again, quota waits are rescheduled.
- An approval the policy escalates becomes an `approvals` row linked to a Worker question, and a Coordinator event. The Coordinator decides it with `approval_decide` within the Brief's authority, or asks the user with `ask_human`; once the question is with the user, only an owner message can decide it. The Worker's native request (Claude's permission tool call, Codex's approval request) waits up to `approvals.escalationWaitMs` (2 minutes). A decision in time is the native answer. Otherwise the request is declined with a note that it was escalated; the Worker carries on and ends its turn, the Run parks as `waiting_for_user`, and the later decision resumes the same Session through the parked-question path. Undecided approvals are raised again after a restart.

## Testing

- `npm run check` runs typecheck, lint and tests. CI runs it on macOS, Windows and Linux.
- Behaviour tests start a real Preston runtime (`createRuntime` from `src/runtime.ts`, or `startDaemon` for IPC) against a temporary `PRESTON_HOME`, using the fake Channel (`src/channels/fake`) and the fake Worker adapter (`src/workers/fake`), with an injectable clock. They assert on Channel messages, Goal outcomes and files on disk. `test/support/harness.ts` wraps this.
- Process-level tests run the real executable, which the test global setup builds into `.preston-test-dist/`.
- Agent adapters are tested against recorded CLI transcripts.
- Real-provider smoke tests live under `test/smoke/` and run only through `npm run smoke`, never in CI.
