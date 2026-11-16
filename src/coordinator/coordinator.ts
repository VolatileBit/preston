import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Outbox } from "../channels/outbox.js";
import type { ChannelKind } from "../channels/types.js";
import { type Clock, isoNow } from "../clock.js";
import type { ConfigManager } from "../config/config.js";
import type { GoalStore } from "../goals/store.js";
import { errorMessage, type Logger } from "../log.js";
import { COORDINATOR_RUN_ID } from "../mcp/names.js";
import type { Tokens } from "../mcp/tools.js";
import { decide, nativeAction } from "../policy/approvals.js";
import type { Approval } from "../policy/escalations.js";
import { COORDINATOR_GUIDANCE } from "../prompts/coordinator.js";
import { GRILLING_GUIDANCE } from "../prompts/grilling.js";
import type { Questions } from "../questions/questions.js";
import type { ModelCatalog } from "../workers/models.js";
import { type Adapters, agentLabel } from "../workers/registry.js";
import type { McpLaunchSpec, RunHandle, WorkerEvent } from "../workers/types.js";
import { type CoordinatorInput, renderInput } from "./input.js";

export { COORDINATOR_DEFAULTS } from "../workers/models.js";

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
  adapters: Adapters;
  config: ConfigManager;
  store: GoalStore;
  questions: Questions;
  outbox: Outbox;
  tokens: Tokens;
  clock: Clock;
  log: Logger;
  workdir: string;
  transcriptsDir: string;
  mcpLaunch(token: string): McpLaunchSpec;
  models: ModelCatalog;
  /** An escalated approval and the Brief authority it is judged against. */
  approval(id: string): { approval: Approval; authority: string } | undefined;
}

/**
 * Preston's reasoning step: one persistent agent Session, resumed with a new input per
 * invocation. Invocations are serialised. The final text answers the originating Channel;
 * for events nothing is sent except what the Coordinator sends through its tools.
 */
export class Coordinator {
  private queue: Promise<void> = Promise.resolve();
  private active: Invocation | undefined;
  private handle: RunHandle | undefined;
  private stopping = false;
  private invocations = 0;

  constructor(private readonly deps: CoordinatorDeps) {}

  submit(input: CoordinatorInput): void {
    this.queue = this.queue
      .then(() => this.invoke(input))
      .catch((err) => this.deps.log.error("coordinator invocation failed", { error: err }));
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
    await this.handle?.interrupt();
    await this.queue;
  }

  private async invoke(input: CoordinatorInput): Promise<void> {
    if (this.stopping) return;
    const { config, questions, store, tokens, log } = this.deps;
    const approval = input.kind === "approval" ? this.deps.approval(input.approvalId) : undefined;
    const question =
      input.kind === "worker_question"
        ? questions.find(input.questionId)
        : approval
          ? questions.find(approval.approval.questionId)
          : undefined;
    if (input.kind === "worker_question" && question?.state !== "pending_coordinator") return;
    if (
      input.kind === "approval" &&
      (approval?.approval.state !== "pending" || question?.state !== "pending_coordinator")
    ) {
      return;
    }

    const replyTo = replyTarget(input);
    const settings = config.get().coordinator;
    const agent = settings.agent;
    const adapter = agent ? this.deps.adapters.get(agent) : undefined;
    if (!agent || !adapter) {
      this.reply(
        replyTo,
        "I don't have an agent to think with yet. Run `preston` in a terminal to finish setting me up.",
      );
      this.escalateUnhandled(input);
      return;
    }

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
      approval,
    );
    const { model, effort } = await this.deps.models.coordinator(agent, settings);
    mkdirSync(this.deps.workdir, { recursive: true });
    this.active = { input, replyTo };
    let end: WorkerEvent | undefined;
    try {
      this.handle = adapter.startRun({
        runId: COORDINATOR_RUN_ID,
        workdir: this.deps.workdir,
        prompt,
        resumeSessionId,
        appendSystemPrompt: `${COORDINATOR_GUIDANCE}\n\n${GRILLING_GUIDANCE}`,
        model,
        effort,
        mcp: this.deps.mcpLaunch(token),
        onApproval: async (request) =>
          decide(nativeAction(request), { workdir: this.deps.workdir }).decision,
        transcriptPath: join(
          this.deps.transcriptsDir,
          "coordinator",
          `invocation-${++this.invocations}.log`,
        ),
      });
      for await (const event of this.handle.events) {
        if (event.type === "started")
          store.recordSession(agent, event.sessionId, "coordinator", this.deps.workdir);
        else if (event.type !== "activity" && event.type !== "message" && event.type !== "exited")
          end ??= event;
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
    }
    if (this.stopping) return;

    switch (end?.type) {
      case "completed":
        if (replyTo && end.finalText.trim()) this.reply(replyTo, end.finalText.trim());
        else if (!replyTo && end.finalText.trim())
          log.debug("coordinator event reply not sent", { kind: input.kind });
        break;
      case "quota_blocked": {
        const until = end.resetsAt ? ` until about ${new Date(end.resetsAt).toUTCString()}` : "";
        log.warn("coordinator out of quota", { bucket: end.bucket, resetsAt: end.resetsAt });
        this.reply(
          replyTo,
          `My own agent (${agentLabel(agent)}) is out of quota${until}, so I can't think this through right now. Your Goals keep going, and you can still say status, stop, pause or resume.`,
        );
        break;
      }
      case "auth_error":
        log.warn("coordinator agent needs sign-in", { detail: end.detail });
        this.reply(
          replyTo,
          `${agentLabel(agent)} needs you to sign in again before I can think this through. You can still say status, stop, pause or resume.`,
        );
        break;
      default:
        log.warn("coordinator turn did not complete", { end: end?.type });
        this.reply(
          replyTo,
          "Something went wrong on my side while thinking about that. Please try again in a moment.",
        );
    }
    this.escalateUnhandled(input);
  }

  /** A Worker question or approval the Coordinator could not handle goes to the user as asked. */
  private escalateUnhandled(input: CoordinatorInput): void {
    if (input.kind === "approval") {
      const approval = this.deps.approval(input.approvalId)?.approval;
      const question = approval && this.deps.questions.find(approval.questionId);
      if (approval?.state !== "pending" || question?.state !== "pending_coordinator") return;
      this.deps.log.info("escalating unhandled approval", { approvalId: approval.id });
      this.deps.questions.escalate(
        question.id,
        `A Worker wants to ${approval.summary}, which needs your approval because ${approval.policyReason}. Shall I allow it? Reply yes or no.`,
      );
      return;
    }
    if (input.kind !== "worker_question") return;
    const question = this.deps.questions.find(input.questionId);
    if (question?.state === "pending_coordinator") {
      this.deps.log.info("escalating unhandled worker question", { questionId: question.id });
      this.deps.questions.escalate(question.id, question.text);
    }
  }

  private reply(target: ReplyTarget | undefined, text: string): void {
    if (!target) return;
    this.deps.outbox.enqueue({
      channel: target.channel,
      conversationId: target.conversationId,
      kind: "reply",
      text,
      replyTo: target.ref,
    });
  }
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
    case "approval":
      return undefined;
  }
}
