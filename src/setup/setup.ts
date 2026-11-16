import { TERMINAL_CONVERSATION } from "../channels/terminal.js";
import type { ConfigManager } from "../config/config.js";
import type { Coordinator } from "../coordinator/coordinator.js";
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
  agents: SetupAgent[];
}

/**
 * Setup bootstrap. Choosing agents is deterministic (the Coordinator needs an agent to exist);
 * everything after that is a conversation with the Coordinator. Completion lives in config,
 * so running `preston` again resumes unfinished setup.
 */
export class Setup {
  constructor(
    private readonly deps: { config: ConfigManager; adapters: Adapters; coordinator: Coordinator },
  ) {}

  async state(): Promise<SetupState> {
    const config = this.deps.config.get();
    const detected = await this.deps.adapters.detectAll();
    return {
      needsAgents: config.agents.enabled.length === 0 || !config.coordinator.agent,
      complete: config.setup.complete,
      agents: detected.map(({ agent, label, detection }) => ({
        agent,
        label,
        installed: detection.installed,
        version: detection.version,
        problem: detection.problem,
      })),
    };
  }

  async chooseAgents(choice: { agents: AgentKind[]; balanceByQuota: boolean }): Promise<void> {
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
    this.deps.config.update(
      {
        agents: { enabled: agents, balanceByQuota: agents.length > 1 && choice.balanceByQuota },
        coordinator: { agent: agents[0] },
      },
      "agents chosen during setup",
    );
  }

  /** Hands the terminal conversation to the Coordinator when setup is unfinished. */
  continue(options: { justChoseAgents: boolean }): boolean {
    const config = this.deps.config.get();
    if (config.setup.complete) return false;
    const chosen = config.agents.enabled.map(agentLabel).join(" and ");
    const note = options.justChoseAgents
      ? `Setup is not complete. The user just chose to use ${chosen}${config.agents.balanceByQuota ? ", balanced by remaining quota" : ""}. Welcome them briefly and continue setup.`
      : "The user reopened Preston and setup is not complete yet. Pick up where it left off.";
    this.deps.coordinator.submit({
      kind: "setup",
      note,
      channel: "terminal",
      conversationId: TERMINAL_CONVERSATION,
    });
    return true;
  }
}
