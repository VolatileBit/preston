import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";
import { FakeChannel } from "../../../src/channels/fake/index.js";
import type { ChannelKind, OutboundMessage } from "../../../src/channels/types.js";
import { type Daemon, startDaemon } from "../../../src/daemon/daemon.js";
import type { Goal } from "../../../src/goals/store.js";
import { noGitHub } from "../../../src/landing/github.js";
import { type FakeScript, fakeAdapterFactory } from "../../../src/workers/fake/index.js";
import { record } from "./ledger.js";
import { type Metered, type MeteredOptions, metered } from "./metered.js";
import { CHEAPEST, type Provider, realAdapter } from "./providers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (err) {
      console.warn(`smoke cleanup failed: ${String(err)}`);
    }
  }
});

export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `preston-smoke-${prefix}-`)));
  // SMOKE_KEEP=1 keeps the temporary folders, to inspect transcripts and logs after a failure.
  if (process.env.SMOKE_KEEP) console.log(`kept ${dir}`);
  else onCleanup(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function write(root: string, file: string, content: string): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export interface Project {
  dir: string;
  /** A bare repository standing in for a hosted remote; any push to it shows in `pushes()`. */
  origin?: string;
}

/** A throwaway repository in the temp directory, on `main` with one commit. */
export function makeProject(
  options: { files?: Record<string, string>; remote?: boolean } = {},
): Project {
  const dir = tempDir("repo");
  git(dir, "init", "--quiet", "--initial-branch=main");
  for (const [file, content] of Object.entries(options.files ?? { "README.md": "# smoke\n" })) {
    write(dir, file, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "Initial commit");
  if (!options.remote) return { dir };
  const origin = tempDir("origin");
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "--quiet", "origin", "main");
  git(dir, "fetch", "--quiet", "origin");
  git(dir, "remote", "set-head", "origin", "main");
  return { dir, origin };
}

/** Every ref in a bare remote, so a stray push is visible. */
export function remoteRefs(origin: string): string {
  return git(origin, "for-each-ref", "--format=%(refname) %(objectname)");
}

/** A Channel that also prints what Preston says, so a long run can be followed. */
export class LoggedChannel extends FakeChannel {
  constructor(
    readonly label: string,
    private readonly startedAt: number,
    options: { kind?: ChannelKind; reactions?: boolean } = {},
  ) {
    super(options);
  }

  override async send(message: OutboundMessage) {
    const result = await super.send(message);
    if (result.status === "delivered") {
      log(
        this.startedAt,
        `${this.label} <- [${message.kind}] ${message.text.replace(/\n/g, " | ")}`,
      );
    }
    return result;
  }
}

export function log(startedAt: number, text: string): void {
  console.log(`[+${String(Math.round((Date.now() - startedAt) / 1000)).padStart(3)}s] ${text}`);
}

export interface WorldOptions {
  scenario: string;
  provider: Provider;
  /** `real`: the real agent thinks as Coordinator. A script: a scripted stand-in, no model call. */
  coordinator: "real" | FakeScript;
  channels?: { label: string; kind: ChannelKind; reactions?: boolean }[];
  /** Config on top of the cheapest-model defaults. */
  config?: Record<string, unknown>;
  /** Changes real events, or the quota read (the quota scenario only). */
  metering?: Omit<MeteredOptions, "scenario" | "provider">;
  /** An existing home, for a restart. */
  home?: string;
}

export interface World {
  home: string;
  startedAt: number;
  daemon: Daemon;
  channels: LoggedChannel[];
  /** The metered real adapter: every real turn, with its Session and tokens. */
  agent: Metered;
  /** The first Channel. */
  owner: LoggedChannel;
  goals(): Goal[];
  say(text: string, channel?: number): string;
  waitForGoal(predicate?: (g: Goal) => boolean, timeoutMs?: number): Promise<Goal>;
  stop(): Promise<void>;
}

const BASE_TIMING = {
  // Quick retries of failed deliveries; nothing here changes what is sent.
  outbox: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 5 },
};

