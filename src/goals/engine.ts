import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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
  handoverPrompt,
  QUOTA_RESUME_PROMPT,
  RATE_LIMIT_RESUME_PROMPT,
  RECOVERY_PROMPT,
  REPORT_REMINDER_PROMPT,
  RESUME_AFTER_PAUSE_PROMPT,
  SIGNED_IN_RESUME_PROMPT,
  STALL_RESUME_PROMPT,
  strategyNotePrompt,
  WORKER_GUIDANCE,
} from "../prompts/worker.js";
import type { Question, Questions } from "../questions/questions.js";
import type { QuotaMonitor } from "../quota/monitor.js";
import type { Bucket } from "../quota/store.js";
import { formatResetTime } from "../quota/time.js";
import { type Db, recordEvent, transaction } from "../store/db.js";
import type { ProcessTracker } from "../supervisor/processes.js";
import { type RunHealth, runHealth, type StallEvidence, StallWatch } from "../supervisor/stalls.js";
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
  handoverMessage,
  quotaWaitMessage,
  signInHow,
  signInMessage,
  spendLimitMessage,
  unverifiedMessage,
  verifiedMessage,
} from "./messages.js";
import {
  type Attempt,
  type Goal,
  type GoalState,
  type GoalStore,
  type Origin,
  type Run,
  TERMINAL_GOAL_STATES,
  type WorkerReport,
} from "./store.js";

/** A repeated stall (or a failure after a stall) that needs the Coordinator's judgement. */
export interface GoalEvent {
  goalId: string;
  runId: string;
  detail: string;
}

export type StrategyAction =
  | "retry_with_note"
  | "fresh_session"
  | "switch_agent"
  | "report_blocked";

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
  quota: QuotaMonitor;
  processes: ProcessTracker;
  adapter(kind: AgentKind): WorkerAdapter | undefined;
  mcpLaunch(token: string): McpLaunchSpec;
  /** A Worker question still needs the Coordinator (used again after a restart). */
  raiseWorkerQuestion(question: Question): void;
  /** Asks the Coordinator how a stuck Goal should continue. */
  raiseGoalEvent(event: GoalEvent): void;
}

type TurnEnd = Extract<
  WorkerEvent,
  { type: "completed" | "failed" | "quota_blocked" | "auth_error" }
>;
type QuotaEnd = Extract<WorkerEvent, { type: "quota_blocked" }>;

