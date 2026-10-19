import type { Page } from "@playwright/test";

/** Shared determinism helpers for the visual baseline and axe runs (#120). */

export type Theme = "light" | "dark";
export type Width = 375 | 768 | 1440;

export const widths: Width[] = [375, 768, 1440];

/** Heights match the shared spec conventions: 812 for phones, 900 for larger screens. */
export const sizeFor = (width: Width): { width: number; height: number } =>
  width === 375 ? { width: 375, height: 812 } : { width, height: 900 };

/** The in-page readiness step of `settleVisual`, evaluated per document (main frame and every open frame). */
const settleDocument = async () => {
  await document.fonts.ready;
  const root = document.documentElement;
  const animations = root.getAnimations({ subtree: true });
  // A loading skeleton's spinner animates forever; only finite animations have a finish to wait for.
  const finite = animations.filter(animation => animation.effect?.getTiming().iterations !== Infinity);
  // The cap is a safety net for an animotion the page orphaned; nothing below needs a wall-clock stability.
  await Promise.race([Promise.all(finite.map(animation => animation.finished)), new Promise<void>(resolve => setTimeout(resolve, 500))]);
  await Promise.race([new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }), new Promise<void>(resolve => setTimeout(resolve, 400))]);
  const remaining = root.getAnimations({ subtree: true });
  await Promise.race([Promise.all(remaining.map(animation => animation.finished)), new Promise<void>(resolve => setTimeout(resolve, 200))]);
  for (const animation of root.getAnimations({ subtree: true })) animation.pause();
};

/**
 * One readiness gate for every screenshot and scan: web fonts applied, the animation queue
 * drained (the paused-animation follow-up of #262), and two painted frames past the last change.
 * Only finite animations are awaited; infinite ones (held-loading spinners) are simply paused.
 */
export async function settleVisual(page: Page) {
  // WebKit aborts an evaluation that overlaps a rendering-process hiccup on a slow runner
  // ("AbortError: The operation was aborted"); the readiness step is idempotent, so retry it.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.evaluate(settleDocument);
      break;
    } catch (error) {
      if (attempt >= 3 || !/AbortError|Execution context was destroyed/.test(String(error))) throw error;
      await page.waitForTimeout(250);
    }
  }
  await Promise.all(page.frames().map(frame => frame.evaluate(settleDocument).catch(() => undefined)));
}

/** Pin the page clock's Date (its frames included) so relative ages and dates render identically everywhere. */
export async function fixClock(page: Page, epoch: number) {
  await page.clock.setFixedTime(epoch);
}

/** The baseline and axe runs always emulate reduced motion; every theme is an explicit color scheme. */
export async function applyTheme(page: Page, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
}
