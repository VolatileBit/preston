/**
 * WeChat Channel: talks to the owner's WeChat ClawBot over Tencent's iLink protocol.
 *
 * Polling, cursor and context-token handling follow Tencent's MIT-licensed reference plugin
 * https://github.com/Tencent/openclaw-weixin (src/monitor/monitor.ts, src/messaging/inbound.ts,
 * src/storage/inbound-journal.ts). Preston differs on purpose in one place: a stale-session
 * error (-14) is treated as a lost login that needs a new QR scan, rather than a one-hour pause.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ChannelStatus,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PairingIO,
  PairingResult,
} from "../types.js";
import {
  apiErrorCode,
  DEFAULT_BASE_URL,
  type GetUpdatesResponse,
  ILinkClient,
  ILinkHttpError,
  type ILinkMessage,
  isAbortError,
  MESSAGE_TYPE_BOT,
} from "./api.js";
import { systemClock, type WeChatClock } from "./clock.js";
import { pairWithQrCode } from "./pairing.js";
import { chunkText, inboundText } from "./text.js";

export type { WeChatClock } from "./clock.js";

/**
 * Persisted WeChat Channel config. The core stores it; the Channel reports changes through
 * `PairingResult.configPatch` (credentials) and `deps.persist` (cursor and context tokens).
 */
export interface WeChatChannelConfig {
  /** iLink bot token from the QR login. Secret. */
  botToken?: string;
  /** `ilink_bot_id` of the paired ClawBot. */
  botId?: string;
  /** `ilink_user_id` of the WeChat user who scanned the QR code: the only owner. */
  ownerUserId?: string;
  /** Bot API base URL; login may assign one. Defaults to the official host. */
  baseUrl?: string;
  /** Base URL for QR login. Defaults to the official host. */
  loginBaseUrl?: string;
  /** Opaque `get_updates_buf` long-poll cursor. */
  getUpdatesCursor?: string;
  /** Latest `context_token` per user id, echoed on sends. Secret. */
  contextTokens?: Record<string, string>;
}

export interface WeChatChannelDeps {
  fetch?: typeof fetch;
  clock?: WeChatClock;
  /** Persist a config change. Called (serialised) when the cursor or a context token changes. */
  persist?: (patch: Partial<WeChatChannelConfig>) => Promise<void>;
  /** Minimum gap between cursor-only persists. Changes that come with messages persist at once. */
  persistIntervalMs?: number;
}

/** ret/errcode the reference treats as a stale or expired session (src/api/session-guard.ts). */
const SESSION_EXPIRED = -14;
/** Community-reported (unverified) code for "proactive window or quota exceeded". */
const PROACTIVE_LIMIT = -2;

const DEFAULT_LONG_POLL_MS = 35_000;
/** Extra client-side wait beyond the server's long-poll hold before giving up on a poll. */
const LONG_POLL_MARGIN_MS = 5_000;
/** Reference backoff: 2 s between failures, 30 s after every third in a row. */
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const FAILURES_BEFORE_BACKOFF = 3;
const DEFAULT_PERSIST_INTERVAL_MS = 30_000;
const SEEN_LIMIT = 1_000;

export const LOST_LOGIN_NOTICE = "Preston lost its WeChat connection — run `preston` to reconnect.";
const LOST_LOGIN_DETAIL = "WeChat ended Preston's login. Run `preston` to scan a new QR code.";
const NOT_PAIRED_DETAIL = "WeChat isn't paired yet. Run `preston` to scan the QR code.";
const NEEDS_PAIRING_SEND_ERROR =
  "WeChat needs to be reconnected (run `preston`), so the message is waiting.";
const PROACTIVE_LIMIT_ERROR =
  "WeChat only lets Preston send a few messages until you write to it again, " +
  "so this one was not delivered.";

const CAPABILITIES: ChannelCapabilities = { reactions: false, proactive: "windowed" };

export const wechatSetupGuide = `Connecting WeChat takes a minute. You need WeChat on your phone, signed in to the account you want to talk to Preston from, with ClawBot available on it.

1. Preston shows a QR code here.
2. On your phone, open WeChat, tap "+" and then "Scan", and scan the code.
3. Confirm the login on your phone. If WeChat shows a number, type it here when Preston asks.
4. That's it: from then on, message the ClawBot in WeChat to talk to Preston.

Only the WeChat account that scanned the code can give Preston instructions. WeChat only lets Preston send a few messages on its own until you write to it again, so anything that couldn't be delivered waits until you next ask. If WeChat ever ends the login, Preston tells you on this computer; run \`preston\` and scan a new code.`;

