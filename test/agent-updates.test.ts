import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  checkInstall,
  managedByPackageManager,
  UPDATE_RETRY_MS,
  UPDATE_START_DELAY_MS,
} from "../src/agents/updater.js";
import { ManualClock } from "../src/clock.js";
import type { FakeScript } from "../src/workers/fake/index.js";
import type { AgentDetection, UpdateResult } from "../src/workers/types.js";
import {
  advanceUntil,
  brief,
  finishedGoal,
  goalCreatingCoordinator,
  onCleanup,
  ownerMessage,
  reportingWorker,
  startPreston,
  TEST_CONFIG,
  tempDir,
  waitFor,
  workerQuestionId,
} from "./support/harness.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A stand-in agent CLI: what `detect()` sees, and what its updater does, are scripted. */
function cli(version = "1.0.0") {
  const state = {
    version,
    installed: true,
    loggedIn: true as boolean | "unknown",
    problem: undefined as string | undefined,
    /** Called by `update()`; returns the result and may change the CLI as a real update would. */
    onUpdate: (): UpdateResult => ({ updated: false, detail: "Already up to date." }),
    updateTimes: [] as number[],
  };
  const detection = (): AgentDetection => ({
    installed: state.installed,
    path: "fake",
    version: state.version,
    loggedIn: state.loggedIn,
    ...(state.problem ? { problem: state.problem } : {}),
  });
  /** An update that installs `to`. */
  const upgradesTo = (to: string) => () => {
    const from = state.version;
    state.version = to;
    return { updated: true, fromVersion: from, toVersion: to, detail: `Updated from ${from}.` };
  };
  return { state, detection, upgradesTo };
}

async function start(
  agent: ReturnType<typeof cli>,
  options: {
    clock?: ManualClock;
    config?: Record<string, unknown>;
    worker?: FakeScript;
    coordinator?: FakeScript;
    tieSessions?: boolean;
  } = {},
) {
  const clock = options.clock ?? new ManualClock();
  const p = await startPreston({
    clock,
    scenario: {
      detection: agent.detection,
      update: () => {
        agent.state.updateTimes.push(clock.now());
        return agent.state.onUpdate();
      },
      sessionsTieToVersion: options.tieSessions ?? false,
      ...(options.worker ? { worker: options.worker } : {}),
      ...(options.coordinator ? { coordinator: options.coordinator } : {}),
    },
    config: { ...TEST_CONFIG, ...options.config },
  });
  return { p, clock };
}

const notices = (p: { owner: { texts(kind: "notice"): string[] } }) => p.owner.texts("notice");

