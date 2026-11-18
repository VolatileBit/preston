import type { ChannelHub } from "../channels/hub.js";
import type { Outbox } from "../channels/outbox.js";
import type { ChannelKind } from "../channels/types.js";
import { type Clock, isoNow } from "../clock.js";
import { pick } from "../i18n/index.js";
import type { Logger } from "../log.js";
import { all, type Db, one, run } from "../store/db.js";
import { newId } from "../util/ids.js";

/**
 * `pending_coordinator`: a Worker asked; the Coordinator has not answered or escalated yet.
 * `pending_human`: sent to every Channel; the first answer wins.
 */
export type QuestionState = "pending_coordinator" | "pending_human" | "answered" | "cancelled";

export interface Question {
  id: string;
  goalId: string | null;
  runId: string | null;
  askedBy: "worker" | "coordinator";
  /** The question as asked (a Worker's words are untrusted data). */
  text: string;
  /** The plain-language version sent to the user. */
  humanText: string | null;
  state: QuestionState;
  answer: string | null;
  answeredBy: "coordinator" | "human" | null;
  answeredVia: ChannelKind | null;
  /** The answer has reached the Worker (in the tool result or a resumed turn). */
  answerDelivered: boolean;
  createdAt: string;
}

export type WaitResult = { answer: string } | { parked: true };

interface QuestionRow {
  id: string;
  goal_id: string | null;
  run_id: string | null;
  asked_by: Question["askedBy"];
  text: string;
  human_text: string | null;
  state: QuestionState;
  answer: string | null;
  answered_by: Question["answeredBy"];
  answered_via: ChannelKind | null;
  answer_delivered: number;
  created_at: string;
}

export interface QuestionsDeps {
  db: Db;
  clock: Clock;
  outbox: Outbox;
  hub: ChannelHub;
  log: Logger;
  /** Short name of a Goal for messages, e.g. its objective. */
  goalName(goalId: string): string | undefined;
}

/** Questions from Workers and the Coordinator, their fan-out to Channels, and their answers. */
export class Questions {
  private waiters = new Map<string, (result: WaitResult) => void>();
  private answeredListeners: ((question: Question) => void)[] = [];

  constructor(private readonly deps: QuestionsDeps) {}

  onAnswered(listener: (question: Question) => void): void {
    this.answeredListeners.push(listener);
  }

  askFromWorker(runId: string, goalId: string, text: string): Question {
    const id = newId("q");
    run(
      this.deps.db,
      `INSERT INTO questions (id, goal_id, run_id, asked_by, text, state, created_at)
       VALUES (:id, :goal, :run, 'worker', :text, 'pending_coordinator', :at)`,
      { id, goal: goalId, run: runId, text, at: this.now() },
    );
    return this.get(id);
  }

  /**
   * Waits for the Coordinator to answer. Resolves `parked` when the question goes to the user
   * or the wait times out; the answer then reaches the Worker in a resumed turn.
   */
  waitForAnswer(id: string, timeoutMs: number): Promise<WaitResult> {
    const current = this.get(id);
    if (current.state === "answered" && current.answer !== null) {
      this.markDelivered([id]);
      return Promise.resolve({ answer: current.answer });
    }
    if (current.state !== "pending_coordinator") return Promise.resolve({ parked: true });
    return new Promise((resolve) => {
      const timer = this.deps.clock.setTimeout(() => finish({ parked: true }), timeoutMs);
      const finish = (result: WaitResult) => {
        timer.cancel();
        this.waiters.delete(id);
        resolve(result);
      };
      this.waiters.set(id, finish);
    });
  }

  /** Sends a Worker's question to the user, in plain language. */
  escalate(id: string, humanText: string): Question {
    const question = this.get(id);
    if (question.state !== "pending_coordinator") {
      throw new Error(`Question ${id} is ${describeState(question.state)}.`);
    }
    run(
      this.deps.db,
      "UPDATE questions SET state = 'pending_human', human_text = :human, escalated_at = :at WHERE id = :id",
      { id, human: humanText, at: this.now() },
    );
    this.waiters.get(id)?.({ parked: true });
    this.fanOut(this.get(id));
    return this.get(id);
  }

  /** A question the Coordinator itself needs the user to answer. */
  askHuman(text: string, goalId?: string): Question {
    const id = newId("q");
    const at = this.now();
    run(
      this.deps.db,
      `INSERT INTO questions (id, goal_id, asked_by, text, human_text, state, created_at, escalated_at)
       VALUES (:id, :goal, 'coordinator', :text, :text, 'pending_human', :at, :at)`,
      { id, goal: goalId ?? null, text, at },
    );
    const question = this.get(id);
    this.fanOut(question);
    return question;
  }

