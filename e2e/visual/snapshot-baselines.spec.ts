import { expect } from "../fixtures";
import { testVisual } from "./state";
import { applyTheme, fixClock, settleVisual, sizeFor, widths, type Theme } from "./states";
import { maskFor, openState, pinVolatileText, type Cell } from "./render-states";

/**
 * Visual baselines (#120): every page family and its loading/empty/error/dialog/menu state at
 * 375/768/1440px in light and dark, emulated reduced motion, a fixed page clock and drained
 * animations. Chromium renders the screenshots (see visual.config.ts and docs/BROWSER_TESTS.md
 * for the environment and the no-auto-accept approval process). Masks cover only text that is
 * intentionally run-specific (server ids and key prefixes); their content is asserted by the
 * functional specs, not this suite.
 */
const cells: Cell[] = [
  { family: "landing", state: "default" },
  { family: "sign-in", state: "default" },
  { family: "sign-up", state: "default" },
  { family: "org", state: "overview" },
  { family: "projects", state: "list" },
  { family: "projects", state: "empty" },
  { family: "projects", state: "loading" },
  { family: "projects", state: "error" },
  { family: "projects", state: "dialog" },
  { family: "project", state: "deployments" },
  { family: "project", state: "loading" },
  { family: "teams", state: "list" },
  { family: "keys", state: "list" },
  { family: "account-menu", state: "default" },
  { family: "viewer", state: "tree" },
  { family: "viewer", state: "loading" },
  { family: "viewer", state: "menu" },
  { family: "comments", state: "drawer" },
  { family: "repo", state: "home" },
  { family: "repo", state: "search" },
  { family: "repo", state: "not-found" },
];

const themes: Theme[] = ["light", "dark"];

// A baseline from any browser but the digest-pinned container would drift against CI.
testVisual.beforeAll(() => {
  if (!process.env.RENDRO_VISUAL_WS) throw new Error("Visual baselines render in the pinned Playwright container: run `pnpm visual` or `pnpm visual:update`");
});

for (const cell of cells) {
  testVisual(`${cell.family} — ${cell.state}`, async ({ page, visual }) => {
    for (const width of widths) {
      await page.setViewportSize(sizeFor(width));
      for (const theme of themes) {
        await applyTheme(page, theme);
        await fixClock(page, visual.clockEpoch);
        const open = await openState(page, visual, cell.family, cell.state);
        try {
          await pinVolatileText(page, cell.family, cell.state);
          await settleVisual(page);
          const mask = maskFor(cell.family, cell.state).map(selector => page.locator(selector));
          await expect(page).toHaveScreenshot(`${cell.family}-${cell.state}-${width}-${theme}.png`, { mask: mask.length ? mask : undefined });
        } finally {
          await open.close();
        }
      }
    }
  });
}
