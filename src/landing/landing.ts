import { join } from "node:path";
import { type Clock, isoNow, sleep } from "../clock.js";
import type { ConfigManager } from "../config/config.js";
import type { Config } from "../config/schema.js";
import { runCheck } from "../goals/checks.js";
import { failedChecksEvidence } from "../goals/messages.js";
import type { Goal, GoalStore, Run } from "../goals/store.js";
import { errorMessage, type Logger } from "../log.js";
import type { Questions } from "../questions/questions.js";
import { type Db, recordEvent, transaction } from "../store/db.js";
import { defaultExec, type Exec } from "./exec.js";
import { Git, gitProblem } from "./git.js";
import { chooseMergeMethod, type GitHubClient, type PullRequest } from "./github.js";
import type { LandingHooks, LandResult, PrepareResult } from "./hooks.js";
import {
  ciFailedPrompt,
  commitFailedPrompt,
  commitMessage,
  conflictPrompt,
  failedAfterMergePrompt,
  heldMessage,
  inPlaceNote,
  landedLocally,
  landedOnGitHub,
  mergeCommitMessage,
  nothingToLand,
  parseYesNo,
  publishQuestion,
  pullRequestBody,
  unlandedNote,
} from "./messages.js";
import { samePath } from "./paths.js";
import { findRemote, inspectProject, type ProjectInfo } from "./project.js";
import {
  detectPublishing,
  expectsPullRequestChecks,
  isInterestingPath,
  type PublishingVerdict,
  type RepoSnapshot,
} from "./publishing.js";
import { LandingStore, type Workspace } from "./store.js";
import { Workspaces } from "./workspace.js";

export interface LandingDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  config: ConfigManager;
  goals: GoalStore;
  questions: Questions;
  /** `<home>/worktrees`. */
  worktreesDir: string;
  github: GitHubClient;
  exec?: Exec;
}

/** A Goal's worktree, with the fields landing relies on. */
type Tree = Workspace & {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
};

interface Ctx {
  goal: Goal;
  run: Run;
  ws: Tree;
  signal: AbortSignal;
  cfg: Config["landing"];
}

type Integrated = { result: LandResult } | { baseTip: string; head: string };

/** Attempts at the whole sequence when git or GitHub fails; every step is safe to repeat. */
const MAX_ATTEMPTS = 3;
/** Times the work is combined with a main branch that kept moving. */
const MAX_PASSES = 3;

/**
 * Lands a verified Goal's work: commits what the Worker left, combines it with the latest main
 * branch and re-runs the Brief's checks on the result, then merges. With a GitHub remote that
 * is a pull request merged after the required checks pass; otherwise a local merge that leaves
 * the user's own checkout and uncommitted edits alone. Every step looks at what already exists
 * before acting and is recorded, so a crash anywhere resumes without a second push, pull
 * request or merge. It never force-pushes and never rewrites the user's history.
 */
export class Landing implements LandingHooks {
  readonly store: LandingStore;
  readonly git: Git;
  readonly workspaces: Workspaces;
  private aborts = new Map<string, AbortController>();

  constructor(private readonly deps: LandingDeps) {
    this.store = new LandingStore(deps.db, deps.clock);
    this.git = new Git(deps.exec ?? defaultExec);
    this.workspaces = new Workspaces({
      git: this.git,
      store: this.store,
      log: deps.log,
      clock: deps.clock,
      worktreesDir: deps.worktreesDir,
      saveProject: (goal, info) => this.store.saveProjectInfo(goal.projectId, info),
    });
  }

  // ---- Hooks for the Goal engine -----------------------------------------------------------

  prepare(goal: Goal, run: Run): PrepareResult | Promise<PrepareResult> {
    return this.workspaces.prepare(goal, run);
  }

  usesWorktree(goalId: string): boolean {
    const ws = this.store.workspace(goalId);
    return ws?.mode === "worktree" && ws.state === "active";
  }

