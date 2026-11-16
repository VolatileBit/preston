# Drive agents only through the user's installed CLIs

Preston runs the user's own, unmodified `claude` and `codex` CLIs under the login the user already has, and never reads, stores, or forwards their credentials. It does not embed the Claude Agent SDK with a subscription login, because Anthropic's terms (checked 2026-11-16) forbid third-party products from offering claude.ai login or routing requests through plan credentials, while an end user signing in to the unmodified Claude Code binary is permitted. OpenAI explicitly allows ChatGPT-plan use in open-source, locally run tools via the Codex App Server.

## Consequences

- Integration uses each CLI's structured mode (Claude `stream-json`, Codex App Server) rather than SDK internals.
- Preston keeps the CLIs up to date and must cope with their behaviour changing across versions.
- Anthropic's "ordinary, individual usage" expectation for plan limits remains a risk for unattended resume; the README states the terms plainly.
