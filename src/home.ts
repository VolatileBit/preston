import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Everything Preston owns lives under one per-user directory, never inside a Project. */
export interface HomePaths {
  root: string;
  config: string;
  db: string;
  ipcToken: string;
  /** Unix domain socket path, or a named pipe on Windows. */
  endpoint: string;
  lock: string;
  logs: string;
  transcripts: string;
  /** Working directory of the Coordinator's agent Session. */
  coordinator: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PRESTON_HOME?.trim();
  return resolve(fromEnv ? fromEnv : join(homedir(), ".preston"));
}

export function homePaths(root: string): HomePaths {
  return {
    root,
    config: join(root, "config.json"),
    db: join(root, "preston.db"),
    ipcToken: join(root, "ipc-token"),
    endpoint: ipcEndpoint(root),
    lock: join(root, "daemon.lock"),
    logs: join(root, "logs"),
    transcripts: join(root, "transcripts"),
    coordinator: join(root, "coordinator"),
  };
}

/** Creates the home directory tree, readable only by the owner. */
export function ensureHome(paths: HomePaths): void {
  for (const dir of [paths.root, paths.logs, paths.transcripts, paths.coordinator]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// Unix socket paths are limited to about 104 bytes on macOS.
const MAX_SOCKET_PATH = 100;

function ipcEndpoint(root: string): string {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\preston-${id}`;
  const inHome = join(root, "preston.sock");
  return inHome.length <= MAX_SOCKET_PATH ? inHome : join(tmpdir(), `preston-${id}.sock`);
}
