import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type FakeScript, FakeToolError } from "../src/workers/fake/index.js";
import { ownerMessage, type Preston, startPreston, waitFor } from "./support/harness.js";

/** A Coordinator that calls the tool named in a JSON owner message and replies with the result. */
const toolDriver: FakeScript = async (turn) => {
  const text = ownerMessage(turn);
  if (!text) return "";
  const { tool, args } = JSON.parse(text) as { tool: string; args?: Record<string, unknown> };
  try {
    return await turn.callTool(tool, args);
  } catch (err) {
    if (err instanceof FakeToolError) return `error: ${err.message}`;
    throw err;
  }
};

async function call(p: Preston, tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const before = p.owner.texts("reply").length;
  p.owner.receive(JSON.stringify({ tool, args }));
  return waitFor(() => p.owner.texts("reply")[before], { what: `${tool} reply` });
}

const isPosix = process.platform !== "win32";

describe("config through chat", () => {
  test("updates are validated, versioned, written owner-only, and can be rolled back", async () => {
    const p = await startPreston({ scenario: { coordinator: toolDriver } });
    const file = join(p.home, "config.json");

    const updated = JSON.parse(
      await call(p, "config_update", {
        patch: {
          workers: { model: "opus" },
          channels: { slack: { botToken: "xoxb-1234567890-abcdefghij" } },
        },
        reason: "user asked for a stronger model",
      }),
    );
    expect(updated.config.workers.model).toBe("opus");
    expect(updated.config.channels.slack.botToken).toBe("(set)");
    expect(JSON.parse(readFileSync(file, "utf8")).workers.model).toBe("opus");
    if (isPosix) expect(statSync(file).mode & 0o777).toBe(0o600);

    const rejected = await call(p, "config_update", {
      patch: { verification: { maxFixAttempts: "lots" } },
    });
    expect(rejected).toMatch(/^error: That change is not valid: verification.maxFixAttempts/);

    const history = JSON.parse(await call(p, "config_history"));
    expect(history.versions.map((v: { reason: string }) => v.reason)).toEqual([
      "user asked for a stronger model",
      "initial",
    ]);

    const rolledBack = JSON.parse(await call(p, "config_rollback", { version: 1 }));
    expect(rolledBack.version).toBe(3);
    expect(rolledBack.config.workers.model).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8")).workers.model).toBeUndefined();

    const secretShown = (await call(p, "config_get")).includes("xoxb-");
    expect(secretShown).toBe(false);
    expect(readFileSync(join(p.home, "logs", "preston.log"), "utf8")).not.toContain(
      "xoxb-1234567890",
    );
  });

  test("survives a restart and records edits made on disk as a new version", async () => {
    const first = await startPreston({ scenario: { coordinator: toolDriver } });
    await call(first, "config_update", { patch: { workers: { effort: "high" } } });
    await first.stop();
    const file = join(first.home, "config.json");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    onDisk.workers.effort = "low";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify(onDisk));

    const second = await first.restart();
    const history = JSON.parse(await call(second, "config_history"));
    expect(history.versions[0].reason).toBe("edited on disk");
    expect(second.rt.config.get().workers.effort).toBe("low");
  });
});
