import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*-browser.test.ts"],
          sequence: { groupOrder: 0 },
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
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
  resolve: {
    alias: {
      "@": new URL("src", import.meta.url).pathname,
    },
  },
});
