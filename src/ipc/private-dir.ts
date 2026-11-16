import { chmodSync, mkdirSync, statSync } from "node:fs";

/**
 * The folder holding the daemon's socket must belong to this user and be closed to everyone
 * else. Otherwise another local user could pre-create the socket path in a shared temp folder
 * and receive the secret a client sends to prove who it is. Windows named pipes have no folder.
 */
export function ensurePrivateDir(dir: string): void {
  if (process.platform === "win32") return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(dir);
  chmodSync(dir, 0o700);
}

/** Throws unless `dir` is a folder owned by this user (a link must lead to one). */
export function assertPrivateDir(dir: string): void {
  if (process.platform === "win32") return;
  const stat = statSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error(`${dir} is not a private folder of yours, so Preston will not use it.`);
  }
}
