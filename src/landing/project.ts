import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Git } from "./git.js";
import { canonicalPath, posix } from "./paths.js";

export interface RepoInfo {
  /** The repository's top-level working folder (the Project may be a folder inside it). */
  root: string;
  /** The Project's folder relative to `root`, with forward slashes; empty at the top. */
  prefix: string;
  bare: boolean;
  /** No commits yet. */
  unborn: boolean;
  headSha: string | null;
  currentBranch: string | null;
  detached: boolean;
  /** The branch work normally lands on, if it can be told. */
  defaultBranch: string | null;
  remote: { name: string; url: string; host: "github" | "other" } | null;
  dirty: boolean;
  hasSubmodules: boolean;
}

export interface ProjectInfo {
  path: string;
  name: string;
  kind: "git" | "folder";
  repo?: RepoInfo;
  /** Git is not installed, so a repository could not be recognised. */
  gitMissing?: boolean;
  inspectedAt: string;
}

const COMMON_DEFAULTS = ["main", "master", "trunk", "develop"];

/**
 * Looks at a Project folder: is it a Git repository, which branch is the main one, does it have
 * a remote, are there uncommitted edits. Read-only: nothing in the folder is changed.
 */
export async function inspectProject(git: Git, path: string, at: string): Promise<ProjectInfo> {
  const canonical = canonicalPath(path);
  const base = { path: canonical, name: basename(canonical) || canonical, inspectedAt: at };
  const bareProbe = await git.run(canonical, ["rev-parse", "--is-bare-repository"]);
  if (bareProbe.error === "ENOENT") return { ...base, kind: "folder", gitMissing: true };
  if (bareProbe.code !== 0) return { ...base, kind: "folder" };

  if (bareProbe.stdout.trim() === "true") {
    return {
      ...base,
      kind: "git",
      repo: {
        root: canonical,
        prefix: "",
        bare: true,
        unborn: false,
        headSha: null,
        currentBranch: null,
        detached: false,
        defaultBranch: null,
        remote: null,
        dirty: false,
        hasSubmodules: false,
      },
    };
  }
  const top = await git.out(canonical, ["rev-parse", "--show-toplevel"]);
  if (!top) return { ...base, kind: "folder" };
  const root = canonicalPath(top);
  const prefix = posix((await git.out(canonical, ["rev-parse", "--show-prefix"])) ?? "").replace(
    /\/+$/,
    "",
  );
  const headSha = (await git.rev(root, "HEAD")) ?? null;
  const currentBranch = (await git.currentBranch(root)) ?? null;
  const remote = await findRemote(git, root);
  return {
    ...base,
    kind: "git",
    repo: {
      root,
      prefix,
      bare: false,
      unborn: headSha === null,
      headSha,
      currentBranch,
      detached: headSha !== null && currentBranch === null,
      defaultBranch: await defaultBranch(git, root, currentBranch),
      remote,
      dirty: await git.dirty(root),
      hasSubmodules: existsSync(join(root, ".gitmodules")),
    },
  };
}

/**
 * The branch Goals start from and land on: the remote's default if known, then the configured
 * default, then the usual names, then the checked-out branch. Only branches that exist locally.
 */
async function defaultBranch(
  git: Git,
  root: string,
  current: string | null,
): Promise<string | null> {
  const candidates: (string | undefined)[] = [];
  const remoteHead = await git.out(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead) candidates.push(remoteHead.replace(/^refs\/remotes\/[^/]+\//, ""));
  candidates.push(await git.out(root, ["config", "init.defaultBranch"]));
  candidates.push(...COMMON_DEFAULTS);
  candidates.push(current ?? undefined);
  for (const name of candidates) {
    if (name && (await git.branchExists(root, name))) return name;
  }
  const only = await git.out(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const names = only?.split(/\r?\n/).filter(Boolean) ?? [];
  return names.length === 1 ? (names[0] ?? null) : null;
}

export async function findRemote(git: Git, root: string): Promise<RepoInfo["remote"]> {
  const names = (await git.out(root, ["remote"]))?.split(/\r?\n/).filter(Boolean) ?? [];
  const name = names.includes("origin") ? "origin" : names[0];
  if (!name) return null;
  const url = (await git.out(root, ["remote", "get-url", name])) ?? "";
  return { name, url, host: isGitHubUrl(url) ? "github" : "other" };
}

export function isGitHubUrl(url: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git@|git:\/\/)(?:[^/@]+@)?(?:ssh\.|www\.)?github\.com[:/]/i.test(
    url,
  );
}
