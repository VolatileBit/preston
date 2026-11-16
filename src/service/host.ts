import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type CommandRunner, runCommand } from "../util/command.js";

/** The file operations service registration needs. Injectable, so tests never touch the OS. */
export interface ServiceFs {
  read(path: string): string | undefined;
  /** Writes a file, creating its parent directories. */
  write(path: string, data: string | Uint8Array): void;
  exists(path: string): boolean;
  /** Removes a file if it exists. */
  remove(path: string): void;
}

/** Everything OS-specific that registration reads or does. */
export interface ServiceHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The user's home directory (not Preston's home). */
  userHome: string;
  /** Numeric user id on POSIX systems. */
  uid: number | undefined;
  username: string;
  run: CommandRunner;
  fs: ServiceFs;
  sleep(ms: number): Promise<void>;
}

const realFs: ServiceFs = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  write: (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  },
  exists: (path) => existsSync(path),
  remove: (path) => rmSync(path, { force: true }),
};

export function systemServiceHost(): ServiceHost {
  return {
    platform: process.platform,
    env: process.env,
    userHome: homedir(),
    uid: process.getuid?.(),
    username: safeUsername(),
    run: runCommand,
    fs: realFs,
    sleep: (ms) => delay(ms),
  };
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? "";
  }
}

/** Path helpers for the host's OS, so Windows paths are built correctly on any test machine. */
export function pathsFor(host: ServiceHost): typeof posix {
  return host.platform === "win32" ? win32 : posix;
}
