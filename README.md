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

## Commands

There are only two: `preston` opens the conversation (and starts the background service if needed), and `preston stop` stops the background service. Work in progress is saved and picks up the next time Preston starts. `preston -h` shows the usage. If you work on Preston itself, `npm run build` keeps `dist/cli.js` executable, so an `npm link` keeps working after a rebuild.

## Updates

Preston keeps itself current. Each time you run `preston`, and every six hours in the background, it asks npm for a newer version. When there is one:

- `preston` installs it, restarts the background service and carries on with the new version.
- The background service installs it only while nothing is running (no Goal in progress), restarts itself, and tells you in chat.

It only updates a copy installed with `npm i -g`. A development checkout, a project install, `npx` or another package manager's copy is left alone, and Preston tells you the command to update by hand. If an install fails (usually npm's folder permissions), it explains why, keeps running the current version, and tries that version again after a day. Your Goals, settings and history carry over. To turn this off, tell Preston to set `selfUpdate.enabled` to false, or run `npm i -g @polyweave/preston@latest` yourself whenever you like.

## Run

```sh
preston
```

The first time, Preston starts its background service, sets it to start by itself whenever you sign in to your computer, finds the coding agents installed, and asks which to use. Then it offers to connect a chat app, so you can talk to it away from this computer, and walks you through it step by step:

- **Discord**: you create your own Discord bot and paste its token. You need a Discord server to add the bot to; you can create one for free.
- **Slack**: Preston gives you a ready-made app manifest to paste into Slack's "Create an app" page, then asks for the two tokens Slack shows you.

If you have both Claude Code and Codex and let Preston use both, setup also asks which of them should do Preston's own thinking (understanding you and planning). Codex is offered first and is the default (just press Enter); choose Claude Code if you prefer it. You can change it later by telling Preston. Preston's own thinking is separate from the work itself, which is shared between the agents by quota.

Preston asks which language you want the first time you run it: English or Simplified Chinese (简体中文). Everything it says to you follows that choice, including the setup steps, and the words `状态`, `停止`, `暂停` and `继续` work like `status`, `stop`, `pause` and `resume`. To change it later, just tell Preston.

You can send Preston pictures, videos, GIFs and other files in Discord or Slack, and ask it to send files back (for example "send me hello.txt"). Files you send are saved under `~/.preston/attachments` and handed to a coding agent that can open them; Preston itself only reads the message and the file list. Preston can send any file on your computer when you ask, up to 25 MB on Discord and 100 MB on Slack; anything bigger it tells you the location of instead. Emoji and GIF links in your messages arrive as plain text.

Preston speaks with one voice: when you give it a Goal, it answers you itself, and when the Goal ends it tells you in its own words, in the language you write in, with any files attached. Tell it how you want to be reached ("I'm going to sleep, let's chat tomorrow morning") and it holds the messages until then. If Preston's own agent is unavailable when a Goal ends, a plain standard message is sent after three minutes instead, so you are never left without a result.

If you ask for something to be made (a picture, a document, a chart), Preston hands it to a coding agent and sends you the file with the result. What can be made is whatever your Claude Code or Codex can do on your computer: drawing with code and installed tools, or an image tool if your agent has one. Preston has no image model of its own.

Slack apps created before this feature need the `files:read` and `files:write` permissions added under "OAuth & Permissions", then a reinstall, or files will not work there.

While Preston is thinking, the terminal shows a spinner with a changing message, so you can tell it is working. During Discord or Slack setup it can also save its logo to your Downloads folder, ready to use as your app's picture.

Any of them, or none: the terminal always works. Each one is paired with your own account, and only you can give Preston instructions there.

After that, `preston` opens a conversation with Preston. Tell it what you want done. Press Ctrl+C to leave; Preston keeps working in the background. Run `preston` again to pick up where you left off, including anything left unfinished.

You can always type `status`, `stop`, `pause` or `resume`. Preston answers these straight away, even when its own agent has run out of quota. If Preston loses a chat connection, such as a revoked bot token, it shows a notification on your computer.

## Looking back and improving

About once a day, Preston looks back over the work it did: what failed or could not be checked, where a coding agent kept getting stuck, which checks failed, which questions you had to answer, and requests that came back. If something repeats, it sends you one short message with up to three suggestions, such as a standing order, a note to remember, a schedule or a better way of writing its instructions. Nothing changes until you agree in chat. A quiet day sends nothing. You can also ask "how did things go this week?" at any time. Each look back is kept as readable text in `~/.preston/reviews`. To turn it off, tell Preston to set `review.enabled` to false.

## What happens to the finished work

In a Git project, Preston gives each Goal its own separate working copy, so your own checkout, branch and unsaved edits are never touched and several Goals can run side by side. When the work is Verified it merges it for you: through a pull request on GitHub if the project has one and the GitHub tool (`gh`) is signed in (it waits for the project's required checks first), otherwise straight into your main branch on your computer. If your main branch is checked out and clean, it is brought up to date; if you are on another branch, Preston leaves you there and says so. If a merge would also publish something (deploy a site, release a build, publish a package), Preston asks you first; you can change that in chat. Work it could not check is left on its own branch, not merged. Files that look installed or built (such as `node_modules`) or are very large binaries are left out of the merge unless your project already tracks them, and Preston says so. A Goal that did not finish keeps its separate working copy for two weeks and then only its branch, never losing unsaved work; if you change your mind about work it held back, ask it to merge it. Folders that are not Git projects are worked on in place.

## Teach Preston by chatting: standing orders, schedules, memory

Everything below is done by telling Preston, not by editing files.

- **Standing orders** are lasting rules about how Preston works: "ask before spending anything", "in my website folder always check accessibility", "merge routine PRs without asking". Preston starts with a few sensible ones (own the objective, recover from routine problems itself, ask you only when it really needs you, prove results, keep messages short). Ask to see, change, switch off or roll back any of them, including those.
- **Schedules** make Preston do something later or on a repeat: "every weekday at 9 check the build", "on Friday at 4pm summarise the week". Each time, Preston starts a normal Goal. It can also run a plain check and speak up only when it fails. If your computer was asleep or off at the time, Preston catches up once when it is back (or skips, if you prefer); it can't run anything while the computer is asleep. Ask it to pause, resume, run now, or show what happened.
- **Memory** is what Preston remembers about you: preferences and facts you tell it ("I prefer short replies", "my staging site is..."). It is kept as readable text in `~/.preston/memory` that you can edit, and it never stores passwords or keys. Ask it to forget something and it does.

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

## Keeping your agents current

Preston keeps your agent CLIs up to date: about once a day, and only when no work is using that CLI, it runs the CLI's own updater and checks that it still starts and is still signed in. It never uses administrator rights; if you installed a CLI with Homebrew, apt, winget or similar, it says so in `status` and leaves it to you. To stop automatic updates, tell Preston so (it sets `agents.autoUpdate` to false).

## Development

```sh
npm install
npm run check   # typecheck, lint and tests
npm run build   # compiles to dist/
npm run test:pack   # packs, installs into a temporary prefix, runs the installed preston
npm run smoke   # uses your real Claude Code and Codex logins (a few cents of quota); see docs/smoke-tests.md
```

The [architecture](docs/architecture.md), the [glossary](CONTEXT.md) and the [decisions](docs/adr/) describe how Preston is put together.

## Licence

MIT
