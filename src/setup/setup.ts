import { TERMINAL_CONVERSATION } from "../channels/terminal.js";
import type { ConfigManager } from "../config/config.js";
import type { Coordinator } from "../coordinator/coordinator.js";
import type { Language } from "../i18n/index.js";
import { type Adapters, agentLabel } from "../workers/registry.js";
import type { AgentKind } from "../workers/types.js";

export interface SetupAgent {
  agent: AgentKind;
  label: string;
  installed: boolean;
  version?: string | undefined;
  problem?: string | undefined;
}

export interface SetupState {
  /** No agent chosen yet: the terminal runs the deterministic agent step first. */
  needsAgents: boolean;
  complete: boolean;
  /** The language Preston speaks to the user in. */
  language: Language;
  agents: SetupAgent[];
  /** Setup left to do even when `complete` (for example a Channel that needs pairing again). */
  unfinished: string[];
}

export interface SetupDeps {
  config: ConfigManager;
  adapters: Adapters;
  coordinator: Coordinator;
  /** Plain descriptions of chat Channels that are configured but not usable until paired. */
  channelsNeedingPairing(): string[];
}

/** Preston thinks with Codex when the user uses it, otherwise with the first agent chosen. */
export function defaultCoordinator(agents: readonly AgentKind[]): AgentKind {
  return agents.includes("codex") ? "codex" : (agents[0] as AgentKind);
}

/**
 * Setup bootstrap. Choosing agents is deterministic (the Coordinator needs an agent to exist);
 * everything after that is a conversation with the Coordinator. Progress lives in config
 * (`agents`, `channels`, `setup.complete`), so running `preston` again resumes unfinished
 * setup, including a Channel that needs pairing again after setup was completed.
 */
export class Setup {
  constructor(private readonly deps: SetupDeps) {}

  async state(): Promise<SetupState> {
    const config = this.deps.config.get();
    const detected = await this.deps.adapters.detectAll();
    return {
      needsAgents: config.agents.enabled.length === 0 || !config.coordinator.agent,
      complete: config.setup.complete,
      language: config.language,
      agents: detected.map(({ agent, label, detection }) => ({
        agent,
        label,
        installed: detection.installed,
        version: detection.version,
        problem: detection.problem,
      })),
      unfinished: this.deps.channelsNeedingPairing(),
    };
  }

  async chooseAgents(choice: {
    agents: AgentKind[];
    balanceByQuota: boolean;
    /** Which of `agents` does Preston's own thinking; default Codex when it is among them. */
    coordinator?: AgentKind | undefined;
    language?: Language | undefined;
  }): Promise<void> {
    const installed = new Set(
      (await this.state()).agents.filter((a) => a.installed).map((a) => a.agent),
    );
    const agents = [...new Set(choice.agents)];
    const missing = agents.find((a) => !installed.has(a));
    if (agents.length === 0 || missing) {
      throw new Error(
        missing ? `${agentLabel(missing)} is not installed.` : "Choose at least one agent.",
      );
    }
    const coordinator = choice.coordinator ?? defaultCoordinator(agents);
    if (!agents.includes(coordinator)) {
      throw new Error(`${agentLabel(coordinator)} is not one of the agents chosen.`);
    }
    this.deps.config.update(
      {
        agents: { enabled: agents, balanceByQuota: agents.length > 1 && choice.balanceByQuota },
        coordinator: { agent: coordinator },
        ...(choice.language ? { language: choice.language } : {}),
      },
      "agents chosen during setup",
    );
  }

  /** Hands the terminal conversation to the Coordinator when setup is unfinished. */
  continue(options: { justChoseAgents: boolean }): boolean {
    const config = this.deps.config.get();
    const unfinished = this.deps.channelsNeedingPairing();
    if (config.setup.complete && unfinished.length === 0) return false;
    const chosen = config.agents.enabled.map(agentLabel).join(" and ");
    const channels = unfinished.length
      ? ` These Channels need attention: ${unfinished.join(" ")} Offer to pair them again (channel_pair).`
      : "";
    const note = config.setup.complete
      ? `The user reopened Preston. Setup was finished, but something needs fixing.${channels}`
      : options.justChoseAgents
        ? `Setup is not complete. The user just chose to use ${chosen}${config.agents.balanceByQuota ? ", balanced by remaining quota" : ""}. Welcome them briefly and continue setup.${channels}`
        : `The user reopened Preston and setup is not complete yet. Check channel_status and pick up where it left off.${channels}`;
    this.deps.coordinator.submit({
      kind: "setup",
      note,
      channel: "terminal",
      conversationId: TERMINAL_CONVERSATION,
    });
    return true;
  }
}
