import { z } from "zod";
import { errorMessage, type Logger } from "../log.js";
import { newSecret } from "../util/ids.js";

/**
 * Preston's MCP tools, owned by the daemon. `preston mcp` is only a stdio proxy: it asks the
 * daemon which tools its token may see and forwards calls. Tokens are minted per agent turn,
 * held in memory only, and scope the caller to one role.
 */

export type Caller = { role: "coordinator" } | { role: "worker"; runId: string; goalId: string };
export type Role = Caller["role"];

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  roles: readonly Role[];
  input: S;
  /** Return text, or a value that is sent as JSON text. Throw ToolError for a user-facing error. */
  handler(args: z.infer<S>, caller: Caller): unknown;
}

export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** What an agent (or a test double of one) uses to call Preston's tools. */
export interface ToolClient {
  describe(token: string): { role: Role; tools: ToolDescription[] };
  call(token: string, name: string, args: unknown): Promise<ToolResult>;
}

export class ToolError extends Error {}

export class Tokens {
  private callers = new Map<string, Caller>();

  constructor(private readonly onMint?: (token: string) => void) {}

  mint(caller: Caller): string {
    const token = newSecret();
    this.callers.set(token, caller);
    this.onMint?.(token);
    return token;
  }

  resolve(token: string): Caller | undefined {
    return this.callers.get(token);
  }

  revoke(token: string): void {
    this.callers.delete(token);
  }
}

export class ToolRegistry implements ToolClient {
  private tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly tokens: Tokens,
    private readonly log: Logger,
  ) {}

  add<S extends z.ZodType>(tool: ToolDefinition<S>): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  describe(token: string): { role: Role; tools: ToolDescription[] } {
    const caller = this.authorise(token);
    const tools = [...this.tools.values()]
      .filter((t) => t.roles.includes(caller.role))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.input, { target: "draft-7", io: "input" }) as Record<
          string,
          unknown
        >,
      }));
    return { role: caller.role, tools };
  }

  async call(token: string, name: string, args: unknown): Promise<ToolResult> {
    const caller = this.authorise(token);
    const tool = this.tools.get(name);
    if (!tool?.roles.includes(caller.role)) {
      return { text: `Unknown tool: ${name}`, isError: true };
    }
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) {
      return { text: `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`, isError: true };
    }
    try {
      const value = await tool.handler(parsed.data, caller);
      return { text: typeof value === "string" ? value : JSON.stringify(value ?? { ok: true }) };
    } catch (err) {
      if (!(err instanceof ToolError)) this.log.error("tool failed", { tool: name, error: err });
      return { text: errorMessage(err), isError: true };
    }
  }

  private authorise(token: string): Caller {
    const caller = this.tokens.resolve(token);
    if (!caller) throw new ToolError("This Preston tool token is not valid (it may have expired).");
    return caller;
  }
}
