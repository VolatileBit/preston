import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Outbox } from "../channels/outbox.js";
import type { ChannelKind } from "../channels/types.js";
import { type Clock, isoNow, type Timer } from "../clock.js";
import type { ConfigManager } from "../config/config.js";
import type { GoalEvent } from "../goals/engine.js";
import { signInHow } from "../goals/messages.js";
import type { GoalStore } from "../goals/store.js";
import { errorMessage, type Logger } from "../log.js";
import { COORDINATOR_RUN_ID } from "../mcp/names.js";
import type { Tokens } from "../mcp/tools.js";
import { decide, nativeAction } from "../policy/approvals.js";
import { COORDINATOR_GUIDANCE } from "../prompts/coordinator.js";
import { GRILLING_GUIDANCE } from "../prompts/grilling.js";
import type { Questions } from "../questions/questions.js";
import { COORDINATOR_OWNER, type QuotaMonitor } from "../quota/monitor.js";
import type { Bucket } from "../quota/store.js";
import { formatResetTime } from "../quota/time.js";
import { type Db, transaction } from "../store/db.js";
import type { ProcessTracker } from "../supervisor/processes.js";
import { type Adapters, agentLabel } from "../workers/registry.js";
import type { AgentKind, McpLaunchSpec, RunHandle, WorkerEvent } from "../workers/types.js";
import type { Inbox } from "./inbox.js";
import { type CoordinatorInput, renderInput } from "./input.js";

/**
 * Coordinator defaults per agent (spec: Sonnet 5.5 / GPT-6.1 Sol, medium effort). Model IDs
 * must be validated against the adapter's `listModels()` once the real adapters are integrated.
 */
export const COORDINATOR_DEFAULTS: Partial<Record<AgentKind, { model: string; effort: string }>> = {
  claude: { model: "sonnet", effort: "medium" },
  codex: { model: "gpt-6.1-sol", effort: "medium" },
};

export interface ReplyTarget {
  channel: ChannelKind;
  conversationId: string;
  ref?: string;
}

/** The invocation in progress, visible to coordinator tools. */
export interface Invocation {
  input: CoordinatorInput;
  replyTo: ReplyTarget | undefined;
}

export interface CoordinatorDeps {
  db: Db;
  adapters: Adapters;
  config: ConfigManager;
  store: GoalStore;
  questions: Questions;
  outbox: Outbox;
  inbox: Inbox;
  quota: QuotaMonitor;
  processes: ProcessTracker;
  tokens: Tokens;
  clock: Clock;
  log: Logger;
  workdir: string;
  transcriptsDir: string;
  mcpLaunch(token: string): McpLaunchSpec;
  /** Goal events still waiting for a decision (raised again when the Coordinator can run). */
  pendingGoalEvents(): GoalEvent[];
  /** A Goal event invocation finished; the engine applies its fallback if nothing was decided. */
  goalEventHandled(event: GoalEvent): void;
}

type TurnEnd = Exclude<WorkerEvent, { type: "activity" | "message" | "exited" | "started" }>;

/**
 * Preston's reasoning step: one persistent agent Session, resumed with a new input per
 * invocation. Invocations are serialised. The final text answers the originating Channel;
 * for events nothing is sent except what the Coordinator sends through its tools.
 *
 * Owner messages come from the durable inbox and are marked handled only with their reply.
 * While the Coordinator's agent is out of quota (or signed out), messages wait there, answered
 * deterministically that they are queued, unless another agent the user allowed has headroom.
 */
export class Coordinator {
  private queue: Promise<void> = Promise.resolve();
  private active: Invocation | undefined;
  private handle: RunHandle | undefined;
  private stopping = false;
  private invocations = 0;
  /** Inbox messages and Goal events already queued in this process. */
  private queued = new Set<string>();
  private retries = new Set<Timer>();

  constructor(private readonly deps: CoordinatorDeps) {}

