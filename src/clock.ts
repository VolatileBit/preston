/**
 * All time-dependent logic takes a Clock so tests can control time.
 * Timers created through the system clock never keep the process alive on their own.
 */

export interface Timer {
  cancel(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): Timer;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, Math.max(0, ms));
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

export function isoNow(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/** Resolves after `ms` on the given clock; rejects with the signal's reason if aborted first. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      timer.cancel();
      reject(signal?.reason);
    };
    const timer = clock.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ManualTimer {
  due: number;
  seq: number;
  fn: () => void;
}

/** A clock that only moves when told to. Timers fire in due order during `advance`. */
export class ManualClock implements Clock {
  private current: number;
  private seq = 0;
  private timers = new Set<ManualTimer>();

  constructor(start = Date.parse("2026-11-16T09:00:00.000Z")) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): Timer {
    const timer: ManualTimer = { due: this.current + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.add(timer);
    return { cancel: () => this.timers.delete(timer) };
  }

  /** Number of timers waiting to fire. */
  get pending(): number {
    return this.timers.size;
  }

  /** Moves time forward by `ms`, firing due timers in order and letting async work settle between them. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const next = [...this.timers]
        .filter((t) => t.due <= target)
        .sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (!next) break;
      this.timers.delete(next);
      this.current = Math.max(this.current, next.due);
      next.fn();
      await settle();
    }
    this.current = target;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}
