import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { securityHeaders } from "@/middleware/security-headers";
import { renderScopedDocumentShell } from "../src/routes/app";
import { bundleBrowserAsset, createBrowserHarness, waitForSettled } from "./helpers/browser";
import { serveFonts } from "./helpers/fonts";
import { serveStyles } from "./helpers/styles";

/**
 * The real viewer shell (its CSS, base stylesheet, inline script and strict CSP) with the real tree script and a
 * stubbed deployment.
 */
const harness = createBrowserHarness();
const violations: string[] = [];
const base = "/organizations/org-a/projects/project-a/docs";
const user = { id: "u", email: "reader@example.test", name: "Reader" } as User;
type Entry = { name: string; type: "file" | "folder" };
const doc = (name: string): Entry => ({ name, type: "file" });
// Names far longer than a tree row, in a script without spaces to break at.
const longFile = `${"長い名前のドキュメント".repeat(8)}.html`;
const longFolder = "とても長いフォルダの名前".repeat(6);
const longTitle = "非常に長いプロジェクトの名前 ".repeat(12).trim();
const wide = Array.from({ length: 120 }, (_, index) => doc(`w${String(index).padStart(3, "0")}.html`));
// Directory pages: the root, a closed folder, and a folder of 120 documents served 50 at a time.
const pages: Record<string, Entry[][]> = {
  "": [[{ name: "guide", type: "folder" }, { name: "wide", type: "folder" }, doc("after.html"), doc("index.html"), doc(longFile)]],
  "guide/": [[{ name: longFolder, type: "folder" }, doc("a.html"), doc("b.html"), doc(longFile)]],
  "wide/": [wide.slice(0, 50), wide.slice(50, 100), wide.slice(100)],
};

beforeAll(async () => {
  const assets = new Map([["/lazy-tree.js", await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts")]]);
  const app = new Hono();
  app.use("*", securityHeaders);
  app.get("/fonts/*", serveFonts);
  app.get("/styles/*", serveStyles);
  app.get(`${base}/tree`, c => {
    const entries = pages[c.req.query("dir") ?? ""] ?? [[]];
    const index = Number(c.req.query("cursor") ?? "0");
    return c.json({ children: entries[index] ?? [], cursor: index + 1 < entries.length ? String(index + 1) : null });
  });
  app.get(`${base}/files/*`, c => c.html(`<!doctype html><html><body style="margin:0;min-height:2000px"><h1>${decodeURIComponent(c.req.path.slice(`${base}/files/`.length))}</h1></body></html>`));
  app.get(base, c => c.html(renderScopedDocumentShell({
    user, namespace: "org-a", title: c.req.query("title") === "long" ? longTitle : "Docs", basePath: base, selectedPath: "index.html",
    shareConfig: { organizationId: "org-a", projectId: "project-a" },
  })));
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((req, res) => { void listener(req, res).catch(error => res.destroy(error as Error)); }, assets);
});

beforeEach(() => { violations.length = 0; });
afterEach(() => { expect(violations, "CSP violations in the shell and the document").toEqual([]); });

/** Collects every CSP violation the page reports, in the shell and in the document frame. */
async function recordViolations(page: Page) {
  await page.exposeFunction("recordViolation", (value: string) => { violations.push(value); });
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", event => {
    (window as unknown as { recordViolation: (value: string) => void }).recordViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
  }));
  page.on("console", message => { if (/content security policy/i.test(message.text())) violations.push(message.text()); });
}
async function open(width = 1280, reducedMotion: "reduce" | "no-preference" = "reduce", query = "") {
  const page = await harness.newPage({ viewport: { width, height: 800 }, reducedMotion });
  await recordViolations(page);
  await page.goto(harness.origin + base + query);
  await page.locator('.tree-item[data-path="org-a/index.html"].active').waitFor();
  await page.frameLocator("#content-frame").getByRole("heading", { name: "index.html" }).waitFor();
  return page;
}
const folder = (page: Page, name: string) => page.locator(`.tree-folder[data-path="org-a/${name}/"]`);
/** Links with this name that the browser exposes to assistive technology (inert and hidden content is ignored). */
async function exposedLinks(page: Page, name: string) {
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = await session.send("Accessibility.getFullAXTree") as { nodes: Array<{ ignored?: boolean; role?: { value?: string }; name?: { value?: string } }> };
    return nodes.filter(node => !node.ignored && node.role?.value === "link" && node.name?.value === name).length;
  } finally { await session.detach(); }
}
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

