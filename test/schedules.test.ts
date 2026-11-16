import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { ManualClock } from "../src/clock.js";
import type { FakeScript } from "../src/workers/fake/index.js";
import {
  brief,
  node,
  type Preston,
  reportingWorker,
  startPreston,
  TEST_CONFIG,
  tempDir,
  waitFor,
} from "./support/harness.js";
import { teacher } from "./support/teach.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface HistoryRun {
  scheduledFor: string;
  source: string;
  state: string;
  reason: string | null;
  missedBefore: number;
  outcome: string | null;
  goal: { id: string; state: string } | null;
  standingOrders: string[];
}

const config = (schedules: Record<string, unknown> = {}) => ({ ...TEST_CONFIG, schedules });

const history = async (t: ReturnType<typeof teacher>, p: Preston, id: string) =>
  ((await t.call(p, "schedule_history", { id, limit: 50 })).runs as HistoryRun[]).reverse();

/** The run history straight from the scheduler, oldest first. */
const runsOf = (p: Preston, id: string) => p.rt.schedules.history(id, 50).reverse();

const ended = (p: Preston) => p.rt.goals().filter((g) => g.endedAt);

/** A Worker that waits until the test lets it finish. */
function gatedWorker() {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const script: FakeScript = async (turn) => {
    await gate;
    return reportingWorker(turn);
  };
  return { script, release: () => open() };
}

async function setup(options: {
  clock?: ManualClock;
  worker?: FakeScript;
  schedules?: Record<string, unknown>;
}) {
  const project = tempDir("project");
  const t = teacher(project);
  const p = await startPreston({
    clock: options.clock,
    scenario: { coordinator: t.coordinator, worker: options.worker ?? reportingWorker },
    config: config(options.schedules),
  });
  return { p, t, project };
}

describe("one-time schedules", () => {
  test("fires once at its time, starts one Goal, and reports only the outcome", async () => {
    const clock = new ManualClock(Date.parse("2026-11-16T09:00:00Z"));
    const { p, t, project } = await setup({ clock });

    const created = await t.call(p, "schedule_create", {
      name: "Friday check",
      at: "2026-11-16T11:00:00Z",
      timezone: "UTC",
      projectPath: project,
      brief: brief({ objective: "Check the site loads" }),
    });
    expect(created).toMatchObject({ enabled: true, nextRun: "2026-11-16T11:00:00.000Z" });
    expect(created.nextRunLocal).toBe("Mon 16 Nov, 11:00");

    await clock.advance(2 * HOUR - MINUTE);
    expect(p.rt.goals()).toHaveLength(0);

    await clock.advance(MINUTE);
    await waitFor(() => ended(p).length === 1, { what: "scheduled goal to finish" });
    await clock.advance(3 * DAY);

    expect(p.rt.goals()).toHaveLength(1);
    expect(p.owner.texts("ack")).toEqual([]);
    expect(p.owner.texts("outcome")).toHaveLength(1);
    expect(p.owner.texts("outcome")[0]).toContain("Done and verified: Check the site loads");
    const [run] = await history(t, p, created.id);
    expect(run).toMatchObject({
      scheduledFor: "2026-11-16T11:00:00.000Z",
      source: "scheduled",
      state: "done",
      outcome: "verified",
    });
    expect(run?.goal?.id).toBe(p.rt.goals()[0]?.id);
    const [schedule] = (await t.call(p, "schedule_list")).schedules;
    expect(schedule).toMatchObject({ enabled: false, nextRun: null });
  });

  test("rejects times in the past and unknown time zones in plain words", async () => {
    const { p, t, project } = await setup({});
    const base = { name: "x", projectPath: project, brief: brief() };
    expect(await t.refused(p, "schedule_create", { ...base, at: "2020-01-01T00:00:00Z" })).toMatch(
      /already passed/,
    );
    expect(
      await t.refused(p, "schedule_create", { ...base, every: "2h", timezone: "Mars/Olympus" }),
    ).toMatch(/not a time zone/);
    expect(await t.refused(p, "schedule_create", { ...base, cron: "61 * * * *" })).toMatch(
      /minute/,
    );
    expect(await t.refused(p, "schedule_create", base)).toMatch(/exactly one/);
  });
});