describe("keeping the agent CLIs current", () => {
  test("an idle CLI is updated after start, and the version change is recorded and shown", async () => {
    const agent = cli("1.0.0");
    agent.state.onUpdate = agent.upgradesTo("1.0.1");
    const { p, clock } = await start(agent);

    await clock.advance(UPDATE_START_DELAY_MS - 1);
    expect(p.fake.updates).toBe(0);
    await clock.advance(1);
    await waitFor(() => p.fake.updates === 1, { what: "the update" });

    expect(p.rt.cliState("fake")).toMatchObject({ version: "1.0.1", result: "updated" });
    expect(p.rt.cliVersionChanges("fake")).toEqual([
      { agent: "fake", from: "1.0.0", to: "1.0.1", how: "update", at: expect.any(String) },
    ]);
    expect(p.rt.statusText()).toMatch(
      /Agent CLIs:\n- Fake agent 1\.0\.1: updated from 1\.0\.0 \(checked [^)]+\)\./,
    );
    // A routine patch update is not worth interrupting the user for.
    expect(notices(p)).toEqual([]);
  });

  test("a CLI that is already current is reported as up to date", async () => {
    const { p, clock } = await start(cli("2.3.4"));
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => p.rt.cliState("fake"), { what: "the first check" });
    expect(p.rt.cliState("fake")).toMatchObject({ version: "2.3.4", result: "up_to_date" });
    expect(p.rt.cliVersionChanges("fake")).toEqual([]);
    expect(p.rt.statusText()).toMatch(/- Fake agent 2\.3\.4: up to date \(checked [^)]+\)\.$/);
  });

  test("a new major version is told to the user once", async () => {
    const agent = cli("1.9.0");
    agent.state.onUpdate = agent.upgradesTo("2.0.0");
    const { p, clock } = await start(agent);
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => notices(p).length === 1, { what: "the notice" });
    expect(notices(p)[0]).toContain("Fake agent to 2.0.0, a new major version");
    await clock.advance(3 * DAY);
    expect(notices(p)).toHaveLength(1);
  });

  test("it never updates while a Run is using the CLI, and does once the Run is over", async () => {
    const agent = cli();
    agent.state.onUpdate = agent.upgradesTo("1.0.1");
    const project = tempDir("project");
    let finish!: () => void;
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { p, clock } = await start(agent, {
      coordinator: goalCreatingCoordinator(project),
      worker: async (turn) => {
        turn.activity("npm test", true);
        await released;
        return reportingWorker(turn);
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "running", { what: "the Run" });
    // Past the first check and one retry: the Run holds the CLI throughout.
    await clock.advance(UPDATE_START_DELAY_MS + UPDATE_RETRY_MS);
    expect(p.fake.updates).toBe(0);

    finish();
    await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });
    await advanceUntil(clock, () => p.fake.updates > 0, UPDATE_RETRY_MS * 2, MINUTE);
    expect(p.fake.updates).toBe(1);
    expect(p.rt.cliState("fake")).toMatchObject({ version: "1.0.1", result: "updated" });
  });

  test("it never updates while the Coordinator is thinking on the CLI", async () => {
    const agent = cli();
    agent.state.onUpdate = agent.upgradesTo("1.0.1");
    let finish!: () => void;
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let thinking = false;
    const { p, clock } = await start(agent, {
      coordinator: async () => {
        thinking = true;
        await released;
        return "Done thinking.";
      },
    });

    p.owner.receive("hello");
    await waitFor(() => thinking, { what: "the Coordinator to start" });
    await clock.advance(UPDATE_START_DELAY_MS + UPDATE_RETRY_MS);
    expect(p.fake.updates).toBe(0);

    finish();
    await waitFor(() => p.owner.texts("reply").length === 1, { what: "the reply" });
    await advanceUntil(clock, () => p.fake.updates > 0, UPDATE_RETRY_MS * 2, MINUTE);
    expect(p.fake.updates).toBe(1);
  });

  test("it does not update while setup is unfinished", async () => {
    const agent = cli();
    const { p, clock } = await start(agent, {
      config: { setup: { complete: false } },
    });
    await clock.advance(UPDATE_START_DELAY_MS + 2 * UPDATE_RETRY_MS);
    expect(p.fake.updates).toBe(0);

    p.rt.config.update({ setup: { complete: true } }, "setup finished");
    await advanceUntil(clock, () => p.fake.updates > 0, UPDATE_RETRY_MS * 2, MINUTE);
    expect(p.fake.updates).toBe(1);
  });

  test("a CLI that stops working after an update needs attention, and the user is told once", async () => {
    const agent = cli("1.0.0");
    agent.state.onUpdate = () => {
      agent.state.version = "1.1.0";
      agent.state.installed = false;
      agent.state.problem = "Fake agent is installed but won't start (missing library).";
      return { updated: true, fromVersion: "1.0.0", toVersion: "1.1.0", detail: "Updated." };
    };
    const { p, clock } = await start(agent);
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => notices(p).length === 1, { what: "the notice" });

    expect(p.rt.cliState("fake")).toMatchObject({ result: "needs_attention" });
    expect(notices(p)[0]).toContain("stopped working after an update");
    expect(notices(p)[0]).toContain("missing library");
    expect(p.rt.statusText()).toContain("Fake agent 1.1.0: needs attention.");

    // Nothing more is tried, and nothing more is said, however long it stays broken.
    await clock.advance(5 * DAY);
    expect(p.fake.updates).toBe(1);
    expect(notices(p)).toHaveLength(1);

    // Once the user has fixed it, the next check clears it and updating carries on.
    agent.state.installed = true;
    agent.state.problem = undefined;
    agent.state.onUpdate = () => ({ updated: false, detail: "Already up to date." });
    await clock.advance(DAY + HOUR);
    expect(p.rt.cliState("fake")).toMatchObject({ result: "up_to_date", attention: undefined });
    expect(p.fake.updates).toBe(2);
  });

  test("a CLI that loses its sign-in after an update needs attention too", async () => {
    const agent = cli("1.0.0");
    agent.state.onUpdate = () => {
      agent.state.loggedIn = false;
      agent.state.problem = "Fake agent is installed but not signed in.";
      return { updated: false, detail: "Already up to date." };
    };
    const { p, clock } = await start(agent);
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => notices(p).length === 1, { what: "the notice" });
    expect(p.rt.cliState("fake")?.attention).toContain("not signed in");
  });

  test("an update that fails is retried at the next interval, not in a storm", async () => {
    const agent = cli();
    agent.state.onUpdate = () => ({ updated: false, failed: true, detail: "network is down" });
    const { p, clock } = await start(agent);
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => p.fake.updates === 1);
    expect(p.rt.cliState("fake")).toMatchObject({ result: "failed" });
    await clock.advance(DAY / 2);
    expect(p.fake.updates).toBe(1);
    await clock.advance(DAY);
    expect(p.fake.updates).toBe(2);
    expect(notices(p)).toEqual([]);
  });

  test("an install managed by someone else is left alone, once, and not retried for that version", async () => {
    const agent = cli("1.0.0");
    agent.state.onUpdate = () => ({
      updated: false,
      failed: true,
      detail: "EACCES: permission denied, rename '/usr/local/lib/node_modules/agent'",
    });
    const { p, clock } = await start(agent);
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => p.fake.updates === 1);
    expect(p.rt.cliState("fake")).toMatchObject({
      result: "managed_externally",
      managedVersion: "1.0.0",
    });
    expect(p.rt.statusText()).toContain(
      "Fake agent 1.0.0: updating it needs administrator rights. Update it yourself.",
    );

    await clock.advance(10 * DAY);
    expect(p.fake.updates).toBe(1);
    expect(notices(p)).toEqual([]);

    // The user updated it themselves: that is recorded, and the next check looks again.
    agent.state.version = "1.0.5";
    const upgrade = agent.upgradesTo("1.0.6");
    agent.state.onUpdate = () =>
      agent.state.version === "1.0.5" ? upgrade() : { updated: false, detail: "Up to date." };
    await clock.advance(2 * DAY);
    expect(p.fake.updates).toBeGreaterThanOrEqual(2);
    expect(p.rt.cliVersionChanges("fake")).toMatchObject([
      { from: "1.0.0", to: "1.0.5", how: "outside" },
      { from: "1.0.5", to: "1.0.6", how: "update" },
    ]);
  });

  test("a package manager's own message also counts as managed", async () => {
    const agent = cli();
    agent.state.onUpdate = () => ({
      updated: false,
      detail: "This install is managed by Homebrew. Run: brew upgrade agent",
    });
    const { p, clock } = await start(agent);
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => p.rt.cliState("fake")?.result === "managed_externally");
    await clock.advance(5 * DAY);
    expect(p.fake.updates).toBe(1);
  });

  test("with agents.autoUpdate off it never updates, and updates again once it is turned on", async () => {
    const agent = cli();
    const { p, clock } = await start(agent, {
      config: { agents: { enabled: ["fake"], autoUpdate: false } },
    });
    await clock.advance(5 * DAY);
    expect(p.fake.updates).toBe(0);
    expect(p.rt.cliState("fake")).toBeUndefined();

    p.rt.config.update({ agents: { autoUpdate: true } }, "turned updates on");
    await clock.advance(DAY + HOUR);
    expect(p.fake.updates).toBe(1);
  });

  test("a CLI the user did not enable is not updated", async () => {
    const { p, clock } = await start(cli(), { config: { agents: { enabled: [] } } });
    await clock.advance(3 * DAY);
    expect(p.fake.updates).toBe(0);
  });

  test("checks repeat on agents.updateIntervalMs with jitter, and never early", async () => {
    const agent = cli();
    const { p, clock } = await start(agent, {
      config: { agents: { enabled: ["fake"], updateIntervalMs: 2 * HOUR } },
    });
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => p.fake.updates === 1);
    await clock.advance(10 * HOUR);
    await waitFor(() => p.fake.updates >= 5);
    const times = agent.state.updateTimes;
    const gaps = times.slice(1).map((at, i) => at - (times[i] as number));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(2 * HOUR * 0.9 - 1);
      expect(gap).toBeLessThanOrEqual(2 * HOUR * 1.1 + 1);
    }
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  test("versions and results survive a restart, and a quick restart does not check again at once", async () => {
    const agent = cli("1.0.0");
    agent.state.onUpdate = agent.upgradesTo("1.0.1");
    const { p, clock } = await start(agent);
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => p.fake.updates === 1);

    const again = await p.restart();
    expect(again.rt.cliVersionChanges("fake")).toMatchObject([{ from: "1.0.0", to: "1.0.1" }]);
    expect(again.rt.cliState("fake")).toMatchObject({ version: "1.0.1", result: "updated" });
    await clock.advance(UPDATE_START_DELAY_MS);
    expect(agent.state.updateTimes).toHaveLength(1);
    await clock.advance(10 * MINUTE);
    await waitFor(() => agent.state.updateTimes.length === 2, {
      what: "the check after a restart",
    });
  });

  test("agents_status says how keeping the CLI current is going", async () => {
    const { p, clock } = await start(cli("3.1.4"), {
      coordinator: async (turn) => {
        if (!ownerMessage(turn)) return "";
        return await turn.callTool("agents_status");
      },
    });
    await clock.advance(UPDATE_START_DELAY_MS);
    await waitFor(() => p.rt.cliState("fake"));
    p.owner.receive("how are my agents?");
    await waitFor(() => p.owner.texts("reply").length === 1);
    const status = JSON.parse(p.owner.texts("reply")[0] as string) as {
      agents: { agent: string; version: string; cliUpdate: string }[];
      autoUpdate: boolean;
    };
    expect(status.autoUpdate).toBe(true);
    expect(status.agents[0]).toMatchObject({ agent: "fake", version: "3.1.4" });
    expect(status.agents[0]?.cliUpdate).toMatch(/^Fake agent 3\.1\.4: up to date/);
  });
});

