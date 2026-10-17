import type { Page } from "@playwright/test";
import { test, expect, content, documentFrame, frameFile, trackActivation } from "./viewer-fixtures";
import { desktop } from "./shell-helpers";

/**
 * Links and fragments inside a published document, through the private viewer: fragment scrolling and URL reporting,
 * cross-document links with their query and fragment, and the parent-owned confirmation for navigation the reader did
 * not start. The document is an opaque sandboxed iframe; only the trusted shell can open another document.
 */
test.use({ viewport: desktop });

const heading = (tab: Page, name: string) => content(tab).getByRole("heading", { name });
const notice = (tab: Page) => tab.locator("#document-navigation-notice");
const destination = (tab: Page) => tab.locator("#document-navigation-destination");
const review = (tab: Page) => tab.locator("#document-navigation-review");
const historyLength = (tab: Page) => tab.evaluate(() => history.length);
const historyState = (tab: Page) => tab.evaluate(() => history.state as unknown);
const hash = (tab: Page) => tab.evaluate(() => location.hash);
/** Distance of an element's top edge from the top of the document's viewport. */
const offset = (tab: Page, selector: string) => documentFrame(tab).evaluate(selector => {
  const element = selector.startsWith("[name") ? document.querySelector(selector) : document.getElementById(selector.slice(1));
  return element ? Math.round(element.getBoundingClientRect().top) : null;
}, selector);
// An empty named anchor sits in a zero-height line box: engines disagree by up to one paragraph margin (16px) about its edge.
const scrolledTo = async (tab: Page, selector: string, tolerance = 2) => expect.poll(async () => Math.abs((await offset(tab, selector)) ?? 9999), { message: `${selector} at the top` }).toBeLessThanOrEqual(tolerance);
const documentScroll = (tab: Page) => documentFrame(tab).evaluate(() => Math.round(document.scrollingElement?.scrollTop ?? -1));
const focusInNotice = (tab: Page) => tab.evaluate(() => !!document.activeElement?.closest("#document-navigation-notice, #document-navigation-review"));