describe("recurring schedules", () => {
  test("a daily local time keeps its wall-clock hour across the clocks going back", async () => {
    const clock = new ManualClock(Date.parse("2026-10-23T12:00:00Z"));
    const { p, t, project } = await setup({ clock, schedules: { tickMs: HOUR } });
    const { id } = await t.call(p, "schedule_create", {
      name: "Morning report",
      cron: "0 9 * * *",
      timezone: "Europe/London",
      projectPath: project,
      brief: brief({ objective: "Write the morning report" }),
    });

    for (let day = 1; day <= 4; day++) {
      await clock.advance(DAY);
      await waitFor(() => ended(p).length === day, { what: `run ${day}` });
    }
    const runs = await history(t, p, id);
    expect(runs.map((r) => r.scheduledFor)).toEqual([
      "2026-10-24T08:00:00.000Z", // 09:00 BST
      "2026-10-25T09:00:00.000Z", // 09:00 GMT: the clocks went back at 01:00 UTC
      "2026-10-26T09:00:00.000Z",
      "2026-10-27T09:00:00.000Z",
    ]);
    expect(runs.every((r) => r.source === "scheduled")).toBe(true);
  });
});

describe("overlap", () => {
  test("skip (the default) drops a run while the previous one is still going", async () => {
    const clock = new ManualClock();
    const worker = gatedWorker();
    const { p, t, project } = await setup({ clock, worker: worker.script });
    const { id, overlap } = await t.call(p, "schedule_create", {
      name: "Frequent",
      every: "10m",
      projectPath: project,
      brief: brief(),
    });
    expect(overlap).toBe("skip");

    await clock.advance(10 * MINUTE);
    await waitFor(() => p.rt.goals().length === 1);
    await clock.advance(10 * MINUTE);
    expect(p.rt.goals()).toHaveLength(1);

    worker.release();
    await waitFor(() => ended(p).length === 1);
    await clock.advance(10 * MINUTE);
    await waitFor(() => p.rt.goals().length === 2);

    const runs = await history(t, p, id);
    expect(runs.map((r) => r.state)).toEqual([
      "done",
      "skipped",
      expect.stringMatching(/running|done/),
    ]);
    expect(runs[1]?.reason).toMatch(/previous run is still going/);
  });

  test("queue keeps one waiting run and starts it as soon as the previous one ends", async () => {
    const clock = new ManualClock();
    const worker = gatedWorker();
    const { p, t, project } = await setup({ clock, worker: worker.script });
    const { id } = await t.call(p, "schedule_create", {
      name: "Frequent",
      every: "10m",
      overlap: "queue",
      projectPath: project,
      brief: brief(),
    });

    await clock.advance(10 * MINUTE);
    await waitFor(() => p.rt.goals().length === 1);
    await clock.advance(20 * MINUTE); // two more due times while the first goal runs
    expect(p.rt.goals()).toHaveLength(1);
    expect((await history(t, p, id)).map((r) => r.state)).toEqual(["running", "queued", "skipped"]);

    worker.release();
    await waitFor(() => ended(p).length === 1);
    await clock.advance(MINUTE);
    await waitFor(() => p.rt.goals().length === 2, { what: "the queued run to start" });
    const runs = await history(t, p, id);
    expect(runs[1]).toMatchObject({ state: expect.stringMatching(/running|done/) });
    expect(runs[1]?.scheduledFor).toBe(new Date(Date.parse("2026-11-16T09:20:00Z")).toISOString());
    expect(runs[2]).toMatchObject({ state: "skipped", reason: "a run is already waiting" });
  });
});

