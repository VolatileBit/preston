import type { Config } from "../config/schema.js";

/** Checks are never closer together than this, whatever the advertised reset says. */
const MIN_CHECK_DELAY_MS = 30_000;

/**
 * When a blocked bucket is next checked. Deterministic: the jitter comes from the bucket name
 * and attempt number, so checks for different buckets spread out but tests are repeatable.
 *
 * - Token-free reads start at `recheckIntervalMs`; probes (a real resumed turn) at the more
 *   conservative `probeIntervalMs`.
 * - Each check that still finds the bucket blocked backs off by `backoffFactor`, up to
 *   `maxRecheckIntervalMs` (probes may wait up to twice that).
 * - A known reset time pulls the check earlier, to just after the reset; checks keep happening
 *   before it too, because providers sometimes reset early.
 */
export function nextCheckDelay(input: {
  bucket: string;
  now: number;
  resetsAt: string | null;
  failedChecks: number;
  canRead: boolean;
  settings: Config["quota"];
}): number {
  const { settings } = input;
  const base = input.canRead ? settings.recheckIntervalMs : settings.probeIntervalMs;
  const cap = input.canRead ? settings.maxRecheckIntervalMs : settings.maxRecheckIntervalMs * 2;
  const backedOff = Math.min(base * settings.backoffFactor ** input.failedChecks, cap);
  const jitter = (unitHash(`${input.bucket}:${input.failedChecks}`) * 2 - 1) * settings.jitterRatio;
  let delay = Math.round(backedOff * (1 + jitter));
  const reset = input.resetsAt ? Date.parse(input.resetsAt) : Number.NaN;
  if (Number.isFinite(reset)) {
    const afterReset = reset + settings.resetGraceMs - input.now;
    if (afterReset > 0 && afterReset < delay) delay = afterReset;
  }
  return Math.max(delay, MIN_CHECK_DELAY_MS);
}

/** A stable number in [0, 1) for a string (FNV-1a). */
function unitHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 2 ** 32;
}
