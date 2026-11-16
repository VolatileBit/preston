import { z } from "zod";
import type { Logger } from "../log.js";
import {
  createDiscordChannel,
  type DiscordChannelDeps,
  discordSetupGuide,
} from "./discord/index.js";
import {
  createSlackChannel,
  type SlackChannelDeps,
  slackAppManifest,
  slackSetupGuide,
} from "./slack/index.js";
import type { Channel, ChannelKind } from "./types.js";
import { createWeChatChannel, type WeChatChannelDeps, wechatSetupGuide } from "./wechat/index.js";

export type ChatChannelKind = Exclude<ChannelKind, "terminal" | "fake">;
export const CHAT_CHANNEL_KINDS: readonly ChatChannelKind[] = ["discord", "slack", "wechat"];

/** What a chat Channel factory receives. */
export interface ChannelFactoryContext {
  home: string;
  /** This Channel's `config.channels[kind]` section, merged with its saved runtime state. */
  settings: Record<string, unknown>;
  log: Logger;
  /**
   * Saves a change the Channel made itself (cursors, context tokens). It never recreates the
   * Channel. Keys listed in `stateKeys` go to the Channel's state file, others to config.
   */
  persist(patch: Record<string, unknown>): Promise<void>;
}

/** A value the user pastes into the conversation, such as a bot token. */
export interface CredentialSpec {
  label: string;
  pattern: RegExp;
  /** Plain-language hint when the shape is wrong. */
  hint: string;
}

export interface ChatChannelSpec {
  label: string;
  /** Validates a config section (credentials, pairing) before it is saved. */
  settings: z.ZodType<Record<string, unknown>>;
  /** Builds the Channel from validated settings. */
  create(ctx: ChannelFactoryContext): Channel;
  /** Values the user provides in chat before pairing; none means pairing needs nothing first. */
  credentials: Record<string, CredentialSpec>;
  /**
   * Keys the Channel itself updates often (a long-poll cursor, context tokens). They are kept
   * in `<home>/channels/<kind>.json`, not as config versions, so config history stays readable
   * and a rollback never rewinds them.
   */
  stateKeys: readonly string[];
  /** Step-by-step setup text for the user. */
  guide(): string;
}

export interface ChatChannelDeps {
  discord?: DiscordChannelDeps;
  slack?: SlackChannelDeps;
  wechat?: Omit<WeChatChannelDeps, "persist">;
}

const id = z.string().min(1).optional();
const DISCORD_TOKEN = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;
const SLACK_BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,}$/;
const SLACK_APP_TOKEN = /^xapp-[A-Za-z0-9-]{10,}$/;

/**
 * The chat Channels Preston ships, next to the always-present terminal. `deps` replaces their
 * network transports (tests use fakes).
 */
export function chatChannelSpecs(
  deps: ChatChannelDeps = {},
): Record<ChatChannelKind, ChatChannelSpec> {
  return {
    discord: {
      label: "Discord",
      settings: z.strictObject({
        botToken: z.string().regex(DISCORD_TOKEN, "that doesn't look like a Discord bot token"),
        ownerUserId: id,
        dmChannelId: id,
      }),
      create: (ctx) => createDiscordChannel(ctx.settings as { botToken: string }, deps.discord),
      credentials: {
        botToken: {
          label: "Discord bot token",
          pattern: DISCORD_TOKEN,
          hint: 'A Discord bot token is a long text with two dots in it. In the Developer Portal open your application, click "Bot", then "Reset Token" and "Copy".',
        },
      },
      stateKeys: [],
      guide: () => discordSetupGuide,
    },
    slack: {
      label: "Slack",
      settings: z.strictObject({
        botToken: z.string().regex(SLACK_BOT_TOKEN, "the bot token must start with xoxb-"),
        appToken: z.string().regex(SLACK_APP_TOKEN, "the app-level token must start with xapp-"),
        ownerUserId: id,
        dmChannelId: id,
      }),
      create: (ctx) =>
        createSlackChannel(ctx.settings as { botToken: string; appToken: string }, deps.slack),
      credentials: {
        botToken: {
          label: "Slack bot token",
          pattern: SLACK_BOT_TOKEN,
          hint: 'The bot token starts with xoxb-. It is under "OAuth & Permissions" as "Bot User OAuth Token".',
        },
        appToken: {
          label: "Slack app-level token",
          pattern: SLACK_APP_TOKEN,
          hint: 'The app-level token starts with xapp-. Create it under "Basic Information", "App-Level Tokens", with the connections:write scope.',
        },
      },
      stateKeys: [],
      guide: () =>
        `${slackSetupGuide}\n\nThe manifest to paste in step 3:\n\n${slackAppManifest()}`,
    },
    wechat: {
      label: "WeChat",
      settings: z.strictObject({
        botToken: id,
        botId: id,
        ownerUserId: id,
        baseUrl: z.url().optional(),
        loginBaseUrl: z.url().optional(),
        getUpdatesCursor: z.string().optional(),
        contextTokens: z.record(z.string(), z.string()).optional(),
      }),
      create: (ctx) => createWeChatChannel(ctx.settings, { ...deps.wechat, persist: ctx.persist }),
      credentials: {},
      stateKeys: ["getUpdatesCursor", "contextTokens"],
      guide: () => wechatSetupGuide,
    },
  };
}

export const CHAT_CHANNELS: Record<ChatChannelKind, ChatChannelSpec> = chatChannelSpecs();

export function isChatChannelKind(kind: string): kind is ChatChannelKind {
  return (CHAT_CHANNEL_KINDS as readonly string[]).includes(kind);
}