describe("when Preston was not running", () => {
  const dailyAt9 = (project: string, extra: Record<string, unknown> = {}) => ({
    name: "Daily summary",
    cron: "0 9 * * *",
    timezone: "UTC",
    projectPath: project,
    brief: brief({ objective: "Summarise yesterday" }),
    ...extra,
  });

  test("catches up exactly once, tells the user once, and does not dispatch again after restarts", async () => {
    const clock = new ManualClock(Date.parse("2026-11-16T10:00:00Z"));
    const { p, t, project } = await setup({ clock, schedules: { catchUpWindowMs: 3 * DAY } });
    const { id } = await t.call(p, "schedule_create", dailyAt9(project));

    await p.stop();
    await clock.advance(2 * DAY + HOUR); // 17th and 18th 09:00 both passed; now 18th 11:00

    const back = await p.restart();
    await waitFor(() => ended(back).length === 1, { what: "caught-up goal" });

    const runs = await history(t, back, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      scheduledFor: "2026-11-18T09:00:00.000Z",
      source: "catch_up",
      missedBefore: 1,
    });
    expect(back.owner.texts("notice")).toEqual([
      `I wasn't running when "Daily summary" was due (Wed 18 Nov, 09:00), so I started it now.`,
    ]);

    const again = await back.restart();
    await clock.advance(5 * MINUTE);
    expect(again.rt.goals()).toHaveLength(1);
    expect(again.owner.texts("notice")).toEqual([]);
    const [schedule] = (await t.call(again, "schedule_list")).schedules;
    expect(schedule.nextRun).toBe("2026-11-19T09:00:00.000Z");
  });

  test("a run due while Preston was down is skipped when the schedule says to skip", async () => {
    const clock = new ManualClock(Date.parse("2026-11-16T10:00:00Z"));
    const { p, t, project } = await setup({ clock });
    const { id } = await t.call(p, "schedule_create", dailyAt9(project, { missedRun: "skip" }));
    await p.stop();
    await clock.advance(DAY + HOUR);

    const back = await p.restart();
    await clock.advance(MINUTE);
    expect(back.rt.goals()).toHaveLength(0);
    const runs = await history(t, back, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "skipped", reason: expect.stringMatching(/missed/) });
    expect(back.owner.texts("notice")).toEqual([]);
    expect((await t.call(back, "schedule_list")).schedules[0].nextRun).toBe(
      "2026-11-18T09:00:00.000Z",
    );
  });

  test("a run missed by more than the catch-up window is not caught up", async () => {
    const clock = new ManualClock(Date.parse("2026-11-16T10:00:00Z"));
    const { p, t, project } = await setup({ clock, schedules: { catchUpWindowMs: HOUR } });
    const { id } = await t.call(p, "schedule_create", dailyAt9(project));
    await p.stop();
    await clock.advance(DAY + 3 * HOUR); // 12:00 on the 17th: due at 09:00, three hours ago

    const back = await p.restart();
    await clock.advance(MINUTE);
    expect(back.rt.goals()).toHaveLength(0);
    expect((await history(t, back, id))[0]).toMatchObject({
      state: "skipped",
      reason: "missed by more than the catch-up window",
    });
  });

  test("a due time that already has a run key is never dispatched twice", async () => {
    const clock = new ManualClock(Date.parse("2026-11-16T10:00:00Z"));
    const { p, t, project } = await setup({ clock });
    const { id } = await t.call(p, "schedule_create", dailyAt9(project));
    await clock.advance(23 * HOUR);
    await waitFor(() => ended(p).length === 1);

    // Rewind the stored next run, as if Preston had stopped before recording it.
    const db = new DatabaseSync(join(p.home, "preston.db"));
    db.prepare("UPDATE schedules SET next_run = :at WHERE id = :id").run({
      at: "2026-11-17T09:00:00.000Z",
      id,
    });
    db.close();
    const again = await p.restart();
    await clock.advance(5 * MINUTE);

    expect(again.rt.goals()).toHaveLength(1);
    expect(await history(t, again, id)).toHaveLength(1);
    expect((await t.call(again, "schedule_list")).schedules[0].nextRun).toBe(
      "2026-11-18T09:00:00.000Z",
    );
  });
});

