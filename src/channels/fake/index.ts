import { randomBytes } from "node:crypto";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ChannelKind,
  DeliveryResult,
  OutboundMessage,
} from "../types.js";

export interface FakeChannelOptions {
  /** Which kind this fake stands in for; one Channel per kind can be registered. */
  kind?: ChannelKind;
  reactions?: boolean;
  proactive?: ChannelCapabilities["proactive"];
  /** The largest attachment this fake accepts. Default 1 MB. */
  maxFileBytes?: number;
}

export interface SentMessage extends OutboundMessage {
  ref: string;
}

type Failure = { error: string; retryable: boolean; retryAfterMs?: number };

/**
 * A Channel for tests: delivers owner and non-owner messages, records what Preston sends
 * (including reactions), and can be told to fail deliveries.
 */
export class FakeChannel implements Channel {
  readonly kind: ChannelKind;
  readonly capabilities: ChannelCapabilities;
  readonly sent: SentMessage[] = [];
  /** Refs passed to `markAnswered`. */
  readonly reactions: string[] = [];
  /** Refs of the owner's messages Preston marked as read. */
  readonly acknowledged: string[] = [];
  /** Every `setTyping` call, in order. */
  readonly typing: { conversationId: string; typing: boolean }[] = [];
  /** Delivery attempts, including failed ones. */
  attempts = 0;
  private ctx: ChannelContext | undefined;
  private failures: Failure[] = [];
  private failAll: Failure | undefined;
  private failWithFiles: Failure | undefined;
  private seq = 0;
  /** Native refs are unique across instances, as a real service's are across restarts. */
  private readonly tag = randomBytes(3).toString("hex");

  constructor(options: FakeChannelOptions = {}) {
    this.kind = options.kind ?? "fake";
    this.capabilities = {
      reactions: options.reactions ?? true,
      proactive: options.proactive ?? "always",
      files: { maxBytes: options.maxFileBytes ?? 1024 * 1024, maxCount: 10 },
    };
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.ctx = ctx;
    ctx.setStatus("connected");
  }

  async stop(): Promise<void> {
    this.ctx?.setStatus("disconnected");
    this.ctx = undefined;
  }

  /** Simulates the user (or, with `owner: false`, someone else) sending a message. */
  /** With `ref`, simulates the service delivering the same native message again. */
  receive(
    text: string,
    options: { owner?: boolean; senderId?: string; ref?: string } = {},
  ): string {
    if (!this.ctx) throw new Error(`${this.kind} fake Channel is not started`);
    const ref = options.ref ?? `${this.kind}-in-${this.tag}-${++this.seq}`;
    const owner = options.owner ?? true;
    this.ctx.onMessage({
      channel: this.kind,
      conversationId: `${this.kind}-dm`,
      senderId: options.senderId ?? (owner ? "owner" : "stranger"),
      isOwner: owner,
      text,
      ref,
      receivedAt: new Date().toISOString(),
    });
    return ref;
  }

  /** Fail the next `count` deliveries. */
  failNext(count: number, failure: Failure = { error: "fake outage", retryable: true }): void {
    for (let i = 0; i < count; i++) this.failures.push(failure);
  }

  /** Fail every delivery until `stopFailing`. */
  failEverything(failure: Failure = { error: "fake outage", retryable: true }): void {
    this.failAll = failure;
  }

  /** Fail every delivery that carries files (the service refuses uploads), until `stopFailing`. */
  failFiles(failure: Failure = { error: "uploads are down", retryable: true }): void {
    this.failWithFiles = failure;
  }

  stopFailing(): void {
    this.failAll = undefined;
    this.failWithFiles = undefined;
    this.failures = [];
  }

  setStatus(status: "connected" | "disconnected"): void {
    this.ctx?.setStatus(status);
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    this.attempts++;
    const failure =
      this.failAll ??
      (message.files?.length ? this.failWithFiles : undefined) ??
      this.failures.shift();
    if (failure) return { status: "failed", ...failure };
    const ref = `${this.kind}-out-${++this.seq}`;
    this.sent.push({ ...message, ref });
    return { status: "delivered", ref };
  }

  async acknowledge(ref: string): Promise<void> {
    this.acknowledged.push(ref);
  }

  setTyping(conversationId: string, typing: boolean): void {
    this.typing.push({ conversationId, typing });
  }

  async markAnswered(ref: string): Promise<void> {
    this.reactions.push(ref);
  }

  texts(kind?: OutboundMessage["kind"]): string[] {
    return this.sent.filter((m) => !kind || m.kind === kind).map((m) => m.text);
  }
}
