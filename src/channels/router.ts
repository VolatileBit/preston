import type { Logger } from "../log.js";
import type { Outbox } from "./outbox.js";
import type { InboundMessage } from "./types.js";

export type FixedWord = "status" | "stop" | "pause" | "resume";

const FIXED_WORDS: readonly FixedWord[] = ["status", "stop", "pause", "resume"];

/** Chinese equivalents, always accepted whatever language Preston speaks. */
const CHINESE_WORDS: Record<string, FixedWord> = {
  状态: "status",
  停止: "stop",
  暂停: "pause",
  继续: "resume",
};

/** The whole message, ignoring case and surrounding whitespace, is one of the fixed words. */
export function fixedWord(text: string): FixedWord | undefined {
  const word = text.trim().toLowerCase();
  return FIXED_WORDS.find((w) => w === word) ?? CHINESE_WORDS[word];
}

export interface RouterDeps {
  outbox: Outbox;
  log: Logger;
  /** Deterministic replies; these must never call a model. */
  fixed: Record<FixedWord, () => string>;
  /** Shows the owner their message was read (a reaction); best effort, never throws. */
  acknowledge?(message: InboundMessage): void;
  /** Everything else from the owner. */
  toCoordinator(message: InboundMessage): void;
  /**
   * Gets the owner's messages first; returns true when it consumed one (an answer to a question
   * a Channel's pairing asked in that conversation). Fixed words are never intercepted.
   */
  intercept?(message: InboundMessage): boolean;
}

/**
 * Decides what happens to each inbound message: non-owners are ignored, fixed words get a
 * deterministic reply, and everything else becomes a Coordinator invocation.
 */
export class Router {
  constructor(private readonly deps: RouterDeps) {}

  handle(message: InboundMessage): void {
    if (!message.isOwner) {
      this.deps.log.info("ignored message from a non-owner", {
        channel: message.channel,
        senderId: message.senderId,
      });
      return;
    }
    const word = fixedWord(message.text);
    // Read receipt first, before any thinking: the owner sees it at once.
    this.deps.acknowledge?.(message);
    if (!word) {
      if (this.deps.intercept?.(message)) return;
      this.deps.toCoordinator(message);
      return;
    }
    this.deps.log.info("fixed word", { channel: message.channel, word });
    this.deps.outbox.enqueue({
      channel: message.channel,
      conversationId: message.conversationId,
      kind: "reply",
      text: this.deps.fixed[word](),
      replyTo: message.ref,
    });
  }
}
