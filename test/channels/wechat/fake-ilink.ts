/**
 * A local stand-in for the iLink HTTP API: records every request and answers from
 * per-endpoint scripts. Unscripted `getupdates` calls are held open like a real long poll
 * until the client goes away.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ChannelContext,
  ChannelStatus,
  InboundMessage,
  PairingIO,
} from "../../../src/channels/types.js";
import type { WeChatClock } from "../../../src/channels/wechat/index.js";

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

export type Reply =
  | { status?: number; json?: unknown; raw?: string }
  | { hold: true }
  | { destroy: true };

export type Script = Reply | ((req: RecordedRequest) => Reply | Promise<Reply>);

export const PATHS = {
  getUpdates: "/ilink/bot/getupdates",
  sendMessage: "/ilink/bot/sendmessage",
  notifyStart: "/ilink/bot/msg/notifystart",
  notifyStop: "/ilink/bot/msg/notifystop",
  qrcode: "/ilink/bot/get_bot_qrcode",
  qrStatus: "/ilink/bot/get_qrcode_status",
} as const;

export class FakeILink {
  readonly requests: RecordedRequest[] = [];
  private readonly queues = new Map<string, Script[]>();
  private readonly fallbacks = new Map<string, Script>();
  private readonly held = new Set<ServerResponse>();
  private readonly server = createServer((req, res) => void this.handle(req, res));
  url = "";

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this;
  }

  async close(): Promise<void> {
    for (const res of this.held) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Answer the next calls to `path` with these scripts, in order. */
  queue(path: string, ...scripts: Script[]): this {
    this.queues.set(path, [...(this.queues.get(path) ?? []), ...scripts]);
    return this;
  }

  /** Answer calls to `path` with this script once its queue is empty. */
  otherwise(path: string, script: Script): this {
    this.fallbacks.set(path, script);
    return this;
  }

  calls(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fake");
    const recorded: RecordedRequest = {
      method: req.method ?? "",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
    this.requests.push(recorded);

    const script = this.queues.get(url.pathname)?.shift() ?? this.fallbacks.get(url.pathname);
    const reply: Reply =
      typeof script === "function"
        ? await script(recorded)
        : (script ?? (url.pathname === PATHS.getUpdates ? { hold: true } : { json: { ret: 0 } }));

    if ("hold" in reply) {
      this.held.add(res);
      res.on("close", () => this.held.delete(res));
      return;
    }
    if ("destroy" in reply) {
      req.socket.destroy();
      return;
    }
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
    res.end(reply.raw ?? JSON.stringify(reply.json ?? {}));
  }
}

/** Instant clock: sleeps resolve on the next turn and advance `now`. */
export function fakeClock(start = Date.UTC(2026, 10, 16)): WeChatClock & { sleeps: number[] } {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      now += ms;
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    },
  };
}

export interface RecordingContext extends ChannelContext {
  messages: InboundMessage[];
  statuses: Array<{ status: ChannelStatus; detail?: string }>;
  notices: string[];
  logs: Array<{ level: string; message: string; data?: unknown }>;
}

export function recordingContext(): RecordingContext {
  const ctx: RecordingContext = {
    messages: [],
    statuses: [],
    notices: [],
    logs: [],
    onMessage: (m) => ctx.messages.push(m),
    setStatus: (status, detail) => ctx.statuses.push({ status, detail }),
    notifyHost: (text) => ctx.notices.push(text),
    log: (level, message, data) => ctx.logs.push({ level, message, data }),
  };
  return ctx;
}

export function recordingIO(
  extra: { prompt?: (q: string) => Promise<string> } = {},
): PairingIO & { shown: string[]; controller: AbortController } & typeof extra {
  const controller = new AbortController();
  const shown: string[] = [];
  return { shown, controller, signal: controller.signal, show: (t) => shown.push(t), ...extra };
}

export async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A WeixinMessage as getupdates returns it. */
export function textMessage(
  from: string,
  text: string,
  opts: { id?: string; contextToken?: string } = {},
): Record<string, unknown> {
  return {
    message_id: opts.id ?? `${Math.floor(Math.random() * 1e9)}`,
    from_user_id: from,
    to_user_id: "bot@im.bot",
    create_time_ms: Date.UTC(2026, 10, 16, 9, 30),
    message_type: 1,
    message_state: 2,
    context_token: opts.contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  };
}
