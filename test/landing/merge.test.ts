import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { addRemote, commitAll, git, initRepo, write } from "../support/git.js";
import { FakeGitHub } from "../support/github.js";
import {
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  reportingWorker,
  startPreston,
  waitFor,
} from "../support/harness.js";
import { answeringCoordinator, branches, worktreesIn, writingWorker } from "../support/landing.js";

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

describe("conflicts with newer changes to main", () => {
  /** The user lands a different change to shared.txt on main while the Worker is busy. */
  const conflictingWorker =
    (resolve: boolean) => async (turn: Parameters<typeof reportingWorker>[0]) => {
      const dir = turn.input.workdir;
      if (turn.turn === 1) {
        write(dir, "shared.txt", "worker version\n");
        write(turn.input.workdir, "feature.txt", "hello\n");
        return reportingWorker(turn);
      }
      if (resolve) {
        const sha = /git merge ([0-9a-f]{40})/.exec(turn.input.prompt)?.[1] as string;
        try {
          git(dir, "merge", "--no-edit", sha);
        } catch {
          // Expected: the merge stops with conflicts.
        }
        write(dir, "shared.txt", "both versions\n");
        git(dir, "add", "-A");
        git(dir, "commit", "--quiet", "--no-edit");
      }
      return reportingWorker(turn);
    };

  test("resumes the Worker once with the conflict, then lands the resolved work", async () => {
    const repo = initRepo({ "shared.txt": "base\n" });
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: async (turn) => {
          if (turn.turn === 1) {
            write(repo, "shared.txt", "user version\n");
            commitAll(repo, "User change");
          }
          return conflictingWorker(true)(turn);
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const turns = p.fake.calls.filter((c) => c.role === "worker");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.input.resumeSessionId).toBe(turns[0]?.sessionId);
    expect(turns[1]?.input.prompt).toContain("conflict in:\n- shared.txt");
    expect(read(repo, "shared.txt")).toBe("both versions\n");
    expect(read(repo, "feature.txt")).toBe("hello\n");
    expect(p.owner.texts("outcome")).toHaveLength(1);
  });

  test("is Blocked in plain words when the Worker cannot resolve it, leaving main as it was", async () => {
    const repo = initRepo({ "shared.txt": "base\n" });
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: async (turn) => {
          if (turn.turn === 1) {
            write(repo, "shared.txt", "user version\n");
            commitAll(repo, "User change");
          }
          return conflictingWorker(false)(turn);
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal.state).toBe("blocked");
    // Resumed once, not forever.
    expect(p.fake.calls.filter((c) => c.role === "worker")).toHaveLength(2);
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain("conflicts with newer changes to main in shared.txt");
    expect(outcome).toContain("Nothing of yours was changed");
    expect(read(repo, "shared.txt")).toBe("user version\n");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("User change");
    expect(git(repo, "status", "--porcelain")).toBe("");
    // The work is kept on its branch, in its worktree, for the user.
    expect(branches(repo).some((b) => b.startsWith("preston/"))).toBe(true);
    expect(worktreesIn(p.home)).toHaveLength(1);
  });

  test("resumes the Worker once when the combined work fails the checks", async () => {
    const repo = initRepo({ "version.txt": "1\n" });
    // Passes on the Worker's own work; fails once main has the other change.
    const check = {
      name: "no banned file",
      command: `node -e "process.exit(require('fs').existsSync('banned.txt') ? 1 : 0)"`,
    };
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief({ checks: [check] })),
        worker: async (turn) => {
          if (turn.turn === 1) {
            write(repo, "banned.txt", "x\n");
            commitAll(repo, "Someone adds a banned file");
          } else {
            git(turn.input.workdir, "rm", "--quiet", "banned.txt");
            git(turn.input.workdir, "commit", "--quiet", "-m", "Remove the banned file");
          }
          write(turn.input.workdir, "feature.txt", "hello\n");
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const turns = p.fake.calls.filter((c) => c.role === "worker");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.input.prompt).toContain("combined your work with the latest main");
    expect(turns[1]?.input.prompt).toContain("no banned file");
    expect(() => read(repo, "banned.txt")).toThrow();
  });
});

