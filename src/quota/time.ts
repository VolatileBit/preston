import { language } from "../i18n/index.js";

/** Plain-language times for messages, in the host's local time zone (the user's machine). */

const DAY_MS = 86_400_000;

/** "3:40pm" today, "Tue 3:40pm" within the week, otherwise "Nov 23 3:40pm". */
export function formatResetTime(iso: string, now: number): string {
  const at = new Date(iso);
  if (language() === "zh-CN") return formatResetTimeZh(at, now);
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

/** "15:40" today, "周二 15:40" within the week, otherwise "11月23日 15:40". */
function formatResetTimeZh(at: Date, now: number): string {
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  if (at.toDateString() === new Date(now).toDateString()) return time;
  if (at.getTime() - now < 6 * DAY_MS) {
    return `${new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(at)} ${time}`;
  }
  return `${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(at)} ${time}`;
}
