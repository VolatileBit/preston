import { pathToFileURL } from "node:url";
import { newId } from "../util/ids.js";
import type { Channel, ChannelContext, DeliveryResult, OutboundMessage } from "./types.js";

/** One attached `preston` terminal client, as seen by the daemon. */
export interface TerminalClient {
  send(message: { kind: OutboundMessage["kind"]; text: string }): void;
  /** Preston's own agent started or stopped thinking. */
  busy?(busy: boolean): void;
}

export const TERMINAL_CONVERSATION = "terminal";

/**
 * The terminal Channel lives in the daemon; `preston` clients attach to it over IPC. Whoever
 * runs `preston` as this user is the owner. It is connected while at least one client is
 * attached, and every attached client sees the single conversation.
 */
export class TerminalChannel implements Channel {
  readonly kind = "terminal" as const;
  // Files are shown as links on this same computer, so there is no real size limit.
  readonly capabilities = {
    reactions: false,
    proactive: "always",
    files: { maxBytes: Number.MAX_SAFE_INTEGER, maxCount: 20 },
  } as const;
  private ctx: ChannelContext | undefined;
  private clients = new Set<TerminalClient>();

  async start(ctx: ChannelContext): Promise<void> {
    this.ctx = ctx;
    this.reportStatus();
  }

  async stop(): Promise<void> {
    this.clients.clear();
    this.ctx = undefined;
  }

  /** Attaches a client; returns a function that detaches it. */
  attach(client: TerminalClient): () => void {
    this.clients.add(client);
    this.reportStatus();
    return () => {
      this.clients.delete(client);
      this.reportStatus();
    };
  }

  /** Tells every attached client whether Preston is thinking. */
  setBusy(busy: boolean): void {
    for (const client of this.clients) client.busy?.(busy);
  }

  /** A line the owner typed in a terminal client. */
  receive(text: string): void {
    this.ctx?.onMessage({
      channel: "terminal",
      conversationId: TERMINAL_CONVERSATION,
      senderId: "owner",
      isOwner: true,
      text,
      ref: newId("t"),
      receivedAt: new Date().toISOString(),
    });
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    if (this.clients.size === 0) {
      return { status: "failed", error: "No terminal is open", retryable: true };
    }
    const links = (message.files ?? []).map((f) => `${f.name}: ${pathToFileURL(f.path).href}`);
    const text = [message.text, ...links].filter(Boolean).join("\n");
    for (const client of this.clients) client.send({ kind: message.kind, text });
    return { status: "delivered", ref: newId("t") };
  }

  private reportStatus(): void {
    this.ctx?.setStatus(this.clients.size > 0 ? "connected" : "disconnected");
  }
}
