import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The built `preston` executable (dist/cli.js equivalent), for process-level tests. */
    cliPath: string;
  }
}

/** Builds Preston once into `.preston-test-dist/` so tests can run the real executable. */
export default function setup(project: TestProject): () => void {
  const root = resolve(import.meta.dirname, "..", "..");
  const outDir = join(root, ".preston-test-dist");
  rmSync(outDir, { recursive: true, force: true });
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", "tsconfig.build.json", "--outDir", outDir],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(`Building Preston for tests failed:\n${result.stdout}${result.stderr}`);
  }
  project.provide("cliPath", join(outDir, "cli.js"));
  return () => rmSync(outDir, { recursive: true, force: true });
}
