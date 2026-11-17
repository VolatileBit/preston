import type { Clock, Timer } from "../clock.js";
import { isoNow } from "../clock.js";
import type { Config } from "../config/schema.js";
import { pick } from "../i18n/index.js";
import { errorMessage, type Logger } from "../log.js";
import { all, type Db, one, run } from "../store/db.js";
import type { ChannelHub } from "./hub.js";
import type { ChannelKind, DeliveryResult, OutboundFile, OutboundKind } from "./types.js";

export interface OutboxItem {
  channel: ChannelKind;
  conversationId?: string | undefined;
  kind: OutboundKind;
  text: string;
  replyTo?: string | undefined;
  goalId?: string | undefined;
  questionId?: string | undefined;
  /** Files to send with the text (the text may then be empty). */
  files?: OutboundFile[] | undefined;
  /** Do not deliver before this time (ms since the epoch): a message held on purpose. */
  holdUntilMs?: number | undefined;
  /** Enqueuing the same key twice delivers once, including across restarts. */
  dedupeKey?: string | undefined;
}

/** After this many failed tries a message's files are dropped and its text goes alone. */
const FILE_FALLBACK_ATTEMPTS = 3;

interface OutboxRow {
  id: number;
  channel: ChannelKind;
  conversation_id: string | null;
  kind: OutboundKind;
  text: string;
  reply_to: string | null;
  files: string | null;
  attempts: number;
  next_attempt_at: string;
}

/**
 * Durable delivery of every outgoing message. Items are attempted only while their Channel is
 * connected, in order per Channel, with exponential backoff on failure. A failed delivery is
 * recorded and never propagates to the caller (so it can never fail a Goal).
 */
export class Outbox {
  private timer: Timer | undefined;
  private flushing: Promise<void> | undefined;
  private again = false;
  private stopped = true;

  constructor(
    private readonly db: Db,
    private readonly hub: ChannelHub,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly settings: () => Config["outbox"],
    /** Masks secrets in every message before it is stored or sent (never echo a token). */
    private readonly redact: (text: string) => string = (text) => text,
  ) {
    hub.onConnected(() => this.kick());
  }

  start(): void {
    this.stopped = false;
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    await this.flushing;
  }

  /** Records an item for delivery. Returns false when the dedupe key was already used. */
  enqueue(item: OutboxItem): boolean {
    const at = isoNow(this.clock);
    const changes = run(
      this.db,
      `INSERT OR IGNORE INTO outbox (dedupe_key, channel, conversation_id, kind, text, reply_to, goal_id, question_id, files, state, next_attempt_at, created_at)
       VALUES (:key, :channel, :conversation, :kind, :text, :replyTo, :goal, :question, :files, 'pending', :due, :at)`,
      {
        key: item.dedupeKey ?? null,
        channel: item.channel,
        conversation: item.conversationId ?? null,
        kind: item.kind,
        text: this.redact(item.text),
        replyTo: item.replyTo ?? null,
        goal: item.goalId ?? null,
        question: item.questionId ?? null,
        files: item.files?.length ? JSON.stringify(item.files) : null,
        at,
        due: item.holdUntilMs === undefined ? at : new Date(item.holdUntilMs).toISOString(),
      },
    );
    if (changes > 0) this.kick();
    return changes > 0;
  }

  /** Sends the same message to every registered Channel's default conversation. */
  broadcast(item: Omit<OutboxItem, "channel" | "conversationId" | "replyTo">): void {
    for (const channel of this.hub.kinds()) {
      this.enqueue({
        ...item,
        channel,
        dedupeKey: item.dedupeKey ? `${item.dedupeKey}:${channel}` : undefined,
      });
    }
  }

  /**
   * Withdraws a Goal's own standard outcome message that has not been sent yet (the Coordinator
   * told the user in its own words). Returns how many were withdrawn.
   */
  cancelOutcome(goalId: string): number {
    return run(
      this.db,
      "UPDATE outbox SET state = 'cancelled' WHERE goal_id = :g AND kind = 'outcome' AND state = 'pending' AND attempts = 0",
      { g: goalId },
    );
  }

  /** Withdraws undelivered copies of a question (it was answered elsewhere). */
  cancelQuestion(questionId: string): void {
    run(
      this.db,
      "UPDATE outbox SET state = 'cancelled' WHERE question_id = :q AND state = 'pending'",
      { q: questionId },
    );
  }

  /** Delivered copies of a question that have not been marked answered yet. */
  deliveredQuestion(questionId: string): { id: number; channel: ChannelKind; ref: string }[] {
    return all<{ id: number; channel: ChannelKind; delivered_ref: string }>(
      this.db,
      `SELECT id, channel, delivered_ref FROM outbox
       WHERE question_id = :q AND state = 'delivered' AND delivered_ref IS NOT NULL AND marked_answered = 0`,
      { q: questionId },
    ).map((r) => ({ id: r.id, channel: r.channel, ref: r.delivered_ref }));
  }

