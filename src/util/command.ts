import { execFile } from "node:child_process";

export interface CommandResult {
  /** Exit code; `null` if the command could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why the command could not run (for example `ENOENT` when it is not installed). */
  error?: string;
}

export interface CommandOptions {
  /** Extra environment variables, added to this process's environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Runs an OS command without a shell: arguments are passed as an array, never interpolated into
 * a command line. Never rejects. Injectable so tests can assert on commands for any OS.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        env: options.env ? { ...process.env, ...options.env } : process.env,
        timeout: options.timeoutMs ?? 15_000,
        windowsHide: true,
        shell: false,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        resolve(
          typeof code === "number"
            ? { code, stdout, stderr }
            : { code: null, stdout, stderr, error: code ?? error.message },
        );
      },
    );
  });

/** A short, plain description of a failed command for logs and user-facing explanations. */
export function describeFailure(command: string, result: CommandResult): string {
  if (result.error === "ENOENT") return `${command} is not available on this computer`;
  const output = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" ");
  const status = result.error ?? `exit code ${result.code}`;
  return output ? `${command} failed (${status}): ${output}` : `${command} failed (${status})`;
}