  isLanding(goalId: string): boolean {
    const rec = this.store.landing(goalId);
    return rec !== undefined && rec.state !== "awaiting_worker";
  }

  questionGoal(questionId: string): string | undefined {
    return this.store.landingByQuestion(questionId)?.goalId;
  }

  outcomeNote(goal: Goal): string | undefined {
    const ws = this.store.workspace(goal.id);
    if (!ws) return undefined;
    if (ws.mode === "in_place") return ws.reason ? inPlaceNote(ws.reason) : undefined;
    if (ws.state === "active" && ws.branch) return unlandedNote(ws.branch, ws.worktreePath);
    return undefined;
  }

  abort(goalId?: string): void {
    if (goalId) this.aborts.get(goalId)?.abort();
    else for (const controller of this.aborts.values()) controller.abort();
  }

  async land(goal: Goal, run: Run): Promise<LandResult> {
    const ws = this.store.workspace(goal.id);
    if (ws?.mode !== "worktree" || !isTree(ws)) {
      return { kind: "landed", message: "" };
    }
    // Everything up to the first await is synchronous: the engine calls this inside the
    // transaction that records the verification, so a restart never sees one without the other.
    const record = this.store.ensureLanding(goal.id);
    if (record.result) return record.result;
    const controller = new AbortController();
    this.aborts.set(goal.id, controller);
    this.store.updateLanding(goal.id, { state: "active" });
    recordEvent(this.deps.db, this.deps.clock, "landing_started", {
      goalId: goal.id,
      runId: run.id,
    });
    const ctx: Ctx = {
      goal,
      run,
      ws,
      signal: controller.signal,
      cfg: this.deps.config.get().landing,
    };
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return this.settle(goal.id, await this.execute(ctx));
        } catch (err) {
          if (controller.signal.aborted) return { kind: "aborted" };
          this.deps.log.warn("landing step failed", { goalId: goal.id, attempt, error: err });
          if (attempt >= MAX_ATTEMPTS) {
            return this.settle(goal.id, {
              kind: "blocked",
              reason: this.stuck(ctx, errorMessage(err)),
            });
          }
          await sleep(this.deps.clock, ctx.cfg.ciPollIntervalMs, controller.signal);
        }
      }
    } catch {
      return { kind: "aborted" };
    } finally {
      this.aborts.delete(goal.id);
    }
  }

  /** Records where a landing stands, so a restart resumes rather than repeats. */
  private settle(goalId: string, result: LandResult): LandResult {
    switch (result.kind) {
      case "landed":
      case "held":
      case "blocked":
        this.store.updateLanding(goalId, { state: "done", result });
        break;
      case "needs_worker":
        this.store.updateLanding(goalId, { state: "awaiting_worker" });
        break;
      case "waiting_for_user":
        this.store.updateLanding(goalId, { state: "awaiting_user" });
        break;
      case "aborted":
        break;
    }
    return result;
  }

  // ---- The landing sequence ----------------------------------------------------------------

  private async execute(ctx: Ctx): Promise<LandResult> {
    const problem = await this.commitPending(ctx);
    if (problem) {
      return this.needsWorker(
        ctx,
        commitFailedPrompt(problem),
        `Git would not save the changes (${problem})`,
      );
    }
    const mode = await this.decideMode(ctx);
    return mode === "pr" ? this.landViaPullRequest(ctx) : this.landLocally(ctx);
  }

  /** Saves whatever the Worker left uncommitted on the Goal's branch. */
  private async commitPending(ctx: Ctx): Promise<string | undefined> {
    const { git } = this;
    const path = ctx.ws.worktreePath;
    if (!(await git.dirty(path))) return undefined;
    const added = await git.run(path, ["add", "-A"]);
    if (added.code !== 0) return gitProblem(added);
    // Exit 0 means nothing is staged (only ignored files changed).
    if (await git.ok(path, ["diff", "--cached", "--quiet"])) return undefined;
    const identity = await git.identityArgs(path);
    const committed = await git.run(path, [
      ...identity,
      "commit",
      "-m",
      commitMessage(ctx.goal.brief),
    ]);
    return committed.code === 0 ? undefined : gitProblem(committed);
  }

  /** Pull request when the repository has a usable GitHub remote, otherwise a local merge. */
  private async decideMode(ctx: Ctx): Promise<"pr" | "local"> {
    const record = this.store.landing(ctx.goal.id);
    if (record?.mode) return record.mode;
    const { git } = this;
    const root = ctx.ws.repoRoot;
    const decide = (mode: "pr" | "local", note: string | null) => {
      this.store.updateLanding(ctx.goal.id, { mode, modeNote: note });
      return mode;
    };
    const remote = await findRemote(git, root);
    if (!remote) return decide("local", null);
    const host = await this.deps.github.repo(ctx.ws.worktreePath);
    if (!host.ok) return decide("local", `I didn't push it anywhere: ${host.reason}`);
    const base = ctx.ws.baseBranch;
    const fetched = await git.run(root, ["fetch", remote.name, base], { timeoutMs: 300_000 });
    if (fetched.code !== 0) {
      return decide("local", "I couldn't reach GitHub, so I didn't push anything.");
    }
    const remoteTip = await git.rev(root, `refs/remotes/${remote.name}/${base}`);
    if (!remoteTip) {
      return decide("local", `GitHub doesn't have a ${base} branch, so I didn't push anything.`);
    }
    if (!(await git.isAncestor(root, ctx.ws.baseSha, remoteTip))) {
      return decide(
        "local",
        `Your ${base} has changes that aren't on GitHub yet, so I didn't push anything.`,
      );
    }
    return decide("pr", null);
  }

  // ---- Local merge -------------------------------------------------------------------------

  private async landLocally(ctx: Ctx): Promise<LandResult> {
    const { git } = this;
    const { repoRoot: root, baseBranch: base } = ctx.ws;
    const baseRef = `refs/heads/${base}`;
    const record = this.require(ctx);
    if (record.candidateSha && (await git.isAncestor(root, record.candidateSha, baseRef))) {
      return this.landedLocal(ctx, "untouched", record.modeNote);
    }
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const integrated = await this.integrate(ctx, baseRef, base);
      if ("result" in integrated) return integrated.result;
      const gate = await this.gate(ctx, base, integrated, null);
      if (gate) return gate;
      const advanced = await this.advanceLocal(ctx, integrated);
      if (advanced) return advanced;
    }
    return { kind: "blocked", reason: this.stuck(ctx, `${base} kept changing while I merged`) };
  }

  /**
   * Moves the main branch to a merge commit of the verified work. It never resets or checks out
   * anything in the user's folder: a checkout of the branch is fast-forwarded (git refuses if
   * that would overwrite the user's edits), and a branch nobody has checked out is only moved.
   * Returns undefined when the branch moved meanwhile and the work has to be combined again.
   */
  private async advanceLocal(
    ctx: Ctx,
    integrated: { baseTip: string; head: string },
  ): Promise<LandResult | undefined> {
    const { git } = this;
    const { repoRoot: root, baseBranch: base, worktreePath: path } = ctx.ws;
    const tree = await git.out(path, ["rev-parse", `${integrated.head}^{tree}`]);
    if (!tree) throw new Error("Could not read the finished work from Git.");
    const squash = ctx.cfg.mergeMethod === "squash";
    const identity = await git.identityArgs(path);
    const message = squash
      ? commitMessage(ctx.goal.brief)
      : mergeCommitMessage(ctx.goal.brief, ctx.ws.branch);
    const created = await git.run(path, [
      ...identity,
      "commit-tree",
      tree,
      "-p",
      integrated.baseTip,
      ...(squash ? [] : ["-p", integrated.head]),
      "-m",
      message,
    ]);
    const candidate = created.stdout.trim();
    if (created.code !== 0 || !candidate) throw new Error(gitProblem(created));
    // Recorded before the branch moves: after a crash it shows whether it did.
    this.store.updateLanding(ctx.goal.id, { candidateSha: candidate });
    this.store.recordOp(ctx.goal.id, `advance:${integrated.baseTip}:${candidate}`);

    const checkout = (await git.worktrees(root)).find(
      (w) => w.branch === base && !samePath(w.path, path),
    );
    if (checkout) {
      const dirty = await git.dirty(checkout.path);
      const result = await git.run(checkout.path, ["merge", "--ff-only", candidate]);
      if (result.code !== 0) {
        if (/overwritten|local changes|untracked working tree/i.test(result.stderr)) {
          return {
            kind: "blocked",
            reason: `Your own unsaved edits in ${checkout.path} are in the way of merging into ${base}, so I left everything as it was. The finished work is saved on branch ${ctx.ws.branch}. Once your edits are saved or set aside, ask me for a follow-up Goal to merge it.`,
          };
        }
        if (/fast-forward/i.test(result.stderr)) return undefined;
        throw new Error(gitProblem(result));
      }
      return this.landedLocal(ctx, dirty ? "updated_dirty" : "updated", this.require(ctx).modeNote);
    }
    const moved = await git.run(root, [
      "update-ref",
      "-m",
      `preston: merge ${ctx.ws.branch}`,
      `refs/heads/${base}`,
      candidate,
      integrated.baseTip,
    ]);
    if (moved.code !== 0) return undefined;
    return this.landedLocal(ctx, "untouched", this.require(ctx).modeNote);
  }

  private async landedLocal(
    ctx: Ctx,
    checkout: "updated" | "updated_dirty" | "untouched",
    note: string | null,
  ): Promise<LandResult> {
    const currentBranch = await this.git.currentBranch(ctx.ws.repoRoot);
    await this.workspaces.cleanup(ctx.ws, { deleteBranch: true });
    return {
      kind: "landed",
      message: landedLocally({ base: ctx.ws.baseBranch, checkout, currentBranch, note }),
    };
  }

  // ---- Pull request ------------------------------------------------------------------------

  private async landViaPullRequest(ctx: Ctx): Promise<LandResult> {
    const { git, deps } = { git: this.git, deps: this.deps };
    const { repoRoot: root, worktreePath: path, branch, baseBranch: base } = ctx.ws;
    const remote = await findRemote(git, root);
    if (!remote) throw new Error("The project's GitHub remote is not there any more.");
    const host = await deps.github.repo(path);
    if (!host.ok) throw new Error(host.reason);
    const remoteRef = `refs/remotes/${remote.name}/${base}`;
    const record = this.require(ctx);

    let pr = record.prNumber
      ? await deps.github.getPr(path, record.prNumber)
      : await deps.github.findPr(path, branch);
    if (pr?.state === "merged") return this.afterPullRequest(ctx, remote.name, pr);
    if (pr?.state === "closed") {
      return {
        kind: "blocked",
        reason: `The pull request was closed on GitHub without being merged (${pr.url}), so I stopped. The finished work is saved on branch ${branch}.`,
      };
    }

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      await this.fetch(ctx, remote.name, base);
      const integrated = await this.integrate(ctx, remoteRef, base);
      if ("result" in integrated) return integrated.result;
      await this.push(ctx, remote.name, integrated.head);
      pr ??= await this.openPullRequest(ctx, base);
      const gate = await this.gate(ctx, base, integrated, pr.url);
      if (gate) return gate;
      const waited = await this.waitForChecks(ctx, pr, integrated.head);
      if (waited) return waited;

      // The main branch moved while the checks ran: combine and check again.
      await this.fetch(ctx, remote.name, base);
      if ((await git.rev(root, remoteRef)) !== integrated.baseTip) continue;

      const method = chooseMergeMethod(ctx.cfg.mergeMethod, host.host.allowed);
      try {
        await deps.github.mergePr(path, pr.number, method);
      } catch (err) {
        const now = await deps.github.getPr(path, pr.number).catch(() => undefined);
        if (now?.state !== "merged") {
          return {
            kind: "blocked",
            reason: `GitHub wouldn't let me merge the pull request (${errorMessage(err)}). It may need someone's approval or a setting changed. It is open at ${pr.url}, and the finished work is saved on branch ${branch}.`,
          };
        }
      }
      this.store.recordOp(ctx.goal.id, `merge:${pr.number}`);
      return this.afterPullRequest(ctx, remote.name, { ...pr, state: "merged" });
    }
    return { kind: "blocked", reason: this.stuck(ctx, `${base} kept changing while I merged`) };
  }

  private async fetch(ctx: Ctx, remote: string, base: string): Promise<void> {
    const result = await this.git.run(ctx.ws.repoRoot, ["fetch", remote, base], {
      timeoutMs: 300_000,
    });
    if (result.code !== 0) throw new Error(`Could not reach GitHub: ${gitProblem(result)}`);
  }

  /** Sends the branch. A fast-forward only, and only when the remote does not have it yet. */
  private async push(ctx: Ctx, remote: string, head: string): Promise<void> {
    const { git } = this;
    const path = ctx.ws.worktreePath;
    const listed = await git.out(path, ["ls-remote", remote, `refs/heads/${ctx.ws.branch}`]);
    if (listed?.split(/\s+/)[0] === head) return;
    const pushed = await git.run(
      path,
      ["push", remote, `${ctx.ws.branch}:refs/heads/${ctx.ws.branch}`],
      { timeoutMs: 600_000 },
    );
    if (pushed.code !== 0)
      throw new Error(`Could not send the branch to GitHub: ${gitProblem(pushed)}`);
    this.store.recordOp(ctx.goal.id, `push:${head}`);
    this.store.updateLanding(ctx.goal.id, { ciStartedAt: null });
  }

  /** The pull request for the branch: an existing one first, a new one only if there is none. */
  private async openPullRequest(ctx: Ctx, base: string): Promise<PullRequest> {
    const { github, goals } = this.deps;
    const path = ctx.ws.worktreePath;
    const existing = await github.findPr(path, ctx.ws.branch);
    let pr = existing?.state === "open" ? existing : undefined;
    if (!pr) {
      const verification = goals
        .verifications(ctx.goal.id)
        .filter((v) => v.passed)
        .at(-1);
      const input = {
        head: ctx.ws.branch,
        base,
        title: ctx.goal.brief.objective.trim().replace(/\s+/g, " ").slice(0, 120),
        body: pullRequestBody(ctx.goal, ctx.run.report, verification?.results ?? []),
      };
      try {
        pr = await github.createPr(path, input);
      } catch (err) {
        // It may have been created although the call failed (a dropped connection).
        pr = (await github.findPr(path, ctx.ws.branch)) ?? undefined;
        if (!pr) throw err;
      }
      this.store.recordOp(ctx.goal.id, "pr_create", pr.url);
    }
    this.store.updateLanding(ctx.goal.id, { prNumber: pr.number, prUrl: pr.url });
    return pr;
  }

  /** Waits, by polling and without any model, for the repository's required checks. */
  private async waitForChecks(
    ctx: Ctx,
    pr: PullRequest,
    head: string,
  ): Promise<LandResult | undefined> {
    const { clock, github } = this.deps;
    const expected = expectsPullRequestChecks(await this.snapshot(ctx, head));
    const record = this.require(ctx);
    const started = record.ciStartedAt ?? isoNow(clock);
    if (!record.ciStartedAt) this.store.updateLanding(ctx.goal.id, { ciStartedAt: started });
    for (;;) {
      const checks = await github.checks(ctx.ws.worktreePath, pr.number);
      if (checks.state === "failing") {
        return this.needsWorker(
          ctx,
          ciFailedPrompt(checks.failing),
          `GitHub's required checks failed (${checks.failing.join(", ")}). The pull request is ${pr.url}`,
        );
      }
      if (checks.state === "passing") return undefined;
      const waited = clock.now() - Date.parse(started);
      if (checks.state === "none" && (!expected || waited >= ctx.cfg.ciStartGraceMs)) {
        return undefined;
      }
      if (waited >= ctx.cfg.requireCiWaitMs) {
        return {
          kind: "blocked",
          reason: `GitHub's checks were still running after ${Math.round(ctx.cfg.requireCiWaitMs / 60_000)} minutes, so I haven't merged. The pull request is open at ${pr.url}, and the finished work is saved on branch ${ctx.ws.branch}.`,
        };
      }
      await sleep(clock, ctx.cfg.ciPollIntervalMs, ctx.signal);
    }
  }

  private async afterPullRequest(ctx: Ctx, remote: string, pr: PullRequest): Promise<LandResult> {
    const { git } = this;
    const { repoRoot: root, baseBranch: base, branch } = ctx.ws;
    const fetched = await git.run(root, ["fetch", remote, base], { timeoutMs: 300_000 });
    let local: "updated" | "behind" = "behind";
    if (fetched.code === 0) local = await this.catchUp(root, remote, base);
    // Best effort: the remote copy of the branch is done with.
    await git.run(root, ["push", remote, "--delete", branch], { timeoutMs: 120_000 });
    await this.workspaces.cleanup(ctx.ws, { deleteBranch: true });
    return { kind: "landed", message: landedOnGitHub({ url: pr.url, base, local }) };
  }

  /** Brings the user's own copy of the main branch up to date, only when that is a fast-forward. */
  private async catchUp(root: string, remote: string, base: string): Promise<"updated" | "behind"> {
    const { git } = this;
    const remoteTip = await git.rev(root, `refs/remotes/${remote}/${base}`);
    const localTip = await git.rev(root, `refs/heads/${base}`);
    if (!remoteTip || !localTip) return "behind";
    if (remoteTip === localTip) return "updated";
    if (!(await git.isAncestor(root, localTip, remoteTip))) return "behind";
    const checkout = (await git.worktrees(root)).find((w) => w.branch === base);
    if (checkout) {
      return (await git.ok(checkout.path, ["merge", "--ff-only", remoteTip]))
        ? "updated"
        : "behind";
    }
    const moved = await git.ok(root, [
      "update-ref",
      "-m",
      "preston: catch up",
      `refs/heads/${base}`,
      remoteTip,
      localTip,
    ]);
    return moved ? "updated" : "behind";
  }

  // ---- Shared steps ------------------------------------------------------------------------

  /**
   * Brings the latest main branch into the Goal's branch (inside its own worktree) and, if that
   * changed anything, re-runs the Brief's checks on the result. A conflict goes back to the
   * Worker with the details.
   */
  private async integrate(ctx: Ctx, baseRef: string, base: string): Promise<Integrated> {
    const { git } = this;
    const { repoRoot: root, worktreePath: path } = ctx.ws;
    const baseTip = await git.rev(root, baseRef);
    if (!baseTip) {
      return {
        result: {
          kind: "blocked",
          reason: `The ${base} branch is no longer in your project, so I can't merge into it. The finished work is saved on branch ${ctx.ws.branch}.`,
        },
      };
    }
    if (!(await git.isAncestor(path, baseTip, "HEAD"))) {
      const identity = await git.identityArgs(path);
      const merged = await git.run(path, [
        ...identity,
        "merge",
        "--no-edit",
        "-m",
        `Bring in the latest ${base}`,
        baseTip,
      ]);
      if (merged.code !== 0) {
        const unmerged = await git.out(path, ["diff", "--name-only", "--diff-filter=U"]);
        const files = unmerged?.split(/\r?\n/).filter(Boolean) ?? [];
        await git.run(path, ["merge", "--abort"]);
        if (files.length === 0) throw new Error(gitProblem(merged));
        return {
          result: this.needsWorker(
            ctx,
            conflictPrompt(base, baseTip, files),
            `the work conflicts with newer changes to ${base} in ${files.join(", ")}`,
          ),
        };
      }
      const joined = await git.rev(path, "HEAD");
      if (joined) this.store.recordOp(ctx.goal.id, `integrated:${joined}`);
    }
    const head = (await git.rev(path, "HEAD")) ?? "";
    if ((await git.out(root, ["rev-list", "--count", `${baseTip}..${head}`])) === "0") {
      await this.workspaces.cleanup(ctx.ws, { deleteBranch: true });
      return { result: { kind: "landed", message: nothingToLand(base) } };
    }
    if (
      this.store.hasOp(ctx.goal.id, `integrated:${head}`) &&
      !this.store.hasOp(ctx.goal.id, `verified:${head}`)
    ) {
      const evidence = await this.verifyMerged(ctx);
      if (evidence) {
        return {
          result: this.needsWorker(
            ctx,
            failedAfterMergePrompt(base, evidence),
            `my checks fail once the work is combined with the latest ${base}`,
          ),
        };
      }
      this.store.recordOp(ctx.goal.id, `verified:${head}`);
    }
    return { baseTip, head };
  }

  /** The Brief's checks, run by Preston on the combined result. Undefined when they pass. */
  private async verifyMerged(ctx: Ctx): Promise<string | undefined> {
    const { clock, goals } = this.deps;
    const startedAt = isoNow(clock);
    const results = [];
    for (const [index, check] of ctx.goal.brief.checks.entries()) {
      results.push(
        await runCheck(
          { ...check, source: "brief" },
          {
            cwd: ctx.ws.workdir,
            timeoutMs: this.deps.config.get().verification.checkTimeoutMs,
            clock,
            outputPath: join(
              ctx.run.transcriptDir,
              `landing-check-${Date.parse(startedAt)}-${index + 1}.log`,
            ),
            signal: ctx.signal,
          },
        ),
      );
    }
    if (ctx.signal.aborted) throw new Error("stopped");
    const passed = results.every((r) => r.passed);
    goals.addVerification({
      goalId: ctx.goal.id,
      runId: ctx.run.id,
      passed,
      results,
      startedAt,
      endedAt: isoNow(clock),
    });
    return passed ? undefined : failedChecksEvidence(results);
  }

  /** Asks before a merge that would also publish something, unless the user has allowed it. */
  private async gate(
    ctx: Ctx,
    base: string,
    integrated: { baseTip: string; head: string },
    prUrl: string | null,
  ): Promise<LandResult | undefined> {
    if (ctx.cfg.autoMergePublishing) return undefined;
    const { questions } = this.deps;
    const held = (): LandResult => ({
      kind: "held",
      message: heldMessage({
        branch: ctx.ws.branch,
        prUrl: prUrl ?? this.require(ctx).prUrl,
        worktreePath: ctx.ws.worktreePath,
      }),
    });
    const record = this.require(ctx);
    if (record.decision === "yes") return undefined;
    if (record.decision === "no") return held();
    if (record.questionId) {
      const question = questions.find(record.questionId);
      if (question?.state === "answered") {
        const decision = parseYesNo(question.answer ?? "");
        this.store.updateLanding(ctx.goal.id, { decision });
        return decision === "yes" ? undefined : held();
      }
      if (question?.state === "pending_human" || question?.state === "pending_coordinator") {
        return { kind: "waiting_for_user" };
      }
      throw new Error("The question about publishing is no longer open.");
    }
    const verdict = await this.publishing(ctx, integrated);
    this.store.updateLanding(ctx.goal.id, { publishing: verdict });
    if (verdict.verdict === "none") return undefined;
    const text = publishQuestion(ctx.goal, verdict, base, ctx.ws.branch, prUrl);
    // Asked and recorded together: after a crash the question is never asked twice.
    transaction(this.deps.db, () => {
      const question = questions.askHuman(text, ctx.goal.id);
      this.store.updateLanding(ctx.goal.id, { questionId: question.id });
    });
    return { kind: "waiting_for_user" };
  }

  private async publishing(
    ctx: Ctx,
    integrated: { baseTip: string; head: string },
  ): Promise<PublishingVerdict> {
    const reasons = new Set<string>();
    let verdict: PublishingVerdict["verdict"] = "none";
    for (const ref of [integrated.head, integrated.baseTip]) {
      const found = detectPublishing(await this.snapshot(ctx, ref), ctx.ws.baseBranch);
      for (const reason of found.reasons) reasons.add(reason);
      if (found.verdict === "publishes") verdict = "publishes";
      else if (found.verdict === "unsure" && verdict === "none") verdict = "unsure";
    }
    return verdict === "none"
      ? { verdict: "none", reasons: [] }
      : { verdict, reasons: [...reasons] };
  }

  /** The repository's files at a commit, read from Git without checking anything out. */
  private async snapshot(ctx: Ctx, ref: string): Promise<RepoSnapshot> {
    const { git } = this;
    const path = ctx.ws.worktreePath;
    const listed = (await git.out(path, ["ls-tree", "-r", "--name-only", "-z", ref])) ?? "";
    const paths = listed.split("\0").filter(Boolean);
    const files = new Map<string, string>();
    for (const file of paths.filter(isInterestingPath)) {
      const text = await git.out(path, ["show", `${ref}:${file}`]);
      if (text !== undefined) files.set(file, text.slice(0, 200_000));
    }
    const refs = await git.out(path, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ]);
    return { paths, files, branches: refs?.split(/\r?\n/).filter(Boolean) ?? [] };
  }

  /** Sends a fixable problem to the Worker once (configurable), otherwise reports Blocked. */
  private needsWorker(ctx: Ctx, prompt: string, because: string): LandResult {
    const record = this.require(ctx);
    if (record.fixAttempts >= ctx.cfg.conflictFixAttempts) {
      return { kind: "blocked", reason: this.stuck(ctx, because) };
    }
    this.store.updateLanding(ctx.goal.id, { fixAttempts: record.fixAttempts + 1 });
    return { kind: "needs_worker", prompt };
  }

  private stuck(ctx: Ctx, because: string): string {
    const prUrl = this.store.landing(ctx.goal.id)?.prUrl;
    const where = prUrl ? ` The pull request is at ${prUrl}.` : "";
    return `I couldn't finish merging this on my own: ${because}. Nothing of yours was changed.${where} The finished work is saved on branch ${ctx.ws.branch}, with its files in ${ctx.ws.worktreePath}.`;
  }

  private require(ctx: Ctx) {
    return this.store.ensureLanding(ctx.goal.id);
  }

  // ---- Projects ----------------------------------------------------------------------------

  /** Every Project Preston knows, looked at again right now. */
  async projects(): Promise<
    {
      id: string;
      path: string;
      name: string;
      activeGoals: number;
      totalGoals: number;
      info: ProjectInfo;
    }[]
  > {
    const out = [];
    for (const project of this.store.projects()) {
      const info = await inspectProject(this.git, project.path, isoNow(this.deps.clock));
      this.store.saveProjectInfo(project.id, info);
      out.push({ ...project, info });
    }
    return out;
  }
}

function isTree(ws: Workspace): ws is Tree {
  return Boolean(ws.repoRoot && ws.worktreePath && ws.branch && ws.baseBranch && ws.baseSha);
}
