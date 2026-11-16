/**
 * A fake process launcher that replays recorded `claude` stdout line by line, for adapter tests.
 */
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type {
  SpawnedProcess,
  SpawnFn,
  SpawnOptionsLite,
} from "../../../src/workers/claude/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixtureLines(name: string): string[] {
  return readFileSync(join(fixturesDir, name), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

export interface Script {
  /** Stdout lines to replay (without line endings). */
  lines?: string[];
  /** Line ending to use when replaying. */
  eol?: "\n" | "\r\n";
  /** Split stdout into chunks of this many bytes, to exercise partial lines. */
  chunkBytes?: number;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  /** Keep running after replay until killed. */
  hold?: boolean;
  /** When held, ignore SIGINT (forcing the adapter to escalate). */
  ignoreSigint?: boolean;
}

export class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: (NodeJS.Signals | undefined)[] = [];
  stdinText = "";
  stdinEnded = false;
  stdoutText = "";
  private closed = false;

  constructor(private readonly script: Script) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (d: string) => {
      this.stdinText += d;
    });
    this.stdin.on("end", () => {
      this.stdinEnded = true;
    });
  }

  /** JSON messages written to the CLI's stdin. */
  get stdinMessages(): Record<string, unknown>[] {
    return this.stdinText
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (signal === "SIGINT" && this.script.ignoreSigint) return true;
    this.close(null, signal ?? "SIGTERM");
    return true;
  }

  async replay(lines: string[]): Promise<void> {
    const eol = this.script.eol ?? "\n";
    const data = Buffer.from(lines.map((l) => l + eol).join(""), "utf8");
    this.stdoutText = data.toString("utf8");
    const size = this.script.chunkBytes ?? 0;
    if (size > 0) {
      for (let i = 0; i < data.length; i += size) {
        this.stdout.write(data.subarray(i, i + size));
        await tick();
      }
    } else {
      for (const line of lines) {
        this.stdout.write(line + eol);
        await tick();
      }
    }
    if (this.script.stderr) this.stderr.write(this.script.stderr);
    if (!this.script.hold) this.close(this.script.code ?? 0, this.script.signal ?? null);
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptionsLite;
  child: FakeChild;
  /** Contents of files passed via flags, read at spawn time (they are removed after exit). */
  files: Record<string, string>;
}

export function argValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * Creates a fake spawn. `handler` picks the script for each call. Recorded session IDs in the
 * replayed lines are replaced by the one in argv, as the real CLI uses the ID it is given.
 */
export function fakeSpawn(handler: (args: readonly string[], command: string) => Script) {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const script = handler(args, command);
    const child = new FakeChild(script);
    const files: Record<string, string> = {};
    for (const flag of ["--mcp-config", "--append-system-prompt-file"]) {
      const path = argValue(args, flag);
      if (path && existsSync(path)) files[flag] = readFileSync(path, "utf8");
    }
    calls.push({ command, args, options, child, files });
    const wanted = argValue(args, "--session-id") ?? argValue(args, "--resume");
    let lines = script.lines ?? [];
    const recorded = lines
      .map((l) => /"session_id":"([0-9a-f-]{36})"/.exec(l)?.[1])
      .find((id) => id !== undefined);
    if (wanted && recorded) lines = lines.map((l) => l.split(recorded).join(wanted));
    setImmediate(() => void child.replay(lines));
    return child;
  };
  return { spawn, calls };
}
