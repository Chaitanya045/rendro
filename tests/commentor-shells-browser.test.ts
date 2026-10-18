import type { Page } from "playwright";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import publicDocs from "@/routes/public-v2";
import shareDocs from "@/routes/share-v2";
import { securityHeaders } from "@/middleware/security-headers";
import * as minio from "@/minio";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

/** A publisher script can speak the comment protocol; only a private viewer has a parent that answers it. */
const manifestKey = "tenants/org/projects/project/deployments/deploy/manifest.json";
const harness = createBrowserHarness();

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Protocol probe</title></head><body><h1>Probe</h1><script>
window.answers = [];
addEventListener("message", event => { if (event.source === parent) answers.push(event.data); });
parent.postMessage({ type: "commentor-viewer-reload" }, location.origin);
parent.postMessage({ type: "commentor-parent-request", requestId: "r1", method: "subscribe", args: {} }, location.origin);
parent.postMessage({ type: "commentor-parent-request", requestId: "r2", method: "draft.save", args: { key: "create", draft: { body: "x" } } }, location.origin);
parent.postMessage({ type: "probe-done" }, location.origin);
</script></body></html>`;

beforeAll(async () => {
  const viewer = await bundleBrowserAsset("src/viewer/entry.ts");
  const tree = await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts");
  vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1, files: [{ path: "index.html", contentType: "text/html", size: 100 }] }));
  vi.spyOn(minio, "getObjectStream").mockImplementation(() => Promise.resolve(new Response(page).body));
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/publications/public")) return Promise.resolve(Response.json({ publication: { slug: "fixture", pathPrefix: "", entryFile: "index.html" }, project: { name: "Docs" }, deployment: { manifestKey } }));
    if (url.pathname.endsWith("/shares/public")) return Promise.resolve(Response.json({ grant: { documentPath: "index.html", expiresAt: Date.now() + 60_000 }, project: { name: "Docs" }, deployment: { manifestKey } }));
    return Promise.resolve(new Response(null, { status: 404 }));
  }));
  const app = new Hono();
  app.use("*", securityHeaders);
  app.get("/private-viewer.js", c => c.body(viewer, 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  app.get("/lazy-tree.js", c => c.body(tree, 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  app.route("/", publicDocs);
  app.route("/", shareDocs);
  await harness.start((request, response) => {
    void (async () => {
      const result = await app.request(new URL(request.url!, harness.origin).href);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(error => response.destroy(error as Error));
  });
});

afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function open(path: string): Promise<Page> {
  const tab = await harness.newPage();
  await tab.addInitScript(() => {
    if (window.parent !== window) return;
    (window as unknown as { probeDone: boolean }).probeDone = false;
    addEventListener("message", event => { if ((event.data as { type?: string })?.type === "probe-done") (window as unknown as { probeDone: boolean }).probeDone = true; });
  });
  await tab.route(url => url.origin !== harness.origin, route => route.request().url().includes("cdn.tailwindcss.com")
    ? route.fulfill({ contentType: "text/javascript; charset=utf-8", body: "window.tailwind = {};" }) : route.abort());
  await browserStep("open the shell", () => tab.goto(harness.origin + path, { waitUntil: "domcontentloaded" }));
  await browserStep("wait for the publisher document to speak", () => tab.waitForFunction(() => (window as unknown as { probeDone: boolean }).probeDone));
  return tab;
}

describe("comment protocol in public and share viewers", () => {
  it.each(["/p/fixture", "/s/fixture"])("ignores a document's reload and comment requests in %s: nothing reloads, appears or answers", async path => {
    const tab = await open(path);
    try {
      const loadedAt = await tab.evaluate(() => performance.timeOrigin);
      const entries = await tab.evaluate(() => window.history.length);
      // Give the shell the same turn to react that a private viewer would take, then look.
      await tab.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await tab.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
      expect(await tab.evaluate(() => window.history.length)).toBe(entries);
      expect(await tab.locator("#viewer-update-notice").count()).toBe(0);
      expect(await tab.locator("#document-navigation-notice, #document-navigation-review").count()).toBe(0);
      const frame = tab.frames().find(candidate => candidate !== tab.mainFrame())!;
      // The shell speaks to the document about fragments, but never in the comment protocol.
      const answers = await frame.evaluate(() => (window as unknown as { answers: Array<{ type?: string }> }).answers.map(answer => answer.type ?? ""));
      expect(answers.filter(type => type.startsWith("commentor-"))).toEqual([]);
    } finally { await tab.close(); }
  });
});
