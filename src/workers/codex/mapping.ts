import type { ModelInfo, QuotaKind, QuotaReading } from "../types.js";
import type {
  GetAccountRateLimitsResponse,
  Model,
  RateLimitSnapshot,
  RateLimitWindow,
  TurnError,
} from "./protocol.js";

export type TerminalFailure =
  | { type: "quota_blocked"; bucket: string; kind: QuotaKind; resetsAt?: string; detail?: string }
  | { type: "auth_error"; detail: string }
  | { type: "failed"; error: string; retryable: boolean };

const WINDOWS = ["primary", "secondary"] as const;

/** `codex:primary` for the account-wide limit; other metered limits keep their own id. */
export function bucketName(limitId: string | null | undefined, window: string): string {
  return !limitId || limitId === "codex" ? `codex:${window}` : `codex:${limitId}:${window}`;
}

function isoFromUnixSeconds(seconds: number | null | undefined): string | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : undefined;
}

function errorInfoName(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  if (info && typeof info === "object") return Object.keys(info)[0];
  return undefined;
}

function httpStatus(info: unknown): number | undefined {
  if (!info || typeof info !== "object") return undefined;
  const inner = Object.values(info)[0] as { httpStatusCode?: unknown } | undefined;
  return typeof inner?.httpStatusCode === "number" ? inner.httpStatusCode : undefined;
}

function isSpendLimit(snapshot: RateLimitSnapshot): boolean {
  return (
    snapshot.spendControlReached === true ||
    (snapshot.rateLimitReachedType ?? "").includes("credits_depleted")
  );
}

/**
 * Picks the window that blocks work: an exhausted one (the latest reset if several, since all must
 * reset), otherwise the fullest one. Without any snapshot, falls back to `codex:primary`.
 */
export function blockingWindow(snapshots: Iterable<RateLimitSnapshot>): {
  bucket: string;
  resetsAt?: string;
  kind: QuotaKind;
} {
  const blocksMore = (a: RateLimitWindow, b: RateLimitWindow) => {
    const aFull = a.usedPercent >= 100;
    if (aFull !== b.usedPercent >= 100) return aFull;
    return aFull ? (a.resetsAt ?? 0) > (b.resetsAt ?? 0) : a.usedPercent > b.usedPercent;
  };
  let best: { snapshot: RateLimitSnapshot; name: string; window: RateLimitWindow } | undefined;
  for (const snapshot of snapshots) {
    for (const name of WINDOWS) {
      const window = snapshot[name];
      if (window && (!best || blocksMore(window, best.window))) best = { snapshot, name, window };
    }
  }
  if (!best) return { bucket: "codex:primary", kind: "usage_limit" };
  const resetsAt = isoFromUnixSeconds(best.window.resetsAt);
  return {
    bucket: bucketName(best.snapshot.limitId, best.name),
    kind: isSpendLimit(best.snapshot) ? "spend_limit" : "usage_limit",
    ...(resetsAt ? { resetsAt } : {}),
  };
}

const NOT_RETRYABLE = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "modelNotFound",
  "badRequest",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "inferenceHookDenied",
  "tooManyDenials",
  "sandboxError",
  "threadRollbackFailed",
]);

/**
 * Classifies a failed turn. Plan exhaustion, request-rate limits and authentication problems are
 * kept apart, because Preston waits for the first two and asks the user about the third.
 */
export function classifyTurnError(
  error: TurnError | null | undefined,
  snapshots: Iterable<RateLimitSnapshot>,
): TerminalFailure {
  const message = error?.message || "Codex turn failed";
  const detail = error?.additionalDetails ? `${message} (${error.additionalDetails})` : message;
  const info = error?.codexErrorInfo;
  const name = errorInfoName(info);
  const status = httpStatus(info);

  if (name === "unauthorized" || status === 401) {
    return {
      type: "auth_error",
      detail: `Codex is not signed in or its login expired: ${detail}`,
    };
  }
  if (name === "usageLimitExceeded") {
    return { type: "quota_blocked", ...blockingWindow(snapshots), detail };
  }
  if (name === "rateLimitExceeded" || status === 429) {
    return { type: "quota_blocked", bucket: "codex:rate_limit", kind: "rate_limit", detail };
  }
  return { type: "failed", error: detail, retryable: !(name && NOT_RETRYABLE.has(name)) };
}

/**
 * Maps `account/rateLimits/read` to one reading per metered window. A window is unavailable when
 * it is full, the backend says the limit is reached, or ordinary usage is not allowed.
 */
export function quotaReadings(
  response: GetAccountRateLimitsResponse | null | undefined,
  checkedAt: string,
): QuotaReading[] {
  if (!response) return [];
  const byId = Object.values(response.rateLimitsByLimitId ?? {}).filter(
    (s): s is RateLimitSnapshot => !!s,
  );
  const snapshots = byId.length > 0 ? byId : response.rateLimits ? [response.rateLimits] : [];
  const readings: QuotaReading[] = [];
  for (const snapshot of snapshots) {
    const limitReached = !!snapshot.rateLimitReachedType || snapshot.spendControlReached === true;
    for (const name of WINDOWS) {
      const window = snapshot[name];
      if (!window) continue;
      const resetsAt = isoFromUnixSeconds(window.resetsAt);
      const exhausted =
        window.usedPercent >= 100 || response.ordinaryUsageAllowed === false || limitReached;
      readings.push({
        bucket: bucketName(snapshot.limitId, name),
        available: !exhausted,
        usedPercent: window.usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
        checkedAt,
      });
    }
  }
  return readings;
}

export function toModelInfo(model: Model): ModelInfo {
  const efforts = model.supportedReasoningEfforts?.map((e) => e.reasoningEffort);
  return {
    id: model.model || model.id,
    ...(model.displayName ? { displayName: model.displayName } : {}),
    ...(efforts?.length ? { efforts } : {}),
    isDefault: model.isDefault === true,
  };
}

export interface ApprovalAnswer {
  /** The JSON-RPC result that answers the App Server. */
  result: unknown;
  /** Whether the answer itself tells the agent why it was declined (only the legacy methods). */
  carriesReason: boolean;
}

/**
 * Answers a server→client approval request. Preston starts Codex so it should not ask (full
 * access never asks, tools-only has nothing to ask for); this keeps an unexpected ask from
 * hanging the turn. Returns undefined for methods that are not approvals.
 */
export function answerApproval(
  method: string,
  raw: unknown,
  allow: boolean,
  reason: string,
): ApprovalAnswer | undefined {
  const params = (raw ?? {}) as Record<string, unknown>;
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: allow ? "accept" : "decline" }, carriesReason: false };
    case "item/permissions/requestApproval": {
      const requested = (params.permissions ?? {}) as { network?: unknown; fileSystem?: unknown };
      return {
        result: {
          permissions: allow
            ? {
                ...(requested.network ? { network: requested.network } : {}),
                ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
              }
            : {},
          scope: "turn",
        },
        carriesReason: false,
      };
    }
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        result: { decision: allow ? "approved" : { denied: { rejection: reason } } },
        carriesReason: true,
      };
    default:
      return undefined;
  }
}
