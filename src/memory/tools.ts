import { z } from "zod";
import type { Coordinator } from "../coordinator/coordinator.js";
import { ToolError, type ToolRegistry } from "../mcp/tools.js";
import { type Memory, MemoryError } from "./service.js";

export interface MemoryToolDeps {
  memory: Memory;
  coordinator: Pick<Coordinator, "current">;
  /** Throws unless the Coordinator is answering the user. */
  requireOwnerTurn(): void;
}

const scope = z
  .string()
  .optional()
  .describe('"global" (default) or "project:<absolute folder>" for facts about one Project');

/** The Coordinator's memory tools. The runtime saves and finds; the Coordinator decides what matters. */
export function registerMemoryTools(registry: ToolRegistry, deps: MemoryToolDeps): void {
  const { memory } = deps;
  const roles = ["coordinator"] as const;
  const guarded = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MemoryError) throw new ToolError(err.message);
      throw err;
    }
  };

  registry.add({
    name: "memory_search",
    description:
      "Search what you know about the user and summaries of finished Goals. Use it before asking the user something they may have told you, and when a request refers to earlier work. An empty query lists the most recent.",
    roles,
    input: z.strictObject({
      query: z.string().default(""),
      kinds: z.enum(["all", "memory", "goals"]).default("all"),
      scope: scope,
      limit: z.number().int().min(1).max(25).default(8),
    }),
    handler: ({ query, kinds, scope: where, limit }) => ({
      results: memory.search(query, {
        kinds: kinds === "memory" ? ["memory"] : kinds === "goals" ? ["goal"] : ["memory", "goal"],
        scope: where?.trim() || undefined,
        limit,
      }),
    }),
  });

  registry.add({
    name: "memory_upsert",
    description:
      "Remember a lasting fact or preference the user told you (one short sentence). The same fact is never stored twice; pass id (or the same key) to change an earlier one. Never save passwords, keys or tokens, and never save progress on a Goal.",
    roles,
    input: z.strictObject({
      text: z.string().min(1).describe("One short sentence about the user or their Project"),
      id: z.string().min(1).optional().describe("Replace this memory instead of adding one"),
      key: z
        .string()
        .min(1)
        .optional()
        .describe("Short topic name such as reply-style; a new value replaces the old one"),
      scope,
      source: z
        .enum(["user", "observed"])
        .default("user")
        .describe("user: they said it. observed: you noticed it."),
    }),
    handler: ({ text, id, key, scope: where, source }) => {
      deps.requireOwnerTurn();
      return guarded(async () => {
        const via = deps.coordinator.current()?.replyTo?.channel;
        const { entry, action } = await memory.upsert({ text, id, key, scope: where, source, via });
        return { id: entry.id, action, version: entry.version, scope: entry.scope };
      });
    },
  });

  registry.add({
    name: "memory_remove",
    description: "Forget a memory for good (when the user asks you to).",
    roles,
    input: z.strictObject({ id: z.string().min(1) }),
    handler: ({ id }) => {
      deps.requireOwnerTurn();
      return guarded(async () => {
        if (!(await memory.remove(id))) throw new ToolError(`There is no memory ${id}.`);
        return { removed: id };
      });
    },
  });
}
