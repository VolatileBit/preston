import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every real agent turn the smoke run makes, so the run can print what it cost. */
export interface TurnRecord {
  kind: "turn";
  scenario: string;
  provider: string;
  role: "coordinator" | "worker";
  wallMs: number;
  /** How the turn ended: completed, quota_blocked, failed, ... */
  end: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface ScenarioRecord {
  kind: "scenario";
  scenario: string;
  provider: string;
  status: "pass" | "fail" | "skipped";
  wallMs: number;
  note?: string;
}

export type LedgerEntry = TurnRecord | ScenarioRecord;

export function ledgerPath(): string {
  return process.env.PRESTON_SMOKE_LEDGER ?? join(tmpdir(), "preston-smoke-ledger.jsonl");
}

export function record(entry: LedgerEntry): void {
  appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`);
}

export function readLedger(path = ledgerPath()): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

const sum = (values: (number | undefined)[]) => values.reduce<number>((a, b) => a + (b ?? 0), 0);

/** A plain-text cost summary: turns, tokens and cost per scenario and provider. */
export function summarize(entries: LedgerEntry[]): string {
  const turns = entries.filter((e): e is TurnRecord => e.kind === "turn");
  const scenarios = entries.filter((e): e is ScenarioRecord => e.kind === "scenario");
  const lines: string[] = ["", "Smoke run summary", "================="];
  const keys = [...new Set(scenarios.map((s) => `${s.scenario}\t${s.provider}`))];
  for (const key of keys) {
    const [scenario, provider] = key.split("\t") as [string, string];
    const result = scenarios
      .filter((s) => s.scenario === scenario && s.provider === provider)
      .at(-1);
    const own = turns.filter((t) => t.scenario === scenario && t.provider === provider);
    const coordinator = own.filter((t) => t.role === "coordinator");
    const tokens = (t: TurnRecord[]) =>
      sum(t.map((x) => (x.inputTokens ?? 0) + (x.outputTokens ?? 0) + (x.cachedInputTokens ?? 0)));
    const total = tokens(own);
    const share = total > 0 ? `${Math.round((tokens(coordinator) / total) * 100)}%` : "n/a";
    lines.push(
      `${(result?.status ?? "?").toUpperCase().padEnd(7)} ${scenario.padEnd(22)} ${provider.padEnd(7)}` +
        ` turns=${own.length} (coordinator ${coordinator.length}, worker ${own.length - coordinator.length})` +
        ` tokens=${total} coordinator-share=${share} cost=$${sum(own.map((t) => t.costUsd)).toFixed(4)}` +
        ` wall=${Math.round((result?.wallMs ?? 0) / 1000)}s${result?.note ? ` (${result.note})` : ""}`,
    );
  }
  for (const provider of [...new Set(turns.map((t) => t.provider))]) {
    const own = turns.filter((t) => t.provider === provider);
    lines.push(
      `TOTAL   ${provider}: ${own.length} real agent turns, ` +
        `tokens=${sum(own.map((t) => (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cachedInputTokens ?? 0)))}, ` +
        `cost=$${sum(own.map((t) => t.costUsd)).toFixed(4)}`,
    );
  }
  lines.push(
    "(tokens: input + output + cached input as each CLI reports them; cost only where the CLI reports one)",
  );
  return lines.join("\n");
}
