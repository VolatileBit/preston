import type { ChannelKind } from "../channels/types.js";
import { type Clock, isoNow } from "../clock.js";
import type { ConfigManager } from "../config/config.js";
import type { Logger } from "../log.js";
import { ToolError } from "../mcp/tools.js";
import type { Questions } from "../questions/questions.js";
import { all, type Db, one, recordEvent, run, transaction } from "../store/db.js";
import { newId } from "../util/ids.js";
import type { ApprovalDecision } from "../workers/types.js";
import type { PolicyAction } from "./policy.js";

/**
 * Approvals the deterministic policy escalated (ADR 0003). The Worker's native request blocks
 * while the Coordinator decides within the Brief's authority, or asks the user. The wait is
 * bounded: after `approvals.escalationWaitMs` the request is declined for now and the Worker
 * carries on with other work. Each approval is linked to a Worker question, so a decision that
 * arrives later resumes the Worker's Session through the same path as a parked question.
 */

export type ApprovalState = "pending" | "allowed" | "denied" | "cancelled";

export interface Approval {
  id: string;
  goalId: string;
  runId: string;
  questionId: string;
  action: PolicyAction;
  /** What the Worker wants to do, in plain words ("run `git push origin main`"). */
  summary: string;
  /** Why the policy escalated it. */
  policyReason: string;
  state: ApprovalState;
  decidedBy: "coordinator" | "human" | null;
  decisionReason: string | null;
  /** How the Worker learnt the outcome: in the native reply, or declined-for-now. */
  workerTold: "decision" | "escalated" | null;
  createdAt: string;
}

interface ApprovalRow {
  id: string;
  goal_id: string;
  run_id: string;
  question_id: string;
  action: string;
  summary: string;
  policy_reason: string;
  state: ApprovalState;
  decided_by: Approval["decidedBy"];
  decision_reason: string | null;
  worker_told: Approval["workerTold"];
  created_at: string;
}

export interface ApprovalsDeps {
  db: Db;
  clock: Clock;
  questions: Questions;
  config: ConfigManager;
  log: Logger;
  /** Hands a new (or, after a restart, still undecided) approval to the Coordinator. */
  raise(approval: Approval): void;
}

export class Approvals {
  private waiters = new Map<string, (decision: ApprovalDecision) => void>();
  private raised = new Set<string>();

  constructor(private readonly deps: ApprovalsDeps) {}

  /** Blocks until a decision or the escalation wait ends; then answers the Worker's request. */
  async request(
    target: { runId: string; goalId: string },
    action: PolicyAction,
    policyReason: string,
  ): Promise<ApprovalDecision> {
    const { db, clock, questions } = this.deps;
    const id = newId("a");
    const summary = describeAction(action);
    const approval = transaction(db, () => {
      const question = questions.askFromWorker(
        target.runId,
        target.goalId,
        `Approval ${id}: may the Worker ${summary}? Preston's policy escalated it because ${policyReason}.`,
      );
      run(
        db,
        `INSERT INTO approvals (id, goal_id, run_id, question_id, action, summary, policy_reason, state, created_at)
         VALUES (:id, :goal, :run, :question, :action, :summary, :reason, 'pending', :at)`,
        {
          id,
          goal: target.goalId,
          run: target.runId,
          question: question.id,
          action: JSON.stringify(action),
          summary,
          reason: policyReason,
          at: isoNow(clock),
        },
      );
      recordEvent(db, clock, "approval_escalated", target, {
        approvalId: id,
        summary,
        reason: policyReason,
      });
      return this.get(id);
    });
    const decided = new Promise<ApprovalDecision | undefined>((resolve) => {
      const timer = clock.setTimeout(
        () => finish(undefined),
        this.deps.config.get().approvals.escalationWaitMs,
      );
      const finish = (decision: ApprovalDecision | undefined) => {
        timer.cancel();
        this.waiters.delete(id);
        resolve(decision);
      };
      this.waiters.set(id, finish);
    });
    this.raise(approval);
    const decision = await decided;
    if (decision) return decision;
    this.setWorkerTold(id, "escalated");
    this.deps.log.info("approval still undecided; declined for now", { approvalId: id });
    return { allow: false, reason: escalatedReason(id, summary) };
  }

