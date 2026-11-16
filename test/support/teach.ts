import type { FakeScript } from "../../src/workers/fake/index.js";
import { brief, goalCreatingCoordinator, ownerMessage, type Preston, waitFor } from "./harness.js";

/**
 * A scripted Coordinator that calls whatever Preston tool the owner's message names, as a model
 * would after reading it: the message is `{"id":1,"tool":"memory_upsert","args":{...}}`.
 */
export function teacher(project: string, goalBrief: Record<string, unknown> = brief()) {
  const results = new Map<number, { ok: boolean; text: string }>();
  let seq = 0;
  const fallback = goalCreatingCoordinator(project, goalBrief);
  const coordinator: FakeScript = async (turn) => {
    const message = ownerMessage(turn);
    if (message?.startsWith("{")) {
      const { id, tool, args } = JSON.parse(message) as {
        id: number;
        tool: string;
        args: Record<string, unknown>;
      };
      try {
        results.set(id, { ok: true, text: await turn.callTool(tool, args) });
      } catch (err) {
        results.set(id, { ok: false, text: (err as Error).message });
      }
      return `done ${id}`;
    }
    return fallback(turn);
  };
  const run = async (p: Preston, tool: string, args: Record<string, unknown>) => {
    const id = ++seq;
    p.owner.receive(JSON.stringify({ id, tool, args }));
    return waitFor(() => results.get(id), { what: `${tool} result` });
  };
  return {
    coordinator,
    /** Calls a tool as the Coordinator answering the owner and returns its parsed result. */
    async call(p: Preston, tool: string, args: Record<string, unknown> = {}) {
      const result = await run(p, tool, args);
      if (!result.ok) throw new Error(`${tool} failed: ${result.text}`);
      // biome-ignore lint/suspicious/noExplicitAny: tests read tool results loosely
      return JSON.parse(result.text) as Record<string, any>;
    },
    /** Calls a tool that is expected to be refused and returns the reason. */
    async refused(p: Preston, tool: string, args: Record<string, unknown> = {}) {
      const result = await run(p, tool, args);
      if (result.ok) throw new Error(`${tool} was not refused: ${result.text}`);
      return result.text;
    },
  };
}
