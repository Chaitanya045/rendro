import type { Page } from "@playwright/test";
import { test, expect, content, documentFrame, trackActivation } from "./viewer-fixtures";
import { desktop } from "./shell-helpers";
import { storedDrafts } from "./comment-helpers";

/**
 * The comment widget and the document's links share one opaque frame and one shell: a link inside the document, and the
 * shell's own confirmation for a link nobody asked for, must not cost the reader the comment they are writing.
 */
test.use({ viewport: desktop });

const heading = (tab: Page, name: string) => content(tab).getByRole("heading", { name });
const historyLength = (tab: Page) => tab.evaluate(() => history.length);
const hash = (tab: Page) => tab.evaluate(() => location.hash);
const dock = (tab: Page) => content(tab).getByTestId("commentor-dock");
const composer = (tab: Page) => content(tab).getByTestId("commentor-composer");
const textarea = (tab: Page) => content(tab).getByTestId("commentor-composer-textarea");

/** Select a word of the intro paragraph with the pointer and open the composer from the chip. */
async function startComment(tab: Page) {
  await expect(dock(tab)).toBeAttached();
  await content(tab).locator("#intro").dblclick({ position: { x: 60, y: 8 } });
  const chip = content(tab).getByTestId("commentor-selection-action");
  await expect(chip).toHaveAttribute("data-state", "open");
  await chip.click();
  await expect(textarea(tab)).toBeFocused();
}

test.describe("comments and links", () => {
  test("a link within the document scrolls it without reloading it or losing the comment being written", async ({ asOwner: tab, site }) => {
    await tab.goto(`${site.docs}?doc=comment.html`);
    await expect(heading(tab, "Comment page")).toBeVisible();
    await startComment(tab);
    await textarea(tab).fill("A draft the reader has not sent");
    const loadedAt = await documentFrame(tab).evaluate(() => performance.timeOrigin);
    const entries = await historyLength(tab);

    await content(tab).locator("#to-later").click();
    await expect.poll(() => hash(tab)).toBe("#later");
    await expect.poll(() => documentFrame(tab).evaluate(() => Math.round(document.getElementById("later")!.getBoundingClientRect().top))).toBeLessThanOrEqual(2);
    // The same document is still loaded, with no new history entry, and the draft is where the reader left it.
    expect(await documentFrame(tab).evaluate(() => performance.timeOrigin)).toBe(loadedAt);
    expect(await historyLength(tab)).toBe(entries);
    await expect(tab.locator("#document-navigation-notice")).toHaveCount(0);
    // A click in the document closes the composer, as any click away from it does, but the draft is kept by the shell…
    await expect(composer(tab)).toHaveCount(0);
    expect(await storedDrafts(tab)).toEqual(["A draft the reader has not sent"]);
    // …and comes back, word for word, when the reader opens the composer again.
    await content(tab).locator("#intro").dblclick({ position: { x: 60, y: 8 } });
    await content(tab).getByTestId("commentor-selection-action").click();
    await expect(textarea(tab)).toHaveValue("A draft the reader has not sent");
    expect(await documentFrame(tab).evaluate(() => performance.timeOrigin)).toBe(loadedAt);
  });

  test("a link confirmation that is waiting, or dismissed, leaves the theme, the tree and the comment actions working", async ({ asOwner: tab, site }) => {
    test.slow();
    const gate = await trackActivation(tab);
    await tab.goto(`${site.docs}?doc=comment.html`);
    await expect(heading(tab, "Comment page")).toBeVisible();
    await expect(dock(tab)).toBeAttached();
    const entries = await historyLength(tab);
    // The document follows a link nobody clicked: the shell asks and changes nothing.
    await gate.postWhenInactive({ click: "go" });
    await gate.handled(1);
    const notice = tab.locator("#document-navigation-notice");
    const review = tab.locator("#document-navigation-review");
    const destination = tab.locator("#document-navigation-destination");
    await expect(destination).toHaveText("Open linked document guide/intro.html#details?");

    const theme = () => tab.evaluate(() => document.documentElement.dataset.theme);
    const guide = tab.locator('.tree-folder[data-path$="/guide/"] > .tree-item');
    const stillAsking = async (dismissed: boolean) => {
      if (dismissed) {
        await expect(notice).toHaveCount(0);
        await expect(review.getByRole("button", { name: "Review linked document" })).toBeVisible();
      } else {
        await expect(destination).toHaveText("Open linked document guide/intro.html#details?");
      }
      expect(documentFrame(tab).url()).toMatch(/\/files\/comment\.html$/);
      expect(await historyLength(tab)).toBe(entries);
    };
    for (const dismissed of [false, true]) {
      if (dismissed) await notice.getByRole("button", { name: "Dismiss" }).click();
      await stillAsking(dismissed);

      // Theme: the control cycles and the document is told, with the prompt untouched.
      const before = await theme();
      await tab.locator(".rendro-theme-control").click();
      await expect.poll(theme).not.toBe(before);
      await stillAsking(dismissed);

      // Tree: a folder opens and closes by its row.
      await guide.click();
      await expect(guide).toHaveAttribute("aria-expanded", "true");
      await expect(tab.locator('.tree-item[data-path$="/guide/intro.html"]')).toBeVisible();
      await stillAsking(dismissed);
      await guide.click();
      await expect(guide).toHaveAttribute("aria-expanded", "false");

      // Comments: the selection chip opens the composer, Escape closes it again.
      await startComment(tab);
      await textarea(tab).fill(`Written while a link waits (${dismissed ? "dismissed" : "visible"})`);
      await expect(composer(tab)).toBeVisible();
      await tab.keyboard.press("Escape");
      await expect(composer(tab)).toHaveCount(0);
      await stillAsking(dismissed);
    }

    // After all of that the prompt still does its one job: Review, then Open, goes to the linked document.
    await review.getByRole("button", { name: "Review linked document" }).click();
    await notice.getByRole("button", { name: "Open linked document" }).click();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=guide%2Fintro\.html#details$/);
    await expect(notice).toHaveCount(0);
    await expect(review).toHaveCount(0);
  });
});
