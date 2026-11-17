#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { helpText, parseArgs, usageError } from "./cli-args.js";
import { type HomePaths, homePaths, resolveHome } from "./home.js";
import { pick, setLanguage } from "./i18n/index.js";

quietSqliteWarning();

/**
 * `preston` opens the terminal conversation and `preston stop` stops the background service;
 * those are the only user-facing commands. `daemon` and `mcp` are internal roles of the same
 * executable. Modules are loaded per role so the MCP proxy starts fast and never opens the
 * database.
 */
async function main(argv: string[]): Promise<number | undefined> {
  const paths = homePaths(resolveHome());
  const invocation = parseArgs(argv);
  switch (invocation.kind) {
    case "help": {
      await useStoredLanguage(paths);
      process.stdout.write(helpText());
      return 0;
    }
    case "error":
      process.stderr.write(usageError(invocation.message));
      return 2;
    case "open": {
      const cliPath = fileURLToPath(import.meta.url);
      const { updateOnStart } = await import("./selfupdate/start.js");
      const updated = await updateOnStart({
        paths,
        cliPath,
        print: (text) => process.stdout.write(`${text}\n\n`),
      });
      if (updated !== undefined) return updated;
      const { runTerminal } = await import("./terminal/conversation.js");
      return runTerminal({ paths, cliPath });
    }
    case "stop":
      return runStop(paths);
    case "daemon": {
      const { runDaemonProcess } = await import("./daemon/daemon.js");
      await runDaemonProcess();
      return undefined;
    }
    case "version": {
      // Hidden, for diagnostics and the packaging smoke test.
      const { PRESTON_VERSION } = await import("./version.js");
      process.stdout.write(`${PRESTON_VERSION}\n`);
      return 0;
    }
    case "mcp": {
      const index = invocation.args.indexOf("--token");
      const token = index >= 0 ? invocation.args[index + 1] : undefined;
      if (!token) {
        process.stderr.write("Usage: preston mcp --token <token>\n");
        return 2;
      }
      const { runMcpServer } = await import("./mcp/stdio.js");
      await runMcpServer({ token, paths });
      return undefined;
    }
  }
}

/** `preston stop`. */
async function runStop(paths: HomePaths): Promise<number> {
  await useStoredLanguage(paths);
  const { stopBackgroundService } = await import("./daemon/stop.js");
  const result = await stopBackgroundService(paths);
  const say = (text: string) => process.stdout.write(`${text}\n`);
  switch (result) {
    case "not_running":
      say(
        pick({
          en: "Preston's background service is not running.",
          "zh-CN": "Preston 的后台服务没有在运行。",
        }),
      );
      return 0;
    case "stopped":
    case "killed":
      say(
        pick({
          en: "Preston's background service has stopped. Work in progress is saved and picks up when Preston starts again.",
          "zh-CN": "Preston 的后台服务已停止。进行中的工作已保存，Preston 再次启动时会继续。",
        }),
      );
      return 0;
    case "failed":
      process.stderr.write(
        `${pick({
          en: "preston: could not stop the background service. Quit the process named in the lock file by hand.",
          "zh-CN": "preston：无法停止后台服务。请手动结束锁文件中记录的进程。",
        })}\n${paths.lock}\n`,
      );
      return 1;
  }
}

/** The language the user chose, read from the config file so no database is opened. */
async function useStoredLanguage(paths: HomePaths): Promise<void> {
  const { readStartSettings } = await import("./selfupdate/start.js");
  setLanguage(readStartSettings(paths).language);
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
