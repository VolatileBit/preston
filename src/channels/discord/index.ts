/**
 * Discord Channel: the owner talks to Preston in a DM with their own Discord bot.
 * The connection is the outbound Gateway, so the host needs no public URL.
 */
import { PermissionFlagsBits } from "discord.js";
import {
  ChunkProgress,
  failureResult,
  isNetworkError,
  reconnectDelayMs,
  type SendFailure,
} from "../shared/delivery.js";
import {
  describeDuration,
  generatePairingCode,
  type PairingWait,
  PairingWaiter,
} from "../shared/pairing.js";
import { createRedactor, errorText, type Redactor, redactingLogger } from "../shared/secrets.js";
import { splitMessage } from "../shared/text.js";
import type {
  Channel,
  ChannelContext,
  DeliveryResult,
  OutboundMessage,
  PairingIO,
  PairingResult,
} from "../types.js";
import {
  type CreateDiscordTransport,
  createDiscordJsTransport,
  type DiscordIdentity,
  type DiscordIncoming,
  type DiscordTransport,
} from "./transport.js";

export type { CreateDiscordTransport, DiscordIncoming, DiscordTransport } from "./transport.js";
export { DISCORD_INTENTS, DISCORD_PARTIALS } from "./transport.js";

export interface DiscordChannelConfig {
  botToken: string;
  /** Discord user id of the paired owner; set by pairing. */
  ownerUserId?: string;
  /** The owner's DM channel with the bot: the default conversation. Set by pairing. */
  dmChannelId?: string;
}

export interface DiscordChannelDeps {
  /** Replaces the discord.js transport (tests use a fake). */
  createTransport?: CreateDiscordTransport;
  generatePairingCode?: () => string;
  /** How long pairing waits for the code. Default 15 minutes. */
  pairingTimeoutMs?: number;
  /** Delay before reconnect attempt `attempt` after the connection failed. */
  reconnectDelayMs?: (attempt: number) => number;
}

/** Discord's limit for a message's content. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Server permissions requested by the invite. DMs, reading DMs and reacting in DMs are not
 * governed by server permissions at all; View Channels only makes the bot show up in the
 * server's member list, which is where the owner clicks it to start the DM.
 */
export const DISCORD_INVITE_PERMISSIONS = PermissionFlagsBits.ViewChannel;

