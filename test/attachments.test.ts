import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeChannel } from "../src/channels/fake/index.js";
import { TerminalChannel } from "../src/channels/terminal.js";
import { ManualClock } from "../src/clock.js";
import type { FakeTurn } from "../src/workers/fake/index.js";
import {
  finishedGoal,
  goalCreatingCoordinator,
  ownerMessage,
  reportingWorker,
  startPreston,
  tempDir,
  waitFor,
} from "./support/harness.js";

function folderWith(name: string, content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "preston-files-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return { dir, path };
}

/** A Coordinator that runs `send_file` with the JSON the owner wrote. */
const fileSender = (results: string[]) => async (turn: FakeTurn) => {
  const text = ownerMessage(turn);
  if (!text) return "";
  try {
    results.push(await turn.callTool("send_file", JSON.parse(text)));
  } catch (err) {
    results.push(`error: ${(err as Error).message}`);
  }
  return "ok";
};

describe("send_file", () => {
  test("queues the file to the conversation being answered, with the caption", async () => {
    const { path } = folderWith("chart.png", "PNG");
    const results: string[] = [];
    const channel = new FakeChannel();
    const p = await startPreston({
      channels: [channel],
      scenario: { coordinator: fileSender(results) },
    });

    channel.receive(JSON.stringify({ paths: [path], caption: "Here you go" }));
    await waitFor(() => channel.sent.some((m) => m.files), { what: "the file to be sent" });

    const sent = channel.sent.find((m) => m.files);
    expect(sent).toMatchObject({
      kind: "reply",
      text: "Here you go",
      files: [{ path, name: "chart.png" }],
    });
    expect(JSON.parse(results[0] as string)).toEqual({ queued: ["chart.png"] });
    expect(p.rt.goals()).toEqual([]);
  });

  test("any file on the computer can be sent, but only when the owner asked", async () => {
    const { path } = folderWith("notes.txt", "private");
    const results: string[] = [];
    const channel = new FakeChannel();
    await startPreston({ channels: [channel], scenario: { coordinator: fileSender(results) } });
    // A stranger's message never reaches the Coordinator, so nothing is sent for it.
    channel.receive(JSON.stringify({ paths: [path] }), { owner: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(results).toEqual([]);
    expect(channel.sent.some((m) => m.files)).toBe(false);
  });

  test("a missing file, a folder and an oversized file are explained, not queued", async () => {
    const { dir, path: big } = folderWith("big.bin", "x".repeat(2_000));
    const results: string[] = [];
    const channel = new FakeChannel({ maxFileBytes: 1_000 });
    await startPreston({ channels: [channel], scenario: { coordinator: fileSender(results) } });

    channel.receive(JSON.stringify({ paths: [join(dir, "nope.png")] }));
    channel.receive(JSON.stringify({ paths: [dir] }));
    channel.receive(JSON.stringify({ paths: [big] }));
    await waitFor(() => results.length === 3, { what: "three results" });

    expect(results[0]).toMatch(/^error: There is no file at .*nope\.png\.$/);
    expect(results[1]).toMatch(/^error: .* is not a file\.$/);
    expect(results[2]).toMatch(/^error: big\.bin is 2 KB, over the 1000 B this chat accepts/);
    expect(channel.sent.some((m) => m.files)).toBe(false);
  });

  test("the files survive in the outbox until the Channel is connected", async () => {
    const { path } = folderWith("photo.jpg", "JPG");
    const results: string[] = [];
    const channel = new FakeChannel();
    await startPreston({ channels: [channel], scenario: { coordinator: fileSender(results) } });
    channel.failNext(1);
    channel.receive(JSON.stringify({ paths: [path] }));
    // Real time: one second of backoff, plus whatever a busy machine adds.
    await waitFor(() => channel.sent.some((m) => m.files), {
      what: "the retried delivery",
      timeoutMs: 25_000,
    });
    expect(channel.attempts).toBeGreaterThanOrEqual(2);
  });
});

describe("files a Worker makes for the user", () => {
  test("the result arrives with the deliverables the Worker listed, and only those that exist", async () => {
    const { path } = folderWith("cat.png", "PNG");
    const channel = new FakeChannel();
    const p = await startPreston({
      channels: [channel],
      scenario: {
        coordinator: goalCreatingCoordinator(tempDir("project")),
        worker: async (turn) => {
          await turn.callTool("report_result", {
            summary: "Drew the cat.",
            checksPerformed: ["opened it"],
            deliverables: [path, path, "/no/such/picture.png"],
          });
          return "Done.";
        },
      },
    });
    channel.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });
    await waitFor(() => channel.sent.some((m) => m.kind === "outcome"), { what: "the outcome" });

    const outcome = channel.sent.find((m) => m.kind === "outcome");
    expect(outcome?.files).toEqual([{ path, name: "cat.png" }]);
    // The ack and replies carry no files.
    expect(channel.sent.filter((m) => m.files)).toHaveLength(1);
  });

  test("a result without deliverables is a plain message", async () => {
    const channel = new FakeChannel();
    const p = await startPreston({
      channels: [channel],
      scenario: {
        coordinator: goalCreatingCoordinator(tempDir("project")),
        worker: reportingWorker,
      },
    });
    channel.receive("go");
    await waitFor(finishedGoal(p.rt), { what: "the Goal to finish" });
    await waitFor(() => channel.sent.some((m) => m.kind === "outcome"), { what: "the outcome" });
    expect(channel.sent.find((m) => m.kind === "outcome")?.files).toBeUndefined();
  });

  test("the Coordinator is told to hand making things to a Worker, and where one-off work goes", async () => {
    const { COORDINATOR_GUIDANCE } = await import("../src/prompts/coordinator.js");
    expect(COORDINATOR_GUIDANCE).toContain("you never tell the user you cannot");
    expect(COORDINATOR_GUIDANCE).toContain("deliverables");
    const prompts: string[] = [];
    const p = await startPreston({
      scenario: {
        coordinator: async (turn) => {
          prompts.push(turn.input.appendSystemPrompt ?? "");
          return "ok";
        },
      },
    });
    p.owner.receive("draw me a cat");
    await waitFor(() => prompts.length > 0, { what: "a Coordinator turn" });
    expect(prompts[0]).toContain(`Scratch folder for one-off requests`);
    expect(prompts[0]).toContain(`${p.home}/scratch`);
  });
});

