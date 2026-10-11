import { getRequestListener } from "@hono/node-server";
import { build } from "esbuild";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentRecoveryState } from "@/commentor/operation-state";
import projectDocs from "@/routes/project-docs";
import { securityHeaders } from "@/middleware/security-headers";
import * as minio from "@/minio";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
const base = "/organizations/org/projects/project/docs";
const manifest = (version: number) => `tenants/org/projects/project/deployments/deploy-${version}/manifest.json`;
const documentPath = "guide/page.html";
let version = 1;
let shellLoads = 0;
let renewals = 0;
const assetStatuses: number[] = [];

beforeAll(async () => {
  const assets = new Map([
    ["/private-viewer.js", await bundleBrowserAsset("src/viewer/entry.ts")],
    ["/lazy-tree.js", await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts")],
  ]);
  // Exercise the real parent bridge and durable operation state, replacing only
  // the backend with an unacknowledged write and the widget with protocol probes.
  const parent = await browserStep("bundle comment recovery host", () => build({ stdin: {
    contents: `import { CommentorParentHost } from "./src/commentor/parent-host";
      addEventListener('DOMContentLoaded', () => {
        const backend = {
          subscribe(scope, update) {
            queueMicrotask(() => update([], { canLoadMore: false, loading: false }));
            return { unsubscribe() {}, loadMore() { return false; } };
          },
          mutate() { document.body.dataset.pendingWrite = 'true'; return new Promise(() => {}); }
        };
        new CommentorParentHost(document.getElementById('content-frame'), location.origin,
          { organizationId: 'org', projectId: 'project', convexUrl: '' }, backend, 'test').start();
      });`, resolveDir: process.cwd(), loader: "ts",
  }, bundle: true, write: false, platform: "browser" }));
  assets.set("/commentor-parent.js", parent.outputFiles[0].text);
  assets.set("/commentor.js", `addEventListener('message', event => {
    if (event.source !== parent) return;
    if (event.data.type === 'commentor-parent-ready') {
      document.body.dataset.recovery = JSON.stringify(event.data.recoveryState);
      parent.postMessage({ type: 'commentor-parent-request', requestId: 'subscribe', method: 'subscribe', args: { documentPath: 'guide/page.html' } }, '*');
    }
    if (event.data.type === 'commentor-parent-response') document.body.dataset[event.data.requestId] = String(event.data.ok);
  });`);
  vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1, files: [
    { path: documentPath, contentType: "text/html" },
    { path: "guide/deferred.svg", contentType: "image/svg+xml" },
  ] }));
  vi.spyOn(minio, "getObjectStream").mockImplementation(key => {
    const content = key.endsWith(".svg")
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>'
      : `<!doctype html><html><head><title>Version ${version}</title></head><body data-version="${version}">
        <input id="focus-target" aria-label="Keep reading"><img id="deferred" alt="Deferred illustration">
        <div style="height:1200px"></div><h2 id="details">Details</h2></body></html>`;
    return Promise.resolve(new Response(content).body);
  });
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/deployments/active")) return Promise.resolve(Response.json({
      project: { name: "Republish fixture" }, deployment: { manifestKey: manifest(version) },
    }));
    return Promise.resolve(new Response(null, { status: 404 }));
  }));
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", securityHeaders);
  app.use("*", async (c, next) => {
    if (c.req.header("Cookie")?.includes("better-auth.session_token=fixture.signature")) {
      c.set("user", { id: "test", name: "Test", email: "test@example.test" } as User);
    }
    await next();
  });
  app.route("/", projectDocs);
  const listener = getRequestListener(async request => {
    const path = new URL(request.url).pathname;
    if (path === base) shellLoads++;
    if (path.endsWith("/viewer-ticket")) renewals++;
    const result = await app.fetch(request);
    if (path.endsWith("deferred.svg")) assetStatuses.push(result.status);
    return result;
  });
  await harness.start((request, response) => {
    void listener(request, response).catch(error => response.destroy(error as Error));
  }, assets);
});
beforeEach(() => { version = 1; shellLoads = 0; renewals = 0; assetStatuses.length = 0; });
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("private viewer republishing", () => {
  it.each(["deferred asset", "heartbeat"])("recovers from %s supersession at the same URL with drafts and pending operations", async trigger => {
    const page = await harness.newPage();
    await page.context().addCookies([{ name: "better-auth.session_token", value: "fixture.signature", url: harness.origin }]);
    await page.route(url => url.origin !== harness.origin, route => route.fulfill({
      contentType: route.request().url().includes("cdn.tailwindcss.com") ? "text/javascript" : "text/css",
      body: route.request().url().includes("cdn.tailwindcss.com") ? "window.tailwind = {};" : "",
    }));
    const violations: string[] = [];
    await page.exposeFunction("recordViolation", (value: string) => violations.push(value));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", event => {
        (window as unknown as { recordViolation: (value: string) => void }).recordViolation(event.effectiveDirective);
      });
    });
    const url = `${harness.origin}${base}?${new URLSearchParams({ doc: documentPath, docQuery: "?mode=print&tag=a&tag=b" })}#details`;
    await browserStep("open current private deployment", () => page.goto(url));
    let frame = (await (await page.locator("#content-frame").elementHandle())!.contentFrame())!;
    await browserStep("initialize comment bridge", () => frame.waitForFunction(() => document.body.dataset.subscribe === "true"));
    await frame.evaluate(() => {
      const args = { body: "Pending comment", anchor: { kind: "element", path: ["#details"] } };
      parent.postMessage({ type: "commentor-parent-request", requestId: "draft", method: "draft.save", args: { key: "create", draft: args } }, "*");
    });
    await browserStep("persist draft through the parent bridge", () => frame.waitForFunction(() => document.body.dataset.draft === "true"));
    await frame.evaluate(() => {
      parent.postMessage({ type: "commentor-parent-request", requestId: "write", method: "thread.create", args: {
        body: "Pending comment", anchor: { kind: "element", path: ["#details"] }, clientOperationId: "pending-before-republish",
      } }, "*");
    });
    await browserStep("persist operation before dispatching pending write", () => page.waitForFunction(() => document.body.dataset.pendingWrite === "true"));
    const recoveryBefore = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith("commentor-"))));
    const locationBefore = page.url();
    const oldAsset = await frame.evaluate(() => new URL("deferred.svg", document.baseURI).href);
    version = 2; // Activate a new manifest at the real route's backend boundary.
    await frame.locator("#focus-target").focus();
    if (trigger === "deferred asset") {
      await frame.locator("#deferred").evaluate(element => { (element as HTMLImageElement).src = "deferred.svg"; });
      await expect.poll(() => assetStatuses.includes(404), { message: "reject the superseded asset" }).toBe(true);
    } else {
      await page.clock.setFixedTime(Date.now() + 6 * 60_000);
      await frame.evaluate(() => dispatchEvent(new Event("focus")));
    }
    await browserStep("announce new publication", () => page.getByRole("status").filter({ hasText: "A newer version of this document was published." }).waitFor());
    expect(await page.getByRole("button", { name: "Reload", exact: true }).count()).toBe(1);
    expect(await frame.locator("#focus-target").evaluate(element => element === document.activeElement)).toBe(true);
    expect(await frame.locator("body").getAttribute("data-version")).toBe("1");
    expect(shellLoads).toBe(1);
    expect(renewals).toBe(1);
    expect(page.url()).toBe(locationBefore);
    expect((await page.request.get(oldAsset)).status()).toBe(404);
    const nonce = await page.locator('script[data-viewer="parent"]').evaluate(element => (element as HTMLScriptElement).nonce);
    expect(nonce).not.toBe("");
    expect(await page.locator("#viewer-update-notice").evaluate(element => (element.previousElementSibling as HTMLStyleElement).nonce)).toBe(nonce);
    await browserStep("explicitly reload the same document URL", async () => {
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Reload", exact: true }).click()]);
    });
    frame = (await (await page.locator("#content-frame").elementHandle())!.contentFrame())!;
    await browserStep("restore comment state in the new deployment", () => frame.waitForFunction(() => document.body.dataset.subscribe === "true"));
    expect(await frame.locator("body").getAttribute("data-version")).toBe("2");
    expect(page.url()).toBe(locationBefore);
    expect(await frame.evaluate(() => location.search)).toBe("?mode=print&tag=a&tag=b");
    await expect.poll(() => frame.locator("#details").evaluate(element => element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().top < innerHeight)).toBe(true);
    expect(await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith("commentor-"))))).toEqual(recoveryBefore);
    const restored = JSON.parse((await frame.locator("body").getAttribute("data-recovery"))!) as CommentRecoveryState;
    expect(restored.drafts.create.body).toBe("Pending comment");
    expect(Object.values(restored.operations)).toEqual([expect.objectContaining({ clientOperationId: "pending-before-republish" })]);
    await frame.locator("#deferred").evaluate(element => { (element as HTMLImageElement).src = "deferred.svg"; });
    await browserStep("load deferred asset from the current deployment", () => frame.waitForFunction(() => (document.getElementById("deferred") as HTMLImageElement).naturalWidth === 10));
    expect(await page.locator("#viewer-update-notice").isVisible()).toBe(false);
    expect(shellLoads).toBe(2);
    expect(violations).toEqual([]);
  });
});