describe("Sessions after the CLI changed version", () => {
  test("a Session the new version cannot resume continues in a new Session from a checkpoint, and the Goal still finishes", async () => {
    const agent = cli("1.0.0");
    agent.state.onUpdate = agent.upgradesTo("1.1.0");
    const project = tempDir("project");
    const { p, clock } = await start(agent, {
      tieSessions: true,
      coordinator: goalCreatingCoordinator(project, brief(), async (turn) => {
        const questionId = workerQuestionId(turn);
        if (questionId) {
          await turn.callTool("ask_human", { questionId, question: "Blue or green?" });
          return "";
        }
        const text = ownerMessage(turn);
        if (!text) return "";
        const status = JSON.parse(await turn.callTool("status")) as {
          openQuestions: { id: string }[];
        };
        const open = status.openQuestions[0];
        if (open) await turn.callTool("answer_worker", { questionId: open.id, answer: text });
        return "Passing that on.";
      }),
      worker: async (turn) => {
        if (turn.turn === 1 && !turn.resumed) {
          await turn.callTool("ask_preston", { question: "Blue or green button?" });
          turn.message("Waiting for the colour.");
          return "Parked until I hear back.";
        }
        return reportingWorker(turn);
      },
    });

    p.owner.receive("go");
    await waitFor(() => p.rt.goals()[0]?.state === "waiting_for_user", { what: "the Run to park" });
    // Nothing is using the CLI now, so it is updated: its old Session can no longer be resumed.
    await advanceUntil(clock, () => p.fake.updates > 0, 15 * MINUTE, MINUTE);
    expect(agent.state.version).toBe("1.1.0");

    p.owner.receive("Blue");
    const goal = await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });

    expect(goal).toMatchObject({ state: "completed", outcome: "verified" });
    const runs = p.rt.runs(goal.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ state: "ended", endReason: "fresh_session" });
    const workers = p.fake.calls.filter((c) => c.role === "worker");
    // The resume that failed, then a new Session started from the Brief and a checkpoint.
    expect(workers[1]?.input.resumeSessionId).toBe(workers[0]?.sessionId);
    expect(workers[2]?.input.resumeSessionId).toBeUndefined();
    expect(workers[2]?.sessionId).not.toBe(workers[0]?.sessionId);
    expect(workers[2]?.input.prompt).toContain("Make the greeting page say hello");
    expect(workers[2]?.input.prompt).toContain("You are starting a new session");
    expect(goal.attempts.map((a) => a.tactic)).toEqual(["fresh_session"]);
  });

  test("the Coordinator carries on in a new Session when its old one cannot be resumed", async () => {
    const agent = cli("1.0.0");
    const { p, clock } = await start(agent, {
      tieSessions: true,
      coordinator: (turn) => `Reply ${turn.turn} to ${ownerMessage(turn)}`,
    });
    p.owner.receive("one");
    await waitFor(() => p.owner.texts("reply").length === 1);

    agent.state.version = "1.1.0"; // updated behind Preston's back
    await clock.advance(MINUTE);
    p.owner.receive("two");
    await waitFor(() => p.owner.texts("reply").length === 2);
    expect(p.owner.texts("reply")).toEqual(["Reply 1 to one", "Reply 1 to two"]);
    const coordinator = p.fake.calls.filter((c) => c.role === "coordinator");
    expect(coordinator.map((c) => c.input.resumeSessionId !== undefined)).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe("installs Preston must not touch", () => {
  test("package-manager locations are recognised", () => {
    expect(managedByPackageManager("/opt/homebrew/bin/claude")).toBe("installed with Homebrew");
    expect(managedByPackageManager("/usr/local/Cellar/codex/0.1.0/bin/codex")).toBe(
      "installed with Homebrew",
    );
    expect(managedByPackageManager("/usr/bin/codex")).toBe(
      "installed by your system's package manager",
    );
    expect(managedByPackageManager("/snap/bin/codex")).toBe("installed with Snap");
    expect(
      managedByPackageManager("C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe"),
    ).toBe("installed with winget");
    expect(managedByPackageManager("/Users/me/.local/bin/claude")).toBeUndefined();
    expect(managedByPackageManager("/Users/me/.nvm/versions/node/v22/bin/codex")).toBeUndefined();
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an install in a folder this user cannot write to is left to an administrator",
    () => {
      const root = tempDir("install");
      const bin = join(root, "bin");
      mkdirSync(bin);
      const exe = join(bin, "agent");
      // A file in a read-only folder (as with a root-owned npm prefix).
      const file = join(bin, "agent-file");
      writeFileSync(file, "x");
      onCleanup(() => chmodSync(bin, 0o755));
      expect(checkInstall(file)).toBeUndefined();
      chmodSync(bin, 0o555);
      expect(checkInstall(file)).toBe("installed where only an administrator can change it");
      expect(checkInstall(exe)).toBeUndefined(); // does not exist: nothing to judge
      expect(checkInstall(undefined)).toBeUndefined();
    },
  );
});
