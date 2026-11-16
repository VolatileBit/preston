import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FakeScript } from "../../src/workers/fake/index.js";
import { git, write } from "./git.js";
import { goalCreatingCoordinator, ownerMessage, reportingWorker, waitFor } from "./harness.js";

/** A Worker that writes `file` in its working folder and reports success. */
export function writingWorker(file = "feature.txt", content = "hello\n"): FakeScript {
  return async (turn) => {
    write(turn.input.workdir, file, content);
    return reportingWorker(turn);
  };
}

/**
 * A Coordinator that creates the Goal when told "go" and records any other owner message as the
 * answer to the open question (what the real Coordinator does with the user's reply).
 */
export function answeringCoordinator(
  project: string,
  goalBrief: Record<string, unknown>,
  extra: FakeScript = () => "",
): FakeScript {
  return goalCreatingCoordinator(project, goalBrief, async (turn) => {
    const text = ownerMessage(turn);
    if (!text) return extra(turn);
    const status = JSON.parse(await turn.callTool("status")) as { openQuestions: { id: string }[] };
    const open = status.openQuestions[0];
    if (!open) return "Nothing was waiting for an answer.";
    await turn.callTool("answer_worker", { questionId: open.id, answer: text });
    return "Passing that on.";
  });
}

export const worktreesIn = (home: string): string[] => {
  const dir = join(home, "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((project) =>
    readdirSync(join(dir, project)).map((goal) => join(dir, project, goal)),
  );
};

export const branches = (repo: string): string[] =>
  git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);

/** A check that records what it can see in the folder it runs in. */
export function loggingCheck(log: string, files: string[]) {
  const logPath = log.replace(/\\/g, "/");
  const probe = files.map((f) => `fs.existsSync('${f}')`).join(",");
  return {
    name: "it works",
    command: `node -e "const fs=require('fs');fs.appendFileSync('${logPath}',[${probe}].join()+'\\n')"`,
  };
}

export { waitFor };
