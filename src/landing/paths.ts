import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * The one spelling of a folder Preston uses to identify it: absolute, symlinks resolved, and on
 * Windows the real letter case. Falls back to the resolved path when the folder is missing.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/** Lower-case words joined by dashes: safe in a branch name and in a Windows folder name. */
export function slugify(text: string, max = 32): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug;
}

/** A short, stable folder name for a Project: its name plus a hash of its canonical path. */
export function projectSlug(path: string): string {
  const canonical = canonicalPath(path);
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 6);
  return `${slugify(basename(canonical), 20) || "project"}-${hash}`;
}

/** A path with forward slashes only, for comparing against what git prints. */
export function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalised(path: string): string {
  const value = posix(canonicalPath(path)).replace(/\/+$/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** Same folder, whatever the spelling (case on Windows, slashes, trailing separators). */
export function samePath(a: string, b: string): boolean {
  return normalised(a) === normalised(b);
}

/** Whether `child` is `parent` itself or somewhere inside it, whatever the spelling. */
export function isInside(parent: string, child: string): boolean {
  const base = normalised(parent);
  const path = normalised(child);
  return path === base || path.startsWith(`${base}/`);
}