  submit(input: CoordinatorInput, options: { probe?: boolean } = {}): boolean {
    const key = queueKey(input);
    if (key) {
      if (this.queued.has(key)) return false;
      this.queued.add(key);
    }
    this.queue = this.queue
      .then(() => this.invoke(input, options.probe ?? false))
      .catch((err) => this.deps.log.error("coordinator invocation failed", { error: err }))
      .finally(() => {
        if (key) this.queued.delete(key);
      });
    return true;
  }

  /**
   * Submits everything still waiting: unhandled inbox messages (oldest first) and Goal events.
   * With `probe`, only the oldest item, to find out whether the agent has quota again.
   */
  resume(probe = false): boolean {
    if (this.stopping) return false;
    const inputs: CoordinatorInput[] = [
      ...this.deps.inbox.pending().map(
        (m): CoordinatorInput => ({
          kind: "message",
          message: m.message,
          inboundId: m.id,
          replayed: m.attempts > 0,
        }),
      ),
      ...this.deps.pendingGoalEvents().map((e): CoordinatorInput => ({ kind: "goal_event", ...e })),
    ];
    let submitted = false;
    for (const input of probe ? inputs.slice(0, 1) : inputs) {
      submitted = this.submit(input, { probe }) || submitted;
    }
    return submitted;
  }

  current(): Invocation | undefined {
    return this.active;
  }

