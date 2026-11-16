import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ManualClock } from "../../src/clock.js";
import { addRemote, git, initRepo, write } from "../support/git.js";
import { FakeGitHub } from "../support/github.js";
import {
  brief,
  finishedGoal,
  type Preston,
  startPreston,
  TEST_CONFIG,
  tempDir,
  waitFor,
} from "../support/harness.js";
import { branches, worktreesIn, writingWorker } from "../support/landing.js";
import { teacher } from "../support/teach.js";

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const publishingRepo = () => initRepo({ "README.md": "# site\n", "vercel.json": "{}\n" });

/** Moves the clock on an hour at a time, letting the hourly tidy-up run its Git commands. */
async function advanceHours(clock: ManualClock, done: () => boolean, maxHours = 6) {
  for (let hour = 0; hour < maxHours && !done(); hour++) {
    await clock.advance(3_600_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Starts a Goal in `repo` and answers its publishing question with `answer`. */
async function heldGoal(repo: string, answer: "yes" | "no", config = TEST_CONFIG) {
  const t = teacher(repo);
  const p = await startPreston({
    config,
    scenario: { coordinator: t.coordinator, worker: writingWorker() },
  });
  const { goalId } = await t.call(p, "goal_create", { projectPath: repo, brief: brief() });
  await waitFor(() => p.owner.texts("question").length === 1, { what: "the question" });
  const status = await t.call(p, "status");
  await t.call(p, "answer_worker", { questionId: status.openQuestions[0].id, answer });
  await waitFor(() => p.rt.goal(goalId)?.endedAt, { what: "goal to finish" });
  return { p, t, goalId };
}

describe("goal_land: merging verified work that was held back", () => {
  test("after a no, lands the work without asking again when the user says to go ahead", async () => {
    const repo = publishingRepo();
    const { p, t, goalId } = await heldGoal(repo, "no");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
    expect(p.owner.texts("outcome")[0]).toContain("I didn't merge it, as you said");

    const landed = await t.call(p, "goal_land", { goalId, allowPublishing: true });
    await waitFor(() => p.owner.texts("outcome").length === 2, { what: "the second outcome" });

    expect(landed.note).toBe("Trying to merge it again.");
    expect(p.rt.goal(goalId)).toMatchObject({ state: "completed", outcome: "verified" });
    expect(read(repo, "feature.txt")).toBe("hello\n");
    expect(p.owner.texts("question")).toHaveLength(1);
    expect(p.owner.texts("outcome")[1]).toContain("Merged into main");
    expect(branches(repo)).toEqual(["main"]);
    expect(worktreesIn(p.home)).toEqual([]);
  });

  test("without allowPublishing it asks the question again, and a yes lands it", async () => {
    const repo = publishingRepo();
    const { p, t, goalId } = await heldGoal(repo, "no");

    await t.call(p, "goal_land", { goalId });
    await waitFor(() => p.owner.texts("question").length === 2, { what: "the second question" });
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
    const status = await t.call(p, "status");
    await t.call(p, "answer_worker", { questionId: status.openQuestions[0].id, answer: "yes" });
    await waitFor(() => p.owner.texts("outcome").length === 2, { what: "the second outcome" });

    expect(read(repo, "feature.txt")).toBe("hello\n");
  });

  test("is safe to repeat: a Goal already merged is not merged twice", async () => {
    const repo = publishingRepo();
    const { p, t, goalId } = await heldGoal(repo, "no");
    await t.call(p, "goal_land", { goalId, allowPublishing: true });
    await waitFor(() => p.owner.texts("outcome").length === 2, { what: "the second outcome" });
    const merged = git(repo, "rev-parse", "main");

    const again = await t.refused(p, "goal_land", { goalId, allowPublishing: true });

    expect(again).toContain("already merged");
    expect(git(repo, "rev-parse", "main")).toBe(merged);
    expect(p.owner.texts("outcome")).toHaveLength(2);
  });

  test("lands a Goal that was Blocked by the user's own edits once they are out of the way", async () => {
    const repo = initRepo({ "README.md": "# project\n", "notes.txt": "one\n" });
    write(repo, "notes.txt", "my edit\n");
    const t = teacher(repo);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: writingWorker("notes.txt", "worker\n") },
    });
    const { goalId } = await t.call(p, "goal_create", { projectPath: repo, brief: brief() });
    await waitFor(() => p.rt.goal(goalId)?.state === "blocked", { what: "goal to block" });
    expect(p.owner.texts("outcome")[0]).toContain("Your own unsaved edits");

    git(repo, "checkout", "--quiet", "--", "notes.txt");
    await t.call(p, "goal_land", { goalId });
    await waitFor(() => p.rt.goal(goalId)?.state === "completed", { what: "goal to land" });

    expect(read(repo, "notes.txt")).toBe("worker\n");
    expect(p.owner.texts("outcome")).toHaveLength(2);
    expect(branches(repo)).toEqual(["main"]);
  });

  test("tries again after the pull request's checks timed out, without opening a second one", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    github.checks_ = () => ({ state: "pending", failing: [] });
    const t = teacher(repo);
    const p = await startPreston({
      config: {
        ...TEST_CONFIG,
        landing: { ciPollIntervalMs: 20, ciStartGraceMs: 0, requireCiWaitMs: 100 },
      },
      landing: { github },
      scenario: { coordinator: t.coordinator, worker: writingWorker() },
    });
    const { goalId } = await t.call(p, "goal_create", { projectPath: repo, brief: brief() });
    await waitFor(() => p.rt.goal(goalId)?.state === "blocked", { what: "goal to block" });
    expect(github.count("mergePr")).toBe(0);

    github.checks_ = () => ({ state: "passing", failing: [] });
    await t.call(p, "goal_land", { goalId });
    await waitFor(() => p.rt.goal(goalId)?.state === "completed", { what: "goal to land" });

    expect(github.count("createPr")).toBe(1);
    expect(github.count("mergePr")).toBe(1);
    expect(git(origin, "show", "main:feature.txt")).toBe("hello");
  });

  test("never merges work Preston could not verify", async () => {
    const repo = initRepo();
    const t = teacher(repo);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: writingWorker() },
    });
    const { goalId } = await t.call(p, "goal_create", {
      projectPath: repo,
      brief: brief({ checks: [] }),
    });
    await waitFor(finishedGoal(p.rt), { what: "goal to finish" });
    expect(p.rt.goal(goalId)).toMatchObject({ state: "completed", outcome: "unverified" });

    const reason = await t.refused(p, "goal_land", { goalId });

    expect(reason).toContain("never verified");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
  });

  test("refuses work that was done in place, and Goals that do not exist", async () => {
    const plain = tempDir("plain");
    write(plain, "a.txt", "a\n");
    const t = teacher(plain);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: writingWorker() },
    });
    const { goalId } = await t.call(p, "goal_create", { projectPath: plain, brief: brief() });
    await waitFor(() => p.rt.goal(goalId)?.endedAt, { what: "goal to finish" });

    expect(await t.refused(p, "goal_land", { goalId })).toContain("directly in the project folder");
    expect(await t.refused(p, "goal_land", { goalId: "g-nope" })).toContain("no goal");
  });

  test("works after the working copy was removed to save space, restoring it from the branch", async () => {
    const repo = publishingRepo();
    const clock = new ManualClock();
    const t = teacher(repo);
    const p = await startPreston({
      clock,
      config: { ...TEST_CONFIG, landing: { worktreeRetentionMs: 2 * 3_600_000 } },
      scenario: { coordinator: t.coordinator, worker: writingWorker() },
    });
    const { goalId } = await t.call(p, "goal_create", { projectPath: repo, brief: brief() });
    await waitFor(() => p.owner.texts("question").length === 1, { what: "the question" });
    const status = await t.call(p, "status");
    await t.call(p, "answer_worker", { questionId: status.openQuestions[0].id, answer: "no" });
    await waitFor(() => p.rt.goal(goalId)?.endedAt, { what: "goal to finish" });
    expect(worktreesIn(p.home)).toHaveLength(1);

    await advanceHours(clock, () => worktreesIn(p.home).length === 0);
    expect(worktreesIn(p.home)).toEqual([]);
    expect(branches(repo).some((b) => b.startsWith("preston/"))).toBe(true);

    await t.call(p, "goal_land", { goalId, allowPublishing: true });
    await waitFor(() => p.owner.texts("outcome").length === 2, { what: "the second outcome" });

    expect(read(repo, "feature.txt")).toBe("hello\n");
    expect(branches(repo)).toEqual(["main"]);
  });
});

