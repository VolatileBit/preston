import { describe, expect, test } from "vitest";
import { type FakeScript, fakeAdapterFactory } from "../src/workers/fake/index.js";
import type { QuotaReading } from "../src/workers/types.js";
import {
  brief,
  finishedGoal,
  reportingWorker,
  startPreston,
  TEST_CONFIG,
  tempDir,
  waitFor,
} from "./support/harness.js";
import { teacher } from "./support/teach.js";

const reading = (
  bucket: string,
  usedPercent: number,
  extra: Partial<QuotaReading> = {},
): QuotaReading => ({ bucket, available: true, usedPercent, checkedAt: "", ...extra });

/** Two agents, "fake" (first choice) and "codex", each reporting the quota it is told to. */
async function twoAgents(
  options: {
    fake?: () => QuotaReading[];
    codex?: () => QuotaReading[];
    balance?: boolean;
    worker?: FakeScript;
    config?: Record<string, unknown>;
  } = {},
) {
  const project = tempDir("project");
  const t = teacher(project);
  const codex = fakeAdapterFactory({
    agent: "codex",
    quota: options.codex ?? (() => [reading("codex:primary", 20)]),
    worker: options.worker ?? reportingWorker,
  });
  const p = await startPreston({
    scenario: {
      coordinator: t.coordinator,
      worker: options.worker ?? reportingWorker,
      quota: options.fake ?? (() => [reading("fake:5h", 20)]),
    },
    adapters: { codex: codex.factory },
    config: {
      ...TEST_CONFIG,
      agents: { enabled: ["fake", "codex"], balanceByQuota: options.balance ?? true },
      ...options.config,
    },
  });
  const start = async (projectPath = project) => {
    const created = await t.call(p, "goal_create", { projectPath, brief: brief() });
    await waitFor(() => p.rt.goal(created.goalId)?.endedAt, { what: "goal to finish" });
    return created as { goalId: string; agent: string };
  };
  return { p, t, project, start };
}

describe("which agent a new Goal goes to", () => {
  test("the one with headroom, recorded with its reason and shown in status", async () => {
    const { p, t, start } = await twoAgents({ fake: () => [reading("fake:5h", 95)] });

    const created = await start();

    expect(created.agent).toBe("codex");
    expect(p.rt.runs(created.goalId).map((r) => r.agent)).toEqual(["codex"]);
    const { goals } = await t.call(p, "goal_list");
    expect(goals[0].agentChoice).toEqual({
      agent: "codex",
      reason: "Codex has quota to spare; Fake agent is out or nearly out",
    });
  });

  test("status names the agent a Goal is on once there is more than one", async () => {
    const { p, t, project } = await twoAgents({
      fake: () => [reading("fake:5h", 95)],
      worker: (turn) => turn.stall(),
    });

    await t.call(p, "goal_create", { projectPath: project, brief: brief() });
    await waitFor(() => p.rt.goals()[0]?.state === "running");

    expect(p.rt.statusText()).toBe(
      "In progress:\n- Make the greeting page say hello (working, on Codex)",
    );
  });

  test("the headroom threshold is the configured share of quota used", async () => {
    const { start } = await twoAgents({
      fake: () => [reading("fake:5h", 95)],
      config: { quota: { headroomPercent: 99 } },
    });

    expect((await start()).agent).toBe("fake");
  });

  test("a threshold outside 1 to 100 is refused", async () => {
    const { p, t } = await twoAgents();

    expect(
      await t.refused(p, "config_update", { patch: { quota: { headroomPercent: 0 } } }),
    ).toContain("not valid");
    expect(
      await t.refused(p, "config_update", { patch: { quota: { headroomPercent: 150 } } }),
    ).toContain("not valid");
    const ok = await t.call(p, "config_update", { patch: { quota: { headroomPercent: 80 } } });
    expect(ok.config.quota.headroomPercent).toBe(80);
  });

  test("with room on both, the agent that last worked on the Project, otherwise the first choice", async () => {
    let fakeUsed = 95;
    const { p, t, start } = await twoAgents({ fake: () => [reading("fake:5h", fakeUsed)] });
    const first = await start();
    expect(first.agent).toBe("codex");

    fakeUsed = 10;
    const again = await start();
    const elsewhere = await start(tempDir("another-project"));

    expect(again.agent).toBe("codex");
    expect(
      (await t.call(p, "goal_list")).goals.find((g: { id: string }) => g.id === again.goalId)
        .agentChoice.reason,
    ).toBe("Codex has quota to spare and worked on this project last");
    expect(elsewhere.agent).toBe("fake");
  });

  test("with none having room, the one expected back first", async () => {
    const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
    const { start } = await twoAgents({
      fake: () => [reading("fake:5h", 100, { available: false, resetsAt: hours(5) })],
      codex: () => [reading("codex:primary", 100, { available: false, resetsAt: hours(2) })],
    });

    const created = await start();

    expect(created.agent).toBe("codex");
  });

  test("without permission to balance, the first choice keeps the work however full it is", async () => {
    const { start } = await twoAgents({
      balance: false,
      fake: () => [reading("fake:5h", 99)],
    });

    expect((await start()).agent).toBe("fake");
  });

  test("never an agent the user did not enable", async () => {
    const project = tempDir("project");
    const t = teacher(project);
    const codex = fakeAdapterFactory({ agent: "codex", worker: reportingWorker });
    const p = await startPreston({
      scenario: {
        coordinator: t.coordinator,
        worker: reportingWorker,
        quota: () => [reading("fake:5h", 100, { available: false })],
      },
      adapters: { codex: codex.factory },
      config: { ...TEST_CONFIG, agents: { enabled: ["fake"], balanceByQuota: true } },
    });

    const created = await t.call(p, "goal_create", { projectPath: project, brief: brief() });
    await waitFor(finishedGoal(p.rt));

    expect(created.agent).toBe("fake");
    expect(codex.adapter().calls).toEqual([]);
  });

  test("the choice survives a restart", async () => {
    const { p, start } = await twoAgents({ fake: () => [reading("fake:5h", 95)] });
    const created = await start();

    const q = await p.restart();

    expect(q.rt.goal(created.goalId)?.agentChoice?.agent).toBe("codex");
  });
});
