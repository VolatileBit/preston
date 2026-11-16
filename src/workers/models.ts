import type { Clock } from "../clock.js";
import { errorMessage, type Logger } from "../log.js";
import { type Adapters, agentLabel } from "./registry.js";
import type { AgentKind, ModelInfo } from "./types.js";

/**
 * Coordinator defaults per agent (spec: Sonnet 5.5 / GPT-6.1 Sol, Medium effort), as provider IDs.
 * Claude Code 2.1.325 maps its `sonnet` alias to `claude-sonnet-5-5` only for Anthropic's own API
 * (on Bedrock, Vertex and Foundry it is an older Sonnet), so the full ID is used; on those
 * providers Preston falls back to the alias, which names the provider's latest Sonnet.
 * The Codex ID comes from `model/list` and is checked against it before use.
 */
export const COORDINATOR_DEFAULTS: Partial<Record<AgentKind, { model: string; effort: string }>> = {
  claude: { model: "claude-sonnet-5-5", effort: "medium" },
  codex: { model: "gpt-6.1-sol", effort: "medium" },
};

/** `claude --effort` values (Claude Code 2.1.325). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_ALIASES = new Set(["default", "best", "sonnet", "opus", "haiku", "fable", "opusplan"]);
/** Full names, including provider forms such as `us.anthropic.claude-…` or `claude-…[1m]`. */
const CLAUDE_MODEL_NAME = /^[\w.:/@-]*claude-[\w.:/@-]+(\[1m\])?$/i;
const THIRD_PARTY_CLAUDE = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

const LIST_TTL_MS = 60 * 60_000;

export type ModelCheck = { ok: true; warning?: string } | { ok: false; reason: string };

export interface ResolvedModel {
  model?: string | undefined;
  effort?: string | undefined;
  /** Plain explanation when Preston could not use what was configured or the default. */
  note?: string | undefined;
}

/**
 * Which models and efforts each agent offers, and the Coordinator's effective settings.
 * Codex lists its models for free (`model/list`); Claude Code has no listing, so its names and
 * efforts are checked by shape. Listings are cached for an hour.
 */
export class ModelCatalog {
  private lists = new Map<AgentKind, { at: number; models: ModelInfo[] }>();
  private notes = new Map<AgentKind, string>();

