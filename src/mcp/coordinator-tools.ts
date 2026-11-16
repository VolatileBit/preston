import { z } from "zod";
import type { ChannelHub } from "../channels/hub.js";
import { ConfigError, type ConfigManager, maskConfig } from "../config/config.js";
import type { Coordinator } from "../coordinator/coordinator.js";
import { briefSchema } from "../goals/brief.js";
import type { GoalEngine } from "../goals/engine.js";
import { describeGoalState } from "../goals/status.js";
import type { Goal, GoalStore } from "../goals/store.js";
import type { Questions } from "../questions/questions.js";
import type { Adapters } from "../workers/registry.js";
import { ToolError, type ToolRegistry } from "./tools.js";

export interface CoordinatorToolDeps {
  engine: GoalEngine;
  store: GoalStore;
  questions: Questions;
  coordinator: Coordinator;
  config: ConfigManager;
  adapters: Adapters;
  hub: ChannelHub;
}

const goalId = z.string().min(1).describe("Goal ID, e.g. g-3f9a1c0b2d");

/** The Coordinator's tools: Goals, questions, status and config. */
export function registerCoordinatorTools(registry: ToolRegistry, deps: CoordinatorToolDeps): void {
  const { engine, store, questions, coordinator, config } = deps;
  const roles = ["coordinator"] as const;

  registry.add({
    name: "goal_create",
    description:
      "Create a Goal in a Project folder and start a Worker on it. Preston acknowledges it to the user itself.",
    roles,
    input: z.strictObject({
      projectPath: z.string().min(1).describe("Absolute path of the Project folder"),
      brief: briefSchema,
      parentGoalId: goalId.optional().describe("Set for a follow-up to a finished Goal"),
    }),
    handler: ({ projectPath, brief, parentGoalId }) => {
      const replyTo = coordinator.current()?.replyTo;
      const goal = engine.createGoal({
        projectPath,
        brief,
        parentGoalId,
        origin: replyTo
          ? { channel: replyTo.channel, conversationId: replyTo.conversationId }
          : undefined,
      });
      return { goalId: goal.id, state: goal.state };
    },
  });

  registry.add({
    name: "goal_list",
    description: "List Goals in progress and recently finished ones.",
    roles,
    input: z.strictObject({}),
    handler: () => ({ goals: store.listGoals().map(summary) }),
  });

  registry.add({
    name: "goal_get",
    description:
      "Everything about one Goal: Brief, state, Runs, verification results and questions.",
    roles,
    input: z.strictObject({ goalId }),
    handler: ({ goalId: id }) => {
      const goal = requireGoal(store, id);
      return {
        ...summary(goal),
        brief: goal.brief,
        runs: store.runsForGoal(id).map((r) => ({
          id: r.id,
          agent: r.agent,
          state: r.state,
          sessionId: r.sessionId,
          turns: r.turns,
          recoveries: r.recoveries,
          fixAttempts: r.fixAttempts,
          endReason: r.endReason,
          report: r.report,
        })),
        verifications: store.verifications(id).map((v) => ({
          passed: v.passed,
          at: v.endedAt,
          results: v.results.map((c) => ({
            name: c.name,
            command: c.command,
            passed: c.passed,
            exitCode: c.exitCode,
            timedOut: c.timedOut,
          })),
        })),
      };
    },
  });

  registry.add({
    name: "goal_cancel",
    description: "Stop a Goal that has not finished.",
    roles,
    input: z.strictObject({ goalId }),
    handler: ({ goalId: id }) => summary(engine.cancelGoal(id)),
  });

  registry.add({
    name: "goal_update_brief",
    description:
      "Replace a running Goal's Brief (for example after the user corrects it). The Worker is told at its next turn boundary.",
    roles,
    input: z.strictObject({ goalId, brief: briefSchema }),
    handler: ({ goalId: id, brief }) => summary(engine.updateBrief(id, brief)),
  });

  registry.add({
    name: "answer_worker",
    description:
      "Record the answer to an open question: a Worker's question you can answer, or the user's reply to a question sent with ask_human. The first answer wins.",
    roles,
    input: z.strictObject({ questionId: z.string().min(1), answer: z.string().min(1).max(8000) }),
    handler: ({ questionId, answer }) => {
      const result = questions.answer(questionId, answer, coordinator.current()?.replyTo?.channel);
      if (!result.ok) throw new ToolError(result.reason);
      return { questionId, state: result.question.state };
    },
  });

  registry.add({
    name: "ask_human",
    description:
      "Send the user a question on every Channel; the first answer wins. Pass questionId to escalate a Worker's question (the Worker stays parked until it is answered).",
    roles,
    input: z.strictObject({
      question: z
        .string()
        .min(1)
        .max(2000)
        .describe("One plain question with your recommended answer"),
      goalId: goalId.optional(),
      questionId: z.string().min(1).optional().describe("The Worker question being escalated"),
    }),
    handler: ({ question, goalId: id, questionId }) => {
      if (questionId) {
        const existing = questions.find(questionId);
        if (!existing) throw new ToolError(`There is no question ${questionId}.`);
        if (existing.state !== "pending_coordinator") {
          throw new ToolError(
            `Question ${questionId} cannot be escalated: it is ${existing.state}.`,
          );
        }
        return { questionId: questions.escalate(questionId, question).id };
      }
      if (id) requireGoal(store, id);
      return { questionId: questions.askHuman(question, id).id };
    },
  });

  registry.add({
    name: "status",
    description: "Goals, open questions, Channels and agents right now.",
    roles,
    input: z.strictObject({}),
    handler: () => {
      const current = config.get();
      return {
        goals: store.listGoals({ finishedLimit: 5 }).map(summary),
        openQuestions: questions.open().map((q) => ({
          id: q.id,
          state: q.state,
          goalId: q.goalId,
          askedBy: q.askedBy,
          text: q.humanText ?? q.text,
        })),
        channels: deps.hub.status(),
        agents: { enabled: current.agents.enabled, coordinator: current.coordinator.agent ?? null },
        setupComplete: current.setup.complete,
      };
    },
  });

  registry.add({
    name: "config_get",
    description: "Preston's current settings. Credentials are masked.",
    roles,
    input: z.strictObject({}),
    handler: () => maskConfig(config.get()),
  });

  registry.add({
    name: "config_update",
    description:
      "Change settings with a partial patch: objects merge, arrays and values replace, null removes a key. Recorded as a new version.",
    roles,
    input: z.strictObject({
      patch: z.record(z.string(), z.unknown()),
      reason: z.string().min(1).max(200).default("changed in chat"),
    }),
    handler: ({ patch, reason }) => {
      try {
        const { version, config: updated } = config.update(patch, reason);
        return { version, config: maskConfig(updated) };
      } catch (err) {
        if (err instanceof ConfigError)
          throw new ToolError(`That change is not valid: ${err.message}`);
        throw err;
      }
    },
  });

  registry.add({
    name: "config_history",
    description: "Recent config versions, newest first.",
    roles,
    input: z.strictObject({ limit: z.number().int().min(1).max(100).default(20) }),
    handler: ({ limit }) => ({ versions: config.history(limit) }),
  });

  registry.add({
    name: "config_rollback",
    description: "Restore an earlier config version (recorded as a new version).",
    roles,
    input: z.strictObject({ version: z.number().int().min(1) }),
    handler: ({ version }) => {
      try {
        const result = config.rollback(version);
        return { version: result.version, config: maskConfig(result.config) };
      } catch (err) {
        if (err instanceof ConfigError) throw new ToolError(err.message);
        throw err;
      }
    },
  });

  registry.add({
    name: "agents_detect",
    description: "Which coding agent CLIs are installed and signed in on this computer.",
    roles,
    input: z.strictObject({}),
    handler: async () => ({ agents: await deps.adapters.detectAll() }),
  });
}

function summary(goal: Goal) {
  return {
    id: goal.id,
    objective: goal.brief.objective,
    projectPath: goal.projectPath,
    state: goal.state,
    outcome: goal.outcome,
    description: describeGoalState(goal),
    detail: goal.detail,
    parentGoalId: goal.parentGoalId,
    createdAt: goal.createdAt,
    endedAt: goal.endedAt,
  };
}

function requireGoal(store: GoalStore, id: string): Goal {
  const goal = store.findGoal(id);
  if (!goal) throw new ToolError(`There is no goal ${id}.`);
  return goal;
}
