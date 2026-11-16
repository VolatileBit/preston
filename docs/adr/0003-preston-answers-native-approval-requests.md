# Preston answers the agents' native approval requests

Workers run unattended, so nobody is at the keyboard when an agent asks for permission. Preston does not use the agents' "skip all permissions" modes. Instead it keeps each agent's native safeguards and answers their approval requests itself:

- Claude Code: `--permission-prompt-tool` pointing at Preston's MCP server, with the user's own allow and deny rules still applied first.
- Codex: App Server approval requests, with `workspace-write` sandboxing.

Preston applies a deterministic policy:

- Routine actions inside the Goal's worktree or Project are allowed.
- Actions that are destructive, publish something, spend money, or go outside the Project are escalated to the Coordinator, which allows them within the Brief's authority or asks the user.

This gives unattended autonomy without discarding the protections users already rely on.

## Considered Options

- Bypass permissions entirely: rejected because it removes protections users configured and makes one bad Worker decision unrecoverable.
- Ask the user on every prompt: rejected because it defeats unattended operation.
