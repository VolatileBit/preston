import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Clock, isoNow } from "../clock.js";
import type { Logger } from "../log.js";
import { all, type Db, run } from "../store/db.js";
import type { AgentKind } from "../workers/types.js";

/**
 * Agent child processes Preston started, recorded with a start identity so that after a crash
 * the next daemon terminates the orphans it left behind, and never a process that merely reused
 * the PID. Records are removed when a turn ends normally; on shutdown they are left in place and
 * the next start verifies them, because an interrupt is no proof the process is gone.
 */
export class ProcessTracker {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly probe: ProcessProbe = systemProcesses,
  ) {}

  /** Records `pid` for `owner` (a Run ID or "coordinator"). Resolves once recorded. */
  async track(owner: string, agent: AgentKind, pid: number): Promise<void> {
    const identity = await this.probe.identity(pid);
    if (!identity) return; // Already gone.
    run(
      this.db,
      `INSERT OR REPLACE INTO agent_processes (pid, identity, owner, agent, started_at)
       VALUES (:pid, :identity, :owner, :agent, :at)`,
      { pid, identity, owner, agent, at: isoNow(this.clock) },
    );
  }

  untrack(owner: string): void {
    run(this.db, "DELETE FROM agent_processes WHERE owner = :owner", { owner });
  }

  tracked(): { pid: number; owner: string; agent: AgentKind }[] {
    return all(this.db, "SELECT pid, owner, agent FROM agent_processes ORDER BY started_at");
  }

  /**
   * Terminates every recorded process that is still the one Preston started, then forgets them
   * all. Run before anything resumes, so a resumed Session never runs twice.
   */
  async reconcile(): Promise<number> {
    const rows = all<{ pid: number; identity: string; owner: string; agent: AgentKind }>(
      this.db,
      "SELECT pid, identity, owner, agent FROM agent_processes",
    );
    let terminated = 0;
    for (const row of rows) {
      const identity = await this.probe.identity(row.pid);
      if (identity === row.identity) {
        this.log.warn("terminating orphaned agent process", {
          pid: row.pid,
          owner: row.owner,
          agent: row.agent,
        });
        await this.probe.terminate(row.pid);
        terminated++;
      }
      run(this.db, "DELETE FROM agent_processes WHERE pid = :pid AND identity = :identity", {
        pid: row.pid,
        identity: row.identity,
      });
    }
    return terminated;
  }
}

export interface ProcessProbe {
  /** A string that differs between two processes that had the same PID; undefined if gone. */
  identity(pid: number): Promise<string | undefined>;
  terminate(pid: number): Promise<void>;
}

export const systemProcesses: ProcessProbe = {
  async identity(pid) {
    if (!isAlive(pid)) return undefined;
    try {
      if (process.platform === "linux") {
        // Field 22 of /proc/<pid>/stat is the start time in clock ticks since boot.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return fields[19] ? `linux:${fields[19]}` : undefined;
      }
      if (process.platform === "win32") {
        const out = await exec("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
        ]);
        return out ? `win:${out}` : undefined;
      }
      const out = await exec("ps", ["-o", "lstart=", "-p", String(pid)]);
      return out ? `ps:${out}` : undefined;
    } catch {
      return undefined;
    }
  },

  async terminate(pid) {
    if (process.platform === "win32") {
      await exec("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => "");
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    // Real time: this waits for an actual process, not for Preston's own schedule.
    const deadline = Date.now() + 3_000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone in the meantime.
      }
    }
  },
};

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function exec(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}
