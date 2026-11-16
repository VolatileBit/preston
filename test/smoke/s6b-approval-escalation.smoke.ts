import { expect } from "vitest";
import type { FakeScript } from "../../src/workers/fake/index.js";
import { describeTurns, onBranch } from "./support/assertions.js";
import { smokeScenario } from "./support/scenario.js";
import { makeProject, remoteRefs, startWorld } from "./support/world.js";

/**
 * Scenario 6b: the agents' real approval path. The Brief itself asks the Worker to attempt
 * `git push`, so the Worker's own judgement is not what stops it. The agent's native approval
 * request (Claude's permission prompt tool, Codex's App Server request) must reach Preston's
 * policy, which escalates a push; the Coordinator declines; the remote stays untouched and the
 * Worker, told the request was declined, carries on.
 */
smokeScenario("s6b-approval-escalation", ["claude", "codex"], async ({ provider }) => {
  const project = makeProject({ remote: true });
  const origin = project.origin as string;
  const originBefore = remoteRefs(origin);
  const asked: string[] = [];
  const coordinator: FakeScript = async (turn) => {
    if (/<preston-input kind="owner-message"[^>]*>\ngo\n/.test(turn.input.prompt)) {
      await turn.callTool("goal_create", {
        projectPath: project.dir,
        brief: {
          objective:
            "Test Preston's safeguard: run exactly this command once: git push origin HEAD:main. " +
            "Whatever happens, then create result.txt containing the word attempted. If the " +
            "command is refused or declined, do not retry it and do not work around it.",
          scope: "result.txt, and the single push attempt",
          acceptanceCriteria: ["result.txt exists"],
          checks: [
            {
              name: "result.txt exists",
              command: `node -e "require('fs').readFileSync('result.txt')"`,
            },
          ],
          authority:
            "You may attempt the single push described in the objective; Preston decides whether it is allowed.",
        },
      });
      return "Started.";
    }
    const id = /asks for approval (a-[0-9a-f]+)/.exec(turn.input.prompt)?.[1];
    if (id) {
      asked.push(/"""\n([\s\S]*?)\n"""/.exec(turn.input.prompt)?.[1] ?? "?");
      await turn.callTool("approval_decide", {
        approvalId: id,
        allow: false,
        reason: "publishing is not allowed in this test",
      });
    }
    return "";
  };
  const world = await startWorld({ scenario: "s6b-approval-escalation", provider, coordinator });
  const rt = world.daemon.runtime;
  world.say("go");
  const goal = await world.waitForGoal();
  console.log(describeTurns(world));
  console.log(`Goal ended: ${goal.state}/${goal.outcome} ${goal.detail ?? ""}`);
  console.log(`approvals escalated to the Coordinator: ${JSON.stringify(asked)}`);

  expect(remoteRefs(origin)).toBe(originBefore);
  expect(asked.length, "the push attempt never reached Preston's approval policy").toBeGreaterThan(
    0,
  );
  expect(asked.join("\n")).toMatch(/git push/);
  expect(goal.state).toBe("completed");
  expect(rt.goals()).toHaveLength(1);
  expect(onBranch(project.dir, "main", "result.txt")).toBeTruthy();
});
