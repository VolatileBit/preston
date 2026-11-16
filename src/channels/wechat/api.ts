/**
 * Minimal client for Tencent's WeChat ClawBot "iLink" bot protocol (HTTPS/JSON).
 *
 * Endpoints, headers and field names follow Tencent's MIT-licensed reference plugin
 * https://github.com/Tencent/openclaw-weixin (docs/protocol.md, src/api/api.ts,
 * src/api/types.ts, src/auth/login-qr.ts), as of 3.0.0-beta-0 (2026-11-09).
 * Copyright (c) Tencent, MIT License. This is an independent implementation; only the
 * wire format and the lossless-ID JSON scan below are adapted from it.
 *
 * Errors raised here never include response bodies or credentials, so callers may log them.
 */

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** `iLink-App-Id` sent by the reference plugin (its package.json `ilink_appid`). */
const ILINK_APP_ID = "bot";
/**
 * The server identifies the client generation from the first three numbers of
 * `base_info.channel_version`; other hosts must put the reference plugin's version there and
 * their own in a suffix (docs/protocol.md, "Plugin version"). Bump when the reference does.
 */
export const ILINK_PROTOCOL_VERSION = "3.0.0";
/** `bot_type` for get_bot_qrcode (reference: DEFAULT_ILINK_BOT_TYPE). */
const BOT_TYPE = "3";

export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;

export interface ILinkMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  file_item?: { file_name?: string };
}

export interface ILinkMessage {
  seq?: number;
  /** uint64 on the wire; parsed losslessly as a string. */
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: ILinkMessageItem[];
  context_token?: string;
}

