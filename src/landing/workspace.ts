import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "../clock.js";
import { isoNow } from "../clock.js";
import type { Goal } from "../goals/store.js";
import type { Logger } from "../log.js";
import { type Git, gitProblem } from "./git.js";
import type { PrepareResult } from "./hooks.js";
import { canonicalPath, isInside, projectSlug, slugify } from "./paths.js";
import { inspectProject, type ProjectInfo } from "./project.js";
import { stageWork } from "./stage.js";
import type { LandingStore, Workspace } from "./store.js";

/** Windows rejects paths past 260 characters; leave room for files inside the worktree. */
const MAX_WINDOWS_PATH = 200;

export interface WorkspaceDeps {
  git: Git;
  store: LandingStore;
  log: Logger;
  clock: Clock;
  worktreesDir: string;
  /** Remember what was seen about the Project. */
  saveProject(goal: Goal, info: ProjectInfo): void;
}

/** Why a separate working copy could not be made, in plain words, and what can be done. */
interface Problem {
  /** Plain-language reason the work has to be in place or cannot start. */
  because: string;
  /** In-place work would make no sense at all (a bare repository). */
  noFallback?: boolean;
}

/**
 * Gives each coding Goal its own Git worktree and branch, reuses it after a restart, and falls
 * back to working in place only when the Brief allows. Never touches the user's own checkout.
 */
