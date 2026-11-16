/**
 * Contract between Preston and the chat services the user talks through.
 * A Channel normalises messages and enforces its own owner pairing. Keep changes additive.
 */

export type ChannelKind = "terminal" | "discord" | "slack" | "wechat" | "fake";

export interface InboundMessage {
  channel: ChannelKind;
  /** Native conversation (DM/channel/chat) the message arrived in. */
  conversationId: string;
  senderId: string;
  /** Decided by the Channel from its pairing; non-owner messages are never acted on. */
  isOwner: boolean;
  text: string;
  /** Native message reference, usable for replies and `markAnswered`. */
  ref: string;
  receivedAt: string;
}

export type OutboundKind = "reply" | "ack" | "question" | "outcome" | "notice";

export interface OutboundMessage {
  /** Omit to send to the owner's default conversation established at pairing. */
  conversationId?: string;
  text: string;
  kind: OutboundKind;
  /** Native reference of the inbound message being answered, if any. */
  replyTo?: string;
}

export type DeliveryResult =
  | { status: "delivered"; ref?: string }
  | { status: "failed"; error: string; retryable: boolean; retryAfterMs?: number };

export interface ChannelCapabilities {
  /** Can mark a message (e.g. an answered question) without sending a notification. */
  reactions: boolean;
  /** "windowed": unprompted sends only work for a while after the user's last message. */
  proactive: "always" | "windowed";
}

export type ChannelStatus = "connected" | "connecting" | "disconnected" | "needs_pairing";

export interface ChannelContext {
  onMessage(message: InboundMessage): void;
  setStatus(status: ChannelStatus, detail?: string): void;
  /** Raise a desktop notification on the host (e.g. when a pairing is lost). */
  notifyHost(text: string): void;
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void;
}

/** I/O the setup conversation lends a Channel while pairing it with the owner. */
export interface PairingIO {
  /** Show text to the user in the setup conversation (QR codes are rendered as text). */
  show(text: string): void;
  signal: AbortSignal;
}

export interface PairingResult {
  ok: boolean;
  /** Plain-language outcome for the user. */
  detail: string;
  /** Channel config to persist (owner identity, default conversation, credentials). */
  configPatch?: Record<string, unknown>;
}

export interface Channel {
  readonly kind: ChannelKind;
  readonly capabilities: ChannelCapabilities;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<DeliveryResult>;
  /** Mark a delivered question as answered without notifying (reactions). */
  markAnswered?(ref: string): Promise<void>;
  /** Pair the owner's account (QR scan, pairing code, ...). */
  pair?(io: PairingIO): Promise<PairingResult>;
}
