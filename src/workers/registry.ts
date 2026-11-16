import type { Clock } from "../clock.js";
import type { Logger } from "../log.js";
import type { ToolClient } from "../mcp/tools.js";
import { type ClaudeAdapterOptions, createClaudeAdapter } from "./claude/index.js";
import { type CodexAdapterOptions, createCodexAdapter } from "./codex/index.js";
import { agentEnv } from "./env.js";
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

export interface BuiltinAdapterOptions {
  /** Environment the agent CLIs start from; defaults to Preston's own. Nested-session variables are removed. */
  env?: NodeJS.ProcessEnv;
  claude?: Omit<ClaudeAdapterOptions, "env" | "now">;
  codex?: Omit<CodexAdapterOptions, "env" | "now">;
}

/**
 * The adapters Preston ships: the user's own Claude Code and Codex CLIs. Every process they
 * start gets `agentEnv(...)`, so a daemon started from inside an agent session does not make
 * its agents believe they are nested in it. The fake adapter is never part of this list; it is
 * only added through the test environment variable (see daemon).
 */
export function builtinAdapters(options: BuiltinAdapterOptions = {}): AdapterFactories {
  const now = (ctx: AdapterContext) => () => new Date(ctx.clock.now());
  return {
    claude: (ctx) =>
      createClaudeAdapter({
        ...options.claude,
        env: agentEnv(options.env ?? process.env),
        now: now(ctx),
      }),
    codex: (ctx) =>
      createCodexAdapter({
        ...options.codex,
        env: agentEnv(options.env ?? process.env),
        now: now(ctx),
      }),
  };
}

export const BUILTIN_ADAPTERS: AdapterFactories = builtinAdapters();

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
