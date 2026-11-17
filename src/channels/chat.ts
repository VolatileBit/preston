import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type ConfigManager, configSecrets } from "../config/config.js";
import type { Config } from "../config/schema.js";
import { errorMessage, type Logger } from "../log.js";
import type { ChannelHub } from "./hub.js";
import { CHAT_CHANNEL_KINDS, type ChatChannelKind, type ChatChannelSpec } from "./registry.js";
import type { Channel, ChannelKind } from "./types.js";

export interface ChatChannelsDeps {
  specs: Record<ChatChannelKind, ChatChannelSpec>;
  hub: ChannelHub;
  config: ConfigManager;
  home: string;
  log: Logger;
  /** Adds a value to log masking. */
  addSecret(secret: string): void;
  /** Kinds already served by a fixed Channel (tests register fakes); never managed here. */
  fixed: ReadonlySet<ChannelKind>;
}

interface Entry {
  channel: Channel;
  /** The config section the Channel was built from; a different section recreates it. */
  section: unknown;
  /** Built for pairing before any config exists; dropped if pairing fails. */
  provisional: boolean;
}

/**
 * The chat Channels (Discord, Slack) built from `config.channels`. A Channel is
 * recreated when its config section changes (config_update, rollback, channel_configure) and
 * removed when its section goes away. Changes a Channel makes itself (pairing results, cursors)
 * are saved without recreating it: config keys as a config version, `stateKeys` in
 * `<home>/channels/<kind>.json`.
 */
export class ChatChannels {
  private entries = new Map<ChatChannelKind, Entry>();
  private problems = new Map<ChatChannelKind, string>();
  private queue: Promise<void> = Promise.resolve();
  private ownWrite = false;

  constructor(private readonly deps: ChatChannelsDeps) {}

  /** Builds and registers the configured Channels; the hub starts them. */
  init(): void {
    const config = this.deps.config.get();
    for (const kind of this.kinds()) {
      const section = config.channels[kind];
      if (section === undefined) continue;
      const channel = this.build(kind, section);
      if (!channel) continue;
      this.deps.hub.register(channel);
      this.entries.set(kind, { channel, section: structuredClone(section), provisional: false });
    }
  }

  /** Called on every config change; applies it to the running Channels in order. */
  onConfigChange(config: Config): void {
    if (this.ownWrite) return;
    this.enqueue(() => this.apply(config));
  }

  /** Resolves once every queued Channel change has been applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  kinds(): ChatChannelKind[] {
    return CHAT_CHANNEL_KINDS.filter((kind) => !this.deps.fixed.has(kind));
  }

  spec(kind: ChatChannelKind): ChatChannelSpec {
    return this.deps.specs[kind];
  }

  /** The running Channel, if built. */
  channel(kind: ChatChannelKind): Channel | undefined {
    return this.entries.get(kind)?.channel;
  }

  /** Why a configured Channel could not be built, if it could not. */
  problem(kind: ChatChannelKind): string | undefined {
    return this.problems.get(kind);
  }

  /** Validates a config section for `kind`; returns a plain reason when it is not valid. */
  validate(kind: ChatChannelKind, section: unknown): string | undefined {
    const parsed = this.spec(kind).settings.safeParse(section);
    return parsed.success ? undefined : z.prettifyError(parsed.error).replace(/\n/g, " ");
  }

  /**
   * The Channel to pair: the running one, or for a Channel that needs no credentials first a
   * provisional one, registered and started so it reports its status.
   */
  async forPairing(kind: ChatChannelKind): Promise<Channel | { error: string }> {
    await this.idle();
    const spec = this.spec(kind);
    const entry = this.entries.get(kind);
    if (entry) return entry.channel;
    if (Object.keys(spec.credentials).length > 0) {
      const problem = this.problems.get(kind);
      return {
        error: problem
          ? `${spec.label} can't start: ${problem}`
          : `${spec.label} needs its ${Object.values(spec.credentials)
              .map((c) => c.label)
              .join(" and ")} first (channel_configure).`,
      };
    }
    const channel = this.build(kind, {});
    if (!channel) return { error: this.problems.get(kind) ?? `${spec.label} can't start.` };
    this.entries.set(kind, { channel, section: undefined, provisional: true });
    await this.deps.hub.add(channel);
    return channel;
  }

