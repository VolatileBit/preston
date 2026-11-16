/**
 * Slack Channel: the owner talks to Preston in a DM with their own Slack app.
 * The connection is outbound Socket Mode, so the host needs no public URL.
 */
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
  type CreateSlackTransport,
  createBoltTransport,
  SlackConnectError,
  type SlackIdentity,
  type SlackIncoming,
  type SlackTransport,
} from "./transport.js";

export type {
  CreateSlackTransport,
  SlackIdentity,
  SlackIncoming,
  SlackTransport,
  SlackTransportHandlers,
} from "./transport.js";
export { SlackConnectError } from "./transport.js";

export interface SlackChannelConfig {
  /** Bot User OAuth Token (`xoxb-…`). */
  botToken: string;
  /** App-level token with `connections:write` (`xapp-…`), used for Socket Mode. */
  appToken: string;
  /** Slack user id of the paired owner; set by pairing. */
  ownerUserId?: string;
  /** The owner's DM with the app: the default conversation. Set by pairing. */
  dmChannelId?: string;
}

export interface SlackChannelDeps {
  /** Replaces the @slack/bolt transport (tests use a fake). */
  createTransport?: CreateSlackTransport;
  generatePairingCode?: () => string;
  /** How long pairing waits for the code. Default 15 minutes. */
  pairingTimeoutMs?: number;
  /** Delay before reconnect attempt `attempt` after the connection failed. */
  reconnectDelayMs?: (attempt: number) => number;
}

/** Slack recommends at most 4,000 characters per message (and truncates at 40,000). */
export const SLACK_MESSAGE_LIMIT = 4000;

/** Bot scopes: post (chat:write), receive DMs (im:history), mark questions answered (reactions:write). */
export const SLACK_BOT_SCOPES = ["chat:write", "im:history", "reactions:write"] as const;
export const SLACK_BOT_EVENTS = ["message.im"] as const;
export const SLACK_APP_TOKEN_SCOPE = "connections:write";

/**
 * The app manifest for Slack's "Create an app → From a manifest" flow (JSON tab).
 * Socket Mode on, the App Home Messages tab open for DMs, and the minimal scopes.
 */
