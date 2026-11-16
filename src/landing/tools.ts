import { z } from "zod";
import type { ToolRegistry } from "../mcp/tools.js";
import type { Landing } from "./landing.js";

/** The Coordinator's tools for Projects. */
export function registerLandingTools(registry: ToolRegistry, deps: { landing: Landing }): void {
  registry.add({
    name: "project_list",
    description:
      "The Projects (folders) Preston keeps context for, each looked at right now: whether it is a Git repository, its main branch, the branch checked out, whether it has a remote and uncommitted edits, and its Goals. Projects are created by goal_create.",
    roles: ["coordinator"],
    input: z.strictObject({}),
    handler: async () => ({
      projects: (await deps.landing.projects()).map((p) => ({
        id: p.id,
        path: p.path,
        name: p.name,
        kind: p.info.kind,
        ...(p.info.repo
          ? {
              repository: {
                bare: p.info.repo.bare,
                noCommitsYet: p.info.repo.unborn,
                mainBranch: p.info.repo.defaultBranch,
                checkedOutBranch: p.info.repo.currentBranch,
                detachedHead: p.info.repo.detached,
                remote: p.info.repo.remote
                  ? { host: p.info.repo.remote.host, url: p.info.repo.remote.url }
                  : null,
                uncommittedEdits: p.info.repo.dirty,
                folderInRepository: p.info.repo.prefix || null,
              },
            }
          : {}),
        ...(p.info.gitMissing ? { note: "Git is not installed on this computer." } : {}),
        activeGoals: p.activeGoals,
        totalGoals: p.totalGoals,
      })),
    }),
  });
}