/** Guild install with the `bot` scope; slash commands are not used. */
export function discordInviteUrl(applicationId: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: "bot",
    permissions: DISCORD_INVITE_PERMISSIONS.toString(),
    integration_type: "0",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export const discordSetupGuide = `Setting up Discord takes about five minutes. You create your own Discord bot, and Preston talks to you through it.

1. Open https://discord.com/developers/applications and sign in to Discord.
2. Click "New Application", name it (for example "Preston"), accept the terms and click "Create".
3. In the menu on the left, click "Bot". Click "Reset Token", confirm, then click "Copy".
4. Paste the token here. Treat it like a password: anyone with it can control the bot.
5. Preston then gives you an invite link. Open it, pick one of your servers and click "Authorize".
   No server yet? In Discord, click the "+" at the bottom of the server list, then "Create My Own".
6. In that server, find the bot in the member list, click it, and send it the pairing code Preston shows you.

You don't need to turn on any of the "Privileged Gateway Intents" switches.`;

const ANSWERED_EMOJI = "✅";
const DEFAULT_PAIRING_TIMEOUT_MS = 15 * 60_000;

interface PairingMatch {
  userId: string;
  channelId: string;
}

export function createDiscordChannel(
  config: DiscordChannelConfig,
  deps: DiscordChannelDeps = {},
): Channel {
  const settings: DiscordChannelConfig = { ...config, botToken: config.botToken.trim() };
  const createTransport = deps.createTransport ?? createDiscordJsTransport;
  const pairingTimeoutMs = deps.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;
  const nextDelay = deps.reconnectDelayMs ?? reconnectDelayMs;
  const redact = createRedactor(() => [settings.botToken, config.botToken]);
  let ctx: ChannelContext | undefined;
  const log = redactingLogger(() => ctx?.log.bind(ctx), redact);
  const progress = new ChunkProgress();

  let transport: DiscordTransport | undefined;
  let identity: DiscordIdentity | undefined;
  let connecting: Promise<DiscordIdentity> | undefined;
  let pairing: PairingWaiter<PairingMatch> | undefined;
  let running = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectAttempt = 0;

  const setStatus: ChannelContext["setStatus"] = (status, detail) => {
    if (running) ctx?.setStatus(status, detail === undefined ? undefined : redact(detail));
  };

  const handleMessage = (m: DiscordIncoming) => {
    if (!identity || m.authorId === identity.botUserId) return;
    if (!m.isDm || !m.isUserMessage) return;
    if (
      pairing &&
      !m.authorIsBot &&
      pairing.offer(m.content, { userId: m.authorId, channelId: m.channelId })
    ) {
      return;
    }
    const text = m.content.trim();
    if (!ctx || !running || text === "") return;
    ctx.onMessage({
      channel: "discord",
      conversationId: m.channelId,
      senderId: m.authorId,
      isOwner: settings.ownerUserId !== undefined && m.authorId === settings.ownerUserId,
      text,
      ref: `${m.channelId}:${m.messageId}`,
      receivedAt: m.createdAt.toISOString(),
    });
  };

  const dropTransport = async () => {
    const t = transport;
    transport = undefined;
    identity = undefined;
    connecting = undefined;
    await t
      ?.disconnect()
      .catch((error: unknown) => log("debug", "Discord disconnect failed", error));
  };

  const connect = (): Promise<DiscordIdentity> => {
    if (identity) return Promise.resolve(identity);
    if (connecting) return connecting;
    const t = createTransport(settings.botToken, log);
    transport = t;
    const attempt = t
      .connect({
        onMessage: handleMessage,
        onStatus: (status, detail) => {
          if (transport === t) setStatus(status, detail);
        },
        onClosed: (reason, detail) => {
          if (transport !== t) return;
          void dropTransport().then(() => {
            if (reason === "auth") authLost(detail);
            else connectionLost(detail);
          });
        },
      })
      .then(
        (id) => {
          if (transport === t) identity = id;
          return id;
        },
        async (error: unknown) => {
          if (transport === t) await dropTransport();
          throw error;
        },
      );
    connecting = attempt;
    return attempt;
  };

  const authLost = (detail: string) => {
    setStatus("needs_pairing", `${detail} Run \`preston\` to set Discord up again.`);
    if (running)
      ctx?.notifyHost(
        "Preston lost its Discord connection: the bot token stopped working. Run `preston` to fix it.",
      );
  };

  const connectionLost = (detail: string) => {
    setStatus("disconnected", detail);
    scheduleReconnect();
  };

  const scheduleReconnect = () => {
    if (!running || reconnectTimer) return;
    const delay = nextDelay(reconnectAttempt++);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connectAndReport();
    }, delay);
    reconnectTimer.unref?.();
  };

  const connectAndReport = async () => {
    if (!running) return;
    setStatus("connecting");
    try {
      await connect();
      reconnectAttempt = 0;
      setStatus("connected");
    } catch (error) {
      const failure = classifyDiscordError(error, redact);
      if (failure.kind === "auth") authLost(failure.detail);
      else connectionLost(`Couldn't connect to Discord: ${failure.detail}`);
    }
  };

  const resolveConversation = async (conversationId?: string): Promise<string | undefined> => {
    if (conversationId) return conversationId;
    if (settings.dmChannelId) return settings.dmChannelId;
    if (!settings.ownerUserId || !transport) return undefined;
    settings.dmChannelId = await transport.openDm(settings.ownerUserId);
    return settings.dmChannelId;
  };

  const reportFailure = (error: unknown): DeliveryResult => {
    const failure = classifyDiscordError(error, redact);
    log("warn", `Discord delivery failed: ${failure.detail}`);
    if (failure.kind === "auth") {
      void dropTransport();
      authLost(failure.detail);
    }
    return failureResult(failure);
  };

  return {
    kind: "discord",
    capabilities: { reactions: true, proactive: "always" },

    async start(context) {
      ctx = context;
      running = true;
      if (!settings.ownerUserId) {
        setStatus(
          "needs_pairing",
          "Discord isn't paired with your account yet. Run `preston` to finish setting it up.",
        );
        return;
      }
      await connectAndReport();
    },

    async stop() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      pairing?.cancel();
      await dropTransport();
      ctx?.setStatus("disconnected");
      running = false;
    },

    async send(message: OutboundMessage): Promise<DeliveryResult> {
      if (!transport || !identity) {
        return { status: "failed", error: "Discord isn't connected right now.", retryable: true };
      }
      let channelId: string | undefined;
      try {
        channelId = await resolveConversation(message.conversationId);
      } catch (error) {
        return reportFailure(error);
      }
      if (!channelId) {
        return {
          status: "failed",
          error: "Discord isn't paired with your account yet.",
          retryable: false,
        };
      }
      const chunks = splitMessage(message.text, DISCORD_MESSAGE_LIMIT);
      if (chunks.length === 0) {
        return { status: "failed", error: "The message is empty.", retryable: false };
      }
      const key = progress.key(channelId, message.text);
      const state = progress.get(key);
      for (let i = state.sent; i < chunks.length; i++) {
        try {
          const replyTo = i === 0 ? parseRef(message.replyTo)?.messageId : undefined;
          const id = await transport.sendMessage(channelId, chunks[i] as string, replyTo);
          state.sent = i + 1;
          state.firstRef ??= `${channelId}:${id}`;
          progress.record(key, state);
        } catch (error) {
          return reportFailure(error);
        }
      }
      progress.clear(key);
      return state.firstRef
        ? { status: "delivered", ref: state.firstRef }
        : { status: "delivered" };
    },

    async markAnswered(ref) {
      const parsed = parseRef(ref);
      if (!parsed || !transport) {
        log(
          "warn",
          "Could not mark a Discord message as answered: not connected or unknown message.",
        );
        return;
      }
      try {
        await transport.addReaction(parsed.channelId, parsed.messageId, ANSWERED_EMOJI);
      } catch (error) {
        log(
          "warn",
          `Could not add the answered reaction: ${classifyDiscordError(error, redact).detail}`,
        );
      }
    },

    async pair(io: PairingIO): Promise<PairingResult> {
      if (io.signal.aborted) return { ok: false, detail: "Pairing was cancelled." };
      if (!settings.botToken) {
        return { ok: false, detail: "Paste your Discord bot token first, then try pairing again." };
      }
      const ownsConnection = !transport;
      let id: DiscordIdentity;
      try {
        id = await connect();
      } catch (error) {
        const failure = classifyDiscordError(error, redact);
        return {
          ok: false,
          detail:
            failure.kind === "auth"
              ? 'Discord didn\'t accept that bot token. In the Developer Portal, open your application, go to "Bot", click "Reset Token" and paste the new token.'
              : `Couldn't connect to Discord: ${failure.detail} Check the internet connection and try again.`,
        };
      }

      pairing?.cancel();
      const waiter = new PairingWaiter<PairingMatch>(
        (deps.generatePairingCode ?? generatePairingCode)(),
        pairingTimeoutMs,
        io.signal,
      );
      pairing = waiter;
      io.show(
        [
          "Discord accepted the bot token.",
          `1. Invite the bot to one of your servers: ${discordInviteUrl(id.applicationId)}`,
          "2. In that server, find the bot in the member list, click it and open a direct message.",
          `3. Send it this pairing code: ${waiter.code}`,
          `The code works once and expires in ${describeDuration(pairingTimeoutMs)}.`,
        ].join("\n"),
      );

      const outcome: PairingWait<PairingMatch> = await waiter.result;
      if (pairing === waiter) pairing = undefined;
      if (outcome.status !== "matched") {
        // Keep a connection only if the running Channel already had a paired owner.
        if (ownsConnection && !(running && settings.ownerUserId)) await dropTransport();
        return { ok: false, detail: pairingFailureDetail(outcome.status, pairingTimeoutMs) };
      }

      settings.ownerUserId = outcome.match.userId;
      settings.dmChannelId = outcome.match.channelId;
      try {
        await transport?.sendMessage(
          outcome.match.channelId,
          "You're paired. From now on, this is where you talk to Preston.",
        );
      } catch (error) {
        log("warn", "Could not send the pairing confirmation on Discord", error);
      }
      if (running) {
        reconnectAttempt = 0;
        setStatus("connected");
      } else if (ownsConnection) {
        await dropTransport();
      }
      return {
        ok: true,
        detail:
          "Discord is paired with your account. Preston will talk to you in that direct message.",
        configPatch: {
          botToken: settings.botToken,
          ownerUserId: outcome.match.userId,
          dmChannelId: outcome.match.channelId,
        },
      };
    },
  };
}

