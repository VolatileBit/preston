/**
 * The parts of the Codex App Server protocol (v2) that Preston reads, checked against
 * `codex app-server generate-ts` for codex-cli 0.169.0. Fields Preston ignores are omitted;
 * everything is treated as possibly missing because the CLI updates itself.
 */

export interface TurnError {
  message?: string;
  /** A string such as "usageLimitExceeded", or an object such as `{ httpConnectionFailed: { httpStatusCode } }`. */
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

export interface Turn {
  id: string;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  error?: TurnError | null;
  items?: ThreadItem[];
}

export interface ThreadItem {
  type: string;
  id: string;
  text?: string;
  phase?: string | null;
  command?: string;
  cwd?: string;
  server?: string;
  tool?: string;
  query?: string;
  changes?: { path: string }[];
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  /** Unix seconds. */
  resetsAt?: number | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  spendControlReached?: boolean | null;
  rateLimitReachedType?: string | null;
}

export interface GetAccountRateLimitsResponse {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null;
}

export interface TokenUsageBreakdown {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface Model {
  id: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
}

export interface ModelListResponse {
  data?: Model[];
  nextCursor?: string | null;
}