  /** Resolves when every submitted invocation has finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.retries) timer.cancel();
    await this.handle?.interrupt();
    await this.queue;
  }

  private async invoke(input: CoordinatorInput, probe: boolean): Promise<void> {
    if (this.stopping) return;
    const { config, questions, store, tokens, log, quota } = this.deps;
    if (input.kind === "message" && input.inboundId !== undefined) {
      if (!this.deps.inbox.get(input.inboundId)) return; // Handled meanwhile.
    }
    const question =
      input.kind === "worker_question" ? questions.find(input.questionId) : undefined;
    if (input.kind === "worker_question" && question?.state !== "pending_coordinator") return;

    const replyTo = replyTarget(input);
    const settings = config.get().coordinator;
    const primary = settings.agent;
    if (!primary || !this.deps.adapters.get(primary)) {
      this.answer(
        input,
        replyTo,
        "I don't have an agent to think with yet. Run `preston` in a terminal to finish setting me up.",
      );
      this.escalateUnhandled(input);
      this.finishEvent(input);
      return;
    }

    let agent = primary;
    const block = quota.coordinatorBlock(primary);
    if (block && !probe) {
      const alternative = await this.alternative(primary);
      if (this.stopping) return;
      if (!alternative) {
        this.defer(input, replyTo, primary, block);
        return;
      }
      agent = alternative;
    }
    const adapter = this.deps.adapters.get(agent);
    if (!adapter) return;

    const token = tokens.mint({ role: "coordinator" });
    const resumeSessionId = store.latestSession("coordinator", agent);
    const prompt = renderInput(
      input,
      {
        time: isoNow(this.deps.clock),
        goals: store.listGoals({ finishedLimit: 3 }),
        openQuestions: questions.open(),
      },
      question,
    );
    const defaults = COORDINATOR_DEFAULTS[agent];
    const sameAgent = agent === primary;
    mkdirSync(this.deps.workdir, { recursive: true });
    if (input.kind === "message" && input.inboundId !== undefined) {
      this.deps.inbox.started(input.inboundId);
    }
    this.active = { input, replyTo };
    let end: TurnEnd | undefined;
    let tracking: Promise<void> = Promise.resolve();
    try {
      const handle = adapter.startRun({
        runId: COORDINATOR_RUN_ID,
        workdir: this.deps.workdir,
        prompt,
        resumeSessionId,
        appendSystemPrompt: `${COORDINATOR_GUIDANCE}\n\n${GRILLING_GUIDANCE}`,
        model: (sameAgent ? settings.model : undefined) ?? defaults?.model,
        effort: (sameAgent ? settings.effort : undefined) ?? defaults?.effort,
        mcp: this.deps.mcpLaunch(token),
        onApproval: async (request) =>
          decide(nativeAction(request), { workdir: this.deps.workdir }).decision,
        transcriptPath: join(
          this.deps.transcriptsDir,
          "coordinator",
          `invocation-${++this.invocations}.log`,
        ),
      });
      this.handle = handle;
      let trackedPid: number | undefined;
      const trackPid = () => {
        const pid = handle.processId?.();
        if (pid === undefined || pid === trackedPid) return;
        trackedPid = pid;
        tracking = this.deps.processes
          .track(COORDINATOR_OWNER, agent, pid)
          .catch((err) => log.warn("could not record the coordinator process", { error: err }));
      };
      trackPid();
      for await (const event of handle.events) {
        trackPid();
        if (event.type === "started") {
          store.recordSession(agent, event.sessionId, "coordinator", this.deps.workdir);
        } else if (event.type === "activity" || event.type === "message") {
          quota.progress(COORDINATOR_OWNER);
        } else if (event.type !== "exited") {
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
      this.active = undefined;
      this.handle = undefined;
      tokens.revoke(token);
      await tracking;
      // On shutdown the record stays: the next start verifies the process really is gone.
      if (!this.stopping) this.deps.processes.untrack(COORDINATOR_OWNER);
    }
    // An interrupted invocation leaves its message in the inbox, to be replayed on restart.
    if (this.stopping) return;

    switch (end?.type) {
      case "completed":
        quota.progress(COORDINATOR_OWNER);
        this.answer(input, replyTo, end.finalText.trim());
        if (!replyTo && end.finalText.trim())
          log.debug("coordinator event reply not sent", { kind: input.kind });
        break;
      case "quota_blocked": {
        log.warn("coordinator out of quota", {
          agent,
          bucket: end.bucket,
          kind: end.kind,
          resetsAt: end.resetsAt,
        });
        if (end.kind === "rate_limit") {
          quota.turnEnded(COORDINATOR_OWNER);
          this.retryLater(input);
          return;
        }
        const bucket = quota.runBlocked({
          owner: COORDINATOR_OWNER,
          agent,
          bucket: end.bucket,
          kind: end.kind,
          resetsAt: end.resetsAt,
          detail: end.detail,
        });
        this.defer(input, replyTo, agent, bucket);
        return;
      }
      case "auth_error": {
        log.warn("coordinator agent needs sign-in", { agent, detail: end.detail });
        const bucket = quota.authBroken({ owner: COORDINATOR_OWNER, agent, detail: end.detail });
        this.defer(input, replyTo, agent, bucket);
        return;
      }
      default:
        quota.turnEnded(COORDINATOR_OWNER);
        log.warn("coordinator turn did not complete", { end: end?.type });
        this.answer(
          input,
          replyTo,
          "Something went wrong on my side while thinking about that. Please try again in a moment.",
        );
    }
    this.escalateUnhandled(input);
    this.finishEvent(input);
  }

  /** Another agent the user allowed Preston to balance onto, with quota headroom now. */
  private async alternative(primary: AgentKind): Promise<AgentKind | undefined> {
    const { agents } = this.deps.config.get();
    if (!agents.balanceByQuota) return undefined;
    for (const agent of agents.enabled) {
      if (agent === primary || !this.deps.adapters.get(agent)) continue;
      if (this.deps.quota.coordinatorBlock(agent)) continue;
      if (await this.deps.quota.headroom(agent)) return agent;
    }
    return undefined;
  }

