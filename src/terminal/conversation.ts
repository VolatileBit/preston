import { clearLine, createInterface, cursorTo } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { connectToDaemon } from "../daemon/ensure.js";
import { ensureStartAtLogin, type StartAtLoginResult } from "../daemon/start-at-login.js";
import type { HomePaths } from "../home.js";
import {
  LANGUAGE_NAMES,
  LANGUAGES,
  type Language,
  languageFromLocale,
  pick,
  setLanguage,
} from "../i18n/index.js";
import type { IpcClient } from "../ipc/client.js";
import { errorMessage } from "../log.js";
import { defaultCoordinator, type SetupAgent, type SetupState } from "../setup/setup.js";
import type { AgentKind } from "../workers/types.js";
import { ActivityIndicator } from "./activity.js";

export interface TerminalOptions {
  paths: HomePaths;
  /** This executable, used to start the daemon when it is not running. */
  cliPath: string;
  input?: Readable;
  output?: Writable & { isTTY?: boolean };
  /** The computer's locale (`LANG`), which suggests the language to offer first. */
  locale?: string;
  /** Registers the daemon to start at login. Tests replace it so nothing is registered. */
  startAtLogin?: (options: { paths: HomePaths; cliPath: string }) => Promise<StartAtLoginResult>;
}

const installHelp = () =>
  pick({
    en: [
      "Preston works through a coding agent already on your computer: Claude Code or Codex.",
      "Install one and sign in to it, then run `preston` again:",
      "- Claude Code: https://claude.com/claude-code",
      "- Codex: https://developers.openai.com/codex",
    ],
    "zh-CN": [
      "Preston 通过您电脑上已有的编程助手工作：Claude Code 或 Codex。",
      "请先安装并登录其中一个，然后再次运行 `preston`：",
      "- Claude Code: https://claude.com/claude-code",
      "- Codex: https://developers.openai.com/codex",
    ],
  }).join("\n");

/**
 * `preston`: makes sure the daemon is running, finishes the deterministic part of setup, then
 * opens the terminal conversation. Ctrl+C or Ctrl+D leaves; Preston keeps running.
 */
export async function runTerminal(options: TerminalOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = Boolean(output.isTTY);
  const rl = createInterface({ input, output, terminal: interactive });
  // The spinner is the prompt's prefix, so text the user is typing is never disturbed.
  let promptPrefix = "";
  const indicator = new ActivityIndicator((prefix) => {
    promptPrefix = prefix;
    rl.setPrompt(`${prefix}> `);
    rl.prompt(true);
  });
  const print = (text: string) => {
    if (interactive) {
      clearLine(output, 0);
      cursorTo(output, 0);
    }
    output.write(`${text}\n\n`);
    if (interactive) rl.prompt(true);
  };

  // Register first, so a re-registration that restarts the service happens before connecting.
  const login = await (options.startAtLogin ?? ensureStartAtLogin)(options);
  if (login.notice) print(login.notice);

  let client: IpcClient;
  try {
    client = await connectToDaemon(options.paths, options.cliPath);
  } catch (err) {
    print(
      pick({
        en: `I couldn't start Preston: ${errorMessage(err)}`,
        "zh-CN": `无法启动 Preston：${errorMessage(err)}`,
      }),
    );
    rl.close();
    return 1;
  }

  const state = await client.request<SetupState>("setup.state");
  setLanguage(state.language);
  let justChoseAgents = false;
  if (state.needsAgents) {
    const chosen = await chooseAgents(
      state,
      rl,
      print,
      options.locale ?? process.env.LC_ALL ?? process.env.LANG,
    );
    if (!chosen) {
      client.close();
      rl.close();
      return 1;
    }
    await client.request("setup.chooseAgents", chosen);
    justChoseAgents = true;
  }

  client.onNotification((method, params) => {
    if (method === "terminal.message") print((params as { text: string }).text);
    // Only a real terminal gets a spinner; piped output stays clean.
    if (method === "terminal.activity" && interactive) {
      if ((params as { busy: boolean }).busy) indicator.start();
      else indicator.stop();
    }
  });
  await client.request("terminal.attach");
  const { handedToCoordinator } = await client.request<{ handedToCoordinator: boolean }>(
    "setup.continue",
    { justChoseAgents },
  );
  if (!handedToCoordinator) {
    print(
      pick({
        en: "Preston is here. What would you like done?",
        "zh-CN": "Preston 在这里。需要我做点什么？",
      }),
    );
  }

  return new Promise<number>((resolve) => {
    let leaving = false;
    rl.setPrompt(`${promptPrefix}> `);
    rl.prompt();
    rl.on("line", (line) => {
      const text = line.trim();
      if (text) {
        client.request("terminal.send", { text }).catch((err) =>
          print(
            pick({
              en: `That didn't reach Preston: ${errorMessage(err)}`,
              "zh-CN": `消息没有送达 Preston：${errorMessage(err)}`,
            }),
          ),
        );
      }
      rl.prompt();
    });
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      leaving = true;
      indicator.stop();
      output.write(
        pick({
          en: "\nPreston keeps working in the background. Run `preston` to come back.\n",
          "zh-CN": "\nPreston 会继续在后台工作。运行 `preston` 即可回来。\n",
        }),
      );
      client.close();
      resolve(0);
    });
    client.onClose(() => {
      if (leaving) return;
      indicator.stop();
      print(
        pick({
          en: "Lost the connection to Preston. Run `preston` again to reconnect.",
          "zh-CN": "与 Preston 的连接已断开。请再次运行 `preston` 重新连接。",
        }),
      );
      rl.close();
    });
  });
}

