import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { versionedBundles } from "../src/routes/versioned-bundles";
import { test, expect } from "./fixtures";
import { signInSeeded } from "./shell-helpers";
import type { RepoFixtures } from "./repo-fixtures";

/**
 * Public static assets on the real Worker (#95): every bundle a page loads is served from the allowlist with the
 * exact-version immutable policy and without the session stack, and a stale or foreign URL is never cached long-term.
 */
const immutable = "public, max-age=31536000, immutable";
const script = "text/javascript; charset=utf-8";
const bundlePaths = Object.keys(versionedBundles);
const currentSearch = (path: string) => `?v=${versionedBundles[path]}`;

/** Same-origin bundle responses a page receives, keyed by path+query (the frame's own requests included). */
function trackBundles(page: Page) {
  const responses = new Map<string, { status: number; headers: Record<string, string> }>();
  page.on("response", response => {
    const url = new URL(response.url());
    if (bundlePaths.includes(url.pathname)) responses.set(url.pathname + url.search, { status: response.status(), headers: response.headers() });
  });
  return responses;
}

test.describe("public static assets", () => {
  test("every bundle a signed-in page loads is immutable and bypasses the session stack", async ({ page: tab, context, baseURL, seed, cspViolations }) => {
    test.slow();
    await signInSeeded(context, baseURL, seed, "owner");
    const bundles = trackBundles(tab);
    // The signed-in home is private and no-store, and loads no bundle of its own.
    const home = await tab.goto("/home");
    expect(home?.headers()["cache-control"]).toBe("private, no-store");
    expect(home?.headers()["server-timing"]).toContain("session");
    // A private repository's shell adds the ticket renewal (private viewer) to the tree, comments and real-user
    // monitoring (#282) every repository shell loads; its document is a frame with the comment widget.
    const { closed } = JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
    await tab.goto(`/r/${closed.owner}/${closed.name}`);
    await expect(tab.frameLocator("#content-frame").getByRole("heading", { name: "Closed home", level: 1 })).toBeVisible();
    await expect(tab.locator("script[src^='/rum.js']")).toHaveCount(1);

    // The repository document and its comment frame load their `defer` scripts after the heading renders, so the list
    // is complete only once every bundle's response arrived: poll the real condition instead of reading it once.
    const loadedPaths = () => [...bundles.keys()].map(key => key.replace(/\?.*/, ""));
    for (const path of bundlePaths) await expect.poll(loadedPaths, { message: `${path} was not loaded by any page` }).toContain(path);
    for (const [key, response] of bundles) {
      const path = key.replace(/\?.*/, "");
      expect(key, "pages reference only the current version").toBe(path + currentSearch(path));
      expect(response.status, key).toBe(200);
      expect(response.headers["cache-control"], key).toBe(immutable);
      expect(response.headers["content-type"], key).toBe(script);
      expect(response.headers["x-content-type-options"], key).toBe("nosniff");
      // Only the session middleware adds Server-Timing, and a cookie-bearing asset request must not reach it.
      expect(response.headers["server-timing"], key).toBeUndefined();
      expect(response.headers["set-cookie"], key).toBeUndefined();
    }
    // Firefox warns (not a violation) that frame-ancestors supersedes X-Frame-Options on the viewer shell.
    expect(cspViolations.filter(message => !/x-frame-options/i.test(message))).toEqual([]);

    // Images and icons are public too: a daily refresh, never the session's private no-store.
    for (const [path, type] of [["/landing-product.webp", "image/webp"], ["/favicon.svg", "image/svg+xml"], ["/favicon.ico", "image/x-icon"]]) {
      const response = await tab.request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"], path).toBe(type);
      expect(response.headers()["cache-control"], path).toBe("public, max-age=86400");
      expect(response.headers()["server-timing"], path).toBeUndefined();
    }
  });

  test("a stale, foreign or missing version serves the current bytes uncached, and unlisted paths are 404", async ({ page: tab }) => {
    for (const path of bundlePaths) {
      const current = await tab.request.get(path + currentSearch(path));
      expect(current.status(), path).toBe(200);
      expect(current.headers()["cache-control"], path).toBe(immutable);
      const bytes = await current.body();
      expect(bytes.length, path).toBeGreaterThan(100);
      for (const search of ["", "?v=0", `?v=${Number(versionedBundles[path]) - 1}`, `${currentSearch(path)}&x=1`, `${currentSearch(path)}0`]) {
        const response = await tab.request.get(path + search);
        expect(response.status(), path + search).toBe(200);
        expect(response.headers()["cache-control"], path + search).toBe("no-store");
        expect(response.headers()["content-type"], path + search).toBe(script);
        expect(await response.body(), path + search).toEqual(bytes);
      }
    }
    for (const path of ["/robots.txt", "/lazy-tree.js/", "/LAZY-TREE.JS", "/fonts/", "/fonts/missing.woff2", "/scripts/asset-versions.json", "/package.json"]) {
      const response = await tab.request.get(path);
      expect(response.status(), path).toBe(404);
      expect(response.headers()["cache-control"], path).not.toContain("immutable");
    }
  });
});
