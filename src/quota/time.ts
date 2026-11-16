/** Plain-language times for messages, in the host's local time zone (the user's machine). */

const DAY_MS = 86_400_000;

/** "3:40pm" today, "Tue 3:40pm" within the week, otherwise "Nov 23 3:40pm". */
export function formatResetTime(iso: string, now: number): string {
  const at = new Date(iso);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const time = `${parts.hour}:${parts.minute}${(parts.dayPeriod ?? "").toLowerCase()}`;
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return time;
  if (at.getTime() - now < 6 * DAY_MS) return `${parts.weekday} ${time}`;
  return `${parts.month} ${parts.day} ${time}`;
}
