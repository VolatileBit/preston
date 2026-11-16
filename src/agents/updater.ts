import { accessSync, constants, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Outbox } from "../channels/outbox.js";
import { type Clock, isoNow, type Timer } from "../clock.js";
import type { ConfigManager } from "../config/config.js";
import { errorMessage, type Logger } from "../log.js";
import { formatResetTime } from "../quota/time.js";
import { all, type Db, one, recordEvent, run } from "../store/db.js";
import { type Adapters, agentLabel } from "../workers/registry.js";
import type { AgentDetection, AgentKind, UpdateResult } from "../workers/types.js";

/** First check after the daemon starts: lets recovery settle before anything else runs. */
export const UPDATE_START_DELAY_MS = 30_000;
/** How long to wait before looking again when the CLI is in use or setup is unfinished. */
export const UPDATE_RETRY_MS = 5 * 60_000;
/** A restart does not check again sooner than this after the last check (a crash loop is quiet). */
const MIN_RECHECK_MS = 10 * 60_000;
/** Each interval is spread by up to this share of itself, so agents do not line up. */
const JITTER_RATIO = 0.1;

export type UpdateOutcome =
  | "up_to_date"
  | "updated"
  | "failed"
  | "managed_externally"
  | "needs_attention"
  | "skipped";

/** What is known about one agent CLI, for status and tools. */
export interface AgentCliState {
  agent: AgentKind;
  version: string | undefined;
  checkedAt: string | undefined;
  result: UpdateOutcome;
  detail: string | undefined;
  /** Plain-language reason Preston stopped updating this agent and wants the user to look. */
  attention: string | undefined;
  /** Version at which Preston found the install managed by something else. */
  managedVersion: string | undefined;
  managedReason: string | undefined;
}

export interface VersionChange {
  agent: AgentKind;
  from: string | undefined;
  to: string;
  how: "update" | "outside";
  at: string;
}

export interface UpdaterDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  config: ConfigManager;
  adapters: Adapters;
  outbox: Outbox;
  /** A Run or the Coordinator is using this agent's CLI right now. */
  busy(agent: AgentKind): boolean;
  /** What stops an install being updated without help (default: look at the files on disk). */
  checkInstall?: (path: string | undefined) => string | undefined;
}

/**
 * Keeps the agent CLIs current without a model: on start (after recovery) and then every
 * `agents.updateIntervalMs`, each enabled agent whose adapter can update is updated, but only
 * while nothing uses that CLI and setup is finished; otherwise it is looked at again shortly.
 * Afterwards the CLI must still start and still be signed in. If not, the agent is marked as
 * needing attention and the user is told once; nothing is rolled back and nothing more is tried.
 * Installs managed by a package manager or an administrator are never touched. Persisted, so
 * versions and results survive restarts.
 */
export class AgentUpdater {
  private timers = new Map<AgentKind, Timer>();
  private running = new Set<AgentKind>();
  private cycles = new Map<AgentKind, number>();
  private stopped = true;

  constructor(private readonly deps: UpdaterDeps) {}

  start(): void {
    this.stopped = false;
    for (const agent of this.updatable()) this.schedule(agent, this.firstDelay(agent));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
  }

  /** What is recorded about an agent CLI; undefined until it has been looked at. */
  state(agent: AgentKind): AgentCliState | undefined {
    const row = one<CliRow>(this.deps.db, "SELECT * FROM agent_cli WHERE agent = :agent", {
      agent,
    });
    return row ? toState(row) : undefined;
  }

  /** Version changes seen for an agent, oldest first. */
  versionChanges(agent: AgentKind): VersionChange[] {
    return all<VersionRow>(
      this.deps.db,
      "SELECT * FROM agent_cli_versions WHERE agent = :agent ORDER BY id",
      { agent },
    ).map((row) => ({
      agent: row.agent,
      from: row.from_version ?? undefined,
      to: row.to_version,
      how: row.how,
      at: row.at,
    }));
  }

  /** One short line per agent CLI Preston keeps current, for the status text. */
  statusLines(): string[] {
    return this.updatable()
      .filter((agent) => this.deps.config.get().agents.enabled.includes(agent))
      .map((agent) => this.line(agent))
      .filter((line): line is string => line !== undefined);
  }