export async function chooseAgents(
  state: SetupState,
  rl: { question(query: string, callback: (answer: string) => void): void },
  print: (text: string) => void,
  locale: string | undefined,
): Promise<
  | {
      agents: AgentKind[];
      balanceByQuota: boolean;
      coordinator?: AgentKind;
      language: Language;
    }
  | undefined
> {
  const ask = (question: string) =>
    new Promise<string>((resolve) => rl.question(question, resolve));
  const yes = (answer: string) => !/^\s*(n|否|不)/i.test(answer);
  const language = await chooseLanguage(ask, languageFromLocale(locale));
  setLanguage(language);
  const installed = state.agents.filter((a) => a.installed);
  if (installed.length === 0) {
    const problems = state.agents.filter((a) => a.problem).map((a) => `(${a.label}: ${a.problem})`);
    print([installHelp(), ...problems].join("\n"));
    return undefined;
  }
  print(
    pick({
      en: `Welcome to Preston. I found ${describe(installed)} on this computer.`,
      "zh-CN": `欢迎使用 Preston。我在这台电脑上找到了 ${describe(installed)}。`,
    }),
  );
  const [first] = installed as [SetupAgent, ...SetupAgent[]];
  if (installed.length === 1) {
    const question = pick({
      en: `Shall I use ${first.label}? [Y/n] `,
      "zh-CN": `使用 ${first.label} 吗？[Y/n] `,
    });
    if (yes(await ask(question))) {
      return { agents: [first.agent], balanceByQuota: false, language };
    }
    print(
      pick({
        en: "Okay. Run `preston` again when you're ready.",
        "zh-CN": "好的。准备好后再次运行 `preston` 即可。",
      }),
    );
    return undefined;
  }
  const all = pick({
    en: "Shall I use all of them, balanced by how much quota each has left? (recommended) [Y/n] ",
    "zh-CN": "是否全部使用，并按各自剩余额度来分配？（推荐）[Y/n] ",
  });
  if (yes(await ask(all))) {
    const agents = installed.map((a) => a.agent);
    return {
      agents,
      balanceByQuota: true,
      coordinator: await chooseThinker(ask, print, installed),
      language,
    };
  }
  const menu = installed.map((a, i) => `${i + 1}) ${a.label}`).join("  ");
  for (;;) {
    const which = pick({ en: "Which one should I use?", "zh-CN": "使用哪一个？" });
    const answer = (await ask(`${which} ${menu}: `)).trim();
    const picked = installed[Number.parseInt(answer, 10) - 1];
    if (picked) return { agents: [picked.agent], balanceByQuota: false, language };
    print(
      pick({
        en: `Please answer with a number from 1 to ${installed.length}.`,
        "zh-CN": `请输入 1 到 ${installed.length} 之间的数字。`,
      }),
    );
  }
}

/**
 * Which of the agents the user will use does Preston's own thinking (the Coordinator). Codex is
 * offered first and is the default (Enter); the others follow.
 */
async function chooseThinker(
  ask: (question: string) => Promise<string>,
  print: (text: string) => void,
  agents: SetupAgent[],
): Promise<AgentKind> {
  const preferred = defaultCoordinator(agents.map((a) => a.agent));
  const options = [
    ...agents.filter((a) => a.agent === preferred),
    ...agents.filter((a) => a.agent !== preferred),
  ];
  const menu = options
    .map(
      (a, i) =>
        `${i + 1}) ${a.label}${i === 0 ? pick({ en: " (recommended)", "zh-CN": "（推荐）" }) : ""}`,
    )
    .join("  ");
  const question = pick({
    en: `Which agent should do Preston's own thinking (understanding you and planning)? ${menu} [1] `,
    "zh-CN": `由哪个助手负责 Preston 自己的思考（理解您的需求并制定计划）？${menu} [1] `,
  });
  for (;;) {
    const answer = (await ask(question)).trim();
    if (answer === "") return (options[0] as SetupAgent).agent;
    const picked = options[Number.parseInt(answer, 10) - 1];
    if (picked) return picked.agent;
    print(
      pick({
        en: `Please answer with a number from 1 to ${options.length}, or press Enter.`,
        "zh-CN": `请输入 1 到 ${options.length} 之间的数字，或直接按回车。`,
      }),
    );
  }
}

/** The first thing a new user sees, so it is written in both languages. */
async function chooseLanguage(
  ask: (question: string) => Promise<string>,
  suggested: Language,
): Promise<Language> {
  const menu = LANGUAGES.map((l, i) => `${i + 1}) ${LANGUAGE_NAMES[l]}`).join("  ");
  const answer = (
    await ask(`Language / 语言: ${menu} [${LANGUAGES.indexOf(suggested) + 1}] `)
  ).trim();
  return LANGUAGES[Number.parseInt(answer, 10) - 1] ?? suggested;
}

function describe(agents: SetupAgent[]): string {
  const names = agents.map((a) => (a.version ? `${a.label} (${a.version})` : a.label));
  if (names.length <= 1) return names[0] ?? "";
  const and = pick({ en: " and ", "zh-CN": "和" });
  return `${names.slice(0, -1).join(", ")}${and}${names.at(-1)}`;
}
