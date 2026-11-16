import { expect } from "vitest";
import { smokeScenario } from "./support/scenario.js";
import { poll, startWorld } from "./support/world.js";

/**
 * Scenario 5: talking to the real Coordinator. `status` is answered with no model call. A plain
 * question gets a real answer. Its config tools work end to end: it shows its own settings and
 * changes its own effort, and the change is recorded as a new config version.
 */
smokeScenario("s5-coordinator-chat", ["claude"], async ({ provider }) => {
  const world = await startWorld({
    scenario: "s5-coordinator-chat",
    provider,
    coordinator: "real",
  });
  const rt = world.daemon.runtime;

  // Fixed word: answered by Preston itself, with no model call at all.
  world.say("status");
  await poll(() => world.owner.texts("reply").length > 0, 10_000, "the status reply");
  expect(world.agent.turns).toHaveLength(0);
  expect(world.owner.texts("reply")[0]).toMatch(/\S/);
  console.log(`status reply: ${world.owner.texts("reply")[0]}`);

  // A plain question and the setup tools: one real Coordinator turn.
  world.say("What are you working on right now, and which agent and settings do you think with?");
  await poll(() => world.owner.texts("reply").length > 1, 3 * 60_000, "the Coordinator's answer");
  const answer = world.owner.texts("reply")[1] ?? "";
  expect(world.agent.turnsOf("coordinator")).toHaveLength(1);
  expect(answer).toMatch(/\S/);
  // No Goal exists, and the Coordinator must not have invented one.
  expect(rt.goals()).toEqual([]);
  expect(answer.toLowerCase()).toContain(provider === "claude" ? "claude" : "codex");
  expect(answer).toMatch(/haiku|luna|low/i);

  // Changing its own effort goes through config_update and is recorded as a new version.
  const before = rt.config.history(1)[0]?.version ?? 0;
  expect(rt.config.get().coordinator.effort).toBe("low");
  world.say("Please change your own thinking effort to medium.");
  await poll(
    () => world.owner.texts("reply").length > 2,
    3 * 60_000,
    "the Coordinator's confirmation",
  );
  const latest = rt.config.history(1)[0];
  console.log(`config history: ${JSON.stringify(rt.config.history(3))}`);
  expect(rt.config.get().coordinator.effort).toBe("medium");
  expect(rt.config.get().coordinator.model).toBe(world.agent.turns[0]?.model);
  expect(latest?.version).toBeGreaterThan(before);
  expect(world.agent.turnsOf("coordinator")).toHaveLength(2);
  // The next Coordinator turn would use it (the change is applied from the next invocation).
  expect(world.owner.texts("reply")[2]).toMatch(/medium/i);
});
