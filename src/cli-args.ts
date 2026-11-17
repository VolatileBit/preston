import { pick } from "./i18n/index.js";

/** What the command line asks for. Only `preston` and `preston stop` are for users. */
export type Invocation =
  | { kind: "open" }
  | { kind: "stop" }
  | { kind: "help" }
  | { kind: "error"; message: string }
  // Internal roles of the same executable, never shown in the help.
  | { kind: "daemon" }
  | { kind: "version" }
  | { kind: "mcp"; args: string[] };

/**
 * Reads the command line the POSIX way: options start with `-`, `--` ends them, `-h` and
 * `--help` win over everything else, and anything unrecognised is an error (never ignored).
 */
export function parseArgs(argv: readonly string[]): Invocation {
  const [first, ...rest] = argv;
  // Internal roles keep their own arguments.
  if (first === "daemon" && rest.length === 0) return { kind: "daemon" };
  if (first === "mcp") return { kind: "mcp", args: rest };
  if (first === "--version" && rest.length === 0) return { kind: "version" };

  const operands: string[] = [];
  let optionsEnded = false;
  for (const arg of argv) {
    if (optionsEnded || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
    } else if (arg === "--") {
      optionsEnded = true;
    } else if (arg === "-h" || arg === "--help") {
      return { kind: "help" };
    } else if (arg.startsWith("--")) {
      return { kind: "error", message: `unrecognized option '${arg}'` };
    } else {
      // A cluster such as -xh is read letter by letter; -h anywhere in it asks for help.
      if (arg.slice(1).includes("h")) return { kind: "help" };
      return { kind: "error", message: `invalid option -- '${arg[1]}'` };
    }
  }
  const [command, ...extra] = operands;
  if (command === undefined) return { kind: "open" };
  if (command !== "stop") return { kind: "error", message: `unknown command '${command}'` };
  if (extra.length > 0) {
    return { kind: "error", message: `unexpected argument '${extra[0]}' after 'stop'` };
  }
  return { kind: "stop" };
}

/** The text of `preston -h`: usage first, then what each form does. */
export function helpText(): string {
  return pick({
    en: `Usage: preston
       preston stop
       preston -h

Preston is a chief of staff for your coding agents. Run \`preston\` and tell it what
you want done in plain words; it also talks to you in Discord or Slack once connected.

Commands:
  (none)  Open the conversation with Preston. The first time, this sets Preston up. It
          starts the background service if it is not running, and keeps Preston up to date.
  stop    Stop the background service. Work in progress is saved and picks up again
          the next time Preston starts (run \`preston\`, or sign in to your computer).

Options:
  -h, --help  Show this help and exit.

Exit status: 0 on success, 1 if something went wrong, 2 for a mistake in the command line.
`,
    "zh-CN": `用法：preston
      preston stop
      preston -h

Preston 是您编程助手的总管。运行 \`preston\`，用平常的话告诉它您想做什么；
连接 Discord 或 Slack 后，也可以在那里和它对话。

命令：
  （无）  打开与 Preston 的对话。第一次运行时会引导您完成设置。如果后台服务没有运行，
          会先启动它，并保持 Preston 为最新版本。
  stop    停止后台服务。进行中的工作会被保存，下次 Preston 启动时继续
          （运行 \`preston\`，或重新登录电脑）。

选项：
  -h, --help  显示本帮助并退出。

退出状态：0 表示成功，1 表示出错，2 表示命令行有误。
`,
  });
}

/** What is printed to stderr for a command-line mistake. */
export function usageError(message: string): string {
  return `preston: ${message}\nUsage: preston | preston stop | preston -h\n`;
}
