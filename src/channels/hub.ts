import { type Clock, isoNow } from "../clock.js";
import { errorMessage, type Logger } from "../log.js";
import type { Channel, ChannelKind, ChannelStatus, InboundMessage } from "./types.js";

/**
 * Raises a desktop notification on the host (`ChannelContext.notifyHost`). The service layer
 * provides the real one; without it the request is only logged.
 */
export interface HostNotifier {
  notify(text: string): void | Promise<void>;
}

export interface ChannelState {
  kind: ChannelKind;
  status: ChannelStatus;
  /** The Channel's own plain-language explanation of its status, if it gave one. */
  detail?: string | undefined;
}

/**
 * Owns the registered Channels: starts and stops them, tracks their status, and hands inbound
 * messages to the Router. At most one Channel per kind. Chat Channels can be added and removed
 * while running (their config changed, or they were set up in conversation).
 */
export class ChannelHub {
  private channels = new Map<ChannelKind, Channel>();
  private states = new Map<ChannelKind, { status: ChannelStatus; detail?: string | undefined }>();
  private connectedListeners: ((kind: ChannelKind) => void)[] = [];
  private inbound: (message: InboundMessage) => void = () => {};
  private started = false;

  constructor(
    private readonly log: Logger,
    private readonly clock: Clock,
    private readonly notifier?: HostNotifier,
  ) {}

  register(channel: Channel): void {
    if (this.channels.has(channel.kind)) {
      throw new Error(`A ${channel.kind} Channel is already registered`);
    }
    this.channels.set(channel.kind, channel);
    this.states.set(channel.kind, { status: "disconnected" });
  }

  /** Registers a Channel while running, and starts it if the hub has started. */
  async add(channel: Channel): Promise<void> {
    this.register(channel);
    if (this.started) await this.startOne(channel);
  }

  /** Stops and unregisters the Channel of this kind, if any. */
  async remove(kind: ChannelKind): Promise<void> {
    const channel = this.channels.get(kind);
    if (!channel) return;
    this.channels.delete(kind);
    this.states.delete(kind);
    await channel
      .stop()
      .catch((err) => this.log.warn("channel failed to stop", { kind, error: err }));
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
    return this.states.get(kind)?.status === "connected";
  }

  status(): { kind: ChannelKind; status: ChannelStatus }[] {
    return this.kinds().map((kind) => ({
      kind,
      status: this.states.get(kind)?.status ?? "disconnected",
    }));
  }

  /** Status and detail of a registered Channel. */
  state(kind: ChannelKind): ChannelState | undefined {
    if (!this.channels.has(kind)) return undefined;
    return { kind, ...(this.states.get(kind) ?? { status: "disconnected" }) };
  }

  async start(): Promise<void> {
    this.started = true;
    await Promise.all([...this.channels.values()].map((channel) => this.startOne(channel)));
  }

  async stop(): Promise<void> {
    this.started = false;
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

  private async startOne(channel: Channel): Promise<void> {
    const log = this.log.child(channel.kind);
    // A replaced Channel instance may still report; only the registered one counts.
    const current = () => this.channels.get(channel.kind) === channel;
    try {
      await channel.start({
        onMessage: (message) => {
          if (current()) this.receive(channel.kind, message);
        },
        setStatus: (status, detail) => {
          if (current()) this.setStatus(channel.kind, status, detail);
        },
        notifyHost: (text) => this.notifyHost(channel.kind, text),
        log: (level, message, data) => log[level](message, data),
      });
    } catch (err) {
      if (current()) this.setStatus(channel.kind, "disconnected", errorMessage(err));
      log.error("channel failed to start", { error: err });
    }
  }

  private notifyHost(kind: ChannelKind, text: string): void {
    const notifier = this.notifier;
    if (!notifier) {
      this.log.warn("host notification requested (no notifier installed)", { kind, text });
      return;
    }
    Promise.resolve()
      .then(() => notifier.notify(text))
      .catch((err) => this.log.warn("host notification failed", { kind, error: err }));
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
    const previous = this.states.get(kind)?.status;
    this.states.set(kind, { status, detail });
    if (previous !== status) this.log.info("channel status", { kind, status, detail });
    if (status === "connected" && previous !== "connected") {
      for (const listener of this.connectedListeners) listener(kind);
    }
  }
}