describe("the document tree", () => {
  it("sizes an open folder to its rows, so the rows after it start below the last one, however many pages are loaded", async () => {
    const page = await open();
    const after = '.tree-item[data-path="org-a/after.html"]';
    await folder(page, "wide").locator("> .tree-item").click();
    await page.locator('.tree-item[data-path="org-a/wide/w049.html"]').waitFor();
    const check = async (last: string) => {
      const row = await box(page, `.tree-item[data-path="org-a/wide/${last}.html"]`);
      expect((await box(page, after)).y).toBeGreaterThanOrEqual(row.y + row.height - 1);
    };
    await check("w049");
    // Later pages of the same folder grow it too, past anything a fixed cap would allow.
    await folder(page, "wide").getByRole("button", { name: "Load more..." }).click();
    await page.locator('.tree-item[data-path="org-a/wide/w099.html"]').waitFor();
    await check("w099");
    await folder(page, "wide").getByRole("button", { name: "Load more..." }).click();
    await page.locator('.tree-item[data-path="org-a/wide/w119.html"]').waitFor();
    await check("w119");
    expect((await box(page, '.tree-folder[data-path="org-a/wide/"] > .tree-folder-collapse')).height).toBeGreaterThan(120 * 20);
    // Closing it gives the space back: nothing stays drawn over the rows after it.
    await folder(page, "wide").locator("> .tree-item").click();
    await expect.poll(async () => (await box(page, '.tree-folder[data-path="org-a/wide/"] > .tree-folder-collapse')).height).toBe(0);
    const closed = await box(page, after);
    const header = await box(page, '.tree-folder[data-path="org-a/wide/"] > .tree-item');
    expect(closed.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    expect(closed.y).toBeLessThan(header.y + header.height + 12);
  });

  it("animates a folder open and closed, and settles at the size of its rows", async () => {
    const page = await open(1280, "no-preference");
    const collapse = '.tree-folder[data-path="org-a/guide/"] > .tree-folder-collapse';
    await folder(page, "guide").locator("> .tree-item").click();
    await page.locator('.tree-item[data-path="org-a/guide/b.html"]').waitFor();
    await waitForSettled(page);
    const shown = await box(page, collapse);
    const rows = await page.locator('.tree-folder[data-path="org-a/guide/"] > .tree-folder-collapse .tree-item').evaluateAll(items => items.map(item => item.getBoundingClientRect().bottom));
    expect(shown.y + shown.height).toBeGreaterThanOrEqual(Math.max(...rows) - 1);
    expect(await page.locator(collapse).evaluate(element => getComputedStyle(element).transitionProperty)).toContain("grid-template-rows");
    await folder(page, "guide").locator("> .tree-item").click();
    await waitForSettled(page);
    expect((await box(page, collapse)).height).toBe(0);
    expect(await page.locator(collapse).evaluate(element => getComputedStyle(element).opacity)).toBe("0");
  });

  it("keeps a closed folder's rows out of Tab and the accessibility tree, and brings them back when it opens", async () => {
    const page = await open();
    const guide = folder(page, "guide").locator("> .tree-item");
    await guide.focus();
    await page.keyboard.press("Enter");
    await page.locator('.tree-item[data-path="org-a/guide/b.html"]').waitFor();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('.tree-folder[data-path="org-a/guide/"] > .tree-folder-collapse') !== null)).toBe(true);
    await guide.focus();
    await page.keyboard.press("Space");
    expect(await guide.getAttribute("aria-expanded")).toBe("false");
    expect(await folder(page, "guide").locator("> .tree-folder-collapse").getAttribute("inert")).toBe("");
    // The next stop is the next folder, not a hidden row.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest(".tree-item")?.parentElement?.getAttribute("data-path"))).toBe("org-a/wide/");
    expect(await exposedLinks(page, "a")).toBe(0);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    expect(await exposedLinks(page, "a")).toBe(1);
  });
});

