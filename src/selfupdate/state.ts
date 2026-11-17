import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomePaths } from "../home.js";

/** What Preston remembers about updating itself, in `<home>/self-update.json`. */
export interface SelfUpdateState {
  /** When the background service last asked npm what is newest (ms since the epoch). */
  checkedAt?: number;
  /** When `preston` last asked at start, so starting it repeatedly does not keep asking. */
  startCheckedAt?: number;
  /** A version whose install failed, and when (it is not retried for a day). */
  failedVersion?: string;
  failedAt?: number;
  /** The last version the user was told about without being able to install it. */
  announcedVersion?: string;
}

const file = (paths: HomePaths) => join(paths.root, "self-update.json");

export function readState(paths: HomePaths): SelfUpdateState {
  try {
    const value = JSON.parse(readFileSync(file(paths), "utf8")) as SelfUpdateState;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function writeState(paths: HomePaths, state: SelfUpdateState): void {
  try {
    writeFileSync(file(paths), JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Losing this only means checking again sooner.
  }
}

export const FAILURE_BACKOFF_MS = 24 * 3_600_000;
