# Chat is the only user interface

Preston's users are often non-technical, so every interaction with Preston is a conversation, never a set of commands. Running `preston` in a terminal opens an agentic setup conversation that walks the user through anything unfinished (choosing agents, creating their own Slack app or Discord bot), resolves unforeseen technical problems, and prepares artifacts such as a Slack app manifest. After setup, the user works through chat Channels: giving Goals, answering questions, checking status, and changing configuration.

Because there is no command fallback, Preston must answer a small set of fixed words (such as status, stop, pause) without calling a model, so the user can always see and stop work even when the Coordinator has no quota.

## Considered Options

- Fixed CLI commands alongside chat (as in the original handoff): rejected because the target user should never need to learn commands.
- A scripted, non-agentic setup wizard: rejected because users' environments vary too much for a fixed script to recover from unforeseen problems.