  /** Drops a provisional Channel whose pairing did not finish. */
  async discardProvisional(kind: ChatChannelKind): Promise<void> {
    const entry = this.entries.get(kind);
    if (!entry?.provisional) return;
    this.entries.delete(kind);
    await this.deps.hub.remove(kind);
  }

  /**
   * Saves a change the Channel made itself (a pairing result, a cursor) without recreating it.
   * State keys replace the saved state; other keys are merged into the config section.
   */
  async persistOwned(
    kind: ChatChannelKind,
    patch: Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    const spec = this.spec(kind);
    const state: Record<string, unknown> = {};
    const settings: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (spec.stateKeys.includes(key)) state[key] = value;
      else settings[key] = value;
    }
    if (Object.keys(state).length) this.writeState(kind, { ...this.readState(kind), ...state });
    const entry = this.entries.get(kind);
    if (Object.keys(settings).length === 0 && !entry?.provisional) return;
    this.ownWrite = true;
    try {
      this.deps.config.transform((config) => {
        const current = config.channels[kind];
        const base = current && typeof current === "object" ? (current as object) : {};
        return { ...config, channels: { ...config.channels, [kind]: { ...base, ...settings } } };
      }, reason);
    } finally {
      this.ownWrite = false;
    }
    if (entry) {
      entry.section = structuredClone(this.deps.config.get().channels[kind]);
      entry.provisional = false;
    }
  }

  /** Stops the Channel and forgets its config and saved state. */
  async remove(kind: ChatChannelKind, reason: string): Promise<void> {
    if (this.deps.config.get().channels[kind] !== undefined) {
      this.deps.config.update({ channels: { [kind]: null } }, reason);
    } else {
      this.enqueue(async () => {
        this.entries.delete(kind);
        await this.deps.hub.remove(kind);
      });
    }
    await this.idle();
    rmSync(this.statePath(kind), { force: true });
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(task)
      .catch((err) => this.deps.log.error("channel change failed", { error: err }));
  }

  private async apply(config: Config): Promise<void> {
    for (const kind of this.kinds()) {
      const desired = config.channels[kind];
      const entry = this.entries.get(kind);
      if (entry?.provisional && desired === undefined) continue;
      if (entry && isDeepStrictEqual(entry.section, desired)) continue;
      if (!entry && desired === undefined) {
        this.problems.delete(kind);
        continue;
      }
      if (entry) {
        this.entries.delete(kind);
        await this.deps.hub.remove(kind);
        this.deps.log.info("channel config changed; recreating it", { kind });
      }
      if (desired === undefined) continue;
      const channel = this.build(kind, desired);
      if (!channel) continue;
      this.entries.set(kind, { channel, section: structuredClone(desired), provisional: false });
      await this.deps.hub.add(channel);
    }
  }

  private build(kind: ChatChannelKind, section: unknown): Channel | undefined {
    const spec = this.spec(kind);
    const parsed = spec.settings.safeParse(section);
    if (!parsed.success) {
      const problem = `its settings are not valid (${z.prettifyError(parsed.error).replace(/\n/g, " ")})`;
      this.problems.set(kind, problem);
      this.deps.log.warn("channel not started: invalid settings", { kind });
      return undefined;
    }
    const state = this.readState(kind);
    for (const secret of configSecrets({ ...parsed.data, ...state })) this.deps.addSecret(secret);
    try {
      const channel = spec.create({
        home: this.deps.home,
        settings: { ...parsed.data, ...state },
        log: this.deps.log.child(kind),
        persist: (patch) => this.persistOwned(kind, patch, `${spec.label} saved its state`),
      });
      this.problems.delete(kind);
      return channel;
    } catch (err) {
      this.problems.set(kind, errorMessage(err));
      this.deps.log.warn("channel could not be created", { kind, error: err });
      return undefined;
    }
  }

  private statePath(kind: ChatChannelKind): string {
    return join(this.deps.home, "channels", `${kind}.json`);
  }

  private readState(kind: ChatChannelKind): Record<string, unknown> {
    const path = this.statePath(kind);
    if (!existsSync(path)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch (err) {
      this.deps.log.warn("ignored unreadable channel state", { kind, error: errorMessage(err) });
      return {};
    }
  }

  private writeState(kind: ChatChannelKind, state: Record<string, unknown>): void {
    for (const secret of configSecrets(state)) this.deps.addSecret(secret);
    const path = this.statePath(kind);
    mkdirSync(join(this.deps.home, "channels"), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }
}
