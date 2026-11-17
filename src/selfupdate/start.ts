import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { stopDaemon } from "../daemon/ensure.js";
import type { HomePaths } from "../home.js";
import { languageSchema, pick, setLanguage } from "../i18n/index.js";
import { errorMessage } from "../log.js";
import { PRESTON_VERSION } from "../version.js";
import {
  installKind,
  installVersion,
  isNewer,
  latestVersion,
  type RunProgram,
  runProgram,
  thisPackageRoot,
} from "./npm.js";
import { FAILURE_BACKOFF_MS, readState, writeState } from "./state.js";

/** Set on the copy started right after an update, so it does not look again. */
export const JUST_UPDATED_ENV = "PRESTON_JUST_UPDATED";

/** Looking again within this time of the last check, when nothing newer was found, is skipped. */
const RECHECK_MS = 60 * 60_000;

export interface UpdateOnStartOptions {
  paths: HomePaths;
  /** This executable; the new version replaces it in place. */
  cliPath: string;
  print(text: string): void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  exec?: RunProgram;
  packageRoot?: string;
  currentVersion?: string;
  /** Stops the daemon that runs the old version. */
  stopDaemon?: (paths: HomePaths) => Promise<boolean>;
  /** Runs the updated Preston in place of this one and resolves with its exit code. */
  rerun?: (cliPath: string) => Promise<number>;
}

/**
 * `preston` checks for a newer version before it opens the conversation. When npm has one and
 * this copy was installed with `npm install -g`, it installs it, stops the old background
 * service and runs the new Preston in its place (which starts a new service). Returns the exit
 * code of that new run, or undefined to carry on with this copy: nothing newer, updates off, an
 * install npm did not make, or a failure (which is explained and not retried for a day).
 */
export async function updateOnStart(options: UpdateOnStartOptions): Promise<number | undefined> {
  const { paths, print } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const exec = options.exec ?? runProgram;
  const current = options.currentVersion ?? PRESTON_VERSION;
  if (env[JUST_UPDATED_ENV]) return undefined;

  const settings = readStartSettings(paths);
  setLanguage(settings.language);
  if (!settings.enabled) return undefined;

  const state = readState(paths);
  if (state.startCheckedAt !== undefined && now() - state.startCheckedAt < RECHECK_MS) {
    return undefined;
  }

  try {
    const latest = await latestVersion(exec);
    writeState(paths, { ...readState(paths), startCheckedAt: now() });
    if (!latest || !isNewer(latest, current)) return undefined;

    const kind = await installKind(exec, options.packageRoot ?? thisPackageRoot());
    if (kind.kind === "unmanaged") {
      if (readState(paths).announcedVersion !== latest) {
        print(
          pick({
            en: `Preston ${latest} is available, but ${kind.reason}, so I can't update myself. To update, run: npm install -g @polyweave/preston`,
            "zh-CN": `Preston ${latest} 已发布，但${kind.reason}，所以我无法自行更新。请手动更新：npm install -g @polyweave/preston`,
          }),
        );
        writeState(paths, { ...readState(paths), announcedVersion: latest });
      }
      return undefined;
    }
    if (
      state.failedVersion === latest &&
      state.failedAt !== undefined &&
      now() - state.failedAt < FAILURE_BACKOFF_MS
    ) {
      return undefined;
    }

    print(
      pick({
        en: `Updating Preston ${current} → ${latest}. This takes a moment…`,
        "zh-CN": `正在把 Preston 从 ${current} 更新到 ${latest}，请稍候……`,
      }),
    );
    const result = await installVersion(exec, latest);
    if (!result.ok) {
      writeState(paths, { ...readState(paths), failedVersion: latest, failedAt: now() });
      print(
        pick({
          en: `I couldn't update to ${latest}. ${result.detail} Carrying on with ${current}.`,
          "zh-CN": `无法更新到 ${latest}。${result.detail} 继续使用 ${current}。`,
        }),
      );
      return undefined;
    }

    // The background service still runs the old files; stop it so the new copy starts a new one.
    if (!(await (options.stopDaemon ?? stopDaemon)(paths))) {
      print(
        pick({
          en: "Updated, but the old background service did not stop. Run `preston` again in a moment.",
          "zh-CN": "已更新，但旧的后台服务没有停止。请稍后再次运行 `preston`。",
        }),
      );
      return 0;
    }
    print(pick({ en: `Updated to ${latest}.`, "zh-CN": `已更新到 ${latest}。` }));
    return await (options.rerun ?? defaultRerun)(options.cliPath);
  } catch (err) {
    // Never let an update problem stop the user from reaching Preston.
    print(
      pick({
        en: `I couldn't check for updates: ${errorMessage(err)}`,
        "zh-CN": `无法检查更新：${errorMessage(err)}`,
      }),
    );
    return undefined;
  }
}

function defaultRerun(cliPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cliPath], {
      stdio: "inherit",
      env: { ...process.env, [JUST_UPDATED_ENV]: "1" },
    });
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
}

/** `selfUpdate.enabled` and `language` from the config file, without opening the database. */
export function readStartSettings(paths: HomePaths): {
  enabled: boolean;
  language: "en" | "zh-CN";
} {
  try {
    const config = JSON.parse(readFileSync(paths.config, "utf8")) as {
      selfUpdate?: { enabled?: unknown };
      language?: unknown;
    };
    return {
      enabled: config.selfUpdate?.enabled !== false,
      language: languageSchema.catch("en").parse(config.language),
    };
  } catch {
    return { enabled: true, language: "en" };
  }
}
