/**
 * Cron expressions, intervals and one-shot times, evaluated in an IANA time zone.
 *
 * Expressions have five fields (minute hour day-of-month month day-of-week) with lists, ranges,
 * steps, month and weekday names, and the usual `@daily`-style shortcuts. When both day-of-month
 * and day-of-week are restricted, either may match (as in Vixie cron).
 *
 * Daylight saving time:
 * - A wall-clock time that does not exist (the spring-forward gap) runs once, at the moment the
 *   clocks jump.
 * - A wall-clock time that happens twice (the autumn overlap) runs once, the first time.
 */

const MINUTE = 60_000;
export const MIN_INTERVAL_MS = MINUTE;

export class CronError extends Error {}

export type Trigger =
  | { kind: "once"; at: string }
  | { kind: "cron"; expression: string }
  | { kind: "every"; everyMs: number; anchor: string };

// ---- Time zones ------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The wall clock in `timeZone` at instant `ms`, as milliseconds of a naive UTC date. */
export function wallTime(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    (parts.hour ?? 0) % 24,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallTime(whole, timeZone) - whole;
}

/**
 * The first instant at which the wall clock in `timeZone` reads `wall` (a naive UTC date). For a
 * time inside a spring-forward gap, the instant the clocks jump.
 */
export function wallToInstant(wall: number, timeZone: string): number {
  const before = offsetAt(wall - 24 * 3_600_000, timeZone);
  const after = offsetAt(wall + 24 * 3_600_000, timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => wallTime(instant, timeZone) === wall);
  if (valid.length) return Math.min(...valid);
  // In a gap: the first second at which the later offset applies.
  let low = Math.floor((wall - after) / 1000);
  let high = Math.ceil((wall - before) / 1000);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsetAt(mid * 1000, timeZone) === after) high = mid;
    else low = mid + 1;
  }
  return low * 1000;
}

// ---- Cron expressions ------------------------------------------------------------------------

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SHORTCUTS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const parsedCache = new Map<string, CronFields>();

export function parseCron(expression: string): CronFields {
  const cached = parsedCache.get(expression);
  if (cached) return cached;
  const text = SHORTCUTS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `"${expression}" is not a cron expression: it needs five fields (minute hour day-of-month month day-of-week).`,
    );
  }
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const fields: CronFields = {
    minutes: parseField(minute, 0, 59, "minute"),
    hours: parseField(hour, 0, 23, "hour"),
    days: parseField(day, 1, 31, "day of month"),
    months: parseField(month, 1, 12, "month", MONTH_NAMES, 1),
    weekdays: normaliseWeekdays(parseField(weekday, 0, 7, "day of week", WEEKDAY_NAMES, 0)),
    daysRestricted: !/^[*?]/.test(day),
    weekdaysRestricted: !/^[*?]/.test(weekday),
  };
  if (nextWallMatch(fields, Date.UTC(2026, 0, 1)) === undefined) {
    throw new CronError(`"${expression}" never matches a real date.`);
  }
  parsedCache.set(expression, fields);
  return fields;
}

function normaliseWeekdays(set: Set<number>): Set<number> {
  if (set.delete(7)) set.add(0);
  return set;
}

function parseField(
  text: string,
  min: number,
  max: number,
  label: string,
  names: string[] = [],
  nameBase = 0,
): Set<number> {
  const out = new Set<number>();
  const value = (raw: string): number => {
    const named = names.indexOf(raw.toLowerCase());
    const n = named >= 0 ? named + nameBase : /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new CronError(`"${raw}" is not a valid ${label} (${min}-${max}).`);
    }
    return n;
  };
  for (const item of text.split(",")) {
    const [range, stepText, extra] = item.split("/");
    if (extra !== undefined || range === undefined || range === "") {
      throw new CronError(`"${item}" is not a valid ${label}.`);
    }
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`"${item}" has a bad step.`);
    let from: number;
    let to: number;
    if (range === "*" || range === "?") {
      from = min;
      to = max;
      if (label === "day of week") to = 6;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      from = value(a ?? "");
      to = value(b ?? "");
      if (from > to) throw new CronError(`"${item}" runs backwards.`);
    } else {
      from = value(range);
      to = stepText === undefined ? from : max;
    }
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out;
}

/** The first wall-clock minute at or after `wall` (naive UTC ms) that matches, if any within 8 years. */
function nextWallMatch(fields: CronFields, wall: number): number | undefined {
  const limit = wall + 8 * 366 * 86_400_000;
  let t = Math.ceil(wall / MINUTE) * MINUTE;
  while (t < limit) {
    const d = new Date(t);
    if (!fields.months.has(d.getUTCMonth() + 1)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    const dayOk = fields.days.has(d.getUTCDate());
    const weekdayOk = fields.weekdays.has(d.getUTCDay());
    const matchesDay =
      fields.daysRestricted && fields.weekdaysRestricted
        ? dayOk || weekdayOk
        : (!fields.daysRestricted || dayOk) && (!fields.weekdaysRestricted || weekdayOk);
    if (!matchesDay) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!fields.hours.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!fields.minutes.has(d.getUTCMinutes())) {
      t += MINUTE;
      continue;
    }
    return t;
  }
  return undefined;
}

