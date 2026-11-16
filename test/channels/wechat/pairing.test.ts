import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWeChatChannel } from "../../../src/channels/wechat/index.js";
import {
  FakeILink,
  fakeClock,
  PATHS,
  recordingContext,
  recordingIO,
  textMessage,
  waitFor,
} from "./fake-ilink.js";

const BOT_TOKEN = "bot-token-SECRET-0001";

let fake: FakeILink;
beforeEach(async () => {
  fake = await new FakeILink().start();
});
afterEach(async () => {
  await fake.close();
});

function channel(config: Record<string, unknown> = {}) {
  return createWeChatChannel(
    { baseUrl: fake.url, loginBaseUrl: fake.url, ...config },
    { clock: fakeClock() },
  );
}

const confirmed = {
  json: {
    status: "confirmed",
    bot_token: BOT_TOKEN,
    ilink_bot_id: "b0b@im.bot",
    ilink_user_id: "owner@im.wechat",
  },
};

describe("WeChat pairing", () => {
  test("shows a QR code, waits for scan and confirm, and returns the credentials", async () => {
    fake
      .queue(PATHS.qrcode, {
        json: { qrcode: "qr-1", qrcode_img_content: "https://wx.example/q/1" },
      })
      .queue(
        PATHS.qrStatus,
        { json: { status: "wait" } },
        { json: { status: "scaned" } },
        confirmed,
      );
    const io = recordingIO();

    const result = await channel().pair?.(io);

    expect(result).toEqual({
      ok: true,
      detail: "WeChat is connected.",
      configPatch: {
        botToken: BOT_TOKEN,
        botId: "b0b@im.bot",
        ownerUserId: "owner@im.wechat",
        getUpdatesCursor: "",
        contextTokens: {},
      },
    });
    expect(io.shown[0]).toContain("Scan this QR code");
    expect(io.shown[0]).toMatch(/[█▀▄]/);
    expect(io.shown[0]).toContain("https://wx.example/q/1");
    expect(io.shown.some((s) => s.includes("confirm the login"))).toBe(true);

    const [qrReq] = fake.calls(PATHS.qrcode);
    expect(qrReq?.method).toBe("POST");
    expect(qrReq?.query.get("bot_type")).toBe("3");
    expect(qrReq?.body).toEqual({ local_token_list: [] });
    expect(qrReq?.headers.authorization).toBeUndefined();
    expect(qrReq?.headers["ilink-app-id"]).toBe("bot");
    const polls = fake.calls(PATHS.qrStatus);
    expect(polls).toHaveLength(3);
    expect(polls.every((p) => p.method === "GET" && p.query.get("qrcode") === "qr-1")).toBe(true);
  });

  test("an expired code is replaced with a fresh one", async () => {
    fake
      .queue(
        PATHS.qrcode,
        { json: { qrcode: "qr-1", qrcode_img_content: "https://wx.example/q/1" } },
        { json: { qrcode: "qr-2", qrcode_img_content: "https://wx.example/q/2" } },
      )
      .queue(PATHS.qrStatus, { json: { status: "expired" } }, confirmed);
    const io = recordingIO();

    const result = await channel().pair?.(io);

    expect(result?.ok).toBe(true);
    expect(
      io.shown.some((s) => s.includes("expired") && s.includes("https://wx.example/q/2")),
    ).toBe(true);
    expect(fake.calls(PATHS.qrStatus).map((p) => p.query.get("qrcode"))).toEqual(["qr-1", "qr-2"]);
  });

  test("gives up after a bounded number of expired codes", async () => {
    fake
      .otherwise(PATHS.qrcode, {
        json: { qrcode: "qr", qrcode_img_content: "https://wx.example/q" },
      })
      .otherwise(PATHS.qrStatus, { json: { status: "expired" } });

    const result = await channel().pair?.(recordingIO());

    expect(result?.ok).toBe(false);
    expect(result?.detail).toMatch(/expired several times/);
    expect(fake.calls(PATHS.qrcode)).toHaveLength(3);
  });

  test("can be cancelled while waiting for the scan", async () => {
    fake
      .queue(PATHS.qrcode, {
        json: { qrcode: "qr-1", qrcode_img_content: "https://wx.example/q/1" },
      })
      .otherwise(PATHS.qrStatus, { hold: true });
    const io = recordingIO();

    const pending = channel().pair?.(io);
    await waitFor(() => fake.calls(PATHS.qrStatus).length > 0);
    io.controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, detail: "WeChat pairing was cancelled." });
  });

  test("sends the number shown on the phone when WeChat asks for it", async () => {
    fake
      .queue(PATHS.qrcode, {
        json: { qrcode: "qr-1", qrcode_img_content: "https://wx.example/q/1" },
      })
      .queue(
        PATHS.qrStatus,
        { json: { status: "need_verifycode" } },
        { json: { status: "scaned" } },
        confirmed,
      );
    const questions: string[] = [];
    const io = recordingIO({
      prompt: async (q) => {
        questions.push(q);
        return " 4711 ";
      },
    });

    const result = await channel().pair?.(io);

    expect(result?.ok).toBe(true);
    expect(questions).toHaveLength(1);
    const codes = fake.calls(PATHS.qrStatus).map((p) => p.query.get("verify_code"));
    expect(codes).toEqual([null, "4711", null]);
  });

  test("fails plainly when WeChat asks for a number and the setup cannot ask the user", async () => {
    fake
      .queue(PATHS.qrcode, {
        json: { qrcode: "qr-1", qrcode_img_content: "https://wx.example/q/1" },
      })
      .queue(PATHS.qrStatus, { json: { status: "need_verifycode" } });

    const result = await channel().pair?.(recordingIO());

    expect(result?.ok).toBe(false);
    expect(result?.detail).toMatch(/number shown on your phone/);
  });

  test("re-pairing the same bot keeps the cursor and resumes polling with the new token", async () => {
    fake
      .queue(
        PATHS.getUpdates,
        { json: { ret: -14 } },
        { json: { ret: 0, msgs: [textMessage("owner@im.wechat", "back again")] } },
      )
      .queue(PATHS.qrcode, {
        json: { qrcode: "qr-1", qrcode_img_content: "https://wx.example/q/1" },
      })
      .queue(PATHS.qrStatus, {
        json: { ...confirmed.json, bot_token: "bot-token-NEW-0002" },
      });
    const ch = channel({
      botToken: BOT_TOKEN,
      botId: "b0b@im.bot",
      ownerUserId: "owner@im.wechat",
      getUpdatesCursor: "cursor-7",
    });
    const ctx = recordingContext();
    await ch.start(ctx);
    await waitFor(() => ctx.statuses.some((s) => s.status === "needs_pairing"));

    const result = await ch.pair?.(recordingIO());

    expect(result?.configPatch).toEqual({
      botToken: "bot-token-NEW-0002",
      botId: "b0b@im.bot",
      ownerUserId: "owner@im.wechat",
    });
    expect(fake.calls(PATHS.qrcode)[0]?.body).toEqual({ local_token_list: [BOT_TOKEN] });
    await waitFor(() => ctx.messages.length === 1);
    const resumed = fake.calls(PATHS.getUpdates)[1];
    expect(resumed?.headers.authorization).toBe("Bearer bot-token-NEW-0002");
    expect(resumed?.body.get_updates_buf).toBe("cursor-7");
    await ch.stop();
  });
});
