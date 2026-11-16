import { type Clock, isoNow } from "../clock.js";
import { errorMessage, type Logger } from "../log.js";
import type { Channel, ChannelKind, ChannelStatus, InboundMessage } from "./types.js";

/**
 * Owns the registered Channels: starts and stops them, tracks their status, and hands inbound
 * messages to the Router. At most one Channel per kind.
 */
export class ChannelHub {
  private channels = new Map<ChannelKind, Channel>();
  private statuses = new Map<ChannelKind, ChannelStatus>();
  private connectedListeners: ((kind: ChannelKind) => void)[] = [];
  private inbound: (message: InboundMessage) => void = () => {};

  constructor(
    private readonly log: Logger,
    private readonly clock: Clock,
    /** Shows a desktop notification on the host; omitted in tests, where it is only logged. */
    private readonly notifyHost?: (text: string) => unknown,
  ) {}

  register(channel: Channel): void {
    if (this.channels.has(channel.kind)) {
      throw new Error(`A ${channel.kind} Channel is already registered`);
    }
    this.channels.set(channel.kind, channel);
    this.statuses.set(channel.kind, "disconnected");
  }

  onInbound(handler: (message: InboundMessage) => void): void {
    this.inbound = handler;
  }

  onConnected(listener: (kind: ChannelKind) => void): void {
    this.connectedListeners.push(listener);
  }

  get(kind: ChannelKind): Channel | undefined {
    return this.channels.get(kind);
  }

  kinds(): ChannelKind[] {
    return [...this.channels.keys()];
  }

  isConnected(kind: ChannelKind): boolean {
    return this.statuses.get(kind) === "connected";
  }

  status(): { kind: ChannelKind; status: ChannelStatus }[] {
    return this.kinds().map((kind) => ({
      kind,
      status: this.statuses.get(kind) ?? "disconnected",
    }));
  }

  async start(): Promise<void> {
    await Promise.all(
      [...this.channels.values()].map(async (channel) => {
        const log = this.log.child(channel.kind);
        try {
          await channel.start({
            onMessage: (message) => this.receive(channel.kind, message),
            setStatus: (status, detail) => this.setStatus(channel.kind, status, detail),
            notifyHost: (text) => {
              log.warn("host notification requested", { text });
              try {
                this.notifyHost?.(text);
              } catch (err) {
                log.warn("host notification failed", { error: err });
              }
            },
            log: (level, message, data) => log[level](message, data),
          });
        } catch (err) {
          this.setStatus(channel.kind, "disconnected", errorMessage(err));
          log.error("channel failed to start", { error: err });
        }
      }),
    );
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.channels.values()].map((channel) =>
        channel
          .stop()
          .catch((err) =>
            this.log.warn("channel failed to stop", { kind: channel.kind, error: err }),
          ),
      ),
    );
  }

  private receive(kind: ChannelKind, message: InboundMessage): void {
    if (message.channel !== kind) {
      this.log.warn("dropped message reported by the wrong Channel", {
        kind,
        claimed: message.channel,
      });
      return;
    }
    try {
      this.inbound({ ...message, receivedAt: message.receivedAt || isoNow(this.clock) });
    } catch (err) {
      this.log.error("failed to handle inbound message", { kind, error: err });
    }
  }

  private setStatus(kind: ChannelKind, status: ChannelStatus, detail?: string): void {
    const previous = this.statuses.get(kind);
    this.statuses.set(kind, status);
    if (previous !== status) this.log.info("channel status", { kind, status, detail });
    if (status === "connected" && previous !== "connected") {
      for (const listener of this.connectedListeners) listener(kind);
    }
  }
}