test.describe("fragments and anchors", () => {
  test("a fragment link scrolls its own document and is reported to the shell without navigating or reloading", async ({ asOwner: tab, site }) => {
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    const frame = documentFrame(tab);
    const loadedAt = await frame.evaluate(() => performance.timeOrigin);
    const entries = await historyLength(tab);
    const state = await historyState(tab);
    await content(tab).getByLabel("Draft").fill("work in progress");

    await content(tab).locator("#to-section-two").click();
    await scrolledTo(tab, "#section-two");
    await expect.poll(() => hash(tab)).toBe("#section-two");
    // The shell replaced its own entry: no new history, the document was not reloaded, nothing was offered.
    expect(await historyLength(tab)).toBe(entries);
    expect(await historyState(tab)).toEqual(state);
    expect(await frame.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
    await expect(content(tab).getByLabel("Draft")).toHaveValue("work in progress");
    expect(frameFile(tab)).toBe("index.html");
    await expect(notice(tab)).toHaveCount(0);

    // A percent-encoded Unicode id and a legacy named anchor resolve the same way.
    await content(tab).locator("#to-cafe").click();
    await scrolledTo(tab, "#café");
    await expect.poll(() => hash(tab)).toBe("#caf%C3%A9");
    await content(tab).locator("#to-legacy").click();
    await scrolledTo(tab, "[name=legacy-anchor]", 16);
    await expect(content(tab).getByText("Legacy anchor target")).toBeInViewport();
    await expect.poll(() => hash(tab)).toBe("#legacy-anchor");

    // A target that does not exist leaves the scroll position alone; a bare hash returns to the top.
    const before = await documentScroll(tab);
    expect(before).toBeGreaterThan(1000);
    await content(tab).locator("#to-missing").click();
    await expect.poll(() => hash(tab)).toBe("#missing-target");
    expect(await documentScroll(tab)).toBe(before);
    await content(tab).locator("#to-bare").click();
    await expect.poll(() => documentScroll(tab)).toBe(0);
    expect(await historyLength(tab)).toBe(entries);
    expect(await frame.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
    await expect(content(tab).getByLabel("Draft")).toHaveValue("work in progress");
    await expect(notice(tab)).toHaveCount(0);
  });

  test("a deep link with a fragment scrolls once the document has loaded, and so does a reload", async ({ asOwner: tab, site }) => {
    await tab.goto(`${site.docs}?doc=guide%2Fintro.html#details`);
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await scrolledTo(tab, "#details");
    await expect(tab.locator(".tree-item.active")).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
    await tab.reload();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await scrolledTo(tab, "#details");
    expect(await hash(tab)).toBe("#details");
    // The Unicode fragment survives the same trip.
    await tab.goto(`${site.docs}?doc=index.html#caf%C3%A9`);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await scrolledTo(tab, "#café");
  });

  test("cross-document links keep their query and fragment, restore on reload, and Back returns to the document before", async ({ asOwner: tab, site }) => {
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    const entries = await historyLength(tab);

    await content(tab).locator("#to-intro-query").click();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await scrolledTo(tab, "#details");
    // The publisher's own query rides in a separate parameter, never in the authorized path.
    await expect(tab).toHaveURL(new RegExp(`\\?doc=guide%2Fintro\\.html&docQuery=%3Flang%3Dfr#details$`));
    expect(documentFrame(tab).url()).toMatch(/\/files\/guide\/intro\.html\?lang=fr$/);
    expect(await historyLength(tab)).toBe(entries + 1);
    await expect(tab.locator(".tree-item.active")).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
    await expect(notice(tab)).toHaveCount(0);

    await tab.reload();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await scrolledTo(tab, "#details");
    expect(documentFrame(tab).url()).toMatch(/\/files\/guide\/intro\.html\?lang=fr$/);

    await tab.goBack();
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await expect(tab).not.toHaveURL(/docQuery/);
    expect(frameFile(tab)).toBe("index.html");
    await expect(tab.locator(".tree-item.active")).toHaveAttribute("data-path", /\/index\.html$/);
    await tab.goForward();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(tab).toHaveURL(/docQuery=%3Flang%3Dfr#details$/);
    await scrolledTo(tab, "#details");
  });

  test("a link back to a section of another document opens it there, and picking a row in the tree drops the old fragment", async ({ asOwner: tab, site }) => {
    await tab.goto(`${site.docs}?doc=guide%2Fintro.html`);
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await content(tab).locator("#to-home-section").click();
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await scrolledTo(tab, "#section-two");
    await expect(tab).toHaveURL(/\?doc=index\.html#section-two$/);
    // The deep link revealed (opened) guide/; only a closed folder needs opening.
    const guide = tab.locator('.tree-folder[data-path$="/guide/"] > .tree-item');
    await expect(guide).toHaveAttribute("aria-expanded", "true");
    await tab.locator('.tree-item[data-path$="/guide/intro.html"] a.tree-link').click();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=guide%2Fintro\.html$/);
    expect(await documentScroll(tab)).toBe(0);
  });
});

test.describe("link confirmation", () => {
  test("a link the reader activates opens at once, by pointer or by keyboard, without asking", async ({ asOwner: tab, site }) => {
    const gate = await trackActivation(tab);
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    const entries = await historyLength(tab);
    await content(tab).locator("#to-intro").click();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=guide%2Fintro\.html$/);
    expect(frameFile(tab)).toBe("guide/intro.html");
    expect(await historyLength(tab)).toBe(entries + 1);
    await expect(notice(tab)).toHaveCount(0);
    await tab.goBack();
    await expect(heading(tab, "Viewer home")).toBeVisible();
    // A second link inside the same activation would be offered instead (the first one used it up), so let it lapse.
    await gate.untilInactive();
    // Keyboard: Enter on a focused link inside the opaque document is a genuine activation too.
    await content(tab).locator("#to-topic").focus();
    await tab.keyboard.press("Enter");
    await expect(heading(tab, "Deep topic")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=guide%2Fdeep%2Ftopic\.html$/);
    await expect(notice(tab)).toHaveCount(0);
  });

  test("a link followed with no reader action is offered by the shell: cancel, review and confirm", async ({ asOwner: tab, site }) => {
    const gate = await trackActivation(tab);
    await tab.goto(`${site.docs}?doc=late.html`);
    await expect(heading(tab, "Late link")).toBeVisible();
    const entries = await historyLength(tab);
    await gate.postWhenInactive({ click: "go" });
    await gate.handled(1);

    // Nothing navigated: the prompt names the exact destination and does not take focus from where the reader was.
    await expect(notice(tab)).toBeVisible();
    await expect(destination(tab)).toHaveText("Open linked document guide/intro.html#details?");
    await expect(destination(tab)).toHaveAttribute("role", "status");
    await expect(notice(tab).getByRole("button", { name: "Open linked document" })).toHaveAccessibleDescription("Open linked document guide/intro.html#details?");
    await expect(notice(tab)).toHaveCount(1);
    expect(frameFile(tab)).toBe("late.html");
    await expect(tab).toHaveURL(/\?doc=late\.html$/);
    expect(await historyLength(tab)).toBe(entries);
    expect(await focusInNotice(tab)).toBe(false);

    // Dismiss leaves only a Review button, focused, and still nothing navigated.
    await notice(tab).getByRole("button", { name: "Dismiss" }).click();
    await expect(notice(tab)).toHaveCount(0);
    await expect(review(tab).getByRole("button", { name: "Review linked document" })).toBeFocused();
    expect(frameFile(tab)).toBe("late.html");
    await expect(tab).toHaveURL(/\?doc=late\.html$/);

    // Review brings the same prompt back and moves focus to it; the reader's explicit Open is what navigates.
    await review(tab).getByRole("button", { name: "Review linked document" }).click();
    await expect(review(tab)).toHaveCount(0);
    await expect(destination(tab)).toHaveText("Open linked document guide/intro.html#details?");
    await expect(notice(tab).getByRole("button", { name: "Open linked document" })).toBeFocused();
    expect(frameFile(tab)).toBe("late.html");
    await notice(tab).getByRole("button", { name: "Open linked document" }).click();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=guide%2Fintro\.html#details$/);
    await scrolledTo(tab, "#details");
    expect(frameFile(tab)).toBe("guide/intro.html");
    await expect(notice(tab)).toHaveCount(0);
    await expect(review(tab)).toHaveCount(0);
    await expect(tab.locator(".tree-item.active")).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
    expect(await historyLength(tab)).toBe(entries + 1);

    // Back returns to the document that asked, which asks again: confirmation is per request, never remembered.
    await tab.goBack();
    await expect(heading(tab, "Late link")).toBeVisible();
    await gate.postWhenInactive({ click: "go" });
    await gate.handled(2);
    await expect(destination(tab)).toHaveText("Open linked document guide/intro.html#details?");
    expect(frameFile(tab)).toBe("late.html");
  });

  test("further unsolicited links never retarget a visible prompt, and while dismissed only the latest is kept for Review", async ({ asOwner: tab, site }) => {
    const gate = await trackActivation(tab);
    await tab.goto(`${site.docs}?doc=flood.html`);
    await expect(heading(tab, "Flood")).toBeVisible();
    const entries = await historyLength(tab);
    await gate.postWhenInactive({ click: "first" });
    await gate.handled(1);
    await expect(destination(tab)).toHaveText("Open linked document guide/intro.html?");

    // Another request arrives while the prompt is visible: the destination, the button and the focus stay as they were.
    // (Reading the page handed it activation in Chromium; it lapses first, so only the prompt can stop this request.)
    await gate.postWhenInactive({ click: "second" });
    await gate.handled(2);
    await expect(notice(tab)).toHaveCount(1);
    await expect(destination(tab)).toHaveText("Open linked document guide/intro.html?");
    expect(await focusInNotice(tab)).toBe(false);
    expect(frameFile(tab)).toBe("flood.html");

    // Dismissed, the shell stays silent. The next request comes right after the reader's own click on Dismiss; that is
    // parent input, so it cannot authorize what the document asks for.
    await notice(tab).getByRole("button", { name: "Dismiss" }).click();
    await gate.postNow({ click: "third" });
    await gate.handled(3);
    await expect(review(tab).getByRole("button")).toBeFocused();
    await expect(notice(tab)).toHaveCount(0);
    expect(frameFile(tab)).toBe("flood.html");
    expect(await historyLength(tab)).toBe(entries);

    // The latest request, with its query and fragment, is what Review offers; Open then navigates to exactly that.
    await review(tab).getByRole("button", { name: "Review linked document" }).click();
    await expect(destination(tab)).toHaveText("Open linked document other/elsewhere.html?x=1#y?");
    await notice(tab).getByRole("button", { name: "Open linked document" }).click();
    await expect(heading(tab, "Elsewhere")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=other%2Felsewhere\.html&docQuery=%3Fx%3D1#y$/);
    expect(documentFrame(tab).url()).toMatch(/\/files\/other\/elsewhere\.html\?x=1$/);
    await expect(notice(tab)).toHaveCount(0);
    await expect(review(tab)).toHaveCount(0);
  });

  test("forged, malformed and stale requests do not navigate, prompt or leave the shell", async ({ asOwner: tab, site }) => {
    const gate = await trackActivation(tab);
    const requests: string[] = [];
    await tab.route("https://docs.example.test/**", route => { requests.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<h1>outside</h1>" }); });
    await tab.goto(`${site.docs}?doc=forged.html`);
    await expect(heading(tab, "Forged")).toBeVisible();
    const entries = await historyLength(tab);
    await gate.postWhenInactive({ forge: true });
    await gate.handled(6);
    // Requests are handled in order: once the valid one that follows them is offered, every forged one was refused.
    await expect(destination(tab)).toHaveText("Open linked document guide/intro.html#details?");
    await expect(notice(tab)).toHaveCount(1);
    await expect(review(tab)).toHaveCount(0);
    expect(frameFile(tab)).toBe("forged.html");
    await expect(tab).toHaveURL(new RegExp(`${site.docs.replaceAll("/", "\\/")}\\?doc=forged\\.html$`));
    expect(await historyLength(tab)).toBe(entries);

    // The shell's own window is not the frame: a request posted by it, or claiming to load a document, is ignored too.
    await notice(tab).getByRole("button", { name: "Dismiss" }).click();
    await tab.evaluate(() => {
      postMessage({ type: "doc-navigate", path: "guide/deep/topic.html" }, "*");
      postMessage({ type: "doc-loaded", path: "guide/deep/topic.html" }, "*");
    });
    await review(tab).getByRole("button", { name: "Review linked document" }).click();
    await expect(destination(tab)).toHaveText("Open linked document guide/intro.html#details?");
    expect(frameFile(tab)).toBe("forged.html");
    expect(requests).toEqual([]);
  });

  test("a link to another site never loads inside the viewer", async ({ asOwner: tab, site }) => {
    const requests: string[] = [];
    await tab.route("https://docs.example.test/**", route => { requests.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<h1>outside</h1>" }); });
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    // The shell only allows its own origin in frames, so the frame never navigates: the click is handed to the shell,
    // which asks before doing anything. No request is made, the document stays and no history entry is added.
    const entries = await historyLength(tab);
    await content(tab).locator("#external").click();
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

  test("a link to another site asks the reader, then opens in a new tab that cannot reach the viewer", async ({ asOwner: tab, site, context }) => {
    const requests: string[] = [];
    await context.route("https://docs.example.test/**", route => { requests.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<h1>outside</h1>" }); });
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await content(tab).locator("#external").click();
    await expect(destination(tab)).toHaveText("Open external link https://docs.example.test/outside?");
    await expect(notice(tab).getByRole("button", { name: "Open external link" })).toHaveAccessibleDescription("Open external link https://docs.example.test/outside?");
    // Nothing is opened until the reader says so, and a second click on the same link does not replace the prompt.
    await content(tab).locator("#external").click();
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

  test("a link that opens a new tab leaves the viewer where it was", async ({ asOwner: tab, site, context }) => {
    await tab.goto(site.docs);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    const entries = await historyLength(tab);
    const popup = context.waitForEvent("page");
    await content(tab).locator("#new-tab").click();
    const opened = await popup;
    await opened.waitForLoadState("domcontentloaded");
    expect(new URL(opened.url()).pathname).toMatch(/\/docs\/(view\/[^/]+\/)?files\/guide\/intro\.html$/);
    await opened.close();
    await expect(tab).toHaveURL(new RegExp(`${site.docs.replaceAll("/", "\\/")}$`));
    expect(await historyLength(tab)).toBe(entries);
    await expect(notice(tab)).toHaveCount(0);
  });
});