describe("a standing order lifts the publishing question", () => {
  const goalAndWait = async (p: Preston, t: ReturnType<typeof teacher>, repo: string) => {
    const { goalId } = await t.call(p, "goal_create", { projectPath: repo, brief: brief() });
    await waitFor(() => p.rt.goal(goalId)?.endedAt, { what: "goal to finish" });
  };

  test("merges without asking once the user teaches it, for that project only", async () => {
    const repo = publishingRepo();
    const other = publishingRepo();
    const t = teacher(repo);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: writingWorker() },
    });
    await t.call(p, "standing_order_create", {
      title: "Ship my site without asking",
      scope: `project:${repo}`,
      authority: "merge changes that also deploy the site",
      policy: { "landing.autoMergePublishing": true },
    });

    await goalAndWait(p, t, repo);

    expect(p.owner.texts("question")).toEqual([]);
    expect(read(repo, "feature.txt")).toBe("hello\n");

    // Another project is still asked.
    await t.call(p, "goal_create", { projectPath: other, brief: brief() });
    await waitFor(() => p.owner.texts("question").length === 1, { what: "the question" });
    expect(git(other, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
  });

  test("asks again once the standing order is switched off", async () => {
    const repo = publishingRepo();
    const t = teacher(repo);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: writingWorker() },
    });
    const order = await t.call(p, "standing_order_create", {
      title: "Ship it",
      authority: "merge changes that also deploy",
      policy: { "landing.autoMergePublishing": true },
    });
    await t.call(p, "standing_order_disable", { id: order.id, reason: "changed my mind" });

    await t.call(p, "goal_create", { projectPath: repo, brief: brief() });

    await waitFor(() => p.owner.texts("question").length === 1, { what: "the question" });
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
  });
});
