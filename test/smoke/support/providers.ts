import { systemClock } from "../../../src/clock.js";
import { agentEnv } from "../../../src/workers/env.js";
import { builtinAdapters } from "../../../src/workers/registry.js";
import type { AgentKind, WorkerAdapter } from "../../../src/workers/types.js";

export type Provider = "claude" | "codex";

/**
 * The cheapest models, used for both the Coordinator and the Workers. Claude: the `haiku` alias.
 * Codex: the cheapest the account's `model/list` offers (checked in `usableProviders`).
 */
export const CHEAPEST: Record<Provider, { model: string; effort: string }> = {
  claude: { model: "haiku", effort: "low" },
  codex: { model: "gpt-5.6-luna", effort: "low" },
};

/** The real adapter for a provider, started from the developer's own environment and login. */
export function realAdapter(provider: Provider): WorkerAdapter {
  const factory = builtinAdapters({ env: agentEnv(process.env) })[provider];
  if (!factory) throw new Error(`no adapter for ${provider}`);
  return factory({
    home: "",
    clock: systemClock,
    // The built-in adapters use only the clock.
    log: undefined as never,
    tools: undefined as never,
  });
}

export interface ProviderStatus {
  provider: Provider;
  usable: boolean;
  /** Why it is not usable, for the skip message. */
  reason?: string;
}

/** Which providers this machine can run: installed, signed in, and offering the cheap model. */
export async function usableProviders(): Promise<ProviderStatus[]> {
  const wanted = (process.env.SMOKE_PROVIDERS ?? "claude,codex")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Provider[];
  const out: ProviderStatus[] = [];
  for (const provider of ["claude", "codex"] as const) {
    if (!wanted.includes(provider)) {
      out.push({ provider, usable: false, reason: "not selected (SMOKE_PROVIDERS)" });
      continue;
    }
    try {
      const adapter = realAdapter(provider);
      const detection = await adapter.detect();
      if (!detection.installed) {
        out.push({ provider, usable: false, reason: detection.problem ?? "not installed" });
      } else if (detection.loggedIn === false) {
        out.push({ provider, usable: false, reason: detection.problem ?? "not signed in" });
      } else if (provider === "codex") {
        const models = await adapter.listModels?.();
        if (models && !models.some((m) => m.id === CHEAPEST.codex.model)) {
          out.push({
            provider,
            usable: false,
            reason: `${CHEAPEST.codex.model} is not offered by this account (offered: ${models.map((m) => m.id).join(", ")})`,
          });
        } else out.push({ provider, usable: true });
      } else out.push({ provider, usable: true });
    } catch (err) {
      out.push({ provider, usable: false, reason: String(err) });
    }
  }
  return out;
}

export type { AgentKind };