function nextCron(expression: string, timeZone: string, after: number): number | undefined {
  const fields = parseCron(expression);
  let wall = wallTime(after, timeZone);
  for (let attempt = 0; attempt < 8; attempt++) {
    const match = nextWallMatch(fields, wall - (wall % MINUTE) + MINUTE);
    if (match === undefined) return undefined;
    const instant = wallToInstant(match, timeZone);
    if (instant > after) return instant;
    // The first occurrence of an overlapped time already passed; look further ahead.
    wall = match;
  }
  return undefined;
}

// ---- Triggers --------------------------------------------------------------------------------

/** The first occurrence strictly after `after` (epoch ms), or undefined when there is none. */
export function nextOccurrence(
  trigger: Trigger,
  timeZone: string,
  after: number,
): number | undefined {
  switch (trigger.kind) {
    case "once": {
      const at = Date.parse(trigger.at);
      return at > after ? at : undefined;
    }
    case "every": {
      const anchor = Date.parse(trigger.anchor);
      if (after < anchor) return anchor + trigger.everyMs;
      return anchor + (Math.floor((after - anchor) / trigger.everyMs) + 1) * trigger.everyMs;
    }
    case "cron":
      return nextCron(trigger.expression, timeZone, after);
  }
}

/** Every occurrence in (`after`, `until`], oldest first, at most `cap`. */
export function occurrencesBetween(
  trigger: Trigger,
  timeZone: string,
  after: number,
  until: number,
  cap = 10_000,
): number[] {
  const out: number[] = [];
  let cursor = after;
  while (out.length < cap) {
    const next = nextOccurrence(trigger, timeZone, cursor);
    if (next === undefined || next > until) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

const INTERVAL = /^(?:every\s+)?(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i;

/** Parses "30m", "every 2 hours", "1d". */
export function parseInterval(text: string): number {
  const match = INTERVAL.exec(text.trim());
  if (!match) throw new CronError(`"${text}" is not an interval like "30m", "2h" or "1d".`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase()[0];
  const ms = amount * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : MINUTE);
  if (ms < MIN_INTERVAL_MS) throw new CronError("The shortest repeat is every minute.");
  return ms;
}

const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/** An ISO time with an offset or Z, or a local time (no offset) read in `timeZone`. */
export function parseInstant(text: string, timeZone: string): number {
  const trimmed = text.trim();
  if (NAIVE_ISO.test(trimmed)) {
    const naive = Date.parse(`${trimmed.replace(" ", "T")}Z`);
    if (Number.isNaN(naive)) throw new CronError(`"${text}" is not a valid date and time.`);
    return wallToInstant(naive, timeZone);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    throw new CronError(
      `"${text}" is not a date and time like 2026-11-20T09:00 (with an offset such as +08:00 or Z, or in the schedule's time zone).`,
    );
  }
  return at;
}

/** Builds a Trigger from what the Coordinator supplies; exactly one of the three. */
export function buildTrigger(
  input: { at?: string | undefined; cron?: string | undefined; every?: string | undefined },
  timeZone: string,
  now: number,
): Trigger {
  const given = [input.at, input.cron, input.every].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new CronError(
      "Give exactly one of: at (one time), cron (a pattern) or every (a repeat).",
    );
  }
  if (input.at !== undefined) {
    const at = parseInstant(input.at, timeZone);
    if (at <= now) throw new CronError("That time has already passed.");
    return { kind: "once", at: new Date(at).toISOString() };
  }
  if (input.every !== undefined) {
    return {
      kind: "every",
      everyMs: parseInterval(input.every),
      anchor: new Date(now).toISOString(),
    };
  }
  const expression = (input.cron as string).trim();
  parseCron(expression);
  return { kind: "cron", expression };
}

export function describeTrigger(trigger: Trigger, timeZone: string): string {
  switch (trigger.kind) {
    case "once":
      return `once, ${formatLocal(Date.parse(trigger.at), timeZone)}`;
    case "cron":
      return `cron "${trigger.expression}" (${timeZone})`;
    case "every": {
      const minutes = trigger.everyMs / MINUTE;
      if (minutes % 1440 === 0) return `every ${minutes / 1440} day(s)`;
      if (minutes % 60 === 0) return `every ${minutes / 60} hour(s)`;
      return `every ${minutes} minute(s)`;
    }
  }
}

/** A plain local time such as "Tue 17 Nov, 09:00". */
export function formatLocal(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}
