import { defaultExec, type Exec } from "./exec.js";
import { gitProblem } from "./git.js";

export type MergeMethod = "merge" | "squash" | "rebase";

export interface RepoHost {
  /** For example `octo/hello`. */
  name: string;
  defaultBranch: string;
  allowed: Record<MergeMethod, boolean>;
}

export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  baseBranch: string;
}

export interface Checks {
  /** `none`: no required checks reported (yet). */
  state: "none" | "pending" | "passing" | "failing";
  failing: string[];
}

/**
 * What Preston needs from a code host to raise and merge a pull request. The real one drives
 * the `gh` program; tests inject a fake. `cwd` is any folder inside the repository.
 */
export interface GitHubClient {
  /** The hosted repository, or why Preston cannot use GitHub here (not installed, not signed in). */
  repo(cwd: string): Promise<{ ok: true; host: RepoHost } | { ok: false; reason: string }>;
  /** The open or merged pull request whose head is `branch`, if any. */
  findPr(cwd: string, branch: string): Promise<PullRequest | undefined>;
  createPr(
    cwd: string,
    input: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequest>;
  getPr(cwd: string, number: number): Promise<PullRequest>;
  /** The repository's required checks on the pull request. */
  checks(cwd: string, number: number): Promise<Checks>;
  mergePr(cwd: string, number: number, method: MergeMethod): Promise<void>;
}

/** The configured method if the repository allows it, otherwise the first one it does allow. */
export function chooseMergeMethod(
  configured: "merge" | "squash",
  allowed: Record<MergeMethod, boolean>,
): MergeMethod {
  if (allowed[configured]) return configured;
  const fallback = (["merge", "squash", "rebase"] as const).find((m) => allowed[m]);
  if (!fallback) throw new Error("The GitHub repository doesn't allow any way of merging.");
  return fallback;
}

/** A client for computers where GitHub cannot be used. */
export const noGitHub: GitHubClient = {
  repo: async () => ({ ok: false, reason: "GitHub isn't set up on this computer." }),
  findPr: async () => undefined,
  createPr: async () => {
    throw new Error("GitHub isn't set up on this computer.");
  },
  getPr: async () => {
    throw new Error("GitHub isn't set up on this computer.");
  },
  checks: async () => ({ state: "none", failing: [] }),
  mergePr: async () => {
    throw new Error("GitHub isn't set up on this computer.");
  },
};

const PR_FIELDS = "number,url,state,baseRefName";

interface RawPr {
  number: number;
  url: string;
  state: string;
  baseRefName: string;
}

function toPr(raw: RawPr): PullRequest {
  const state = raw.state.toUpperCase();
  return {
    number: raw.number,
    url: raw.url,
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
    baseBranch: raw.baseRefName,
  };
}

/** The `gh`-backed client. Arguments are always an array; nothing goes through a shell. */
export function createGhClient(exec: Exec = defaultExec): GitHubClient {
  const gh = (cwd: string, args: string[]) => exec("gh", args, { cwd, timeoutMs: 120_000 });
  const parse = <T>(text: string): T => JSON.parse(text) as T;
  const fail = (what: string, result: Awaited<ReturnType<Exec>>): Error =>
    new Error(`${what}: ${gitProblem(result)}`);

  return {
    async repo(cwd) {
      const auth = await gh(cwd, ["auth", "status"]);
      if (auth.error === "ENOENT") {
        return { ok: false, reason: "GitHub's tool (gh) isn't installed on this computer." };
      }
      if (auth.code !== 0) {
        return { ok: false, reason: "GitHub's tool (gh) isn't signed in on this computer." };
      }
      const view = await gh(cwd, [
        "repo",
        "view",
        "--json",
        "nameWithOwner,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
      ]);
      if (view.code !== 0) {
        return { ok: false, reason: "This project isn't on a GitHub repository I can use." };
      }
      const raw = parse<{
        nameWithOwner: string;
        defaultBranchRef: { name: string } | null;
        mergeCommitAllowed: boolean;
        squashMergeAllowed: boolean;
        rebaseMergeAllowed: boolean;
      }>(view.stdout);
      return {
        ok: true,
        host: {
          name: raw.nameWithOwner,
          defaultBranch: raw.defaultBranchRef?.name ?? "main",
          allowed: {
            merge: raw.mergeCommitAllowed,
            squash: raw.squashMergeAllowed,
            rebase: raw.rebaseMergeAllowed,
          },
        },
      };
    },

    async findPr(cwd, branch) {
      const result = await gh(cwd, [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        PR_FIELDS,
        "--limit",
        "20",
      ]);
      if (result.code !== 0) throw fail("Could not look up the pull request", result);
      const prs = parse<RawPr[]>(result.stdout || "[]").map(toPr);
      return prs.find((p) => p.state === "open") ?? prs.find((p) => p.state === "merged");
    },

    async createPr(cwd, input) {
      const created = await gh(cwd, [
        "pr",
        "create",
        "--head",
        input.head,
        "--base",
        input.base,
        "--title",
        input.title,
        "--body",
        input.body,
      ]);
      if (created.code !== 0) throw fail("Could not open the pull request", created);
      const url = created.stdout.trim().split(/\s+/).pop() ?? "";
      const view = await gh(cwd, ["pr", "view", url, "--json", PR_FIELDS]);
      if (view.code !== 0) throw fail("Could not read the new pull request", view);
      return toPr(parse<RawPr>(view.stdout));
    },

    async getPr(cwd, number) {
      const view = await gh(cwd, ["pr", "view", String(number), "--json", PR_FIELDS]);
      if (view.code !== 0) throw fail("Could not read the pull request", view);
      return toPr(parse<RawPr>(view.stdout));
    },

    async checks(cwd, number) {
      const result = await gh(cwd, [
        "pr",
        "checks",
        String(number),
        "--required",
        "--json",
        "name,bucket",
      ]);
      // gh exits 1 for failing checks and 8 for pending ones; both still print the list.
      if (!result.stdout.trim()) {
        if (/no (required )?checks reported/i.test(result.stderr))
          return { state: "none", failing: [] };
        if (result.code !== 0) throw fail("Could not read the checks", result);
        return { state: "none", failing: [] };
      }
      const checks = parse<{ name: string; bucket: string }[]>(result.stdout);
      if (checks.length === 0) return { state: "none", failing: [] };
      const failing = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
      if (failing.length) return { state: "failing", failing: failing.map((c) => c.name) };
      if (checks.some((c) => c.bucket === "pending")) return { state: "pending", failing: [] };
      return { state: "passing", failing: [] };
    },

    async mergePr(cwd, number, method) {
      // No --delete-branch: gh would also change the local checkout.
      const result = await gh(cwd, ["pr", "merge", String(number), `--${method}`]);
      if (result.code !== 0) throw fail("GitHub did not merge the pull request", result);
    },
  };
}