describe("the document tree while it loads and with long names", () => {
  it("shows a loading skeleton until the root listing arrives, then replaces it with folder and file rows", async () => {
    const page = await harness.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    await recordViolations(page);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const seen = new Promise<void>(resolve => { arrived = resolve; });
    await page.route(url => url.pathname === `${base}/tree` && url.searchParams.get("dir") === "", async route => {
      arrived();
      await gate;
      await route.continue();
    });
    try {
      await page.goto(harness.origin + base);
      await seen;
      // Until the listing arrives the tree is a labelled, busy skeleton: no rows, nothing to select.
      const skeleton = page.locator("#tree-container .tree-skeleton");
      expect(await skeleton.count()).toBe(1);
      expect(await skeleton.getAttribute("aria-label")).toBe("Loading documents");
      expect(await skeleton.getAttribute("aria-busy")).toBe("true");
      await page.locator("#tree-container[aria-busy='true']").waitFor();
      expect(await page.locator("#tree-container .tree-item").count()).toBe(0);
      expect(await skeleton.locator(".tree-skeleton-item").count()).toBeGreaterThan(1);
    } finally { release(); }
    // The rows replace the skeleton in one step: folders first, then documents; the container is no longer busy.
    await page.locator('.tree-item[data-path="org-a/index.html"]').waitFor();
    expect(await page.locator("#tree-container .tree-skeleton").count()).toBe(0);
    expect(await page.locator("#tree-container").getAttribute("aria-busy")).toBeNull();
    expect(await page.locator("#tree-container > .tree-folder > .tree-item .tree-label").allTextContents()).toEqual(["guide", "wide"]);
    expect(await page.locator("#tree-container > .tree-item .tree-label").allTextContents()).toEqual(["after", "index", longFile.replace(/\.html$/, "")]);
  });

  /** Layout of a tree label: whether its text is clipped, how, and the row it sits in. */
  const metrics = (page: Page, selector: string) => page.locator(selector).evaluate(label => {
    const style = getComputedStyle(label);
    const row = label.closest(".tree-item") as HTMLElement;
    return { clipped: label.scrollWidth > label.clientWidth, overflow: style.overflowX, ellipsis: style.textOverflow, noWrap: style.whiteSpace, row: row.getBoundingClientRect().height };
  });
  const truncated = { clipped: true, overflow: "hidden", ellipsis: "ellipsis", noWrap: "nowrap" };
  const treeScrollsSideways = (page: Page) => page.locator(".sidebar-tree").evaluate(tree => tree.scrollWidth > tree.clientWidth);

  it("truncates a long Unicode name at the top of the tree to one line with an ellipsis and keeps its whole name for assistive technology", async () => {
    const page = await open(1280, "reduce");
    const fileName = longFile.replace(/\.html$/, "");
    const long = await metrics(page, `.tree-item[data-path="org-a/${longFile}"] .tree-label`);
    const short = await metrics(page, '.tree-item[data-path="org-a/after.html"] .tree-label');
    expect(long).toMatchObject(truncated);
    // One line: a long name does not make its row taller than a short one.
    expect(long.row).toBe(short.row);
    expect(short.clipped).toBe(false);
    // The text is clipped by styles only: the full name is what the link is called, and the tree does not scroll sideways.
    expect(await page.getByRole("link", { name: fileName, exact: true }).count()).toBe(1);
    expect(await treeScrollsSideways(page)).toBe(false);
    // And the name is still a working link.
    await page.getByRole("link", { name: fileName, exact: true }).click();
    await page.frameLocator("#content-frame").getByRole("heading", { name: longFile }).waitFor();
    expect(await page.locator(`.tree-item[data-path="org-a/${longFile}"]`).getAttribute("class")).toContain("active");
  });

  // Known bug: the open folder's grid column grows to its widest label (`.tree-folder-content` has no `min-width: 0`), so
  // inside a folder a long name is not clipped at the row: it pushes the tree sideways. Remove `.fails` with the fix.
  it.fails("truncates long Unicode file and folder names inside an open folder (known bug)", async () => {
    const page = await open(1280, "reduce");
    await folder(page, "guide").locator("> .tree-item").click();
    await page.locator(`.tree-item[data-path="org-a/guide/${longFile}"]`).waitFor();
    const short = await metrics(page, '.tree-item[data-path="org-a/guide/a.html"] .tree-label');
    for (const selector of [`.tree-item[data-path="org-a/guide/${longFile}"] .tree-label`, `.tree-folder[data-path="org-a/guide/${longFolder}/"] > .tree-item .tree-label`]) {
      const long = await metrics(page, selector);
      expect(long, selector).toMatchObject(truncated);
      expect(long.row, selector).toBe(short.row);
    }
    expect(await treeScrollsSideways(page)).toBe(false);
    expect(await page.getByRole("link", { name: longFile.replace(/\.html$/, ""), exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: longFolder, exact: true }).count()).toBe(1);
  });

  it("animates only the active row while a document loads, and leaves the active bar where it is", async () => {
    const page = await open(1280, "no-preference");
    // The rows' own entrance animation (staggered, so slower on a loaded runner) is not the motion under test.
    await page.waitForFunction(() => document.querySelectorAll("#tree-container .tree-item").length > 0 && !document.querySelector(".tree-item-entering"));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const seen = new Promise<void>(resolve => { arrived = resolve; });
    await page.route(url => url.pathname === `${base}/files/after.html`, async route => {
      arrived();
      await gate;
      await route.continue();
    });
    try {
      await page.locator('.tree-item[data-path="org-a/after.html"] a.tree-link').click();
      await seen;
      await page.locator("html.doc-loading").waitFor();
      const state = await page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>("#tree-container .tree-item")];
        const motion = (row: HTMLElement) => ({ row: getComputedStyle(row).animationName, shimmer: getComputedStyle(row, "::before").animationName });
        const active = rows.filter(row => row.classList.contains("active"));
        const bar = document.getElementById("active-indicator")!;
        const target = active[0];
        return {
          active: active.map(row => ({ path: row.dataset.path, ...motion(row) })),
          others: rows.filter(row => !row.classList.contains("active")).map(motion),
          bar: { animation: getComputedStyle(bar).animationName, opacity: bar.style.opacity, transform: bar.style.transform, at: `translate(${target.offsetLeft}px, ${target.offsetTop}px)` },
        };
      });
      expect(state.active).toEqual([{ path: "org-a/after.html", row: "docPillRecoil", shimmer: "docRowShimmer" }]);
      expect(state.others.length).toBeGreaterThanOrEqual(3);
      expect(state.others.every(other => other.row === "none" && other.shimmer === "none")).toBe(true);
      // The bar sits on the active row, fully shown and not animating, however the row itself moves.
      expect(state.bar).toMatchObject({ animation: "none", opacity: "1" });
      expect(state.bar.transform).toBe(state.bar.at);
    } finally { release(); }
    await page.frameLocator("#content-frame").getByRole("heading", { name: "after.html" }).waitFor();
  });
});

