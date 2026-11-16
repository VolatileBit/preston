import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";

/**
 * Memory lives in Markdown files under `<home>/memory`: `USER.md` for what applies everywhere,
 * `projects/<name>-<hash>.md` for one Project. One fact per line, with its provenance in a
 * trailing comment that survives hand edits:
 *
 *   - Prefers short replies. <!-- m-3f9a1c0b2d {"v":2,"source":"user","via":"terminal",...} -->
 *
 * A line without a comment (typed by hand) is adopted on the next read.
 */

export interface MemoryEntry {
  id: string;
  scope: string;
  text: string;
  key?: string | undefined;
  /** `user` said it; `observed` is something Preston noticed. */
  source: "user" | "observed";
  via?: string | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const GLOBAL_SCOPE = "global";

const TRAILER = /\s*<!--\s*(m-[0-9a-f]+)\s+(\{.*\})\s*-->\s*$/;
const USER_HEADER = "# What Preston knows about you";

export function projectScope(path: string): string {
  return `project:${path}`;
}

export function fileForScope(dir: string, scope: string): string {
  if (scope === GLOBAL_SCOPE) return join(dir, "USER.md");
  const path = scope.slice("project:".length);
  const slug =
    (basename(path) || "project").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "project";
  const hash = createHash("sha1").update(path).digest("hex").slice(0, 8);
  return join(dir, "projects", `${slug}-${hash}.md`);
}

/** Entries in a file, adopting hand-typed lines through `adopt`. */
export function parseFile(
  text: string,
  scope: string,
  adopt: (line: string) => MemoryEntry,
): { entries: MemoryEntry[]; adopted: boolean } {
  const entries: MemoryEntry[] = [];
  let adopted = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith("- ")) continue;
    const body = raw.slice(2);
    const match = TRAILER.exec(body);
    if (match) {
      try {
        const meta = JSON.parse(match[2] as string) as Record<string, unknown>;
        entries.push({
          id: match[1] as string,
          scope,
          text: body.slice(0, match.index).trim(),
          key: typeof meta.key === "string" ? meta.key : undefined,
          source: meta.source === "observed" ? "observed" : "user",
          via: typeof meta.via === "string" ? meta.via : undefined,
          version: typeof meta.v === "number" ? meta.v : 1,
          createdAt: typeof meta.created === "string" ? meta.created : "",
          updatedAt: typeof meta.updated === "string" ? meta.updated : "",
        });
        continue;
      } catch {
        // Fall through: treat a damaged trailer as hand-typed text.
      }
    }
    const trimmed = body.replace(/<!--.*$/, "").trim();
    if (!trimmed) continue;
    entries.push(adopt(trimmed));
    adopted = true;
  }
  return { entries, adopted };
}

export function formatFile(scope: string, entries: MemoryEntry[]): string {
  const header =
    scope === GLOBAL_SCOPE
      ? `${USER_HEADER}\n\n<!-- Kept by Preston. You can edit this: one fact per line. -->`
      : `# What Preston knows about this project\n\n<!-- project: ${scope.slice("project:".length)} -->`;
  const lines = entries.map((e) => {
    const meta: Record<string, unknown> = {
      v: e.version,
      source: e.source,
      created: e.createdAt,
      updated: e.updatedAt,
    };
    if (e.via) meta.via = e.via;
    if (e.key) meta.key = e.key;
    return `- ${e.text} <!-- ${e.id} ${JSON.stringify(meta)} -->`;
  });
  return `${header}\n\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

/** The project a `projects/*.md` file belongs to, from its header comment. */
export function scopeOfProjectFile(text: string): string | undefined {
  const match = /<!--\s*project:\s*(.+?)\s*-->/.exec(text);
  return match ? projectScope(match[1] as string) : undefined;
}

// ---- Atomic writes and the lock --------------------------------------------------------------

/** Writes through a temporary file and a rename, so readers never see half a file. */
export function writeAtomic(file: string, content: string): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, file);
      return;
    } catch (err) {
      // Windows refuses a rename onto a file another process has open; it clears quickly.
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        try {
          unlinkSync(temp);
        } catch {
          // Nothing to clean up.
        }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

export function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function fingerprint(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

const STALE_LOCK_MS = 30_000;

/**
 * Serialises writers: in-process through a promise chain, and across processes through an
 * exclusive lock file that is taken over once it is stale.
 */
export class MemoryLock {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.chain.then(() => this.withFile(fn));
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async withFile<T>(fn: () => T | Promise<T>): Promise<T> {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    await this.acquire();
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(this.file);
      } catch {
        // Already gone.
      }
    }
  }

  private async acquire(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        closeSync(openSync(this.file, "wx"));
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      try {
        if (existsSync(this.file) && Date.now() - statSync(this.file).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(this.file);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("Memory is busy; try again in a moment.");
      await realDelay(15);
    }
  }
}
