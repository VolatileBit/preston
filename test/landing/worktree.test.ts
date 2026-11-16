import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { addRemote, commitAll, git, initRepo, write } from "../support/git.js";
import {
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  reportingWorker,
  startPreston,
  tempDir,
  waitFor,
} from "../support/harness.js";
import { branches, loggingCheck, worktreesIn, writingWorker } from "../support/landing.js";

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

describe("a Goal in a Git project works in its own worktree", () => {
  test("leaves the user's branch and uncommitted edits alone, and lands the work on main", async () => {
    const repo = initRepo({ "README.md": "# project\n", "notes.txt": "one\n" });
    git(repo, "checkout", "--quiet", "-b", "feature-x");
    write(repo, "notes.txt", "edited by the user\n");
    write(repo, "scratch.txt", "untracked\n");
    const before = git(repo, "status", "--porcelain");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker("feature.txt", "hello\n"),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const worker = p.fake.calls.find((c) => c.role === "worker");
    expect(worker?.input.workdir.startsWith(join(p.home, "worktrees"))).toBe(true);
    // The user's checkout is exactly as they left it.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature-x");
    expect(git(repo, "status", "--porcelain")).toBe(before);
    expect(read(repo, "notes.txt")).toBe("edited by the user\n");
    expect(existsSync(join(repo, "feature.txt"))).toBe(false);
    // The work is on main, committed, and the worktree and branch are gone.
    expect(git(repo, "show", "main:feature.txt")).toBe("hello");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toContain("Merge");
    expect(branches(repo).sort()).toEqual(["feature-x", "main"]);
    expect(worktreesIn(p.home)).toEqual([]);
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain("Done and verified");
    expect(outcome).toContain("Merged into main on your computer");
    expect(outcome).toContain("you're on feature-x");
  });

  test("merges main into the work and re-runs the checks on the result before landing", async () => {
    const repo = initRepo();
    const log = join(tempDir("log"), "checks.log");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(
          repo,
          brief({ checks: [loggingCheck(log, ["feature.txt", "other.txt"])] }),
        ),
        worker: async (turn) => {
          write(turn.input.workdir, "feature.txt", "hello\n");
          // Meanwhile the user (or another Goal) lands something else on main.
          write(repo, "other.txt", "other\n");
          commitAll(repo, "Another change");
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    // First on the Worker's own work, then on the work combined with the new main.
    expect(read(join(log, ".."), "checks.log").trim().split("\n")).toEqual([
      "true,false",
      "true,true",
    ]);
    // main was checked out and clean, so the folder itself was brought up to date.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(read(repo, "feature.txt")).toBe("hello\n");
    expect(read(repo, "other.txt")).toBe("other\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(p.owner.texts("outcome")[0]).toContain("your project folder is up to date");
  });

  test("brings a checked-out main up to date without touching unrelated uncommitted edits", async () => {
    const repo = initRepo({ "README.md": "# project\n", "notes.txt": "one\n" });
    write(repo, "notes.txt", "my edit\n");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(read(repo, "notes.txt")).toBe("my edit\n");
    expect(read(repo, "feature.txt")).toBe("hello\n");
    expect(git(repo, "status", "--porcelain")).toBe("M notes.txt");
    expect(p.owner.texts("outcome")[0]).toContain("your own unsaved edits were left alone");
  });

  test("is Blocked, changing nothing, when the user's own edits are in the way of the merge", async () => {
    const repo = initRepo({ "README.md": "# project\n", "notes.txt": "one\n" });
    write(repo, "notes.txt", "my edit\n");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker("notes.txt", "worker version\n"),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal.state).toBe("blocked");
    expect(read(repo, "notes.txt")).toBe("my edit\n");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
    expect(p.owner.texts("outcome")[0]).toContain("Your own unsaved edits");
    // The finished work is still saved on its branch.
    expect(branches(repo).some((b) => b.startsWith("preston/"))).toBe(true);
  });

  test("squashes into one commit when configured", async () => {
    const repo = initRepo();
    const p = await startPreston({
      config: {
        agents: { enabled: ["fake"] },
        coordinator: { agent: "fake" },
        setup: { complete: true },
        landing: { mergeMethod: "squash" },
      },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Make the greeting page say hello");
    expect(git(repo, "rev-list", "--parents", "-1", "main").split(" ")).toHaveLength(2);
  });

  test("a Project that is a folder inside a repository works at the same place in the worktree", async () => {
    const repo = initRepo({ "app/README.md": "# app\n", "other/x.txt": "x\n" });
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(join(repo, "app"), brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const worker = p.fake.calls.find((c) => c.role === "worker");
    expect(worker?.input.workdir.endsWith(join("", "app"))).toBe(true);
    expect(git(repo, "show", "main:app/feature.txt")).toBe("hello");
  });

  test("two Goals in one repository do not collide", async () => {
    const repo = initRepo();
    let n = 0;
    const p = await startPreston({
      scenario: {
        coordinator: async (turn) => {
          for (const name of ["one", "two"]) {
            await turn.callTool("goal_create", {
              projectPath: repo,
              brief: brief({ objective: `Add file ${name}` }),
            });
          }
          return "ok";
        },
        worker: async (turn) => {
          n += 1;
          write(turn.input.workdir, `file-${n}.txt`, "x\n");
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.rt.goals().length === 2 && p.rt.goals().every((g) => g.endedAt), {
      what: "both goals to finish",
    });

    expect(p.rt.goals().map((g) => [g.state, g.outcome])).toEqual([
      ["completed", "verified"],
      ["completed", "verified"],
    ]);
    const files = git(repo, "ls-tree", "-r", "--name-only", "main").split("\n").sort();
    expect(files).toEqual(["README.md", "file-1.txt", "file-2.txt"]);
  });
});

describe("work that could not be checked", () => {
  test("is not merged: it stays on its branch and the outcome says where", async () => {
    const repo = initRepo();
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief({ checks: [] })),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "unverified" });
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain("Done, but unverified");
    expect(outcome).toContain("I haven't merged it");
    const branch = branches(repo).find((b) => b.startsWith("preston/")) as string;
    expect(outcome).toContain(branch);
    expect(worktreesIn(p.home)).toHaveLength(1);
  });
});

describe("Projects that are not ordinary repositories", () => {
  test("a folder that is not a repository works in place", async () => {
    const folder = tempDir("homeserver");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(folder, brief()),
        worker: writingWorker("note.txt", "fixed\n"),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(p.fake.calls.find((c) => c.role === "worker")?.input.workdir).toBe(folder);
    expect(read(folder, "note.txt")).toBe("fixed\n");
    expect(worktreesIn(p.home)).toEqual([]);
    expect(p.owner.texts("outcome")[0]).not.toContain("Merged");
  });

  test("a repository with no commits is Blocked in plain words unless the Brief allows working in place", async () => {
    const repo = tempDir("fresh");
    git(repo, "init", "--quiet", "--initial-branch=main");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal.state).toBe("blocked");
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain("no saved commits yet");
    expect(outcome).toContain("I haven't changed anything");
    expect(p.fake.calls.filter((c) => c.role === "worker")).toHaveLength(0);
    expect(existsSync(join(repo, "feature.txt"))).toBe(false);
  });

  test("a repository with no commits is worked on in place when the Brief says so", async () => {
    const repo = tempDir("fresh");
    git(repo, "init", "--quiet", "--initial-branch=main");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief({ workspace: { allowInPlace: true } })),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(read(repo, "feature.txt")).toBe("hello\n");
    expect(p.owner.texts("outcome")[0]).toContain("worked directly in your project folder");
  });

  test("a detached HEAD does not stop the work, and is left detached", async () => {
    const repo = initRepo();
    git(repo, "checkout", "--quiet", "--detach");
    const head = git(repo, "rev-parse", "HEAD");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "show", "main:feature.txt")).toBe("hello");
    expect(p.owner.texts("outcome")[0]).toContain("you're not on a branch");
  });

  test("starting from the current branch needs a branch, and says so", async () => {
    const repo = initRepo();
    git(repo, "checkout", "--quiet", "--detach");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief({ workspace: { startFrom: "current" } })),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal.state).toBe("blocked");
    expect(p.owner.texts("outcome")[0]).toContain("past commit rather than on a branch");
  });

  test("starting from the current branch lands on that branch", async () => {
    const repo = initRepo();
    git(repo, "checkout", "--quiet", "-b", "develop");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief({ workspace: { startFrom: "current" } })),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(git(repo, "show", "develop:feature.txt")).toBe("hello");
    expect(() => git(repo, "show", "main:feature.txt")).toThrow();
  });

  test("a bare repository is Blocked, even when in-place work is allowed", async () => {
    const bare = tempDir("bare");
    git(bare, "init", "--quiet", "--bare", "--initial-branch=main");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(bare, brief({ workspace: { allowInPlace: true } })),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal.state).toBe("blocked");
    expect(p.owner.texts("outcome")[0]).toContain("bare Git repository");
  });

  test("a repository whose submodules cannot be set up is Blocked in plain words", async () => {
    const repo = initRepo();
    write(
      repo,
      ".gitmodules",
      '[submodule "lib"]\n\tpath = lib\n\turl = /nonexistent/preston-test-submodule\n',
    );
    git(
      repo,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${git(repo, "rev-parse", "HEAD")},lib`,
    );
    git(repo, "add", ".gitmodules");
    git(repo, "commit", "--quiet", "-m", "Add a submodule");
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal.state).toBe("blocked");
    expect(p.owner.texts("outcome")[0]).toContain("submodules");
    expect(worktreesIn(p.home)).toEqual([]);
    expect(branches(repo)).toEqual(["main"]);
  });
});

describe("recovery", () => {
  test("a restart reuses the Goal's worktree and what is already in it", async () => {
    const repo = initRepo();
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: async (turn) => {
          if (turn.turn === 1) {
            write(turn.input.workdir, "half-done.txt", "wip\n");
            return turn.stall();
          }
          write(turn.input.workdir, "feature.txt", "hello\n");
          return reportingWorker(turn);
        },
      },
    });
    p.owner.receive("go");
    await waitFor(() => worktreesIn(p.home).length === 1 && p.fake.calls.length >= 2, {
      what: "the Worker to start",
    });
    const [tree] = worktreesIn(p.home);

    const q = await p.restart();
    const goal = await waitFor(finishedGoal(q.rt), { what: "goal to finish after restart" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const workers = q.fake.calls.filter((c) => c.role === "worker");
    expect(workers[0]?.input.workdir).toBe(
      (p.fake.calls.filter((c) => c.role === "worker")[0] as { input: { workdir: string } }).input
        .workdir,
    );
    expect(workers[0]?.input.workdir.startsWith(tree as string)).toBe(true);
    // The unfinished file was carried into the merged work.
    expect(git(repo, "show", "main:half-done.txt")).toBe("wip");
    expect(git(repo, "show", "main:feature.txt")).toBe("hello");
  });

  test("a worktree folder that went missing is restored from the Goal's branch", async () => {
    const repo = initRepo();
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: async (turn) => {
          if (turn.turn === 1) {
            write(turn.input.workdir, "half-done.txt", "wip\n");
            git(turn.input.workdir, "add", "-A");
            git(turn.input.workdir, "commit", "--quiet", "-m", "wip");
            return turn.stall();
          }
          write(turn.input.workdir, "feature.txt", "hello\n");
          return reportingWorker(turn);
        },
      },
    });
    p.owner.receive("go");
    await waitFor(() => p.fake.calls.length >= 2, { what: "the Worker to start" });
    const [tree] = worktreesIn(p.home);
    await p.stop();
    rmSync(tree as string, { recursive: true, force: true });

    const q = await p.restart();
    const goal = await waitFor(finishedGoal(q.rt), { what: "goal to finish after restart" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(git(repo, "show", "main:half-done.txt")).toBe("wip");
  });
});

describe("Projects", () => {
  test("goal_create makes a Project, identified by its canonical path, and project_list shows it", async () => {
    const repo = initRepo();
    git(repo, "checkout", "--quiet", "-b", "wip");
    write(repo, "dirty.txt", "x\n");
    addRemote(repo);
    let listed = "";
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief(), async (turn) => {
          listed = await turn.callTool("project_list");
          return "ok";
        }),
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "goal to finish" });
    p.owner.receive("what projects do you have?");
    await waitFor(() => listed !== "", { what: "project_list" });

    const { projects } = JSON.parse(listed) as {
      projects: {
        path: string;
        kind: string;
        totalGoals: number;
        repository: {
          mainBranch: string;
          checkedOutBranch: string;
          uncommittedEdits: boolean;
          remote: { host: string };
        };
      }[];
    };
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ path: repo, kind: "git", totalGoals: 1 });
    expect(projects[0]?.repository).toMatchObject({
      mainBranch: "main",
      checkedOutBranch: "wip",
      uncommittedEdits: true,
    });
  });

  test("another spelling of the same folder is the same Project", async () => {
    if (process.platform === "win32") return;
    const repo = initRepo();
    const link = join(tempDir("links"), "alias");
    (await import("node:fs")).symlinkSync(repo, link);
    const p = await startPreston({
      scenario: {
        coordinator: async (turn) => {
          for (const [i, path] of [repo, link].entries()) {
            await turn.callTool("goal_create", {
              projectPath: path,
              brief: brief({ objective: `Add file ${i}` }),
            });
          }
          return "ok";
        },
        worker: writingWorker(),
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.rt.goals().length === 2, { what: "both goals" });

    expect(new Set(p.rt.goals().map((g) => g.projectId)).size).toBe(1);
    expect(p.rt.goals().map((g) => g.projectPath)).toEqual([repo, repo]);
  });
});
