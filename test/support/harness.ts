import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { FakeChannel } from "../../src/channels/fake/index.js";
import type { ChatChannelKind, ChatChannelSpec } from "../../src/channels/registry.js";
import type { Channel } from "../../src/channels/types.js";
import type { Clock, ManualClock } from "../../src/clock.js";
import type { ConfigPatch } from "../../src/config/config.js";
import { noGitHub } from "../../src/landing/github.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "../../src/runtime.js";
import {
  type FakeAdapter,
  type FakeScenario,
  type FakeScript,
  type FakeTurn,
  fakeAdapterFactory,
} from "../../src/workers/fake/index.js";
import type { AdapterFactories } from "../../src/workers/registry.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

/** A fresh temporary directory, removed after the test. */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  onCleanup(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** Config for tests: the fake agent does everything and retries are quick. */
export const TEST_CONFIG: ConfigPatch = {
  agents: { enabled: ["fake"] },
  coordinator: { agent: "fake" },
  outbox: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 5 },
  setup: { complete: true },
};

export interface Preston {
  rt: Runtime;
  home: string;
  fake: FakeAdapter;
  /** The first Channel, an owner-paired fake by default. */
  owner: FakeChannel;
  channels: Channel[];
  /** Stops this runtime and starts a new one on the same home (a restart). */
  restart(next?: { scenario?: FakeScenario; channels?: Channel[] }): Promise<Preston>;
  stop(): Promise<void>;
}

export async function startPreston(options: {
  scenario: FakeScenario;
  home?: string;
  clock?: Clock;
  channels?: Channel[];
  config?: ConfigPatch;
  /** More adapters alongside the fake (for example a second fake standing in for Codex). */
  adapters?: AdapterFactories;
  /** Chat Channels built from config; tests pass ones with fake transports. */
  chatChannels?: Record<ChatChannelKind, ChatChannelSpec>;
  /** Wraps the fake adapter (for example to add listModels). */
  wrapAdapter?: (adapter: FakeAdapter) => FakeAdapter;
  /** The GitHub client used to land work. Default: GitHub is not available. */
  landing?: RuntimeOptions["landing"];
}): Promise<Preston> {
  const home = options.home ?? tempDir("preston-home");
  const channels = options.channels ?? [new FakeChannel()];
  const fake = fakeAdapterFactory(options.scenario);
  const rt = await createRuntime({
    home,
    clock: options.clock,
    adapters: {
      fake: (ctx) => {
        const adapter = fake.factory(ctx) as FakeAdapter;
        return options.wrapAdapter ? options.wrapAdapter(adapter) : adapter;
      },
      ...options.adapters,
    },
    channels,
    chatChannels: options.chatChannels,
    initialConfig: options.config ?? TEST_CONFIG,
    landing: options.landing ?? { github: noGitHub },
  });
  await rt.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await rt.stop();
  };
  onCleanup(stop);
  return {
    rt,
    home,
    fake: fake.adapter(),
    owner: channels[0] as FakeChannel,
    channels,
    stop,
    async restart(next = {}) {
      await stop();
      return startPreston({
        ...options,
        home,
        scenario: next.scenario ?? options.scenario,
        channels: next.channels ?? channels.map(cloneFake),
      });
    },
  };
}

function cloneFake(channel: Channel): Channel {
  return channel instanceof FakeChannel
    ? new FakeChannel({ kind: channel.kind, reactions: channel.capabilities.reactions })
    : channel;
}

/** Polls until `check` returns a truthy value. Real time, but only as a deadline. */
export async function waitFor<T>(
  check: () => T | undefined | null | false,
  options: { timeoutMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 8_000);
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${options.what ?? "condition"}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Moves a ManualClock forward in steps until `check` holds, so that work started by a timer
 * (an agent turn, a verification command with its own timeout) runs without the clock racing on.
 */
export async function advanceUntil(
  clock: ManualClock,
  check: () => boolean,
  maxMs: number,
  stepMs = 30_000,
): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += stepMs) {
    if (check()) return;
    await clock.advance(stepMs);
  }
  if (!check()) throw new Error(`Condition not met within ${maxMs} ms of clock time`);
}

/** Shell-portable check commands (they work in sh and cmd.exe). */
export const node = (code: string) => `node -e "${code}"`;
export const PASSING_CHECK = { name: "it works", command: node("process.exit(0)") };

export function brief(overrides: Record<string, unknown> = {}) {
  return {
    objective: "Make the greeting page say hello",
    scope: "Only the greeting page",
    acceptanceCriteria: ["The page says hello"],
    checks: [PASSING_CHECK],
    ...overrides,
  };
}

/** The owner message text in a Coordinator prompt, if this turn is one. */
export function ownerMessage(turn: FakeTurn): string | undefined {
  const match = /<preston-input kind="owner-message"[^>]*>\n([\s\S]*?)\n<\/preston-input>/.exec(
    turn.input.prompt,
  );
  return match?.[1];
}

/** The question ID in a Coordinator worker-question event, if this turn is one. */
export function workerQuestionId(turn: FakeTurn): string | undefined {
  if (!turn.input.prompt.includes('event="worker-question"')) return undefined;
  return /asks question (q-[0-9a-f]+)/.exec(turn.input.prompt)?.[1];
}

/** The approval ID in a Coordinator approval-request event, if this turn is one. */
export function approvalRequestId(turn: FakeTurn): string | undefined {
  if (!turn.input.prompt.includes('event="approval-request"')) return undefined;
  return /asks for approval (a-[0-9a-f]+)/.exec(turn.input.prompt)?.[1];
}

/**
 * A Coordinator that creates a Goal with `goalBrief` in `projectPath` when told "go". By
 * default it declines escalated approvals as outside the Brief; with `approvals: "pass"` they
 * reach `extra` like any other turn.
 */
export function goalCreatingCoordinator(
  projectPath: string,
  goalBrief: Record<string, unknown> = brief(),
  extra: FakeScript = () => "",
  options: { approvals?: "decline" | "pass" } = {},
): FakeScript {
  return async (turn) => {
    if (ownerMessage(turn)?.trim() === "go") {
      await turn.callTool("goal_create", { projectPath, brief: goalBrief });
      return "Here's the Brief I drafted.";
    }
    const approvalId = approvalRequestId(turn);
    if (approvalId && options.approvals !== "pass") {
      await turn.callTool("approval_decide", {
        approvalId,
        allow: false,
        reason: "the Brief's authority does not cover it",
      });
      return "";
    }
    return extra(turn);
  };
}

/** A Worker that reports success straight away. */
export const reportingWorker: FakeScript = async (turn) => {
  await turn.callTool("report_result", {
    summary: "Implemented the greeting.",
    checksPerformed: ["ran it"],
  });
  return "Done.";
};

export function finishedGoal(rt: Runtime) {
  return () => rt.goals().find((g) => g.endedAt);
}
