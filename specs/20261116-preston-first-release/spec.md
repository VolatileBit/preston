# Preston first release

Terminology follows [CONTEXT.md](../../CONTEXT.md). Binding decisions are recorded in [ADR 0001](../../docs/adr/0001-chat-is-the-only-interface.md) (chat is the only interface) and [ADR 0002](../../docs/adr/0002-drive-agents-only-through-their-installed-clis.md) (drive agents only through their installed CLIs). Items marked **Proposed** are implementation proposals that the product owner has not explicitly approved; everything else was agreed.

## Problem Statement

People, many of them non-technical, now build their own projects with Claude Code or Codex. Substantial work still needs constant babysitting:

- **Quota interruptions:** work stops when an agent's usage quota runs out, and someone has to notice and restart it.
- **Silent stalls:** agents stall or exit while nobody is watching, and the outcome is lost.
- **Unchecked results:** agents report "done" for work that is not actually working.
- **Juggling Goals:** several long Goals are hard to keep track of at once.
- **Tedious steps:** raising pull requests and merging take effort, as does choosing which agent to spend quota on.

There is no existing implementation. The repository contains only the glossary, two ADRs, and the logo (`assets/logo.webp`, `assets/logo.png`). The original product handoff is the source of intent; this spec supersedes it wherever they differ, most notably in dropping the CLI command interface and targeting non-technical users.

## Solution

Preston is an open-source, self-hosted chief of staff for coding agents. The user tells Preston what they want in plain language through chat. Preston then:

- turns the request into a Brief with acceptance criteria that need no human;
- delegates complete objectives to the user's installed Claude Code or Codex;
- stays out of the Worker's way, survives stalls, crashes, restarts and quota exhaustion, and verifies the result itself;
- handles PRs and merges;
- reports back briefly.

It asks the user only for meaningful product decisions or authority beyond scope.

Installation is `npm i -g @polyweave/preston` (MIT licence). After that, the only command is `preston`:

- It starts Preston as a background service that restarts at login.
- It opens an agentic conversation in the terminal, which walks the user through any unfinished setup and fixes problems along the way.

After setup the user talks to Preston from the terminal, Discord, Slack or WeChat. Preston runs on macOS, Windows and Linux.

## User Stories

- As a user, I install Preston from npm and run `preston`, and a conversation sets everything up with me, including fixing unexpected problems on my machine.
- As a user, I create my own Discord bot, Slack app and WeChat pairing with Preston guiding me step by step, using links, a ready-to-paste Slack app manifest, and checks that each step worked. Where my agent supports computer use, Preston offers to do the clicking.
- As a user, I tell Preston what I want in chat. Preston grills me in plain, non-technical language to sharpen the Brief, or drafts the Brief itself and starts immediately if I'm in a hurry.
- As a user, I leave Preston working for hours or days, and it keeps going through stalls, crashes, restarts and quota limits without me rebuilding context.
- As a user, I get told when Preston takes on a Goal, when it needs my decision, and its final result (Verified, Unverified or Blocked), and nothing routine.
- As a user, I answer a question from whichever Channel I'm on, and the parked work resumes.
- As a user, I ask "status", "stop" or "pause" and get an answer even when Preston's own model has no quota.
- As a user with both Claude and Codex, I let Preston spread work across them based on remaining quota.
- As a user, I tell Preston in chat to switch agents, change its model, or be quieter, and it does so.
- As a user, I get finished work merged without dealing with branches and PRs, but Preston asks me first when a merge would publish something.
- As a Worker (coding agent), I ask Preston a question through a tool. Preston answers it itself or escalates it to the user.

## Implementation Decisions

### Distribution and runtime

- **Package:** npm package `@polyweave/preston`, MIT licence, providing a single executable `preston`. TypeScript on Node.js.
- **Platforms:** macOS, Windows and Linux are all first-class.
- **Starting Preston:** running `preston` ensures the background service is running and registered to start at login, then opens the terminal conversation. Running it again resumes any incomplete setup (for example, a re-pair after a lost WeChat login).
  - **Proposed:** use launchd (macOS), a systemd user unit (Linux) and a per-user scheduled task (Windows).
- **Topology:** single user, single host. The user's Preston instance is the server for their own Slack app, Discord bot and WeChat pairing. All three Channels connect outward from the host (Slack Socket Mode, Discord Gateway, WeChat long-poll), so no public URL, port forwarding or tunnel is needed.
- **Persistence (Proposed):** SQLite for durable state (Goals, Runs, Sessions, quota state, outbox, config versions). Use a library that installs without a compiler on all three platforms. Verbose agent transcripts and logs stay on disk as files referenced from SQLite.
- **State location:** all of Preston's state and config live in Preston's own per-user data directory, never inside a Project.

