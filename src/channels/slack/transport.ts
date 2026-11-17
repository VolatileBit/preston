/**
 * Thin wrapper around @slack/bolt in Socket Mode. Everything Preston decides (owner checks,
 * pairing, chunking, error mapping) lives in the Channel; this file only speaks the SDK, so
 * tests replace it with a fake.
 */
import { App, type Logger, LogLevel, SocketModeReceiver, webApi } from "@slack/bolt";
import type { IncomingFile } from "../shared/files.js";
import type { ChannelLogger } from "../shared/secrets.js";

export interface SlackIdentity {
  botUserId: string;
  botId?: string;
  teamName?: string;
}

export interface SlackIncoming {
  channelId: string;
  /** "im" for a direct message with the app. */
  channelType?: string;
  ts: string;
  userId?: string;
  botId?: string;
  /** Absent for an ordinary message written by a person. */
  subtype?: string;
  text: string;
  /** Files shared in the message (Slack keeps them on its own servers). */
  files?: IncomingFile[];
}

export interface SlackTransportHandlers {
  onMessage(message: SlackIncoming): void;
  /** The Socket Mode connection is gone; the Channel decides whether to reconnect. */
  onClosed(detail: string): void;
}

/** Which of the two tokens a connection failure is about. */
export class SlackConnectError extends Error {
  constructor(
    readonly token: "bot" | "app",
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SlackConnectError";
  }
}

export interface SlackTransport {
  /** Verifies the bot token (auth.test), then opens Socket Mode with the app token. */
  connect(handlers: SlackTransportHandlers): Promise<SlackIdentity>;
  disconnect(): Promise<void>;
  /** `channel` may be a user id, which posts to the app's DM with that user. */
  postMessage(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  /** Fetches a file Slack holds (needs the `files:read` scope). */
  download(file: IncomingFile): Promise<Uint8Array>;
  /** Uploads files to a conversation, with `text` as their comment. */
  uploadFiles(
    channel: string,
    text: string,
    files: { name: string; data: Buffer }[],
  ): Promise<void>;
}

export type CreateSlackTransport = (
  tokens: { botToken: string; appToken: string },
  log: ChannelLogger,
) => SlackTransport;

/**
 * Fail fast instead of letting the client sleep through rate limits or retry for
 * half an hour: the outbox owns retries.
 */
const CLIENT_OPTIONS = { rejectRateLimitedCalls: true, retryConfig: { retries: 2 } };

export const createBoltTransport: CreateSlackTransport = ({ botToken, appToken }, log) => {
  let app: App | undefined;
  let receiver: SocketModeReceiver | undefined;
  const logger = sdkLogger(log);

  const live = (): App => {
    if (!app) throw new Error("Slack is not connected");
    return app;
  };

  return {
    async connect(handlers) {
      let auth: webApi.AuthTestResponse;
      try {
        auth = await new webApi.WebClient(botToken, { ...CLIENT_OPTIONS, logger }).auth.test();
      } catch (error) {
        throw new SlackConnectError("bot", error);
      }
      if (!auth.user_id)
        throw new SlackConnectError("bot", new Error("auth.test returned no user"));

      // Preston reconnects itself: socket-mode's own reconnect loop rethrows unrecoverable
      // errors (such as a revoked app token) from an event listener, out of reach of callers.
      const r = new SocketModeReceiver({ appToken, logger, autoReconnectEnabled: false });
      const a = new App({
        token: botToken,
        botId: auth.bot_id,
        botUserId: auth.user_id,
        receiver: r,
        logger,
        clientOptions: CLIENT_OPTIONS,
      });
      a.event("message", async ({ event }) => {
        const e = event as unknown as Record<string, unknown>;
        handlers.onMessage({
          channelId: String(e.channel ?? ""),
          channelType: str(e.channel_type),
          ts: String(e.ts ?? ""),
          userId: str(e.user),
          botId: str(e.bot_id),
          subtype: str(e.subtype),
          text: typeof e.text === "string" ? e.text : "",
          files: slackFiles(e.files),
        });
      });
      a.error(async (error) => log("warn", "Slack event handling failed", error));
      try {
        await a.start();
      } catch (error) {
        await a.stop().catch(() => {});
        throw new SlackConnectError("app", error);
      }
      r.client.on("disconnected", () => {
        if (app === a) handlers.onClosed("Slack closed the connection.");
      });
      app = a;
      receiver = r;
      return {
        botUserId: auth.user_id,
        ...(auth.bot_id ? { botId: auth.bot_id } : {}),
        ...(auth.team ? { teamName: auth.team } : {}),
      };
    },

    async disconnect() {
      const a = app;
      app = undefined;
      receiver?.client.removeAllListeners("disconnected");
      receiver = undefined;
      await a?.stop();
    },

    async postMessage(channel, text) {
      const result = await live().client.chat.postMessage({ channel, text });
      if (!result.ts || !result.channel) throw new Error("Slack did not confirm the message");
      return { channel: result.channel, ts: result.ts };
    },

    async addReaction(channel, ts, name) {
      await live().client.reactions.add({ channel, timestamp: ts, name });
    },

    async download(file) {
      const response = await fetch(file.url, { headers: { Authorization: `Bearer ${botToken}` } });
      if (!response.ok) throw new Error(`Slack returned HTTP ${response.status} for the file`);
      // Without the files:read scope Slack answers with a sign-in page instead of the file.
      if (
        response.headers.get("content-type")?.startsWith("text/html") &&
        !file.mimeType?.startsWith("text/html")
      ) {
        throw new Error("Slack did not give the file; the app may lack the files:read permission");
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async uploadFiles(channel, text, files) {
      await live().client.filesUploadV2({
        channel_id: channel,
        ...(text ? { initial_comment: text } : {}),
        file_uploads: files.map((f) => ({ file: f.data, filename: f.name })),
      });
    },
  };
};

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The files of a Slack message event, as downloadable descriptions. */
function slackFiles(value: unknown): IncomingFile[] {
  if (!Array.isArray(value)) return [];
  const files: IncomingFile[] = [];
  for (const item of value as Record<string, unknown>[]) {
    const url = str(item.url_private_download) ?? str(item.url_private);
    if (!url) continue;
    files.push({
      name: str(item.name) ?? str(item.title) ?? "file",
      url,
      size: typeof item.size === "number" ? item.size : undefined,
      mimeType: str(item.mimetype),
    });
  }
  return files;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Routes Slack SDK logging into the Channel's redacting logger. */
function sdkLogger(log: ChannelLogger): Logger {
  let level = LogLevel.INFO;
  const order = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
  const emit = (at: LogLevel, msg: unknown[]) => {
    if (order.indexOf(at) < order.indexOf(level)) return;
    const text = msg.map(describe).join(" ");
    log(
      at === LogLevel.ERROR
        ? "error"
        : at === LogLevel.WARN
          ? "warn"
          : at === LogLevel.INFO
            ? "info"
            : "debug",
      `slack: ${text}`,
    );
  };
  return {
    debug: (...msg) => emit(LogLevel.DEBUG, msg),
    info: (...msg) => emit(LogLevel.INFO, msg),
    warn: (...msg) => emit(LogLevel.WARN, msg),
    error: (...msg) => emit(LogLevel.ERROR, msg),
    setLevel: (next) => {
      level = next;
    },
    getLevel: () => level,
    setName: () => {},
  };
}
