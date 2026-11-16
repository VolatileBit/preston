import { expect } from "vitest";
import type { FakeScript } from "../../src/workers/fake/index.js";
import type { QuotaReading } from "../../src/workers/types.js";
import { expectVerified, onBranch } from "./support/assertions.js";
import { realAdapter } from "./support/providers.js";
import { smokeScenario } from "./support/scenario.js";
import { makeProject, startWorld } from "./support/world.js";

/**
 * Scenario 4a: forced quota pause and resume. A real account cannot be exhausted on purpose, so
 * two things are simulated, both through the thin wrapper around the real adapter (see
 * `metered.ts`): once the real Worker has done a first piece of work, its turn is interrupted and
 * a `quota_blocked` event with a reset time a few seconds ahead is reported in place of what
 * would follow, and the token-free quota read is a stand-in that says "blocked" until that time
 * and "available" after. Everything else is real: the Session, the resume and the second turn.
 */
smokeScenario("s4-forced-quota", ["claude", "codex"], async ({ provider }) => {
  const project = makeProject();
  const bucket = `${provider}:smoke-forced`;
  const resetsAt = { at: 0 };
  let reads = 0;
  let blockedOnce = false;
  const readQuota = async (): Promise<QuotaReading[]> => {
    reads++;
    const open = Date.now() >= resetsAt.at;
    return [
      {
        bucket,
        available: open,
        checkedAt: new Date().toISOString(),
        ...(open ? {} : { resetsAt: new Date(resetsAt.at).toISOString() }),
      },
    ];
  };

  // A scripted Coordinator (no model call): it only starts the Goal when told "go".
  const coordinator: FakeScript = async (turn) => {
    if (!/<preston-input kind="owner-message"[^>]*>\ngo\n/.test(turn.input.prompt)) return "";
    await turn.callTool("goal_create", {
      projectPath: project.dir,
      brief: {
        objective: "Create note.txt containing exactly 'quota test'",
        scope: "Only note.txt",
        acceptanceCriteria: ["note.txt contains exactly: quota test"],
        checks: [
          {
            name: "note.txt is right",
            command: `node -e "process.exit(require('fs').readFileSync('note.txt','utf8').trim()==='quota test'?0:1)"`,
          },
        ],
      },
    });
    return "Started.";
  };

  const world = await startWorld({
    scenario: "s4-forced-quota",
    provider,
    coordinator,
    config: {
      // Seconds instead of minutes, so the wait can be watched.
      quota: {
        recheckIntervalMs: 2_000,
        probeIntervalMs: 2_000,
        maxRecheckIntervalMs: 2_000,
        backoffFactor: 1,
        jitterRatio: 0,
        resetGraceMs: 500,
        resumeStaggerMs: 500,
      },
    },
    metering: {
      readQuota,
      // As a real usage limit does, cut the first turn short once the Worker has done a first
      // piece of real work (before it reports), and report the limit in place of what follows.
      rewrite: (turn, event) => {
        if (turn.role !== "worker" || turn.number !== 1 || blockedOnce) return undefined;
        const firstWorkDone =
          event.type === "activity" &&
          (event.kind === "tool_result" ||
            event.kind === "commandExecution_completed" ||
            event.kind === "fileChange_completed") &&
          !/preston/i.test(event.summary ?? "");
        if (!firstWorkDone) return undefined;
        blockedOnce = true;
        resetsAt.at = Date.now() + 15_000;
        return {
          stop: true,
          emit: [
            {
              type: "quota_blocked",
              at: event.at,
              bucket,
              kind: "usage_limit",
              resetsAt: new Date(resetsAt.at).toISOString(),
              detail: "forced by the smoke test",
            },
          ],
        };
      },
    },
  });
  const rt = world.daemon.runtime;
  world.say("go");

  // Waiting, not failed: the Goal is parked on its bucket, which is being monitored.
  const waiting = await world.waitForGoal((g) => g.state === "waiting_for_quota", 3 * 60_000);
  expect(waiting.endedAt).toBeNull();
  const run = rt.runs(waiting.id)[0];
  expect(run?.state).toBe("parked");
  expect(run?.quotaBucket).toBe(bucket);
  const sessionBefore = run?.sessionId;
  expect(sessionBefore).toBeTruthy();
  const blocked = rt.quota().find((b) => b.bucket === bucket);
  expect(blocked?.state).toBe("blocked");
  expect(blocked?.monitored).toBe(true);
  console.log(`waiting for quota on ${bucket}; Session ${sessionBefore}`);
  expect(world.owner.texts("outcome")).toEqual([]);

  // Rechecked with the token-free read, then resumed automatically in the same Session.
  const goal = await world.waitForGoal(undefined, 3 * 60_000);
  console.log(`Goal ended: ${goal.state}/${goal.outcome}; quota reads: ${reads}`);
  expectVerified(rt, goal);
  expect(reads).toBeGreaterThan(0);
  expect(rt.quota().find((b) => b.bucket === bucket)?.state).toBe("available");
  const workerTurns = world.agent.turnsOf("worker");
  expect(workerTurns).toHaveLength(2);
  expect(workerTurns[1]?.resumedFrom).toBe(sessionBefore);
  expect(workerTurns[1]?.sessionId).toBe(sessionBefore);
  expect(workerTurns[1]?.prompt).toMatch(/quota restored/i);
  expect(rt.runs(goal.id)).toHaveLength(1);
  expect(onBranch(project.dir, "main", "note.txt")?.trim()).toBe("quota test");
  // A wait of seconds is not worth a message: only the acknowledgement and the outcome.
  expect(world.owner.texts("notice")).toEqual([]);
});

/**
 * Scenario 4b: the real, token-free quota read of each provider (Claude `/usage`, Codex
 * `account/rateLimits/read`). Only records whether it works and what it returns, shape only.
 */
smokeScenario("s4-real-quota-read", ["claude", "codex"], async ({ provider }) => {
  const adapter = realAdapter(provider);
  expect(adapter.readQuota, `${provider} adapter has no readQuota`).toBeTypeOf("function");
  const started = Date.now();
  const readings = await adapter.readQuota?.();
  console.log(
    `${provider} readQuota() took ${Date.now() - started} ms: ${JSON.stringify(
      readings?.map((r) => ({
        bucket: r.bucket,
        available: r.available,
        usedPercent: r.usedPercent,
        resetsAt: r.resetsAt,
      })),
    )}`,
  );
  expect(Array.isArray(readings)).toBe(true);
  for (const reading of readings ?? []) {
    expect(reading.bucket).toMatch(new RegExp(`^${provider}:`));
    expect([true, false, "unknown"]).toContain(reading.available);
  }
});