  /** "Claude Code 2.1.4: up to date (checked 9:00am)." Undefined before the first look. */
  line(agent: AgentKind): string | undefined {
    const state = this.state(agent);
    if (!state) return undefined;
    const label = agentLabel(agent);
    const name = state.version ? `${label} ${state.version}` : label;
    const when = state.checkedAt ? formatResetTime(state.checkedAt, this.deps.clock.now()) : "";
    if (state.attention) return `${name}: needs attention. ${state.attention}`;
    if (state.managedVersion && state.managedVersion === state.version) {
      return `${name}: ${state.managedReason ?? "managed outside Preston"}. Update it yourself.`;
    }
    const off = this.deps.config.get().agents.autoUpdate ? "" : " Automatic updates are off.";
    const checked = when ? ` (checked ${when})` : "";
    switch (state.result) {
      case "updated": {
        const from = this.versionChanges(agent).at(-1)?.from;
        return `${name}: updated${from ? ` from ${from}` : ""}${checked}.${off}`;
      }
      case "failed":
        return `${name}: the last update check failed${checked}; I'll try again.${off}`;
      case "skipped":
        return `${name}: not checked${checked}${state.detail ? ` - ${state.detail}` : ""}.${off}`;
      default:
        return `${name}: up to date${checked}.${off}`;
    }
  }

  // ---- Scheduling ---------------------------------------------------------------------------

  private updatable(): AgentKind[] {
    return this.deps.adapters.kinds().filter((agent) => this.deps.adapters.get(agent)?.update);
  }

  private firstDelay(agent: AgentKind): number {
    const checked = this.state(agent)?.checkedAt;
    const since = checked ? this.deps.clock.now() - Date.parse(checked) : Number.POSITIVE_INFINITY;
    return since < MIN_RECHECK_MS
      ? MIN_RECHECK_MS - since + UPDATE_START_DELAY_MS
      : UPDATE_START_DELAY_MS;
  }

  private schedule(agent: AgentKind, delayMs: number): void {
    if (this.stopped) return;
    this.timers.get(agent)?.cancel();
    this.timers.set(
      agent,
      this.deps.clock.setTimeout(() => {
        this.timers.delete(agent);
        void this.tick(agent).catch((err) =>
          this.deps.log.error("agent update check failed", { agent, error: err }),
        );
      }, delayMs),
    );
  }

  /** The next regular check: the interval, spread so agents (and restarts) do not line up. */
  private nextDelay(agent: AgentKind): number {
    const cycle = (this.cycles.get(agent) ?? 0) + 1;
    this.cycles.set(agent, cycle);
    const base = this.deps.config.get().agents.updateIntervalMs;
    const jitter = (unitHash(`${agent}:${cycle}`) * 2 - 1) * JITTER_RATIO;
    return Math.round(base * (1 + jitter));
  }

  private async tick(agent: AgentKind): Promise<void> {
    if (this.stopped || this.running.has(agent)) return;
    const config = this.deps.config.get();
    if (!config.agents.autoUpdate || !config.agents.enabled.includes(agent)) {
      this.schedule(agent, this.nextDelay(agent));
      return;
    }
    // Never mid-setup, never while work is using this CLI: look again at the next quiet moment.
    if (!config.setup.complete || this.deps.busy(agent)) {
      this.schedule(agent, UPDATE_RETRY_MS);
      return;
    }
    this.running.add(agent);
    try {
      await this.update(agent);
    } finally {
      this.running.delete(agent);
    }
    this.schedule(agent, this.nextDelay(agent));
  }

  // ---- One update -----------------------------------------------------------------------------

