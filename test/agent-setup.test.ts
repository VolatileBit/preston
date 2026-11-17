import { afterEach, describe, expect, test } from "vitest";
import { setLanguage } from "../src/i18n/index.js";
import type { SetupState } from "../src/setup/setup.js";
import { defaultCoordinator } from "../src/setup/setup.js";
import { chooseAgents } from "../src/terminal/conversation.js";
import { startPreston } from "./support/harness.js";

afterEach(() => setLanguage("en"));

const state = (installed: ("claude" | "codex")[]): SetupState => ({
  needsAgents: true,
  complete: false,
  language: "en",
  unfinished: [],
  agents: (["claude", "codex"] as const).map((agent) => ({
    agent,
    label: agent === "claude" ? "Claude Code" : "Codex",
    installed: installed.includes(agent),
  })),
});

/** Answers each question in turn, remembering what was asked. */
function user(...answers: string[]) {
  const asked: string[] = [];
  const printed: string[] = [];
  const rl = {
    question: (q: string, cb: (answer: string) => void) => {
      asked.push(q);
      cb(answers.shift() ?? "");
    },
  };
  return { rl, asked, printed, print: (t: string) => printed.push(t) };
}

describe("which agent does Preston's thinking", () => {
  test("Codex is the default when it is among the agents used", () => {
    expect(defaultCoordinator(["claude", "codex"])).toBe("codex");
    expect(defaultCoordinator(["codex"])).toBe("codex");
    expect(defaultCoordinator(["claude"])).toBe("claude");
  });

  test("with several agents and all of them in use, the user is asked, and Enter picks Codex", async () => {
    const u = user("", "", ""); // language, use all, thinker
    const choice = await chooseAgents(state(["claude", "codex"]), u.rl, u.print, "en_US.UTF-8");
    expect(choice).toMatchObject({
      agents: ["claude", "codex"],
      balanceByQuota: true,
      coordinator: "codex",
    });
    expect(u.asked.at(-1)).toBe(
      "Which agent should do Preston's own thinking (understanding you and planning)? 1) Codex (recommended)  2) Claude Code [1] ",
    );
  });

  test("the user can prefer Claude Code, and a wrong answer is asked again", async () => {
    const u = user("", "", "9", "2");
    const choice = await chooseAgents(state(["claude", "codex"]), u.rl, u.print, "en_US.UTF-8");
    expect(choice?.coordinator).toBe("claude");
    expect(u.printed.some((t) => t.includes("number from 1 to 2"))).toBe(true);
  });

  test("a single agent is not asked who thinks: it thinks", async () => {
    const one = user("", "");
    const choice = await chooseAgents(state(["claude"]), one.rl, one.print, "en_US.UTF-8");
    expect(choice).toMatchObject({ agents: ["claude"] });
    expect(choice?.coordinator).toBeUndefined();
    expect(one.asked).toHaveLength(2);
  });

  test("choosing just one of two agents does not ask either", async () => {
    const u = user("", "n", "2"); // language, not all, pick Claude
    const choice = await chooseAgents(state(["claude", "codex"]), u.rl, u.print, "en_US.UTF-8");
    expect(choice).toMatchObject({ agents: ["codex"], balanceByQuota: false });
    expect(u.asked).toHaveLength(3);
  });

  test("the question is in Chinese for a Chinese user", async () => {
    const u = user("2", "", "");
    await chooseAgents(state(["claude", "codex"]), u.rl, u.print, "en_US.UTF-8");
    expect(u.asked.at(-1)).toContain("由哪个助手负责 Preston 自己的思考");
    expect(u.asked.at(-1)).toContain("1) Codex（推荐）");
  });
});

describe("setup saves the choice", () => {
  test("the thinking agent is stored and must be one of the agents chosen", async () => {
    const p = await startPreston({ scenario: {}, config: {} });
    await expect(
      p.rt.setup.chooseAgents({ agents: ["fake"], balanceByQuota: false, coordinator: "codex" }),
    ).rejects.toThrow("Codex is not one of the agents chosen.");
    await p.rt.setup.chooseAgents({ agents: ["fake"], balanceByQuota: false });
    expect(p.rt.config.get().coordinator.agent).toBe("fake");
  });
});
