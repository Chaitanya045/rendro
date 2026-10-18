import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // E2E_RETRIES=0 (nightly stability job) surfaces first-attempt flakes that a retry would hide.
  retries: process.env.E2E_RETRIES === undefined ? (process.env.CI ? 1 : 0) : Number.parseInt(process.env.E2E_RETRIES, 10),
  failOnFlakyTests: !!process.env.CI,
  timeout: 30_000,
  // All three engines remain sequential as the auth/recovery matrix grows.
  globalTimeout: 2_700_000,
  expect: { timeout: 10_000 },
  outputDir: "../test-results/e2e",
  // CI also writes a blob report so the sharded jobs' results can be merged into one HTML report per engine.
  reporter: [["list"], ["html", { outputFolder: "../playwright-report", open: "never" }], ...(process.env.CI ? [["blob", { outputDir: "../blob-report" }] as const] : [])],
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    serviceWorkers: "block",
    // Capture the original failure even with zero retries; not just the retry.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
