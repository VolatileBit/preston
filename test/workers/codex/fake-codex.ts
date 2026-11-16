import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type {
  CodexChild,
  CodexSpawn,
  CodexSpawnOptions,
} from "../../../src/workers/codex/index.js";

// biome-ignore lint/suspicious/noExplicitAny: fixtures are raw protocol JSON
export type Json = any;
export interface FixtureEntry {
  dir: "in" | "out";
  msg: Json;
}

const fixtureDir = new URL("./fixtures/", import.meta.url);

/** Loads a recorded or synthetic transcript, dropping its `meta` header line. */
export function loadFixture(name: string): FixtureEntry[] {
  return readFileSync(new URL(`${name}.jsonl`, fixtureDir), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.dir === "in" || entry.dir === "out");
}

export function loadJsonFixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`${name}.json`, fixtureDir), "utf8")).result;
}

/** Answers a request Preston sends that the transcript doesn't cover (or overrides it). */
export type Handler = (msg: Json, server: FakeAppServer) => void;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: (NodeJS.Signals | undefined)[] = [];
  exited = false;

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.exit(null, signal ?? "SIGTERM");
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", code, signal);
    });
  }
}

/**
 * Simulates `codex app-server` by replaying a transcript: each message Preston sends is matched to
 * the next recorded client message of the same kind, then the recorded server output up to the
 * following client message is written back (with response ids translated). Lines are written in
 * two chunks, with CRLF endings when asked, to exercise framing.
 */
export class FakeAppServer extends FakeChild {
  /** Everything Preston wrote, parsed. */
  readonly received: Json[] = [];
  stdinEnded = false;
  private position = 0;
  private readonly idMap = new Map<string, number | string>();
  private buffer = "";

  constructor(
    private readonly script: FixtureEntry[],
    private readonly handlers: Record<string, Handler> = {},
    private readonly options: { crlf?: boolean; exitOnStdinEnd?: boolean } = {},
  ) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.onInput(chunk));
    this.stdin.on("finish", () => {
      this.stdinEnded = true;
      if (this.options.exitOnStdinEnd !== false) this.exit(0);
    });
    setImmediate(() => this.flush());
  }

  requests(method: string): Json[] {
    return this.received.filter((m) => m.method === method);
  }

  send(msg: Json): void {
    if (this.exited) return;
    const line = JSON.stringify(msg);
    const mid = Math.floor(line.length / 2);
    this.stdout.write(line.slice(0, mid));
    this.stdout.write(`${line.slice(mid)}${this.options.crlf ? "\r\n" : "\n"}`);
  }

  crash(code: number, stderr = ""): void {
    if (stderr) this.stderr.write(stderr);
    this.exit(code);
  }

  private onInput(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.trim()) this.onMessage(JSON.parse(line));
    }
  }

  private onMessage(msg: Json): void {
    this.received.push(msg);
    const handler = msg.method ? this.handlers[msg.method] : undefined;
    if (handler) {
      handler(msg, this);
      return;
    }
    const isResponse = msg.method === undefined;
    const index = this.script.findIndex(
      (entry, i) =>
        i >= this.position &&
        entry.dir === "out" &&
        (isResponse
          ? entry.msg.method === undefined && entry.msg.id === msg.id
          : entry.msg.method === msg.method),
    );
    if (index < 0) {
      if (msg.id !== undefined && !isResponse) {
        this.send({
          id: msg.id,
          error: { code: -32601, message: `not in fixture: ${msg.method}` },
        });
      }
      return;
    }
    const recorded = this.script[index]?.msg;
    if (!isResponse && recorded.id !== undefined) this.idMap.set(String(recorded.id), msg.id);
    this.position = index + 1;
    setImmediate(() => this.flush());
  }

  private flush(): void {
    while (this.position < this.script.length) {
      const entry = this.script[this.position];
      if (!entry || entry.dir === "out") return;
      this.position++;
      const msg = entry.msg;
      const isResponse = msg.method === undefined && msg.id !== undefined;
      this.send(isResponse ? { ...msg, id: this.idMap.get(String(msg.id)) ?? msg.id } : msg);
    }
  }
}

/** A one-shot CLI command such as `codex --version`. */
export class FakeCommand extends FakeChild {
  constructor(result: { stdout?: string; stderr?: string; code: number }) {
    super();
    setImmediate(() => {
      if (result.stdout) this.stdout.write(result.stdout);
      if (result.stderr) this.stderr.write(result.stderr);
      this.exit(result.code);
    });
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: CodexSpawnOptions;
}

/** A spawn that hands out fakes by argv, and records every launch. */
export function fakeSpawn(factory: (args: readonly string[]) => CodexChild | Error) {
  const calls: SpawnCall[] = [];
  const spawn: CodexSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = factory(args);
    if (child instanceof Error) {
      const failing = new FakeChild();
      setImmediate(() => failing.emit("error", child));
      return failing as unknown as CodexChild;
    }
    return child;
  };
  return { spawn, calls };
}

export function enoent(): Error {
  return Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
}
