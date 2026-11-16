import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

/** The subset of a child process the Codex adapter relies on. Tests substitute a fake. */
export interface CodexChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface CodexSpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Only true for a Windows `.cmd`/`.bat` shim, which Node cannot start without a shell. */
  shell: boolean;
}

/** Starts the Codex CLI with piped stdio. Injectable so tests can simulate the App Server. */
export type CodexSpawn = (
  command: string,
  args: readonly string[],
  options: CodexSpawnOptions,
) => CodexChild;

export interface ResolvedExecutable {
  command: string;
  /** Absolute path when it could be found on disk. */
  path?: string;
  shell: boolean;
}

const isWindows = process.platform === "win32";

/** Spawns with pipes and, on Windows, kills the whole process tree on a forced kill. */
export const defaultSpawn: CodexSpawn = (command, args, options) => {
  // With a shell, Node joins command and args unquoted, so quote the path (e.g. under Program Files).
  const child = nodeSpawn(options.shell ? `"${command}"` : command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (isWindows) {
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL" && child.pid !== undefined) {
        // A .cmd shim runs codex as a grandchild; taskkill /T takes the whole tree down.
        nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }).on("error", () => kill(signal));
        return true;
      }
      return kill(signal);
    };
  }
  return child as CodexChild;
};

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (!isWindows) accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function needsShell(file: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(file);
}

/**
 * Finds the executable the way the OS would, without a shell: PATH, plus PATHEXT on Windows
 * (so `codex` resolves to `codex.exe` or the npm `codex.cmd` shim).
 */
export function resolveExecutable(executable: string, env: NodeJS.ProcessEnv): ResolvedExecutable {
  const hasDir = executable.includes("/") || (isWindows && executable.includes("\\"));
  const extensions = isWindows
    ? ["", ...(env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const withExtensions = (base: string) =>
    path.extname(base) && isWindows ? [base] : extensions.map((ext) => base + ext);

  if (hasDir) {
    for (const candidate of withExtensions(path.resolve(executable))) {
      if (isExecutableFile(candidate)) {
        return { command: candidate, path: candidate, shell: needsShell(candidate) };
      }
    }
    return { command: executable, shell: needsShell(executable) };
  }

  const searchPath = env.PATH ?? env.Path ?? "";
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const candidate of withExtensions(path.join(dir, executable))) {
      if (isExecutableFile(candidate)) {
        return { command: candidate, path: candidate, shell: needsShell(candidate) };
      }
    }
  }
  return { command: executable, shell: false };
}

/** Arguments must be plain tokens whenever a shell is involved, so nothing can be interpreted. */
export function assertShellSafe(args: readonly string[]): void {
  for (const arg of args) {
    if (!/^[\w.:=/-]+$/.test(arg)) throw new Error(`Unsafe argument for a shell launch: ${arg}`);
  }
}

export interface CapturedRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started (for example ENOENT). */
  error?: Error;
  timedOut: boolean;
}

/** Runs a short, non-interactive CLI command (stdin closed) and captures its output. */
export function runCaptured(
  spawn: CodexSpawn,
  exe: ResolvedExecutable,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd?: string,
): Promise<CapturedRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<CapturedRun, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    let child: CodexChild;
    try {
      if (exe.shell) assertShellSafe(args);
      child = spawn(exe.command, args, { cwd, env, shell: exe.shell });
    } catch (error) {
      resolve({ code: null, stdout, stderr, error: error as Error, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ code: null, error }));
    child.on("exit", (code) => finish({ code }));
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

/** Waits for exit; escalates from closed stdin to SIGTERM to SIGKILL. Resolves with the exit status. */
export function shutdownChild(
  child: CodexChild,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  graceMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  // The App Server exits cleanly when its stdin closes (observed with codex-cli 0.169.0).
  child.stdin.end();
  let killTimer: NodeJS.Timeout | undefined;
  const termTimer = setTimeout(() => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  }, graceMs);
  return exited.finally(() => {
    clearTimeout(termTimer);
    clearTimeout(killTimer);
  });
}
