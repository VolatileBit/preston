import type { Goal, Run } from "../goals/store.js";

/** Where a Worker should work, or why it cannot start. */
export type PrepareResult =
  | {
      ok: true;
      workdir: string /** Extra guidance for the Worker's system prompt. */;
      guidance?: string;
    }
  | { ok: false; reason: string };

/** What happened when Preston tried to land a Goal's verified work. */
export type LandResult =
  /** The work is on the main branch (or merged on GitHub). */
  | { kind: "landed"; message: string }
  /** The work is verified and kept on its branch; nothing was merged (the user said no). */
  | { kind: "held"; message: string }
  /** Something the Worker can fix (a conflict, a failing check): resume it with this prompt. */
  | { kind: "needs_worker"; prompt: string }
  /** Preston asked the user whether to merge something that publishes, and waits. */
  | { kind: "waiting_for_user" }
  | { kind: "blocked"; reason: string }
  /** Preston is shutting down or the Goal was cancelled. */
  | { kind: "aborted" };

/**
 * The seam between the Goal engine and landing (`src/landing`). The engine knows only this
 * interface: where a Goal works, whether its verified work still has to be landed, and what to do
 * with the result.
 */
export interface LandingHooks {
  /** Before every turn: the Goal's working folder. Creates or reuses its worktree. */
  prepare(goal: Goal, run: Run): PrepareResult | Promise<PrepareResult>;
  /** The Goal works in its own worktree, so verified work has to be landed. */
  usesWorktree(goalId: string): boolean;
  /** Lands the Goal's verified work. Idempotent; never throws. */
  land(goal: Goal, run: Run): Promise<LandResult>;
  /** A landing was started and has not reached a result: resume it after a restart. */
  isLanding(goalId: string): boolean;
  /** The Goal whose landing is waiting for this question's answer. */
  questionGoal(questionId: string): string | undefined;
  /** A plain-language note for outcomes that did not land (kept branch, in-place fallback). */
  outcomeNote(goal: Goal): string | undefined;
  /**
   * Why a finished Goal's verified work cannot be merged again now (it was never verified, it
   * is already merged, it has no saved work), or undefined when it can. Restores the working
   * copy if it was removed to save space.
   */
  prepareReland(goal: Goal): Promise<string | undefined>;
  /**
   * Clears what stopped the last landing so `land` tries again from the start (synchronous, so
   * the engine can do it in the transaction that moves the Goal back to verifying). Without
   * `allowPublishing` a merge that would publish is asked about again.
   */
  resetForReland(goalId: string, options: { allowPublishing: boolean }): void;
  /** Stops waits and checks of one Goal's landing (cancelled), or of all of them (shutdown). */
  abort(goalId?: string): void;
}
