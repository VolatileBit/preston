import { execFile } from "node:child_process";
import type { CommandResult } from "../util/command.js";

export interface ExecOptions {
  cwd?: string;
  /** Extra environment variables, added to the cleaned environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Runs a program without a shell: arguments are an array and are never interpolated into a
 * command line. Never rejects. Injectable so tests can assert on commands.
 */
export type Exec = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<CommandResult>;

/** Variables that would make git operate on another repository than the one asked about. */
const GIT_REPO_VARS =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX|NAMESPACE)$/;

function cleanEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!GIT_REPO_VARS.test(key)) env[key] = value;
  }
  // Never wait for a person at a prompt, and keep git's messages stable.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GH_PROMPT_DISABLED = "1";
  env.LC_ALL = "C";
  return { ...env, ...extra };
}

export const defaultExec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: cleanEnv(options.env),
        timeout: options.timeoutMs ?? 120_000,
        windowsHide: true,
        shell: false,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
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
