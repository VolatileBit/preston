# Workers run with full access

Preston's users want work done, not permission prompts, and unattended agents have nobody to answer them. Workers therefore run with everything the user's own account can do: Claude Code with `--dangerously-skip-permissions`, Codex with the `danger-full-access` sandbox, accepting anything it still asks. Preston adds no sandbox, no approval policy and no escalation of its own. The Brief's checks and the commands a Worker suggests also run directly on the user's machine, as CI would.

The Coordinator is the exception. It reads text nobody vetted (Worker messages, repository files, chat from non-owners), and the only thing it needs is Preston's own tools, so it gets those and nothing else: Claude Code with no built-in tools (`--tools ""`), Codex with a read-only sandbox.

What still limits a Worker, none of it enforced by Preston:

- The Worker prompt tells it to stay in the Project folder and not to publish, deploy, push to shared branches, merge, spend money or delete outside the Project unless the Brief's authority allows it.
- Preston lands the work itself. Landing asks the user first when a merge would publish something (a standing order can lift that).
- Only paired owners can give Preston orders, and tools that widen authority or change settings run only while answering the owner.

## Consequences

- A Worker that misbehaves, or follows instructions planted in a repository, can do anything the user can: delete files, push, publish, spend. The first two protections above are guidance to a model, not a barrier. The user accepts this in exchange for unattended autonomy.
- Preston is as safe as the user's own account and the agents' own judgement. Users who want a barrier can run Preston under a restricted account or in a VM.
- Claude Code refuses `--dangerously-skip-permissions` when run as root, so Preston cannot drive Claude as root.

## Considered Options

- Keep each agent's native safeguards and answer their approval requests with a deterministic policy, escalating to the Coordinator and the user (the first version of this decision): rejected because the escalations are exactly the interruptions users dread, and a policy over shell commands is easy to work around.
- Sandbox Workers and Brief checks (containers, OS sandboxes): rejected for the same reason, and because it fails non-technical users with setup problems.
- Ask the user on every prompt: rejected because it defeats unattended operation.