/**
 * Starts a real Preston daemon in this process (IPC endpoint and all, so the agents' `preston
 * mcp` server reaches it) with fake owner Channels and the real agent CLI for the provider, on
 * the cheapest model, in a temporary PRESTON_HOME. Nothing is registered with the OS login
 * service, no real chat service is contacted, and GitHub is unavailable, so nothing is pushed.
 */
export async function startWorld(options: WorldOptions): Promise<World> {
  const startedAt = Date.now();
  const home = options.home ?? tempDir("home");
  const cli = process.env.PRESTON_SMOKE_CLI;
  if (!cli) throw new Error("PRESTON_SMOKE_CLI is not set; run through `npm run smoke`.");
  const { model, effort } = CHEAPEST[options.provider];
  const channels = (options.channels ?? [{ label: "owner", kind: "fake" as const }]).map(
    (c) => new LoggedChannel(c.label, startedAt, c),
  );
  const agent = metered(realAdapter(options.provider), {
    scenario: options.scenario,
    provider: options.provider,
    ...options.metering,
  });
  const scripted = options.coordinator !== "real";
  const fake = fakeAdapterFactory({
    ...(scripted ? { coordinator: options.coordinator as FakeScript } : {}),
  });
  const daemon = await startDaemon({
    home,
    adapters: {
      [options.provider]: () => agent,
      fake: fake.factory,
    },
    channels,
    mcpCommand: { command: process.execPath, args: [cli] },
    landing: { github: noGitHub },
    initialConfig: {
      agents: { enabled: [options.provider] },
      coordinator: { agent: scripted ? "fake" : options.provider, model, effort },
      workers: { model, effort },
      verification: { checkTimeoutMs: 120_000 },
      setup: { complete: true },
      ...BASE_TIMING,
      ...options.config,
    },
  });
  const stop = async () => {
    await daemon.close();
  };
  onCleanup(stop);
  const rt = daemon.runtime;
  return {
    home,
    startedAt,
    daemon,
    channels,
    agent,
    owner: channels[0] as LoggedChannel,
    goals: () => rt.goals(),
    say(text, channel = 0) {
      log(startedAt, `${channels[channel]?.label ?? "owner"} -> ${text.replace(/\n/g, " | ")}`);
      return (channels[channel] as LoggedChannel).receive(text);
    },
    async waitForGoal(predicate = (g) => Boolean(g.endedAt), timeoutMs = 8 * 60_000) {
      let repliedAt: number | undefined;
      return poll(
        () => {
          const found = rt.goals().find(predicate);
          if (found) return found;
          // The Coordinator answered but never started a Goal: fail now instead of waiting.
          if (rt.goals().length === 0) {
            const reply = channels.flatMap((c) => c.sent).find((m) => m.kind === "reply");
            if (reply) repliedAt ??= Date.now();
            if (repliedAt && Date.now() - repliedAt > 20_000) {
              throw new Error(`The Coordinator replied but started no Goal. Reply: ${reply?.text}`);
            }
          }
          return undefined;
        },
        timeoutMs,
        "a Goal to reach the expected state",
        () =>
          rt
            .goals()
            .map((g) => `${g.id}:${g.state}${g.detail ? ` (${g.detail})` : ""}`)
            .join(", ") || "no Goals",
      );
    },
    stop,
  };
}

/** Polls until `check` returns something truthy, or fails with `describe()` for context. */
export async function poll<T>(
  check: () => T | undefined | null | false,
  timeoutMs: number,
  what: string,
  describe: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}. ${describe()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Records the scenario's result in the cost ledger, whatever the outcome. */
export function scenarioResult(
  scenario: string,
  provider: string,
  startedAt: number,
  status: "pass" | "fail" | "skipped",
  note?: string,
): void {
  record({
    kind: "scenario",
    scenario,
    provider,
    status,
    wallMs: Date.now() - startedAt,
    ...(note ? { note } : {}),
  });
}