export function createWeChatChannel(
  config: WeChatChannelConfig,
  deps: WeChatChannelDeps = {},
): Channel {
  return new WeChatChannel(config, deps);
}

class WeChatChannel implements Channel {
  readonly kind = "wechat" as const;
  readonly capabilities = CAPABILITIES;

  private config: WeChatChannelConfig;
  private readonly client: ILinkClient;
  private readonly clock: WeChatClock;
  private readonly persistIntervalMs: number;

  private ctx: ChannelContext | undefined;
  private started = false;
  private loginLost = false;
  private status: ChannelStatus | undefined;
  private poll: { controller: AbortController; done: Promise<void> } | undefined;

  private pending: Partial<WeChatChannelConfig> = {};
  private lastPersistAt = Number.NEGATIVE_INFINITY;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly seen = new Set<string>();

  constructor(
    config: WeChatChannelConfig,
    private readonly deps: WeChatChannelDeps,
  ) {
    this.config = { ...config, contextTokens: { ...config.contextTokens } };
    this.client = new ILinkClient({ fetch: deps.fetch });
    this.clock = deps.clock ?? systemClock;
    this.persistIntervalMs = deps.persistIntervalMs ?? DEFAULT_PERSIST_INTERVAL_MS;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.ctx = ctx;
    this.started = true;
    if (!this.config.botToken) {
      this.setStatus("needs_pairing", NOT_PAIRED_DETAIL);
      return;
    }
    if (this.loginLost) {
      this.setStatus("needs_pairing", LOST_LOGIN_DETAIL);
      return;
    }
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.started = false;
    const wasPolling = this.poll !== undefined;
    await this.stopPolling();
    await this.flush(true);
    const token = this.config.botToken;
    if (wasPolling && token && !this.loginLost) {
      try {
        await this.client.notifyStop(this.apiBaseUrl(), token);
      } catch (err) {
        this.log("debug", `notifystop failed (ignored): ${this.describe(err)}`);
      }
    }
    if (this.status !== "needs_pairing") this.setStatus("disconnected");
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    const token = this.config.botToken;
    if (!token || this.loginLost) {
      return { status: "failed", error: NEEDS_PAIRING_SEND_ERROR, retryable: true };
    }
    const to = message.conversationId ?? this.config.ownerUserId;
    if (!to) {
      return {
        status: "failed",
        error: "WeChat has no paired owner to send to.",
        retryable: false,
      };
    }
    const chunks = chunkText(message.text);
    if (chunks.length === 0) {
      return { status: "failed", error: "The message was empty.", retryable: false };
    }
    let firstRef: string | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.sendChunk(token, to, chunk);
      if (result.status === "failed") {
        if (index === 0) return result;
        // Retrying would repeat the parts already delivered.
        return {
          status: "failed",
          error: `${result.error} Only ${index} of ${chunks.length} parts were delivered.`,
          retryable: false,
        };
      }
      firstRef ??= result.ref;
    }
    return firstRef === undefined
      ? { status: "delivered" }
      : { status: "delivered", ref: firstRef };
  }

  async pair(io: PairingIO): Promise<PairingResult> {
    const outcome = await pairWithQrCode({
      client: this.client,
      clock: this.clock,
      loginBaseUrl: this.config.loginBaseUrl ?? DEFAULT_BASE_URL,
      localTokens: this.config.botToken ? [this.config.botToken] : [],
      io,
      log: (level, message) => this.log(level, message),
    });
    if (outcome.kind === "failed") return { ok: false, detail: outcome.detail };
    if (outcome.kind === "already_bound") {
      if (this.config.botToken && !this.loginLost) {
        return { ok: true, detail: "This WeChat is already connected to Preston." };
      }
      return {
        ok: false,
        detail: "WeChat says this ClawBot is already bound, but sent no new login. Try again.",
      };
    }

    const patch: Partial<WeChatChannelConfig> = {
      botToken: outcome.botToken,
      botId: outcome.botId,
      ownerUserId: outcome.ownerUserId,
    };
    if (outcome.baseUrl) patch.baseUrl = outcome.baseUrl;
    const newIdentity =
      outcome.botId !== this.config.botId || outcome.ownerUserId !== this.config.ownerUserId;
    await this.stopPolling();
    if (newIdentity) {
      // The cursor and context tokens belong to the previous bot or owner.
      patch.getUpdatesCursor = "";
      patch.contextTokens = {};
      this.pending = {};
      this.seen.clear();
    } else {
      await this.flush(true);
    }
    this.config = {
      ...this.config,
      ...patch,
      contextTokens: { ...(patch.contextTokens ?? this.config.contextTokens) },
    };
    this.loginLost = false;
    this.log("info", "WeChat paired");
    if (this.started) this.startPolling();
    return { ok: true, detail: "WeChat is connected.", configPatch: { ...patch } };
  }

  // --- polling -------------------------------------------------------------

  private startPolling(): void {
    if (this.poll) return;
    const controller = new AbortController();
    this.setStatus("connecting");
    const done = this.pollLoop(controller.signal).catch((err) => {
      this.log("error", `WeChat polling stopped unexpectedly: ${this.describe(err)}`);
    });
    this.poll = { controller, done };
  }

  private async stopPolling(): Promise<void> {
    const poll = this.poll;
    if (!poll) return;
    poll.controller.abort();
    await poll.done;
    if (this.poll === poll) this.poll = undefined;
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    const token = this.config.botToken;
    if (!token) return;
    try {
      const res = await this.client.notifyStart(this.apiBaseUrl(), token, signal);
      if (apiErrorCode(res) === SESSION_EXPIRED) {
        await this.loseLogin();
        return;
      }
    } catch (err) {
      if (signal.aborted) return;
      this.log("debug", `notifystart failed (ignored): ${this.describe(err)}`);
    }

    let holdMs = DEFAULT_LONG_POLL_MS;
    let failures = 0;
    while (!signal.aborted) {
      let res: GetUpdatesResponse;
      let failure: string | undefined;
      try {
        res = await this.client.getUpdates(
          this.apiBaseUrl(),
          token,
          this.config.getUpdatesCursor ?? "",
          holdMs + LONG_POLL_MARGIN_MS,
          signal,
        );
        const code = apiErrorCode(res);
        if (code === SESSION_EXPIRED) {
          await this.loseLogin();
          return;
        }
        if (code !== 0) failure = `getupdates returned error ${code}`;
      } catch (err) {
        if (signal.aborted) return;
        res = {};
        failure = `getupdates request failed: ${this.describe(err)}`;
      }
      if (signal.aborted) return;

      if (failure !== undefined) {
        failures += 1;
        const delay = failures % FAILURES_BEFORE_BACKOFF === 0 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
        this.setStatus("disconnected", "Can't reach WeChat right now; retrying.");
        this.log("warn", `${failure}; retrying in ${delay / 1000}s`);
        try {
          await this.clock.sleep(delay, signal);
        } catch {
          return;
        }
        continue;
      }

      failures = 0;
      if (res.longpolling_timeout_ms && res.longpolling_timeout_ms > 0) {
        holdMs = res.longpolling_timeout_ms;
      }
      this.setStatus("connected");
      await this.acceptUpdates(res);
    }
  }

  private async acceptUpdates(res: GetUpdatesResponse): Promise<void> {
    let delivered = 0;
    let tokensChanged = false;
    for (const msg of res.msgs ?? []) {
      const sender = msg.from_user_id ?? "";
      // Messages the bot itself sent are never orders, whoever they claim to be from.
      if (!sender || msg.message_type === MESSAGE_TYPE_BOT) continue;
      const key = messageKey(msg, sender);
      if (key !== undefined) {
        if (this.seen.has(key)) continue;
        this.remember(key);
      }
      const isOwner = this.config.ownerUserId !== undefined && sender === this.config.ownerUserId;
      // Keep only the owner's latest token: Preston never writes to anyone else, and
      // storing strangers' tokens would grow the config without bound.
      if (
        isOwner &&
        msg.context_token &&
        this.config.contextTokens?.[sender] !== msg.context_token
      ) {
        this.config.contextTokens = { ...this.config.contextTokens, [sender]: msg.context_token };
        tokensChanged = true;
      }
      const inbound: InboundMessage = {
        channel: "wechat",
        conversationId: sender,
        senderId: sender,
        isOwner,
        text: inboundText(msg),
        ref: key ?? randomUUID(),
        receivedAt: new Date(msg.create_time_ms ?? this.clock.now()).toISOString(),
      };
      delivered += 1;
      try {
        this.ctx?.onMessage(inbound);
      } catch (err) {
        this.log("error", `inbound message handler failed: ${this.describe(err)}`);
      }
    }

    // Like the reference, only a non-empty cursor replaces the stored one.
    const cursor = res.get_updates_buf;
    if (cursor && cursor !== this.config.getUpdatesCursor) {
      this.config.getUpdatesCursor = cursor;
      this.pending.getUpdatesCursor = cursor;
    }
    if (tokensChanged) this.pending.contextTokens = { ...this.config.contextTokens };
    await this.flush(delivered > 0 || tokensChanged);
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private async loseLogin(): Promise<void> {
    if (this.loginLost) return;
    this.loginLost = true;
    this.poll?.controller.abort();
    this.log("warn", `WeChat login is no longer valid (error ${SESSION_EXPIRED}); polling stopped`);
    this.setStatus("needs_pairing", LOST_LOGIN_DETAIL);
    this.ctx?.notifyHost(LOST_LOGIN_NOTICE);
    await this.flush(true);
  }

  // --- sending -------------------------------------------------------------

  private async sendChunk(token: string, to: string, text: string): Promise<DeliveryResult> {
    const clientId = `preston:${randomUUID()}`;
    try {
      const res = await this.client.sendText(this.apiBaseUrl(), token, {
        to,
        text,
        contextToken: this.config.contextTokens?.[to],
        clientId,
      });
      const code = apiErrorCode(res);
      if (code === 0) return { status: "delivered", ref: res.message_id ?? clientId };
      if (code === SESSION_EXPIRED) {
        await this.loseLogin();
        return { status: "failed", error: NEEDS_PAIRING_SEND_ERROR, retryable: true };
      }
      if (code === PROACTIVE_LIMIT) {
        this.log("info", `sendmessage refused with error ${code} (proactive limit)`);
        return { status: "failed", error: PROACTIVE_LIMIT_ERROR, retryable: false };
      }
      this.log("warn", `sendmessage returned error ${code}`);
      return {
        status: "failed",
        error: `WeChat refused the message (error ${code}).`,
        retryable: false,
      };
    } catch (err) {
      this.log("warn", `sendmessage failed: ${this.describe(err)}`);
      if (err instanceof ILinkHttpError) {
        if (err.status === 429) {
          return { status: "failed", error: PROACTIVE_LIMIT_ERROR, retryable: false };
        }
        if (err.status >= 500) {
          return {
            status: "failed",
            error: "WeChat is having trouble; try again.",
            retryable: true,
          };
        }
        return {
          status: "failed",
          error: `WeChat refused the message (HTTP ${err.status}).`,
          retryable: false,
        };
      }
      return {
        status: "failed",
        error: isAbortError(err) ? "WeChat didn't answer in time." : "Couldn't reach WeChat.",
        retryable: true,
      };
    }
  }

  // --- persistence, status, logging ---------------------------------------

  /** Persist pending changes now (`force`) or when the throttle interval has passed. */
  private async flush(force: boolean): Promise<void> {
    if (Object.keys(this.pending).length === 0) return;
    if (!force && this.clock.now() - this.lastPersistAt < this.persistIntervalMs) return;
    const patch = this.pending;
    this.pending = {};
    this.lastPersistAt = this.clock.now();
    const persist = this.deps.persist;
    if (!persist) return;
    this.persistChain = this.persistChain.then(async () => {
      try {
        await persist(patch);
      } catch (err) {
        this.log("warn", `could not save WeChat state: ${this.describe(err)}`);
      }
    });
    await this.persistChain;
  }

  private apiBaseUrl(): string {
    return this.config.baseUrl ?? DEFAULT_BASE_URL;
  }

  private setStatus(status: ChannelStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.ctx?.setStatus(status, detail);
  }

  /** Error text with any known secret masked, as a guard against echoes from lower layers. */
  private describe(err: unknown): string {
    let text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
    if (cause && typeof cause.code === "string") text += ` (${cause.code})`;
    return this.mask(text);
  }

  private mask(text: string): string {
    const secrets = [this.config.botToken, ...Object.values(this.config.contextTokens ?? {})];
    let masked = text;
    for (const secret of secrets) {
      if (secret && secret.length >= 4) masked = masked.split(secret).join("***");
    }
    return masked;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.ctx?.log(level, `[wechat] ${this.mask(message)}`);
  }
}

/** Stable identity for de-duplication and replies (reference: InboundJournal.accept). */
/**
 * What identifies a message across redeliveries: the server's id, else (when it sent a sequence
 * number or time) a digest of who sent it, when, and what it said, so a repeated message is
 * not run twice.
 */
function messageKey(msg: ILinkMessage, sender: string): string | undefined {
  const id =
    msg.message_id?.trim() || msg.item_list?.map((i) => i.msg_id?.trim() ?? "").find(Boolean);
  if (id) return id;
  if (msg.seq === undefined && msg.create_time_ms === undefined) return undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify([sender, msg.seq, msg.create_time_ms, inboundText(msg)]))
    .digest("hex");
  return `digest:${digest.slice(0, 32)}`;
}
