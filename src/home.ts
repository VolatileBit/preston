import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
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
  /** Files the user sent through a chat Channel. */
  attachments: string;
  /** A Project folder for one-off requests that belong to no real project (a picture, an answer). */
  scratch: string;
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
    attachments: join(root, "attachments"),
    scratch: join(root, "scratch"),
  };
}

/** Creates the home directory tree, readable only by the owner. */
export function ensureHome(paths: HomePaths): void {
  for (const dir of [
    paths.root,
    paths.logs,
    paths.transcripts,
    paths.coordinator,
    paths.attachments,
    paths.scratch,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // The modes above apply only to folders just created, and the home may predate them.
  if (process.platform !== "win32") chmodSync(paths.root, 0o700);
}

// Unix socket paths are limited to about 104 bytes on macOS.
const MAX_SOCKET_PATH = 100;

function ipcEndpoint(root: string): string {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\preston-${id}`;
  const inHome = join(root, "preston.sock");
  if (inHome.length <= MAX_SOCKET_PATH) return inHome;
  // A shared temp folder gets a private folder of this user's own, never a bare socket path.
  return join(tmpdir(), `preston-${process.getuid?.() ?? 0}`, `${id}.sock`);
}
