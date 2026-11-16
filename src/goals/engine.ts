import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Outbox } from "../channels/outbox.js";
import { type Clock, isoNow, type Timer } from "../clock.js";
import type { ConfigManager } from "../config/config.js";
import { errorMessage, type Logger } from "../log.js";
import { type Tokens, ToolError } from "../mcp/tools.js";
import { decide, nativeAction } from "../policy/approvals.js";
import type { PolicyAction } from "../policy/policy.js";
import { evaluate } from "../policy/policy.js";
import {
  answerPrompt,
  briefChangedPrompt,
  failedChecksPrompt,
  QUOTA_RESUME_PROMPT,
  RECOVERY_PROMPT,
  REPORT_REMINDER_PROMPT,
  RESUME_AFTER_PAUSE_PROMPT,
  WORKER_GUIDANCE,
} from "../prompts/worker.js";
import type { Question, Questions } from "../questions/questions.js";
import { type Db, recordEvent, transaction } from "../store/db.js";
import { agentLabel } from "../workers/registry.js";
import type {
  AgentKind,
  ApprovalDecision,
  McpLaunchSpec,
  RunHandle,
  WorkerAdapter,
  WorkerEvent,
} from "../workers/types.js";
import { type Brief, renderBrief } from "./brief.js";
import { type CheckResult, runCheck } from "./checks.js";
import {
  ackMessage,
  blockedMessage,
  failedChecksEvidence,
  failedMessage,
  pausedForSignInMessage,
  unverifiedMessage,
  verifiedMessage,
} from "./messages.js";
import {
  type Goal,
  type GoalState,
  type GoalStore,
  type Origin,
  type Run,
  TERMINAL_GOAL_STATES,
  type WorkerReport,
} from "./store.js";

export interface EngineDeps {
  db: Db;
  store: GoalStore;
  questions: Questions;
  outbox: Outbox;
  config: ConfigManager;
  tokens: Tokens;
  clock: Clock;
  log: Logger;
  transcriptsDir: string;
  adapter(kind: AgentKind): WorkerAdapter | undefined;
  mcpLaunch(token: string): McpLaunchSpec;
  /** A Worker question still needs the Coordinator (used again after a restart). */
  raiseWorkerQuestion(question: Question): void;
}

type TurnEnd = Extract<
  WorkerEvent,
  { type: "completed" | "failed" | "quota_blocked" | "auth_error" }
>;

const PAUSABLE: readonly GoalState[] = ["queued", "running", "recovering", "waiting_for_quota"];
const MAX_SUGGESTED_CHECKS = 5;

/**
 * The durable Goal and Run state machine. Every transition is a synchronous database write;
 * asynchronous work (agent turns, verification) re-reads state when it finishes, so a Goal
 * cancelled or paused meanwhile is never overwritten.
 */
export class GoalEngine {
  private live = new Map<string, RunHandle>();
  private tasks = new Set<Promise<void>>();
  private wakeTimers = new Map<string, Timer>();
  private checkAborts = new Map<string, AbortController>();
  /** Runs whose live turn Preston interrupted on purpose (pause, cancel). */
  private interrupted = new Set<string>();
  private stopping = false;

  constructor(private readonly deps: EngineDeps) {
    deps.questions.onAnswered((question) => this.onAnswered(question));
  }

  // ---- Commands ----------------------------------------------------------------------------