  constructor(
    private readonly deps: {
      adapters: Adapters;
      clock: Clock;
      log: Logger;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  /** The models an agent offers, or undefined when it cannot list them. Throws if listing fails. */
  async offered(agent: AgentKind): Promise<ModelInfo[] | undefined> {
    const adapter = this.deps.adapters.get(agent);
    if (!adapter?.listModels) return undefined;
    const cached = this.lists.get(agent);
    const now = this.deps.clock.now();
    if (cached && now - cached.at < LIST_TTL_MS) return cached.models;
    const models = await adapter.listModels();
    this.lists.set(agent, { at: now, models });
    return models;
  }

  /** Whether `agent` accepts this model and effort (unset values inherit the user's own). */
  async check(agent: AgentKind, model?: string, effort?: string): Promise<ModelCheck> {
    const label = agentLabel(agent);
    if (!this.deps.adapters.get(agent)) {
      return { ok: false, reason: `${label} isn't available on this computer.` };
    }
    if (agent === "claude") return checkClaude(model, effort);
    let models: ModelInfo[] | undefined;
    try {
      models = await this.offered(agent);
    } catch (err) {
      return {
        ok: true,
        warning: `I couldn't check which models ${label} offers (${errorMessage(err)}), so I saved it unchecked.`,
      };
    }
    if (!models) return { ok: true };
    const info = model ? models.find((m) => m.id === model) : models.find((m) => m.isDefault);
    if (model && !info) {
      return {
        ok: false,
        reason: `"${model}" isn't one of the models your ${label} account offers. It offers: ${describe(models)}.`,
      };
    }
    if (effort && info?.efforts && !info.efforts.includes(effort)) {
      return {
        ok: false,
        reason: `${info.displayName ?? info.id} doesn't offer "${effort}" effort. Choose one of: ${info.efforts.join(", ")}.`,
      };
    }
    return { ok: true };
  }

  /** The model and effort a Coordinator invocation uses, falling back with a note when needed. */
  async coordinator(
    agent: AgentKind,
    configured: { model?: string | undefined; effort?: string | undefined },
  ): Promise<ResolvedModel> {
    const defaults = COORDINATOR_DEFAULTS[agent];
    const label = agentLabel(agent);
    let model = configured.model ?? defaults?.model;
    let effort = configured.effort ?? defaults?.effort;
    let note: string | undefined;

    if (agent === "claude" && !configured.model && this.thirdPartyClaude()) {
      model = "sonnet";
      note =
        "Claude Code uses a cloud provider other than Anthropic here, so I think with its latest Sonnet instead of Sonnet 5.5.";
    }
    let models: ModelInfo[] | undefined;
    try {
      models = await this.offered(agent);
    } catch (err) {
      this.deps.log.warn("could not list models", { agent, error: errorMessage(err) });
    }
    if (models && model && !models.some((m) => m.id === model)) {
      const wanted = model;
      const fallback = configured.model && defaults && models.find((m) => m.id === defaults.model);
      model = fallback ? fallback.id : undefined;
      const instead = fallback
        ? (fallback.displayName ?? fallback.id)
        : `your own ${label} default${defaultName(models)}`;
      note = `"${wanted}" isn't offered on your ${label} account, so I think with ${instead} instead.`;
    }
    if (models && effort) {
      const info = model ? models.find((m) => m.id === model) : models.find((m) => m.isDefault);
      if (info?.efforts && !info.efforts.includes(effort)) {
        note = [
          note,
          `${info.displayName ?? info.id} doesn't offer "${effort}" effort, so I use its default.`,
        ]
          .filter(Boolean)
          .join(" ");
        effort = undefined;
      }
    }
    this.record(agent, note);
    return { model, effort, note };
  }

  /** The latest model note per agent, for status and setup. */
  note(agent: AgentKind): string | undefined {
    return this.notes.get(agent);
  }

  private record(agent: AgentKind, note: string | undefined): void {
    const previous = this.notes.get(agent);
    if (note) this.notes.set(agent, note);
    else this.notes.delete(agent);
    if (note && note !== previous)
      this.deps.log.warn("coordinator model fallback", { agent, note });
  }

  private thirdPartyClaude(): boolean {
    const env = this.deps.env ?? process.env;
    return THIRD_PARTY_CLAUDE.some((name) => {
      const value = env[name]?.trim().toLowerCase();
      return Boolean(value) && value !== "0" && value !== "false";
    });
  }
}

function checkClaude(model: string | undefined, effort: string | undefined): ModelCheck {
  if (model && !CLAUDE_ALIASES.has(model.toLowerCase()) && !CLAUDE_MODEL_NAME.test(model)) {
    return {
      ok: false,
      reason: `"${model}" isn't a Claude model name. Use an alias such as sonnet, opus or haiku, or a full name such as claude-sonnet-5-5.`,
    };
  }
  if (effort && !(CLAUDE_EFFORTS as readonly string[]).includes(effort)) {
    return {
      ok: false,
      reason: `Claude Code doesn't offer "${effort}" effort. Choose one of: ${CLAUDE_EFFORTS.join(", ")}.`,
    };
  }
  return { ok: true };
}

function describe(models: ModelInfo[]): string {
  return models.map((m) => (m.displayName ? `${m.id} (${m.displayName})` : m.id)).join(", ");
}

function defaultName(models: ModelInfo[]): string {
  const def = models.find((m) => m.isDefault);
  return def ? ` (${def.displayName ?? def.id})` : "";
}
