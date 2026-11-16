import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CreateDiscordTransport, DiscordIncoming } from "../src/channels/discord/index.js";
import { FakeChannel } from "../src/channels/fake/index.js";
import { chatChannelSpecs } from "../src/channels/registry.js";
import type { FakeScript, FakeTurn } from "../src/workers/fake/index.js";
import { FakeILink, fakeClock, PATHS } from "./channels/wechat/fake-ilink.js";
import {
  ownerMessage,
  type Preston,
  startPreston,
  TEST_CONFIG,
  waitFor,
} from "./support/harness.js";

const DISCORD_TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GhIjKl.abcdefghijklmnopqrstuvwxyz0123456789AB";
const OTHER_DISCORD_TOKEN =
  "OTg3NjU0MzIxMDk4NzY1NDMyMQ.ZyXwVu.ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zz";
const OWNER = "100";
const DM = "300";

/** Discord's Gateway, as the Discord Channel's transport sees it. */
class FakeDiscord {
  tokens: string[] = [];
  sent: { channelId: string; text: string }[] = [];
  private onMessage: ((m: DiscordIncoming) => void) | undefined;
  private next = 1;

  factory: CreateDiscordTransport = (token, log) => {
    this.tokens.push(token);
    return {
      connect: async (handlers) => {
        // A careless library logging its token must still not leak it.
        log("debug", `logged in with ${token}`);
        this.onMessage = handlers.onMessage;
        return { botUserId: "900", applicationId: "555" };
      },
      disconnect: async () => {
        this.onMessage = undefined;
      },
      openDm: async () => DM,
      sendMessage: async (channelId, text) => {
        this.sent.push({ channelId, text });
        return String(this.next++);
      },
      addReaction: async () => {},
    };
  };

  /** The owner sends the bot a direct message. */
  dm(content: string): void {
    if (!this.onMessage) throw new Error("not connected");
    this.onMessage({
      channelId: DM,
      messageId: String(this.next++),
      authorId: OWNER,
      authorIsBot: false,
      isDm: true,
      isUserMessage: true,
      content,
      createdAt: new Date(),
    });
  }
}

/** A Coordinator that runs one tool per owner message: `<tool> <json args>`. */
const toolRunner = (results: string[]): FakeScript => {
  return async (turn: FakeTurn) => {
    const text = ownerMessage(turn);
    if (!text) return "";
    const space = text.indexOf(" ");
    const name = space < 0 ? text : text.slice(0, space);
    const args = space < 0 ? {} : (JSON.parse(text.slice(space + 1)) as Record<string, unknown>);
    try {
      results.push(await turn.callTool(name, args));
    } catch (err) {
      results.push(`error: ${(err as Error).message}`);
    }
    return "ok";
  };
};

function section(p: Preston, kind: string): Record<string, unknown> | undefined {
  return p.rt.config.get().channels[kind] as Record<string, unknown> | undefined;
}

function logText(home: string): string {
  return readFileSync(join(home, "logs", "preston.log"), "utf8");
}

