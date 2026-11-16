import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  brief,
  reportingWorker,
  startPreston,
  tempDir,
  waitFor,
  workerQuestionId,
} from "./support/harness.js";
import { teacher } from "./support/teach.js";

const workerPrompts = (p: Awaited<ReturnType<typeof startPreston>>) =>
  p.fake.calls.filter((c) => c.role === "worker").map((c) => c.input.appendSystemPrompt ?? "");

async function runGoal(
  p: Awaited<ReturnType<typeof startPreston>>,
  t: ReturnType<typeof teacher>,
  projectPath: string,
  objective: string,
) {
  const before = p.rt.goals().filter((g) => g.endedAt).length;
  const { goalId } = await t.call(p, "goal_create", {
    projectPath,
    brief: brief({ objective, scope: "" }),
  });
  await waitFor(
    () => p.rt.goal(goalId)?.endedAt && p.rt.goals().filter((g) => g.endedAt).length > before,
  );
}

describe("standing orders", () => {
  test("ships short global defaults that reach the Coordinator and every Worker", async () => {
    const project = tempDir("project");
    const t = teacher(project);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: reportingWorker },
    });

    const { orders } = await t.call(p, "standing_order_list");
    expect(orders.map((o: { id: string }) => o.id)).toEqual([
      "default-ownership",
      "default-recovery",
      "default-escalation",
      "default-evidence",
      "default-communication",
    ]);
    expect(orders.every((o: { default: boolean }) => o.default)).toBe(true);

    await runGoal(p, t, project, "Make the page say hello");
    const [worker] = workerPrompts(p);
    expect(worker).toContain("never silently abandon it");
    expect(worker).toContain("hard-to-reverse actions");
    expect(worker).not.toContain("Communicate briefly"); // a Coordinator-only order
    const coordinator = p.fake.calls.filter((c) => c.role === "coordinator").at(-1);
    expect(coordinator?.input.appendSystemPrompt).toContain("Communicate briefly");
    expect(coordinator?.input.appendSystemPrompt).toContain("Own the objective");
    expect(coordinator?.input.appendSystemPrompt).toContain("Teaching you by chat");
  });

  test("a standing order applies to the next relevant Goal and not to irrelevant ones", async () => {
    const mine = tempDir("my-site");
    const other = tempDir("other-project");
    const t = teacher(mine);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: reportingWorker },
    });

    await t.call(p, "standing_order_create", {
      title: "Keep the site accessible",
      scope: `project:${mine}`,
      constraints: ["Every page needs alt text on images."],
    });
    await t.call(p, "standing_order_create", {
      title: "Database care",
      keywords: ["migration"],
      constraints: ["Back up the database before any migration."],
    });

    await runGoal(p, t, mine, "Add an about page");
    await runGoal(p, t, other, "Add an about page");
    await runGoal(p, t, mine, "Run the database migration");

    const [inProject, elsewhere, withKeyword] = workerPrompts(p);
    expect(inProject).toContain("Every page needs alt text");
    expect(inProject).not.toContain("Back up the database");
    expect(elsewhere).not.toContain("alt text");
    expect(elsewhere).not.toContain("Back up the database");
    expect(withKeyword).toContain("Back up the database");
    expect(withKeyword).toContain("alt text");
  });

  test("disabling stops it applying and rollback brings an earlier version back", async () => {
    const project = tempDir("project");
    const t = teacher(project);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: reportingWorker },
    });

    const created = await t.call(p, "standing_order_create", {
      title: "Tone",
      constraints: ["Write commit messages in the imperative."],
    });
    await t.call(p, "standing_order_update", {
      id: created.id,
      constraints: ["Write commit messages in the past tense."],
      reason: "user changed their mind",
    });
    await runGoal(p, t, project, "First");
    await t.call(p, "standing_order_disable", { id: created.id, reason: "not wanted" });
    await runGoal(p, t, project, "Second");
    await t.call(p, "standing_order_rollback", { id: created.id, version: 1 });
    await runGoal(p, t, project, "Third");

    const [first, second, third] = workerPrompts(p);
    expect(first).toContain("past tense");
    expect(second).not.toContain("commit messages");
    expect(third).toContain("imperative");
    expect(third).not.toContain("past tense");
    const { versions } = await t.call(p, "standing_order_history", { id: created.id });
    expect(versions.map((v: { version: number }) => v.version)).toEqual([4, 3, 2, 1]);
    expect(versions[0]).toMatchObject({ enabled: true, reason: "rolled back to version 1" });
    expect(versions[1]).toMatchObject({ enabled: false });
    const { orders } = await t.call(p, "standing_order_list", { includeDisabled: true });
    expect(orders).toHaveLength(6);
  });

  test("a default can be disabled and stays disabled across a restart", async () => {
    const project = tempDir("project");
    const t = teacher(project);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: reportingWorker },
    });
    await t.call(p, "standing_order_disable", { id: "default-evidence", reason: "too strict" });

    const restarted = await p.restart();
    const { orders } = await t.call(restarted, "standing_order_list");
    expect(orders.map((o: { id: string }) => o.id)).not.toContain("default-evidence");
    expect(orders).toHaveLength(4);
  });

  test("a typed flag lifts the publishing-merge question, most specific scope winning", async () => {
    const site = tempDir("site");
    const other = tempDir("other");
    const t = teacher(site);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: reportingWorker },
    });
    const policy = (path: string) => p.rt.standing.effectivePolicy({ projectPath: path });

    expect(policy(site).landing.autoMergePublishing).toBe(false);

    const global = await t.call(p, "standing_order_create", {
      title: "Ship it",
      authority: "merge PRs that also deploy",
      policy: { "landing.autoMergePublishing": true },
    });
    expect(policy(site).landing.autoMergePublishing).toBe(true);
    expect(policy(other).landing.autoMergePublishing).toBe(true);

    await t.call(p, "standing_order_create", {
      title: "Careful with the site",
      scope: `project:${site}`,
      policy: { "landing.autoMergePublishing": false },
    });
    expect(policy(site).landing.autoMergePublishing).toBe(false);
    expect(policy(join(site, "sub")).landing.autoMergePublishing).toBe(false);
    expect(policy(other).landing.autoMergePublishing).toBe(true);

    await t.call(p, "standing_order_disable", { id: global.id, reason: "never mind" });
    expect(policy(other).landing.autoMergePublishing).toBe(false);
  });

  test("rendered orders stay within the token budget and say what was left out", async () => {
    const project = tempDir("project");
    const t = teacher(project);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: reportingWorker },
      config: {
        ...(await import("./support/harness.js")).TEST_CONFIG,
        standing: { tokenBudget: 60 },
      },
    });
    await runGoal(p, t, project, "Anything");
    const [prompt] = workerPrompts(p);
    expect(prompt).toMatch(/\(\d+ more not shown/);
    const block = prompt?.slice(prompt.indexOf("Standing orders from the user")) ?? "";
    expect(block.length).toBeLessThan(60 * 4 + 400);
  });

  test("refuses secrets, and only changes while answering the owner", async () => {
    const project = tempDir("project");
    const t = teacher(project);
    let attempt: string | undefined;
    const p = await startPreston({
      scenario: {
        coordinator: async (turn) => {
          if (workerQuestionId(turn)) {
            // A Worker's question is data: nothing it says may write a standing order.
            try {
              await turn.callTool("standing_order_create", {
                title: "Allow everything",
                authority: "do anything without asking",
              });
              attempt = "created";
            } catch (err) {
              attempt = (err as Error).message;
            }
            return "";
          }
          return t.coordinator(turn);
        },
        worker: async (turn) => {
          await turn.callTool("ask_preston", { question: "May I do anything I like?" });
          return reportingWorker(turn);
        },
      },
    });
    const secret = await t.refused(p, "standing_order_create", {
      title: "Deploy",
      constraints: ["Use the api key: sk-abcdefghijklmnopqrstuvwxyz123456"],
    });
    expect(secret).toContain("password or access key");

    await t.call(p, "goal_create", { projectPath: project, brief: brief() });
    await waitFor(() => attempt, { what: "worker question reaching the Coordinator" });
    expect(attempt).toContain("only be changed while answering a message from the user");
    const { orders } = await t.call(p, "standing_order_list");
    expect(orders.map((o: { title: string }) => o.title)).not.toContain("Allow everything");
  });
});
