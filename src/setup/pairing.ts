import type { ChatChannels } from "../channels/chat.js";
import type { Outbox } from "../channels/outbox.js";
import type { ChatChannelKind } from "../channels/registry.js";
import type { InboundMessage, PairingIO, PairingResult } from "../channels/types.js";
import type { CoordinatorInput } from "../coordinator/input.js";
import { errorMessage, type Logger } from "../log.js";

/** Where a pairing talks to the user: the conversation that asked for it. */
export interface PairingTarget {
  channel: InboundMessage["channel"];
  conversationId: string;
}

interface Session {
  kind: ChatChannelKind;
  target: PairingTarget;
  abort: AbortController;
  waiting?: { resolve(answer: string): void; reject(error: Error): void; secret: boolean };
}

export interface PairingsDeps {
  chat: ChatChannels;
  outbox: Outbox;
  log: Logger;
  /** Hands the outcome back to the Coordinator, which continues the setup conversation. */
  submit(input: CoordinatorInput): void;
  addSecret(secret: string): void;
}

const CANCEL_WORDS = /^\s*(cancel|stop pairing|never ?mind)\s*$/i;

/**
 * Runs Channel pairing in the background, so the Coordinator's turn never blocks on the user
 * scanning a QR code or sending a code. What the Channel shows goes straight to the conversation
 * that asked for the pairing (QR codes are never retyped by a model); a question it asks is
 * answered by the user's next message there, which never reaches the Coordinator.
 * When pairing ends, the Coordinator gets a setup event and carries on.
 */
export class Pairings {
  private sessions = new Map<ChatChannelKind, Session>();
  private stopping = false;

  constructor(private readonly deps: PairingsDeps) {}

  active(kind: ChatChannelKind): boolean {
    return this.sessions.has(kind);
  }

  /** Starts pairing `kind`, replacing a pairing already running for it. */
  async start(
    kind: ChatChannelKind,
    target: PairingTarget,
  ): Promise<{ started: true } | { error: string }> {
    this.cancel(kind, "Pairing started again.");
    const channel = await this.deps.chat.forPairing(kind);
    if ("error" in channel) return channel;
    if (!channel.pair) return { error: `${this.deps.chat.spec(kind).label} can't be paired.` };
    const session: Session = { kind, target, abort: new AbortController() };
    this.sessions.set(kind, session);
    const pair = channel.pair.bind(channel);
    void this.run(session, () => pair(this.io(session)));
    return { started: true };
  }

  /** Cancels a running pairing. Returns whether one was running. */
  cancel(kind: ChatChannelKind, reason = "Pairing was cancelled."): boolean {
    const session = this.sessions.get(kind);
    if (!session) return false;
    this.sessions.delete(kind);
    session.abort.abort(new Error(reason));
    session.waiting?.reject(new Error(reason));
    return true;
  }

  /** Cancels every pairing without reporting (Preston is stopping). */
  stop(): void {
    this.stopping = true;
    for (const kind of [...this.sessions.keys()]) this.cancel(kind, "Preston stopped.");
  }

  /** The owner's message answers a pairing question asked in that conversation. */
  intercept(message: InboundMessage): boolean {
    for (const session of this.sessions.values()) {
      const { waiting, target } = session;
      if (!waiting) continue;
      if (target.channel !== message.channel || target.conversationId !== message.conversationId) {
        continue;
      }
      session.waiting = undefined;
      if (CANCEL_WORDS.test(message.text)) {
        this.cancel(session.kind);
        this.say(session, `Okay, I stopped pairing ${this.deps.chat.spec(session.kind).label}.`);
        return true;
      }
      const answer = message.text.trim();
      if (waiting.secret) this.deps.addSecret(answer);
      waiting.resolve(answer);
      return true;
    }
    return false;
  }

  private io(session: Session): PairingIO {
    return {
      signal: session.abort.signal,
      show: (text) => this.say(session, text),
      prompt: (question, opts) =>
        new Promise<string>((resolve, reject) => {
          if (session.abort.signal.aborted) {
            reject(new Error("Pairing was cancelled."));
            return;
          }
          session.waiting = { resolve, reject, secret: Boolean(opts?.secret) };
          this.say(session, `${question}\n(Reply "cancel" to stop pairing.)`);
        }),
    };
  }

  private async run(session: Session, pair: () => Promise<PairingResult>): Promise<void> {
    const { chat, log } = this.deps;
    const label = chat.spec(session.kind).label;
    let result: PairingResult;
    try {
      result = await pair();
    } catch (err) {
      result = { ok: false, detail: `Pairing ${label} failed: ${errorMessage(err)}` };
    }
    const current = this.sessions.get(session.kind) === session;
    if (current) this.sessions.delete(session.kind);
    if (this.stopping) return;
    if (!current && !result.ok) {
      // Cancelled: whoever cancelled it has told the user.
      if (!this.sessions.has(session.kind)) {
        await chat
          .discardProvisional(session.kind)
          .catch((err) => log.warn("could not drop the Channel", { error: err }));
      }
      return;
    }
    try {
      if (result.ok && result.configPatch) {
        await chat.persistOwned(session.kind, result.configPatch, `${label} paired`);
      }
      if (!result.ok) await chat.discardProvisional(session.kind);
    } catch (err) {
      log.error("could not save the pairing", { kind: session.kind, error: err });
      result = {
        ok: false,
        detail: `${label} paired, but I couldn't save it (${errorMessage(err)}). Please try again.`,
      };
    }
    log.info("pairing finished", { kind: session.kind, ok: result.ok });
    this.say(session, result.detail);
    this.deps.submit({
      kind: "setup",
      channel: session.target.channel,
      conversationId: session.target.conversationId,
      note: `Pairing ${label} ${result.ok ? "succeeded" : "did not finish"}. The user has already been told: "${result.detail}" Do not repeat that; continue setup from here (for example the next Channel, or try again if it failed and they want to).`,
    });
  }

  private say(session: Session, text: string): void {
    this.deps.outbox.enqueue({
      channel: session.target.channel,
      conversationId: session.target.conversationId,
      kind: "reply",
      text,
    });
  }
}
