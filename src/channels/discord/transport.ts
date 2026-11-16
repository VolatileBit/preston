/**
 * Thin wrapper around discord.js. Everything Preston decides (owner checks, pairing,
 * chunking, error mapping) lives in the Channel; this file only speaks the SDK, so tests
 * replace it with a fake.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  Partials,
  type RateLimitData,
  Routes,
} from "discord.js";
import type { ChannelLogger } from "../shared/secrets.js";

/**
 * Only DM events. Message text in DMs with the bot is delivered without the privileged
 * Message Content intent, so the user never has to switch it on in the Developer Portal.
 */
export const DISCORD_INTENTS = [GatewayIntentBits.DirectMessages] as const;

/** DM channels are not cached, so discord.js needs the Channel partial to emit DM messages. */
export const DISCORD_PARTIALS = [Partials.Channel] as const;

/** Short rate-limit waits are absorbed by discord.js; longer ones fail fast to the outbox. */
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

export interface DiscordIdentity {
  botUserId: string;
  applicationId: string;
}

export interface DiscordIncoming {
  channelId: string;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
  /** Sent in a direct message with the bot (not in a server channel). */
  isDm: boolean;
  /** An ordinary message or reply written by a person, not a system notice. */
  isUserMessage: boolean;
  content: string;
  createdAt: Date;
}

export interface DiscordTransportHandlers {
  onMessage(message: DiscordIncoming): void;
  /** The library is reconnecting or has reconnected on its own. */
  onStatus(status: "connecting" | "connected", detail?: string): void;
  /** The connection is gone for good; the Channel decides whether to reconnect. */
  onClosed(reason: "auth" | "other", detail: string): void;
}

export interface DiscordTransport {
  /** Logs in and resolves once the Gateway is ready. Rejects on an invalid token. */
  connect(handlers: DiscordTransportHandlers): Promise<DiscordIdentity>;
  disconnect(): Promise<void>;
  /** Opens (or reuses) the DM channel with a user and returns its id. */
  openDm(userId: string): Promise<string>;
  /** Returns the new message id. */
  sendMessage(channelId: string, text: string, replyTo?: string): Promise<string>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
}

export type CreateDiscordTransport = (botToken: string, log: ChannelLogger) => DiscordTransport;

const AUTHENTICATION_FAILED = 4004;
const DISALLOWED_INTENTS = 4014;

export const createDiscordJsTransport: CreateDiscordTransport = (botToken, log) => {
  let client: Client | undefined;

  const live = (): Client => {
    if (!client) throw new Error("Discord is not connected");
    return client;
  };

  return {
    async connect(handlers) {
      const c = new Client({
        intents: [...DISCORD_INTENTS],
        partials: [...DISCORD_PARTIALS],
        rest: {
          rejectOnRateLimit: (data: RateLimitData) =>
            data.global || data.timeToReset > MAX_RATE_LIMIT_WAIT_MS,
        },
      });
      client = c;

      c.on(Events.MessageCreate, (m) => {
        handlers.onMessage({
          channelId: m.channelId,
          messageId: m.id,
          authorId: m.author.id,
          authorIsBot: m.author.bot,
          isDm: !m.inGuild(),
          isUserMessage:
            !m.system && (m.type === MessageType.Default || m.type === MessageType.Reply),
          content: m.content,
          createdAt: m.createdAt,
        });
      });
      c.on(Events.ShardReconnecting, () =>
        handlers.onStatus("connecting", "Reconnecting to Discord."),
      );
      c.on(Events.ShardResume, () => handlers.onStatus("connected"));
      c.on(Events.ShardReady, () => handlers.onStatus("connected"));
      c.on(Events.ShardDisconnect, (event) => {
        if (event.code === AUTHENTICATION_FAILED) {
          handlers.onClosed("auth", "Discord no longer accepts the bot token.");
        } else if (event.code === DISALLOWED_INTENTS) {
          handlers.onClosed("other", "Discord refused the connection settings Preston asked for.");
        } else {
          handlers.onClosed("other", `Discord closed the connection (code ${event.code}).`);
        }
      });
      c.on(Events.Invalidated, () => handlers.onClosed("other", "Discord ended the session."));
      c.on(Events.Warn, (message) => log("warn", `discord.js: ${message}`));
      c.on(Events.Error, (error) => log("warn", "discord.js client error", error));

      const ready = new Promise<void>((resolve) => c.once(Events.ClientReady, () => resolve()));
      try {
        await c.login(botToken);
        await ready;
      } catch (error) {
        client = undefined;
        c.removeAllListeners();
        await c.destroy().catch(() => {});
        throw error;
      }
      const user = c.user;
      if (!user) throw new Error("Discord did not report the bot user");
      return { botUserId: user.id, applicationId: c.application?.id ?? user.id };
    },

    async disconnect() {
      const c = client;
      client = undefined;
      if (!c) return;
      c.removeAllListeners();
      await c.destroy();
    },

    async openDm(userId) {
      const channel = (await live().rest.post(Routes.userChannels(), {
        body: { recipient_id: userId },
      })) as { id: string };
      return channel.id;
    },

    async sendMessage(channelId, text, replyTo) {
      const body: Record<string, unknown> = { content: text, allowed_mentions: { parse: [] } };
      if (replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
      const message = (await live().rest.post(Routes.channelMessages(channelId), { body })) as {
        id: string;
      };
      return message.id;
    },

    async addReaction(channelId, messageId, emoji) {
      await live().rest.put(
        Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji)),
      );
    },
  };
};