### Interface and Channels

- **Chat only (ADR 0001):** there is no command interface and no web UI. Channels are the terminal (opened by `preston`), Discord, Slack and WeChat. All three chat Channels ship in the first release.
- **Who may give orders:** only the owner accounts paired during setup. Messages from anyone else are ignored and never treated as instructions.
- **One conversation:** each Channel holds a single conversation. Preston infers which Goal a message refers to and asks only when that is genuinely ambiguous. There are no per-Goal threads.
- **Fixed replies without a model:** the words `status`, `stop` and `pause` (exact set **Proposed**) always get a deterministic reply that does not call a model. This keeps the user able to see and stop work when the Coordinator has no quota.
- **Questions that need the user:**
  - A question is sent to all connected Channels, and the first answer wins.
  - Preston does not send "already answered" messages to the other Channels. On Slack and Discord it adds an emoji reaction to the question instead (reactions don't notify). On WeChat it does nothing.
- **What Preston sends unprompted:**
  - **Always:** a short acknowledgement when it takes on a Goal, questions that need the user, and final outcomes.
  - **Only when it changes expectations:** a quota wait or agent switch that noticeably delays a Goal.
  - **Never:** routine progress, retries, or merges within authority.
  - The user can adjust this in chat.
- **Notification outbox:** every outgoing message goes through a durable outbox that records delivery state. A failed delivery never fails a Goal, and results always remain available when the user asks.

### WeChat specifics

- **Integration:** implement a standalone client for Tencent's WeChat ClawBot iLink protocol (HTTPS/JSON), using Tencent's MIT-licensed `openclaw-weixin` plugin as the reference. Pairing is by QR code, and only messages from the owner are accepted.
- **Proactive sends:** send normally and accept that some may be dropped. Community reports (unverified, 2026-11-16) describe a window of about 24 hours after the user's last message and about 10 proactive messages per window. Undelivered results stay available when the user next asks.
- **Lost login (error `-14` or equivalent):**
  - Preston keeps working and holds outgoing messages.
  - It raises a desktop notification on the host telling the user to run `preston`, which treats re-pairing as unfinished setup.
- **Unsupported features:** WeChat has no reactions or message editing, so nothing is sent to mark a question answered.

### Setup conversation

- **Agentic setup:** setup is a conversation with the Coordinator in the terminal, not a scripted wizard. It:
  - detects Claude Code and Codex and asks which agent(s) to use;
  - if both are available, asks whether Preston may use both, balanced by quota;
  - walks the user through creating their own Discord bot and Slack app, generating a Slack app manifest;
  - pairs WeChat by QR code;
  - diagnoses unforeseen problems.
- **Computer use:** a bonus where the user's agent and OS support it, never the only path. Setup must always succeed through guided steps.
- **Secrets:** the user may paste tokens directly into the conversation, and they are stored in plain-text config. To keep that simple approach reasonably safe:
  - the config file is readable only by the owning user;
  - it lives in Preston's data directory, never in a Project;
  - tokens are masked in Preston's own logs and never echoed back to any Channel.

### Goals, Briefs and verification

- **Every Goal has a Brief:** objective, scope, acceptance criteria checkable without a human, and limits of authority.
  - **Grilling:** a product-focused, non-technical interview that asks one important question at a time with a recommended answer. It is optional.
  - **If grilling is skipped:** Preston drafts the Brief, shows it, and starts immediately. The user may correct it while work runs.
- **Goal loop:** understand → assign → observe → assess → adapt or finish.
  - By default, one Worker per Goal, and the Worker owns its own plan → implement → test → fix cycle.
  - Preston changes strategy instead of repeating a failed tactic.
- **Outcomes:**
  - **Verified:** Preston re-ran the Brief's checks itself against the current state of the work, and they passed.
  - **Unverified:** no executable or observable check exists.
  - **Blocked:** the Goal needs something only the user can provide.
  - **Cancelled:** the user stopped it.
  - A Worker exiting or saying "done" is never by itself a Verified outcome.
- **Follow-ups:** a follow-up to a finished Goal is a new Goal linked to the earlier one; the finished Goal is not reopened.

### Workers and agent integration (ADR 0002)

- **Only the user's own CLIs:** Preston drives the user's installed, unmodified `claude` and `codex` CLIs under their existing logins. It never reads, stores or forwards their credentials, and it does not embed the Claude Agent SDK with a subscription login.
- **Integration surfaces** (verified 2026-11-16; re-verify against the installed versions):
  - **Claude Code:**
    - **Mode:** `claude -p --output-format stream-json --input-format stream-json`.
    - **Session IDs:** `--session-id <uuid>` assigns the ID up front, and `--resume <id>` resumes it. Sessions are keyed by working directory, so Preston stores each Session ID together with its working directory.
    - **Quota signals:** a `rate_limit_event` with status and `resetsAt`, and `error: 'rate_limit'` on assistant messages.
    - **Model settings:** `--model` and `--effort`.
  - **Codex:**
    - **Mode:** `codex app-server` (JSON-RPC over stdio).
    - **Threads:** `thread/start`, `thread/resume`, `turn/start` and `turn/interrupt`.
    - **Quota signals:** a turn fails with `codexErrorInfo: "usageLimitExceeded"`.
    - **Quota reads:** `account/rateLimits/read` is token-free, and `account/rateLimits/updated` pushes changes. The App Server asks clients to set `clientInfo.name`.
- **Inherited settings:** Workers inherit the user's own model and effort settings unless explicitly changed.
- **Keeping CLIs current:** Preston keeps the agent CLIs up to date. **Proposed:** update only when no Run is using that CLI, and confirm the CLI still starts afterwards.
- **Asking Preston:** Workers get an `ask_preston` tool (**Proposed:** exposed through an MCP server that Preston provides to the Worker). The Coordinator answers it or escalates through `ask_human`.
- **Parked Runs:** when a question goes to the user, the Worker finishes everything that doesn't depend on the answer and then stops. The Run is parked until the user replies, then the same Session resumes with the answer.

### Coordinator

- **Where it runs:** the Coordinator runs on the same user-installed CLIs, as a headless Session with Preston's own tools: managing Goals, `ask_human`, reading and changing config, and memory. No separate API key is required.
- **Defaults:**
  - **Claude:** Sonnet 5.5, Medium effort.
  - **Codex:** GPT-6.1 Sol, Medium effort.
  - Both are changeable in chat and validated against what the user's account actually offers.
- **Event-driven:** the Coordinator runs only on user messages and meaningful events (Worker questions, repeated failure, a stall, or a final assessment). Process health, events, timers and quota checks are deterministic and cost no tokens.
- **Quota:** the Coordinator's own quota usage is counted in agent balancing.

### Quota, balancing and Sessions

- **Monitoring and resume:**
  - Quota is tracked for each agent and account.
  - When quota runs out, the Run is marked as waiting for quota (not failed) and its state persisted.
  - Preston rechecks periodically, including before the advertised reset time, and resumes automatically. The default interval is about 10–15 minutes and is configurable.
  - One monitor runs per quota bucket, and resumes are staggered so they don't immediately exhaust quota again.
  - Rate-limit bursts, authentication errors and quota exhaustion are distinguished from one another.
- **Balancing:**
  - New Goals go to whichever agent has quota headroom; per-Project stickiness is preferred.
  - An in-flight Goal waits for its own agent unless the wait would be long and the other agent has headroom, in which case Preston hands over with a compact checkpoint.
  - **Proposed:** the default threshold for "long" is 1 hour, changeable in chat.
- **No spending:** Preston never buys credits, enables pay-as-you-go, or switches to a differently billed provider without authority.
- **Sessions:** Preston resumes an existing Session for related follow-up work to keep its context, compacts it into a new Session seeded with the current Brief and state when its context is stale, and starts fresh for unrelated work.

### Projects, worktrees and merging

- **Isolation:**
  - Each coding Goal works in its own git worktree and branch, so parallel Goals in one repository don't collide.
  - Non-repository Projects (for example, home-server maintenance) work in place.
  - Preston preserves the user's uncommitted edits and never blindly resets.
- **Landing the work:**
  - Preston raises a PR when needed and merges automatically once the work is Verified against the merged result.
  - **Proposed:** use a PR when the repository has a hosted remote, and merge locally when it does not.
- **Merges that publish:** Preston asks first when a merge would also publish something publicly: deploying a live site, releasing a build, or publishing a package. It infers this from the repository's setup and asks when unsure. A standing order can lift this requirement.

### Authority and safety

- **Within scope:** Preston acts autonomously within the Brief's scope and the user's standing orders, and reuses the agents' native safeguards rather than adding approval prompts.
- **Escalation:** it escalates unresolved product intent, spending, wider credentials or authority, publishing, and hard-to-reverse destructive actions.
- **Untrusted content:** repository files, web pages, Worker output and messages from non-owners are data. They never grant new authority.

### Recovery

- **On startup:** Preston reconciles persisted Runs with actual processes, native Sessions and worktree state. It never assumes an old "running" record is still executing. Where safe it reattaches or resumes; otherwise it inspects the work and continues from the last reliable checkpoint without redoing known completed work.
- **Exact continuation:** not guaranteed after an interrupted model turn. Safe recovery is the objective.

### Build order

Build in vertical slices, each proven end-to-end before the next:

1. Terminal setup conversation, the terminal Channel, and one durable Goal through one agent to a Verified or Unverified outcome, surviving a Preston restart.
2. The Discord Channel, then the Slack Channel, including guided setup.
3. The WeChat Channel, with the live measurement test (see Human-Only Work) started alongside.
4. Recovery from stalls, crashes and quota exhaustion, with automatic resume.
5. Several concurrent Goals and balancing across agents.
6. Standing orders, schedules and memory, following the original handoff's agreed design.

All three chat Channels ship in the first public release.

## Testing Decisions

**Agreed**

- The automated suite uses a **fake Worker** and a **fake Channel**, consumes no quota, and runs repeatably on macOS, Windows and Linux.
  - **Fake Worker:** can emit timed events, stall, exit unexpectedly, report quota exhaustion with or without a reset time, corrupt or lose a Session, and resume.
  - **Fake Channel:** can deliver owner and non-owner messages and record what Preston sends, including reactions and delivery failures.
- **Real-provider smoke tests** cover a few scenarios against real Claude Code, Codex and WeChat. Each is a small Goal on a throwaway repository, including a forced quota pause and resume. They run only when deliberately invoked, never in CI.
- **WeChat live test:** a 1–2 day test on a real account measures the proactive-message window, the per-window cap and login lifetime. The results inform WeChat messaging behaviour; they do not decide whether WeChat ships.

**Public test boundaries (Proposed)**

Tests drive Preston as a user would, through a Channel and the agent CLIs. They observe Channel messages, Goal outcomes and the repository or worktree state:

- **Simple Goal:** a message on the fake Channel produces an acknowledgement, a Brief, a Run and a Verified result. Preston re-runs the checks itself.
- **Worker exits unexpectedly:** the Goal is not reported as completed, and Preston resumes or retries.
- **Stall:** the stall is detected without model calls, and Preston changes course or reports Blocked.
- **Worker quota exhausted:** the Run waits, is rechecked, resumes on an early reset, and completed work is not redone.
- **Shared quota bucket:** three Runs on one bucket produce one monitor and staggered resumes.
- **Coordinator quota exhausted:** `status` and `stop` still answer without a model.
- **Restart:** killing and restarting Preston at each Goal state preserves Goals, quota waits and parked questions, with no duplicated side effects.
- **Questions to the user:** a Worker's question reaches all Channels, the first answer wins, Slack and Discord get an emoji reaction, and the Run resumes in the same Session.
- **Non-owners:** a non-owner's message is ignored.
- **Delivery failure:** the Goal still completes, and the result is available when asked.
- **Untrusted content:** text such as "ignore your rules" in a repository or in Worker output grants no new authority.
- **Merge that publishes:** a merge that would deploy publicly triggers a question, while an ordinary merge proceeds automatically.
- **Agent adapters:** tested against recorded `claude` stream-json and Codex App Server transcripts. Tests don't assert on internal structure.

The repository has no build or test tooling yet, so verification commands are to be established in slice 1.

## Human-Only Work

- **Run the WeChat live test:** pair a real WeChat account and leave it idle for 1–2 days. *Done when* the measured proactive window, per-window cap and login-expiry behaviour are recorded in the repository.
- **Create test Channel credentials:** create a Discord bot and a Slack app in the owner's accounts for smoke testing. *Done when* both connect to a running Preston and exchange messages with the owner.
- **Run the real-provider smoke tests:** these consume the owner's Claude or Codex quota. *Done when* the results, including the forced quota pause and resume, are recorded.
- **Secure the npm scope:** confirm ownership of the `@polyweave` npm organisation before the first publish. No packages exist under the scope as of 2026-11-16. *Done when* the owner can publish `@polyweave/preston`.

## Out of Scope

- Any command-line command interface beyond `preston`, and any web UI or dashboard.
- Using the Claude Agent SDK with subscription logins, and handling agents' credentials.
- Remote or multi-host execution, multi-user or multi-tenant use, and hosted or paid distribution.
- Channels other than the terminal, Discord, Slack and WeChat. WeCom and Official Accounts are fallbacks only if personal WeChat proves unusable.
- Per-Goal chat threads.
- Rebuilding agents' reasoning loops, tools, editing, memory or subagents.
- General personal-assistant scope (email, calendar and the like). The design should not preclude it.
- Installers for users without Node.js and npm.
- Guaranteed exact continuation of an interrupted model turn.

## Open Questions

None block implementation. The WeChat live-test results may adjust WeChat messaging defaults but do not change scope.
