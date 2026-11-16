import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readLedger, summarize } from "./ledger.js";

/**
 * Builds Preston once, so the agents' `preston mcp` server and the child daemon of the restart
 * scenario run the real compiled executable, and prints the cost summary when the run ends.
 */
export default function setup(): () => void {
  const root = resolve(import.meta.dirname, "..", "..", "..");
  const outDir = join(root, ".preston-test-smoke-dist");
  rmSync(outDir, { recursive: true, force: true });
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", "tsconfig.build.json", "--outDir", outDir],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Building Preston for the smoke tests failed:\n${result.stdout}${result.stderr}`,
    );
  }
  // A ledger for this run only; every test process inherits the path.
  const dir = mkdtempSync(join(tmpdir(), "preston-smoke-run-"));
  const ledger = join(dir, "ledger.jsonl");
  process.env.PRESTON_SMOKE_LEDGER = ledger;
  process.env.PRESTON_SMOKE_CLI = join(outDir, "cli.js");
  return () => {
    const entries = readLedger(ledger);
    process.stdout.write(`${summarize(entries)}\n`);
    // Optional: keep every run's entries, to total the spend over several runs.
    const history = process.env.PRESTON_SMOKE_HISTORY;
    if (history) {
      for (const entry of entries) appendFileSync(history, `${JSON.stringify(entry)}\n`);
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  };
}
