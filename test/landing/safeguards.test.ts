import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, initRepo, write } from "../support/git.js";
import {
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  reportingWorker,
  startPreston,
  waitFor,
} from "../support/harness.js";
import { worktreesIn } from "../support/landing.js";

const tracked = (repo: string, ref = "main") =>
  git(repo, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);

describe("what landing commits when the Worker leaves files behind", () => {
  test("leaves out installed and built folders in a project that does not ignore them, and says so", async () => {
    const repo = initRepo({ "README.md": "# project\n" });
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: async (turn) => {
          const dir = turn.input.workdir;
          write(dir, "src/app.js", "console.log(1)\n");
          write(dir, "node_modules/left-pad/index.js", "x\n");
          write(dir, "packages/web/node_modules/dep/index.js", "x\n");
          write(dir, "dist/app.min.js", "x\n");
          write(dir, "src/__pycache__/app.pyc", "x\n");
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(tracked(repo)).toEqual(["README.md", "src/app.js"]);
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain("Merged into main");
    expect(outcome).toContain("I left out");
    expect(outcome).toContain("node_modules/");
    expect(outcome).toContain("dist/");
  });

  test("keeps changes to generated folders the project itself already tracks", async () => {
    const repo = initRepo({ "README.md": "# project\n", "dist/bundle.js": "old\n" });
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: async (turn) => {
          write(turn.input.workdir, "dist/bundle.js", "new\n");
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(git(repo, "show", "main:dist/bundle.js")).toBe("new");
    expect(p.owner.texts("outcome")[0]).not.toContain("I left out");
  });

  test("respects the project's own ignore rules without mentioning them", async () => {
    const repo = initRepo({ ".gitignore": "node_modules/\n*.log\n" });
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: async (turn) => {
          write(turn.input.workdir, "node_modules/x/index.js", "x\n");
          write(turn.input.workdir, "debug.log", "x\n");
          write(turn.input.workdir, "feature.txt", "hello\n");
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(tracked(repo)).toEqual([".gitignore", "feature.txt"]);
    expect(p.owner.texts("outcome")[0]).not.toContain("I left out");
  });

  test("leaves out a large new binary file, names it, and keeps its folder", async () => {
    const repo = initRepo();
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: async (turn) => {
          const dir = turn.input.workdir;
          write(dir, "feature.txt", "hello\n");
          const big = Buffer.alloc(6 * 1024 * 1024, 1);
          big[10] = 0;
          writeFileSync(join(dir, "recording.bin"), big);
          // A big text file is the Worker's own work and is committed.
          write(dir, "data.csv", "a,b\n".repeat(1_500_000));
          return reportingWorker(turn);
        },
      },
    });

    p.owner.receive("go");
    const goal = await waitFor(finishedGoal(p.rt), { what: "goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    expect(tracked(repo)).toEqual(["README.md", "data.csv", "feature.txt"]);
    const [outcome] = p.owner.texts("outcome");
    expect(outcome).toContain("recording.bin (6 MB)");
    const [folder] = worktreesIn(p.home);
    expect(outcome).toContain(`still in ${folder}`);
    expect(existsSync(join(folder ?? "", "recording.bin"))).toBe(true);
  });
});
