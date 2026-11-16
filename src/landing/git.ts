import type { CommandResult } from "../util/command.js";
import type { Exec, ExecOptions } from "./exec.js";

/** A thin, shell-free wrapper over the `git` program. Every call names the folder it runs in. */
export class Git {
  constructor(private readonly exec: Exec) {}

  run(cwd: string, args: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    return this.exec("git", args, { ...options, cwd });
  }

  /** Trimmed standard output when the command succeeds, otherwise undefined. */
  async out(
    cwd: string,
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<string | undefined> {
    const result = await this.run(cwd, args, options);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async ok(cwd: string, args: readonly string[], options?: ExecOptions): Promise<boolean> {
    return (await this.run(cwd, args, options)).code === 0;
  }

  /** The object a revision names, or undefined if it does not exist. */
  async rev(cwd: string, revision: string): Promise<string | undefined> {
    const out = await this.out(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    return out || undefined;
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    return this.ok(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    return this.ok(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  }

  /** The checked-out branch, or undefined for a detached HEAD or a repository with no commits. */
  async currentBranch(cwd: string): Promise<string | undefined> {
    const out = await this.out(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return out || undefined;
  }

  /**
   * Where each branch is checked out, from `git worktree list`. The first entry is the
   * repository's main working tree.
   */
  async worktrees(cwd: string): Promise<{ path: string; branch?: string; detached: boolean }[]> {
    const out = await this.out(cwd, ["worktree", "list", "--porcelain"]);
    if (!out) return [];
    const trees: { path: string; branch?: string; detached: boolean }[] = [];
    for (const block of out.split(/\r?\n\r?\n/)) {
      let path = "";
      let branch: string | undefined;
      let detached = false;
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
        else if (line.startsWith("branch refs/heads/"))
          branch = line.slice("branch refs/heads/".length);
        else if (line === "detached") detached = true;
      }
      if (path) trees.push({ path, ...(branch ? { branch } : {}), detached });
    }
    return trees;
  }

  /** Whether the working tree has changes (modified, staged or untracked files). */
  async dirty(cwd: string): Promise<boolean> {
    const out = await this.out(cwd, ["--no-optional-locks", "status", "--porcelain"]);
    return Boolean(out);
  }

  /** The configured commit identity, or `-c` options that supply one when there is none. */
  async identityArgs(cwd: string): Promise<string[]> {
    const name = await this.out(cwd, ["config", "user.name"]);
    const email = await this.out(cwd, ["config", "user.email"]);
    if (name && email) return [];
    return [
      "-c",
      `user.name=${name || "Preston"}`,
      "-c",
      `user.email=${email || "preston@localhost"}`,
    ];
  }
}

/**
 * Whether a branch or remote name read from a repository is safe to hand to git as an argument.
 * A name with a leading dash would be read as an option (`--upload-pack=...` runs a program), so
 * only plain names are used; the repository's own configuration is not trusted for this.
 */
export function isPlainName(name: string): boolean {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_./+@-]*$/u.test(name) && !name.includes("..");
}

/** The last few lines of a failed command, for a plain explanation. */
export function gitProblem(result: CommandResult): string {
  const text = (result.stderr || result.stdout || result.error || "").trim();
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-4).join(" ").slice(0, 400);
}
