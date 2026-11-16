import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Goal } from "../../../src/goals/store.js";
import type { Runtime } from "../../../src/runtime.js";
import type { LoggedChannel, World } from "./world.js";
import { git } from "./world.js";

/** The worktrees Preston still holds for any Project in this home. */
export function worktreesIn(home: string): string[] {
  const dir = join(home, "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((project) =>
    readdirSync(join(dir, project)).map((goal) => join(dir, project, goal)),
  );
}

export function prestonBranches(repo: string): string[] {
  return git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/preston")
    .split("\n")
    .filter(Boolean);
}

/** File content on a branch of a repository, or undefined when it is not there. */
export function onBranch(repo: string, branch: string, file: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${branch}:${file}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

export const texts = (channel: LoggedChannel, kind?: Parameters<LoggedChannel["texts"]>[0]) =>
  channel.texts(kind);

/** The Goal reached `completed` as Verified, with the checks re-run by Preston itself. */
export function expectVerified(rt: Runtime, goal: Goal): void {
  expect(goal.state, `Goal ended ${goal.state}: ${goal.detail ?? ""}`).toBe("completed");
  expect(goal.outcome).toBe("verified");
  const verifications = rt.verifications(goal.id);
  expect(verifications.length).toBeGreaterThan(0);
  const last = verifications.at(-1);
  expect(last?.passed).toBe(true);
  expect(last?.results.some((r) => r.source === "brief" && r.passed)).toBe(true);
}

/** Prints the turns of a world (role, Session, tokens) so a failure can be diagnosed. */
export function describeTurns(world: World): string {
  return world.agent.turns
    .map(
      (t) =>
        `${t.role}#${t.number} session=${t.sessionId ?? "?"}${t.resumedFrom ? ` (resumed ${t.resumedFrom})` : ""} end=${t.end ?? "?"} wall=${Math.round((t.wallMs ?? 0) / 1000)}s events=${t.events.length}`,
    )
    .join("\n");
}