const PAUSABLE: readonly GoalState[] = [
  "queued",
  "running",
  "recovering",
  "waiting_for_quota",
  "waiting_for_login",
];
const MAX_SUGGESTED_CHECKS = 5;
/** Failures that are really a short burst of rate limiting (Claude reports them as retryable). */
const TRANSIENT_FAILURE = /\b429\b|\b529\b|rate[ _-]?limit|too many requests|overloaded/i;

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
  /** Runs whose live turn the stall watch interrupted. */
  private stalled = new Set<string>();
  private readonly watch: StallWatch;
  private stopping = false;

  constructor(private readonly deps: EngineDeps) {
    deps.questions.onAnswered((question) => this.onAnswered(question));
    this.watch = new StallWatch(
      deps.clock,
      () => deps.config.get().supervision,
      (runId, evidence) => this.onStall(runId, evidence),
    );
  }

  // ---- Commands ----------------------------------------------------------------------------

  createGoal(input: {
    projectPath: string;
    brief: Brief;
    parentGoalId?: string | undefined;
    origin?: Origin | undefined;
    /** Idempotency key: the same key and objective return the Goal already created. */
    sourceKey?: string | undefined;
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
    if (input.sourceKey) {
      const existing = this.deps.store.findGoalBySource(input.sourceKey, input.brief.objective);
      if (existing) return existing;
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
        sourceKey: input.sourceKey,
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

  /**
   * The Coordinator's decision after a Goal stalled repeatedly. Each decision is recorded on
   * the Goal; after `supervision.maxStrategyChanges` Preston reports Blocked instead of asking.
   */
  changeStrategy(goalId: string, action: StrategyAction, note: string): Goal {
    const goal = this.requireGoal(goalId);
    const run = this.deps.store.currentRun(goalId);
    if (!run?.strategyPending) {
      throw new ToolError(`Goal ${goalId} is not waiting for a decision on how to continue.`);
    }
    const { store, db } = this.deps;
    const label = agentLabel(run.agent);
    switch (action) {
      case "retry_with_note":
        transaction(db, () => {
          store.updateRun(run.id, { strategyPending: false, stalls: 0 });
          store.addAttempt(goalId, {
            runId: run.id,
            agent: run.agent,
            tactic: action,
            reason: note,
          });
        });
        this.resumeRun(
          store.run(run.id),
          run.sessionId ? strategyNotePrompt(note) : renderBrief(goalId, goal.brief),
        );
        break;
      case "fresh_session":
        this.replaceRun(goal, run, run.agent, {
          tactic: action,
          reason: note,
          prompt: (brief) =>
            handoverPrompt({
              brief,
              reason: "it stalled repeatedly",
              previousAgent: `An earlier ${label} session`,
              previousReport: run.report?.summary,
              lastMessage: run.lastMessage ?? undefined,
              note,
            }),
        });
        break;
      case "switch_agent": {
        const target = this.otherAgents(run.agent).find((a) => !this.deps.quota.activeBlock(a));
        if (!target)
          throw new ToolError("No other coding agent is set up with quota to switch to.");
        this.replaceRun(goal, run, target, {
          tactic: action,
          reason: note,
          prompt: (brief) =>
            handoverPrompt({
              brief,
              reason: "it stalled repeatedly",
              previousAgent: label,
              previousReport: run.report?.summary,
              lastMessage: run.lastMessage ?? undefined,
              note,
            }),
        });
        break;
      }
      case "report_blocked":
        store.addAttempt(goalId, { runId: run.id, agent: run.agent, tactic: action, reason: note });
        this.fail(goal, run, "blocked", note);
        break;
    }
    return store.goal(goalId);
  }

  /** Runs a Coordinator decision is still pending for (raised again after a restart). */
  pendingGoalEvents(): GoalEvent[] {
    return this.deps.store.strategyPendingRuns().map((run) => ({
      goalId: run.goalId,
      runId: run.id,
      detail: this.lastAttempt(run.goalId, "strategy_event")?.reason ?? "it stalled repeatedly",
    }));
  }

  /** After the Coordinator handled a Goal event without deciding: report Blocked, never loop. */
  goalEventHandled(event: GoalEvent): void {
    const run = this.deps.store.findRun(event.runId);
    if (!run?.strategyPending || run.state === "ended") return;
    const goal = this.deps.store.goal(run.goalId);
    this.fail(
      goal,
      run,
      "blocked",
      `The worker stalled repeatedly (${event.detail}) and I couldn't find a different way to continue. Tell me how you'd like to proceed.`,
    );
  }

  /** How a Run looks to the supervisor right now. */
  runHealth(runId: string): RunHealth | undefined {
    const run = this.deps.store.findRun(runId);
    if (!run) return undefined;
    return runHealth({
      goal: this.deps.store.goal(run.goalId),
      run,
      live: this.live.has(runId) ? this.watch.liveness(runId) : undefined,
      now: this.deps.clock.now(),
      settings: this.deps.config.get().supervision,
    });
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
      // Still waiting for the Coordinator to decide; it raises the event again when it starts.
      if (run?.strategyPending) continue;
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
          // Bucket waits are resumed by the quota monitor; short rate-limit waits by a timer.
          if (!run?.quotaBucket) this.scheduleWake(goal.id, goal.wakeAt ?? isoNow(this.deps.clock));
          break;
        case "waiting_for_login":
        case "paused":
          break;
      }
    }
  }

  /** Stops all live work without changing durable state, so the next start recovers it. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.watch.stopAll();
    for (const timer of this.wakeTimers.values()) timer.cancel();
    this.wakeTimers.clear();
    for (const abort of this.checkAborts.values()) abort.abort();
    await Promise.allSettled([...this.live.values()].map((h) => h.interrupt()));
    await Promise.allSettled([...this.tasks]);
  }

  // ---- Quota (called by the quota monitor) -------------------------------------------------

  /** Resumes a Run that waited for quota or a login. False when it no longer waits. */
  resumeFromQuota(runId: string, probe: boolean): boolean {
    if (this.stopping) return false;
    const run = this.deps.store.findRun(runId);
    if (run?.state !== "parked" || this.live.has(runId)) return false;
    const goal = this.deps.store.goal(run.goalId);
    if (goal.state !== "waiting_for_quota" && goal.state !== "waiting_for_login") return false;
    const prompt = !run.sessionId
      ? renderBrief(goal.id, goal.brief)
      : goal.state === "waiting_for_login"
        ? SIGNED_IN_RESUME_PROMPT
        : QUOTA_RESUME_PROMPT;
    this.deps.store.updateRun(
      runId,
      probe ? { quotaBucket: null } : { quotaBucket: null, waitingSince: null },
    );
    recordEvent(
      this.deps.db,
      this.deps.clock,
      "quota_resume",
      { goalId: goal.id, runId },
      { probe },
    );
    this.nextStep(goal, this.deps.store.run(runId), prompt);
    return true;
  }

  /** A check found a bucket still blocked: tell the user or hand Goals over, if warranted. */
  reviewWaits(bucket: Bucket): void {
    for (const run of this.deps.store.waitingRuns(bucket.bucket)) {
      this.track(this.reviewWait(run.id, bucket));
    }
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
    this.track(this.executeTurn(runId, prompt), "turn failed", { runId });
  }

  private track(task: Promise<void>, what = "background task failed", data: object = {}): void {
    const tracked = task
      .catch((err) => this.deps.log.error(what, { ...data, error: err }))
      .finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  private async executeTurn(runId: string, prompt: string): Promise<void> {
    const { store, tokens, config, quota } = this.deps;
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
    let trackedPid: number | undefined;
    let tracking: Promise<void> = Promise.resolve();
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
      this.watch.begin(runId);
      const trackPid = () => {
        const pid = handle.processId?.();
        if (pid === undefined || pid === trackedPid) return;
        trackedPid = pid;
        tracking = this.deps.processes.track(runId, run.agent, pid);
        this.track(tracking, "could not record the agent process", { runId, pid });
      };
      trackPid();
      for await (const event of handle.events) {
        trackPid();
        this.watch.observe(runId, event);
        if (event.type === "started") {
          store.updateRun(runId, { sessionId: event.sessionId });
          store.recordSession(run.agent, event.sessionId, "worker", run.workdir);
        } else if (event.type === "message") {
          store.updateRun(runId, { lastMessage: event.text.slice(-2000) });
        }
        if (event.type === "activity" || event.type === "message" || event.type === "completed") {
          quota.progress(runId);
        }
        if (isTurnEnd(event)) end ??= event;
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
      this.watch.end(runId);
      tokens.revoke(token);
      // On shutdown the record stays: the next start verifies the process really is gone.
      if (!this.stopping) {
        this.track(
          tracking.then(() => this.deps.processes.untrack(runId)),
          "could not forget the agent process",
        );
      }
    }
    if (this.stopping) return;
    this.afterTurn(runId, end);
  }

  private afterTurn(runId: string, end: TurnEnd | undefined): void {
    const { store } = this.deps;
    const run = store.run(runId);
    const interruptedByPreston = this.interrupted.delete(runId);
    const stalled = this.stalled.delete(runId);
    if (end?.type !== "quota_blocked" && end?.type !== "auth_error") {
      this.deps.quota.turnEnded(runId);
    }
    if (run.state === "ended") return;
    const goal = store.goal(run.goalId);
    recordEvent(
      this.deps.db,
      this.deps.clock,
      "turn_ended",
      { goalId: goal.id, runId },
      {
        end: stalled ? "stalled" : (end?.type ?? "exited"),
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
    if (stalled) {
      this.handleStall(goal, run);
      return;
    }
    const waiting = end?.type === "quota_blocked" || end?.type === "auth_error";
    if (!waiting && run.waitingSince) store.updateRun(runId, { waitingSince: null });
    if (end?.type === "failed" && end.retryable && TRANSIENT_FAILURE.test(end.error)) {
      this.waitBriefly(goal, store.run(runId), end.error);
      return;
    }
    switch (end?.type) {
      case "completed":
        if (run.rateLimitHits || run.stalls)
          store.updateRun(runId, { rateLimitHits: 0, stalls: 0 });
        this.nextStep(goal, store.run(runId), REPORT_REMINDER_PROMPT);
        return;
      case "quota_blocked":
        if (end.kind === "rate_limit") this.waitBriefly(goal, run, end.detail);
        else this.waitForQuota(goal, run, end);
        return;
      case "auth_error":
        this.waitForLogin(goal, run, end.detail);
        return;
      default: {
        const reason = end?.type === "failed" ? end.error : "the worker exited unexpectedly";
        if (run.stalls > 0) {
          this.raiseStrategy(
            goal,
            run,
            `it failed after Preston resumed it from a stall: ${reason}`,
          );
          return;
        }
        this.recoverRun(goal, run, reason);
      }
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
    if (run.quotaBucket) this.deps.store.updateRun(run.id, { quotaBucket: null });
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

  /** A short, time-based wait after a transient rate limit; no quota monitor, no message. */
  private waitBriefly(goal: Goal, run: Run, detail: string | undefined): void {
    const settings = this.deps.config.get().quota;
    const hits = run.rateLimitHits + 1;
    const delay = Math.min(settings.rateLimitWaitMs * 2 ** (hits - 1), settings.rateLimitMaxWaitMs);
    const wakeAt = new Date(this.deps.clock.now() + delay).toISOString();
    transaction(this.deps.db, () => {
      this.deps.store.updateRun(run.id, { state: "parked", rateLimitHits: hits });
      this.deps.store.setGoalState(goal.id, "waiting_for_quota", {
        detail: `${agentLabel(run.agent)} is briefly rate-limited; retrying shortly.`,
        wakeAt,
      });
      recordEvent(
        this.deps.db,
        this.deps.clock,
        "rate_limited",
        { goalId: goal.id, runId: run.id },
        { hits, delayMs: delay, detail },
      );
    });
    this.scheduleWake(goal.id, wakeAt);
  }

  /** The agent's quota ran out: park the Run on its bucket's monitor. Never a failure. */
  private waitForQuota(goal: Goal, run: Run, end: QuotaEnd): void {
    const { store, db, clock, quota } = this.deps;
    const label = agentLabel(run.agent);
    const kind = end.kind === "spend_limit" ? "spend_limit" : "usage_limit";
    transaction(db, () => {
      store.updateRun(run.id, {
        state: "parked",
        quotaBucket: end.bucket,
        waitingSince: run.waitingSince ?? isoNow(clock),
      });
      store.setGoalState(goal.id, "waiting_for_quota", {
        detail:
          kind === "spend_limit"
            ? `${label} has reached its spending limit.`
            : `${label} is out of quota.`,
        wakeAt: end.resetsAt ?? null,
      });
      recordEvent(
        db,
        clock,
        "quota_blocked",
        { goalId: goal.id, runId: run.id },
        { bucket: end.bucket, kind, resetsAt: end.resetsAt, detail: end.detail },
      );
    });
    const bucket = quota.runBlocked({
      owner: run.id,
      agent: run.agent,
      bucket: end.bucket,
      kind,
      resetsAt: end.resetsAt,
      detail: end.detail,
    });
    this.track(this.reviewWait(run.id, bucket));
  }

  /** The agent's login broke: tell the user once, and resume when a check shows it works. */
  private waitForLogin(goal: Goal, run: Run, detail: string): void {
    const { store, db, clock, quota } = this.deps;
    const label = agentLabel(run.agent);
    const bucket = transaction(db, () => {
      store.updateRun(run.id, {
        state: "parked",
        waitingSince: run.waitingSince ?? isoNow(clock),
      });
      store.setGoalState(goal.id, "waiting_for_login", {
        detail: `${label} needs you to sign in again.`,
      });
      recordEvent(db, clock, "auth_error", { goalId: goal.id, runId: run.id }, { detail });
      const blocked = quota.authBroken({ owner: run.id, agent: run.agent, detail });
      store.updateRun(run.id, { quotaBucket: blocked.bucket });
      return blocked;
    });
    // One message per agent sign-out, however many Goals it holds up.
    this.deps.outbox.broadcast({
      kind: "notice",
      text: signInMessage(goal, label, signInHow(run.agent)),
      goalId: goal.id,
      dedupeKey: `signin:${run.agent}:${bucket.blockedAt}`,
    });
  }

  /**
   * Decides whether a quota wait changes expectations: hand the Goal to another agent with
   * headroom when the wait is long, otherwise tell the user once if it is noticeably long.
   */
  private async reviewWait(runId: string, bucket: Bucket): Promise<void> {
    const stillWaiting = () => {
      const run = this.deps.store.findRun(runId);
      const goal = run && this.deps.store.findGoal(run.goalId);
      return run?.state === "parked" &&
        run.quotaBucket === bucket.bucket &&
        goal?.state === "waiting_for_quota"
        ? { run, goal }
        : undefined;
    };
    const first = stillWaiting();
    if (!first || this.stopping) return;
    const settings = this.deps.config.get().quota;
    const now = this.deps.clock.now();
    const reset = bucket.resetsAt ? Date.parse(bucket.resetsAt) - now : Number.NaN;
    const waited = first.run.waitingSince ? now - Date.parse(first.run.waitingSince) : 0;
    // An unknown reset counts as long only once the wait has actually lasted that long.
    const expected = Number.isFinite(reset) ? Math.max(reset, waited) : waited;
    const until = bucket.resetsAt && reset > 0 ? formatResetTime(bucket.resetsAt, now) : undefined;

    if (expected > settings.switchAfterMs) {
      const target = await this.switchTarget(first.run.agent);
      const current = stillWaiting();
      if (!current || this.stopping) return;
      if (target) {
        const from = agentLabel(current.run.agent);
        const to = agentLabel(target);
        this.replaceRun(current.goal, current.run, target, {
          tactic: "quota_handover",
          reason: `${from} is out of quota${until ? ` until ${until}` : ""}`,
          notice: handoverMessage(current.goal, from, to, until),
          prompt: (brief) =>
            handoverPrompt({
              brief,
              reason: "its usage quota ran out",
              previousAgent: from,
              previousReport: current.run.report?.summary,
              lastMessage: current.run.lastMessage ?? undefined,
            }),
        });
        return;
      }
    }
    const { run, goal } = first;
    const label = agentLabel(run.agent);
    const text =
      bucket.state === "spend_blocked"
        ? spendLimitMessage(goal, label)
        : expected > settings.notifyAfterMs
          ? quotaWaitMessage(goal, label, until)
          : undefined;
    if (!text) return;
    this.deps.outbox.broadcast({
      kind: "notice",
      text,
      goalId: goal.id,
      dedupeKey: `quota-wait:${goal.id}:${run.waitingSince}`,
    });
  }

  /** Another configured agent the user allowed, with quota headroom right now. */
  private async switchTarget(from: AgentKind): Promise<AgentKind | undefined> {
    if (!this.deps.config.get().agents.balanceByQuota) return undefined;
    for (const agent of this.otherAgents(from)) {
      if (await this.deps.quota.headroom(agent)) return agent;
    }
    return undefined;
  }

  private otherAgents(from: AgentKind): AgentKind[] {
    return this.deps.config
      .get()
      .agents.enabled.filter((a) => a !== from && this.deps.adapter(a) !== undefined);
  }

  /**
   * Ends a Run and continues the Goal in a new Session (on the same or another agent), seeded
   * with the Brief and a compact checkpoint. Never claims to continue the old Session exactly.
   */
  private replaceRun(
    goal: Goal,
    run: Run,
    agent: AgentKind,
    how: {
      tactic: Attempt["tactic"];
      reason: string;
      prompt: (brief: string) => string;
      notice?: string;
    },
  ): void {
    const { store, db, clock, outbox } = this.deps;
    const next = transaction(db, () => {
      store.updateRun(run.id, {
        state: "ended",
        endReason: how.tactic,
        quotaBucket: null,
        strategyPending: false,
      });
      const created = store.createRun({
        goalId: goal.id,
        agent,
        workdir: run.workdir,
        transcriptDir: (id) => join(this.deps.transcriptsDir, id),
      });
      store.setGoalState(goal.id, "running");
      store.addAttempt(goal.id, {
        runId: run.id,
        agent: run.agent,
        tactic: how.tactic,
        reason: how.reason,
      });
      recordEvent(
        db,
        clock,
        "run_replaced",
        { goalId: goal.id, runId: created.id },
        { from: run.id, fromAgent: run.agent, agent, tactic: how.tactic },
      );
      if (how.notice) {
        outbox.broadcast({
          kind: "notice",
          text: how.notice,
          goalId: goal.id,
          dedupeKey: `handover:${run.id}`,
        });
      }
      return created;
    });
    this.spawnTurn(next.id, how.prompt(renderBrief(goal.id, store.goal(goal.id).brief)));
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
        if (goal?.state !== "waiting_for_quota" || !run || run.quotaBucket) return;
        this.resumeRun(
          run,
          run.sessionId ? RATE_LIMIT_RESUME_PROMPT : renderBrief(goalId, goal.brief),
        );
      }, delay),
    );
  }

  // ---- Stalls ------------------------------------------------------------------------------

  /** The stall watch saw a live turn go silent: save evidence and interrupt it. */
  private onStall(runId: string, evidence: StallEvidence): void {
    const handle = this.live.get(runId);
    if (!handle || this.stopping) return;
    const run = this.deps.store.run(runId);
    try {
      writeFileSync(
        join(run.transcriptDir, `stall-${Date.parse(evidence.at)}.json`),
        JSON.stringify({ ...evidence, turn: run.turns, sessionId: run.sessionId }, null, 2),
      );
    } catch (err) {
      this.deps.log.warn("could not save stall evidence", { runId, error: err });
    }
    recordEvent(
      this.deps.db,
      this.deps.clock,
      "run_stalled",
      { goalId: run.goalId, runId },
      evidence,
    );
    this.deps.log.warn("worker stalled", { runId, quietMs: evidence.quietMs });
    this.stalled.add(runId);
    handle
      .interrupt()
      .catch((err) => this.deps.log.warn("interrupt failed", { runId, error: err }));
  }

  /** First stall: resume the Session once with a note. Again: ask the Coordinator. */
  private handleStall(goal: Goal, run: Run): void {
    const stalls = run.stalls + 1;
    if (stalls > 1) {
      this.raiseStrategy(goal, run, "it stalled again after Preston resumed it");
      return;
    }
    const { store, db } = this.deps;
    transaction(db, () => {
      store.updateRun(run.id, { state: "parked", stalls });
      store.setGoalState(goal.id, "recovering", { detail: "The worker went silent; resuming it." });
      store.addAttempt(goal.id, {
        runId: run.id,
        agent: run.agent,
        tactic: "stall_resume",
        reason: "it went silent",
      });
    });
    this.resumeRun(
      store.run(run.id),
      run.sessionId ? STALL_RESUME_PROMPT : renderBrief(goal.id, goal.brief),
    );
  }

  /** Raises one Coordinator event, or reports Blocked once strategy changes are used up. */
  private raiseStrategy(goal: Goal, run: Run, reason: string): void {
    const { store, db, clock } = this.deps;
    const raised = goal.attempts.filter((a) => a.tactic === "strategy_event").length;
    if (raised >= this.deps.config.get().supervision.maxStrategyChanges) {
      this.fail(
        goal,
        run,
        "blocked",
        `The worker keeps getting stuck (${reason}), and I've already changed approach ${raised === 1 ? "once" : `${raised} times`}. Tell me how you'd like to proceed.`,
      );
      return;
    }
    transaction(db, () => {
      store.updateRun(run.id, { state: "parked", stalls: run.stalls + 1, strategyPending: true });
      store.setGoalState(goal.id, "recovering", {
        detail: "Deciding how to continue after repeated stalls.",
      });
      store.addAttempt(goal.id, {
        runId: run.id,
        agent: run.agent,
        tactic: "strategy_event",
        reason,
      });
      recordEvent(db, clock, "strategy_needed", { goalId: goal.id, runId: run.id }, { reason });
    });
    this.deps.raiseGoalEvent({ goalId: goal.id, runId: run.id, detail: reason });
  }

  private lastAttempt(goalId: string, tactic: Attempt["tactic"]): Attempt | undefined {
    return this.deps.store
      .goal(goalId)
      .attempts.filter((a) => a.tactic === tactic)
      .at(-1);
  }

  // ---- Verification ------------------------------------------------------------------------

  private verify(goalId: string, runId: string): void {
    this.deps.store.setGoalState(goalId, "verifying");
    this.track(this.runVerification(goalId, runId), "verification failed", { goalId });
  }

  private async runVerification(goalId: string, runId: string): Promise<void> {
    const { store, config, clock, db } = this.deps;
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
    // The verification record and the transition it causes are one write: after a crash the
    // checks are either re-run from scratch or not at all, never recorded twice.
    const record = (patch: { fixAttempts?: number } = {}) => {
      store.addVerification({ goalId, runId, passed, results, startedAt, endedAt: isoNow(clock) });
      store.updateRun(runId, { reportPending: false, ...patch });
    };
    if (passed) {
      transaction(db, () => {
        record();
        this.complete(store.goal(goalId), store.run(runId), results, report);
      });
      return;
    }
    const evidence = failedChecksEvidence(results);
    if (run.fixAttempts < settings.maxFixAttempts) {
      transaction(db, () => {
        record({ fixAttempts: run.fixAttempts + 1 });
        recordEvent(db, clock, "checks_failed_resuming", { goalId, runId });
        store.setGoalState(goalId, "running");
      });
      this.resumeRun(store.run(runId), failedChecksPrompt(evidence));
      return;
    }
    transaction(db, () => {
      record();
      this.fail(
        goal,
        run,
        "failed",
        `My checks still fail after the worker tried to fix them:\n${evidence}`,
      );
    });
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
      store.updateRun(run.id, {
        state: "ended",
        endReason: result.state,
        quotaBucket: null,
        strategyPending: false,
      });
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

  /**
   * The agent for a new Goal: the first enabled one, or with balancing allowed, the first one
   * that is not out of quota.
   */
  private pickAgent(): AgentKind {
    const { agents } = this.deps.config.get();
    const usable = agents.enabled.filter((kind) => this.deps.adapter(kind));
    const first = usable[0];
    if (!first) {
      throw new ToolError("No coding agent is set up yet, so Preston cannot start work.");
    }
    if (!agents.balanceByQuota) return first;
    return usable.find((kind) => !this.deps.quota.activeBlock(kind)) ?? first;
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