  /**
   * Records the decision. A Worker still waiting gets it as the native answer; otherwise its
   * Session is resumed with it (through the linked question) once its turn has ended.
   */
  decide(
    idOrQuestionId: string,
    allow: boolean,
    reason: string,
    by: { decidedBy: "coordinator" | "human"; via?: ChannelKind | undefined },
  ): Approval {
    const approval = this.find(idOrQuestionId) ?? this.byQuestion(idOrQuestionId);
    if (!approval) throw new ToolError(`There is no approval ${idOrQuestionId}.`);
    if (approval.state !== "pending") {
      throw new ToolError(`Approval ${approval.id} was already ${approval.state}.`);
    }
    const question = this.deps.questions.find(approval.questionId);
    if (!question || question.state === "cancelled" || question.state === "answered") {
      this.setState(approval.id, "cancelled", null, null);
      throw new ToolError(`Approval ${approval.id} is no longer needed: its Goal moved on.`);
    }
    const { db, questions, clock } = this.deps;
    const waiter = this.waiters.get(approval.id);
    const decision: ApprovalDecision = allow
      ? { allow: true }
      : { allow: false, reason: `Not approved: ${reason}` };
    const answer = allow
      ? `Approved (${reason}). You may now ${approval.summary}. Go ahead with it, then continue the Goal.`
      : `Not approved (${reason}). Do not ${approval.summary}. Finish the Goal without it; if it cannot be done without it, list that under blockers when you call report_result.`;
    transaction(db, () => {
      this.setState(approval.id, allow ? "allowed" : "denied", by.decidedBy, reason);
      recordEvent(db, clock, "approval_decided", approval, {
        approvalId: approval.id,
        allow,
        by: by.decidedBy,
      });
      const result = questions.answer(approval.questionId, answer, by.via);
      if (waiter && result.ok) {
        // The Worker gets the decision in its native reply, so its Session needs no resume.
        this.setWorkerTold(approval.id, "decision");
        questions.markDelivered([approval.questionId]);
      }
    });
    waiter?.(decision);
    this.deps.log.info("approval decided", { approvalId: approval.id, allow, by: by.decidedBy });
    return this.get(approval.id);
  }

  /** Raises every undecided approval again (after a restart nothing is waiting in memory). */
  recover(): void {
    const pending = all<ApprovalRow>(
      this.deps.db,
      "SELECT * FROM approvals WHERE state = 'pending' ORDER BY created_at, rowid",
    ).map(toApproval);
    for (const approval of pending) {
      const question = this.deps.questions.find(approval.questionId);
      if (question?.state === "pending_coordinator") this.raise(approval);
      else if (question?.state !== "pending_human")
        this.setState(approval.id, "cancelled", null, null);
    }
  }

  /** Hands an approval to the Coordinator once per process. */
  raise(approval: Approval): void {
    if (this.raised.has(approval.id)) return;
    this.raised.add(approval.id);
    this.deps.raise(approval);
  }

  /** Every Worker waiting for a decision gets "declined for now" (Preston is stopping). */
  releaseWaiters(): void {
    for (const finish of [...this.waiters.values()])
      finish({ allow: false, reason: "Preston is restarting." });
  }

  find(id: string): Approval | undefined {
    const row = one<ApprovalRow>(this.deps.db, "SELECT * FROM approvals WHERE id = :id", { id });
    return row ? toApproval(row) : undefined;
  }

  byQuestion(questionId: string): Approval | undefined {
    const row = one<ApprovalRow>(this.deps.db, "SELECT * FROM approvals WHERE question_id = :q", {
      q: questionId,
    });
    return row ? toApproval(row) : undefined;
  }

  get(id: string): Approval {
    const approval = this.find(id);
    if (!approval) throw new Error(`There is no approval ${id}.`);
    return approval;
  }

  private setState(
    id: string,
    state: ApprovalState,
    by: Approval["decidedBy"],
    reason: string | null,
  ): void {
    run(
      this.deps.db,
      "UPDATE approvals SET state = :state, decided_by = :by, decision_reason = :reason, decided_at = :at WHERE id = :id",
      { id, state, by, reason, at: isoNow(this.deps.clock) },
    );
  }

  private setWorkerTold(id: string, told: "decision" | "escalated"): void {
    run(this.deps.db, "UPDATE approvals SET worker_told = :told WHERE id = :id", { id, told });
  }
}

/** The native answer when no decision arrived in time. */
export function escalatedReason(id: string, summary: string): string {
  return (
    `Preston has escalated this request (approval ${id}: ${summary}) and has no decision yet. ` +
    "Do not try to get around it. Continue with the parts of the Goal that do not need it, then end your turn " +
    "without calling report_result for this; if it is approved, Preston resumes this session and tells you."
  );
}

/** A plain description of an action, for the Coordinator and the user. */
export function describeAction(action: PolicyAction): string {
  switch (action.kind) {
    case "command":
      return `run \`${truncate(action.command, 300)}\`${action.cwd ? ` in ${action.cwd}` : ""}`;
    case "write":
      return `change ${action.paths.join(", ") || "files"}`;
    case "read":
      return `read ${action.paths.join(", ") || "files"}`;
    case "network":
      return `use the network (${truncate(action.summary, 200)})`;
    case "preston":
      return "use one of Preston's own tools";
    case "other":
      return `use ${truncate(action.summary, 200)}`;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    goalId: row.goal_id,
    runId: row.run_id,
    questionId: row.question_id,
    action: JSON.parse(row.action) as PolicyAction,
    summary: row.summary,
    policyReason: row.policy_reason,
    state: row.state,
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    workerTold: row.worker_told,
    createdAt: row.created_at,
  };
}
