import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ManualClock } from "../src/clock.js";
import { GoalStore } from "../src/goals/store.js";
import { SearchIndex } from "../src/memory/index.js";
import { Memory } from "../src/memory/service.js";
import { openDatabase } from "../src/store/db.js";
import { reportingWorker, startPreston, TEST_CONFIG, tempDir, waitFor } from "./support/harness.js";
import { teacher } from "./support/teach.js";

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

function memoryAt(dir: string, db = openDatabase(":memory:"), contextChars = 2_000) {
  const clock = new ManualClock();
  const memory = new Memory({
    dir,
    db,
    clock,
    log: silent,
    goals: new GoalStore(db, clock),
    settings: () => ({ contextChars }),
  });
  memory.init();
  return { memory, db, clock };
}

describe("memory service", () => {
  test("saves a fact to USER.md with provenance, finds it again, and never stores it twice", async () => {
    const dir = tempDir("memory");
    const { memory } = memoryAt(dir);

    const first = await memory.upsert({ text: "I prefer short replies.", via: "terminal" });
    const again = await memory.upsert({ text: "  i PREFER short replies  " });
    expect(first.action).toBe("created");
    expect(again).toMatchObject({ action: "unchanged" });
    expect(again.entry.id).toBe(first.entry.id);

    const file = readFileSync(join(dir, "USER.md"), "utf8");
    expect(file.match(/short replies/g)).toHaveLength(1);
    expect(file).toContain(`${first.entry.id}`);
    expect(file).toContain('"source":"user"');
    expect(file).toContain('"via":"terminal"');

    expect(memory.search("replies")[0]).toMatchObject({
      kind: "memory",
      id: first.entry.id,
      scope: "global",
      text: "I prefer short replies.",
    });
  });

  test("a new value for the same key replaces the old one and bumps the version", async () => {
    const { memory } = memoryAt(tempDir("memory"));
    const a = await memory.upsert({ text: "My editor is Vim.", key: "editor" });
    const b = await memory.upsert({ text: "My editor is Zed.", key: "editor" });
    expect(b.action).toBe("updated");
    expect(b.entry).toMatchObject({ id: a.entry.id, version: 2 });
    expect(memory.search("editor")).toHaveLength(1);
    expect(memory.search("Vim")).toHaveLength(0);
    await expect(memory.upsert({ text: "x", id: "m-0000000000" })).rejects.toThrow(/no memory/);
  });

  test("removing forgets it completely", async () => {
    const dir = tempDir("memory");
    const { memory } = memoryAt(dir);
    const { entry } = await memory.upsert({ text: "My dog is called Biscuit." });
    expect(await memory.remove(entry.id)).toBe(true);
    expect(await memory.remove(entry.id)).toBe(false);
    expect(readFileSync(join(dir, "USER.md"), "utf8")).not.toContain("Biscuit");
    expect(memory.search("Biscuit")).toEqual([]);
  });

  test("refuses secrets and credential-shaped text", async () => {
    const dir = tempDir("memory");
    const { memory } = memoryAt(dir);
    for (const text of [
      "My OpenAI key is sk-abcdefghijklmnopqrstuvwxyz123456",
      "password: hunter2hunter2",
      "token is ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "-----BEGIN RSA PRIVATE KEY-----",
      "Authorization: Bearer abcdefghijklmnop1234567890",
      "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gH3jK5mN7p",
    ]) {
      await expect(memory.upsert({ text })).rejects.toThrow(/password or access key/);
    }
    expect(existsSync(join(dir, "USER.md"))).toBe(false);
    await memory.upsert({ text: "I like passwords to be long." });
  });

  test("refuses a secret Preston itself knows, even when it has no recognisable shape", async () => {
    const db = openDatabase(":memory:");
    const clock = new ManualClock();
    const memory = new Memory({
      dir: tempDir("memory"),
      db,
      clock,
      log: silent,
      goals: new GoalStore(db, clock),
      isKnownSecret: (text) => text.includes("correct-horse-battery"),
      settings: () => ({ contextChars: 2_000 }),
    });
    memory.init();
    await expect(memory.upsert({ text: "The wifi is correct-horse-battery" })).rejects.toThrow(
      /access key/,
    );
  });

  test("concurrent writes in one process and across two instances never lose a fact", async () => {
    const dir = tempDir("memory");
    const db = openDatabase(":memory:");
    const a = memoryAt(dir, db).memory;
    const b = memoryAt(dir, db).memory; // another writer on the same files
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 ? a : b).upsert({ text: `Fact number ${i} about colours` }),
      ),
    );
    const file = readFileSync(join(dir, "USER.md"), "utf8");
    for (let i = 0; i < 40; i++) expect(file).toContain(`Fact number ${i} about`);
    expect(file.match(/^- /gm)).toHaveLength(40);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp") || f === ".lock")).toEqual([]);
    expect(a.search("colours", { limit: 25 })).toHaveLength(25);
  });

  test("picks up facts typed into the file by hand", async () => {
    const dir = tempDir("memory");
    const { memory } = memoryAt(dir);
    await memory.upsert({ text: "I live in Lisbon." });
    appendFileSync(join(dir, "USER.md"), "- I am allergic to peanuts\n");
    expect(memory.search("peanuts")).toHaveLength(1);
    await waitFor(() =>
      /allergic to peanuts <!-- m-/.test(readFileSync(join(dir, "USER.md"), "utf8")),
    );
    expect(memory.search("Lisbon")).toHaveLength(1);
  });

  test("keeps Project facts apart from global ones", async () => {
    const dir = tempDir("memory");
    const project = tempDir("site");
    const { memory } = memoryAt(dir);
    await memory.upsert({
      text: "The staging site is staging.example.test",
      scope: `project:${project}`,
    });
    await memory.upsert({ text: "I prefer British spelling." });
    expect(memory.search("staging", { scope: "global" })).toHaveLength(0);
    expect(memory.search("staging", { scope: `project:${project}` })).toHaveLength(1);
    expect(readdirSync(join(dir, "projects"))).toHaveLength(1);
    expect(memory.contextBlock()).toContain("British spelling");
    expect(memory.contextBlock()).not.toContain("staging");
  });

  test("searches Chinese text and falls back to substring matching without FTS5", async () => {
    const { memory, db } = memoryAt(tempDir("memory"));
    await memory.upsert({ text: "我喜欢简短的回复" });
    await memory.upsert({ text: "Reports go to the finance team on Fridays." });
    expect(memory.usesFts).toBe(true);
    expect(memory.search("简短")).toHaveLength(1);
    expect(memory.search("finan")).toHaveLength(1); // prefix match

    // A SQLite without FTS5 never initialises the FTS table: substring search takes over.
    const plain = new SearchIndex(db);
    expect(plain.usesFts).toBe(false);
    const hits = plain.search("回复 friday", { kinds: ["memory"], limit: 5 });
    expect(hits.map((h) => h.text).sort()).toEqual([
      "Reports go to the finance team on Fridays.",
      "我喜欢简短的回复",
    ]);
  });
});

