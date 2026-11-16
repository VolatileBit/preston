import { type CommandResult, type CommandRunner, runCommand } from "../util/command.js";

export interface HostNotifierOptions {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** Milliseconds since the epoch. */
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** The same text is shown at most once per window. Default one hour. */
  dedupeWindowMs?: number;
  /** At most `maxPerWindow` notifications per `rateWindowMs`. Default 3 per 10 minutes. */
  rateWindowMs?: number;
  maxPerWindow?: number;
}

export type NotifyResult =
  | { shown: true; via: string }
  | {
      shown: false;
      reason: "empty" | "duplicate" | "rate_limited" | "unavailable";
      detail?: string;
    };

export interface HostNotifier {
  /** Shows a desktop notification on this computer. Never throws or rejects. */
  notify(text: string): Promise<NotifyResult>;
}

const TITLE = "Preston";
const MAX_LENGTH = 240;

/**
 * Windows toast through the built-in WinRT API. The text arrives in environment variables, never
 * in the script, so nothing in it is ever parsed as PowerShell; CreateTextNode escapes it as XML.
 * Shown under PowerShell's own app id, which is registered on every Windows install.
 */
const TOAST_SCRIPT = `$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$lines = $template.GetElementsByTagName('text')
$lines.Item(0).AppendChild($template.CreateTextNode($env:PRESTON_NOTIFY_TITLE)) > $null
$lines.Item(1).AppendChild($template.CreateTextNode($env:PRESTON_NOTIFY_TEXT)) > $null
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($template))
`;

/** `-EncodedCommand` takes base64 of UTF-16LE. */
export const TOAST_COMMAND = Buffer.from(TOAST_SCRIPT, "utf16le").toString("base64");

/**
 * Desktop notifications for `ChannelContext.notifyHost`: osascript on macOS, notify-send on
 * Linux (if installed), a PowerShell toast on Windows with `msg` as a last resort. Commands get
 * their arguments as arrays, never through a shell. Repeats and bursts are dropped.
 */
export function createHostNotifier(options: HostNotifierOptions = {}): HostNotifier {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const dedupeWindowMs = options.dedupeWindowMs ?? 60 * 60_000;
  const rateWindowMs = options.rateWindowMs ?? 10 * 60_000;
  const maxPerWindow = options.maxPerWindow ?? 3;
  const lastShown = new Map<string, number>();
  let recent: number[] = [];

  const show = async (text: string): Promise<NotifyResult> => {
    const attempts = commandsFor(platform, text, env);
    let failure: CommandResult | undefined;
    for (const attempt of attempts) {
      const result = await run(attempt.command, attempt.args, {
        env: attempt.env,
        timeoutMs: 10_000,
      });
      if (result.code === 0) return { shown: true, via: attempt.command };
      failure = result;
    }
    return {
      shown: false,
      reason: "unavailable",
      detail: failure ? (failure.error ?? failure.stderr.trim()) : `no notifier for ${platform}`,
    };
  };

  return {
    async notify(raw) {
      try {
        const text = clean(raw);
        if (!text) return { shown: false, reason: "empty" };
        const at = now();
        const previous = lastShown.get(text);
        if (previous !== undefined && at - previous < dedupeWindowMs) {
          return { shown: false, reason: "duplicate" };
        }
        recent = recent.filter((t) => at - t < rateWindowMs);
        if (recent.length >= maxPerWindow) return { shown: false, reason: "rate_limited" };
        lastShown.set(text, at);
        recent.push(at);
        return await show(text);
      } catch (err) {
        return { shown: false, reason: "unavailable", detail: String(err) };
      }
    },
  };
}

/** One line of printable text, bounded in length. */
function clean(text: string): string {
  const line = String(text)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are stripped.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line;
}

interface Attempt {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function commandsFor(platform: NodeJS.Platform, text: string, env: NodeJS.ProcessEnv): Attempt[] {
  switch (platform) {
    case "darwin":
      // The text is an argument to the script, never part of its source.
      return [
        {
          command: "osascript",
          args: [
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            TITLE,
            text,
          ],
        },
      ];
    case "win32": {
      const attempts: Attempt[] = [
        {
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", TOAST_COMMAND],
          env: { PRESTON_NOTIFY_TITLE: TITLE, PRESTON_NOTIFY_TEXT: text },
        },
      ];
      const user = env.USERNAME;
      if (user) attempts.push({ command: "msg", args: [user, "/TIME:60", `${TITLE}: ${text}`] });
      return attempts;
    }
    default:
      return [{ command: "notify-send", args: ["--app-name", TITLE, "--", TITLE, text] }];
  }
}
