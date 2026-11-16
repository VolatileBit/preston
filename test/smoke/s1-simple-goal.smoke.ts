import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  describeTurns,
  expectVerified,
  onBranch,
  prestonBranches,
  worktreesIn,
} from "./support/assertions.js";
import { smokeScenario } from "./support/scenario.js";
import { git, makeProject, poll, remoteRefs, startWorld } from "./support/world.js";

/**
 * Scenario 1: setup plus a simple Goal, per provider. A message on the owner Channel reaches the
 * real Coordinator, which drafts a Brief (the user is in a hurry, so no grilling) and starts a
 * Goal in a worktree; the real Worker does the work with its own tools and Preston's MCP server;
 * Preston re-runs the Brief's checks itself, lands the result locally and tells the owner.
 */
smokeScenario("s1-simple-goal", ["claude", "codex"], async ({ provider, startedAt }) => {
  const project = makeProject({ remote: true });
  const originBefore = remoteRefs(project.origin as string);
  const world = await startWorld({
    scenario: "s1-simple-goal",
    provider,
    coordinator: "real",
    chooseAgents: true,
  });
  const rt = world.daemon.runtime;

  // Setup, as `preston` does it: detect the installed agents for real, choose one, then the
  // Coordinator and Worker are set to the cheapest model (what the owner would say in chat).
  const before = await rt.setup.state();
  expect(before.needsAgents).toBe(true);
  const detected = before.agents.find((a) => a.agent === provider);
  expect(detected, `${provider} was not detected`).toMatchObject({ installed: true });
  expect(detected?.version).toMatch(/\d+\.\d+/);
  await rt.setup.chooseAgents({ agents: [provider], balanceByQuota: false });
  rt.config.update(
    {
      coordinator: world.cheapest,
      workers: world.cheapest,
      setup: { complete: true },
    },
    "smoke test: cheapest models",
  );
  expect((await rt.setup.state()).needsAgents).toBe(false);
  expect(rt.config.get().coordinator.agent).toBe(provider);

  world.say(
    `I'm in a hurry, please don't ask me any questions, just draft the Brief and start. ` +
      `In the folder ${project.dir} create hello.txt containing exactly 'hello preston' and a test ` +
      `script check.js that exits 0 only if hello.txt has that content.`,
  );

  const goal = await world.waitForGoal();
  console.log(describeTurns(world));
  console.log(`Goal ended: ${goal.state}/${goal.outcome} ${goal.detail ?? ""}`);
  expectVerified(rt, goal);

  // The Coordinator skipped grilling: it drafted a Brief with a real check and started at once.
  expect(goal.brief.checks.length).toBeGreaterThan(0);
  expect(world.agent.turnsOf("coordinator").length).toBeGreaterThanOrEqual(1);

  // The Worker used Preston's MCP: its report_result is on the Run.
  const runs = rt.runs(goal.id);
  expect(runs[0]?.report?.summary).toBeTruthy();
  expect(runs[0]?.sessionId).toBeTruthy();

  // Landed: a local merge into main (no remote push), the user's checkout fast-forwarded.
  const hello = onBranch(project.dir, "main", "hello.txt");
  expect(hello?.trim()).toBe("hello preston");
  expect(onBranch(project.dir, "main", "check.js")).toBeTruthy();
  expect(readFileSync(join(project.dir, "hello.txt"), "utf8").trim()).toBe("hello preston");
  execFileSync(process.execPath, ["check.js"], { cwd: project.dir });
  expect(remoteRefs(project.origin as string)).toBe(originBefore);

  // The worktree and its branch are gone once the work has landed.
  await poll(() => worktreesIn(world.home).length === 0, 20_000, "the worktree to be removed");
  expect(prestonBranches(project.dir)).toEqual([]);
  expect(git(project.dir, "status", "--porcelain")).toBe("");

  // Concise messages: the Brief reply, one acknowledgement, one outcome.
  const sent = world.owner.sent;
  console.log(sent.map((m) => `[${m.kind}] ${m.text}`).join("\n---\n"));
  expect(sent.filter((m) => m.kind === "ack")).toHaveLength(1);
  const outcomes = sent.filter((m) => m.kind === "outcome");
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.text).toMatch(/verified/i);
  expect(sent.length).toBeLessThanOrEqual(5);
  void startedAt;
});
