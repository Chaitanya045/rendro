import { defineConfig, devices } from "@playwright/test";

/**
 * Visual baselines and axe scans (#120). Chromium owns the screenshots (see #120: one pinned
 * Linux environment renders every baseline, so local and CI pixel output can never drift apart);
 * axe runs on all three engines because the assertion is rule-based, not pixel-based. The
 * functional e2e layer of e2e/playwright.config.ts excludes these files from its shards.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/visual/*.spec.ts",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  fullyParallel: true,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Baselines are deterministic: the single CI retry only absorbs transient local-backend
  // failures (a 503 session check under load), and failOnFlakyTests keeps a pass-on-retry from
  // hiding it — the same posture as the functional e2e suite.
  retries: process.env.E2E_RETRIES === undefined ? (process.env.CI ? 1 : 0) : Number.parseInt(process.env.E2E_RETRIES, 10),
  failOnFlakyTests: !!process.env.CI,
  timeout: 120_000,
  globalTimeout: 2_400_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Every pixel must match (same pinned environment both sides); a CSS animation freeze and
      // an unfocused caret remove the last nondeterministic pixels from the render.
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixels: 0,
      maxDiffPixelRatio: 0,
      // pixelmatch ignores a pixel whose YIQ colour distance is below `threshold` before maxDiffPixels counts anything.
      // Playwright's default 0.2 hid #274's #71717a → #52525b text (a distance of 0.117) in every /r/ cell. The pinned
      // renders are bit-identical across runs (`scripts/visual-baselines.sh repeat`, #276), so any colour change fails;
      // e2e/visual/threshold-self-test.spec.ts proves it on a real cell.
      threshold: 0,
    },
  },
  outputDir: "../test-results/e2e-visual",
  reporter: [["list"], ["html", { outputFolder: "../playwright-report", open: "never" }]],
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    serviceWorkers: "block",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // `scripts/visual-baselines.sh repeat` renders into a scratch directory and compares the next runs against it.
  snapshotPathTemplate: process.env.RENDRO_VISUAL_SNAPSHOTS ? `${process.env.RENDRO_VISUAL_SNAPSHOTS}/{arg}{ext}` : "{testFileDir}/__screenshots__/{arg}{ext}",
  projects: [
    {
      name: "visual-chromium",
      // The browser runs in the digest-pinned Playwright container started by
      // scripts/visual-baselines.sh; the spec refuses to run against any other browser.
      use: { ...devices["Desktop Chrome"], connectOptions: process.env.RENDRO_VISUAL_WS ? { wsEndpoint: process.env.RENDRO_VISUAL_WS } : undefined },
      testIgnore: /[\\/]visual[\\/]axe-states\.spec\.ts$/,
    },
    {
      name: "a11y-chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /[\\/]visual[\\/]axe-states\.spec\.ts$/,
    },
    {
      name: "a11y-firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: /[\\/]visual[\\/]axe-states\.spec\.ts$/,
    },
    {
      name: "a11y-webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: /[\\/]visual[\\/]axe-states\.spec\.ts$/,
    },
  ],
});
