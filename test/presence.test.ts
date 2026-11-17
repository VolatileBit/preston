import { describe, expect, test } from "vitest";
import { TypingKeeper, type TypingTimers } from "../src/channels/shared/typing.js";
import { startPreston, waitFor } from "./support/harness.js";

/** Timers the test drives by hand. */
function manualTimers() {
  let ticks: (() => void)[] = [];
  let limits: (() => void)[] = [];
  const timers: TypingTimers = {
    setInterval: (fn) => {
      ticks.push(fn);
      return fn;
    },
    clearInterval: (handle) => {
      ticks = ticks.filter((t) => t !== handle);
    },
    setTimeout: (fn) => {
      limits.push(fn);
      return fn;
    },
    clearTimeout: (handle) => {
      limits = limits.filter((t) => t !== handle);
    },
  };
  return {
    timers,
    tick: () => {
      for (const t of ticks) t();
    },
    expire: () => {
      for (const t of [...limits]) t();
    },
    running: () => ticks.length,
  };
}

describe("the typing indicator", () => {
  test("shows at once, repeats while it lasts, and stops when asked", () => {
    const sent: string[] = [];
    const clock = manualTimers();
    const keeper = new TypingKeeper(
      async (id) => void sent.push(id),
      () => {},
      8_000,
      60_000,
      clock.timers,
    );

    keeper.start("dm");
    expect(sent).toEqual(["dm"]);
    keeper.start("dm");
    expect(sent).toEqual(["dm"]);
    clock.tick();
    clock.tick();
    expect(sent).toEqual(["dm", "dm", "dm"]);

    keeper.stop("dm");
    clock.tick();
    expect(sent).toHaveLength(3);
    expect(clock.running()).toBe(0);
  });

  test("stops by itself if a stop never comes, and a failed call never throws", async () => {
    const clock = manualTimers();
    const logs: string[] = [];
    const keeper = new TypingKeeper(
      async () => {
        throw new Error("Discord is down");
      },
      (_level, message) => logs.push(message),
      8_000,
      60_000,
      clock.timers,
    );
    keeper.start("dm");
    await Promise.resolve();
    expect(logs).toEqual(["Could not show that Preston is typing"]);
    clock.expire();
    expect(clock.running()).toBe(0);
  });
});

describe("showing that Preston is reading and working", () => {
  test("the owner's message is marked as read at once, before any thinking", async () => {
    let release: (() => void) | undefined;
    const p = await startPreston({
      scenario: {
        coordinator: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return "hi";
        },
      },
    });
    const ref = p.owner.receive("hello");
    await waitFor(() => p.owner.acknowledged.length === 1, { what: "the read receipt" });
    expect(p.owner.acknowledged).toEqual([ref]);
    // The Coordinator has not answered yet.
    expect(p.owner.texts("reply")).toEqual([]);
    await waitFor(() => release, { what: "the Coordinator to start" });
    release?.();
  });

  test("fixed words are marked as read too, but a stranger's message is not", async () => {
    const p = await startPreston({ scenario: {} });
    const status = p.owner.receive("status");
    p.owner.receive("let me in", { owner: false });
    await waitFor(() => p.owner.texts("reply").length === 1, { what: "the status reply" });
    expect(p.owner.acknowledged).toEqual([status]);
  });

  test("Preston shows typing in the conversation while it thinks, and stops when it has answered", async () => {
    let release: (() => void) | undefined;
    const p = await startPreston({
      scenario: {
        coordinator: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return "Here you go.";
        },
      },
    });
    p.owner.receive("what is up?");
    await waitFor(() => p.owner.typing.length === 1, { what: "typing to start" });
    expect(p.owner.typing).toEqual([{ conversationId: "fake-dm", typing: true }]);

    release?.();
    await waitFor(() => p.owner.typing.length === 2, { what: "typing to stop" });
    expect(p.owner.typing[1]).toEqual({ conversationId: "fake-dm", typing: false });
    await waitFor(() => p.owner.texts("reply").length === 1, { what: "the reply" });
  });
});
