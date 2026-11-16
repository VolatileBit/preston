import { describe, expect, test } from "vitest";
import { type FakeAdapter, fakeAdapterFactory } from "../src/workers/fake/index.js";
import type { ModelInfo } from "../src/workers/types.js";
import {
  brief,
  reportingWorker,
  startPreston,
  TEST_CONFIG,
  tempDir,
  waitFor,
} from "./support/harness.js";
import { teacher } from "./support/teach.js";

const CODEX_MODELS: ModelInfo[] = [
  { id: "gpt-6.1-sol", displayName: "GPT 6.1 Sol", isDefault: true, efforts: ["medium", "high"] },
  { id: "gpt-6.1-mini", displayName: "GPT 6.1 Mini", efforts: ["low", "medium"] },
];

/** The fake agent plus stand-ins for Claude Code (names checked by shape) and Codex (listed). */
async function threeAgents(config: Record<string, unknown>) {
  const t = teacher(tempDir("project"));
  const claude = fakeAdapterFactory({ agent: "claude", worker: reportingWorker });
  const codex = fakeAdapterFactory({ agent: "codex", worker: reportingWorker });
  const p = await startPreston({
    scenario: { coordinator: t.coordinator, worker: reportingWorker },
    adapters: {
      claude: claude.factory,
      codex: (ctx) => ({
        ...(codex.factory(ctx) as FakeAdapter),
        listModels: async () => CODEX_MODELS,
      }),
    },
    config: {
      ...TEST_CONFIG,
      agents: { enabled: ["claude", "codex"] },
      ...config,
    },
  });
  return { p, t, claude, codex };
}

describe("Worker model and effort per agent", () => {
  test("each agent's Workers use its own setting, the general one otherwise, and nothing when unset", async () => {
    const { p, t, claude, codex } = await threeAgents({
      workers: { effort: "medium", claude: { model: "opus" }, codex: { model: "gpt-6.1-mini" } },
    });
    const goal = async (agent: "claude" | "codex") => {
      // Start the Goal on the agent whose turn we want to see.
      await t.call(p, "config_update", { patch: { agents: { enabled: [agent] } } });
      const created = await t.call(p, "goal_create", { projectPath: tempDir("p"), brief: brief() });
      await waitFor(() => p.rt.goal(created.goalId)?.endedAt, { what: "goal to finish" });
    };

    await goal("claude");
    await goal("codex");

    expect(claude.adapter().calls.at(-1)?.input).toMatchObject({ model: "opus", effort: "medium" });
    expect(codex.adapter().calls.at(-1)?.input).toMatchObject({
      model: "gpt-6.1-mini",
      effort: "medium",
    });

    await t.call(p, "config_update", {
      patch: { workers: { model: null, effort: null, claude: null, codex: null } },
    });
    await goal("claude");
    expect(claude.adapter().calls.at(-1)?.input.model).toBeUndefined();
    expect(claude.adapter().calls.at(-1)?.input.effort).toBeUndefined();
  });

  test("the general keys still work for every agent", async () => {
    const { p, t, claude } = await threeAgents({ workers: { model: "sonnet", effort: "high" } });

    const created = await t.call(p, "goal_create", { projectPath: tempDir("p"), brief: brief() });
    await waitFor(() => p.rt.goal(created.goalId)?.endedAt, { what: "goal to finish" });

    expect(claude.adapter().calls[0]?.input).toMatchObject({ model: "sonnet", effort: "high" });
  });

  test("a per-agent setting is checked against what that agent offers, and nothing is saved if it is wrong", async () => {
    const { p, t } = await threeAgents({});
    const before = p.rt.config.history(100).length;

    const unknownModel = await t.refused(p, "config_update", {
      patch: { workers: { codex: { model: "imaginary-9" } } },
    });
    const badEffort = await t.refused(p, "config_update", {
      patch: { workers: { codex: { model: "gpt-6.1-mini", effort: "high" } } },
    });
    const notClaude = await t.refused(p, "config_update", {
      patch: { workers: { claude: { model: "gpt-6.1-sol" } } },
    });
    const good = await t.call(p, "config_update", {
      patch: { workers: { claude: { model: "opus", effort: "xhigh" }, codex: { effort: "high" } } },
    });

    expect(unknownModel).toContain("isn't one of the models your Codex account offers");
    expect(badEffort).toContain('doesn\'t offer "high" effort');
    expect(notClaude).toContain("isn't a Claude model name");
    expect(good.config.workers).toEqual({
      claude: { model: "opus", effort: "xhigh" },
      codex: { effort: "high" },
    });
    expect(p.rt.config.history(100)).toHaveLength(before + 1);
  });

  test("a general setting that one agent does not offer says so, and how to set it per agent", async () => {
    const { p, t } = await threeAgents({});

    const reason = await t.refused(p, "config_update", {
      patch: { workers: { model: "gpt-6.1-mini" } },
    });

    expect(reason).toContain("isn't a Claude model name");
    expect(reason).toContain("workers.claude or workers.codex");
  });
});
