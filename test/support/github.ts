import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Checks,
  GitHubClient,
  MergeMethod,
  PullRequest,
  RepoHost,
} from "../../src/landing/github.js";
import { git } from "./git.js";

/**
 * A stand-in for GitHub: a real bare repository is the remote, pull requests and checks are
 * kept in memory, and merging really merges (in a scratch clone), so the work lands for real.
 */
export class FakeGitHub implements GitHubClient {
  readonly prs: (PullRequest & { head: string; title: string; body: string })[] = [];
  readonly calls: string[] = [];
  readonly merges: MergeMethod[] = [];
  /** What the required checks look like; may change over time. */
  checks_: () => Checks = () => ({ state: "none", failing: [] });
  allowed: RepoHost["allowed"] = { merge: true, squash: true, rebase: true };
  /** The next createPr creates the pull request and then fails, as a dropped connection would. */
  dropNextCreate = false;
  mergeError: string | undefined;

  constructor(readonly origin: string) {}

  count(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }

  async repo() {
    this.calls.push("repo");
    return {
      ok: true as const,
      host: { name: "octo/hello", defaultBranch: "main", allowed: this.allowed },
    };
  }

  async findPr(_cwd: string, branch: string) {
    this.calls.push("findPr");
    return (
      this.prs.find((p) => p.head === branch && p.state === "open") ??
      this.prs.find((p) => p.head === branch && p.state === "merged")
    );
  }

  async createPr(_cwd: string, input: { head: string; base: string; title: string; body: string }) {
    this.calls.push("createPr");
    const pr = {
      number: this.prs.length + 1,
      url: `https://github.example/octo/hello/pull/${this.prs.length + 1}`,
      state: "open" as const,
      baseBranch: input.base,
      head: input.head,
      title: input.title,
      body: input.body,
    };
    this.prs.push(pr);
    if (this.dropNextCreate) {
      this.dropNextCreate = false;
      throw new Error("connection reset");
    }
    return pr;
  }

  async getPr(_cwd: string, number: number) {
    this.calls.push("getPr");
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no pull request ${number}`);
    return pr;
  }

  async checks() {
    this.calls.push("checks");
    return this.checks_();
  }

  async mergePr(_cwd: string, number: number, method: MergeMethod) {
    this.calls.push("mergePr");
    if (this.mergeError) throw new Error(this.mergeError);
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no pull request ${number}`);
    const scratch = mkdtempSync(join(tmpdir(), "fake-github-"));
    try {
      git(scratch, "clone", "--quiet", this.origin, "work");
      const work = join(scratch, "work");
      git(work, "config", "user.name", "GitHub");
      git(work, "config", "user.email", "noreply@github.example");
      git(work, "checkout", "--quiet", pr.baseBranch);
      if (method === "squash") {
        git(work, "merge", "--squash", `origin/${pr.head}`);
        git(work, "commit", "--quiet", "-m", pr.title);
      } else {
        git(
          work,
          "merge",
          "--quiet",
          "--no-ff",
          "-m",
          `Merge pull request #${pr.number}`,
          `origin/${pr.head}`,
        );
      }
      git(work, "push", "--quiet", "origin", pr.baseBranch);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    }
    this.merges.push(method);
    pr.state = "merged";
  }
}
