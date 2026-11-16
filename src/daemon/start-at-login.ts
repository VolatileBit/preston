import { realpathSync } from "node:fs";
import { ensureHome, type HomePaths } from "../home.js";
import { ensureStartAtLogin as ensure, type StartAtLoginResult } from "../service/index.js";

export type { StartAtLoginResult } from "../service/index.js";

/**
 * Registers the daemon to start at login (launchd on macOS, a systemd user unit on Linux, a
 * per-user scheduled task on Windows), running this Node and this `dist/cli.js`. Never throws.
 */
export function ensureStartAtLogin(options: {
  paths: HomePaths;
  cliPath: string;
}): Promise<StartAtLoginResult> {
  let cliPath = options.cliPath;
  try {
    // Create the owner-only home before anything is written into it.
    ensureHome(options.paths);
    cliPath = realpathSync(cliPath);
  } catch {
    // Registration explains its own failures; starting the daemon reports a broken home.
  }
  return ensure({ home: options.paths.root, cliPath, nodePath: process.execPath });
}
