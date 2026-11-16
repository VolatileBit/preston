/**
 * Token-free quota read: Claude Code's `/usage` command sent as stream-json input.
 *
 * Confirmed with a recorded 2.1.325 run: `/usage` is a local command. It produces an assistant
 * message from the `<synthetic>` model with zero tokens, `num_turns: 0`, `duration_api_ms: 0` and
 * `total_cost_usd: 0`, and carries a structured `usage_report.rate_limits.limits` array
 * (`kind`, `percent`, `resets_at`, `scope`). Accounts without plan limits (API keys) report none.
 */
import type { QuotaReading } from "../types.js";
import { bucketForLimitName, normaliseResetsAt } from "./classify.js";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Maps `/usage` limit kinds to the bucket names `rate_limit_event.rateLimitType` uses. */
function bucketFor(limit: Json): string {
  const kind = typeof limit.kind === "string" ? limit.kind : "unknown";
  if (kind === "session") return "claude:five_hour";
  if (kind === "weekly_all") return "claude:seven_day";
  const scope = isObject(limit.scope) ? limit.scope : {};
  const model = isObject(scope.model) ? scope.model : {};
  if (typeof model.display_name === "string") return bucketForLimitName(model.display_name);
  return `claude:${kind}`;
}

/** Extracts readings from a `/usage` assistant message, or undefined if it has no usage report. */
export function readingsFromUsageMessage(
  message: Json,
  checkedAt: string,
): QuotaReading[] | undefined {
  const report = isObject(message.usage_report) ? message.usage_report : undefined;
  if (!report) return undefined;
  const rateLimits = isObject(report.rate_limits) ? report.rate_limits : {};
  const limits = Array.isArray(rateLimits.limits) ? rateLimits.limits.filter(isObject) : [];
  return limits.map((limit) => {
    const percent =
      typeof limit.percent === "number" && Number.isFinite(limit.percent)
        ? limit.percent
        : undefined;
    const resetsAt = normaliseResetsAt(limit.resets_at);
    return {
      bucket: bucketFor(limit),
      available: percent === undefined ? "unknown" : percent < 100,
      ...(percent === undefined ? {} : { usedPercent: percent }),
      ...(resetsAt ? { resetsAt } : {}),
      checkedAt,
    };
  });
}
