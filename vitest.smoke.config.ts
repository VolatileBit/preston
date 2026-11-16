import { defineConfig } from "vitest/config";

/**
 * Real-provider smoke tests (`npm run smoke`). They drive the user's installed Claude Code and
 * Codex CLIs, consume real quota, and never run as part of `npm run check` or CI: the default
 * `vitest.config.ts` includes only `*.test.ts`, and these files end in `.smoke.ts`.
 */
export default defineConfig({
  test: {
    include: ["test/smoke/**/*.smoke.ts"],
    globalSetup: ["test/smoke/support/global-setup.ts"],
    // Real agents are slow. Scenarios set longer timeouts where they need them.
    testTimeout: 10 * 60_000,
    hookTimeout: 2 * 60_000,
    // One scenario at a time: they share the user's logins and quota, and the process table.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ["verbose"],
  },
});