  markAnsweredRecorded(id: number): void {
    run(this.db, "UPDATE outbox SET marked_answered = 1 WHERE id = :id", { id });
  }

  /** Schedules a delivery pass soon. */
  kick(): void {
    if (this.stopped) return;
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.flushing = this.flush().finally(() => {
      this.flushing = undefined;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  private async flush(): Promise<void> {
    await Promise.resolve();
    const now = isoNow(this.clock);
    const due = all<OutboxRow>(this.db, "SELECT * FROM outbox WHERE state = 'pending' ORDER BY id");
    const blocked = new Set<ChannelKind>();
    for (const item of due) {
      if (this.stopped) return;
      if (blocked.has(item.channel)) continue;
      // A message held on purpose (not tried yet) waits without holding anything back.
      if (item.next_attempt_at > now && item.attempts === 0) continue;
      // Preserve order per Channel: a retry waiting for its backoff holds back the ones after it.
      if (item.next_attempt_at > now || !this.hub.isConnected(item.channel)) {
        blocked.add(item.channel);
        continue;
      }
      if (!(await this.deliver(item))) blocked.add(item.channel);
    }
    this.scheduleNext();
  }

  private async deliver(item: OutboxRow): Promise<boolean> {
    const channel = this.hub.get(item.channel);
    let result: DeliveryResult;
    if (!channel) {
      result = { status: "failed", error: "Channel is not registered", retryable: false };
    } else {
      try {
        result = await channel.send({
          conversationId: item.conversation_id ?? undefined,
          text: item.text,
          kind: item.kind,
          replyTo: item.reply_to ?? undefined,
          ...(item.files ? { files: JSON.parse(item.files) as OutboundFile[] } : {}),
        });
      } catch (err) {
        result = { status: "failed", error: errorMessage(err), retryable: true };
      }
    }
    if (result.status === "delivered") {
      run(
        this.db,
        "UPDATE outbox SET state = 'delivered', delivered_ref = :ref, delivered_at = :at, attempts = attempts + 1 WHERE id = :id",
        { id: item.id, ref: result.ref ?? null, at: isoNow(this.clock) },
      );
      return true;
    }
    const settings = this.settings();
    const attempts = item.attempts + 1;
    const giveUp = !result.retryable || attempts >= settings.maxAttempts;
    // A file that will not go must not hold back the messages behind it, or leave the user
    // hearing nothing: send the text with a note instead, right away.
    if (item.files && (giveUp || attempts >= FILE_FALLBACK_ATTEMPTS)) {
      this.dropFiles(item, result.error);
      return false;
    }
    const delay =
      result.retryAfterMs ??
      Math.min(settings.baseDelayMs * 2 ** (attempts - 1), settings.maxDelayMs);
    run(
      this.db,
      `UPDATE outbox SET attempts = :attempts, last_error = :error, state = :state, next_attempt_at = :next
       WHERE id = :id AND state = 'pending'`,
      {
        id: item.id,
        attempts,
        error: result.error,
        state: giveUp ? "failed" : "pending",
        next: new Date(this.clock.now() + delay).toISOString(),
      },
    );
    this.log.warn("delivery failed", {
      id: item.id,
      channel: item.channel,
      attempts,
      error: result.error,
      gaveUp: giveUp,
    });
    return false;
  }

  /** Replaces an item's files by a note that they could not be sent, and retries it at once. */
  private dropFiles(item: OutboxRow, error: string): void {
    const names = (JSON.parse(item.files ?? "[]") as OutboundFile[]).map((f) => f.name).join(", ");
    const note = pick({
      en: `(I couldn't send ${names}: ${error} It is still on your computer.)`,
      "zh-CN": `（我没能发送 ${names}：${error} 文件仍在您的电脑上。）`,
    });
    run(
      this.db,
      `UPDATE outbox SET files = NULL, text = :text, attempts = :attempts, last_error = :error, next_attempt_at = :at
       WHERE id = :id AND state = 'pending'`,
      {
        id: item.id,
        text: item.text ? `${item.text}\n\n${note}` : note,
        attempts: item.attempts + 1,
        error,
        at: isoNow(this.clock),
      },
    );
    this.log.warn("could not send files; sending the text without them", {
      id: item.id,
      channel: item.channel,
      error,
    });
    this.again = true;
  }

  private scheduleNext(): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped) return;
    // Items already due wait for their Channel to connect, which kicks the outbox.
    const next = one<{ at: string | null }>(
      this.db,
      "SELECT MIN(next_attempt_at) AS at FROM outbox WHERE state = 'pending' AND next_attempt_at > :now",
      { now: isoNow(this.clock) },
    )?.at;
    if (!next) return;
    const delay = Date.parse(next) - this.clock.now();
    this.timer = this.clock.setTimeout(() => this.kick(), delay);
  }
}
