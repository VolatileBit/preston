import { describe, expect, test } from "vitest";
import { isModelFailure } from "../src/coordinator/coordinator.js";
import type { FakeScript } from "../src/workers/fake/index.js";
import { ownerMessage, startPreston, TEST_CONFIG, waitFor } from "./support/harness.js";

const NOT_FOUND =
  "There's an issue with the selected model (bad-model). It may not exist or you may not have access to it.";

/**
 * A Coordinator that rejects "bad-model" the way an agent CLI does, changes its own model when
 * told `use <model>`, and otherwise greets.
 */
const picky: FakeScript = async (turn) => {
  if (turn.input.model === "bad-model") turn.fail(NOT_FOUND, false);
  const text = ownerMessage(turn)?.trim() ?? "";
  const use = /^use (\S+)$/.exec(text)?.[1];
  if (use) {
    await turn.callTool("config_update", { patch: { coordinator: { model: use } } });
    return `Now thinking with ${use}.`;
  }
  return `Hello from ${turn.input.model ?? "the default"}.`;
};

describe("a Coordinator model that does not work", () => {
  test("goes back to the settings that worked, tells the user once, and answers the message", async () => {
    const p = await startPreston({ scenario: { coordinator: picky } });
    p.owner.receive("hi");
    await waitFor(() => p.owner.texts("reply").length === 1, { what: "the first reply" });
    p.owner.receive("use bad-model");
    await waitFor(() => p.owner.texts("reply").length === 2, { what: "the second reply" });
    expect(p.rt.config.get().coordinator.model).toBe("bad-model");

    p.owner.receive("hello again");
    await waitFor(() => p.owner.texts("reply").length === 3, { what: "the third reply" });
    p.owner.receive("and again");
    await waitFor(() => p.owner.texts("reply").length === 4, { what: "the fourth reply" });

    expect(p.owner.texts("reply").slice(2)).toEqual([
      "Hello from the default.",
      "Hello from the default.",
    ]);
    expect(p.rt.config.get().coordinator.model).toBeUndefined();
    const notices = p.owner.texts("notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("I couldn't think with bad-model");
    expect(notices[0]).toContain("gone back to its default model");
    expect(p.rt.config.history(5)[0]?.reason).toContain("went back to the settings that worked");
    // The failed attempt and the retry were two turns for one message.
    const turns = p.fake.calls.filter((c) => c.role === "coordinator");
    expect(turns.map((c) => c.input.model)).toEqual([
      undefined,
      undefined,
      "bad-model",
      undefined,
      undefined,
    ]);
  });

  test("restores the earlier model, not just the defaults, when that one had worked", async () => {
    const p = await startPreston({
      config: { ...TEST_CONFIG, coordinator: { agent: "fake", model: "good-model" } },
      scenario: { coordinator: picky },
    });
    p.owner.receive("hi");
    await waitFor(() => p.owner.texts("reply").length === 1);
    p.owner.receive("use bad-model");
    await waitFor(() => p.owner.texts("reply").length === 2);

    p.owner.receive("hello");
    await waitFor(() => p.owner.texts("reply").length === 3);

    expect(p.owner.texts("reply")[2]).toBe("Hello from good-model.");
    expect(p.rt.config.get().coordinator.model).toBe("good-model");
    expect(p.owner.texts("notice")[0]).toContain("gone back to good-model");
  });

  test("a model that never worked is replaced by the defaults", async () => {
    const p = await startPreston({
      config: { ...TEST_CONFIG, coordinator: { agent: "fake", model: "bad-model" } },
      scenario: { coordinator: picky },
    });

    p.owner.receive("hi");
    await waitFor(() => p.owner.texts("reply").length === 1, { what: "the reply" });

    expect(p.owner.texts("reply")).toEqual(["Hello from the default."]);
    expect(p.rt.config.get().coordinator.model).toBeUndefined();
    expect(p.owner.texts("notice")).toHaveLength(1);
  });

  test("status, stop and pause keep answering while the Coordinator cannot", async () => {
    const p = await startPreston({
      scenario: { coordinator: (turn) => turn.fail(NOT_FOUND, false) },
    });

    p.owner.receive("status");
    p.owner.receive("hello");
    await waitFor(() => p.owner.texts("reply").length === 2, { what: "two replies" });
    p.owner.receive("stop");
    await waitFor(() => p.owner.texts("reply").length === 3, { what: "the stop reply" });

    expect(p.owner.texts("reply")[0]).toBe("Nothing in progress. Tell me what you'd like done.");
    expect(p.owner.texts("reply")[1]).toContain("Something went wrong on my side");
    expect(p.owner.texts("reply")[2]).toBe("Nothing was running.");
  });

  test("other failures leave the settings alone", async () => {
    const p = await startPreston({
      config: { ...TEST_CONFIG, coordinator: { agent: "fake", model: "some-model" } },
      scenario: {
        coordinator: (turn) => turn.fail("Connection reset by peer", true),
      },
    });

    p.owner.receive("hi");
    await waitFor(() => p.owner.texts("reply").length === 1);

    expect(p.rt.config.get().coordinator.model).toBe("some-model");
    expect(p.owner.texts("notice")).toEqual([]);
  });
});

describe("recognising a model failure", () => {
  test.each([
    NOT_FOUND,
    "The model `gpt-9` does not exist or you do not have access to it.",
    "modelNotFound",
    "model_not_found: claude-sonnet-9",
    "Unknown model: foo",
    "Invalid effort level 'ultra' for this model",
    "The selected model is not available on this plan",
    "You do not have access to the model gpt-6.1-sol",
  ])("%s", (error) => {
    expect(isModelFailure(error)).toBe(true);
  });

  test.each([
    "Connection reset by peer",
    "Not logged in. Please run /login",
    "You've hit your session limit",
    "The model's answer was empty",
    "Request failed with status 500",
  ])("%s is not one", (error) => {
    expect(isModelFailure(error)).toBe(false);
  });
});
