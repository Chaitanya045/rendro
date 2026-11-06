import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { securityHeaders } from "@/middleware/security-headers";
import { COMMENTOR_PARENT_VERSION, LAZY_TREE_VERSION, SHELL_VERSION } from "@/viewer/asset-versions";
import { buildBrowserBundle, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";
import { serveFonts } from "./helpers/fonts";
import { repoShell, shellAsset } from "./helpers/repo-shell";
import { serveStyles } from "./helpers/styles";

/**
 * How the repository shell loads (#359): its CSS and behaviour are same-origin files rather than inline code, the
 * first sidebar page is requested while the head is parsed (and reused, not fetched twice), and the tree script runs
 * before the comment host. The real shell, strict CSP and tree script; the comment host is a recording stub.
 */
const harness = createBrowserHarness();
const base = "/r/acme/docs";
const violations: string[] = [];
afterEach(() => { expect(violations, "CSP violations").toEqual([]); });

beforeAll(async () => {
  const stub = `document.addEventListener("DOMContentLoaded", () => {
    const tree = document.getElementById("tree-container");
    window.hostSawTreeStarted = tree.dataset.loadingRoot === "true" || tree.dataset.path === "acme-docs/";
  });`;
  const assets = new Map([
    ["/lazy-tree.js", await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts")],
    // Built like a real bundle (with its map), so browser coverage can account for it.
    ["/commentor-parent.js", (await buildBrowserBundle({ stdin: { contents: stub, resolveDir: process.cwd(), loader: "js" }, write: false })).outputFiles![0].text],
    shellAsset,
  ]);
  const app = new Hono();
  app.use("*", securityHeaders);
  app.get("/fonts/*", serveFonts);
  app.get("/styles/*", serveStyles);
  // A commit-pinned public tree page is cacheable (src/repo-read/routes.ts), which is what lets a preload be reused.
  app.get(`${base}/tree`, c => c.json({ children: [{ name: "index.html", type: "file" }], cursor: null }, 200, { "Cache-Control": "public, max-age=31536000, immutable" }));
  app.get(`${base}/files/*`, c => c.html("<!doctype html><html><body><h1>doc</h1></body></html>"));
  app.get(base, c => c.html(repoShell({
    namespace: "acme-docs", frameBase: base, basePath: base, selectedPath: "index.html",
    repoCommentConfig: { repoId: 1, accessUrl: `${base}/comment-access`, convexUrl: "https://example.convex.cloud" },
  })));
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((req, res) => { void listener(req, res).catch(error => res.destroy(error as Error)); }, assets);
});

/** Opens the shell, returning the page and every request it made, in the order the browser issued them. */
async function open(): Promise<{ page: Page; requests: string[] }> {
  const page = await harness.newPage();
  const requests: string[] = [];
  page.on("request", request => { requests.push(new URL(request.url()).pathname + new URL(request.url()).search); });
  await page.exposeFunction("recordViolation", (value: string) => { violations.push(value); });
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", event => {
    (window as unknown as { recordViolation: (value: string) => void }).recordViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
  }));
  await page.goto(harness.origin + base);
  await page.locator('.tree-item[data-path="acme-docs/index.html"]').waitFor();
  return { page, requests };
}

describe("the repository shell's loading order", () => {
  it("asks for the first sidebar page before any script and uses that one response", async () => {
    const { requests } = await open();
    const tree = requests.indexOf(`${base}/tree?dir=`);
    expect(tree).toBeGreaterThan(-1);
    for (const script of [`/shell.js?v=${SHELL_VERSION}`, `/lazy-tree.js?v=${LAZY_TREE_VERSION}`, `/commentor-parent.js?v=${COMMENTOR_PARENT_VERSION}`]) {
      expect(requests.indexOf(script), script).toBeGreaterThan(tree);
    }
    // The tree script's own fetch is the preload's: one network request for the page, not two.
    expect(requests.filter(url => url === `${base}/tree?dir=`)).toHaveLength(1);
  });

  it("runs the tree script before the comment host, in the same document-ready step", async () => {
    const { page } = await open();
    const order = await page.evaluate(() => [...document.scripts].map(script => script.getAttribute("src")?.split("?")[0]).filter(Boolean));
    expect(order.indexOf("/lazy-tree.js")).toBeGreaterThan(-1);
    expect(order.indexOf("/lazy-tree.js")).toBeLessThan(order.indexOf("/commentor-parent.js"));
    expect(await page.evaluate(() => (window as unknown as { hostSawTreeStarted: boolean }).hostSawTreeStarted)).toBe(true);
  });

  it("styles and scripts the shell from same-origin files, with no inline shell code and no CSP violation", async () => {
    const { page } = await open();
    expect(await page.evaluate(() => [...document.styleSheets].some(sheet => /\/styles\/shell\.[0-9a-f]{10}\.css$/.test(sheet.href ?? "") && sheet.cssRules.length > 100))).toBe(true);
    expect(await page.evaluate(() => [...document.querySelectorAll("style")].some(style => style.textContent?.includes(".topbar{")))).toBe(false);
    expect(await page.evaluate(() => [...document.scripts].some(script => !script.src && script.textContent?.includes("sidebar-resizer")))).toBe(false);
    // The shell's behaviour runs: the theme control cycles the saved preference and the reading-mode toggle hides the chrome.
    await page.locator("#shell-toggle").click();
    await page.locator("html.shell-hidden").waitFor();
    expect(await page.locator("body").evaluate(body => getComputedStyle(body).overflow)).toBe("hidden");
  });
});