describe("menus and the document", () => {
  const frameBody = (page: Page) => page.frameLocator("#content-frame").locator("body");

  it("closes the account menu when the reader clicks in the document, and leaves it alone for the keyboard", async () => {
    const page = await open();
    const button = page.locator("#avatar-btn");
    const menu = page.locator("#avatar-menu");
    await button.click();
    await menu.waitFor({ state: "visible" });
    // Moving through the menu with the keyboard keeps focus in the shell, so nothing closes.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    expect(await menu.isVisible()).toBe(true);
    // The window losing focus to another application leaves it open as well.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    expect(await menu.isVisible()).toBe(true);
    await frameBody(page).click({ position: { x: 300, y: 300 } });
    await menu.waitFor({ state: "hidden" });
    expect(await button.getAttribute("aria-expanded")).toBe("false");
    // Escape and the button still work afterwards.
    await button.click();
    await menu.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
  });

  it("closes the menus when the document reports a press inside it, and ignores the same message from anywhere else", async () => {
    // Engines that do not report the shell losing focus rely on the document's own report.
    const page = await open();
    const menu = page.locator("#avatar-menu");
    await page.locator("#avatar-btn").click();
    await menu.waitFor({ state: "visible" });
    await page.evaluate(() => window.postMessage({ type: "doc-pointer" }, "*"));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(await menu.isVisible()).toBe(true);
    await page.frameLocator("#content-frame").locator("body").evaluate(() => parent.postMessage({ type: "doc-other" }, "*"));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(await menu.isVisible()).toBe(true);
    await page.frameLocator("#content-frame").locator("body").evaluate(() => parent.postMessage({ type: "doc-pointer" }, "*"));
    await menu.waitFor({ state: "hidden" });
  });

  it("closes the phone More menu, and the account menu inside it, when the reader clicks in the document", async () => {
    const page = await open(390);
    const more = page.locator("#mobile-more-btn");
    const menu = page.locator("#mobile-more-menu");
    await more.click();
    await menu.waitFor({ state: "visible" });
    await page.locator("#avatar-btn").click();
    await page.locator("#avatar-menu").waitFor({ state: "visible" });
    expect(await page.locator("#avatar-menu").evaluate(element => element.closest("#mobile-more-menu") !== null)).toBe(true);
    await frameBody(page).click({ position: { x: 100, y: 300 } });
    await menu.waitFor({ state: "hidden" });
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator("#avatar-menu").isHidden()).toBe(true);
    // The menu still opens, and Escape still closes it and returns focus to its button.
    await more.click();
    await menu.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    expect(await more.evaluate(element => element === document.activeElement)).toBe(true);
  });
});

