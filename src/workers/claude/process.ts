/**
 * Locating and launching the user's `claude` executable without a shell, on every OS.
 */
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** The subset of `ChildProcess` the adapter relies on, so tests can inject a fake. */
export interface SpawnedProcess {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface SpawnOptionsLite {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio: ["pipe" | "ignore", "pipe", "pipe"];
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLite,
) => SpawnedProcess;

/** Reads an environment variable case-insensitively on Windows (copied env objects lose that). */
export function getEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the `claude` executable: on PATH first, then the native installer's default locations.
 * On Windows the native installer provides `claude.exe` and npm provides a `claude.cmd` shim.
 */
export function resolveExecutable(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const isWin = platform === "win32";
  const names = isWin ? ["claude.exe", "claude.cmd"] : ["claude"];
  if (explicit) {
    if (/[\\/]/.test(explicit)) return isExecutableFile(explicit, platform) ? explicit : undefined;
    names.splice(0, names.length, explicit);
    if (isWin && !/\.[a-z]+$/i.test(explicit)) names.push(`${explicit}.exe`, `${explicit}.cmd`);
  }
  const dirs = (getEnv(env, "PATH", platform) ?? "")
    .split(isWin ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const home = getEnv(env, isWin ? "USERPROFILE" : "HOME", platform);
  if (home) {
    dirs.push(join(home, ".local", "bin"));
    if (!isWin) dirs.push(join(home, ".claude", "local"));
  }
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

export interface LaunchCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

// Characters cmd.exe treats specially; escaped with ^ (approach used by cross-spawn).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg: string): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  // A .cmd shim re-parses its arguments, so metacharacters are escaped twice.
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/**
 * Builds the process invocation. A `.cmd`/`.bat` shim cannot be spawned directly on Windows
 * without a shell, so it is run through `cmd.exe /d /s /c` with every argument escaped.
 * Multi-line values must never be passed as arguments (cmd.exe cannot carry them); the adapter
 * sends the prompt on stdin and system-prompt text through a file.
 */
export function launchCommand(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): LaunchCommand {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    if (args.some((a) => /[\r\n]/.test(a))) {
      throw new Error("Cannot pass a multi-line argument through a Windows .cmd shim");
    }
    const line = [executable.replace(CMD_META, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
    return {
      command: getEnv(env, "ComSpec", platform) ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: executable, args: [...args], windowsVerbatimArguments: false };
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs a short, non-interactive command (`--version`, `auth status`, `update`) to completion. */
export function runCommand(
  spawn: SpawnFn,
  executable: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; timeoutMs: number; cwd?: string },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: SpawnedProcess | undefined;
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child?.kill();
      settle({ code: null, stdout, stderr, error: new Error("Timed out") });
    }, opts.timeoutMs);
    try {
      const launch = launchCommand(executable, args, opts.env, opts.platform);
      child = spawn(launch.command, launch.args, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (error) {
      settle({ code: null, stdout, stderr, error: error as Error });
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (error) => settle({ code: null, stdout, stderr, error }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

/** Last part of a text, for error details. */
export function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}