function parseRef(ref: string | undefined): { channelId: string; messageId: string } | undefined {
  if (!ref) return undefined;
  const [channelId, messageId, extra] = ref.split(":");
  if (!channelId || !messageId || extra !== undefined) return undefined;
  return { channelId, messageId };
}

function pairingFailureDetail(
  status: "timeout" | "aborted" | "cancelled",
  timeoutMs: number,
): string {
  switch (status) {
    case "timeout":
      return `No message with the pairing code arrived within ${describeDuration(timeoutMs)}, so pairing stopped. You can try again; you'll get a new code.`;
    case "aborted":
      return "Pairing was cancelled.";
    case "cancelled":
      return "Pairing was replaced by a newer attempt or Preston stopped.";
  }
}

interface DiscordErrorShape {
  code?: unknown;
  status?: unknown;
  retryAfter?: unknown;
  timeToReset?: unknown;
  rawError?: { retry_after?: unknown };
}

/** Maps discord.js / REST errors to how the outbox should treat them. */
export function classifyDiscordError(error: unknown, redact: Redactor): SendFailure {
  const e = (typeof error === "object" && error !== null ? error : {}) as DiscordErrorShape;
  if (e.code === "TokenInvalid") {
    return { kind: "auth", detail: "Discord doesn't accept the bot token." };
  }
  if (typeof e.retryAfter === "number" && typeof e.timeToReset === "number") {
    // RateLimitError: discord.js was told not to wait this long itself.
    const wait = e.retryAfter > 0 ? e.retryAfter : e.timeToReset;
    return {
      kind: "rate_limited",
      detail: "Discord asked Preston to slow down.",
      retryAfterMs: Math.ceil(wait),
    };
  }
  if (typeof e.status === "number") {
    const status = e.status;
    if (status === 401) return { kind: "auth", detail: "Discord doesn't accept the bot token." };
    if (status === 429) {
      const seconds =
        typeof e.rawError?.retry_after === "number" ? e.rawError.retry_after : undefined;
      return {
        kind: "rate_limited",
        detail: "Discord asked Preston to slow down.",
        ...(seconds === undefined ? {} : { retryAfterMs: Math.ceil(seconds * 1000) }),
      };
    }
    if (status >= 500 || status === 408) {
      return { kind: "transient", detail: "Discord is having trouble right now." };
    }
    return { kind: "permanent", detail: permanentDetail(e.code, error, redact) };
  }
  if (isNetworkError(error)) return { kind: "transient", detail: "Couldn't reach Discord." };
  return { kind: "transient", detail: errorText(error, redact) };
}

function permanentDetail(code: unknown, error: unknown, redact: Redactor): string {
  switch (code) {
    case 50007:
      return "Discord won't let the bot message this account. Make sure you share a server with the bot and allow direct messages from its members.";
    case 10003:
      return "That Discord conversation no longer exists.";
    case 10008:
      return "That Discord message no longer exists.";
    case 50001:
    case 50013:
      return "The bot isn't allowed to post there.";
    default:
      return `Discord rejected the request: ${errorText(error, redact)}`;
  }
}