  /**
   * Records an answer. The first answer wins; afterwards other Channels that support
   * reactions get the question marked as answered, and nothing else is sent.
   */
  answer(
    id: string,
    answer: string,
    via: ChannelKind | undefined,
  ): { ok: true; question: Question } | { ok: false; reason: string } {
    const question = this.find(id);
    if (!question) return { ok: false, reason: `There is no question ${id}.` };
    const answeredBy = question.state === "pending_human" ? "human" : "coordinator";
    const changed = run(
      this.deps.db,
      `UPDATE questions SET state = 'answered', answer = :answer, answered_by = :by, answered_via = :via, answered_at = :at
       WHERE id = :id AND state IN ('pending_coordinator', 'pending_human')`,
      {
        id,
        answer,
        by: answeredBy,
        via: answeredBy === "human" ? (via ?? null) : null,
        at: this.now(),
      },
    );
    if (changed === 0)
      return { ok: false, reason: `Question ${id} is ${describeState(question.state)}.` };
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.markDelivered([id]);
      waiter({ answer });
    }
    this.settleDeliveries(id, answeredBy === "human" ? via : undefined);
    const answered = this.get(id);
    for (const listener of this.answeredListeners) listener(answered);
    return { ok: true, question: answered };
  }

  open(): Question[] {
    return all<QuestionRow>(
      this.deps.db,
      "SELECT * FROM questions WHERE state IN ('pending_coordinator', 'pending_human') ORDER BY created_at, rowid",
    ).map(toQuestion);
  }

  /** Questions a Worker asked since a time (ISO), oldest first. */
  askedSince(sinceIso: string): Question[] {
    return all<QuestionRow>(
      this.deps.db,
      "SELECT * FROM questions WHERE asked_by = 'worker' AND created_at >= :since ORDER BY created_at, rowid",
      { since: sinceIso },
    ).map(toQuestion);
  }

  /** Open questions and answers not yet delivered, for one Run. */
  forRun(runId: string): { open: Question[]; undelivered: Question[] } {
    const rows = all<QuestionRow>(
      this.deps.db,
      `SELECT * FROM questions WHERE run_id = :run AND
         (state IN ('pending_coordinator', 'pending_human') OR (state = 'answered' AND answer_delivered = 0))
       ORDER BY created_at, rowid`,
      { run: runId },
    ).map(toQuestion);
    return {
      open: rows.filter((q) => q.state !== "answered"),
      undelivered: rows.filter((q) => q.state === "answered"),
    };
  }

  markDelivered(ids: string[]): void {
    for (const id of ids) {
      run(this.deps.db, "UPDATE questions SET answer_delivered = 1 WHERE id = :id", { id });
    }
  }

  /** Withdraws a Goal's open questions (the Goal ended). */
  cancelForGoal(goalId: string): void {
    const open = all<{ id: string }>(
      this.deps.db,
      "SELECT id FROM questions WHERE goal_id = :goal AND state IN ('pending_coordinator', 'pending_human')",
      { goal: goalId },
    );
    for (const { id } of open) {
      run(this.deps.db, "UPDATE questions SET state = 'cancelled' WHERE id = :id", { id });
      this.waiters.get(id)?.({ parked: true });
      this.settleDeliveries(id, undefined);
    }
  }

  /** Ends every pending wait as parked (Preston is shutting down). */
  releaseWaiters(): void {
    for (const finish of [...this.waiters.values()]) finish({ parked: true });
  }

  find(id: string): Question | undefined {
    const row = one<QuestionRow>(this.deps.db, "SELECT * FROM questions WHERE id = :id", { id });
    return row ? toQuestion(row) : undefined;
  }

  get(id: string): Question {
    const question = this.find(id);
    if (!question) throw new Error(`There is no question ${id}.`);
    return question;
  }

  private fanOut(question: Question): void {
    const goal = question.goalId ? this.deps.goalName(question.goalId) : undefined;
    const text = goal
      ? pick({
          en: `Preston needs your decision on "${goal}":\n${question.humanText ?? question.text}`,
          "zh-CN": `Preston 需要您就“${goal}”做个决定：\n${question.humanText ?? question.text}`,
        })
      : pick({
          en: `Preston needs your decision:\n${question.humanText ?? question.text}`,
          "zh-CN": `Preston 需要您做个决定：\n${question.humanText ?? question.text}`,
        });
    this.deps.outbox.broadcast({
      kind: "question",
      text,
      goalId: question.goalId ?? undefined,
      questionId: question.id,
      dedupeKey: `question:${question.id}`,
    });
    this.deps.log.info("question sent to all Channels", { questionId: question.id });
  }

  /** Stops undelivered copies and marks delivered ones answered where Channels can react. */
  private settleDeliveries(id: string, answeredVia: ChannelKind | undefined): void {
    const { outbox, hub, log } = this.deps;
    outbox.cancelQuestion(id);
    for (const delivery of outbox.deliveredQuestion(id)) {
      outbox.markAnsweredRecorded(delivery.id);
      if (delivery.channel === answeredVia) continue;
      const channel = hub.get(delivery.channel);
      if (!channel?.capabilities.reactions || !channel.markAnswered) continue;
      channel
        .markAnswered(delivery.ref)
        .catch((err) =>
          log.warn("could not mark question answered", { channel: delivery.channel, error: err }),
        );
    }
  }

  private now(): string {
    return isoNow(this.deps.clock);
  }
}

function describeState(state: QuestionState): string {
  switch (state) {
    case "answered":
      return "already answered";
    case "cancelled":
      return "no longer needed";
    case "pending_human":
      return "already waiting for the user";
    case "pending_coordinator":
      return "waiting for an answer";
  }
}

function toQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    goalId: row.goal_id,
    runId: row.run_id,
    askedBy: row.asked_by,
    text: row.text,
    humanText: row.human_text,
    state: row.state,
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredVia: row.answered_via,
    answerDelivered: row.answer_delivered === 1,
    createdAt: row.created_at,
  };
}
