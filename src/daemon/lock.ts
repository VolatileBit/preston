import { readFileSync, rmSync, writeFileSync } from "node:fs";

export class AlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`Preston is already running (pid ${pid}).`);
  }
}

export interface Lock {
  release(): void;
}

/**
 * Single-instance lock: a file holding the owner's pid, created exclusively. A lock whose
 * owner is gone (or no longer answers, as `isHeld` decides) is stale and taken over.
 */
export async function acquireLock(
  path: string,
  isHeld: (pid: number) => Promise<boolean>,
): Promise<Lock> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return {
        release: () => {
          if (readPid(path) === process.pid) rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const owner = readPid(path);
    if (owner !== undefined && owner !== process.pid && (await isHeld(owner))) {
      throw new AlreadyRunningError(owner);
    }
    rmSync(path, { force: true });
  }
  throw new Error(`Could not acquire ${path}`);
}

function readPid(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
