import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock, Timer } from "../clock.js";
import type { ConfigManager } from "../config/config.js";
import type { HomePaths } from "../home.js";
import { errorMessage, type Logger } from "../log.js";
import { buildDigest, type Digest, type DigestSource, renderDigest } from "./digest.js";

export interface ReviewerDeps {
  clock: Clock;
  log: Logger;
  config: ConfigManager;
  paths: HomePaths;
  source(since: number): DigestSource;
  /** Hands the digest to the Coordinator to consider. */
  raise(review: { digest: Digest; file: string }): void;
  /** The Coordinator is not in the middle of something. */
  isIdle(): boolean;
}

/** Never look back further than this, even after a long time off. */
export const MAX_LOOKBACK_MS = 7 * 24 * 3_600_000;
const BUSY_RETRY_MS = 15 * 60_000;
const MAX_WAIT_MS = 60 * 60_000;

const stateFile = (paths: HomePaths) => join(paths.root, "review.json");
const reviewsDir = (paths: HomePaths) => join(paths.root, "reviews");

function readLast(paths: HomePaths): number | undefined {
  try {
    const value = (JSON.parse(readFileSync(stateFile(paths), "utf8")) as { lastReviewAt?: unknown })
      .lastReviewAt;
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeLast(paths: HomePaths, lastReviewAt: number): void {
  try {
    writeFileSync(stateFile(paths), JSON.stringify({ lastReviewAt }), { mode: 0o600 });
  } catch {
    // Without the file the next start simply begins a new period.
  }
}

/**
 * Looks back over the work once per `review.intervalMs`, when the Coordinator is free. It builds
 * the digest itself and only wakes the Coordinator when there is something notable, so a quiet
 * day costs nothing. Each digest is also kept as readable text in `<home>/reviews`. Nothing is
 * changed here: the Coordinator can only suggest, and the user decides.
 */
export class Reviewer {
  private timer: Timer | undefined;
  private stopped = true;

  constructor(private readonly deps: ReviewerDeps) {}

  start(): void {
    this.stopped = false;
    // A fresh install has no history worth reviewing: the first period starts now.
    if (readLast(this.deps.paths) === undefined) writeLast(this.deps.paths, this.deps.clock.now());
    this.schedule(this.untilDue());
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  /** The digest for the last `days` days (on request, not tied to the schedule). */
  digest(days: number): Digest {
    const until = this.deps.clock.now();
    const since = until - days * 24 * 3_600_000;
    return buildDigest(this.deps.source(since), since, until);
  }

  /** One look back if it is due and the Coordinator is free. Never throws. */
  check(): void {
    if (this.stopped) return;
    const settings = this.deps.config.get().review;
    if (!settings.enabled) {
      this.schedule(settings.intervalMs);
      return;
    }
    const wait = this.untilDue();
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    if (!this.deps.isIdle()) {
      this.schedule(BUSY_RETRY_MS);
      return;
    }
    try {
      const until = this.deps.clock.now();
      const since = Math.max(readLast(this.deps.paths) ?? until, until - MAX_LOOKBACK_MS);
      const digest = buildDigest(this.deps.source(since), since, until);
      writeLast(this.deps.paths, until);
      if (digest.findings.length > 0) {
        const file = this.keep(digest);
        this.deps.raise({ digest, file });
      }
    } catch (error) {
      this.deps.log.warn("the daily review failed", { error: errorMessage(error) });
      writeLast(this.deps.paths, this.deps.clock.now());
    }
    this.schedule(this.untilDue());
  }

  private untilDue(): number {
    const last = readLast(this.deps.paths) ?? this.deps.clock.now();
    const due = last + this.deps.config.get().review.intervalMs;
    return Math.min(Math.max(due - this.deps.clock.now(), 0), MAX_WAIT_MS);
  }

  private keep(digest: Digest): string {
    const dir = reviewsDir(this.deps.paths);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${digest.until.slice(0, 10)}.md`);
    writeFileSync(file, `# Review ${digest.until}\n\n${renderDigest(digest)}\n`, { mode: 0o600 });
    return file;
  }

  private schedule(ms: number): void {
    this.timer?.cancel();
    if (this.stopped) return;
    this.timer = this.deps.clock.setTimeout(() => this.check(), Math.max(ms, 1_000));
  }
}
