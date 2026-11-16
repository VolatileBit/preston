import { expect, test } from "vitest";
import type { Channel, ChannelContext } from "../src/channels/types.js";
import { createHostNotifier, TOAST_COMMAND } from "../src/notify/index.js";
import { createRuntime } from "../src/runtime.js";
import type { CommandOptions, CommandResult } from "../src/util/command.js";
import { onCleanup, TEST_CONFIG, tempDir } from "./support/harness.js";

const MALICIOUS = `Lost "WeChat" '; do shell script "rm -rf ~" -- $(touch /tmp/pwned) \`id\` & del C:\\ | %PATH% <b>`;

function recorder(respond: (command: string) => Partial<CommandResult> = () => ({})) {
  const calls: { command: string; args: readonly string[]; options?: CommandOptions }[] = [];
  return {
    calls,
    run: async (command: string, args: readonly string[], options?: CommandOptions) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: "", stderr: "", ...respond(command) };
    },
  };
}

test("macOS: the text is an osascript argument, never part of the script", async () => {
  const { calls, run } = recorder();
  const notifier = createHostNotifier({ platform: "darwin", run });

  expect(await notifier.notify(MALICIOUS)).toEqual({ shown: true, via: "osascript" });

  expect(calls).toEqual([
    {
      command: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        "Preston",
        MALICIOUS,
      ],
      options: { env: undefined, timeoutMs: 10_000 },
    },
  ]);
});

test("Linux: notify-send gets the text after `--`, so it is never read as an option", async () => {
  const { calls, run } = recorder();
  const notifier = createHostNotifier({ platform: "linux", run });

  await notifier.notify("--help me");

  expect(calls[0]).toMatchObject({
    command: "notify-send",
    args: ["--app-name", "Preston", "--", "Preston", "--help me"],
  });
});

test("Linux without notify-send: reported, not thrown", async () => {
  const { run } = recorder(() => ({ code: null, error: "ENOENT" }));
  const notifier = createHostNotifier({ platform: "linux", run });

  expect(await notifier.notify("hello")).toEqual({
    shown: false,
    reason: "unavailable",
    detail: "ENOENT",
  });
});

test("Windows: the toast script is fixed and the text travels in the environment", async () => {
  const { calls, run } = recorder();
  const notifier = createHostNotifier({ platform: "win32", run, env: { USERNAME: "ada" } });

  await notifier.notify(MALICIOUS);

  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call?.command).toBe("powershell.exe");
  expect(call?.args).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand", TOAST_COMMAND]);
  expect(call?.options?.env).toEqual({
    PRESTON_NOTIFY_TITLE: "Preston",
    PRESTON_NOTIFY_TEXT: MALICIOUS,
  });
  const script = Buffer.from(TOAST_COMMAND, "base64").toString("utf16le");
  expect(script).toContain("CreateTextNode($env:PRESTON_NOTIFY_TEXT)");
  expect(script).not.toContain("WeChat");
});

test("Windows: falls back to msg when toasts are unavailable", async () => {
  const { calls, run } = recorder((command) => (command === "powershell.exe" ? { code: 1 } : {}));
  const notifier = createHostNotifier({ platform: "win32", run, env: { USERNAME: "ada" } });

  expect(await notifier.notify("Run preston")).toEqual({ shown: true, via: "msg" });
  expect(calls[1]).toMatchObject({
    command: "msg",
    args: ["ada", "/TIME:60", "Preston: Run preston"],
  });
});

test("control characters and line breaks are flattened, and long text is shortened", async () => {
  const { calls, run } = recorder();
  const notifier = createHostNotifier({ platform: "darwin", run });

  await notifier.notify("line one\nline two\u0007\u001b[31m");
  await notifier.notify("x".repeat(1000));
  expect(await notifier.notify(" \n\t")).toEqual({ shown: false, reason: "empty" });

  expect(calls[0]?.args.at(-1)).toBe("line one line two [31m");
  expect(calls[1]?.args.at(-1)).toHaveLength(240);
});

test("the same text is shown once per window, and bursts are rate limited", async () => {
  let now = 0;
  const { calls, run } = recorder();
  const notifier = createHostNotifier({ platform: "darwin", run, now: () => now });
  const lost = "Preston lost its WeChat connection — run `preston` to reconnect.";

  expect(await notifier.notify(lost)).toMatchObject({ shown: true });
  now += 60_000;
  expect(await notifier.notify(lost)).toEqual({ shown: false, reason: "duplicate" });
  expect(await notifier.notify("second")).toMatchObject({ shown: true });
  expect(await notifier.notify("third")).toMatchObject({ shown: true });
  expect(await notifier.notify("fourth")).toEqual({ shown: false, reason: "rate_limited" });

  now += 60 * 60_000;
  expect(await notifier.notify(lost)).toMatchObject({ shown: true });
  expect(calls).toHaveLength(4);
});

test("a runner that throws never escapes", async () => {
  const notifier = createHostNotifier({
    platform: "darwin",
    run: () => {
      throw new Error("boom");
    },
  });

  expect(await notifier.notify("hello")).toMatchObject({ shown: false, reason: "unavailable" });
});

test("a Channel's notifyHost reaches the runtime's host notifier", async () => {
  const shown: string[] = [];
  let ctx: ChannelContext | undefined;
  const channel: Channel = {
    kind: "wechat",
    capabilities: { reactions: false, proactive: "windowed" },
    start: async (c) => {
      ctx = c;
    },
    stop: async () => {},
    send: async () => ({ status: "delivered" }),
  };
  const rt = await createRuntime({
    home: tempDir("preston-home"),
    adapters: {},
    channels: [channel],
    initialConfig: TEST_CONFIG,
    notifyHost: { notify: (text) => shown.push(text) },
  });
  await rt.start();
  onCleanup(() => rt.stop());

  ctx?.notifyHost("Preston lost its WeChat connection — run `preston` to reconnect.");
  await Promise.resolve();

  expect(shown).toEqual(["Preston lost its WeChat connection — run `preston` to reconnect."]);
});
