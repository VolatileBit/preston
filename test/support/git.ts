import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tempDir } from "./harness.js";

// Tests must not depend on (or be broken by) the developer's own git configuration.
const emptyConfig = join(tempDir("gitconfig"), "gitconfig");
writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_DATE = "2026-11-16T09:00:00Z";
process.env.GIT_COMMITTER_DATE = "2026-11-16T09:00:00Z";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function write(root: string, file: string, content: string): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A throwaway repository on `main` with one commit. */
export function initRepo(files: Record<string, string> = { "README.md": "# project\n" }): string {
  const dir = tempDir("repo");
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "Initial commit");
  return dir;
}

export function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** Gives `repo` a bare `origin` (a local stand-in for a hosted remote) holding `main`. */
export function addRemote(repo: string): string {
  const origin = tempDir("origin");
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "fetch", "--quiet", "origin");
  git(repo, "remote", "set-head", "origin", "main");
  return origin;
}

export const scratch = () => tmpdir();