describe("connecting chat Channels in conversation", () => {
  test("channel_configure stores a pasted token without echoing it, and starts the Channel unpaired", async () => {
    const discord = new FakeDiscord();
    const results: string[] = [];
    const p = await startPreston({
      scenario: { coordinator: toolRunner(results) },
      chatChannels: chatChannelSpecs({
        discord: { createTransport: discord.factory, generatePairingCode: () => "K7M4QX" },
      }),
    });

    p.owner.receive(`channel_configure {"kind":"discord","values":{"botToken":"not a token"}}`);
    p.owner.receive(
      `channel_configure {"kind":"discord","values":{"botToken":" ${DISCORD_TOKEN} "}}`,
    );
    p.owner.receive(`config_get`);
    p.owner.receive(`channel_status`);
    await waitFor(() => results.length === 4, { what: "four tool results" });

    expect(results[0]).toMatch(/^error: That doesn't look like a Discord bot token/);
    expect(results[0]).not.toContain("not a token");
    const configured = JSON.parse(results[1] as string);
    expect(configured.saved.botToken).toBe("…89AB");
    expect(configured.channel).toMatchObject({ kind: "discord", state: "needs_pairing" });
    expect(p.rt.config.get().channels.discord).toEqual({ botToken: DISCORD_TOKEN });
    expect(JSON.parse(results[2] as string).channels.discord.botToken).toBe("(set)");
    expect(JSON.parse(results[3] as string).channels).toEqual([
      expect.objectContaining({ kind: "discord", state: "needs_pairing" }),
      expect.objectContaining({ kind: "slack", state: "not_configured" }),
      expect.objectContaining({ kind: "wechat", state: "not_configured" }),
    ]);
    for (const text of results) expect(text).not.toContain(DISCORD_TOKEN);
    for (const message of p.owner.sent) expect(message.text).not.toContain(DISCORD_TOKEN);
    expect(logText(p.home)).not.toContain(DISCORD_TOKEN);
  });

  test("channel_pair shows the steps in the conversation, saves the pairing and connects the Channel", async () => {
    const discord = new FakeDiscord();
    const results: string[] = [];
    const p = await startPreston({
      scenario: { coordinator: toolRunner(results) },
      config: { ...TEST_CONFIG, channels: { discord: { botToken: DISCORD_TOKEN } } },
      chatChannels: chatChannelSpecs({
        discord: { createTransport: discord.factory, generatePairingCode: () => "K7M4QX" },
      }),
    });

    p.owner.receive(`channel_pair {"kind":"discord"}`);
    await waitFor(() => p.owner.texts().some((t) => t.includes("K7M4QX")), {
      what: "the pairing code in the conversation",
    });
    expect(results[0]).toMatch(/^Pairing Discord started/);
    discord.dm("K7M4QX");

    await waitFor(() => section(p, "discord")?.ownerUserId, { what: "pairing saved" });
    expect(p.rt.config.get().channels.discord).toEqual({
      botToken: DISCORD_TOKEN,
      ownerUserId: OWNER,
      dmChannelId: DM,
    });
    await waitFor(() => p.owner.texts().some((t) => t.includes("Discord is paired")), {
      what: "the outcome in the conversation",
    });
    const setupEvent = await waitFor(
      () =>
        p.fake.calls.find(
          (c) => c.role === "coordinator" && c.input.prompt.includes("Pairing Discord succeeded"),
        ),
      { what: "the Coordinator hearing how pairing ended" },
    );
    expect(setupEvent.input.prompt).toContain('kind="setup" channel="fake"');
    // The paired Channel was kept, not rebuilt from the saved config, and it now works.
    expect(discord.tokens).toHaveLength(1);
    discord.dm("channel_status");
    await waitFor(() => discord.sent.some((m) => m.text === "ok"), {
      what: "the reply on Discord",
    });
    expect(JSON.parse(results[1] as string).channels[0]).toMatchObject({
      kind: "discord",
      state: "connected",
    });
  });

  test("a Channel is recreated when its config changes and removed with channel_remove", async () => {
    const discord = new FakeDiscord();
    const results: string[] = [];
    const p = await startPreston({
      scenario: { coordinator: toolRunner(results) },
      config: {
        ...TEST_CONFIG,
        channels: { discord: { botToken: DISCORD_TOKEN, ownerUserId: OWNER, dmChannelId: DM } },
      },
      chatChannels: chatChannelSpecs({ discord: { createTransport: discord.factory } }),
    });
    await waitFor(() => discord.tokens.length === 1, { what: "the first connection" });

    p.owner.receive(
      `config_update ${JSON.stringify({ patch: { channels: { discord: { botToken: OTHER_DISCORD_TOKEN } } } })}`,
    );
    await waitFor(() => results.length === 1, { what: "the update" });
    expect(discord.tokens).toEqual([DISCORD_TOKEN, OTHER_DISCORD_TOKEN]);

    p.owner.receive(`config_update {"patch":{"channels":{"discord":{"botToken":"nope"}}}}`);
    p.owner.receive(`channel_remove {"kind":"discord"}`);
    await waitFor(() => results.length === 3, { what: "the rejected update and the removal" });
    expect(results[1]).toMatch(
      /^error: I didn't change anything\. The Discord settings are not valid/,
    );
    expect(JSON.parse(results[2] as string)).toMatchObject({ state: "not_configured" });
    expect(p.rt.config.get().channels.discord).toBeUndefined();
    expect(discord.tokens).toHaveLength(2);
  });

  test("re-running preston resumes setup for a Channel that needs pairing, even after setup was completed", async () => {
    const discord = new FakeDiscord();
    const p = await startPreston({
      scenario: { coordinator: () => "Let's pair Discord again." },
      config: { ...TEST_CONFIG, channels: { discord: { botToken: DISCORD_TOKEN } } },
      chatChannels: chatChannelSpecs({ discord: { createTransport: discord.factory } }),
    });

    const state = await p.rt.setup.state();
    expect(state.complete).toBe(true);
    expect(state.unfinished).toEqual([
      "Discord isn't paired with your account yet. Run `preston` to finish setting it up.",
    ]);
    expect(p.rt.setup.continue({ justChoseAgents: false })).toBe(true);
    const turn = await waitFor(() => p.fake.calls.find((c) => c.role === "coordinator"));
    expect(turn.input.prompt).toContain("Discord isn't paired with your account yet.");
    expect(turn.input.prompt).toContain("channel_pair");
  });
});

describe("pairing WeChat in conversation", () => {
  let ilink: FakeILink;
  beforeEach(async () => {
    ilink = await new FakeILink().start();
  });
  afterEach(async () => {
    await ilink.close();
  });

  test("the number WeChat asks for is answered by the user's next message, which never reaches the Coordinator", async () => {
    const results: string[] = [];
    const p = await startPreston({
      scenario: { coordinator: toolRunner(results) },
      config: {
        ...TEST_CONFIG,
        channels: { wechat: { baseUrl: ilink.url, loginBaseUrl: ilink.url } },
      },
      chatChannels: chatChannelSpecs({ wechat: { clock: fakeClock() } }),
    });
    ilink
      .queue(PATHS.qrcode, {
        json: { qrcode: "qr-1", qrcode_img_content: "https://wx.example/q/1" },
      })
      .queue(
        PATHS.qrStatus,
        { json: { status: "need_verifycode" } },
        {
          json: {
            status: "confirmed",
            bot_token: "bot-token-SECRET-0001",
            ilink_bot_id: "b0b@im.bot",
            ilink_user_id: "owner@im.wechat",
          },
        },
      )
      .queue(PATHS.getUpdates, { json: { ret: 0, msgs: [], get_updates_buf: "cursor-1" } })
      .otherwise(PATHS.getUpdates, { hold: true });

    p.owner.receive(`channel_pair {"kind":"wechat"}`);
    await waitFor(() => p.owner.texts().some((t) => t.includes("https://wx.example/q/1")), {
      what: "the QR code in the conversation",
    });
    await waitFor(() => p.owner.texts().some((t) => t.includes("Enter the number WeChat shows")), {
      what: "the question in the conversation",
    });
    const coordinatorTurns = p.fake.calls.length;
    p.owner.receive("4711");

    await waitFor(() => section(p, "wechat")?.botToken, { what: "pairing saved" });
    expect(ilink.calls(PATHS.qrStatus).map((r) => r.query.get("verify_code"))).toEqual([
      null,
      "4711",
    ]);
    expect(p.fake.calls.slice(coordinatorTurns).map((c) => c.input.prompt)).not.toContainEqual(
      expect.stringContaining("4711"),
    );
    expect(p.rt.config.get().channels.wechat).toMatchObject({
      botToken: "bot-token-SECRET-0001",
      ownerUserId: "owner@im.wechat",
    });
    // The long-poll cursor is Channel state, kept out of config and its history.
    const stateFile = join(p.home, "channels", "wechat.json");
    await waitFor(
      () => existsSync(stateFile) && readFileSync(stateFile, "utf8").includes("cursor-1"),
      {
        what: "the cursor saved as Channel state",
      },
    );
    expect(section(p, "wechat")?.getUpdatesCursor).toBeUndefined();
    expect(logText(p.home)).not.toContain("bot-token-SECRET-0001");
  });

  test("an answer a pairing consumed is neither queued in the inbox nor replayed after a restart", async () => {
    const results: string[] = [];
    const config = {
      ...TEST_CONFIG,
      channels: { wechat: { baseUrl: ilink.url, loginBaseUrl: ilink.url } },
    };
    const p = await startPreston({
      scenario: { coordinator: toolRunner(results) },
      config,
      chatChannels: chatChannelSpecs({ wechat: { clock: fakeClock() } }),
    });
    ilink
      .queue(PATHS.qrcode, {
        json: { qrcode: "qr-1", qrcode_img_content: "https://wx.example/q/1" },
      })
      .queue(
        PATHS.qrStatus,
        { json: { status: "need_verifycode" } },
        { json: { status: "need_verifycode" } },
      )
      .otherwise(PATHS.getUpdates, { hold: true });

    p.owner.receive(`channel_pair {"kind":"wechat"}`);
    await waitFor(() => p.owner.texts().some((t) => t.includes("Enter the number WeChat shows")), {
      what: "the question in the conversation",
    });
    p.owner.receive("4711");
    await waitFor(() => ilink.calls(PATHS.qrStatus).length === 2, { what: "the answer used" });
    // The next message is an ordinary one, and is queued as such.
    await waitFor(() => p.owner.texts().filter((t) => t.includes("Enter the number")).length === 2);
    p.owner.receive("status");
    await waitFor(() => p.owner.texts("reply").some((t) => t.startsWith("Nothing in progress")));

    await p.stop();
    const db = new DatabaseSync(join(p.home, "preston.db"), { readOnly: true });
    const stored = db.prepare("SELECT text, state FROM inbound_messages ORDER BY id").all();
    db.close();
    expect(stored).toEqual([{ text: `channel_pair {"kind":"wechat"}`, state: "handled" }]);

    const second = await p.restart({ scenario: { coordinator: toolRunner(results) } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.fake.calls.map((c) => c.input.prompt).join("\n")).not.toContain("4711");
  });
});

test("a fixed Channel of a chat kind is never rebuilt from config", async () => {
  const discord = new FakeDiscord();
  const fixed = new FakeChannel({ kind: "discord" });
  await startPreston({
    scenario: {},
    channels: [fixed],
    config: {
      ...TEST_CONFIG,
      channels: { discord: { botToken: DISCORD_TOKEN, ownerUserId: OWNER } },
    },
    chatChannels: chatChannelSpecs({ discord: { createTransport: discord.factory } }),
  });
  expect(discord.tokens).toEqual([]);
});