describe("script-only jobs", () => {
  test("a passing check starts nothing; a failing one starts a Goal with the failure attached", async () => {
    const clock = new ManualClock();
    const { p, t, project } = await setup({ clock });
    const { id } = await t.call(p, "schedule_create", {
      name: "Build is healthy",
      every: "1h",
      projectPath: project,
      check: {
        name: "no broken marker",
        command: node("process.exit(require('fs').existsSync('broken') ? 3 : 0)"),
      },
      onFailure: "goal",
      brief: brief({
        objective: "Find out why the build check fails and fix it",
        scope: "The build",
      }),
    });

    await clock.advance(HOUR);
    await waitFor(() => runsOf(p, id).some((r) => r.state === "passed"));
    expect(p.rt.goals()).toHaveLength(0);
    expect(p.fake.calls.filter((c) => c.role === "worker")).toHaveLength(0);

    writeFileSync(join(project, "broken"), "x");
    await clock.advance(HOUR);
    await waitFor(() => ended(p).length === 1, { what: "the goal started by the failing check" });
    await clock.advance(MINUTE); // the next look at the clock settles the run

    const runs = await history(t, p, id);
    expect(runs.map((r) => r.state)).toEqual(["passed", "done"]);
    const worker = p.fake.calls.find((c) => c.role === "worker");
    expect(worker?.input.prompt).toContain("exited with code 3 (expected 0)");
    expect(p.owner.texts("ack")).toEqual([]);
  });

  test("honours the expected exit code, and can just notify instead of starting a Goal", async () => {
    const clock = new ManualClock();
    const { p, t, project } = await setup({ clock });
    const { id } = await t.call(p, "schedule_create", {
      name: "Disk check",
      every: "1h",
      projectPath: project,
      check: { name: "disk", command: node("process.exit(2)"), expectedExitCode: 2 },
      onFailure: "notify",
    });
    await clock.advance(HOUR);
    await waitFor(() => runsOf(p, id).some((r) => r.state === "passed"));
    expect(p.owner.texts("notice")).toEqual([]);

    await t.call(p, "schedule_update", {
      id,
      check: {
        name: "disk",
        command: node("console.log('full'); process.exit(1)"),
        expectedExitCode: 2,
      },
      onFailure: "notify",
    });
    await clock.advance(HOUR);
    await waitFor(() => p.owner.texts("notice").length === 1, { what: "failure notice" });
    expect(p.owner.texts("notice")[0]).toContain('"Disk check": The check "disk"');
    expect(p.owner.texts("notice")[0]).toContain("exited with code 1 (expected 2)");
    expect(p.owner.texts("notice")[0]).toContain("full");
    expect(p.rt.goals()).toHaveLength(0);
    expect((await history(t, p, id)).at(-1)).toMatchObject({ state: "failed" });
  });

  test("needs a Brief when a failure should start a Goal", async () => {
    const { p, t, project } = await setup({});
    expect(
      await t.refused(p, "schedule_create", {
        name: "x",
        every: "1h",
        projectPath: project,
        check: { command: "true" },
        onFailure: "goal",
      }),
    ).toMatch(/needs a Brief/);
  });
});

