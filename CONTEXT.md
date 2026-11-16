# Preston

Preston is an open-source, self-hosted chief of staff for people, often non-technical, who build their own projects with coding agents: it takes ownership of a user's substantial outcome, delegates it to the coding agents already on their machine, handles the tedious parts around the work, and returns a verified result or a genuine blocker. The user talks to Preston only through chat.

## Language

### Work

**Project**:
A body of work Preston keeps context for, usually one repository or folder; non-code work such as maintaining a home server is also a Project.
_Avoid_: Workspace, repo (when meaning the broader concept)

**Goal**:
A finite outcome the user asked Preston to achieve within a Project. It ends completed, blocked, or cancelled. A follow-up to a finished Goal is a new Goal linked to it, not a reopening.
_Avoid_: Task, job, ticket

**Brief**:
The agreed statement of a Goal: objective, scope, acceptance criteria checkable without a human, and limits of authority. Produced by grilling, or drafted by Preston when the user skips grilling.
_Avoid_: Spec, prompt, plan

**Run**:
One attempt by one Worker at all or part of a Goal. A Goal may have several Runs, for example after a stall or a change of Worker.
_Avoid_: Session, execution, task

**Worker**:
An existing coding agent (Codex or Claude Code) that carries out a Run, owning its own planning, implementation and self-testing.
_Avoid_: Subagent, executor

**Session**:
A Worker's own native conversation and its accumulated context. Preston chooses to resume, compact, or start a Session; it is never the unit of work.
_Avoid_: Thread, conversation (for the agent side)

**Coordinator**:
Preston's own reasoning step, invoked only when a decision adds value, never to relay routine messages to a Worker.
_Avoid_: Supervisor, orchestrator loop, manager

### Communication

**Channel**:
A conversation surface through which the user talks to Preston and Preston reaches the user: the terminal (opened by running `preston`), WeChat, Discord or Slack. The only user interface.
_Avoid_: Transport, integration, interface

### Outcomes

**Verified**:
A Goal outcome where Preston has itself re-run the checks against the current state of the work and they pass.
_Avoid_: Done, passed

**Unverified**:
A Goal outcome where the Worker reports success but no executable or observable check exists for Preston to confirm it. Distinct from failure.
_Avoid_: Probably done, soft-complete

**Blocked**:
A Goal outcome where Preston cannot proceed without something only the user can provide, such as a product decision or new authority.
_Avoid_: Stuck, failed
