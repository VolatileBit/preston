import type { Clock } from "../clock.js";
import type { Logger } from "../log.js";
import type { ToolClient } from "../mcp/tools.js";
import type { AgentDetection, AgentKind, WorkerAdapter } from "./types.js";

/** What Preston hands an adapter factory when it builds the adapter. */
export interface AdapterContext {
  home: string;
  clock: Clock;
  log: Logger;
  /** In-process access to Preston's MCP tools. Real CLIs reach them through `preston mcp`. */
  tools: ToolClient;
}

export type AdapterFactory = (ctx: AdapterContext) => WorkerAdapter;
export type AdapterFactories = Partial<Record<AgentKind, AdapterFactory>>;

const LABELS: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  fake: "Fake agent",
};

export function agentLabel(kind: AgentKind): string {
  return LABELS[kind];
}

/** The agents a user can choose during setup, in order of preference. */
export const USER_AGENTS: readonly AgentKind[] = ["claude", "codex"];

/**
 * The adapters Preston ships. The real Claude Code and Codex adapters plug in here:
 * replace each stub with `(ctx) => createClaudeAdapter({...})` from `./claude/index.js` and
 * `(ctx) => createCodexAdapter({...})` from `./codex/index.js`. The fake adapter is never part
 * of this list; it is only added through the test environment variable (see daemon).
 */
export const BUILTIN_ADAPTERS: AdapterFactories = {
  // TODO(claude adapter): return createClaudeAdapter(...) once src/workers/claude is integrated.
  claude: () => notIntegrated("claude"),
  // TODO(codex adapter): return createCodexAdapter(...) once src/workers/codex is integrated.
  codex: () => notIntegrated("codex"),
};

function notIntegrated(agent: AgentKind): WorkerAdapter {
  const detection: AgentDetection = {
    installed: false,
    problem: `Preston's ${LABELS[agent]} support is not available in this build yet.`,
  };
  return {
    agent,
    detect: async () => detection,
    startRun: () => {
      throw new Error(detection.problem);
    },
  };
}

/** The adapters a runtime uses, built once from their factories. */
export class Adapters {
  private adapters = new Map<AgentKind, WorkerAdapter>();

  constructor(factories: AdapterFactories, ctx: AdapterContext) {
    for (const [kind, factory] of Object.entries(factories) as [AgentKind, AdapterFactory][]) {
      this.adapters.set(kind, factory(ctx));
    }
  }

  get(kind: AgentKind): WorkerAdapter | undefined {
    return this.adapters.get(kind);
  }

  kinds(): AgentKind[] {
    return [...this.adapters.keys()];
  }

  async detectAll(): Promise<{ agent: AgentKind; label: string; detection: AgentDetection }[]> {
    return Promise.all(
      this.kinds().map(async (agent) => ({
        agent,
        label: agentLabel(agent),
        detection: (await this.adapters
          .get(agent)
          ?.detect()
          .catch(
            (err: unknown) => ({ installed: false, problem: String(err) }) as AgentDetection,
          )) ?? {
          installed: false,
        },
      })),
    );
  }
}
