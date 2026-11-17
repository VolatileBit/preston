import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { fixedWord } from "../src/channels/router.js";
import { statusText } from "../src/goals/status.js";
import { languageFromLocale, setLanguage } from "../src/i18n/index.js";
import { parseYesNo } from "../src/landing/messages.js";
import { ActivityIndicator, type Timers } from "../src/terminal/activity.js";
import type { FakeScript, FakeTurn } from "../src/workers/fake/index.js";
import { ownerMessage, startPreston, waitFor } from "./support/harness.js";

afterEach(() => setLanguage("en"));

describe("Simplified Chinese", () => {
  test("the locale suggests a language, defaulting to English", () => {
    expect(languageFromLocale("zh_CN.UTF-8")).toBe("zh-CN");
    expect(languageFromLocale("zh-Hans")).toBe("zh-CN");
    expect(languageFromLocale("en_US.UTF-8")).toBe("en");
    expect(languageFromLocale(undefined)).toBe("en");
  });

  test("the fixed words also work in Chinese, whatever language Preston speaks", () => {
    expect(fixedWord(" 状态 ")).toBe("status");
    expect(fixedWord("停止")).toBe("stop");
    expect(fixedWord("暂停")).toBe("pause");
    expect(fixedWord("继续")).toBe("resume");
    expect(fixedWord("继续做吧")).toBeUndefined();
  });

  test("a yes or no in Chinese answers a publish question; anything unclear is no", () => {
    for (const yes of ["是", "是的", "好的", "可以", "同意，合并吧", "yes"]) {
      expect(parseYesNo(yes)).toBe("yes");
    }
    for (const no of ["否", "不要", "不可以", "不是", "先别", "maybe"]) {
      expect(parseYesNo(no)).toBe("no");
    }
  });

  test("the status reply follows the chosen language", () => {
    expect(statusText([], [])).toBe("Nothing in progress. Tell me what you'd like done.");
    setLanguage("zh-CN");
    expect(statusText([], [])).toBe("目前没有进行中的事项。告诉我您想做什么吧。");
  });

  test("config.language switches Preston's own replies and the Coordinator's guidance", async () => {
    const seen: string[] = [];
    const script: FakeScript = async (turn: FakeTurn) => {
      seen.push(turn.input.appendSystemPrompt ?? "");
      return ownerMessage(turn) ? "好的" : "";
    };
    const p = await startPreston({ scenario: { coordinator: script } });

    p.owner.receive("status");
    await waitFor(() => p.owner.texts("reply").length === 1, { what: "English status" });
    expect(p.owner.texts("reply")[0]).toContain("Nothing in progress");

    p.rt.config.update({ language: "zh-CN" }, "test");
    p.owner.receive("status");
    await waitFor(() => p.owner.texts("reply").length === 2, { what: "Chinese status" });
    expect(p.owner.texts("reply")[1]).toContain("目前没有进行中的事项");

    p.owner.receive("你好");
    await waitFor(() => seen.length > 0, { what: "a Coordinator turn" });
    expect(seen.at(-1)).toContain("Simplified Chinese");
  });

  test("Discord and Slack setup guides come in Chinese", async () => {
    const p = await startPreston({ scenario: {} });
    const { CHAT_CHANNELS } = await import("../src/channels/registry.js");
    expect(CHAT_CHANNELS.discord.guide()).toContain("Setting up Discord");
    setLanguage("zh-CN");
    expect(CHAT_CHANNELS.discord.guide()).toContain("设置 Discord");
    expect(CHAT_CHANNELS.slack.guide()).toContain("设置 Slack");
    expect(CHAT_CHANNELS.slack.guide()).toContain("manifest");
    expect(p.rt.config.get().language).toBe("en");
  });
});

describe("the thinking indicator", () => {
  /** Timers the test drives by hand. */
  function manualTimers() {
    let tick: (() => void) | undefined;
    const timers: Timers = {
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        tick = undefined;
      },
    };
    return { timers, tick: () => tick?.(), active: () => tick !== undefined };
  }

  test("animates a spinner with a message while Preston thinks, then restores the prompt", () => {
    const drawn: string[] = [];
    const clock = manualTimers();
    const indicator = new ActivityIndicator(
      (p) => drawn.push(p),
      clock.timers,
      () => 0,
    );

    indicator.start();
    clock.tick();
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .+… $/);
    expect(drawn[1]).not.toBe(drawn[0]);

    indicator.stop();
    expect(drawn.at(-1)).toBe("");
    expect(clock.active()).toBe(false);
    expect(indicator.running).toBe(false);
  });

  test("starting twice does not stack timers, and stopping when idle draws nothing", () => {
    const drawn: string[] = [];
    const clock = manualTimers();
    const indicator = new ActivityIndicator((p) => drawn.push(p), clock.timers);
    indicator.stop();
    expect(drawn).toEqual([]);
    indicator.start();
    indicator.start();
    expect(drawn).toHaveLength(1);
  });

  test("speaks the chosen language", () => {
    setLanguage("zh-CN");
    const drawn: string[] = [];
    const indicator = new ActivityIndicator((p) => drawn.push(p), manualTimers().timers);
    indicator.start();
    expect(drawn[0]).toMatch(/[一-鿿]/);
  });

  test("the daemon tells an attached terminal when the Coordinator is thinking", async () => {
    const release: { go?: () => void } = {};
    const p = await startPreston({
      scenario: {
        coordinator: async () => {
          await new Promise<void>((resolve) => {
            release.go = resolve;
          });
          return "ok";
        },
      },
    });
    const busy: boolean[] = [];
    const stop = p.rt.onCoordinatorBusy((b) => busy.push(b));
    p.owner.receive("hello there");
    await waitFor(() => p.rt.coordinatorBusy(), { what: "the Coordinator to start" });
    release.go?.();
    await waitFor(() => busy.length === 2, { what: "the Coordinator to finish" });
    stop();
    expect(busy).toEqual([true, false]);
    expect(p.rt.coordinatorBusy()).toBe(false);
  });
});

describe("saving the logo", () => {
  test("logo_save copies the PNG to the folder and returns a file link", async () => {
    const results: string[] = [];
    const folder = join(mkdtempSync(join(tmpdir(), "preston-logo-")), "nested");
    const p = await startPreston({
      scenario: {
        coordinator: async (turn: FakeTurn) => {
          if (!ownerMessage(turn)) return "";
          results.push(await turn.callTool("logo_save", { folder }));
          return "ok";
        },
      },
    });
    p.owner.receive("save the logo");
    await waitFor(() => results.length === 1, { what: "logo_save" });

    const saved = JSON.parse(results[0] as string) as { saved: string; link: string };
    expect(saved.saved).toBe(join(folder, "preston-logo.png"));
    expect(saved.link).toBe(`file://${saved.saved}`);
    expect(statSync(saved.saved).size).toBeGreaterThan(1_000);
    expect(readFileSync(saved.saved).subarray(1, 4).toString()).toBe("PNG");
  });
});