export function slackAppManifest(opts: { name?: string } = {}): string {
  const name = (opts.name ?? "Preston").trim();
  // Slack caps app names at 35 characters.
  if (name.length === 0 || name.length > 35) {
    throw new RangeError("The Slack app name must be 1 to 35 characters.");
  }
  const manifest = {
    display_information: {
      name,
      description: "Your Preston chief of staff for coding agents.",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...SLACK_BOT_EVENTS] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
  return JSON.stringify(manifest, null, 2);
}

export const slackSetupGuide = `Setting up Slack takes about five minutes. You create your own Slack app, and Preston talks to you through it. Preston gives you a ready-made app description (a "manifest") to paste.

1. Open https://api.slack.com/apps?new_app=1 and sign in to your Slack workspace.
2. Choose "From a manifest", pick your workspace and click "Next".
3. Open the "JSON" tab, replace everything there with the manifest from Preston, click "Next", then "Create".
4. Click "Install to Workspace" and then "Allow". (Some workspaces need an admin to approve this.)
5. In the menu on the left, open "OAuth & Permissions" and copy the "Bot User OAuth Token" (it starts with xoxb-).
6. Open "Basic Information", scroll to "App-Level Tokens" and click "Generate Token and Scopes". Name it "preston", click "Add Scope", choose "connections:write", then "Generate", and copy the token (it starts with xapp-).
7. Paste both tokens here. Treat them like passwords.
8. Preston then shows you a pairing code. In Slack, open the app (under "Apps" in the left sidebar, or search for its name) and send it the code.`;

const ANSWERED_REACTION = "white_check_mark";
const DEFAULT_PAIRING_TIMEOUT_MS = 15 * 60_000;

interface PairingMatch {
  userId: string;
  channelId: string;
}

export function createSlackChannel(
  config: SlackChannelConfig,
  deps: SlackChannelDeps = {},
): Channel {
  const settings: SlackChannelConfig = {
    ...config,
    botToken: config.botToken.trim(),
    appToken: config.appToken.trim(),
  };
  const createTransport = deps.createTransport ?? createBoltTransport;
  const pairingTimeoutMs = deps.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;
  const nextDelay = deps.reconnectDelayMs ?? reconnectDelayMs;
  const redact = createRedactor(() => [
    settings.botToken,
    settings.appToken,
    config.botToken,
    config.appToken,
  ]);
  let ctx: ChannelContext | undefined;
  const log = redactingLogger(() => ctx?.log.bind(ctx), redact);
  const progress = new ChunkProgress();

  let transport: SlackTransport | undefined;
  let identity: SlackIdentity | undefined;
  let connecting: Promise<SlackIdentity> | undefined;
  let pairing: PairingWaiter<PairingMatch> | undefined;
  let running = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectAttempt = 0;

  const setStatus: ChannelContext["setStatus"] = (status, detail) => {
    if (running) ctx?.setStatus(status, detail === undefined ? undefined : redact(detail));
  };

  const handleMessage = (m: SlackIncoming) => {
    if (!identity || m.channelType !== "im" || !m.userId) return;
    if (m.userId === identity.botUserId || (m.botId && m.botId === identity.botId)) return;
    // Only messages a person wrote; edits, joins, bot posts and the like are ignored.
    if (m.subtype !== undefined && !USER_SUBTYPES.has(m.subtype)) return;
    const text = fromSlackText(m.text).trim();
    if (pairing && !m.botId && pairing.offer(text, { userId: m.userId, channelId: m.channelId })) {
      return;
    }
    if (!ctx || !running || text === "") return;
    ctx.onMessage({
      channel: "slack",
      conversationId: m.channelId,
      senderId: m.userId,
      isOwner: settings.ownerUserId !== undefined && m.userId === settings.ownerUserId,
      text,
      ref: `${m.channelId}:${m.ts}`,
      receivedAt: slackTsToIso(m.ts),
    });
  };

  const dropTransport = async () => {
    const t = transport;
    transport = undefined;
    identity = undefined;
    connecting = undefined;
    await t?.disconnect().catch((error: unknown) => log("debug", "Slack disconnect failed", error));
  };

  const connect = (): Promise<SlackIdentity> => {
    if (identity) return Promise.resolve(identity);
    if (connecting) return connecting;
    const tokenProblem = checkTokenShapes(settings);
    if (tokenProblem) return Promise.reject(tokenProblem);
    const t = createTransport({ botToken: settings.botToken, appToken: settings.appToken }, log);
    transport = t;
    const attempt = t
      .connect({
        onMessage: handleMessage,
        onClosed: (detail) => {
          if (transport !== t) return;
          void dropTransport().then(() => connectionLost(detail));
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
    setStatus("needs_pairing", `${detail} Run \`preston\` to set Slack up again.`);
    if (running) {
      ctx?.notifyHost(
        "Preston lost its Slack connection: a Slack token stopped working. Run `preston` to fix it.",
      );
    }
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
      const failure = classifySlackError(error, redact);
      if (failure.kind === "auth") authLost(failure.detail);
      else connectionLost(`Couldn't connect to Slack: ${failure.detail}`);
    }
  };

  const reportFailure = (error: unknown): DeliveryResult => {
    const failure = classifySlackError(error, redact);
    log("warn", `Slack delivery failed: ${failure.detail}`);
    if (failure.kind === "auth") {
      void dropTransport();
      authLost(failure.detail);
    }
    return failureResult(failure);
  };

  return {
    kind: "slack",
    capabilities: { reactions: true, proactive: "always" },

    async start(context) {
      ctx = context;
      running = true;
      if (!settings.ownerUserId) {
        setStatus(
          "needs_pairing",
          "Slack isn't paired with your account yet. Run `preston` to finish setting it up.",
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
        return { status: "failed", error: "Slack isn't connected right now.", retryable: true };
      }
      // Posting to the owner's user id lands in the app's DM with them.
      const target = message.conversationId ?? settings.dmChannelId ?? settings.ownerUserId;
      if (!target) {
        return {
          status: "failed",
          error: "Slack isn't paired with your account yet.",
          retryable: false,
        };
      }
      // Escaping can lengthen a chunk slightly past the 4,000 recommendation; Slack's hard
      // limit is 40,000, so chunk boundaries stay where the reader expects them.
      const chunks = splitMessage(message.text, SLACK_MESSAGE_LIMIT).map(toSlackText);
      if (chunks.length === 0) {
        return { status: "failed", error: "The message is empty.", retryable: false };
      }
      const key = progress.key(target, message.text);
      const state = progress.get(key);
      for (let i = state.sent; i < chunks.length; i++) {
        try {
          const posted = await transport.postMessage(target, chunks[i] as string);
          if (target === settings.ownerUserId) settings.dmChannelId = posted.channel;
          state.sent = i + 1;
          state.firstRef ??= `${posted.channel}:${posted.ts}`;
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
          "Could not mark a Slack message as answered: not connected or unknown message.",
        );
        return;
      }
      try {
        await transport.addReaction(parsed.channelId, parsed.ts, ANSWERED_REACTION);
      } catch (error) {
        if (platformErrorCode(error) === "already_reacted") return;
        log(
          "warn",
          `Could not add the answered reaction: ${classifySlackError(error, redact).detail}`,
        );
      }
    },

    async pair(io: PairingIO): Promise<PairingResult> {
      if (io.signal.aborted) return { ok: false, detail: "Pairing was cancelled." };
      const ownsConnection = !transport;
      let id: SlackIdentity;
      try {
        id = await connect();
      } catch (error) {
        return { ok: false, detail: connectFailureDetail(error, redact) };
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
          `Slack accepted both tokens${id.teamName ? ` for the "${id.teamName}" workspace` : ""}.`,
          'In Slack, open your app (under "Apps" in the left sidebar, or search for its name) and send it this pairing code:',
          waiter.code,
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
        await transport?.postMessage(
          outcome.match.channelId,
          "You're paired. From now on, this is where you talk to Preston.",
        );
      } catch (error) {
        log("warn", "Could not send the pairing confirmation on Slack", error);
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
          "Slack is paired with your account. Preston will talk to you in the app's Messages tab.",
        configPatch: {
          botToken: settings.botToken,
          appToken: settings.appToken,
          ownerUserId: outcome.match.userId,
          dmChannelId: outcome.match.channelId,
        },
      };
    },
  };
}

/** Subtypes that are still a person's own message. */
const USER_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

class TokenShapeError extends Error {
  constructor(readonly token: "bot" | "app") {
    super(token === "bot" ? "bot token has the wrong format" : "app token has the wrong format");
    this.name = "TokenShapeError";
  }
}

function checkTokenShapes(config: SlackChannelConfig): TokenShapeError | undefined {
  if (!config.botToken.startsWith("xoxb-")) return new TokenShapeError("bot");
  if (!config.appToken.startsWith("xapp-")) return new TokenShapeError("app");
  return undefined;
}

function connectFailureDetail(error: unknown, redact: Redactor): string {
  const which =
    error instanceof TokenShapeError || error instanceof SlackConnectError
      ? error.token
      : undefined;
  if (error instanceof TokenShapeError) {
    return which === "bot"
      ? 'That doesn\'t look like a Slack bot token. Copy the "Bot User OAuth Token" from "OAuth & Permissions"; it starts with xoxb-.'
      : 'That doesn\'t look like a Slack app-level token. Create one under "Basic Information" → "App-Level Tokens" with the connections:write scope; it starts with xapp-.';
  }
  const failure = classifySlackError(error, redact);
  if (failure.kind === "transient" || failure.kind === "rate_limited") {
    return `Couldn't connect to Slack: ${failure.detail} Check the internet connection and try again.`;
  }
  if (which === "app") {
    return 'Slack didn\'t accept the app-level token. Under "Basic Information" → "App-Level Tokens", create a token with the connections:write scope and paste it. Also check that Socket Mode is turned on.';
  }
  return 'Slack didn\'t accept the bot token. Make sure the app is installed to your workspace, then copy the "Bot User OAuth Token" from "OAuth & Permissions" again.';
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

function parseRef(ref: string | undefined): { channelId: string; ts: string } | undefined {
  if (!ref) return undefined;
  const [channelId, ts, extra] = ref.split(":");
  if (!channelId || !ts || extra !== undefined) return undefined;
  return { channelId, ts };
}

/** Slack message timestamps are "seconds.micros" since the epoch. */
function slackTsToIso(ts: string): string {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(Math.round(seconds * 1000)).toISOString()
    : new Date().toISOString();
}

/** Slack requires &, < and > to be escaped in message text. */
function toSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Turns Slack's markup back into plain text: links become their URL, entities are unescaped. */
function fromSlackText(text: string): string {
  return text
    .replace(/<((?:https?|mailto):[^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "team_disabled",
  "user_removed_from_team",
  "missing_scope",
]);
const TRANSIENT_ERRORS = new Set([
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

interface SlackErrorShape {
  code?: unknown;
  retryAfter?: unknown;
  statusCode?: unknown;
  data?: { error?: unknown };
}

function platformErrorCode(error: unknown): string | undefined {
  const e = (typeof error === "object" && error !== null ? error : {}) as SlackErrorShape;
  return e.code === "slack_webapi_platform_error" && typeof e.data?.error === "string"
    ? e.data.error
    : undefined;
}

/** Maps @slack/web-api errors to how the outbox should treat them. */
export function classifySlackError(error: unknown, redact: Redactor): SendFailure {
  const cause = error instanceof SlackConnectError ? error.cause : error;
  if (error instanceof TokenShapeError)
    return { kind: "auth", detail: "A Slack token has the wrong format." };
  const e = (typeof cause === "object" && cause !== null ? cause : {}) as SlackErrorShape;
  switch (e.code) {
    case "slack_webapi_rate_limited_error": {
      const seconds = typeof e.retryAfter === "number" ? e.retryAfter : undefined;
      return {
        kind: "rate_limited",
        detail: "Slack asked Preston to slow down.",
        ...(seconds === undefined ? {} : { retryAfterMs: Math.ceil(seconds * 1000) }),
      };
    }
    case "slack_webapi_request_error":
      return { kind: "transient", detail: "Couldn't reach Slack." };
    case "slack_webapi_http_error": {
      const status = typeof e.statusCode === "number" ? e.statusCode : 0;
      if (status === 401 || status === 403)
        return { kind: "auth", detail: "Slack doesn't accept the token." };
      if (status === 429)
        return { kind: "rate_limited", detail: "Slack asked Preston to slow down." };
      if (status >= 500 || status === 408)
        return { kind: "transient", detail: "Slack is having trouble right now." };
      return { kind: "permanent", detail: `Slack rejected the request (HTTP ${status}).` };
    }
    case "slack_webapi_platform_error": {
      const code = String(e.data?.error ?? "unknown_error");
      if (AUTH_ERRORS.has(code)) {
        return {
          kind: "auth",
          detail:
            code === "missing_scope"
              ? "The Slack app is missing a permission Preston needs."
              : "Slack doesn't accept the token.",
        };
      }
      if (code === "ratelimited")
        return { kind: "rate_limited", detail: "Slack asked Preston to slow down." };
      if (TRANSIENT_ERRORS.has(code))
        return { kind: "transient", detail: "Slack is having trouble right now." };
      return { kind: "permanent", detail: `Slack rejected the request (${code}).` };
    }
  }
  if (isNetworkError(cause)) return { kind: "transient", detail: "Couldn't reach Slack." };
  return { kind: "transient", detail: errorText(cause, redact) };
}
