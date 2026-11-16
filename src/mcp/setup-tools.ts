import { z } from "zod";
import type { AgentUpdater } from "../agents/updater.js";
import type { ChatChannels } from "../channels/chat.js";
import type { ChannelHub } from "../channels/hub.js";
import { CHAT_CHANNEL_KINDS, type ChatChannelKind } from "../channels/registry.js";
import { maskSecret } from "../channels/shared/secrets.js";
import { TERMINAL_CONVERSATION } from "../channels/terminal.js";
import type { ConfigManager } from "../config/config.js";
import type { Coordinator } from "../coordinator/coordinator.js";
import { errorMessage } from "../log.js";
import type { Pairings } from "../setup/pairing.js";
import type { ModelCatalog } from "../workers/models.js";
import type { Adapters } from "../workers/registry.js";
import type { QuotaReading } from "../workers/types.js";
import { ownerTurnGuard } from "./owner-turn.js";
import { ToolError, type ToolRegistry } from "./tools.js";

export interface SetupToolDeps {
  chat: ChatChannels;
  hub: ChannelHub;
  pairings: Pairings;
  config: ConfigManager;
  coordinator: Coordinator;
  adapters: Adapters;
  models: ModelCatalog;
  /** Keeps the agent CLIs current; its line says what version each is and how that is going. */
  updater: AgentUpdater;
  addSecret(secret: string): void;
}

const QUOTA_READ_TIMEOUT_MS = 20_000;

const kindSchema = z
  .enum(CHAT_CHANNEL_KINDS as [ChatChannelKind, ...ChatChannelKind[]])
  .describe("discord, slack or wechat");

/** How one chat Channel stands, in words the Coordinator can pass on. */
export function describeChannel(
  deps: Pick<SetupToolDeps, "chat" | "hub" | "pairings">,
  kind: ChatChannelKind,
) {
  const { chat, hub, pairings } = deps;
  const label = chat.spec(kind).label;
  const state = hub.state(kind);
  const problem = chat.problem(kind);
  const pairing = pairings.active(kind);
  if (!state) {
    return {
      kind,
      name: label,
      state: problem ? "invalid" : "not_configured",
      detail: problem ? `${label} is set up but can't start: ${problem}` : `${label} isn't set up.`,
      pairingInProgress: pairing,
    };
  }
  const detail =
    state.detail ??
    {
      connected: `${label} is connected.`,
      connecting: `${label} is connecting.`,
      disconnected: `${label} is not connected right now.`,
      needs_pairing: `${label} needs pairing with your account.`,
    }[state.status];
  return { kind, name: label, state: state.status, detail, pairingInProgress: pairing };
}

