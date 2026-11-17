import type { Outbox } from "../channels/outbox.js";
import type { Clock, Timer } from "../clock.js";
import type { ConfigManager } from "../config/config.js";
import type { HomePaths } from "../home.js";
import { pick } from "../i18n/index.js";
import { errorMessage, type Logger } from "../log.js";
import { installKind, installVersion, isNewer, latestVersion, type RunProgram } from "./npm.js";
import { FAILURE_BACKOFF_MS, readState, writeState } from "./state.js";

export interface SelfUpdaterDeps {
  clock: Clock;
  log: Logger;
  config: ConfigManager;
  outbox: Outbox;
  paths: HomePaths;
  exec: RunProgram;
  packageRoot: string;
  currentVersion: string;
  /** Nothing is running that an update would interrupt (no Goal in progress, no thinking). */
  isIdle(): boolean;
  /** Stops this daemon and starts a new one from the files just installed. */
  restart(): void;
}

const BUSY_RETRY_MS = 15 * 60_000;
const FIRST_CHECK_MS = 60_000;

/**
 * Keeps Preston itself current when it was installed with `npm install -g`: shortly after the
 * daemon starts and then every `selfUpdate.checkIntervalMs`, it asks npm for the newest version
 * and installs it, but only while nothing is running that a restart would interrupt. Afterwards
 * it restarts the daemon, and the user is told once. A copy npm did not install, or an install
 * that fails, is left alone and the user is told how to update by hand; a failed version is not
 * retried for a day. No model is involved.
 */
export class SelfUpdater {
  private timer: Timer | undefined;
  private stopped = true;
  private checking = false;

  constructor(private readonly deps: SelfUpdaterDeps) {}

  start(): void {
    this.stopped = false;
    this.schedule(FIRST_CHECK_MS);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  /** One look at npm, and an update when there is one and it is safe. Never throws. */
  async check(): Promise<void> {
    if (this.checking || this.stopped) return;
    const { config, log, paths, exec, outbox, currentVersion } = this.deps;
    const settings = config.get().selfUpdate;
    if (!settings.enabled) return this.schedule(settings.checkIntervalMs);
    this.checking = true;
    let next = settings.checkIntervalMs;
    try {
      const state = readState(paths);
      const latest = await latestVersion(exec);
      writeState(paths, { ...readState(paths), checkedAt: this.deps.clock.now() });
      if (!latest || !isNewer(latest, currentVersion)) return;

      const kind = await installKind(exec, this.deps.packageRoot);
      if (kind.kind === "unmanaged") {
        if (state.announcedVersion !== latest) {
          outbox.broadcast({
            kind: "notice",
            text: pick({
              en: `Preston ${latest} is available, but ${kind.reason}, so I can't update myself. To update, run: npm install -g @polyweave/preston`,
              "zh-CN": `Preston ${latest} 已发布，但${kind.reason}，所以我无法自行更新。请手动更新：npm install -g @polyweave/preston`,
            }),
            dedupeKey: `self-update-available:${latest}`,
          });
          writeState(paths, { ...readState(paths), announcedVersion: latest });
        }
        return;
      }
      if (
        state.failedVersion === latest &&
        state.failedAt !== undefined &&
        this.deps.clock.now() - state.failedAt < FAILURE_BACKOFF_MS
      ) {
        return;
      }
      if (!this.deps.isIdle()) {
        log.info("a Preston update is waiting for work to finish", { latest });
        next = BUSY_RETRY_MS;
        return;
      }

      log.info("updating Preston", { from: currentVersion, to: latest });
      const result = await installVersion(exec, latest);
      if (!result.ok) {
        log.warn("could not update Preston", { to: latest, detail: result.detail });
        writeState(paths, {
          ...readState(paths),
          failedVersion: latest,
          failedAt: this.deps.clock.now(),
        });
        outbox.broadcast({
          kind: "notice",
          text: pick({
            en: `I couldn't update myself to ${latest}. ${result.detail} I'm still running ${currentVersion} and working as usual.`,
            "zh-CN": `我无法把自己更新到 ${latest}。${result.detail} 我仍在运行 ${currentVersion}，一切照常。`,
          }),
          dedupeKey: `self-update-failed:${latest}`,
        });
        return;
      }
      // Durable, so it is delivered even though this daemon restarts right away.
      outbox.broadcast({
        kind: "notice",
        text: pick({
          en: `I updated myself from Preston ${currentVersion} to ${latest} and restarted. Nothing was running, and your Goals and settings are unchanged.`,
          "zh-CN": `我已把自己从 Preston ${currentVersion} 更新到 ${latest} 并重新启动。更新时没有任务在运行，您的目标和设置保持不变。`,
        }),
        dedupeKey: `self-update-done:${latest}`,
      });
      this.stopped = true;
      this.deps.restart();
    } catch (error) {
      log.warn("checking for a Preston update failed", { error: errorMessage(error) });
    } finally {
      this.checking = false;
      if (!this.stopped) this.schedule(next);
    }
  }

  private schedule(ms: number): void {
    this.timer?.cancel();
    if (this.stopped) return;
    this.timer = this.deps.clock.setTimeout(() => void this.check(), ms);
  }
}
