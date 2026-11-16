import type {
  ApprovalDecision,
  ApprovalRequest,
  ModelInfo,
  QuotaKind,
  QuotaReading,
} from "../types.js";
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

export interface NormalisedApproval {
  request: ApprovalRequest;
  /** The JSON-RPC result that answers the App Server for this decision. */
  result(decision: ApprovalDecision): unknown;
  /** Whether the answer itself tells the agent why it was declined (only the legacy methods). */
  carriesReason: boolean;
}

const withReason = (summary: string, reason: unknown) =>
  typeof reason === "string" && reason ? `${summary} (reason: ${reason})` : summary;

const v2Decision = (decision: ApprovalDecision) => ({
  decision: decision.allow ? "accept" : "decline",
});

const legacyDecision = (decision: ApprovalDecision) => ({
  decision: decision.allow ? "approved" : { denied: { rejection: decision.reason } },
});

/**
 * Turns a server→client approval request into Preston's ApprovalRequest. Returns undefined for
 * methods that are not approvals. `fileChangePaths` holds paths seen on `fileChange` items.
 */
export function normaliseApproval(
  method: string,
  raw: unknown,
  fileChangePaths: ReadonlyMap<string, string[]>,
): NormalisedApproval | undefined {
  const params = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = str(params.command);
      const cwd = str(params.cwd);
      const network = params.networkApprovalContext as
        | { host?: string; protocol?: string }
        | null
        | undefined;
      if (network?.host) {
        return {
          request: {
            kind: "network",
            summary: withReason(`Network access to ${network.host}`, params.reason),
            ...(command ? { command } : {}),
            ...(cwd ? { cwd } : {}),
          },
          result: v2Decision,
          carriesReason: false,
        };
      }
      const summary =
        params.kind === "writeStdin"
          ? "Send input to a running command"
          : `Run command: ${command ?? "(unknown)"}`;
      return {
        request: {
          kind: "command",
          summary: withReason(summary, params.reason),
          ...(command ? { command } : {}),
          ...(cwd ? { cwd } : {}),
        },
        result: v2Decision,
        carriesReason: false,
      };
    }
    case "item/fileChange/requestApproval": {
      const grantRoot = str(params.grantRoot);
      const paths = [...(fileChangePaths.get(String(params.itemId)) ?? [])];
      if (grantRoot) paths.push(grantRoot);
      const summary = grantRoot
        ? `Allow writes under ${grantRoot}`
        : `Apply changes to ${paths.length || "some"} file(s)`;
      return {
        request: { kind: "file_change", summary: withReason(summary, params.reason), paths },
        result: v2Decision,
        carriesReason: false,
      };
    }
    case "item/permissions/requestApproval": {
      const requested = (params.permissions ?? {}) as {
        network?: { enabled?: boolean | null } | null;
        fileSystem?: { read?: string[] | null; write?: string[] | null } | null;
      };
      const parts: string[] = [];
      if (requested.network?.enabled) parts.push("network access");
      const write = requested.fileSystem?.write ?? [];
      const read = requested.fileSystem?.read ?? [];
      if (write.length) parts.push(`write access to ${write.join(", ")}`);
      if (read.length) parts.push(`read access to ${read.join(", ")}`);
      const kind = requested.network?.enabled
        ? "network"
        : requested.fileSystem
          ? "file_change"
          : "other";
      const cwd = str(params.cwd);
      return {
        request: {
          kind,
          summary: withReason(
            `Grant additional permissions: ${parts.join("; ") || "unspecified"}`,
            params.reason,
          ),
          ...(cwd ? { cwd } : {}),
          paths: [...write, ...read],
        },
        result: (decision) => ({
          permissions: decision.allow
            ? {
                ...(requested.network ? { network: requested.network } : {}),
                ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
              }
            : {},
          scope: "turn",
        }),
        carriesReason: false,
      };
    }
    case "execCommandApproval": {
      const argv = Array.isArray(params.command) ? params.command.map(String) : [];
      const command = argv.join(" ");
      const cwd = str(params.cwd);
      return {
        request: {
          kind: "command",
          summary: withReason(`Run command: ${command || "(unknown)"}`, params.reason),
          ...(command ? { command } : {}),
          ...(cwd ? { cwd } : {}),
        },
        result: legacyDecision,
        carriesReason: true,
      };
    }
    case "applyPatchApproval": {
      const paths = Object.keys((params.fileChanges ?? {}) as object);
      return {
        request: {
          kind: "file_change",
          summary: withReason(`Apply changes to ${paths.length} file(s)`, params.reason),
          paths,
        },
        result: legacyDecision,
        carriesReason: true,
      };
    }
    default:
      return undefined;
  }
}