  createGoal(input: {
    projectPath: string;
    brief: Brief;
    parentGoalId?: string | undefined;
    origin?: Origin | undefined;
  }): Goal {
    const projectPath = resolve(input.projectPath);
    if (!isAbsolute(input.projectPath)) {
      throw new ToolError("projectPath must be an absolute path to a folder on this computer.");
    }
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      throw new ToolError(`There is no folder at ${projectPath}.`);
    }
    if (input.parentGoalId && !this.deps.store.findGoal(input.parentGoalId)) {
      throw new ToolError(`There is no goal ${input.parentGoalId}.`);
    }
    const agent = this.pickAgent();
    const { store, db, outbox, clock } = this.deps;
    const goal = transaction(db, () => {
      const projectId = store.ensureProject(projectPath);
      const created = store.createGoal({
        projectId,
        brief: input.brief,
        parentGoalId: input.parentGoalId,
        origin: input.origin,
      });
      recordEvent(db, clock, "goal_created", { goalId: created.id }, { agent });
      const ack = { kind: "ack" as const, text: ackMessage(created), goalId: created.id };
      if (input.origin) {
        outbox.enqueue({ ...ack, ...input.origin, dedupeKey: `ack:${created.id}` });
      } else {
        outbox.broadcast({ ...ack, dedupeKey: `ack:${created.id}` });
      }
      return created;
    });
    this.startNewRun(goal.id, agent);
    return this.deps.store.goal(goal.id);
  }

  cancelGoal(goalId: string, detail = "Stopped by you."): Goal {
    const goal = this.requireGoal(goalId);
    if (isTerminal(goal.state)) throw new ToolError(`Goal ${goalId} has already finished.`);
    const run = this.deps.store.currentRun(goalId);
    transaction(this.deps.db, () => {
      this.deps.store.setGoalState(goalId, "cancelled", { detail });
      if (run) this.deps.store.updateRun(run.id, { state: "ended", endReason: "cancelled" });
      this.deps.questions.cancelForGoal(goalId);
      recordEvent(this.deps.db, this.deps.clock, "goal_cancelled", { goalId });
    });
    this.haltWork(goalId, run);
    return this.deps.store.goal(goalId);
  }

  updateBrief(goalId: string, brief: Brief): Goal {
    const goal = this.requireGoal(goalId);
    if (isTerminal(goal.state)) {
      throw new ToolError(`Goal ${goalId} has finished; create a follow-up Goal instead.`);
    }
    this.deps.store.updateBrief(goalId, brief);
    recordEvent(this.deps.db, this.deps.clock, "brief_updated", { goalId });
    return this.deps.store.goal(goalId);
  }

  /** Pauses all work that is running or about to run. Returns the paused Goals. */
  pauseAll(): Goal[] {
    const paused = this.deps.store.activeGoals().filter((g) => PAUSABLE.includes(g.state));
    for (const goal of paused) {
      this.deps.store.setGoalState(goal.id, "paused", { detail: "Paused by you." });
      recordEvent(this.deps.db, this.deps.clock, "goal_paused", { goalId: goal.id });
      this.haltWork(goal.id, this.deps.store.currentRun(goal.id));
    }
    return paused;
  }

  /** Resumes every paused Goal. Returns the resumed Goals. */
  resumeAll(): Goal[] {
    const paused = this.deps.store.activeGoals().filter((g) => g.state === "paused");
    for (const goal of paused) {
      recordEvent(this.deps.db, this.deps.clock, "goal_resumed", { goalId: goal.id });
      const run = this.deps.store.currentRun(goal.id);
      if (!run) {
        this.startNewRun(goal.id, this.pickAgentOr(goal));
      } else if (this.live.has(run.id)) {
        // Still winding down from the pause; the turn's end continues it.
        this.deps.store.setGoalState(goal.id, "running");
      } else {
        this.nextStep(this.deps.store.goal(goal.id), run, RESUME_AFTER_PAUSE_PROMPT);
      }
    }
    return paused;
  }

  /** Cancels every Goal that has not finished. */
  stopAll(): Goal[] {
    return this.deps.store.activeGoals().map((goal) => this.cancelGoal(goal.id, "Stopped by you."));
  }

  recordReport(runId: string, report: WorkerReport): void {
    const run = this.deps.store.run(runId);
    if (run.state === "ended") throw new ToolError("This Run has already ended.");
    this.deps.store.updateRun(runId, { report, reportPending: true });
    recordEvent(
      this.deps.db,
      this.deps.clock,
      "worker_reported",
      { goalId: run.goalId, runId },
      {
        blockers: report.blockers.length,
        suggested: report.suggestedVerificationCommands.length,
      },
    );
  }

  /** Answers an agent's native approval request with the deterministic policy (ADR 0003). */
  approve(runId: string, action: PolicyAction): ApprovalDecision {
    const run = this.deps.store.run(runId);
    const { decision, policy } = decide(action, { workdir: run.workdir });
    if (policy.verdict === "escalate") {
      recordEvent(
        this.deps.db,
        this.deps.clock,
        "approval_escalated",
        { goalId: run.goalId, runId },
        {
          action,
          reason: policy.reason,
        },
      );
      this.deps.log.info("approval denied pending escalation", { runId, reason: policy.reason });
    }
    return decision;
  }

  /** Reconciles every unfinished Goal with reality. Nothing is assumed to be running. */
  recover(): void {
    for (const goal of this.deps.store.activeGoals()) {
      const run = this.deps.store.currentRun(goal.id);
      recordEvent(
        this.deps.db,
        this.deps.clock,
        "goal_reconciled",
        { goalId: goal.id },
        { state: goal.state },
      );
      switch (goal.state) {
        case "queued":
        case "running":
        case "recovering":
          if (run) this.recoverRun(goal, run, "Preston restarted");
          else this.startNewRun(goal.id, this.pickAgentOr(goal));
          break;
        case "verifying":
          if (run?.reportPending) this.verify(goal.id, run.id);
          else if (run) this.recoverRun(goal, run, "Preston restarted");
          else this.startNewRun(goal.id, this.pickAgentOr(goal));
          break;
        case "waiting_for_user":
          if (!run) break;
          for (const q of this.deps.questions.forRun(run.id).open) {
            if (q.state === "pending_coordinator") this.deps.raiseWorkerQuestion(q);
          }
          this.nextStep(goal, run, undefined);
          break;
        case "waiting_for_quota":
          this.scheduleWake(goal.id, goal.wakeAt ?? isoNow(this.deps.clock));
          break;
        case "paused":
          break;
      }
    }
  }

  /** Stops all live work without changing durable state, so the next start recovers it. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.wakeTimers.values()) timer.cancel();
    this.wakeTimers.clear();
    for (const abort of this.checkAborts.values()) abort.abort();
    await Promise.allSettled([...this.live.values()].map((h) => h.interrupt()));
    await Promise.allSettled([...this.tasks]);
  }

  // ---- Runs and turns ----------------------------------------------------------------------

  private startNewRun(goalId: string, agent: AgentKind): void {
    const goal = this.deps.store.goal(goalId);
    const run = this.deps.store.createRun({
      goalId,
      agent,
      workdir: goal.projectPath,
      transcriptDir: (id) => join(this.deps.transcriptsDir, id),
    });
    this.deps.store.setGoalState(goalId, "running");
    recordEvent(this.deps.db, this.deps.clock, "run_started", { goalId, runId: run.id }, { agent });
    this.spawnTurn(run.id, renderBrief(goalId, goal.brief));
  }

  private spawnTurn(runId: string, prompt: string): void {
    if (this.live.has(runId)) {
      this.deps.log.error("refused to start a second turn for a live Run", { runId });
      return;
    }
    const task = this.executeTurn(runId, prompt)
      .catch((err) => this.deps.log.error("turn failed", { runId, error: err }))
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private async executeTurn(runId: string, prompt: string): Promise<void> {
    const { store, tokens, config } = this.deps;
    const run = store.run(runId);
    const goal = store.goal(run.goalId);
    const adapter = this.deps.adapter(run.agent);
    if (!adapter) {
      this.fail(goal, run, "failed", `${agentLabel(run.agent)} is not available on this computer.`);
      return;
    }
    const turn = run.turns + 1;
    store.updateRun(runId, { state: "active", turns: turn });
    mkdirSync(run.transcriptDir, { recursive: true });
    const token = tokens.mint({ role: "worker", runId, goalId: goal.id });
    const settings = config.get().workers;
    let end: TurnEnd | undefined;
    try {
      const handle = adapter.startRun({
        runId,
        workdir: run.workdir,
        prompt,
        resumeSessionId: run.sessionId ?? undefined,
        appendSystemPrompt: WORKER_GUIDANCE,
        model: settings.model,
        effort: settings.effort,
        mcp: this.deps.mcpLaunch(token),
        onApproval: async (request) => this.approve(runId, nativeAction(request)),
        transcriptPath: join(run.transcriptDir, `turn-${turn}.log`),
      });
      this.live.set(runId, handle);
      for await (const event of handle.events) {
        if (event.type === "started") {
          store.updateRun(runId, { sessionId: event.sessionId });
          store.recordSession(run.agent, event.sessionId, "worker", run.workdir);
        } else if (isTurnEnd(event)) {
          end ??= event;
        }
      }
    } catch (err) {
      end ??= {
        type: "failed",
        at: isoNow(this.deps.clock),
        error: errorMessage(err),
        retryable: true,
      };
    } finally {
      this.live.delete(runId);
      tokens.revoke(token);
    }
    if (this.stopping) return;
    this.afterTurn(runId, end);
  }

  private afterTurn(runId: string, end: TurnEnd | undefined): void {
    const { store } = this.deps;
    const run = store.run(runId);
    const interruptedByPreston = this.interrupted.delete(runId);
    if (run.state === "ended") return;
    const goal = store.goal(run.goalId);
    recordEvent(
      this.deps.db,
      this.deps.clock,
      "turn_ended",
      { goalId: goal.id, runId },
      {
        end: end?.type ?? "exited",
      },
    );
    if (isTerminal(goal.state)) {
      store.updateRun(runId, { state: "ended", endReason: goal.state });
      return;
    }
    if (goal.state === "paused") {
      store.updateRun(runId, { state: "parked" });
      return;
    }
    if (interruptedByPreston) {
      // Paused, then resumed before the interrupted turn wound down.
      this.nextStep(goal, run, RESUME_AFTER_PAUSE_PROMPT);
      return;
    }
    switch (end?.type) {
      case "completed":
        this.nextStep(goal, run, REPORT_REMINDER_PROMPT);
        return;
      case "quota_blocked": {
        const now = this.deps.clock.now();
        const reset = end.resetsAt ? Date.parse(end.resetsAt) : Number.NaN;
        const recheck = now + this.deps.config.get().quota.recheckIntervalMs;
        const wakeAt = new Date(reset > now ? Math.min(reset, recheck) : recheck).toISOString();
        store.updateRun(runId, { state: "parked" });
        store.setGoalState(goal.id, "waiting_for_quota", {
          detail: `${agentLabel(run.agent)} is out of quota.`,
          wakeAt,
        });
        this.scheduleWake(goal.id, wakeAt);
        return;
      }
      case "auth_error":
        store.updateRun(runId, { state: "parked" });
        store.setGoalState(goal.id, "paused", {
          detail: `${agentLabel(run.agent)} needs you to sign in again.`,
        });
        this.deps.outbox.broadcast({
          kind: "notice",
          text: pausedForSignInMessage(goal, agentLabel(run.agent)),
          goalId: goal.id,
          dedupeKey: `signin:${runId}:${run.turns}`,
        });
        return;
      default:
        this.recoverRun(
          goal,
          run,
          end?.type === "failed" ? end.error : "the worker exited unexpectedly",
        );
    }
  }

  /**
   * Decides what a Run that is between turns does next. `fallback` is the prompt to resume with
   * when nothing else is pending; undefined leaves the Run waiting.
   */
  private nextStep(goal: Goal, run: Run, fallback: string | undefined): void {
    const { store, questions } = this.deps;
    const { open, undelivered } = questions.forRun(run.id);
    if (undelivered.length) {
      questions.markDelivered(undelivered.map((q) => q.id));
      this.resumeRun(
        run,
        answerPrompt(undelivered.map((q) => ({ question: q.text, answer: q.answer ?? "" }))),
      );
      return;
    }
    if (open.length) {
      store.updateRun(run.id, { state: "parked" });
      store.setGoalState(goal.id, "waiting_for_user", { detail: "Waiting for an answer." });
      return;
    }
    if (run.briefChanged) {
      store.updateRun(run.id, { briefChanged: false });
      this.resumeRun(run, briefChangedPrompt(renderBrief(goal.id, goal.brief)));
      return;
    }
    if (run.reportPending) {
      this.verify(goal.id, run.id);
      return;
    }
    if (fallback === undefined) return;
    if (fallback === REPORT_REMINDER_PROMPT) {
      if (run.recoveries >= this.deps.config.get().recovery.maxAttempts) {
        this.fail(goal, run, "failed", "The worker kept stopping without reporting a result.");
        return;
      }
      store.updateRun(run.id, { recoveries: run.recoveries + 1 });
    }
    this.resumeRun(run, fallback);
  }

  private recoverRun(goal: Goal, run: Run, reason: string): void {
    const { store } = this.deps;
    if (run.recoveries >= this.deps.config.get().recovery.maxAttempts) {
      this.fail(goal, run, "failed", `The worker kept stopping unexpectedly (${reason}).`);
      return;
    }
    store.updateRun(run.id, { state: "parked", recoveries: run.recoveries + 1 });
    store.setGoalState(goal.id, "recovering", { detail: reason });
    recordEvent(
      this.deps.db,
      this.deps.clock,
      "run_recovering",
      { goalId: goal.id, runId: run.id },
      { reason },
    );
    // Without a native Session there is nothing to resume: start the Run again from the Brief.
    this.resumeRun(run, run.sessionId ? RECOVERY_PROMPT : renderBrief(goal.id, goal.brief));
  }

  private resumeRun(run: Run, prompt: string): void {
    this.deps.store.setGoalState(run.goalId, "running");
    this.spawnTurn(run.id, prompt);
  }

  private onAnswered(question: Question): void {
    if (!question.runId || question.answerDelivered || this.stopping) return;
    const run = this.deps.store.findRun(question.runId);
    if (!run || run.state === "ended" || this.live.has(run.id)) return;
    const goal = this.deps.store.goal(run.goalId);
    if (goal.state === "waiting_for_user") this.nextStep(goal, run, undefined);
  }

  private scheduleWake(goalId: string, at: string): void {
    this.wakeTimers.get(goalId)?.cancel();
    const delay = Math.max(0, Date.parse(at) - this.deps.clock.now());
    this.wakeTimers.set(
      goalId,
      this.deps.clock.setTimeout(() => {
        this.wakeTimers.delete(goalId);
        const goal = this.deps.store.findGoal(goalId);
        const run = this.deps.store.currentRun(goalId);
        if (goal?.state !== "waiting_for_quota" || !run) return;
        this.resumeRun(run, run.sessionId ? QUOTA_RESUME_PROMPT : renderBrief(goalId, goal.brief));
      }, delay),
    );
  }

  // ---- Verification ------------------------------------------------------------------------

  private verify(goalId: string, runId: string): void {
    this.deps.store.setGoalState(goalId, "verifying");
    const task = this.runVerification(goalId, runId)
      .catch((err) => this.deps.log.error("verification failed", { goalId, error: err }))
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private async runVerification(goalId: string, runId: string): Promise<void> {
    const { store, config, clock } = this.deps;
    const goal = store.goal(goalId);
    const run = store.run(runId);
    const report = run.report;
    if (report?.blockers.length) {
      this.fail(
        goal,
        run,
        "blocked",
        `The worker needs something from you:\n${report.blockers.map((b) => `- ${b}`).join("\n")}`,
      );
      return;
    }
    const checks = [
      ...goal.brief.checks.map((c) => ({ ...c, source: "brief" as const })),
      ...acceptedSuggestions(report, goal.brief, run.workdir),
    ];
    if (checks.length === 0) {
      this.complete(goal, run, [], report);
      return;
    }
    const settings = config.get().verification;
    const abort = new AbortController();
    this.checkAborts.set(goalId, abort);
    const startedAt = isoNow(clock);
    const results: CheckResult[] = [];
    try {
      for (const [index, check] of checks.entries()) {
        if (abort.signal.aborted) break;
        results.push(
          await runCheck(check, {
            cwd: run.workdir,
            timeoutMs: settings.checkTimeoutMs,
            clock,
            outputPath: join(run.transcriptDir, `check-${Date.parse(startedAt)}-${index + 1}.log`),
            signal: abort.signal,
          }),
        );
      }
    } finally {
      this.checkAborts.delete(goalId);
    }
    if (this.stopping || store.goal(goalId).state !== "verifying") return;
    const passed = results.every((r) => r.passed);
    store.addVerification({ goalId, runId, passed, results, startedAt, endedAt: isoNow(clock) });
    store.updateRun(runId, { reportPending: false });
    if (passed) {
      this.complete(store.goal(goalId), store.run(runId), results, report);
      return;
    }
    const evidence = failedChecksEvidence(results);
    if (run.fixAttempts < settings.maxFixAttempts) {
      store.updateRun(runId, { fixAttempts: run.fixAttempts + 1 });
      recordEvent(this.deps.db, clock, "checks_failed_resuming", { goalId, runId });
      this.resumeRun(store.run(runId), failedChecksPrompt(evidence));
      return;
    }
    this.fail(
      goal,
      run,
      "failed",
      `My checks still fail after the worker tried to fix them:\n${evidence}`,
    );
  }

  private complete(
    goal: Goal,
    run: Run,
    results: CheckResult[],
    report: WorkerReport | null,
  ): void {
    const verified = results.some((r) => r.source === "brief") && results.every((r) => r.passed);
    this.finish(goal, run, {
      state: "completed",
      outcome: verified ? "verified" : "unverified",
      message: verified ? verifiedMessage(goal, results, report) : unverifiedMessage(goal, report),
    });
  }

  private fail(goal: Goal, run: Run, state: "blocked" | "failed", reason: string): void {
    this.finish(goal, run, {
      state,
      detail: reason,
      message: state === "blocked" ? blockedMessage(goal, reason) : failedMessage(goal, reason),
    });
  }

  /** Ends a Goal with an outcome and tells the user once. */
  private finish(
    goal: Goal,
    run: Run,
    result:
      | { state: "completed"; outcome: "verified" | "unverified"; message: string }
      | { state: "blocked" | "failed"; detail: string; message: string },
  ): void {
    const { db, store, questions, outbox, clock } = this.deps;
    const outcome = result.state === "completed" ? result.outcome : undefined;
    transaction(db, () => {
      store.updateRun(run.id, { state: "ended", endReason: result.state });
      store.setGoalState(goal.id, result.state, {
        outcome,
        detail: result.state === "completed" ? null : result.detail.slice(0, 500),
      });
      questions.cancelForGoal(goal.id);
      recordEvent(
        db,
        clock,
        "goal_finished",
        { goalId: goal.id, runId: run.id },
        {
          state: result.state,
          outcome,
        },
      );
      outbox.broadcast({
        kind: "outcome",
        text: result.message,
        goalId: goal.id,
        dedupeKey: `outcome:${goal.id}`,
      });
    });
    this.deps.log.info("goal finished", { goalId: goal.id, state: result.state, outcome });
  }

  // ---- Helpers -----------------------------------------------------------------------------

  private haltWork(goalId: string, run: Run | undefined): void {
    this.wakeTimers.get(goalId)?.cancel();
    this.wakeTimers.delete(goalId);
    this.checkAborts.get(goalId)?.abort();
    const handle = run ? this.live.get(run.id) : undefined;
    if (!run || !handle) return;
    this.interrupted.add(run.id);
    handle
      .interrupt()
      .catch((err) => this.deps.log.warn("interrupt failed", { goalId, error: err }));
  }

  private pickAgent(): AgentKind {
    const enabled = this.deps.config.get().agents.enabled;
    const agent = enabled.find((kind) => this.deps.adapter(kind));
    if (!agent) {
      throw new ToolError("No coding agent is set up yet, so Preston cannot start work.");
    }
    return agent;
  }

  private pickAgentOr(goal: Goal): AgentKind {
    const previous = this.deps.store.runsForGoal(goal.id).at(-1)?.agent;
    return previous ?? this.pickAgent();
  }

  private requireGoal(goalId: string): Goal {
    const goal = this.deps.store.findGoal(goalId);
    if (!goal) throw new ToolError(`There is no goal ${goalId}.`);
    return goal;
  }
}

function isTerminal(state: GoalState): boolean {
  return TERMINAL_GOAL_STATES.includes(state);
}

function isTurnEnd(event: WorkerEvent): event is TurnEnd {
  return (
    event.type === "completed" ||
    event.type === "failed" ||
    event.type === "quota_blocked" ||
    event.type === "auth_error"
  );
}

/** Worker-suggested commands Preston will also run: only routine ones the policy allows. */
function acceptedSuggestions(report: WorkerReport | null, brief: Brief, workdir: string) {
  const known = new Set(brief.checks.map((c) => c.command.trim()));
  const accepted: { name: string; command: string; source: "suggested" }[] = [];
  for (const raw of report?.suggestedVerificationCommands ?? []) {
    const command = raw.trim();
    if (!command || known.has(command)) continue;
    known.add(command);
    if (evaluate({ kind: "command", command }, { workdir }).verdict !== "allow") continue;
    accepted.push({ name: `suggested: ${command}`, command, source: "suggested" });
    if (accepted.length >= MAX_SUGGESTED_CHECKS) break;
  }
  return accepted;
}
