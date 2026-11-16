import { randomInt } from "node:crypto";

/** No 0/O, 1/I/L, so the code survives being read off a screen and retyped. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/** A short one-time code the owner sends to the bot to prove the account is theirs. */
export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function normalise(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, "");
}

export type PairingWait<T> =
  | { status: "matched"; match: T }
  | { status: "timeout" | "aborted" | "cancelled" };

/**
 * Waits for one message containing the pairing code. The Channel offers every inbound
 * message; the first one that contains the code wins. Messages without it are ignored.
 */
export class PairingWaiter<T> {
  readonly code: string;
  readonly result: Promise<PairingWait<T>>;
  #settle!: (result: PairingWait<T>) => void;
  #done = false;

  constructor(code: string, timeoutMs: number, signal: AbortSignal) {
    this.code = code;
    this.result = new Promise((resolve) => {
      this.#settle = resolve;
    });
    const timer = setTimeout(() => this.#finish({ status: "timeout" }), timeoutMs);
    timer.unref?.();
    const onAbort = () => this.#finish({ status: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    void this.result.then(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
    if (signal.aborted) onAbort();
  }

  get active(): boolean {
    return !this.#done;
  }

  /** Returns true when `text` carried the code and completed the pairing. */
  offer(text: string, match: T): boolean {
    if (this.#done || !normalise(text).includes(this.code)) return false;
    this.#finish({ status: "matched", match });
    return true;
  }

  cancel(): void {
    this.#finish({ status: "cancelled" });
  }

  #finish(result: PairingWait<T>): void {
    if (this.#done) return;
    this.#done = true;
    this.#settle(result);
  }
}

/** "15 minutes", "1 minute", "30 seconds": for plain-language timeout messages. */
export function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}
