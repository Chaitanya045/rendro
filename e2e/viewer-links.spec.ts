import type { Page } from "@playwright/test";
import { test, expect, content, documentFrame, frameFile, trackActivation, doc } from "./viewer-fixtures";
import { desktop } from "./shell-helpers";

/**
 * Links and fragments inside a repository document (/r/, the public `viewer-docs` fixture): fragment scrolling and URL
 * reporting, cross-document links with their query and fragment, and the parent-owned confirmation for a link to another
 * site. The document is an opaque sandboxed iframe; only the trusted shell can open another document. Navigation the
 * reader did not start needs a script in the document, which rendered Markdown never has; the shell's handling of it is
 * covered against hostile frames in tests/viewer-fragments-browser.test.ts.
 */
test.use({ viewport: desktop });

const heading = (tab: Page, name: string) => content(tab).getByRole("heading", { name });
const notice = (tab: Page) => tab.locator("#document-navigation-notice");
const destination = (tab: Page) => tab.locator("#document-navigation-destination");
const review = (tab: Page) => tab.locator("#document-navigation-review");
const historyLength = (tab: Page) => tab.evaluate(() => history.length);
const historyState = (tab: Page) => tab.evaluate(() => history.state as unknown);
const hash = (tab: Page) => tab.evaluate(() => location.hash);
/**
 * Distance of a heading's top edge from where scrolling to it puts it (the top of the viewport, less its scroll margin).
 * Rendered ids, and the document's own links to them, carry GitHub's user-content- prefix.
 */
const offset = (tab: Page, selector: string) => documentFrame(tab).evaluate(selector => {
  const element = document.getElementById(`user-content-${selector.slice(1)}`);
  return element ? Math.round(element.getBoundingClientRect().top - parseFloat(getComputedStyle(element).scrollMarginTop || "0")) : null;
}, selector);
const link = (tab: Page, name: string) => content(tab).getByRole("link", { name, exact: true });
const scrolledTo = async (tab: Page, selector: string, tolerance = 2) => expect.poll(async () => Math.abs((await offset(tab, selector)) ?? 9999), { message: `${selector} at the top` }).toBeLessThanOrEqual(tolerance);
const documentScroll = (tab: Page) => documentFrame(tab).evaluate(() => Math.round(document.scrollingElement?.scrollTop ?? -1));

// #89: the strict nonce CSP must allow everything the shell and the document do here. Requesting the recorder before
// the test starts it with the page; the check runs after every test.
test.beforeEach(({ cspViolations }) => { void cspViolations; });
test.afterEach(({ cspViolations }) => {
  expect(cspViolations.filter(message => !/x-frame-options/i.test(message)), "CSP violations").toEqual([]);
});

