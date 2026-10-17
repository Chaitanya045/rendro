import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { renderScopedDocumentShell } from "../src/routes/app";
import { bundleBrowserAsset, createBrowserHarness, waitForSettled } from "./helpers/browser";
import { serveFonts } from "./helpers/fonts";

/** The real viewer shell (its CSS and inline script) with the real tree script and a stubbed deployment. */
const harness = createBrowserHarness();
const base = "/organizations/org-a/projects/project-a/docs";
const user = { id: "u", email: "reader@example.test", name: "Reader" } as User;
type Entry = { name: string; type: "file" | "folder" };
const doc = (name: string): Entry => ({ name, type: "file" });
const wide = Array.from({ length: 120 }, (_, index) => doc(`w${String(index).padStart(3, "0")}.html`));
// Directory pages: the root, a closed folder, and a folder of 120 documents served 50 at a time.
const pages: Record<string, Entry[][]> = {
  "": [[{ name: "guide", type: "folder" }, { name: "wide", type: "folder" }, doc("after.html"), doc("index.html")]],
  "guide/": [[doc("a.html"), doc("b.html")]],
  "wide/": [wide.slice(0, 50), wide.slice(50, 100), wide.slice(100)],
};

beforeAll(async () => {
  const assets = new Map([["/lazy-tree.js", await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts")]]);
  const app = new Hono();
  app.get("/fonts/*", serveFonts);
  app.get(`${base}/tree`, c => {
    const entries = pages[c.req.query("dir") ?? ""] ?? [[]];
    const index = Number(c.req.query("cursor") ?? "0");
    return c.json({ children: entries[index] ?? [], cursor: index + 1 < entries.length ? String(index + 1) : null });
  });
  app.get(`${base}/files/:name`, c => c.html(`<!doctype html><html><body style="margin:0;min-height:2000px"><h1>${c.req.param("name")}</h1></body></html>`));
  app.get(base, c => c.html(renderScopedDocumentShell({ user, namespace: "org-a", title: "Docs", basePath: base, selectedPath: "index.html" })));
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((req, res) => { void listener(req, res).catch(error => res.destroy(error as Error)); }, assets);
});

async function open(width = 1280, reducedMotion: "reduce" | "no-preference" = "reduce") {
  const page = await harness.newPage({ viewport: { width, height: 800 }, reducedMotion });
  await page.route(url => url.hostname === "cdn.tailwindcss.com", route => route.fulfill({ body: "" }));
  await page.goto(harness.origin + base);
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