  private async update(agent: AgentKind): Promise<void> {
    const adapter = this.deps.adapters.get(agent);
    if (!adapter?.update) return;
    const { log } = this.deps;
    const label = agentLabel(agent);
    const stored = this.state(agent);

    const before = await detect(adapter);
    if (this.stopped) return;
    if (!healthy(before)) {
      // Not ours to fix: a CLI that is missing or signed out is the setup and sign-in paths' job.
      this.save(agent, {
        version: before.version ?? stored?.version,
        result: stored?.attention ? "needs_attention" : "skipped",
        detail: before.problem ?? "it is not installed or not signed in",
        keepAttention: true,
      });
      return;
    }
    this.noteOutsideChange(agent, stored?.version, before.version);
    const cleared = stored?.attention !== undefined;
    if (cleared) log.info("agent works again", { agent });

    if (stored?.managedVersion && stored.managedVersion === before.version) {
      // Already known to be managed elsewhere at this version: stop retrying until it changes.
      this.save(agent, {
        version: before.version,
        result: "managed_externally",
        detail: stored.managedReason,
        managed: { version: before.version, reason: stored.managedReason ?? "" },
      });
      return;
    }

    const blocked = (this.deps.checkInstall ?? checkInstall)(before.path);
    if (blocked) {
      this.markManaged(agent, before.version, blocked);
      return;
    }

    let result: UpdateResult;
    try {
      result = await adapter.update();
    } catch (err) {
      result = { updated: false, failed: true, detail: errorMessage(err) };
    }
    if (this.stopped) return;
    log.info("agent update ran", { agent, ...result });

    if (!result.updated && (result.managedExternally || managedFromOutput(result.detail))) {
      this.markManaged(agent, before.version, managedReason(result.detail));
      return;
    }

    const after = await detect(adapter);
    if (this.stopped) return;
    const version = after.version ?? result.toVersion ?? before.version;
    if (!healthy(after)) {
      this.needsAttention(agent, before.version, version, after, label);
      return;
    }
    const changed = Boolean(version && before.version && version !== before.version);
    if (changed && version) this.recordChange(agent, before.version, version, "update");
    this.save(agent, {
      version,
      result: changed ? "updated" : result.failed ? "failed" : "up_to_date",
      detail: result.detail,
    });
    if (changed && version) this.maybeTell(agent, before.version, version);
  }

  private markManaged(agent: AgentKind, version: string | undefined, reason: string): void {
    this.deps.log.info("agent is managed outside Preston", { agent, version, reason });
    this.save(agent, {
      version,
      result: "managed_externally",
      detail: reason,
      managed: { version: version ?? "", reason },
    });
  }

  private needsAttention(
    agent: AgentKind,
    from: string | undefined,
    to: string | undefined,
    after: AgentDetection,
    label: string,
  ): void {
    const problem = after.problem ?? `${label} did not start or says you are signed out.`;
    const reason = `${label} stopped working after an update. ${problem} I have not changed anything else and I will not undo the update myself.`;
    this.deps.log.warn("agent needs attention after update", { agent, from, to, problem });
    this.save(agent, {
      version: to ?? from,
      result: "needs_attention",
      detail: problem,
      attention: reason,
    });
    recordEvent(this.deps.db, this.deps.clock, "agent_needs_attention", {}, { agent, from, to });
    this.deps.outbox.broadcast({
      kind: "notice",
      text: reason,
      dedupeKey: `agent-attention:${agent}:${from ?? "?"}:${to ?? "?"}`,
    });
  }

  /** Tells the user only about a new major version; routine updates are logged and in status. */
  private maybeTell(agent: AgentKind, from: string | undefined, to: string): void {
    const major = (v: string | undefined) => /^v?(\d+)\./.exec(v ?? "")?.[1];
    const before = major(from);
    const after = major(to);
    if (!before || !after || before === after) return;
    this.deps.outbox.broadcast({
      kind: "notice",
      text: `I updated ${agentLabel(agent)} to ${to}, a new major version. Work carries on as normal; tell me if anything seems different.`,
      dedupeKey: `agent-major:${agent}:${to}`,
    });
  }

  // ---- Persistence ----------------------------------------------------------------------------

  /** The CLI changed version without Preston's update (the user did it). */
  private noteOutsideChange(
    agent: AgentKind,
    known: string | undefined,
    seen: string | undefined,
  ): void {
    if (seen && known && seen !== known) this.recordChange(agent, known, seen, "outside");
  }

  private recordChange(
    agent: AgentKind,
    from: string | undefined,
    to: string,
    how: VersionChange["how"],
  ): void {
    run(
      this.deps.db,
      "INSERT INTO agent_cli_versions (agent, from_version, to_version, how, at) VALUES (:agent, :from, :to, :how, :at)",
      { agent, from: from ?? null, to, how, at: isoNow(this.deps.clock) },
    );
    this.deps.log.info("agent version changed", { agent, from, to, how });
  }