describe("memory in a running Preston", () => {
  test("the Coordinator's 'what you know about the user' block is stable until memory changes", async () => {
    const project = tempDir("project");
    const t = teacher(project);
    const p = await startPreston({ scenario: { coordinator: t.coordinator } });

    const saved = await t.call(p, "memory_upsert", { text: "Prefers very short replies." });
    expect(saved).toMatchObject({ action: "created", version: 1, scope: "global" });
    await t.call(p, "status");
    await t.call(p, "status");

    const prompts = p.fake.calls
      .filter((c) => c.role === "coordinator")
      .map((c) => c.input.appendSystemPrompt ?? "");
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).not.toContain("What you know about the user");
    expect(prompts[1]).toContain("- Prefers very short replies.");
    expect(prompts[2]).toBe(prompts[1]);

    await t.call(p, "memory_upsert", { text: "Works in the Europe/Lisbon time zone." });
    await t.call(p, "status");
    const last = p.fake.calls.filter((c) => c.role === "coordinator").at(-1);
    expect(last?.input.appendSystemPrompt).toContain("Europe/Lisbon");
  });

  test("the block is capped, keeping the newest facts", async () => {
    const t = teacher(tempDir("project"));
    const p = await startPreston({
      scenario: { coordinator: t.coordinator },
      config: { ...TEST_CONFIG, memory: { contextChars: 90 } },
    });
    for (const n of ["one", "two", "three", "four"]) {
      await t.call(p, "memory_upsert", { text: `The word of the day is ${n}.` });
    }
    const block = p.rt.memory.contextBlock();
    expect(block).toContain("four");
    expect(block).not.toContain("is one.");
    expect(block).toContain("More is saved");
  });

  test("memory survives a restart, and summaries of finished Goals are searchable", async () => {
    const project = tempDir("project");
    const t = teacher(project);
    const p = await startPreston({
      scenario: { coordinator: t.coordinator, worker: reportingWorker },
    });
    await t.call(p, "memory_upsert", { text: "I deploy with Fly.io.", key: "hosting" });
    const { goalId } = await t.call(p, "goal_create", {
      projectPath: project,
      brief: {
        objective: "Make the greeting page say hello",
        checks: [{ name: "ok", command: 'node -e "process.exit(0)"' }],
      },
    });
    await waitFor(() => p.rt.goal(goalId)?.endedAt);

    const restarted = await p.restart();
    const memory = await t.call(restarted, "memory_search", {
      query: "fly hosting",
      kinds: "memory",
    });
    expect(memory.results).toHaveLength(1);
    expect(memory.results[0].text).toBe("I deploy with Fly.io.");

    const goals = await t.call(restarted, "memory_search", { query: "greeting", kinds: "goals" });
    expect(goals.results).toHaveLength(1);
    expect(goals.results[0]).toMatchObject({ kind: "goal", id: goalId });
    expect(goals.results[0].text).toContain("(verified)");
    expect(goals.results[0].text).toContain("Implemented the greeting.");
    expect(goals.results[0].details).toMatchObject({
      goalId,
      outcome: "verified",
      projectPath: project,
    });
    expect(goals.results[0].details.links.transcripts).toHaveLength(1);
  });

  test("the Coordinator refuses to remember secrets", async () => {
    const t = teacher(tempDir("project"));
    const p = await startPreston({ scenario: { coordinator: t.coordinator } });
    const reason = await t.refused(p, "memory_upsert", {
      text: "My token is xoxb-1234567890-abcdefghijkl",
    });
    expect(reason).toContain("access key");
    expect(p.rt.memory.search("")).toEqual([]);
  });
});