describe("merges that would publish something", () => {
  const publishingRepo = () => initRepo({ "README.md": "# site\n", "vercel.json": "{}\n" });

  test("asks first, parks the Goal, and merges after the user says yes", async () => {
    const repo = publishingRepo();
    const p = await startPreston({
      scenario: {
        coordinator: answeringCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.owner.texts("question").length === 1, { what: "the question" });
    await waitFor(() => p.rt.goals()[0]?.state === "waiting_for_user", { what: "goal to park" });

    const [question] = p.owner.texts("question");
    expect(question).toContain("will also publish something");
    expect(question).toContain("Vercel");
    expect(question).toContain("My recommendation");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
    expect(p.owner.texts("outcome")).toEqual([]);

    p.owner.receive("yes, go ahead");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(read(repo, "feature.txt")).toBe("hello\n");
    expect(p.owner.texts("question")).toHaveLength(1);
    expect(p.owner.texts("outcome")).toHaveLength(1);
  });

  test("leaves the finished work on its branch when the user says no", async () => {
    const repo = publishingRepo();
    const p = await startPreston({
      scenario: {
        coordinator: answeringCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.owner.texts("question").length === 1, { what: "the question" });
    p.owner.receive("no, hold off");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
    expect(p.owner.texts("outcome")[0]).toContain("I didn't merge it, as you said");
    const branch = branches(repo).find((b) => b.startsWith("preston/")) as string;
    expect(git(repo, "show", `${branch}:feature.txt`)).toBe("hello");
  });

  test("a restart while waiting for the answer asks nothing twice and still lands on yes", async () => {
    const repo = publishingRepo();
    const p = await startPreston({
      scenario: {
        coordinator: answeringCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });
    p.owner.receive("go");
    await waitFor(() => p.owner.texts("question").length === 1, { what: "the question" });
    await waitFor(() => p.rt.goals()[0]?.state === "waiting_for_user");

    const q = await p.restart();
    await waitFor(() => q.rt.goals()[0]?.state === "waiting_for_user");
    q.owner.receive("yes");
    const goal = await waitFor(finishedGoal(q.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(q.owner.texts("question")).toEqual([]);
    expect(read(repo, "feature.txt")).toBe("hello\n");
  });

  test("autoMergePublishing lifts the question", async () => {
    const repo = publishingRepo();
    const p = await startPreston({
      config: {
        agents: { enabled: ["fake"] },
        coordinator: { agent: "fake" },
        setup: { complete: true },
        outcomes: { coordinatorWaitMs: 0 },
        landing: { autoMergePublishing: true },
      },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(p.owner.texts("question")).toEqual([]);
    expect(read(repo, "feature.txt")).toBe("hello\n");
  });

  test("an ordinary code-only merge is not asked about", async () => {
    const repo = initRepo({ "src/index.js": "1\n", ".github/workflows/ci.yml": CI_WORKFLOW });
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(p.owner.texts("question")).toEqual([]);
    expect(p.owner.texts("ack")).toEqual([]);
    expect(p.owner.texts("outcome")).toHaveLength(1);
  });

  test("an automation that publishes when main changes is enough to ask", async () => {
    const repo = initRepo({ ".github/workflows/release.yml": PUBLISH_WORKFLOW });
    const p = await startPreston({
      scenario: {
        coordinator: answeringCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.owner.texts("question").length === 1, { what: "the question" });

    expect(p.owner.texts("question")[0]).toContain('"release.yml" publishes a package');
  });
});

describe("a hosted repository: pull request, checks, merge", () => {
  const config = (extra: Record<string, unknown> = {}) => ({
    agents: { enabled: ["fake" as const] },
    coordinator: { agent: "fake" as const },
    setup: { complete: true },
    outcomes: { coordinatorWaitMs: 0 },
    landing: {
      ciPollIntervalMs: 20,
      ciStartGraceMs: 0,
      requireCiWaitMs: 30_000,
      ...extra,
    },
  });

  test("pushes the branch, opens one pull request, waits for the checks, merges, and updates main", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    let polls = 0;
    github.checks_ = () => {
      polls += 1;
      return polls < 3 ? { state: "pending", failing: [] } : { state: "passing", failing: [] };
    };
    const p = await startPreston({
      config: config(),
      landing: { github },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(github.prs).toHaveLength(1);
    expect(github.count("createPr")).toBe(1);
    expect(github.count("mergePr")).toBe(1);
    expect(github.merges).toEqual(["merge"]);
    expect(polls).toBe(3);
    const pr = github.prs[0];
    expect(pr?.title).toBe("Make the greeting page say hello");
    expect(pr?.body).toContain("it works: passes");
    expect(pr?.body).toContain("The page says hello");
    // It really landed on the remote, and the user's own main caught up.
    expect(git(origin, "show", "main:feature.txt")).toBe("hello");
    expect(read(repo, "feature.txt")).toBe("hello\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(branches(origin)).toEqual(["main"]);
    expect(branches(repo)).toEqual(["main"]);
    expect(worktreesIn(p.home)).toEqual([]);
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain(`Merged on GitHub: ${pr?.url}`);
    expect(p.owner.texts("outcome")).toHaveLength(1);
  });

  test("a restart in the middle of landing resumes without a second pull request or merge", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    github.checks_ = () => ({ state: "pending", failing: [] });
    const p = await startPreston({
      config: config(),
      landing: { github },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    await waitFor(() => github.count("checks") >= 2, { what: "landing to wait for the checks" });
    expect(github.prs).toHaveLength(1);

    const q = await p.restart();
    await waitFor(() => github.count("checks") >= 4, { what: "landing to resume" });
    github.checks_ = () => ({ state: "passing", failing: [] });
    const goal = await waitFor(finishedGoal(q.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(github.count("createPr")).toBe(1);
    expect(github.prs).toHaveLength(1);
    expect(github.count("mergePr")).toBe(1);
    expect(git(origin, "show", "main:feature.txt")).toBe("hello");
    expect(q.owner.texts("outcome")).toHaveLength(1);
  });

  test("a pull request created just before a dropped connection is found, not duplicated", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    github.dropNextCreate = true;
    const p = await startPreston({
      config: config(),
      landing: { github },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(github.prs).toHaveLength(1);
    expect(github.count("mergePr")).toBe(1);
  });

  test("failing required checks go back to the Worker once, then the fix is pushed and merged", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    let fixed = false;
    github.checks_ = () =>
      fixed ? { state: "passing", failing: [] } : { state: "failing", failing: ["unit tests"] };
    const p = await startPreston({
      config: config(),
      landing: { github },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: async (turn) => {
          if (turn.turn > 1) fixed = true;
          write(turn.input.workdir, turn.turn === 1 ? "feature.txt" : "fix.txt", "x\n");
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const turns = p.fake.calls.filter((c) => c.role === "worker");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.input.prompt).toContain("- unit tests");
    expect(github.prs).toHaveLength(1);
    expect(git(origin, "show", "main:fix.txt")).toBe("x");
  });

  test("is Blocked, with the pull request link, when GitHub refuses the merge", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    github.mergeError = "Required approving review is missing";
    const p = await startPreston({
      config: config(),
      landing: { github },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal.state).toBe("blocked");
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain("wouldn't let me merge");
    expect(outcome).toContain(github.prs[0]?.url as string);
    expect(github.count("mergePr")).toBe(1);
  });

  test("gives up waiting for checks after the configured time and says where the pull request is", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    github.checks_ = () => ({ state: "pending", failing: [] });
    const p = await startPreston({
      config: config({ requireCiWaitMs: 100 }),
      landing: { github },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal.state).toBe("blocked");
    expect(p.owner.texts("outcome")[0]).toContain("checks were still running");
    expect(github.count("mergePr")).toBe(0);
  });

  test("stopping a Goal that is waiting for checks ends the wait and merges nothing", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    github.checks_ = () => ({ state: "pending", failing: [] });
    const p = await startPreston({
      config: config(),
      landing: { github },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });
    p.owner.receive("go");
    await waitFor(() => github.count("checks") >= 2, { what: "landing to wait for the checks" });

    p.owner.receive("stop");
    await waitFor(() => p.rt.goals()[0]?.state === "cancelled", { what: "goal to stop" });
    const seen = github.count("checks");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(github.count("checks")).toBeLessThanOrEqual(seen + 1);
    expect(github.count("mergePr")).toBe(0);
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
  });

  test("uses squash when the repository allows only that", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    github.allowed = { merge: false, squash: true, rebase: false };
    const p = await startPreston({
      config: config(),
      landing: { github },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(github.merges).toEqual(["squash"]);
  });

  test("asks before merging a pull request that would publish, with the link in the question", async () => {
    const repo = initRepo({ "netlify.toml": "[build]\n" });
    const origin = addRemote(repo);
    const github = new FakeGitHub(origin);
    const p = await startPreston({
      config: config(),
      landing: { github },
      scenario: {
        coordinator: answeringCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.owner.texts("question").length === 1, { what: "the question" });

    expect(p.owner.texts("question")[0]).toContain(github.prs[0]?.url as string);
    expect(github.count("mergePr")).toBe(0);
    p.owner.receive("yes");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });
    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(github.count("mergePr")).toBe(1);
    expect(github.count("createPr")).toBe(1);
  });

  test("merges locally and says so when GitHub's tool is not usable", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(read(repo, "feature.txt")).toBe("hello\n");
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain("Merged into main on your computer");
    expect(outcome).toContain("I didn't push it anywhere");
    // Nothing was sent to the remote.
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
    expect(branches(origin)).toEqual(["main"]);
  });

  test("merges locally when main has commits GitHub does not have yet", async () => {
    const repo = initRepo();
    const origin = addRemote(repo);
    write(repo, "unpushed.txt", "x\n");
    commitAll(repo, "Not pushed yet");
    const github = new FakeGitHub(origin);
    const p = await startPreston({
      config: config(),
      landing: { github },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(github.count("createPr")).toBe(0);
    expect(p.owner.texts("outcome")[0]).toContain("aren't on GitHub yet");
    expect(branches(origin)).toEqual(["main"]);
  });
});

const CI_WORKFLOW = `name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

const PUBLISH_WORKFLOW = `name: Release
on:
  push:
    branches: [main]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm publish
`;
