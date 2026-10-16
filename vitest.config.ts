import { fileURLToPath } from "node:url";
import { coveragePolicy } from "./scripts/coverage-policy";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // The nightly stability workflow records per-test outcomes of consecutive runs
    // and diffs them (tests/helpers/diff-outcomes.ts); unset, only the default reporter runs.
    reporters: process.env.RENDRO_TEST_OUTCOMES ? ["default", ["json", { outputFile: process.env.RENDRO_TEST_OUTCOMES }]] : ["default"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*-browser.test.ts"],
          sequence: { groupOrder: 0 },
          // In-process Convex emulation under V8 coverage on a shared 2-vCPU runner
          // runs several times slower than the 5s default assumes (seen: 5.1-7s).
          // Budgets here only catch hangs; assertions never depend on elapsed time.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["tests/**/*-browser.test.ts"],
          // Chromium gets the small CI runner to itself, after parallel unit tests.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          // Cold Chromium startup and real rendering need more than unit-test budgets.
          testTimeout: 30_000,
          hookTimeout: 60_000,
          expect: { poll: { timeout: 10_000 } },
        },
      },
    ],
    coverage: {
      provider: "v8",
      ...coveragePolicy(fileURLToPath(new URL(".", import.meta.url))),
      excludeAfterRemap: true,
      reporter: ["json", "json-summary", "lcov", "text"],
      reportOnFailure: true,
    },
  },
  resolve: {
    alias: {
      "@": new URL("src", import.meta.url).pathname,
    },
  },
});
