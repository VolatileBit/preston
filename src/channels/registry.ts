import type { Config } from "../config/schema.js";
import type { Logger } from "../log.js";
import type { Channel, ChannelKind } from "./types.js";

/** What a chat Channel factory receives. Its config section is `config.channels[kind]`. */
export interface ChannelFactoryContext {
  home: string;
  /** This Channel's own config section; the factory validates it. */
  settings: unknown;
  log: Logger;
}

/** Returns the Channel, or undefined when it is not configured (not paired) yet. */
export type ChannelFactory = (ctx: ChannelFactoryContext) => Channel | undefined;

/**
 * The chat Channels the daemon registers alongside the terminal. Integrations plug in here:
 * `discord: (ctx) => createDiscordChannel(...)` from `./discord/index.js`, and likewise for
 * `slack` and `wechat`. The terminal Channel is always present and is not listed.
 */
export const CHAT_CHANNELS: Partial<
  Record<Exclude<ChannelKind, "terminal" | "fake">, ChannelFactory>
> = {
  // TODO(discord channel): discord: (ctx) => createDiscordChannel(...)
  // TODO(slack channel): slack: (ctx) => createSlackChannel(...)
  // TODO(wechat channel): wechat: (ctx) => createWeChatChannel(...)
};

export function configuredChannels(config: Config, home: string, log: Logger): Channel[] {
  const channels: Channel[] = [];
  for (const [kind, factory] of Object.entries(CHAT_CHANNELS)) {
    const settings = config.channels[kind];
    if (!factory || settings === undefined) continue;
    const channel = factory({ home, settings, log: log.child(kind) });
    if (channel) channels.push(channel);
  }
  return channels;
}
