/** Time source for the WeChat Channel, injectable so tests can control waits. */
export interface WeChatClock {
  now(): number;
  /** Resolve after `ms`, or reject with an AbortError once `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: WeChatClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