test.describe("fragments and anchors", () => {
  test("a fragment link scrolls its own document and is reported to the shell without navigating or reloading", async ({ page: tab, site }) => {
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    const frame = documentFrame(tab);
    const loadedAt = await frame.evaluate(() => performance.timeOrigin);
    const entries = await historyLength(tab);
    const state = await historyState(tab);

    await link(tab, "Section two").click();
    await scrolledTo(tab, "#section-two");
    await expect.poll(() => hash(tab)).toBe("#user-content-section-two");
    // The shell replaced its own entry: no new history, the document was not reloaded, nothing was offered.
    expect(await historyLength(tab)).toBe(entries);
    expect(await historyState(tab)).toEqual(state);
    expect(await frame.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
    expect(frameFile(tab)).toBe(doc("index.md"));
    await expect(notice(tab)).toHaveCount(0);

    // A percent-encoded Unicode id resolves the same way.
    await link(tab, "Café").click();
    await scrolledTo(tab, "#café");
    await expect.poll(() => hash(tab)).toBe("#user-content-caf%C3%A9");

    // A target that does not exist leaves the scroll position alone; a bare hash returns to the top. The links sit at
    // the top of the document, so they are activated in place: a pointer click would first scroll them into view.
    const before = await documentScroll(tab);
    expect(before).toBeGreaterThan(1000);
    await link(tab, "Missing target").evaluate(anchor => (anchor as HTMLAnchorElement).click());
    await expect.poll(() => hash(tab)).toBe("#user-content-missing-target");
    expect(await documentScroll(tab)).toBe(before);
    await link(tab, "Bare hash").evaluate(anchor => (anchor as HTMLAnchorElement).click());
    await expect.poll(() => documentScroll(tab)).toBe(0);
    expect(await historyLength(tab)).toBe(entries);
    expect(await frame.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
    await expect(notice(tab)).toHaveCount(0);
  });

  test("a deep link with a fragment scrolls once the document has loaded, and so does a reload", async ({ page: tab, site }) => {
    await tab.goto(`${site.docs}?doc=${encodeURIComponent(doc("guide/intro.md"))}#user-content-details`);
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await scrolledTo(tab, "#details");
    await expect(tab.locator(".tree-item.active")).toHaveAttribute("data-path", /\/guide\/intro\.md$/);
    await tab.reload();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await scrolledTo(tab, "#details");
    expect(await hash(tab)).toBe("#user-content-details");
    // The Unicode fragment survives the same trip.
    await tab.goto(`${site.docs}?doc=${encodeURIComponent(doc("index.md"))}#user-content-caf%C3%A9`);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await scrolledTo(tab, "#café");
  });

  test("cross-document links open at their fragment, restore on reload, and Back returns to the document before", async ({ page: tab, site }) => {
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    const entries = await historyLength(tab);

    await link(tab, "Intro details").click();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await scrolledTo(tab, "#details");
    await expect(tab).toHaveURL(/\?doc=docs%2Fguide%2Fintro\.md#user-content-details$/);
    expect(frameFile(tab)).toBe(doc("guide/intro.md"));
    expect(await historyLength(tab)).toBe(entries + 1);
    await expect(tab.locator(".tree-item.active")).toHaveAttribute("data-path", /\/guide\/intro\.md$/);
    await expect(notice(tab)).toHaveCount(0);

    await tab.reload();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await scrolledTo(tab, "#details");
    expect(frameFile(tab)).toBe(doc("guide/intro.md"));

    await tab.goBack();
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await expect(tab).not.toHaveURL(/user-content-details/);
    expect(frameFile(tab)).toBe(doc("index.md"));
    await expect(tab.locator(".tree-item.active")).toHaveAttribute("data-path", /\/index\.md$/);
    await tab.goForward();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=docs%2Fguide%2Fintro\.md#user-content-details$/);
    await scrolledTo(tab, "#details");
  });

  test("a link back to a section of another document opens it there, and picking a row in the tree drops the old fragment", async ({ page: tab, site }) => {
    await tab.goto(`${site.docs}?doc=${encodeURIComponent(doc("guide/intro.md"))}`);
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await link(tab, "Home section two").click();
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await scrolledTo(tab, "#section-two");
    await expect(tab).toHaveURL(/\?doc=docs%2Findex\.md#user-content-section-two$/);
    // The deep link revealed (opened) guide/; only a closed folder needs opening.
    const guide = tab.locator('.tree-folder[data-path$="/guide/"] > .tree-item');
    await expect(guide).toHaveAttribute("aria-expanded", "true");
    await tab.locator('.tree-item[data-path$="/guide/intro.md"] a.tree-link').click();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=docs%2Fguide%2Fintro\.md$/);
    expect(await documentScroll(tab)).toBe(0);
  });
});

test.describe("link confirmation", () => {
  test("a link the reader activates opens at once, by pointer or by keyboard, without asking", async ({ page: tab, site }) => {
    const gate = await trackActivation(tab);
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    const entries = await historyLength(tab);
    await link(tab, "Intro").click();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=docs%2Fguide%2Fintro\.md$/);
    expect(frameFile(tab)).toBe(doc("guide/intro.md"));
    expect(await historyLength(tab)).toBe(entries + 1);
    await expect(notice(tab)).toHaveCount(0);
    await tab.goBack();
    await expect(heading(tab, "Viewer home")).toBeVisible();
    // A second link inside the same activation would be offered instead (the first one used it up), so let it lapse.
    await gate.untilInactive();
    // Keyboard: Enter on a focused link inside the opaque document is a genuine activation too.
    await link(tab, "Deep topic").focus();
    await tab.keyboard.press("Enter");
    await expect(heading(tab, "Deep topic")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=docs%2Fguide%2Fdeep%2Ftopic\.md$/);
    await expect(notice(tab)).toHaveCount(0);
  });

  test("a link to another site never loads inside the viewer", async ({ page: tab, site }) => {
    const requests: string[] = [];
    await tab.route("https://docs.example.test/**", route => { requests.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<h1>outside</h1>" }); });
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    // The shell only allows its own origin in frames, so the frame never navigates: the click is handed to the shell,
    // which asks before doing anything. No request is made, the document stays and no history entry is added.
    const entries = await historyLength(tab);
    await link(tab, "External").click();
    await expect(notice(tab)).toBeVisible();
    await expect(tab).toHaveURL(new RegExp(`${site.docs.replaceAll("/", "\\/")}$`));
    await expect(heading(tab, "Viewer home")).toBeVisible();
    expect(await historyLength(tab)).toBe(entries);
    expect(requests).toEqual([]);
    // Reloading the shell restores the document whatever the frame ended up showing.
    await tab.reload();
    await expect(heading(tab, "Viewer home")).toBeVisible();
    expect(requests).toEqual([]);
  });

  test("a link to another site asks the reader, then opens in a new tab that cannot reach the viewer", async ({ page: tab, site, context }) => {
    const requests: string[] = [];
    await context.route("https://docs.example.test/**", route => { requests.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<h1>outside</h1>" }); });
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await link(tab, "External").click();
    await expect(destination(tab)).toHaveText("Open external link https://docs.example.test/outside?");
    await expect(notice(tab).getByRole("button", { name: "Open external link" })).toHaveAccessibleDescription("Open external link https://docs.example.test/outside?");
    // Nothing is opened until the reader says so, and a second click on the same link does not replace the prompt.
    await link(tab, "External").click();
    await expect(notice(tab)).toHaveCount(1);
    expect(requests).toEqual([]);

    // Dismissing keeps a Review button; the reader can bring the prompt back with the same address.
    await notice(tab).getByRole("button", { name: "Dismiss" }).click();
    await expect(notice(tab)).toHaveCount(0);
    await review(tab).getByRole("button", { name: "Review external link" }).click();
    await expect(destination(tab)).toHaveText("Open external link https://docs.example.test/outside?");
    expect(requests).toEqual([]);

    const entries = await historyLength(tab);
    const popup = context.waitForEvent("page");
    await notice(tab).getByRole("button", { name: "Open external link" }).click();
    const opened = await popup;
    await opened.waitForLoadState("domcontentloaded");
    expect(opened.url()).toBe("https://docs.example.test/outside");
    // The opened page has no handle back to the viewer.
    expect(await opened.evaluate(() => window.opener === null)).toBe(true);
    await opened.close();
    await expect(notice(tab)).toHaveCount(0);
    await expect(review(tab)).toHaveCount(0);
    await expect(tab).toHaveURL(new RegExp(`${site.docs.replaceAll("/", "\\/")}$`));
    await expect(heading(tab, "Viewer home")).toBeVisible();
    expect(await historyLength(tab)).toBe(entries);
    expect(requests).toEqual(["https://docs.example.test/outside"]);
  });
});