describe("managing schedules", () => {
  test("pause stops runs, resume does not catch up the paused time", async () => {
    const clock = new ManualClock();
    const { p, t, project } = await setup({ clock });
    const { id } = await t.call(p, "schedule_create", {
      name: "Hourly",
      every: "1h",
      projectPath: project,
      brief: brief(),
    });
    const paused = await t.call(p, "schedule_pause", { id });
    expect(paused).toMatchObject({ enabled: false, nextRun: null });
    await clock.advance(5 * HOUR);
    expect(p.rt.goals()).toHaveLength(0);

    const resumed = await t.call(p, "schedule_resume", { id });
    expect(resumed.enabled).toBe(true);
    expect(Date.parse(resumed.nextRun)).toBeGreaterThan(clock.now());
    await clock.advance(MINUTE);
    expect(p.rt.goals()).toHaveLength(0);
    await clock.advance(HOUR);
    await waitFor(() => p.rt.goals().length === 1);
  });

  test("run_now starts a Goal at once without moving the next run, and follows the overlap rule", async () => {
    const clock = new ManualClock();
    const worker = gatedWorker();
    const { p, t, project } = await setup({ clock, worker: worker.script });
    const { id, nextRun } = await t.call(p, "schedule_create", {
      name: "On demand",
      cron: "0 3 * * *",
      timezone: "UTC",
      projectPath: project,
      brief: brief(),
    });
    expect(await t.call(p, "schedule_run_now", { id })).toMatchObject({ result: "started" });
    await waitFor(() => p.rt.goals().length === 1);
    expect(await t.call(p, "schedule_run_now", { id })).toMatchObject({
      result: "skipped",
      reason: "the previous run is still going",
    });
    expect((await t.call(p, "schedule_list")).schedules[0].nextRun).toBe(nextRun);
    worker.release();
    await waitFor(() => ended(p).length === 1);
    expect((await history(t, p, id)).map((r) => r.source)).toEqual(["manual", "manual"]);
  });

  test("update retimes from now, and delete removes the schedule but not its Goals", async () => {
    const clock = new ManualClock();
    const { p, t, project } = await setup({ clock });
    const { id } = await t.call(p, "schedule_create", {
      name: "Hourly",
      every: "1h",
      projectPath: project,
      brief: brief(),
    });
    const updated = await t.call(p, "schedule_update", {
      id,
      name: "Daily",
      cron: "0 18 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(updated).toMatchObject({
      name: "Daily",
      timezone: "Asia/Shanghai",
      nextRun: "2026-11-16T10:00:00.000Z",
    });
    await t.call(p, "schedule_run_now", { id });
    await waitFor(() => ended(p).length === 1);
    await t.call(p, "schedule_delete", { id });
    expect((await t.call(p, "schedule_list")).schedules).toEqual([]);
    expect(p.rt.goals()).toHaveLength(1);
    expect(await t.refused(p, "schedule_history", { id })).toMatch(/no schedule/);
  });

  test("standing orders scoped to a schedule reach only its Goals, and are referenced by the run", async () => {
    const clock = new ManualClock();
    const { p, t, project } = await setup({ clock });
    const { id } = await t.call(p, "schedule_create", {
      name: "Nightly",
      every: "1h",
      projectPath: project,
      brief: brief({ objective: "Nightly tidy" }),
    });
    const order = await t.call(p, "standing_order_create", {
      title: "Nightly rules",
      scope: `schedule:${id}`,
      constraints: ["Never touch the main branch overnight."],
    });
    await t.call(p, "schedule_run_now", { id });
    await waitFor(() => ended(p).length === 1);
    await t.call(p, "goal_create", {
      projectPath: project,
      brief: brief({ objective: "Ordinary" }),
    });
    await waitFor(() => ended(p).length === 2);

    const prompts = p.fake.calls
      .filter((c) => c.role === "worker")
      .map((c) => c.input.appendSystemPrompt ?? "");
    expect(prompts[0]).toContain("Never touch the main branch overnight");
    expect(prompts[1]).not.toContain("Never touch the main branch");
    expect((await history(t, p, id))[0]?.standingOrders).toContain(order.id);
  });

  test("a Goal that cannot start is reported once, and the schedule keeps its timetable", async () => {
    const clock = new ManualClock();
    const { p, t, project } = await setup({ clock });
    const { id } = await t.call(p, "schedule_create", {
      name: "Hourly",
      every: "1h",
      projectPath: project,
      brief: brief(),
    });
    await p.rt.config.update({ agents: { enabled: [] } }, "test: no agent");
    await clock.advance(HOUR);
    await waitFor(() => p.owner.texts("notice").length === 1);
    expect(p.owner.texts("notice")[0]).toContain(`I couldn't start the scheduled job "Hourly"`);
    expect((await history(t, p, id))[0]).toMatchObject({ state: "failed" });
    expect((await t.call(p, "schedule_list")).schedules[0].nextRun).toBe(
      "2026-11-16T11:00:00.000Z",
    );
  });
});
