import { expect } from "vitest";
import { describeTurns, expectVerified, onBranch } from "./support/assertions.js";
import { smokeScenario } from "./support/scenario.js";
import { makeProject, poll, startWorld } from "./support/world.js";

/**
 * Scenario 2: a Worker question. The Brief deliberately leaves out a fact only the owner knows,
 * so the real Worker calls ask_preston; the real Coordinator cannot settle it and escalates with
 * ask_human; the question reaches every Channel; the owner answers on one of them; the Run is
 * resumed in the same native Session and finishes.
 */
smokeScenario("s2-worker-question", ["claude", "codex"], async ({ provider }) => {
  const project = makeProject();
  const world = await startWorld({
    scenario: "s2-worker-question",
    provider,
    coordinator: "real",
    channels: [
      { label: "discord", kind: "discord", reactions: true },
      { label: "slack", kind: "slack", reactions: true },
    ],
  });
  const [discord, slack] = world.channels;
  if (!discord || !slack) throw new Error("two Channels expected");
  const rt = world.daemon.runtime;

  world.say(
    `I'm in a hurry, so no questions to me now, just start. In the folder ${project.dir} the Worker must ` +
      `create greeting.txt containing the greeting our customer prefers. I have not decided which greeting ` +
      `that is and it is not written anywhere in the folder, so the Worker must not guess: put in the Brief ` +
      `that it has to ask Preston with its ask_preston tool which greeting to write. If the Worker asks, ` +
      `do not answer it yourself, ask me. The check is that greeting.txt exists and is not empty ` +
      `(node -e "process.exit(require('fs').readFileSync('greeting.txt','utf8').trim() ? 0 : 1)").`,
    0,
  );

  // The Worker's question reaches every Channel.
  const asked = await poll(
    () => (discord.texts("question").length > 0 && slack.texts("question").length > 0) || undefined,
    4 * 60_000,
    "the Worker's question on both Channels",
    () => `discord: ${discord.texts().join(" || ")}; slack: ${slack.texts().join(" || ")}`,
  );
  expect(asked).toBe(true);
  expect(discord.texts("question")).toHaveLength(1);
  expect(slack.texts("question")).toHaveLength(1);
  // The Worker finishes what does not depend on the answer, ends its turn, and the Run parks.
  const parked = await world.waitForGoal((g) => g.state === "waiting_for_user", 2 * 60_000);
  const sessionBefore = rt.runs(parked.id)[0]?.sessionId;
  expect(sessionBefore).toBeTruthy();
  console.log(`question on both Channels; Worker Session before the answer: ${sessionBefore}`);

  // The owner answers on one Channel (Slack); the first answer wins.
  world.say("Use the greeting: good evening", 1);

  const goal = await world.waitForGoal();
  console.log(describeTurns(world));
  console.log(`Goal ended: ${goal.state}/${goal.outcome} ${goal.detail ?? ""}`);
  expectVerified(rt, goal);

  // The same native Session carried the Run across the question.
  const workerTurns = world.agent.turnsOf("worker");
  expect(workerTurns.length).toBeGreaterThanOrEqual(2);
  expect(workerTurns[0]?.sessionId).toBe(sessionBefore);
  for (const turn of workerTurns.slice(1)) {
    expect(turn.resumedFrom).toBe(sessionBefore);
    expect(turn.sessionId).toBe(sessionBefore);
  }
  expect(rt.runs(goal.id)).toHaveLength(1);
  expect(rt.runs(goal.id)[0]?.sessionId).toBe(sessionBefore);

  // The answer made it into the work, and the other Channel's copy was marked, not re-sent.
  expect(onBranch(project.dir, "main", "greeting.txt")?.toLowerCase()).toContain("good evening");
  expect(discord.reactions.length).toBeGreaterThan(0);
  expect(discord.texts("question")).toHaveLength(1);
  expect(slack.texts("question")).toHaveLength(1);
  expect(rt.openQuestions()).toEqual([]);
});
