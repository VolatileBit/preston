import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    globalSetup: ["test/support/build.ts"],
    testTimeout: 20000,
    pool: "forks",
  },
});
