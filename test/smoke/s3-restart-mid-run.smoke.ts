import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { onBranch, prestonBranches, worktreesIn } from "./support/assertions.js";
import { startChildDaemon } from "./support/child-daemon.js";
import { record } from "./support/ledger.js";
import { isAlive, processTable, sleep, treeOf } from "./support/processes.js";
import { CHEAPEST } from "./support/providers.js";
import { smokeScenario } from "./support/scenario.js";
import { makeProject, poll, tempDir } from "./support/world.js";

/**
 * Scenario 3: Preston is killed (SIGKILL, a real child process) while a real Worker Run is in
 * flight. A new daemon on the same home must reconcile: end the orphaned agent process, resume
 * the same native Session, finish the Goal without redoing finished work, and leave no agent
 * processes behind.
 */
smokeScenario("s3-restart-mid-run", ["claude", "codex"], async ({ provider, startedAt }) => {
  const project = makeProject();
  const home = tempDir("home");
  const { model, effort } = CHEAPEST[provider];
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      agents: { enabled: [provider], autoUpdate: false },
      coordinator: { agent: provider, model, effort },
      workers: { model, effort },
      verification: { checkTimeoutMs: 120_000 },
      setup: { complete: true },
    }),
    { mode: 0o600 },
  );

  const first = await startChildDaemon(home);
  // Everything that ever ran below the daemon, so that a leftover can be told from other agents.
  const seen = new Map<number, string>();
  const watch = (daemonPid: number) => {
    const timer = setInterval(() => {
      for (const row of treeOf(daemonPid)) {
        if (row.pid !== daemonPid) seen.set(row.pid, row.command);
      }
    }, 500);
    return () => clearInterval(timer);
  };
  let stopWatching = watch(first.pid);

  try {
    await first.send(
      `I'm in a hurry, no questions please, just start. In the folder ${project.dir} the Worker must do ` +
        `these steps in this order and put them in the Brief's objective: (1) create part1.txt containing ` +
        `exactly "one"; (2) run the shell command \`sleep 25\`; (3) create part2.txt containing exactly "two". ` +
        `The check is: node -e "const f=require('fs');process.exit(f.readFileSync('part1.txt','utf8').trim()==='one'&&f.readFileSync('part2.txt','utf8').trim()==='two'?0:1)"`,
    );

    // Wait until the Worker has finished step 1, so the kill lands in the middle of the Run.
    const goalId = await poll(
      () => first.query<{ id: string }>("SELECT id FROM goals")[0]?.id,
      90_000,
      "a Goal to be created",
      () => first.messages.map((m) => m.text).join(" || "),
    );
    const part1 = await poll(
      () =>
        worktreesIn(home)
          .map((w) => join(w, "part1.txt"))
          .find((f) => existsSync(f)),
      180_000,
      "the Worker to write part1.txt",
    );
    await poll(
      () => first.messages.some((m) => m.kind === "reply"),
      60_000,
      "the Coordinator's reply",
    );
    const mtimeBefore = statSync(part1).mtimeMs;
    const runBefore = first.query<{ id: string; session_id: string; turns: number; state: string }>(
      "SELECT id, session_id, turns, state FROM runs WHERE goal_id = :goal",
      { goal: goalId },
    )[0];
    const tracked = first.query<{ pid: number; owner: string }>(
      "SELECT pid, owner FROM agent_processes",
    );
    const agentPids = tracked.map((t) => t.pid);
    console.log(
      `before the kill: run ${runBefore?.id} state=${runBefore?.state} turns=${runBefore?.turns} session=${runBefore?.session_id}; tracked agent pids ${agentPids.join(",")}`,
    );
    expect(runBefore?.session_id).toBeTruthy();
    expect(agentPids.length).toBeGreaterThan(0);
    const treeBefore = treeOf(first.pid);
    console.log(`process tree below the daemon: ${treeBefore.length - 1} processes`);

    await first.kill9();
    stopWatching();
    await sleep(500);
    const survivors = [...seen.keys()].filter(isAlive);
    console.log(
      `after SIGKILL of the daemon, ${survivors.length} of ${seen.size} processes below it are still alive: ${survivors
        .map((p) => `${p}:${(seen.get(p) ?? "").slice(0, 60)}`)
        .join(" | ")}`,
    );

    // A new daemon on the same home: it must clean up and finish the Goal.
    const second = await startChildDaemon(home);
    stopWatching = watch(second.pid);
    try {
      await poll(
        () => {
          const g = second.query<{ state: string }>("SELECT state FROM goals WHERE id = :id", {
            id: goalId,
          })[0];
          return g && ["completed", "blocked", "failed", "cancelled"].includes(g.state)
            ? g
            : undefined;
        },
        6 * 60_000,
        "the Goal to finish after the restart",
        () => JSON.stringify(second.query("SELECT id, state, state_detail FROM goals")),
      );
      const goal = second.query<{ state: string; outcome: string | null; detail: string | null }>(
        "SELECT state, outcome, state_detail AS detail FROM goals WHERE id = :id",
        { id: goalId },
      )[0];
      console.log(`Goal ended: ${goal?.state}/${goal?.outcome} ${goal?.detail ?? ""}`);
      expect(goal?.state).toBe("completed");
      expect(goal?.outcome).toBe("verified");

      // The same Run and native Session carried on; the old agent process was dealt with.
      const runs = second.query<{
        id: string;
        session_id: string;
        turns: number;
        recoveries: number;
      }>("SELECT id, session_id, turns, recoveries FROM runs WHERE goal_id = :goal", {
        goal: goalId,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.session_id).toBe(runBefore?.session_id);
      expect(runs[0]?.turns).toBeGreaterThanOrEqual(2);
      for (const pid of agentPids)
        expect(isAlive(pid), `old agent process ${pid} still alive`).toBe(false);

      // Finished work was not redone: the resumed turn never wrote part1.txt again.
      const transcriptDir = join(home, "transcripts", runs[0]?.id ?? "");
      const turn2 = readdirSync(transcriptDir)
        .filter((f) => f.startsWith("turn-") && f !== "turn-1.log")
        .map((f) => readFileSync(join(transcriptDir, f), "utf8"))
        .join("\n");
      const rewrites = turn2
        .split("\n")
        .filter(
          (line) =>
            /"name":"(Write|Edit)"|"type":"fileChange"/.test(line) && line.includes("part1.txt"),
        );
      console.log(
        `writes of part1.txt after the restart: ${rewrites.length}; mtime before kill ${mtimeBefore}`,
      );
      expect(rewrites).toHaveLength(0);

      expect(onBranch(project.dir, "main", "part1.txt")?.trim()).toBe("one");
      expect(onBranch(project.dir, "main", "part2.txt")?.trim()).toBe("two");
      await poll(() => worktreesIn(home).length === 0, 20_000, "the worktree to be removed");
      expect(prestonBranches(project.dir)).toEqual([]);

      // No duplicated side effects: the acknowledgement went out once, before the kill.
      const all = [...first.messages, ...second.messages];
      expect(all.filter((m) => m.kind === "ack")).toHaveLength(1);
      expect(second.messages.some((m) => m.kind === "outcome" && /verified/i.test(m.text))).toBe(
        true,
      );

      // Ledger entries for the child daemon's turns (it is not metered in this process).
      const turns = second.query<{ turns: number }>(
        "SELECT turns FROM runs WHERE goal_id = :goal",
        { goal: goalId },
      );
      const coordinatorTurns = existsSync(join(home, "transcripts", "coordinator"))
        ? readdirSync(join(home, "transcripts", "coordinator")).length
        : 0;
      for (let i = 0; i < coordinatorTurns; i++) {
        record({
          kind: "turn",
          scenario: "s3-restart-mid-run",
          provider,
          role: "coordinator",
          wallMs: 0,
          end: "completed",
        });
      }
      for (let i = 0; i < (turns[0]?.turns ?? 0); i++) {
        record({
          kind: "turn",
          scenario: "s3-restart-mid-run",
          provider,
          role: "worker",
          wallMs: 0,
          end: "completed",
        });
      }
    } finally {
      await second.shutdown();
    }

    // After an orderly shutdown nothing the daemons started is left running.
    await sleep(1000);
    const leftovers = [...seen.keys()].filter(isAlive);
    console.log(`processes still alive at the end: ${leftovers.length}`);
    expect(
      leftovers.map((p) => `${p}:${(seen.get(p) ?? "").slice(0, 80)}`),
      "orphan agent processes remain",
    ).toEqual([]);
    const stray = processTable().filter((r) => r.command.includes(home));
    expect(stray.map((r) => r.command.slice(0, 120))).toEqual([]);
  } finally {
    stopWatching();
    void startedAt;
  }
});
