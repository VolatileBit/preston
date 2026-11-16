import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { connectToDaemon } from "../daemon/ensure.js";
import { ensureStartAtLogin } from "../daemon/start-at-login.js";
import type { HomePaths } from "../home.js";
import type { IpcClient } from "../ipc/client.js";
import { errorMessage } from "../log.js";
import type { SetupAgent, SetupState } from "../setup/setup.js";

export interface TerminalOptions {
  paths: HomePaths;
  /** This executable, used to start the daemon when it is not running. */
  cliPath: string;
  input?: Readable;
  output?: Writable & { isTTY?: boolean };
}

const INSTALL_HELP = [
  "Preston works through a coding agent already on your computer: Claude Code or Codex.",
  "Install one and sign in to it, then run `preston` again:",
  "- Claude Code: https://claude.com/claude-code",
  "- Codex: https://developers.openai.com/codex",
].join("\n");

/**
 * `preston`: makes sure the daemon is running, finishes the deterministic part of setup, then
 * opens the terminal conversation. Ctrl+C or Ctrl+D leaves; Preston keeps running.
 */
export async function runTerminal(options: TerminalOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = Boolean(output.isTTY);
  const rl = createInterface({ input, output, terminal: interactive });
  const print = (text: string) => {
    if (interactive) {
      clearLine(output, 0);
      cursorTo(output, 0);
    }
    output.write(`${text}\n\n`);
    if (interactive) rl.prompt(true);
  };

  let client: IpcClient;
  try {
    client = await connectToDaemon(options.paths, options.cliPath);
  } catch (err) {
    print(`I couldn't start Preston: ${errorMessage(err)}`);
    rl.close();
    return 1;
  }
  await ensureStartAtLogin();

  const state = await client.request<SetupState>("setup.state");
  let justChoseAgents = false;
  if (state.needsAgents) {
    const chosen = await chooseAgents(state, rl, print);
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
  });
  await client.request("terminal.attach");
  const { handedToCoordinator } = await client.request<{ handedToCoordinator: boolean }>(
    "setup.continue",
    { justChoseAgents },
  );
  if (!handedToCoordinator) print("Preston is here. What would you like done?");

  return new Promise<number>((resolve) => {
    let leaving = false;
    rl.setPrompt("> ");
    rl.prompt();
    rl.on("line", (line) => {
      const text = line.trim();
      if (text) {
        client
          .request("terminal.send", { text })
          .catch((err) => print(`That didn't reach Preston: ${errorMessage(err)}`));
      }
      rl.prompt();
    });
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      leaving = true;
      output.write("\nPreston keeps working in the background. Run `preston` to come back.\n");
      client.close();
      resolve(0);
    });
    client.onClose(() => {
      if (leaving) return;
      print("Lost the connection to Preston. Run `preston` again to reconnect.");
      rl.close();
    });
  });
}

async function chooseAgents(
  state: SetupState,
  rl: Interface,
  print: (text: string) => void,
): Promise<{ agents: string[]; balanceByQuota: boolean } | undefined> {
  const ask = (question: string) =>
    new Promise<string>((resolve) => rl.question(question, resolve));
  const yes = (answer: string) => !/^\s*n/i.test(answer);
  const installed = state.agents.filter((a) => a.installed);
  if (installed.length === 0) {
    const problems = state.agents.filter((a) => a.problem).map((a) => `(${a.label}: ${a.problem})`);
    print([INSTALL_HELP, ...problems].join("\n"));
    return undefined;
  }
  print(`Welcome to Preston. I found ${describe(installed)} on this computer.`);
  const [first] = installed as [SetupAgent, ...SetupAgent[]];
  if (installed.length === 1) {
    if (yes(await ask(`Shall I use ${first.label}? [Y/n] `)))
      return { agents: [first.agent], balanceByQuota: false };
    print("Okay. Run `preston` again when you're ready.");
    return undefined;
  }
  if (
    yes(
      await ask(
        "Shall I use all of them, balanced by how much quota each has left? (recommended) [Y/n] ",
      ),
    )
  ) {
    return { agents: installed.map((a) => a.agent), balanceByQuota: true };
  }
  const menu = installed.map((a, i) => `${i + 1}) ${a.label}`).join("  ");
  for (;;) {
    const answer = (await ask(`Which one should I use? ${menu}: `)).trim();
    const picked = installed[Number.parseInt(answer, 10) - 1];
    if (picked) return { agents: [picked.agent], balanceByQuota: false };
    print(`Please answer with a number from 1 to ${installed.length}.`);
  }
}

function describe(agents: SetupAgent[]): string {
  const names = agents.map((a) => (a.version ? `${a.label} (${a.version})` : a.label));
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
