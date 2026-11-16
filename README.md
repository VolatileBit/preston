<p align="center"><img src="assets/logo.png" alt="Preston" width="160"></p>

# Preston

A self-hosted chief of staff for your coding agents. Give it a goal. Get a result.

Preston takes ownership of an outcome you describe in plain language, hands the work to the coding agent already on your computer (Claude Code or Codex), keeps it going through stalls, crashes and restarts, checks the result itself, and tells you briefly how it went: **Verified**, **Unverified** or **Blocked**. It asks you only for real product decisions or for authority beyond what you gave it.

You talk to Preston only through chat. There are no commands to learn.

## Requirements

- Node.js 22.13 or later, on macOS, Windows or Linux.
- [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex), installed and signed in.

## Install

```sh
npm i -g @polyweave/preston
```

## Run

```sh
preston
```

The first time, Preston starts its background service, sets it to start by itself whenever you sign in to your computer, finds the coding agents installed, asks which to use, and walks you through the rest of setup in conversation. After that, `preston` opens a conversation with Preston. Tell it what you want done. Press Ctrl+C to leave; Preston keeps working in the background. Run `preston` again to pick up where you left off, or to finish any setup that is incomplete.

You can always type `status`, `stop`, `pause` or `resume`. Preston answers these straight away, even when its own agent has run out of quota. If Preston loses a chat connection, such as its WeChat login, it shows a notification on your computer.

## Where Preston keeps things

All of Preston's state, config and logs live in `~/.preston` (or `$PRESTON_HOME`), never inside your projects. Its config file is readable only by you, and tokens are masked in its logs, which are in `~/.preston/logs`.

To start at login, Preston registers itself with your computer's own service manager, for your user only and without administrator rights:

- **macOS:** a LaunchAgent, `~/Library/LaunchAgents/ai.polyweave.preston.plist`.
- **Linux:** a systemd user service, `~/.config/systemd/user/preston.service`. Where systemd user services are unavailable (for example in WSL or a container), it uses `~/.config/autostart/preston.desktop` on a desktop; otherwise it tells you to run `preston` after you sign in.
- **Windows:** a scheduled task named `Preston` that runs when you sign in, or `Preston.cmd` in your Startup folder if scheduled tasks are not allowed.

A different `PRESTON_HOME` gets its own registration, named with a short suffix. After upgrading Node or reinstalling Preston, run `preston` once so the registration uses the new location.

## Stopping or removing Preston

To stop the background service and keep it from starting at login, remove its registration: on macOS run `launchctl bootout gui/$(id -u)/ai.polyweave.preston` and delete the plist; on Linux run `systemctl --user disable --now preston.service`; on Windows run `schtasks /Delete /TN Preston /F` (or delete `Preston.cmd` from the Startup folder) and end Preston's `node` process. Running `preston` again sets it up again. To remove Preston completely, also run `npm rm -g @polyweave/preston` and delete `~/.preston`.

## Your agents and their terms

Preston drives your own, unmodified `claude` and `codex` CLIs under the logins you already have. It never reads, stores or forwards your credentials. Anthropic's terms let you use Claude Code with your own subscription. They also expect plan limits to reflect ordinary, individual usage, and long unattended work may sit uneasily with that. OpenAI allows ChatGPT-plan use in open-source, locally run tools through the Codex App Server. Check the current terms for your plan.

## Development

```sh
npm install
npm run check   # typecheck, lint and tests
npm run build   # compiles to dist/
npm run test:pack   # packs, installs into a temporary prefix, runs the installed preston
```

The [architecture](docs/architecture.md), the [glossary](CONTEXT.md) and the [decisions](docs/adr/) describe how Preston is put together.

## Licence

MIT
