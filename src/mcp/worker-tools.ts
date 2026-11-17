import { z } from "zod";
import type { ConfigManager } from "../config/config.js";
import type { GoalEngine } from "../goals/engine.js";
import { PARKED_INSTRUCTION } from "../prompts/worker.js";
import type { Question, Questions } from "../questions/questions.js";
import { type Caller, ToolError, type ToolRegistry } from "./tools.js";

export interface WorkerToolDeps {
  engine: GoalEngine;
  questions: Questions;
  config: ConfigManager;
  /** Hands a new Worker question to the Coordinator. */
  raiseWorkerQuestion(question: Question): void;
}

/** Tools for Workers. */
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
      deliverables: z
        .array(z.string().min(1))
        .max(10)
        .default([])
        .describe(
          "Absolute paths of files the user asked for or should see (a picture, a video, a document, an export). Preston sends them to the user together with the result.",
        ),
    }),
    handler: (report, caller) => {
      deps.engine.recordReport(asWorker(caller).runId, report);
      return "Recorded. Preston will verify the result itself. End your turn now.";
    },
  });
}

function asWorker(caller: Caller): Extract<Caller, { role: "worker" }> {
  if (caller.role !== "worker") throw new ToolError("Only a Worker can call this tool.");
  return caller;
}
