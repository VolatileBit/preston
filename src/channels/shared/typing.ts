import type { ChannelLogger } from "./secrets.js";

export interface TypingTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: TypingTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Keeps a chat service's "typing…" indicator on while Preston is working on a reply. Services
 * show it for only a few seconds per call, so it is repeated until stopped, and always stops by
 * itself after `maxMs` in case a stop never comes. Failures are logged and never thrown.
 */
export class TypingKeeper {
  private active = new Map<string, { interval: unknown; limit: unknown }>();

  constructor(
    private readonly send: (conversationId: string) => Promise<void>,
    private readonly log: ChannelLogger,
    private readonly intervalMs = 8_000,
    private readonly maxMs = 5 * 60_000,
    private readonly timers: TypingTimers = realTimers,
  ) {}

  start(conversationId: string): void {
    if (this.active.has(conversationId)) return;
    const ping = () => {
      this.send(conversationId).catch((error: unknown) =>
        this.log("debug", "Could not show that Preston is typing", error),
      );
    };
    ping();
    this.active.set(conversationId, {
      interval: this.timers.setInterval(ping, this.intervalMs),
      limit: this.timers.setTimeout(() => this.stop(conversationId), this.maxMs),
    });
  }

  stop(conversationId: string): void {
    const entry = this.active.get(conversationId);
    if (!entry) return;
    this.timers.clearInterval(entry.interval);
    this.timers.clearTimeout(entry.limit);
    this.active.delete(conversationId);
  }

  stopAll(): void {
    for (const id of [...this.active.keys()]) this.stop(id);
  }
}
