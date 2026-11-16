/**
 * Classifies Claude Code failures into quota, auth and ordinary failures.
 *
 * Sources (checked 2026-11-16 against Claude Code 2.1.325):
 * - Assistant `error` codes and `system/api_retry` categories:
 *   https://code.claude.com/docs/en/agent-sdk/typescript and https://code.claude.com/docs/en/headless
 * - Message texts ("You've hit your session limit · resets 3:45pm", "Request rejected (429)",
 *   "Not logged in · Please run /login", "OAuth token has expired"): https://code.claude.com/docs/en/errors
 * - A recorded logged-out run: assistant `error: "authentication_failed"` followed by a result with
 *   `is_error: true` and `subtype: "success"`.
 *
 * Auth is decided first so a login problem is never reported as quota.
 */
import type { QuotaKind, WorkerEvent } from "../types.js";

type WithoutAt<T> = T extends unknown ? Omit<T, "at"> : never;
export type TerminalDraft = WithoutAt<
  Extract<WorkerEvent, { type: "quota_blocked" | "auth_error" | "failed" | "completed" }>
>;

/** A `rate_limit_event` whose status was `rejected`. */
export interface RejectedLimit {
  rateLimitType?: string;
  resetsAt?: string;
}

const AUTH_CODES = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "cloud_credential_error",
]);
const NON_RETRYABLE_CODES = new Set(["invalid_request", "model_not_found", "max_output_tokens"]);
const TRANSIENT_CODES = new Set(["rate_limit", "overloaded", "server_error"]);

const AUTH_TEXT =
  /not logged in|please run \/login|login expired|authentication required|sign in again|invalid api key|oauth token (?:has expired|revoked)|failed to authenticate|could not resolve authentication|invalid auth token|apikeyhelper script|api error: 40[13]\b|account is on hold|organization has (?:been )?disabled/i;
const SERVER_THROTTLE_TEXT = /not your usage limit|temporarily limiting requests/i;
const SPEND_TEXT =
  /spend limit|shared budget|group's budget|credit balance is too low|usage credits required/i;
const USAGE_TEXT = /you've hit your ([a-z0-9' -]+?) limit/i;
const TRANSIENT_TEXT = /\b429\b|\b529\b|\b50[0-4]\b|overloaded|rate limit|timed? ?out|econnreset/i;

export interface ClassifyInput {
  /** Assistant `error` code, when the CLI gave one. */
  code?: string;
  text: string;
  httpStatus?: number | null;
  rejected?: RejectedLimit;
  now: Date;
  /** Retryability when nothing more specific is known. */
  defaultRetryable: boolean;
}

export function classifyFailure(input: ClassifyInput): TerminalDraft {
  const { code, text, httpStatus, rejected, now } = input;
  const detail = text.trim() || code || "Claude Code reported an error";
  const codeIsVague = code === undefined || code === "unknown";

  if (
    (code !== undefined && AUTH_CODES.has(code)) ||
    (codeIsVague && (AUTH_TEXT.test(text) || httpStatus === 401))
  ) {
    return { type: "auth_error", detail };
  }

  if (
    code === "billing_error" ||
    ((codeIsVague || code === "rate_limit") && SPEND_TEXT.test(text))
  ) {
    return { type: "quota_blocked", bucket: "claude:spend", kind: "spend_limit", detail };
  }

  const mayBeQuota = codeIsVague || code === "rate_limit";
  const usageMatch = mayBeQuota && !SERVER_THROTTLE_TEXT.test(text) ? USAGE_TEXT.exec(text) : null;
  if (usageMatch || (mayBeQuota && rejected && !SERVER_THROTTLE_TEXT.test(text))) {
    const kind: QuotaKind = "usage_limit";
    const bucket = rejected?.rateLimitType
      ? `claude:${rejected.rateLimitType}`
      : bucketForLimitName(usageMatch?.[1] ?? "unknown");
    const resetsAt = rejected?.resetsAt ?? parseResetText(text, now);
    return { type: "quota_blocked", bucket, kind, ...(resetsAt ? { resetsAt } : {}), detail };
  }

  if (
    (code !== undefined && TRANSIENT_CODES.has(code)) ||
    (codeIsVague && (TRANSIENT_TEXT.test(text) || httpStatus === 429 || (httpStatus ?? 0) >= 500))
  ) {
    return { type: "failed", error: detail, retryable: true };
  }

  if (code !== undefined && NON_RETRYABLE_CODES.has(code)) {
    return { type: "failed", error: detail, retryable: false };
  }
  return { type: "failed", error: detail, retryable: input.defaultRetryable };
}

/** Maps a limit name from Claude Code's text to the bucket naming used by `rate_limit_event`. */
export function bucketForLimitName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  if (slug === "session") return "claude:five_hour";
  if (slug === "weekly") return "claude:seven_day";
  return `claude:seven_day_${slug || "unknown"}`;
}

/** Converts a `resetsAt` from Claude Code (epoch seconds, epoch ms or ISO) to ISO. */
export function normaliseResetsAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  return undefined;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RESET_TEXT =
  /resets\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

/**
 * Parses the reset time from texts such as "resets 3:45pm", "resets Mon 12:00am" or
 * "resets Nov 16 at 5:30pm (Europe/London)". Times without a zone are in the machine's local zone,
 * as Claude Code prints them. Returns the next matching instant after `now`, as ISO.
 */
export function parseResetText(text: string, now: Date): string | undefined {
  const m = RESET_TEXT.exec(text);
  if (!m) return undefined;
  const [, weekday, month, day, year, hourText, minuteText, meridiem, zoneText] = m;
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  const zone = zoneText && isValidZone(zoneText) ? zoneText : undefined;
  const today = wallDate(now, zone);

  let t: number;
  if (month && day) {
    const monthIndex = MONTHS.indexOf(month.toLowerCase());
    let y = year ? Number(year) : today.year;
    t = zonedTime(y, monthIndex, Number(day), hour, minute, zone);
    if (!year && t < now.getTime() - 86_400_000) {
      y += 1;
      t = zonedTime(y, monthIndex, Number(day), hour, minute, zone);
    }
  } else {
    let offset = 0;
    if (weekday) {
      const target = WEEKDAYS.indexOf(weekday.toLowerCase());
      offset = (target - today.weekday + 7) % 7;
    }
    t = zonedTime(today.year, today.month, today.day + offset, hour, minute, zone);
    if (t <= now.getTime()) {
      offset += weekday ? 7 : 1;
      t = zonedTime(today.year, today.month, today.day + offset, hour, minute, zone);
    }
  }
  return new Date(t).toISOString();
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface WallDate {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

function wallDate(at: Date, zone: string | undefined): WallDate {
  if (!zone) {
    return {
      year: at.getFullYear(),
      month: at.getMonth(),
      day: at.getDate(),
      weekday: at.getDay(),
    };
  }
  const parts = zoneParts(at.getTime(), zone);
  const weekday = new Date(Date.UTC(parts.year, parts.month, parts.day)).getUTCDay();
  return { year: parts.year, month: parts.month, day: parts.day, weekday };
}

function zoneParts(utcMs: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month") - 1,
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Epoch ms for a wall-clock time in `zone` (or local time when no zone is given). */
function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string | undefined,
): number {
  if (!zone) return new Date(year, month, day, hour, minute).getTime();
  const guess = Date.UTC(year, month, day, hour, minute);
  const offsetAt = (ms: number) => {
    const p = zoneParts(ms, zone);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - ms;
  };
  const first = guess - offsetAt(guess);
  const second = guess - offsetAt(first);
  return second;
}
