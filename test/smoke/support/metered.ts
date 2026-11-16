import { COORDINATOR_RUN_ID } from "../../../src/mcp/names.js";
import type {
  QuotaReading,
  RunHandle,
  StartRunInput,
  TokenUsage,
  WorkerAdapter,
  WorkerEvent,
} from "../../../src/workers/types.js";
import { record } from "./ledger.js";

/** What happened in one real agent turn, as Preston saw it. */
export interface TurnLog {
  role: "coordinator" | "worker";
  /** 1-based, per role. */
  number: number;
  workdir: string;
  resumedFrom?: string | undefined;
  sessionId?: string | undefined;
  prompt: string;
  appendSystemPrompt?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  startedAt: number;
  wallMs?: number;
  end?: string;
  usage?: TokenUsage | undefined;
  /** Event types in order, for diagnosing a turn that went wrong. */
  events: string[];
  /** The last assistant text of the turn. */
  finalText?: string | undefined;
}

export interface MeteredOptions {
  scenario: string;
  provider: string;
  /** Replaces a real event with others, to force a condition a real account cannot produce. */
  rewrite?(
    turn: TurnLog,
    event: WorkerEvent,
  ): WorkerEvent[] | { emit: WorkerEvent[]; stop: true } | undefined;
  /** Replaces the token-free quota read. */
  readQuota?: () => Promise<QuotaReading[]>;
  /** Called when a real turn starts, with the live handle (to inspect its process). */
  onTurnStart?(turn: TurnLog, handle: RunHandle): void;
}

export interface Metered extends WorkerAdapter {
  readonly turns: TurnLog[];
  turnsOf(role: TurnLog["role"]): TurnLog[];
}

/**
 * Wraps a real adapter, passing every call and event through unchanged, and records each turn
 * (role, Session, tokens, how it ended) to the cost ledger. `rewrite` and `readQuota` are the
 * only places a test may alter what the real agent did, and each scenario that uses them says so.
 */
export function metered(real: WorkerAdapter, options: MeteredOptions): Metered {
  const turns: TurnLog[] = [];
  const counts = { coordinator: 0, worker: 0 };
  const wrapped: Metered = {
    agent: real.agent,
    turns,
    turnsOf: (role) => turns.filter((t) => t.role === role),
    detect: () => real.detect(),
    startRun(input: StartRunInput): RunHandle {
      const role = input.runId === COORDINATOR_RUN_ID ? "coordinator" : "worker";
      const turn: TurnLog = {
        role,
        number: ++counts[role],
        workdir: input.workdir,
        resumedFrom: input.resumeSessionId,
        prompt: input.prompt,
        appendSystemPrompt: input.appendSystemPrompt,
        model: input.model,
        effort: input.effort,
        startedAt: Date.now(),
        events: [],
      };
      turns.push(turn);
      const handle = real.startRun(input);
      options.onTurnStart?.(turn, handle);
      return {
        sessionId: () => handle.sessionId(),
        interrupt: () => handle.interrupt(),
        ...(handle.processId ? { processId: () => handle.processId?.() } : {}),
        events: events(handle),
      };

      async function* events(source: RunHandle): AsyncGenerator<WorkerEvent> {
        let interrupting: Promise<unknown> | undefined;
        try {
          for await (const event of source.events) {
            turn.events.push(event.type);
            if (event.type === "started") turn.sessionId = event.sessionId;
            if (event.type === "message") turn.finalText = event.text;
            if (event.type === "completed") {
              turn.usage = event.usage;
              turn.finalText = event.finalText || turn.finalText;
            }
            const replaced = options.rewrite?.(turn, event);
            if (replaced) {
              const stop = !Array.isArray(replaced);
              const emit = Array.isArray(replaced) ? replaced : replaced.emit;
              // `stop`: the real turn is cut short (interrupted) as a real quota hit would.
              if (stop) interrupting = source.interrupt().catch(() => undefined);
              for (const e of emit) {
                if (e.type === "quota_blocked" || e.type === "failed") turn.end = e.type;
                yield e;
              }
              if (stop) {
                yield {
                  type: "exited",
                  at: new Date().toISOString(),
                  code: null,
                  signal: "SIGINT",
                };
                return;
              }
              continue;
            }
            if (
              event.type !== "exited" &&
              event.type !== "started" &&
              event.type !== "activity" &&
              event.type !== "message"
            ) {
              turn.end ??= event.type;
            }
            yield event;
          }
        } finally {
          await interrupting;
          turn.wallMs = Date.now() - turn.startedAt;
          record({
            kind: "turn",
            scenario: options.scenario,
            provider: options.provider,
            role,
            wallMs: turn.wallMs,
            end: turn.end ?? "exited",
            ...(turn.usage?.inputTokens !== undefined
              ? { inputTokens: turn.usage.inputTokens }
              : {}),
            ...(turn.usage?.outputTokens !== undefined
              ? { outputTokens: turn.usage.outputTokens }
              : {}),
            ...(turn.usage?.cachedInputTokens !== undefined
              ? { cachedInputTokens: turn.usage.cachedInputTokens }
              : {}),
            ...(turn.usage?.costUsd !== undefined ? { costUsd: turn.usage.costUsd } : {}),
          });
        }
      }
    },
  };
  const read = options.readQuota ?? real.readQuota?.bind(real);
  if (read) wrapped.readQuota = read;
  if (real.listModels) wrapped.listModels = real.listModels.bind(real);
  if (real.update) wrapped.update = real.update.bind(real);
  return wrapped;
}
