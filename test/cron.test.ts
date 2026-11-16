import { describe, expect, test } from "vitest";
import {
  buildTrigger,
  CronError,
  nextOccurrence,
  occurrencesBetween,
  parseCron,
  parseInterval,
  parseInstant,
  type Trigger,
} from "../src/schedule/cron.js";

const cron = (expression: string): Trigger => ({ kind: "cron", expression });
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const next = (expression: string, tz: string, after: string) =>
  iso(nextOccurrence(cron(expression), tz, Date.parse(after)));

describe("cron expressions", () => {
  test("matches lists, ranges, steps, names and shortcuts", () => {
    expect(next("*/15 * * * *", "UTC", "2026-11-16T09:07:00Z")).toBe("2026-11-16T09:15:00.000Z");
    expect(next("0 9 * * mon-fri", "UTC", "2026-11-20T10:00:00Z")).toBe("2026-11-23T09:00:00.000Z");
    expect(next("30 8,17 * * *", "UTC", "2026-11-16T09:00:00Z")).toBe("2026-11-16T17:30:00.000Z");
    expect(next("0 0 1 jan *", "UTC", "2026-11-16T09:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
    expect(next("@hourly", "UTC", "2026-11-16T09:00:00Z")).toBe("2026-11-16T10:00:00.000Z");
    expect(next("0 12 * * 7", "UTC", "2026-11-16T09:00:00Z")).toBe("2026-11-22T12:00:00.000Z");
  });

  test("an occurrence is strictly after the given time", () => {
    expect(next("0 9 * * *", "UTC", "2026-11-16T09:00:00Z")).toBe("2026-11-17T09:00:00.000Z");
    expect(next("0 9 * * *", "UTC", "2026-11-16T08:59:59.999Z")).toBe("2026-11-16T09:00:00.000Z");
  });

  test("restricted day-of-month and day-of-week match either, as in Vixie cron", () => {
    // The 1st, or any Monday.
    expect(next("0 0 1 * 1", "UTC", "2026-11-16T09:00:00Z")).toBe("2026-11-23T00:00:00.000Z");
    expect(next("0 0 1 * 1", "UTC", "2026-11-29T09:00:00Z")).toBe("2026-11-30T00:00:00.000Z");
    expect(next("0 0 1 * 1", "UTC", "2026-11-30T09:00:00Z")).toBe("2026-12-01T00:00:00.000Z");
  });

  test("reads the expression in the schedule's time zone", () => {
    expect(next("0 9 * * *", "Asia/Shanghai", "2026-11-16T00:00:00Z")).toBe(
      "2026-11-16T01:00:00.000Z",
    );
    expect(next("0 9 * * *", "America/Los_Angeles", "2026-11-16T00:00:00Z")).toBe(
      "2026-11-16T17:00:00.000Z",
    );
  });

  test("rejects bad expressions with a plain reason", () => {
    expect(() => parseCron("* * * *")).toThrow(CronError);
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
    expect(() => parseCron("0 0 31 2 *")).toThrow(/never matches/);
    expect(() => parseCron("0 5-1 * * *")).toThrow(/backwards/);
    expect(() => parseCron("0 0 * * funday")).toThrow(CronError);
  });
});

describe("daylight saving time", () => {
  test("a daily local time keeps its wall-clock hour across the autumn change in London", () => {
    const times = occurrencesBetween(
      cron("0 9 * * *"),
      "Europe/London",
      Date.parse("2026-10-23T12:00:00Z"),
      Date.parse("2026-10-27T12:00:00Z"),
    ).map(iso);
    expect(times).toEqual([
      "2026-10-24T08:00:00.000Z", // BST
      "2026-10-25T09:00:00.000Z", // clocks went back at 01:00Z
      "2026-10-26T09:00:00.000Z",
      "2026-10-27T09:00:00.000Z",
    ]);
  });

  test("a time inside the spring-forward gap runs once, when the clocks jump", () => {
    const times = occurrencesBetween(
      cron("30 2 * * *"),
      "America/New_York",
      Date.parse("2026-03-07T00:00:00Z"),
      Date.parse("2026-03-10T00:00:00Z"),
    ).map(iso);
    expect(times).toEqual([
      "2026-03-07T07:30:00.000Z", // 02:30 EST
      "2026-03-08T07:00:00.000Z", // 02:30 does not exist; 03:00 EDT
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
    ]);
  });

  test("several times inside the gap collapse to one run", () => {
    const times = occurrencesBetween(
      cron("0,30 2 * * *"),
      "America/New_York",
      Date.parse("2026-03-08T00:00:00Z"),
      Date.parse("2026-03-08T12:00:00Z"),
    ).map(iso);
    expect(times).toEqual(["2026-03-08T07:00:00.000Z"]);
  });

  test("a time that happens twice in the autumn overlap runs once, the first time", () => {
    const times = occurrencesBetween(
      cron("30 1 * * *"),
      "America/New_York",
      Date.parse("2026-10-31T12:00:00Z"),
      Date.parse("2026-11-03T12:00:00Z"),
    ).map(iso);
    expect(times).toEqual([
      "2026-11-01T05:30:00.000Z", // 01:30 EDT
      "2026-11-02T06:30:00.000Z", // 01:30 EST on the 2nd; the repeat on the 1st is skipped
      "2026-11-03T06:30:00.000Z",
    ]);
    // Asked from inside the repeated hour, the next run is still the following day.
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T06:10:00Z")).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });

  test("hourly jobs run once per real hour through the overlap", () => {
    const times = occurrencesBetween(
      cron("0 * * * *"),
      "America/New_York",
      Date.parse("2026-11-01T04:30:00Z"),
      Date.parse("2026-11-01T08:30:00Z"),
    ).map(iso);
    expect(times).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T06:00:00.000Z", // the second 01:00, which hourly jobs keep
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
    ]);
  });
});

describe("intervals and single times", () => {
  test("an interval counts from its anchor", () => {
    const trigger: Trigger = {
      kind: "every",
      everyMs: parseInterval("every 30 minutes"),
      anchor: "2026-11-16T09:00:00.000Z",
    };
    expect(iso(nextOccurrence(trigger, "UTC", Date.parse("2026-11-16T09:00:00Z")))).toBe(
      "2026-11-16T09:30:00.000Z",
    );
    expect(iso(nextOccurrence(trigger, "UTC", Date.parse("2026-11-16T09:31:00Z")))).toBe(
      "2026-11-16T10:00:00.000Z",
    );
    expect(parseInterval("2h")).toBe(7_200_000);
    expect(parseInterval("1d")).toBe(86_400_000);
    expect(() => parseInterval("30s")).toThrow(CronError);
    expect(() => parseInterval("soon")).toThrow(CronError);
  });

  test("a single time with no offset is read in the schedule's time zone", () => {
    expect(iso(parseInstant("2026-11-20T09:00", "Asia/Shanghai"))).toBe("2026-11-20T01:00:00.000Z");
    expect(iso(parseInstant("2026-11-20T09:00:00+02:00", "Asia/Shanghai"))).toBe(
      "2026-11-20T07:00:00.000Z",
    );
    expect(() => parseInstant("tomorrow", "UTC")).toThrow(CronError);
  });

  test("a trigger needs exactly one kind, and a single time must be in the future", () => {
    const now = Date.parse("2026-11-16T09:00:00Z");
    expect(() => buildTrigger({}, "UTC", now)).toThrow(/exactly one/);
    expect(() => buildTrigger({ at: "2026-11-16T08:00:00Z" }, "UTC", now)).toThrow(/passed/);
    expect(buildTrigger({ at: "2026-11-16T10:00:00Z" }, "UTC", now)).toEqual({
      kind: "once",
      at: "2026-11-16T10:00:00.000Z",
    });
  });
});
