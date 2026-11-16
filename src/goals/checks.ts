import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "../clock.js";
import type { Check } from "./brief.js";

export interface CheckResult {
  name: string;
  command: string;
  /** Whether the command came from the Brief or was suggested by the Worker. */
  source: "brief" | "suggested";
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Full output on disk. */
  outputPath: string;
  /** The last part of the output, kept for evidence and messages. */
  outputTail: string;
}

const TAIL_BYTES = 4_000;

/**
 * Runs one check command in `cwd` through the platform shell, as the user would type it.
 * Output goes to `outputPath`; the process tree is killed on timeout or abort.
 */
export function runCheck(
  check: Check & { source: CheckResult["source"] },
  options: {
    cwd: string;
    timeoutMs: number;
    clock: Clock;
    outputPath: string;
    signal?: AbortSignal;
  },
): Promise<CheckResult> {
  mkdirSync(dirname(options.outputPath), { recursive: true });
  const started = options.clock.now();
  const out = createWriteStream(options.outputPath, { mode: 0o600 });
  let tail = "";
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn(check.command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk: Buffer) => {
      out.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-TAIL_BYTES);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const kill = () => killTree(child.pid);
    const timer = options.clock.setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });

    let finished = false;
    const finish = (exitCode: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      timer.cancel();
      options.signal?.removeEventListener("abort", kill);
      if (error) tail = `${tail}\n${error.message}`.slice(-TAIL_BYTES);
      out.end(() =>
        resolve({
          name: check.name,
          command: check.command,
          source: check.source,
          passed: !timedOut && exitCode === 0,
          exitCode,
          timedOut,
          durationMs: options.clock.now() - started,
          outputPath: options.outputPath,
          outputTail: tail.trim(),
        }),
      );
    };
    child.once("error", (err) => finish(null, err));
    child.once("close", (code) => finish(code));
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}
