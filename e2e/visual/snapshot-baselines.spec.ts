import { expect } from "../fixtures";
import { testVisual } from "./state";
import { applyTheme, fixClock, settleVisual, sizeFor, widths, type Theme } from "./states";
import { openState } from "./render-states";
import { baselineCells, baselineTitle } from "./cells";

/**
 * Visual baselines (#120): every page family and its loading/empty/error/dialog/menu state at
 * 375/768/1440px in light and dark, emulated reduced motion, a fixed page clock and drained
 * animations. Chromium renders the screenshots (see visual.config.ts and docs/BROWSER_TESTS.md
 * for the environment and the no-auto-accept approval process). Every rendered string is seeded
 * fixed text, so no cell needs a mask. The cells live in cells.ts.
 */
const themes: Theme[] = ["light", "dark"];

// A baseline from any browser but the digest-pinned container would drift against CI.
testVisual.beforeAll(() => {
  if (!process.env.RENDRO_VISUAL_WS) throw new Error("Visual baselines render in the pinned Playwright container: run `pnpm visual` or `pnpm visual:update`");
});

for (const cell of baselineCells) {
  testVisual(baselineTitle(cell), async ({ page, visual }) => {
    for (const width of cell.widths ?? widths) {
      await page.setViewportSize(sizeFor(width));
      for (const theme of themes) {
        await applyTheme(page, theme);
        await fixClock(page, visual.clockEpoch);
        const open = await openState(page, visual, cell.family, cell.state);
        try {
          await settleVisual(page);
          await expect(page).toHaveScreenshot(`${cell.family}-${cell.state}-${width}-${theme}.png`);
        } finally {
          await open.close();
        }
      }
    }
  });
}
