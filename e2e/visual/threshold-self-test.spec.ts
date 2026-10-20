import { expect } from "../fixtures";
import { testVisual } from "./state";
import { applyTheme, fixClock, settleVisual, sizeFor } from "./states";
import { openState } from "./render-states";

/**
 * Self-test of the baseline comparison (#276): one real cell is rendered with its muted text
 * token one step lighter (#52525b → #71717a, the change #274 made in reverse), and the shot must
 * fail against the committed baseline. Playwright's default per-pixel threshold (0.2) absorbs this
 * change; the same shot is asserted to pass at 0.2, so the cell is a change that only the stricter
 * threshold of visual.config.ts can catch, not one any comparison would.
 */
const baseline = "landing-default-1440-light.png";

testVisual.beforeAll(() => {
  if (!process.env.RENDRO_VISUAL_WS) throw new Error("Visual baselines render in the pinned Playwright container: run `pnpm visual` or `pnpm visual:update`");
});

testVisual("the baseline comparison catches a one-step muted token change", async ({ page, visual }, info) => {
  // In update mode a failed comparison rewrites its baseline: the self-test only runs when baselines are read-only.
  testVisual.skip(info.config.updateSnapshots === "all" || info.config.updateSnapshots === "changed", "baselines are being rewritten");
  await page.setViewportSize(sizeFor(1440));
  await applyTheme(page, "light");
  await fixClock(page, visual.clockEpoch);
  const open = await openState(page, visual, "landing", "default");
  try {
    // An inline custom property on the root outranks the page's `:root` token and is not subject to its style-src CSP.
    await page.evaluate(() => document.documentElement.style.setProperty("--text-muted", "#71717a"));
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim())).toBe("#71717a");
    await settleVisual(page);
    await expect(page).toHaveScreenshot(baseline, { threshold: 0.2, timeout: 5_000 });
    await expect(expect(page).toHaveScreenshot(baseline, { timeout: 5_000 })).rejects.toThrow(/pixels \(ratio [\d.]+ of all image pixels\) are different/);
  } finally {
    await open.close();
  }
});