export class Workspaces {
  private chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: WorkspaceDeps) {}

  prepare(goal: Goal): PrepareResult | Promise<PrepareResult> {
    const existing = this.deps.store.workspace(goal.id);
    if (existing?.mode === "in_place") return this.inPlace(goal, existing.workdir, existing.reason);
    if (existing) return this.reuse(goal, existing);
    // Most folders are not repositories: decide that without starting a process, so a turn for
    // them starts as promptly as it always did.
    if (!mayBeRepository(goal.projectPath)) return this.inPlace(goal, goal.projectPath, null);
    return this.prepareRepository(goal);
  }

  private async prepareRepository(goal: Goal): Promise<PrepareResult> {
    const info = await inspectProject(this.deps.git, goal.projectPath, isoNow(this.deps.clock));
    this.deps.saveProject(goal, info);
    const repo = info.repo;
    if (info.kind === "folder" || !repo) {
      return this.inPlace(goal, goal.projectPath, null);
    }
    // One worktree is created at a time per repository: git locks its own metadata.
    return this.serialised(repo.root, () => this.create(goal, info));
  }

  private async create(goal: Goal, info: ProjectInfo): Promise<PrepareResult> {
    const { git, store } = this.deps;
    const repo = info.repo;
    if (!repo) return this.inPlace(goal, goal.projectPath, null);
    // A concurrent preparation may have finished while this one waited.
    const raced = store.workspace(goal.id);
    if (raced) return this.reuse(goal, raced);

    const problem = await this.check(goal, info);
    if (problem) return this.fallback(goal, problem);

    const startFrom = goal.brief.workspace?.startFrom ?? "default";
    const baseBranch = (startFrom === "current" ? repo.currentBranch : repo.defaultBranch) ?? "";
    const baseSha = (await git.rev(repo.root, `refs/heads/${baseBranch}`)) ?? "";
    const branch = `preston/${goal.id}${slugify(goal.brief.objective, 28) ? `-${slugify(goal.brief.objective, 28)}` : ""}`;
    const path = join(this.deps.worktreesDir, projectSlug(repo.root), goal.id);
    mkdirSync(join(this.deps.worktreesDir, projectSlug(repo.root)), { recursive: true });

    const added = await git.run(repo.root, [
      "-c",
      "core.longpaths=true",
      "worktree",
      "add",
      "-b",
      branch,
      path,
      baseSha,
    ]);
    if (added.code !== 0) {
      this.deps.log.warn("worktree creation failed", {
        goalId: goal.id,
        problem: gitProblem(added),
      });
      return this.fallback(goal, {
        because: `Git would not create a separate working copy (${gitProblem(added) || "no reason given"})`,
      });
    }
    if (repo.hasSubmodules) {
      const submodules = await git.run(path, ["submodule", "update", "--init", "--recursive"], {
        timeoutMs: 600_000,
      });
      if (submodules.code !== 0) {
        await this.discard(repo.root, path, branch);
        return this.fallback(goal, {
          because:
            "the project uses Git submodules, and I couldn't set them up in a separate working copy",
        });
      }
    }
    const workspace: Workspace = {
      goalId: goal.id,
      mode: "worktree",
      repoRoot: repo.root,
      worktreePath: canonicalPath(path),
      workdir: repo.prefix
        ? join(canonicalPath(path), ...repo.prefix.split("/"))
        : canonicalPath(path),
      branch,
      baseBranch,
      baseSha,
      reason: null,
      state: "active",
    };
    store.saveWorkspace(workspace);
    this.deps.log.info("worktree created", { goalId: goal.id, path, branch, base: baseBranch });
    return this.ready(workspace);
  }

  /** Things that stop a separate working copy from being made, before trying. */
  private async check(goal: Goal, info: ProjectInfo): Promise<Problem | undefined> {
    const repo = info.repo;
    if (!repo) return undefined;
    if (repo.bare) {
      return {
        because:
          "this folder is a bare Git repository (it holds history only, with no files to work on). Point me at a normal checkout of it instead",
        noFallback: true,
      };
    }
    if (repo.unborn) {
      return {
        because:
          "this Git project has no saved commits yet, so there is nothing for a separate working copy to start from",
      };
    }
    const startFrom = goal.brief.workspace?.startFrom ?? "default";
    if (startFrom === "current") {
      if (!repo.currentBranch) {
        return {
          because:
            "the project is sitting on a past commit rather than on a branch, so I can't tell which branch to build on",
        };
      }
    } else if (!repo.defaultBranch) {
      return {
        because:
          "I can't tell which branch is the project's main one (it has no main or master branch)",
      };
    }
    if (process.platform === "win32") {
      const length = join(this.deps.worktreesDir, projectSlug(repo.root), goal.id).length;
      if (length > MAX_WINDOWS_PATH) {
        return {
          because:
            "Preston's data folder path is too long for Windows to hold a separate working copy",
        };
      }
    }
    return undefined;
  }

  /** Works in place if the Brief allows it, otherwise explains why the Goal cannot start. */
  private fallback(goal: Goal, problem: Problem): PrepareResult {
    if (!problem.noFallback && goal.brief.workspace?.allowInPlace) {
      this.deps.log.info("working in place", { goalId: goal.id, because: problem.because });
      return this.inPlace(goal, goal.projectPath, problem.because);
    }
    const options = problem.noFallback
      ? ""
      : " If you're happy for me to change files in your project folder directly instead, tell me and I'll start again that way.";
    return {
      ok: false,
      reason: `I can't make a separate working copy of this project because ${problem.because}. I haven't changed anything.${options}`,
    };
  }

  private inPlace(goal: Goal, workdir: string, reason: string | null): PrepareResult {
    this.deps.store.saveWorkspace({
      goalId: goal.id,
      mode: "in_place",
      repoRoot: null,
      worktreePath: null,
      workdir,
      branch: null,
      baseBranch: null,
      baseSha: null,
      reason,
    });
    return {
      ok: true,
      workdir,
      ...(reason
        ? {
            guidance:
              "This Goal works directly in the user's own project folder, so keep to the Brief's scope and do not discard or overwrite changes you did not make.",
          }
        : {}),
    };
  }

  /** The Worker's guidance for a worktree. */
  private ready(w: Workspace): PrepareResult {
    return {
      ok: true,
      workdir: w.workdir,
      guidance: `Your working folder is a dedicated Git worktree on branch ${w.branch}, separate from the user's own checkout, so work freely here. Stay on this branch and do not switch branches, push, or touch other worktrees. You do not need to commit: Preston commits your work, checks it again, and merges it itself.`,
    };
  }

  /** Reuses an existing working copy after a restart, re-attaching it if it went missing. */
  private async reuse(goal: Goal, w: Workspace): Promise<PrepareResult> {
    if (w.mode === "in_place") return this.inPlace(goal, w.workdir, w.reason);
    const { git, store } = this.deps;
    const path = w.worktreePath ?? "";
    const root = w.repoRoot ?? "";
    const branch = w.branch ?? "";
    if (!existsSync(path)) {
      await git.run(root, ["worktree", "prune"]);
      const attach = (await git.branchExists(root, branch))
        ? await git.run(root, ["-c", "core.longpaths=true", "worktree", "add", path, branch])
        : await git.run(root, [
            "-c",
            "core.longpaths=true",
            "worktree",
            "add",
            "-b",
            branch,
            path,
            w.baseSha ?? "HEAD",
          ]);
      if (attach.code !== 0) {
        return {
          ok: false,
          reason: `I couldn't restore the separate working copy for this Goal (${gitProblem(attach)}). Its work is safe on branch ${branch}.`,
        };
      }
      store.setWorkspaceState(goal.id, "active");
      this.deps.log.info("worktree restored", { goalId: goal.id, path });
    } else if ((await git.currentBranch(path)) !== branch) {
      const switched = await git.run(path, ["checkout", branch]);
      if (switched.code !== 0) {
        return {
          ok: false,
          reason: `The working copy for this Goal is not on its branch any more and I couldn't put it back (${gitProblem(switched)}). Its work is on branch ${branch}.`,
        };
      }
    }
    return this.ready(w);
  }

  /**
   * Tidies the working copy of a Goal that has ended, never losing work. Nothing to lose (no
   * unsaved changes, every commit already on the main branch): folder and branch are removed.
   * Otherwise it is left alone until `retentionMs` after the Goal ended; then unsaved changes
   * are saved as a commit on the Goal's branch, the folder is removed and the branch is kept.
   * Only Preston's own branches and folders are ever touched.
   */
  async tidyEnded(
    w: Workspace,
    input: { endedAt: string | null; retentionMs: number },
  ): Promise<"removed" | "archived" | "kept"> {
    const { git, log } = this.deps;
    const { repoRoot: root, worktreePath: path, branch, baseBranch: base } = w;
    if (w.mode !== "worktree" || w.state !== "active" || !root || !path || !branch || !base) {
      return "kept";
    }
    if (!branch.startsWith("preston/") || !isInside(this.deps.worktreesDir, path)) return "kept";
    const unmerged = async () =>
      (await git.branchExists(root, branch))
        ? Number(
            (await git.out(root, [
              "rev-list",
              "--count",
              `refs/heads/${base}..refs/heads/${branch}`,
            ])) ?? 1,
          )
        : 0;
    const folder = existsSync(path);
    const dirty = folder && (await git.dirty(path));
    if (!dirty && (await unmerged()) === 0) {
      await this.cleanup(w, { deleteBranch: true });
      return "removed";
    }
    const expired =
      input.endedAt !== null &&
      this.deps.clock.now() - Date.parse(input.endedAt) >= input.retentionMs;
    if (!expired) return "kept";
    if (dirty && !(await this.snapshot(path))) {
      log.warn("could not save a finished Goal's unsaved work, so its folder stays", {
        goalId: w.goalId,
      });
      return "kept";
    }
    const keep = (await unmerged()) > 0;
    await this.cleanup(w, { deleteBranch: !keep });
    return keep ? "archived" : "removed";
  }

  /** Saves unsaved changes as a commit on the worktree's branch (hooks are not run). */
  private async snapshot(path: string): Promise<boolean> {
    const { git } = this.deps;
    const staged = await stageWork(git, path);
    if (staged.problem) return false;
    if (await git.ok(path, ["diff", "--cached", "--quiet"])) return true;
    const committed = await git.run(path, [
      ...(await git.identityArgs(path)),
      "commit",
      "--no-verify",
      "-m",
      "Unfinished work saved by Preston",
    ]);
    return committed.code === 0;
  }

  /**
   * Removes a Goal's worktree folder. With `deleteBranch` the branch goes too (the caller has
   * landed everything); without, the branch stays and the working copy is recorded as archived.
   */
  async cleanup(w: Workspace, options: { deleteBranch: boolean }): Promise<void> {
    if (w.mode !== "worktree" || !w.repoRoot || !w.worktreePath || !w.branch) return;
    const { git, store, log } = this.deps;
    await this.serialised(w.repoRoot, async () => {
      if (existsSync(w.worktreePath ?? "")) {
        const removed = await git.run(w.repoRoot ?? "", [
          "worktree",
          "remove",
          "--force",
          w.worktreePath ?? "",
        ]);
        if (removed.code !== 0) {
          log.warn("could not remove worktree", {
            path: w.worktreePath,
            problem: gitProblem(removed),
          });
          return;
        }
      }
      await git.run(w.repoRoot ?? "", ["worktree", "prune"]);
      if (options.deleteBranch) {
        const deleted = await git.run(w.repoRoot ?? "", ["branch", "-D", w.branch ?? ""]);
        if (deleted.code !== 0) {
          log.warn("could not delete branch", { branch: w.branch, problem: gitProblem(deleted) });
        }
      }
      store.setWorkspaceState(w.goalId, options.deleteBranch ? "removed" : "archived");
    });
  }

  private async discard(root: string, path: string, branch: string): Promise<void> {
    await this.deps.git.run(root, ["worktree", "remove", "--force", path]);
    await this.deps.git.run(root, ["branch", "-D", branch]);
  }

  /** Runs `fn` after everything queued before it for the same repository. */
  serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

/** A cheap look for a `.git` entry here or in a parent folder (or a bare repository's files). */
function mayBeRepository(path: string): boolean {
  if (existsSync(join(path, "HEAD")) && existsSync(join(path, "objects"))) return true;
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}