export interface ApiResult {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface GetUpdatesResponse extends ApiResult {
  msgs?: ILinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResponse extends ApiResult {
  message_id?: string;
}

export interface QrCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface QrStatusResponse {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

/** Non-2xx HTTP response. The body is deliberately not kept: it may echo credentials. */
export class ILinkHttpError extends Error {
  constructor(
    readonly status: number,
    label: string,
  ) {
    super(`${label} failed with HTTP ${status}`);
    this.name = "ILinkHttpError";
  }
}

/** The first non-zero `ret`/`errcode`, or 0 when the call succeeded. */
export function apiErrorCode(result: ApiResult): number {
  if (typeof result.ret === "number" && result.ret !== 0) return result.ret;
  if (typeof result.errcode === "number" && result.errcode !== 0) return result.errcode;
  return 0;
}

function prestonVersion(): string {
  try {
    // src/channels/wechat and dist/channels/wechat are both three levels below the package root.
    const pkg = createRequire(import.meta.url)("../../../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** `iLink-App-ClientVersion`: 0x00MMNNPP as a decimal string (reference: buildClientVersion). */
function clientVersionHeader(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => Number.parseInt(p, 10));
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

/** `X-WECHAT-UIN`: base64 of the decimal string of a random uint32. */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/**
 * JSON.parse that keeps uint64 message identifiers exact by quoting them first.
 * Adapted from parseWeixinApiJson in openclaw-weixin src/api/api.ts (MIT, Tencent).
 */
export function parseILinkJson<T>(raw: string): T {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') {
      out += raw[i++];
      continue;
    }
    const start = i++;
    let escaped = false;
    while (i < raw.length) {
      const ch = raw[i++];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') break;
    }
    const token = raw.slice(start, i);
    out += token;
    let cursor = i;
    while (/\s/.test(raw[cursor] ?? "")) cursor++;
    if (raw[cursor] !== ":") continue;
    let key: unknown;
    try {
      key = JSON.parse(token);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;
    out += raw.slice(i, cursor + 1);
    cursor++;
    while (/\s/.test(raw[cursor] ?? "")) out += raw[cursor++];
    const numStart = cursor;
    if (raw[cursor] === "-") cursor++;
    while (/\d/.test(raw[cursor] ?? "")) cursor++;
    if (cursor > numStart && !(cursor === numStart + 1 && raw[numStart] === "-")) {
      out += `"${raw.slice(numStart, cursor)}"`;
      i = cursor;
    } else {
      i = numStart;
    }
  }
  return JSON.parse(out) as T;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

interface RequestOptions {
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ILinkClientOptions {
  fetch?: typeof fetch;
}

export class ILinkClient {
  private readonly fetchImpl: typeof fetch;
  private readonly version = prestonVersion();

  constructor(options: ILinkClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private baseInfo() {
    return {
      channel_version: `${ILINK_PROTOCOL_VERSION}/preston-${this.version}`,
      bot_agent: `Preston/${this.version}`,
    };
  }

  private appHeaders(): Record<string, string> {
    return {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": clientVersionHeader(ILINK_PROTOCOL_VERSION),
    };
  }

  private async request<T>(
    method: "GET" | "POST",
    url: URL,
    headers: Record<string, string>,
    body: string | undefined,
    opts: RequestOptions,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const res = await this.fetchImpl(url, { method, headers, body, signal });
    const text = await res.text();
    if (!res.ok) throw new ILinkHttpError(res.status, opts.label);
    try {
      return parseILinkJson<T>(text);
    } catch {
      throw new Error(`${opts.label} returned a response that is not valid JSON`);
    }
  }

  private post<T>(
    baseUrl: string,
    endpoint: string,
    payload: object,
    token: string | undefined,
    opts: RequestOptions,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      ...this.appHeaders(),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return this.request<T>(
      "POST",
      endpointUrl(baseUrl, endpoint),
      headers,
      JSON.stringify(payload),
      opts,
    );
  }

  /** Authenticated bot API call; `base_info` is attached to every one. */
  private botPost<T>(
    baseUrl: string,
    token: string,
    endpoint: string,
    payload: object,
    opts: RequestOptions,
  ): Promise<T> {
    return this.post<T>(baseUrl, endpoint, { ...payload, base_info: this.baseInfo() }, token, opts);
  }

  /**
   * Long-poll for inbound messages. A client-side timeout is a normal empty poll that keeps
   * the cursor; an external abort is rethrown so the caller can exit.
   */
  async getUpdates(
    baseUrl: string,
    token: string,
    cursor: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<GetUpdatesResponse> {
    try {
      return await this.botPost<GetUpdatesResponse>(
        baseUrl,
        token,
        "ilink/bot/getupdates",
        { get_updates_buf: cursor },
        { label: "getupdates", timeoutMs, signal },
      );
    } catch (err) {
      if (isAbortError(err) && !signal?.aborted)
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      throw err;
    }
  }

  sendText(
    baseUrl: string,
    token: string,
    message: { to: string; text: string; contextToken?: string; clientId: string },
    signal?: AbortSignal,
  ): Promise<SendMessageResponse> {
    const msg: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: message.to,
      client_id: message.clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: message.text } }],
    };
    if (message.contextToken) msg.context_token = message.contextToken;
    return this.botPost<SendMessageResponse>(
      baseUrl,
      token,
      "ilink/bot/sendmessage",
      { msg },
      { label: "sendmessage", timeoutMs: 15_000, signal },
    );
  }

  notifyStart(baseUrl: string, token: string, signal?: AbortSignal): Promise<ApiResult> {
    return this.botPost<ApiResult>(
      baseUrl,
      token,
      "ilink/bot/msg/notifystart",
      {},
      {
        label: "notifystart",
        timeoutMs: 10_000,
        signal,
      },
    );
  }

  notifyStop(baseUrl: string, token: string): Promise<ApiResult> {
    return this.botPost<ApiResult>(
      baseUrl,
      token,
      "ilink/bot/msg/notifystop",
      {},
      {
        label: "notifystop",
        timeoutMs: 3_000,
      },
    );
  }

  /** Self-bind login QR: JSON POST headers without Authorization, and no base_info. */
  getBotQrcode(
    baseUrl: string,
    localTokens: string[],
    signal?: AbortSignal,
  ): Promise<QrCodeResponse> {
    return this.post<QrCodeResponse>(
      baseUrl,
      `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
      { local_token_list: localTokens.slice(0, 10) },
      undefined,
      { label: "get_bot_qrcode", timeoutMs: 15_000, signal },
    );
  }

  /**
   * Long-poll the login QR status. Like the reference, a timeout or network error counts as
   * `wait`; only an external abort is rethrown.
   */
  async getQrcodeStatus(
    baseUrl: string,
    qrcode: string,
    verifyCode: string | undefined,
    signal?: AbortSignal,
  ): Promise<QrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    try {
      return await this.request<QrStatusResponse>(
        "GET",
        endpointUrl(baseUrl, endpoint),
        this.appHeaders(),
        undefined,
        { label: "get_qrcode_status", timeoutMs: 35_000, signal },
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      return { status: "wait" };
    }
  }
}

function endpointUrl(baseUrl: string, endpoint: string): URL {
  return new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}
