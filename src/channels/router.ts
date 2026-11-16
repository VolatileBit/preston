import type { Logger } from "../log.js";
import type { Outbox } from "./outbox.js";
import type { InboundMessage } from "./types.js";

export type FixedWord = "status" | "stop" | "pause" | "resume";

const FIXED_WORDS: readonly FixedWord[] = ["status", "stop", "pause", "resume"];

/** The whole message, ignoring case and surrounding whitespace, is one of the fixed words. */
export function fixedWord(text: string): FixedWord | undefined {
  const word = text.trim().toLowerCase();
  return FIXED_WORDS.find((w) => w === word);
}

export interface RouterDeps {
  outbox: Outbox;
  log: Logger;
  /** Deterministic replies; these must never call a model. */
  fixed: Record<FixedWord, () => string>;
  /** Everything else from the owner. */
  toCoordinator(message: InboundMessage): void;
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
    if (!word) {
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
