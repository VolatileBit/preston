import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { type Git, gitProblem } from "./git.js";

/**
 * Folders that hold built or installed files, not the Worker's own work. When a repository does
 * not ignore them, committing "everything" would drag thousands of files into the project.
 */
const GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".gradle",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".turbo",
  ".parcel-cache",
  "coverage",
]);

/** A new binary file bigger than this is not committed (a stray build artefact or download). */
export const MAX_BINARY_BYTES = 5 * 1024 * 1024;

/** Paths per `git add`, so the command line stays short enough for Windows. */
const ADD_CHUNK = 100;

export interface LeftOut {
  /** Relative path with forward slashes; a folder ends with a slash. */
  path: string;
  why: "generated" | "large_binary";
  bytes?: number;
}

/**
 * Stages what the Worker left in a worktree: every change to files Git already tracks, and new
 * files that are not ignored, except generated folders (`node_modules`, `dist`, `.venv`, ...) and
 * large new binary files. Returns what was left out, or the problem Git reported.
 */
export async function stageWork(
  git: Git,
  cwd: string,
): Promise<{ leftOut: LeftOut[]; problem?: string }> {
  const tracked = await git.run(cwd, ["add", "-u"]);
  if (tracked.code !== 0) return { leftOut: [], problem: gitProblem(tracked) };
  const listed = await git.run(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--directory",
    "--no-empty-directory",
    "-z",
  ]);
  if (listed.code !== 0) return { leftOut: [], problem: gitProblem(listed) };

  const leftOut: LeftOut[] = [];
  const add: string[] = [];
  for (const entry of listed.stdout.split("\0").filter(Boolean)) {
    const isDir = entry.endsWith("/");
    // A generated folder is skipped as a whole, without listing what may be 100,000 files.
    if (isDir && isGenerated(entry, true)) {
      leftOut.push({ path: entry, why: "generated" });
      continue;
    }
    const files = isDir ? await filesIn(git, cwd, entry) : [entry];
    if (files === undefined) return { leftOut: [], problem: `Could not list ${entry}` };
    for (const file of files) {
      if (isGenerated(file, false)) {
        const top = generatedPrefix(file);
        if (!leftOut.some((l) => l.path === top)) leftOut.push({ path: top, why: "generated" });
        continue;
      }
      const big = largeBinary(join(cwd, file));
      if (big !== undefined) leftOut.push({ path: file, why: "large_binary", bytes: big });
      else add.push(file);
    }
  }
  for (let i = 0; i < add.length; i += ADD_CHUNK) {
    const added = await git.run(cwd, [
      "--literal-pathspecs",
      "add",
      "--",
      ...add.slice(i, i + ADD_CHUNK),
    ]);
    if (added.code !== 0) return { leftOut, problem: gitProblem(added) };
  }
  return { leftOut };
}

async function filesIn(git: Git, cwd: string, dir: string): Promise<string[] | undefined> {
  const listed = await git.run(cwd, [
    "--literal-pathspecs",
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    dir,
  ]);
  return listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : undefined;
}

/** Whether any folder on the path is a generated one (the last part counts for a folder). */
function isGenerated(path: string, isDir: boolean): boolean {
  const parts = path.split("/").filter(Boolean);
  return (isDir ? parts : parts.slice(0, -1)).some((part) => GENERATED_DIRS.has(part));
}

function generatedPrefix(file: string): string {
  const parts = file.split("/");
  const index = parts.findIndex((part, i) => i < parts.length - 1 && GENERATED_DIRS.has(part));
  return `${parts.slice(0, index + 1).join("/")}/`;
}

/** The size of a new file when it is a large binary one, otherwise undefined. */
function largeBinary(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size <= MAX_BINARY_BYTES) return undefined;
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(8000);
      const read = readSync(fd, head, 0, head.length, 0);
      return head.subarray(0, read).includes(0) ? stat.size : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
