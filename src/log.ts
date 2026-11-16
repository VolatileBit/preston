import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type Clock, isoNow } from "./clock.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(component: string): Logger;
}

// Provider token shapes worth masking even when Preston was never told about them.
const TOKEN_PATTERNS: RegExp[] = [
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bxapp-[A-Za-z0-9-]{10,}/g, // Slack app-level
  /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, // Discord bot
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // API keys
];
// More generic shapes: right for a log, too eager for text the user is meant to read.
const GENERIC_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[a-f0-9]{48,}\b/gi, // long hex secrets (IPC and MCP tokens)
];

const MASK = "[redacted]";

/** Masks known secrets and common token shapes. Every log line passes through it. */
export class Redactor {
  private secrets = new Set<string>();

  add(secret: string | undefined): void {
    if (secret && secret.length >= 8) this.secrets.add(secret);
  }

  /** For logs: known secrets and every token shape. */
  redact(text: string): string {
    return this.mask(text, [...TOKEN_PATTERNS, ...GENERIC_PATTERNS]);
  }

  /** For messages to the user: known secrets and provider tokens, but not hashes or Bearer text. */
  redactOutgoing(text: string): string {
    return this.mask(text, TOKEN_PATTERNS);
  }

  private mask(text: string, patterns: RegExp[]): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join(MASK);
    for (const pattern of patterns) out = out.replace(pattern, MASK);
    return out;
  }
}

export interface LoggerOptions {
  dir: string;
  clock: Clock;
  redactor: Redactor;
  /** Also mirror lines to stderr (useful when running the daemon in the foreground). */
  mirror?: boolean;
}

/** Structured JSON-lines logger writing to `<dir>/preston.log`. */
export function createLogger(options: LoggerOptions, component = "preston"): Logger {
  const file = join(options.dir, "preston.log");
  const write = (level: LogLevel, message: string, data?: unknown) => {
    const entry: Record<string, unknown> = { at: isoNow(options.clock), level, component, message };
    if (data !== undefined) entry.data = toLoggable(data);
    const line = `${options.redactor.redact(JSON.stringify(entry))}\n`;
    try {
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // Logging must never take Preston down.
    }
    if (options.mirror) process.stderr.write(line);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (name) => createLogger(options, `${component}.${name}`),
  };
}

function toLoggable(data: unknown): unknown {
  if (data instanceof Error) return { error: data.message, stack: data.stack };
  if (data && typeof data === "object" && "error" in data && data.error instanceof Error) {
    return { ...data, error: data.error.message };
  }
  return data;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
