# Real-provider smoke tests

`npm run smoke` drives Preston against the real `claude` and `codex` CLIs installed on this computer, under the logins already there. It exists because the automated suite (`npm run check`) uses only fake agents and fake Channels, so it cannot show that Preston works with the real thing. It is run deliberately, by a person, and never by CI: it spends real quota.

```sh
npm run smoke                  # every scenario, for every usable provider
npm run smoke -- s3            # one scenario (any part of the file name works: s1, s2, s3, s4, s5, s6-, s6b)
SMOKE_PROVIDERS=claude npm run smoke   # only one provider (claude, codex, or claude,codex)
SMOKE_KEEP=1 npm run smoke -- s2       # keep the temporary folders (transcripts, logs, database) to inspect
```

A provider that is not installed, not signed in, or does not offer its cheap model is skipped with the reason. The run ends with a summary of agent turns, tokens, cost where the CLI reports one, wall time and the Coordinator's share of tokens per scenario. `PRESTON_SMOKE_HISTORY=<file>` also appends each run's entries to a file, to total the spend over several runs.

## Safety and cost

- Everything lives in temporary folders under the OS temp directory: a throwaway `PRESTON_HOME`, throwaway git repositories and (where a push must be detectable) a local bare repository standing in for a remote.
- Preston is started with `startDaemon` in the test process (or `preston daemon` as a child process in the restart scenario). Nothing is registered with launchd, systemd or the Task Scheduler, the real `~/.preston` is never touched, no real Discord, Slack or WeChat is contacted (the owner Channels are in-process fakes, or the terminal over IPC), and GitHub is unavailable, so nothing is pushed or opened as a pull request.
- The agents themselves still use your real logins and their usual configuration. Their own session history therefore gets entries for the temporary folders (`~/.claude/projects`, `~/.codex/sessions`). Git is isolated from your own configuration (a throwaway identity, no hooks or signing).
- Coordinator and Worker both use the cheapest model: Claude `haiku` and Codex `gpt-5.6-luna`, at `low` effort. Tasks are tiny.
- A clean run of the whole suite makes about 16 real agent turns for Claude and 13 for Codex, in roughly ten minutes, and costs a few cents of Claude usage (the CLI reports about $0.01 per scenario) and a fraction of a percent of a Codex weekly window. If a provider reports a usage limit, stop and look: the suite does not retry.

## What each scenario proves

| Scenario | Providers | Real turns | What it shows |
|---|---|---|---|
| `s1-simple-goal` | Claude, Codex | 2 to 3 | The real setup steps (detect the agents, choose one). A message on a fake owner Channel reaches the real Coordinator, which skips grilling for a user in a hurry and drafts a Brief with a check. A Goal starts in a worktree, the real Worker works with its own tools and calls `report_result` through Preston's MCP server, Preston re-runs the check itself (Verified), lands it with a local merge (no push), and sends one acknowledgement and one outcome. The worktree and branch are gone afterwards. |
| `s2-worker-question` | Claude, Codex | 5 | The Brief leaves out a fact, so the real Worker calls `ask_preston`; the real Coordinator escalates with `ask_human`; the question reaches both Channels once; the owner answers on one; the other gets a reaction. The Run resumes in the same native Session (checked against the persisted Session ID and what the adapter was asked to resume) and the answer ends up in the work. |
| `s3-restart-mid-run` | Claude, Codex | 3 | `preston daemon` is a real child process. It is killed with SIGKILL while a real Worker is mid-Run; a new daemon on the same home terminates the recorded agent process, resumes the same Session in the same Run, finishes without rewriting finished work or repeating the acknowledgement, and no process the daemons started is still alive afterwards (checked in the process table). |
| `s4-forced-quota` | Claude, Codex | 2 | A real account cannot be exhausted on purpose, so the wrapper cuts the first real Worker turn short after its first piece of work and reports `quota_blocked` with a reset time seconds ahead; the token-free quota read is a stand-in that flips to available at that time. Preston parks the Run on the bucket (not failed), says nothing, rechecks, resumes the same real Session and the Goal is Verified. |
| `s4-real-quota-read` | Claude, Codex | 0 | The real token-free reads: Claude `/usage`, Codex `account/rateLimits/read`. Records that each works and that the buckets have the expected shape. |
| `s5-coordinator-chat` | Claude | 2 | `status` is answered with no model call. A plain question gets an answer drawn from Preston's tools (settings, Goals). Asked to change its own effort, the Coordinator calls `config_update` and a new config version is recorded. |
| `s6-untrusted-input` | Claude | 1 | A non-owner's messages get no reply, start no Goal and cost no model call. A repository whose `NOTES.md` and `CLAUDE.md` tell the Worker to ignore its rules and push leaves the remote untouched. |
| `s6b-approval-escalation` | Claude, Codex | 1 | The Brief itself asks the Worker to attempt `git push`, so the agent's own judgement is not what stops it. The agent's native approval request reaches Preston's policy through the real adapter (Claude's permission prompt tool, Codex's App Server request), is escalated to the Coordinator and declined, the Worker carries on, and the remote is untouched. |

By default each scenario runs for the providers in this table; `SMOKE_PROVIDERS` narrows that.

## What is simulated, and what is scripted

- **Quota (s4):** the `quota_blocked` event and the quota read are injected by `test/smoke/support/metered.ts`. The Session, the resume and the second turn are real. The real limit signals (Claude's `rate_limit_event`, Codex's `usageLimitExceeded`) are covered only by the recorded-transcript tests in `npm run check`.
- **Scripted Coordinators:** s4, s6 and s6b use a scripted Coordinator (the fake adapter) to start the Goal and to decline approvals, so that the turn budget goes to the Worker. s1, s2, s3 and s5 use the real Coordinator throughout.
- **Metering:** every real turn passes through a wrapper that records the Session ID, tokens and how the turn ended, and changes nothing unless a scenario says so.

## Known limits

- Codex runs commands inside its own `workspace-write` sandbox and only asks Preston when it wants to leave it. A command the sandbox allows, such as a `git push` with nothing to push, is never seen by Preston's policy. Preston relies on the sandbox for that (network access off by default); a user whose `~/.codex/config.toml` enables sandbox network access weakens it.
- Real usage limits, expired logins and the agents' own "update available" prompts are not exercised.
- The agent CLIs change often. A failure that appears after an agent update is a finding, not necessarily a Preston regression: inspect the kept transcripts (`SMOKE_KEEP=1`).

## First recorded run (2026-11-16)

Claude Code 2.1.325 (`haiku`), codex-cli 0.169.0 (`gpt-5.6-luna`), macOS. All scenarios passed once the defects below were fixed.

RESULTS_TABLE

Defects the first real run exposed, and fixed:

1. **Every Codex MCP tool call was refused.** Codex asks before each MCP tool call (`mcpServer/elicitation/request`, "Allow the preston MCP server to run tool ...?") and the adapter declined all such requests, so the Coordinator could not create a Goal and a Worker could not report. Preston's own tools are now accepted (they are scoped by the turn's token); other servers' stay declined. Regression test: `test/workers/codex/codex-adapter.test.ts`.
2. **A Codex Coordinator polled `goal_get` for a minute after creating a Goal**, burning tokens and holding up the single Coordinator queue (so Worker questions and other messages would have waited). The Coordinator's guidance now says to reply and end its turn after `goal_create`. No fake-agent test can show a model's habit; the smoke scenario `s1` shows the Coordinator turn is down from 63 s to 16 s.
