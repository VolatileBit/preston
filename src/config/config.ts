import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { type Clock, isoNow } from "../clock.js";
import type { Logger } from "../log.js";
import { all, type Db, one, run, transaction } from "../store/db.js";
import { type Config, configSchema, defaultConfig } from "./schema.js";

export interface ConfigVersion {
  version: number;
  reason: string;
  createdAt: string;
}

/** A partial config. Objects merge deeply, arrays and scalars replace, `null` removes a key. */
export type ConfigPatch = Record<string, unknown>;

export class ConfigError extends Error {}

/**
 * Owns `config.json` and its version history. Every change is validated, written atomically
 * with owner-only permissions, and recorded as a new version so it can be rolled back.
 */
export class ConfigManager {
  private current: Config;
  private readonly db: Db;
  private readonly file: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly onChange: ((config: Config) => void) | undefined;

  constructor(options: {
    db: Db;
    file: string;
    clock: Clock;
    log: Logger;
    /** Applied only when neither a config file nor a recorded version exists. */
    initial?: ConfigPatch | undefined;
    onChange?: (config: Config) => void;
  }) {
    this.db = options.db;
    this.file = options.file;
    this.clock = options.clock;
    this.log = options.log;
    this.onChange = options.onChange;
    this.current = this.load(options.initial);
    this.onChange?.(this.current);
  }

  get(): Config {
    return structuredClone(this.current);
  }

  update(patch: ConfigPatch, reason: string): { version: number; config: Config } {
    return this.commit(this.preview(patch), reason);
  }

  /** The validated config `patch` would produce, without saving it. Throws ConfigError. */
  preview(patch: ConfigPatch): Config {
    const parsed = configSchema.safeParse(mergePatch(this.current, patch));
    if (!parsed.success) throw new ConfigError(describeIssues(parsed.error));
    return parsed.data;
  }

  /** Saves what `change` returns for a copy of the current config (to replace a whole section). */
  transform(
    change: (config: Config) => Config,
    reason: string,
  ): { version: number; config: Config } {
    const parsed = configSchema.safeParse(change(this.get()));
    if (!parsed.success) throw new ConfigError(describeIssues(parsed.error));
    return this.commit(parsed.data, reason);
  }

  private commit(next: Config, reason: string): { version: number; config: Config } {
    if (isDeepStrictEqual(next, this.current)) {
      return { version: this.latestVersion() ?? 0, config: this.get() };
    }
    const version = this.save(next, reason);
    return { version, config: this.get() };
  }

  /** The number of the newest config version. */
  version(): number {
    return this.latestVersion() ?? 0;
  }

  /** The config as it was recorded in `version`, if there is such a version. */
  at(version: number): Config | undefined {
    const row = one<{ config: string }>(
      this.db,
      "SELECT config FROM config_versions WHERE version = :version",
      { version },
    );
    const parsed = row ? configSchema.safeParse(JSON.parse(row.config)) : undefined;
    return parsed?.success ? parsed.data : undefined;
  }

  history(limit = 20): ConfigVersion[] {
    return all<{ version: number; reason: string; created_at: string }>(
      this.db,
      "SELECT version, reason, created_at FROM config_versions ORDER BY version DESC LIMIT :limit",
      { limit },
    ).map((r) => ({ version: r.version, reason: r.reason, createdAt: r.created_at }));
  }

  /** Restores an earlier version by recording it again as the newest version. */
  rollback(version: number): { version: number; config: Config } {
    const row = one<{ config: string }>(
      this.db,
      "SELECT config FROM config_versions WHERE version = :version",
      { version },
    );
    if (!row) throw new ConfigError(`There is no config version ${version}.`);
    const parsed = configSchema.safeParse(JSON.parse(row.config));
    if (!parsed.success) throw new ConfigError(describeIssues(parsed.error));
    const newVersion = this.save(parsed.data, `rollback to version ${version}`);
    return { version: newVersion, config: this.get() };
  }

  private load(initial: ConfigPatch | undefined): Config {
    const latest = this.latestRecorded();
    if (!existsSync(this.file)) {
      const config = latest ?? configSchema.parse(mergePatch(defaultConfig(), initial ?? {}));
      this.current = config;
      if (latest) {
        this.writeFile(config);
        this.log.warn("config.json was missing; restored the latest recorded version");
      } else {
        this.save(config, "initial");
      }
      return config;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      throw new ConfigError(`${this.file} is not valid JSON: ${(err as Error).message}`);
    }
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(`${this.file} is invalid: ${describeIssues(parsed.error)}`);
    }
    this.current = parsed.data;
    if (!latest || !isDeepStrictEqual(latest, parsed.data)) {
      this.save(parsed.data, latest ? "edited on disk" : "initial");
    }
    return parsed.data;
  }

  private save(config: Config, reason: string): number {
    return transaction(this.db, () => {
      const version = (this.latestVersion() ?? 0) + 1;
      run(
        this.db,
        "INSERT INTO config_versions (version, config, reason, created_at) VALUES (:version, :config, :reason, :at)",
        { version, config: JSON.stringify(config), reason, at: isoNow(this.clock) },
      );
      this.writeFile(config);
      this.current = config;
      this.log.info("config changed", { version, reason });
      this.onChange?.(config);
      return version;
    });
  }

  private writeFile(config: Config): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private latestVersion(): number | undefined {
    return (
      one<{ v: number | null }>(this.db, "SELECT MAX(version) AS v FROM config_versions")?.v ??
      undefined
    );
  }

  private latestRecorded(): Config | undefined {
    const row = one<{ config: string }>(
      this.db,
      "SELECT config FROM config_versions ORDER BY version DESC LIMIT 1",
    );
    if (!row) return undefined;
    const parsed = configSchema.safeParse(JSON.parse(row.config));
    return parsed.success ? parsed.data : undefined;
  }
}

function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.map(String).join(".") : "config"}: ${i.message}`)
    .join("; ");
}

const SECRET_KEY = /token|secret|password|apikey|api_key|key$/i;

/**
 * Every credential-looking string value in the config, for log masking. Everything under a
 * credential-looking key counts, e.g. each value of `contextTokens: { <user>: <token> }`.
 */
export function configSecrets(value: unknown, key = "", secret = false): string[] {
  const isSecret = secret || SECRET_KEY.test(key);
  if (Array.isArray(value)) return value.flatMap((v) => configSecrets(v, key, isSecret));
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([k, v]) => configSecrets(v, k, isSecret));
  }
  return typeof value === "string" && isSecret ? [value] : [];
}

/** A copy of the config safe to show an agent or a Channel: credential values are masked. */
export function maskConfig(value: unknown, key = "", secret = false): unknown {
  const isSecret = secret || SECRET_KEY.test(key);
  if (Array.isArray(value)) return value.map((v) => maskConfig(v, key, isSecret));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskConfig(v, k, isSecret)]),
    );
  }
  if (typeof value === "string" && isSecret) return value ? "(set)" : "";
  return value;
}
