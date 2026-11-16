import { z } from "zod";
import type { ConfigManager } from "../config/config.js";
import type { GoalEngine } from "../goals/engine.js";
import { claudeAction, claudePermissionResult, decide } from "../policy/approvals.js";
import { PARKED_INSTRUCTION } from "../prompts/worker.js";
import type { Question, Questions } from "../questions/questions.js";
import { PERMISSION_TOOL } from "./names.js";
import { type Caller, ToolError, type ToolRegistry } from "./tools.js";

export interface WorkerToolDeps {
  engine: GoalEngine;
  questions: Questions;
  config: ConfigManager;
  coordinatorWorkdir: string;
  /** Hands a new Worker question to the Coordinator. */
  raiseWorkerQuestion(question: Question): void;
}

/** Tools for Workers, plus the permission tool that both roles' agents may call. */
export function registerWorkerTools(registry: ToolRegistry, deps: WorkerToolDeps): void {
  registry.add({
    name: "ask_preston",
    description:
      "Ask Preston one clear question you cannot settle from the Brief or the Project. Returns the answer, or tells you the question is parked: then finish everything that does not depend on the answer and end your turn; Preston resumes this session with the answer.",
    roles: ["worker"],
    input: z.strictObject({ question: z.string().min(1).max(4000) }),
    handler: async ({ question }, caller) => {
      const worker = asWorker(caller);
      const asked = deps.questions.askFromWorker(worker.runId, worker.goalId, question);
      deps.raiseWorkerQuestion(asked);
      const result = await deps.questions.waitForAnswer(
        asked.id,
        deps.config.get().questions.workerWaitMs,
      );
      return "answer" in result ? result.answer : PARKED_INSTRUCTION;
    },
  });

  registry.add({
    name: "report_result",
    description:
      "Report that the Goal is finished, or that you are genuinely blocked. Preston re-runs the checks itself before telling the user.",
    roles: ["worker"],
    input: z.strictObject({
      summary: z.string().min(1).max(8000),
      checksPerformed: z.array(z.string()).max(50).default([]),
      suggestedVerificationCommands: z
        .array(z.string().min(1))
        .max(20)
        .default([])
        .describe("Commands Preston can run itself in the working directory to verify the result"),
      blockers: z
        .array(z.string().min(1))
        .max(20)
        .default([])
        .describe("Things only the user can provide; empty when the work is finished"),
    }),
    handler: (report, caller) => {
      deps.engine.recordReport(asWorker(caller).runId, report);
      return "Recorded. Preston will verify the result itself. End your turn now.";
    },
  });

  registry.add({
    name: PERMISSION_TOOL,
    description:
      "Permission prompt handler for Claude Code (--permission-prompt-tool). Decides with Preston's approval policy.",
    roles: ["worker", "coordinator"],
    input: z.looseObject({
      tool_name: z.string().min(1),
      input: z.record(z.string(), z.unknown()).default({}),
    }),
    handler: (request, caller) => {
      const action = claudeAction(request);
      const decision =
        caller.role === "worker"
          ? deps.engine.approve(caller.runId, action)
          : decide(action, { workdir: deps.coordinatorWorkdir }).decision;
      return claudePermissionResult(decision, request);
    },
  });
}

function asWorker(caller: Caller): Extract<Caller, { role: "worker" }> {
  if (caller.role !== "worker") throw new ToolError("Only a Worker can call this tool.");
  return caller;
}