describe("the bar on a phone and reading mode", () => {
  it.each([320, 375, 430])("ellipsizes a long title on a %spx screen while the tree toggle, share and More stay on screen", async width => {
    const page = await open(width, "reduce", "?title=long");
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height, display: getComputedStyle(element).display };
      };
      const title = document.querySelector<HTMLElement>(".topbar-logo")!;
      const style = getComputedStyle(title);
      return {
        title: { text: title.textContent, clipped: title.scrollWidth > title.clientWidth, ellipsis: style.textOverflow, overflow: style.overflowX, noWrap: style.whiteSpace, ...rect(".topbar-logo") },
        actions: Object.fromEntries(["#mobile-tree-toggle", "#share-btn", "#mobile-more-btn"].map(selector => [selector, rect(selector)])),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(layout.title).toMatchObject({ clipped: true, ellipsis: "ellipsis", overflow: "hidden", noWrap: "nowrap" });
    expect(layout.title.text!.length).toBeGreaterThan(60);
    // One line, and the bar keeps its height however long the name is.
    expect(layout.title.height).toBeLessThan(56);
    expect(layout.overflow).toBe(0);
    for (const [selector, box] of Object.entries(layout.actions)) {
      // The actions are on screen and tappable, and the title gives way to them rather than the other way around.
      expect(box.display, selector).not.toBe("none");
      expect(box.left, selector).toBeGreaterThanOrEqual(0);
      expect(box.right, selector).toBeLessThanOrEqual(width);
      expect(box.height, selector).toBeGreaterThanOrEqual(36);
      expect(box.right <= layout.title.left || box.left >= layout.title.right, `${selector} does not overlap the title`).toBe(true);
    }
  });

  it("keeps the revealed header while the account menu is under the pointer and while focus moves through it", async () => {
    const page = await harness.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    await recordViolations(page);
    await page.clock.install();
    await page.goto(harness.origin + base);
    await page.locator('.tree-item[data-path="org-a/index.html"].active').waitFor();
    await page.frameLocator("#content-frame").getByRole("heading", { name: "index.html" }).waitFor();
    // The grace period before the header hides is a timer: the test moves it, so nothing here waits on real time.
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const revealed = () => page.evaluate(() => document.documentElement.classList.contains("shell-header-revealed"));
    await page.locator("#shell-toggle").click();
    await page.locator("html.shell-hidden").waitFor();
    expect(await revealed()).toBe(false);

    // The top edge reveals the header; opening the account menu from it puts focus in the header.
    await page.mouse.move(700, 400);
    await page.mouse.move(700, 4);
    await page.locator("html.shell-header-revealed").waitFor();
    await page.locator("#avatar-btn").click();
    await page.locator("#avatar-menu").waitFor({ state: "visible" });
    // The menu hangs below the bar. The pointer moving into it leaves the bar's own box but not the bar, and the grace
    // period passes with the header still shown.
    const item = (await page.locator("#avatar-menu .avatar-menu-item").first().boundingBox())!;
    expect(item.y).toBeGreaterThan(56);
    await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
    await page.clock.runFor(500);
    expect(await revealed()).toBe(true);
    expect(await page.locator("#avatar-menu").isVisible()).toBe(true);
    // Moving through the menu with the keyboard changes nothing either.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.clock.runFor(500);
    expect(await revealed()).toBe(true);
    expect(await page.locator("#avatar-menu").isVisible()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.closest("#avatar-menu") !== null)).toBe(true);

  });
});