  private save(
    agent: AgentKind,
    next: {
      version: string | undefined;
      result: UpdateOutcome;
      detail: string | undefined;
      attention?: string;
      /** Leave a recorded reason for attention in place (the CLI is still broken). */
      keepAttention?: boolean;
      managed?: { version: string; reason: string };
    },
  ): void {
    const before = this.state(agent);
    const attention = next.attention ?? (next.keepAttention ? before?.attention : undefined);
    const managed =
      next.managed ??
      (before?.managedVersion && before.managedVersion === next.version
        ? { version: before.managedVersion, reason: before.managedReason ?? "" }
        : undefined);
    run(
      this.deps.db,
      `INSERT INTO agent_cli (agent, version, checked_at, result, detail, attention, managed_version, managed_reason)
       VALUES (:agent, :version, :at, :result, :detail, :attention, :mv, :mr)
       ON CONFLICT (agent) DO UPDATE SET version = :version, checked_at = :at, result = :result,
         detail = :detail, attention = :attention, managed_version = :mv, managed_reason = :mr`,
      {
        agent,
        version: next.version ?? null,
        at: isoNow(this.deps.clock),
        result: next.result,
        detail: next.detail?.slice(0, 500) ?? null,
        attention: attention ?? null,
        mv: managed?.version || null,
        mr: managed?.reason || null,
      },
    );
  }
}

// ---- Install checks -------------------------------------------------------------------------

/** Install locations owned by a package manager, which updates them (and may need rights). */
const PACKAGE_MANAGED: [RegExp, string][] = [
  [/^\/opt\/homebrew\/|\/Cellar\/|\/Caskroom\/|\/linuxbrew\//, "installed with Homebrew"],
  [/^\/snap\/|\/snap\/bin\//, "installed with Snap"],
  [/^\/nix\/store\/|\/\.nix-profile\/|^\/run\/current-system\//, "installed with Nix"],
  [/^\/usr\/(?:s?bin|lib|libexec|share)\//, "installed by your system's package manager"],
  [/\\WinGet\\|\\Microsoft\\WindowsApps\\/i, "installed with winget"],
  [/\\chocolatey\\/i, "installed with Chocolatey"],
];

/** Why this path is a package manager's install, or undefined. */
export function managedByPackageManager(path: string): string | undefined {
  return PACKAGE_MANAGED.find(([pattern]) => pattern.test(path))?.[1];
}

/**
 * Why Preston must not update an install itself, or undefined when it may try: it sits where a
 * package manager keeps it, or its folder is not writable for this user (so updating would need
 * administrator rights, which Preston never uses).
 */
export function checkInstall(path: string | undefined): string | undefined {
  if (!path) return undefined;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return undefined;
  }
  const managed = managedByPackageManager(path) ?? managedByPackageManager(real);
  if (managed) return managed;
  try {
    accessSync(dirname(real), constants.W_OK);
  } catch {
    return "installed where only an administrator can change it";
  }
  return undefined;
}

const NEEDS_RIGHTS =
  /\b(sudo|administrator|elevated|eacces|eperm|permission denied|operation not permitted|requires? (?:root|admin))\b|managed by|installed (?:with|via|using|through) (?:homebrew|brew|apt|winget|snap|chocolatey|scoop|nix)|\b(?:brew|apt(?:-get)?|dnf|winget|choco) (?:upgrade|install|update)\b/i;

function managedFromOutput(detail: string): boolean {
  return NEEDS_RIGHTS.test(detail);
}

function managedReason(detail: string): string {
  return /sudo|administrator|elevated|eacces|eperm|permission denied|operation not permitted|root|admin/i.test(
    detail,
  )
    ? "updating it needs administrator rights"
    : "managed by a package manager";
}

// ---- Helpers --------------------------------------------------------------------------------

async function detect(adapter: { detect(): Promise<AgentDetection> }): Promise<AgentDetection> {
  try {
    return await adapter.detect();
  } catch (err) {
    return { installed: false, problem: errorMessage(err) };
  }
}

/** Starts, and is not known to be signed out ("unknown" cannot be checked cheaply). */
function healthy(detection: AgentDetection): boolean {
  return detection.installed && detection.loggedIn !== false;
}

interface CliRow {
  agent: AgentKind;
  version: string | null;
  checked_at: string | null;
  result: UpdateOutcome;
  detail: string | null;
  attention: string | null;
  managed_version: string | null;
  managed_reason: string | null;
}

interface VersionRow {
  agent: AgentKind;
  from_version: string | null;
  to_version: string;
  how: "update" | "outside";
  at: string;
}

function toState(row: CliRow): AgentCliState {
  return {
    agent: row.agent,
    version: row.version ?? undefined,
    checkedAt: row.checked_at ?? undefined,
    result: row.result,
    detail: row.detail ?? undefined,
    attention: row.attention ?? undefined,
    managedVersion: row.managed_version ?? undefined,
    managedReason: row.managed_reason ?? undefined,
  };
}

/** A stable number in [0, 1) for a string (FNV-1a), so jitter is repeatable in tests. */
function unitHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 2 ** 32;
}