/** Channel setup and agent status tools for the setup conversation (ADR 0001). */
export function registerSetupTools(registry: ToolRegistry, deps: SetupToolDeps): void {
  const { chat, hub, pairings, config, coordinator } = deps;
  const roles = ["coordinator"] as const;
  // Connecting or replacing a chat account decides who can give Preston orders.
  const requireOwnerTurn = ownerTurnGuard(coordinator);

  registry.add({
    name: "channel_status",
    description:
      "How each chat Channel (Discord, Slack, WeChat) stands: connected, connecting, disconnected, needs_pairing, invalid or not_configured, with a plain explanation, and whether a pairing is in progress.",
    roles,
    input: z.strictObject({}),
    handler: () => ({
      channels: CHAT_CHANNEL_KINDS.map((kind) => describeChannel(deps, kind)),
      terminal: hub.state("terminal")?.status ?? "disconnected",
    }),
  });

  registry.add({
    name: "channel_setup_guide",
    description:
      "Step-by-step instructions for setting up a chat Channel, to walk the user through one step at a time. For Slack it includes the app manifest to paste.",
    roles,
    input: z.strictObject({ kind: kindSchema }),
    handler: ({ kind }) => chat.spec(kind).guide(),
  });

  registry.add({
    name: "channel_configure",
    description:
      "Store the credentials the user pasted for a Channel (Discord: botToken; Slack: botToken and appToken, both in one call). Checks their shape, saves them and starts the Channel; then call channel_pair. Never repeat a token back to the user. WeChat needs no credentials.",
    roles,
    input: z.strictObject({
      kind: kindSchema,
      values: z
        .record(z.string(), z.string())
        .describe("Credential name to the value the user pasted"),
    }),
    handler: async ({ kind, values }) => {
      requireOwnerTurn();
      const spec = chat.spec(kind);
      const expected = Object.keys(spec.credentials);
      for (const value of Object.values(values)) deps.addSecret(value.trim());
      if (expected.length === 0) {
        throw new ToolError(
          `${spec.label} needs no tokens. Call channel_pair with kind "${kind}" and the user scans a QR code.`,
        );
      }
      const unknown = Object.keys(values).filter((k) => !expected.includes(k));
      const missing = expected.filter((k) => !values[k]?.trim());
      if (unknown.length || missing.length) {
        throw new ToolError(
          `${spec.label} takes ${expected.join(" and ")}.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}${unknown.length ? ` Not used: ${unknown.join(", ")}.` : ""}`,
        );
      }
      const credentials: Record<string, string> = {};
      for (const key of expected) {
        const value = (values[key] ?? "").trim();
        const credential = spec.credentials[key];
        if (credential && !credential.pattern.test(value)) {
          throw new ToolError(`That doesn't look like a ${credential.label}. ${credential.hint}`);
        }
        credentials[key] = value;
      }
      const current = config.get().channels[kind] as Record<string, unknown> | undefined;
      const unchanged = current && expected.every((k) => current[k] === credentials[k]);
      const section = unchanged ? current : credentials;
      const problem = chat.validate(kind, section);
      if (problem) throw new ToolError(`${spec.label} can't use that: ${problem}`);
      if (!unchanged) {
        pairings.cancel(kind, "The credentials changed.");
        config.transform(
          (c) => ({ ...c, channels: { ...c.channels, [kind]: section } }),
          `${spec.label} credentials set in chat`,
        );
      }
      await chat.idle();
      return {
        saved: Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, maskSecret(v)])),
        channel: describeChannel(deps, kind),
        next: unchanged
          ? "These were already saved."
          : `Saved. Now call channel_pair with kind "${kind}" to pair it with the user's account.`,
      };
    },
  });

  registry.add({
    name: "channel_pair",
    description:
      "Pair a Channel with the user's own account. Runs in the background: Preston sends the steps (invite link and code, or a QR code) straight to the user in this conversation, and their reply to any question it asks goes to the pairing, not to you. Do not repeat those steps. You get a setup event when pairing ends. Pass cancel: true to stop a pairing.",
    roles,
    input: z.strictObject({ kind: kindSchema, cancel: z.boolean().default(false) }),
    handler: async ({ kind, cancel }) => {
      requireOwnerTurn();
      const label = chat.spec(kind).label;
      if (cancel) {
        return pairings.cancel(kind)
          ? `Stopped pairing ${label}.`
          : `${label} wasn't being paired.`;
      }
      const replyTo = coordinator.current()?.replyTo;
      const target = replyTo
        ? { channel: replyTo.channel, conversationId: replyTo.conversationId }
        : { channel: "terminal" as const, conversationId: TERMINAL_CONVERSATION };
      const started = await pairings.start(kind, target);
      if ("error" in started) throw new ToolError(started.error);
      return `Pairing ${label} started. Preston is showing the user the steps directly; say at most one short line, and wait for the setup event.`;
    },
  });

  registry.add({
    name: "channel_remove",
    description: "Disconnect a Channel and forget its credentials and pairing.",
    roles,
    input: z.strictObject({ kind: kindSchema }),
    handler: async ({ kind }) => {
      requireOwnerTurn();
      pairings.cancel(kind, "The Channel was removed.");
      await chat.remove(kind, `${chat.spec(kind).label} removed in chat`);
      return describeChannel(deps, kind);
    },
  });

  registry.add({
    name: "agents_status",
    description:
      "The coding agents on this computer: installed, version, signed in, remaining quota where it can be read for free, how keeping the CLI up to date is going (cliUpdate; Preston updates the CLIs itself when nothing is using them, and agents.autoUpdate turns that off), and which model you (the Coordinator) think with.",
    roles,
    input: z.strictObject({}),
    handler: async () => {
      const current = config.get();
      const detected = await deps.adapters.detectAll();
      const agents = await Promise.all(
        detected.map(async ({ agent, label, detection }) => {
          const adapter = deps.adapters.get(agent);
          const enabled = current.agents.enabled.includes(agent);
          let quota: QuotaReading[] | string | undefined;
          if (
            enabled &&
            detection.installed &&
            detection.loggedIn !== false &&
            adapter?.readQuota
          ) {
            quota = await withTimeout(adapter.readQuota(), QUOTA_READ_TIMEOUT_MS).catch(
              (err: unknown) => `Couldn't read quota: ${errorMessage(err)}`,
            );
          }
          return {
            agent,
            label,
            enabled,
            installed: detection.installed,
            version: detection.version,
            signedIn: detection.loggedIn,
            problem: detection.problem,
            cliUpdate: deps.updater.line(agent),
            quota,
            modelNote: deps.models.note(agent),
          };
        }),
      );
      return {
        agents,
        coordinator: {
          agent: current.coordinator.agent ?? null,
          model: current.coordinator.model ?? "default",
          effort: current.coordinator.effort ?? "default",
        },
        balanceByQuota: current.agents.balanceByQuota,
        autoUpdate: current.agents.autoUpdate,
      };
    },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
