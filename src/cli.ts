#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { homePaths, resolveHome } from "./home.js";

quietSqliteWarning();

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
    case "--version": {
      // Hidden, for diagnostics and the packaging smoke test.
      const { PRESTON_VERSION } = await import("./version.js");
      process.stdout.write(`${PRESTON_VERSION}\n`);
      return 0;
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

/**
 * Node 22 warns that `node:sqlite` is experimental on first use. That is noise for users, so
 * this one warning is dropped before Node sees it; every other warning, and Node's own warning
 * flags, behave as usual.
 */
function quietSqliteWarning(): void {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: never[]) {
    const options = rest[0] as string | { type?: string } | undefined;
    const type = typeof options === "string" ? options : (options?.type ?? (warning as Error).name);
    const message = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && /\bSQLite\b/.test(message)) return;
    return emitWarning.call(process, warning, ...rest);
  } as typeof process.emitWarning;
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