describe("a file that will not send", () => {
  test("the text goes without it, with a note, and later messages are not held back", async () => {
    const { path } = folderWith("chart.png", "PNG");
    const results: string[] = [];
    const channel = new FakeChannel();
    const clock = new ManualClock();
    await startPreston({
      clock,
      channels: [channel],
      scenario: { coordinator: fileSender(results) },
    });
    channel.failFiles({ error: "Couldn't reach Discord.", retryable: true });

    channel.receive(JSON.stringify({ paths: [path], caption: "Here" }));
    await waitFor(() => results.length === 1, { what: "send_file" });
    await waitFor(() => channel.attempts >= 1, { what: "the first try" });
    expect(channel.sent.some((m) => m.files)).toBe(false);

    await clock.advance(1_000);
    await clock.advance(2_000);
    await waitFor(
      () => channel.texts("reply").some((t) => t.includes("I couldn't send chart.png")),
      {
        what: "the note",
      },
    );
    const note = channel.sent.find((m) => m.text.includes("I couldn't send chart.png"));
    expect(note?.text).toBe(
      "Here\n\n(I couldn't send chart.png: Couldn't reach Discord. It is still on your computer.)",
    );
    expect(note?.files).toBeUndefined();
    // The Coordinator's own reply, queued behind the file, arrives too.
    await waitFor(() => channel.texts("reply").includes("ok"), { what: "the reply behind it" });
  });

  test("a file that is refused for good is turned into a note at once", async () => {
    const { path } = folderWith("chart.png", "PNG");
    const results: string[] = [];
    const channel = new FakeChannel();
    await startPreston({ channels: [channel], scenario: { coordinator: fileSender(results) } });
    channel.failFiles({ error: "That file is not allowed.", retryable: false });

    channel.receive(JSON.stringify({ paths: [path] }));
    await waitFor(
      () => channel.texts("reply").some((t) => t.includes("I couldn't send chart.png")),
      {
        what: "the note",
      },
    );
    expect(channel.texts("reply")).toContain("ok");
  });
});

describe("the terminal", () => {
  test("shows a sent file as a link to it", async () => {
    const terminal = new TerminalChannel();
    const lines: string[] = [];
    await terminal.start({
      onMessage: () => {},
      setStatus: () => {},
      notifyHost: () => {},
      saveFile: async () => "",
      log: () => {},
    });
    terminal.attach({ send: (m) => lines.push(m.text) });
    await terminal.send({
      text: "Here.",
      kind: "reply",
      files: [{ path: "/tmp/a b.png", name: "a b.png" }],
    });
    expect(lines).toEqual(["Here.\na b.png: file:///tmp/a%20b.png"]);
  });
});
