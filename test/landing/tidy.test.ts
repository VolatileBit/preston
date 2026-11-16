import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ManualClock } from "../../src/clock.js";
import type { FakeScript } from "../../src/workers/fake/index.js";
import { git, initRepo, write } from "../support/git.js";
import {
  brief,
  goalCreatingCoordinator,
  startPreston,
  TEST_CONFIG,
  waitFor,
} from "../support/harness.js";
import { branches, worktreesIn } from "../support/landing.js";

/** A Worker that leaves `file` unsaved in its folder and then never finishes. */
const stuckWorker =
  (file?: string): FakeScript =>
  async (turn) => {
    if (file) write(turn.input.workdir, file, "half done\n");
    return turn.stall();
  };

describe("working copies of Goals that ended without landing", () => {
  test("a stopped Goal that changed nothing leaves nothing behind once Preston looks", async () => {
    const repo = initRepo();
    const p = await startPreston({
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: stuckWorker(),
      },
    });
    p.owner.receive("go");
    await waitFor(() => worktreesIn(p.home).length === 1, { what: "the working copy" });
    p.owner.receive("stop");
    await waitFor(() => p.rt.goals()[0]?.state === "cancelled", { what: "goal to stop" });
    expect(worktreesIn(p.home)).toHaveLength(1);

    const q = await p.restart();

    await waitFor(() => worktreesIn(q.home).length === 0 && branches(repo).length === 1, {
      what: "the working copy and its branch to go",
    });
    expect(branches(repo)).toEqual(["main"]);
  });

  test("unsaved work is kept, then saved on its branch before the folder goes, and nothing else is touched", async () => {
    const repo = initRepo();
    git(repo, "branch", "preston/my-own-experiment");
    write(repo, "notes.txt", "my own edit\n");
    const clock = new ManualClock();
    const p = await startPreston({
      clock,
      config: { ...TEST_CONFIG, landing: { worktreeRetentionMs: 2 * 3_600_000 } },
      scenario: {
        coordinator: goalCreatingCoordinator(repo, brief()),
        worker: stuckWorker("wip.txt"),
      },
    });
    p.owner.receive("go");
    await waitFor(() => worktreesIn(p.home).some((d) => existsSync(join(d, "wip.txt"))), {
      what: "the unsaved work",
    });
    p.owner.receive("stop");
    await waitFor(() => p.rt.goals()[0]?.state === "cancelled", { what: "goal to stop" });
    const [folder] = worktreesIn(p.home);

    // Within the retention period the folder and its unsaved file stay.
    await clock.advance(3_600_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(existsSync(join(folder ?? "", "wip.txt"))).toBe(true);

    for (let hour = 0; hour < 4 && worktreesIn(p.home).length; hour++) {
      await clock.advance(3_600_000);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(worktreesIn(p.home)).toEqual([]);
    const branch = branches(repo).find((b) => /^preston\/g-/.test(b)) as string;
    expect(git(repo, "show", `${branch}:wip.txt`)).toBe("half done");
    // Only the Goal's own branch was involved: the user's branch and edits are as they were.
    expect(branches(repo)).toContain("preston/my-own-experiment");
    expect(git(repo, "status", "--porcelain")).toBe("?? notes.txt");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
  });
});
