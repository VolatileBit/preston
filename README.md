<p align="center"><img src="assets/logo.png" alt="Preston" width="160"></p>

# Preston

A self-hosted chief of staff for your coding agents. Give it a goal. Get a result.

Preston takes ownership of an outcome you describe in plain language, hands the work to the coding agent already on your computer (Claude Code or Codex), keeps it going through stalls, crashes and restarts, checks the result itself, and tells you briefly how it went: **Verified**, **Unverified** or **Blocked**. It asks you only for real product decisions or for authority beyond what you gave it.

You talk to Preston only through chat. There are no commands to learn.

## Install

```sh
npm i -g @polyweave/preston
```

## Run

```sh
preston
```

The first time, Preston finds the coding agents installed on your computer and asks which to use. Then it offers to connect a chat app, so you can talk to it away from this computer, and walks you through it step by step:

- **Discord**: you create your own Discord bot and paste its token. You need a Discord server to add the bot to; you can create one for free.
- **Slack**: Preston gives you a ready-made app manifest to paste into Slack's "Create an app" page, then asks for the two tokens Slack shows you.
- **WeChat**: Preston shows a QR code; scan it with WeChat on your phone.

Any of them, or none: the terminal always works. Each one is paired with your own account, and only you can give Preston instructions there.

After that, `preston` opens a conversation with Preston. Tell it what you want done. Press Ctrl+C to leave; Preston keeps working in the background. Run `preston` again to pick up where you left off, including anything left unfinished, such as scanning a new WeChat code when WeChat ended Preston's login.

You can always type `status`, `stop`, `pause` or `resume`. Preston answers these straight away, even when its own agent has run out of quota.

## Requirements

- Node.js 22.13 or later, on macOS, Windows or Linux.
- [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex), installed and signed in.

Preston keeps all of its state in `~/.preston` (or `$PRESTON_HOME`), never inside your projects. Its config file is readable only by you, and tokens are masked in its logs.

## Your agents and their terms

Preston drives your own, unmodified `claude` and `codex` CLIs under the logins you already have. It never reads, stores or forwards your credentials. Anthropic's terms let you use Claude Code with your own subscription. They also expect plan limits to reflect ordinary, individual usage, and long unattended work may sit uneasily with that. OpenAI allows ChatGPT-plan use in open-source, locally run tools through the Codex App Server. Check the current terms for your plan.

## Development

```sh
npm install
npm run check   # typecheck, lint and tests
npm run build   # compiles to dist/
```

The [architecture](docs/architecture.md), the [glossary](CONTEXT.md) and the [decisions](docs/adr/) describe how Preston is put together.

## Licence

MIT
