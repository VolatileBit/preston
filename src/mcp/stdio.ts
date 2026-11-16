import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { HomePaths } from "../home.js";
import { IpcClient } from "../ipc/client.js";
import { errorMessage } from "../log.js";
import { PRESTON_VERSION } from "../version.js";
import { MCP_SERVER_NAME } from "./names.js";
import type { ToolDescription, ToolResult } from "./tools.js";

/**
 * `preston mcp --token <t>`: the stdio MCP server an agent CLI launches. It owns no tools; it
 * forwards to the daemon over IPC with the caller's token, reconnecting if the daemon restarts.
 * Results carry text content only (Claude's permission prompt tool rejects structured content).
 */
export async function runMcpServer(options: { token: string; paths: HomePaths }): Promise<void> {
  const { token, paths } = options;
  let client: IpcClient | undefined;

  const call = async <T>(method: string, params: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!client || client.closed)
          client = await IpcClient.connect(paths.endpoint, paths.ipcToken);
        return await client.request<T>(method, params);
      } catch (err) {
        const lostConnection = !client || client.closed;
        if (!lostConnection || attempt >= 1) throw err;
        client = undefined;
      }
    }
  };

  const server = new Server(
    { name: MCP_SERVER_NAME, version: PRESTON_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const described = await call<{ tools: ToolDescription[] }>("mcp.describe", { token });
    return {
      tools: described.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: "object"; [key: string]: unknown },
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await call<ToolResult>("mcp.call", {
        token,
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Preston could not handle this call: ${errorMessage(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const shutdown = () => {
    client?.close();
    process.exit(0);
  };
  server.onclose = shutdown;
  process.stdin.on("end", shutdown);
  await server.connect(new StdioServerTransport());
}
