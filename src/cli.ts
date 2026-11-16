#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { homePaths, resolveHome } from "./home.js";

/**
 * `preston` is the only user-facing command; it opens the terminal conversation.
 * `daemon` and `mcp` are internal roles of the same executable. Modules are loaded per role so
 * the MCP proxy starts fast and never opens the database.
 */
async function main(argv: string[]): Promise<number | undefined> {
  const [command, ...rest] = argv;
  const paths = homePaths(resolveHome());
  switch (command) {
    case undefined: {
      const { runTerminal } = await import("./terminal/conversation.js");
      return runTerminal({ paths, cliPath: fileURLToPath(import.meta.url) });
    }
    case "daemon": {
      const { runDaemonProcess } = await import("./daemon/daemon.js");
      await runDaemonProcess();
      return undefined;
    }
    case "mcp": {
      const index = rest.indexOf("--token");
      const token = index >= 0 ? rest[index + 1] : undefined;
      if (!token) {
        process.stderr.write("Usage: preston mcp --token <token>\n");
        return 2;
      }
      const { runMcpServer } = await import("./mcp/stdio.js");
      await runMcpServer({ token, paths });
      return undefined;
    }
    default:
      process.stderr.write(
        "Preston has no commands. Run `preston` and tell it what you want in plain words.\n",
      );
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
