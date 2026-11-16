/**
 * QR-code login ("self bind") for the iLink protocol.
 *
 * Flow and status handling follow openclaw-weixin src/auth/login-qr.ts and docs/protocol.md
 * ("QR-code login", "Poll bind status and the PIN") — MIT, Tencent. The other-owner
 * real-name path is not implemented: Preston always binds the scanning user's own ClawBot.
 */

import { renderUnicodeCompact } from "uqr";
import type { PairingIO } from "../types.js";
import type { ILinkClient, QrCodeResponse } from "./api.js";
import type { WeChatClock } from "./clock.js";

export type PairingOutcome =
  | { kind: "confirmed"; botToken: string; botId: string; ownerUserId: string; baseUrl?: string }
  | { kind: "already_bound" }
  | { kind: "failed"; detail: string };

/** Total QR codes shown before giving up (reference: MAX_QR_REFRESH_COUNT). */
const MAX_QR_CODES = 3;
/** Overall wait for a scan (reference: QR_LOGIN_WAIT_MS, 480 s). */
const LOGIN_WAIT_MS = 480_000;
const POLL_INTERVAL_MS = 1_000;

const CANCELLED: PairingOutcome = { kind: "failed", detail: "WeChat pairing was cancelled." };

export async function pairWithQrCode(opts: {
  client: ILinkClient;
  clock: WeChatClock;
  loginBaseUrl: string;
  localTokens: string[];
  io: PairingIO;
  log: (level: "debug" | "info" | "warn", message: string) => void;
}): Promise<PairingOutcome> {
  const { client, clock, io } = opts;
  const signal = io.signal;
  let pollBaseUrl = opts.loginBaseUrl;

  const fetchQr = async (): Promise<QrCodeResponse | PairingOutcome> => {
    try {
      const qr = await client.getBotQrcode(opts.loginBaseUrl, opts.localTokens, signal);
      if (qr.qrcode && qr.qrcode_img_content) return qr;
      opts.log("warn", "get_bot_qrcode returned no QR code");
    } catch (err) {
      if (signal.aborted) return CANCELLED;
      opts.log("warn", `get_bot_qrcode failed: ${err instanceof Error ? err.message : "error"}`);
    }
    return {
      kind: "failed",
      detail: "Couldn't get a login code from WeChat. Check the internet connection and try again.",
    };
  };

  const show = (content: string, intro: string) => {
    io.show(
      `${intro}\n\n${renderUnicodeCompact(content, { border: 2 })}\n\n` +
        `If the code doesn't scan, open this link in WeChat instead:\n${content}`,
    );
  };

  let qr = await fetchQr();
  if ("kind" in qr) return qr;
  show(
    qr.qrcode_img_content ?? "",
    "Scan this QR code with WeChat on your phone, then confirm the login there.",
  );

  let codesShown = 1;
  let pin: string | undefined;
  let scannedShown = false;
  const deadline = clock.now() + LOGIN_WAIT_MS;

  while (clock.now() < deadline) {
    if (signal.aborted) return CANCELLED;
    let status: Awaited<ReturnType<ILinkClient["getQrcodeStatus"]>>;
    try {
      status = await client.getQrcodeStatus(pollBaseUrl, qr.qrcode ?? "", pin, signal);
    } catch {
      return CANCELLED;
    }
    const state = status.status ?? "wait";
    if (state !== "wait") opts.log("debug", `login status: ${state}`);

    if (state.includes("need_verifycode")) {
      if (!io.prompt) {
        return {
          kind: "failed",
          detail:
            "WeChat asked for the number shown on your phone, but this setup conversation " +
            "can't collect it yet. Please try pairing again.",
        };
      }
      const question = pin
        ? "That number didn't match. Enter the number WeChat shows on your phone:"
        : "Enter the number WeChat shows on your phone:";
      let answer: string;
      try {
        answer = await io.prompt(question);
      } catch {
        return CANCELLED;
      }
      pin = answer.trim();
      continue;
    }

    switch (state) {
      case "scaned":
        pin = undefined;
        if (!scannedShown) {
          io.show("Scanned. Now confirm the login in WeChat on your phone.");
          scannedShown = true;
        }
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          // The reference always switches to https://<redirect_host>; keep the current
          // scheme so a plain-http test server can exercise the same path.
          pollBaseUrl = `${new URL(pollBaseUrl).protocol}//${status.redirect_host}`;
        }
        break;
      case "expired":
      case "verify_code_blocked": {
        pin = undefined;
        codesShown += 1;
        if (codesShown > MAX_QR_CODES) {
          return {
            kind: "failed",
            detail:
              state === "expired"
                ? "The login code expired several times. Try pairing again when you're ready to scan."
                : "Too many wrong numbers were entered. Wait a while, then try pairing again.",
          };
        }
        const next = await fetchQr();
        if ("kind" in next) return next;
        qr = next;
        scannedShown = false;
        show(
          qr.qrcode_img_content ?? "",
          state === "expired"
            ? "That code expired. Here is a new one; scan it with WeChat:"
            : "Too many wrong numbers. Here is a new code; scan it with WeChat:",
        );
        break;
      }
      case "binded_redirect":
        return { kind: "already_bound" };
      case "confirmed": {
        if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
          return {
            kind: "failed",
            detail: "WeChat confirmed the login but didn't send the connection details. Try again.",
          };
        }
        return {
          kind: "confirmed",
          botToken: status.bot_token,
          botId: status.ilink_bot_id,
          ownerUserId: status.ilink_user_id,
          ...(validUrl(status.baseurl) ? { baseUrl: status.baseurl } : {}),
        };
      }
    }

    try {
      await clock.sleep(POLL_INTERVAL_MS, signal);
    } catch {
      return CANCELLED;
    }
  }
  return {
    kind: "failed",
    detail: "Timed out waiting for the QR code to be scanned. Try pairing again.",
  };
}

function validUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
