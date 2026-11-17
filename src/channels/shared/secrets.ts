import type { ChannelContext } from "../types.js";

/** Shows only enough of a token for the user to recognise it, e.g. `xoxb-…a1b2`. */
export function maskSecret(secret: string): string {
  const kind = /^(xox[a-z]|xapp)-/.exec(secret)?.[0] ?? "";
  return secret.length <= 8 ? "****" : `${kind}…${secret.slice(-4)}`;
}

/** Token shapes masked even when they are not one of the configured secrets. */
const TOKEN_PATTERNS = [
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
  /\bxapp-[A-Za-z0-9-]{8,}/g,
  // Discord bot tokens: base64 user id, timestamp and HMAC separated by dots.
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}\b/g,
];

export type Redactor = (text: string) => string;

/** Builds a function that masks the current secrets, plus anything token-shaped, in text. */
export function createRedactor(secrets: () => ReadonlyArray<string | undefined>): Redactor {
  return (text) => {
    let out = text;
    for (const secret of secrets()) {
      if (secret && secret.length >= 8) out = out.split(secret).join(maskSecret(secret));
    }
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, (token) => maskSecret(token));
    return out;
  };
}

export type ChannelLogger = ChannelContext["log"];

/**
 * Wraps a log sink so messages and data are redacted before they leave the Channel.
 * Data is reduced to plain JSON (errors to name, message and code) so nothing unredacted
 * can hide in object fields.
 */
export function redactingLogger(
  sink: () => ChannelLogger | undefined,
  redact: Redactor,
): ChannelLogger {
  return (level, message, data) => {
    const log = sink();
    if (!log) return;
    if (data === undefined) log(level, redact(message));
    else log(level, redact(message), redactData(data, redact));
  };
}

function redactData(data: unknown, redact: Redactor): unknown {
  try {
    const json = JSON.stringify(data, (_key, value: unknown) =>
      value instanceof Error ? describeError(value) : value,
    );
    return json === undefined ? undefined : (JSON.parse(redact(json)) as unknown);
  } catch {
    return redact(String(data));
  }
}

function describeError(error: Error): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  const status = (error as { status?: unknown }).status;
  return { name: error.name, message: error.message, code, status };
}

/** Plain-language, redacted text for an unexpected error. */
export function errorText(error: unknown, redact: Redactor): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message).slice(0, 300);
}

/**
 * The technical cause of a failed call (error name, code, and the code of what caused it), for
 * the log only: the plain-language `detail` shown to users hides what actually went wrong.
 */
export function failureCause(error: unknown, redact: Redactor): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    parts.push(
      `${current.name}${code === undefined ? "" : `[${String(code)}]`}: ${current.message}`,
    );
    current = current.cause;
  }
  return redact(parts.join(" <- ")).slice(0, 500);
}
