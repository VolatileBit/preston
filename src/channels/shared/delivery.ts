import { createHash } from "node:crypto";
import type { DeliveryResult } from "../types.js";

/** How a native send error should be reported to the outbox. */
export type SendFailure =
  | { kind: "auth"; detail: string }
  | { kind: "rate_limited"; detail: string; retryAfterMs?: number }
  | { kind: "transient"; detail: string }
  | { kind: "permanent"; detail: string };

export function failureResult(failure: SendFailure): DeliveryResult {
  switch (failure.kind) {
    case "rate_limited":
      return {
        status: "failed",
        error: failure.detail,
        retryable: true,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      };
    case "transient":
    // Fixable by re-pairing, after which the held message should still go out.
    case "auth":
      return { status: "failed", error: failure.detail, retryable: true };
    case "permanent":
      return { status: "failed", error: failure.detail, retryable: false };
  }
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EPIPE",
]);

/** True for errors that mean "the network or the service hiccupped", worth retrying. */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (NETWORK_CODES.has(code) || code.startsWith("UND_ERR_"))) {
    return true;
  }
  return error.cause !== undefined && error.cause !== error && isNetworkError(error.cause);
}

interface Progress {
  sent: number;
  firstRef?: string;
}

const MAX_TRACKED = 200;

/**
 * Remembers how many chunks of a long message were already delivered, so that when the
 * outbox retries a partly delivered message only the missing chunks are sent again.
 */
export class ChunkProgress {
  #entries = new Map<string, Progress>();

  key(conversationId: string, text: string): string {
    return createHash("sha256").update(conversationId).update("\0").update(text).digest("hex");
  }

  get(key: string): Progress {
    return this.#entries.get(key) ?? { sent: 0 };
  }

  record(key: string, progress: Progress): void {
    this.#entries.delete(key);
    this.#entries.set(key, progress);
    if (this.#entries.size > MAX_TRACKED) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }

  clear(key: string): void {
    this.#entries.delete(key);
  }
}

/** Delay before reconnect attempt `attempt` (0-based) after a failed connection. */
export function reconnectDelayMs(attempt: number): number {
  const steps = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000];
  return steps[Math.min(attempt, steps.length - 1)] ?? 300_000;
}