  /**
   * The Coordinator's agent cannot run now. Messages stay in the inbox and get a deterministic
   * "queued" reply once; Worker questions go straight to the user; Goal events wait.
   */
  private defer(
    input: CoordinatorInput,
    replyTo: ReplyTarget | undefined,
    agent: AgentKind,
    bucket: Bucket,
  ): void {
    if (input.kind === "message" && replyTo) {
      this.deps.outbox.enqueue({
        channel: replyTo.channel,
        conversationId: replyTo.conversationId,
        kind: "reply",
        text: queuedText(agent, bucket, this.deps.clock.now()),
        replyTo: replyTo.ref,
        dedupeKey: input.inboundId !== undefined ? `queued:${input.inboundId}` : undefined,
      });
    } else if (input.kind === "setup" && replyTo) {
      this.reply(replyTo, queuedText(agent, bucket, this.deps.clock.now()));
    }
    this.escalateUnhandled(input);
  }

  /** A brief rate limit: try the same input again shortly; it is still durable meanwhile. */
  private retryLater(input: CoordinatorInput): void {
    const timer = this.deps.clock.setTimeout(() => {
      this.retries.delete(timer);
      if (!this.stopping) this.submit(input);
    }, this.deps.config.get().quota.rateLimitWaitMs);
    this.retries.add(timer);
  }

  private finishEvent(input: CoordinatorInput): void {
    if (input.kind === "goal_event") this.deps.goalEventHandled(input);
  }

  /** A Worker question the Coordinator could not handle goes to the user as asked. */
  private escalateUnhandled(input: CoordinatorInput): void {
    if (input.kind !== "worker_question") return;
    const question = this.deps.questions.find(input.questionId);
    if (question?.state === "pending_coordinator") {
      this.deps.log.info("escalating unhandled worker question", { questionId: question.id });
      this.deps.questions.escalate(question.id, question.text);
    }
  }

  /** Sends the reply (if any) and marks an inbox message handled, in one write. */
  private answer(input: CoordinatorInput, target: ReplyTarget | undefined, text: string): void {
    const inboundId = input.kind === "message" ? input.inboundId : undefined;
    transaction(this.deps.db, () => {
      if (target && text) {
        this.reply(target, text, inboundId !== undefined ? `reply:${inboundId}` : undefined);
      }
      if (inboundId !== undefined) this.deps.inbox.handled(inboundId);
    });
  }

  private reply(target: ReplyTarget, text: string, dedupeKey?: string): void {
    this.deps.outbox.enqueue({
      channel: target.channel,
      conversationId: target.conversationId,
      kind: "reply",
      text,
      replyTo: target.ref,
      dedupeKey,
    });
  }
}

/** The deterministic reply while the Coordinator's own agent cannot think. */
function queuedText(agent: AgentKind, bucket: Bucket, now: number): string {
  const who = agentLabel(agent);
  const fixed = "You can still say status, stop, pause or resume.";
  switch (bucket.state) {
    case "auth_broken":
      return `${who}, the agent I think with, needs you to sign in again. ${signInHow(agent)} I'll answer this once you have. ${fixed}`;
    case "spend_blocked":
      return `${who}, the agent I think with, has reached its spending limit, so I'll answer this when it has quota again. I won't buy credits. ${fixed}`;
    default: {
      const until =
        bucket.resetsAt && Date.parse(bucket.resetsAt) > now
          ? ` until ${formatResetTime(bucket.resetsAt, now)}`
          : "";
      return `My own agent (${who}) is out of quota${until}, so I'll answer this when it's back. ${fixed}`;
    }
  }
}

function queueKey(input: CoordinatorInput): string | undefined {
  if (input.kind === "message" && input.inboundId !== undefined) return `m:${input.inboundId}`;
  if (input.kind === "goal_event") return `e:${input.runId}`;
  return undefined;
}

function replyTarget(input: CoordinatorInput): ReplyTarget | undefined {
  switch (input.kind) {
    case "message":
      return {
        channel: input.message.channel,
        conversationId: input.message.conversationId,
        ref: input.message.ref,
      };
    case "setup":
      return { channel: input.channel, conversationId: input.conversationId };
    case "worker_question":
    case "goal_event":
      return undefined;
  }
}