describe("the theme control", () => {
  it("slides its icon over 300ms and reveals the new theme as a 520ms circle that grows from the button", async () => {
    const page = await harness.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference", colorScheme: "light" });
    await recordViolations(page);
    // Record what the page asks the browser to animate on the root element; the animation itself is the browser's.
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      (window as unknown as { rootAnimations: unknown[] }).rootAnimations = calls;
      const original = Reflect.get(Element.prototype, "animate") as Element["animate"];
      Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
        if (this === document.documentElement) calls.push({ keyframes, options });
        return original.call(this, keyframes, options);
      };
    });
    await page.goto(harness.origin + base);
    await page.locator('.tree-item[data-path="org-a/index.html"].active').waitFor();
    const button = page.locator(".rendro-theme-control");
    await button.waitFor();
    const track = page.locator(".rendro-theme-icon-track");
    // At rest the track shows the first icon with no transition (nothing slides on load).
    expect(await track.evaluate(element => ({ transition: (element as HTMLElement).style.transition, transform: (element as HTMLElement).style.transform })))
      .toEqual({ transition: "none", transform: "translateY(0px)" });
    const center = await button.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });

    await button.click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark" && document.documentElement.classList.contains("dark"));
    await page.waitForFunction(() => (window as unknown as { rootAnimations: unknown[] }).rootAnimations.length > 0);
    // The icon track moved to the next icon and its transition was left on; the reveal is one 520ms clip-path circle.
    expect(await track.evaluate(element => ({ transform: (element as HTMLElement).style.transform, transition: (element as HTMLElement).style.transition, property: getComputedStyle(element).transitionProperty, duration: getComputedStyle(element).transitionDuration })))
      .toEqual({ transform: "translateY(-20px)", transition: "", property: "transform", duration: "0.3s" });
    const [reveal, ...others] = await page.evaluate(() => (window as unknown as { rootAnimations: Array<{ keyframes: { clipPath: string[] }; options: { duration: number; easing: string; fill: string; pseudoElement: string } }> }).rootAnimations);
    expect(others).toEqual([]);
    expect(reveal.options).toEqual({ duration: 520, easing: "cubic-bezier(.4,0,.2,1)", fill: "both", pseudoElement: "::view-transition-new(root)" });
    const [from, to] = reveal.keyframes.clipPath;
    expect(from).toBe(`circle(0px at ${center.x}px ${center.y}px)`);
    const radius = Math.hypot(Math.max(center.x, 1280 - center.x), Math.max(center.y, 800 - center.y));
    expect(to).toBe(`circle(${radius}px at ${center.x}px ${center.y}px)`);
    // The reveal ends with the theme settled and the ripple state cleared.
    await page.waitForFunction(() => !document.documentElement.classList.contains("rendro-theme-rippling"));
  });
});
