import { getRequestListener } from "@hono/node-server";
import { buildBrowserBundle as build } from "./helpers/browser";
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
let publisherBase = "";
let shellLoads = 0;
let renewals = 0;
const assetStatuses: number[] = [];
const deferredResponses: Array<{ path: string; status: number; type: string | null; nosniff: string | null }> = [];

beforeAll(async () => {
  const assets = new Map([
    ["/private-viewer.js", await bundleBrowserAsset("src/viewer/entry.ts")],
    ["/lazy-tree.js", await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts")],
  ]);
  // Exercise the production parent boot/client wiring; only the Convex transport
  // is replaced. Subscription updates are delivered explicitly, never polled.
  const parent = await browserStep("bundle comment recovery host", () => build({
    entryPoints: ["src/commentor/parent-entry.ts"], bundle: true, write: false, platform: "browser",
    plugins: [{ name: "convex-fixture", setup(build) {
      build.onResolve({ filter: /^convex\/browser$/ }, () => ({ path: "convex-fixture", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        import { getFunctionName } from 'convex/server';
        export class ConvexClient {
          constructor() { document.body.dataset.clients = String(Number(document.body.dataset.clients || 0) + 1); }
          setAuth(fetchToken) { fetchToken(); }
          onUpdate(query, args, update) {
            if (getFunctionName(query) !== 'projects:activeDeployment' || args.organizationId !== 'org' || args.projectId !== 'project') throw new Error('Unexpected subscription');
            window.publishManifest = update;
            return () => { delete window.publishManifest; };
          }
          onPaginatedUpdate_experimental(query, args, options, update) {
            queueMicrotask(() => update({ results: [], status: 'Exhausted', loadMore() { return false; } }));
            return () => {};
          }
          mutation() { document.body.dataset.pendingWrite = 'true'; return new Promise(() => {}); }
          close() { return Promise.resolve(); }
        }`, resolveDir: process.cwd(), loader: "ts" }));
    } }],
  }));
  assets.set("/commentor-parent.js", parent.outputFiles[0].text);
  assets.set("/commentor.js", (await build({ stdin: { sourcefile: "tests/fixtures/recovery-commentor.js", contents: `addEventListener('message', event => {
    if (event.source !== parent) return;
    if (event.data.type === 'commentor-parent-ready') {
      document.body.dataset.recovery = JSON.stringify(event.data.recoveryState);
      parent.postMessage({ type: 'commentor-parent-request', requestId: 'subscribe', method: 'subscribe', args: { documentPath: 'guide/page.html' } }, '*');
    }
    if (event.data.type === 'commentor-parent-response') document.body.dataset[event.data.requestId] = String(event.data.ok);
  });` } })).outputFiles[0].text);
  vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1, files: [
    { path: documentPath, contentType: "text/html" },
    { path: "guide/deferred.svg", contentType: "image/svg+xml" },
    { path: "guide/background.svg", contentType: "image/svg+xml" },
    { path: "guide/deferred.woff2", contentType: "font/woff2" },
    { path: "guide/import.css", contentType: "text/css" },
  ] }));
  vi.spyOn(minio, "getObjectStream").mockImplementation(key => {
    const content = key.endsWith(".svg")
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>'
      : `<!doctype html><html><head>${publisherBase}<title>Version ${version}</title></head><body data-version="${version}">
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
  app.get("/api/auth/get-session", c => c.json({ user: { id: "test" } }));
  app.get("/api/auth/convex/token", c => c.json({ token: "fixture" }));
  app.route("/", projectDocs);
  const listener = getRequestListener(async request => {
    const path = new URL(request.url).pathname;
    if (path === base) shellLoads++;
    if (path.endsWith("/viewer-ticket")) renewals++;
    const result = await app.fetch(request);
    if (/\/(background.svg|deferred.woff2|import.css)$/.test(path)) deferredResponses.push({
      path: path.split("/").pop()!, status: result.status,
      type: result.headers.get("content-type"), nosniff: result.headers.get("x-content-type-options"),
    });
    if (path.endsWith("deferred.svg")) assetStatuses.push(result.status);
    return result;
  });
  await harness.start((request, response) => {
    void listener(request, response).catch(error => response.destroy(error as Error));
  }, assets);
});
beforeEach(() => { publisherBase = ""; version = 1; shellLoads = 0; renewals = 0; assetStatuses.length = 0; deferredResponses.length = 0; });
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Ticket ciphertext is random and can contain diagnostic-looking text. Inspect
// browser diagnostics, excluding resource URLs, when checking for ORB failures.
function isOpaqueResponseBlocking(message: string): boolean {
  const diagnostic = message.replace(/https?:\/\/[^\s'"<>]+/g, "[url]");
  return /\b(?:ORB|CORB|OpaqueResponseBlocking|ERR_BLOCKED_BY_ORB|ERR_BLOCKED_BY_CORB)\b/i.test(diagnostic);
}

describe("private viewer republishing", () => {
  it("distinguishes opaque-response failures from diagnostic-looking ticket URLs", () => {
    const url = "http://127.0.0.1:3000/view/random-ORB-CORB-OpaqueResponseBlocking-ticket/files/font.woff2";
    expect(isOpaqueResponseBlocking(`Access to font at '${url}' from origin 'null' has been blocked by CORS policy`)).toBe(false);
    expect(isOpaqueResponseBlocking(`${url}: net::ERR_FAILED`)).toBe(false);
    for (const diagnostic of ["net::ERR_BLOCKED_BY_ORB", "OpaqueResponseBlocking", "blocked by ORB", "CORB blocked a cross-origin response"]) {
      expect(isOpaqueResponseBlocking(`${url}: ${diagnostic}`)).toBe(true);
    }
  });

  it.each(["https://publisher.invalid/assets/", "/outside-project/"])("announces a publication with publisher base %s", async href => {
    publisherBase = `<base href="${href}">`;
    const page = await harness.newPage();
    await page.context().addCookies([{ name: "better-auth.session_token", value: "fixture.signature", url: harness.origin }]);
    await page.goto(`${harness.origin}${base}?doc=${documentPath}`);
    const frame = page.frameLocator("#content-frame");
    await expect.poll(() => page.locator("#content-frame").getAttribute("data-loaded-deployment")).toBe("deploy-1");
    expect(await frame.locator("base[data-rendro-viewer]").count()).toBe(0);
    expect(await frame.locator("base").getAttribute("href")).toBe(href);
    await page.waitForFunction(() => typeof (window as unknown as { publishManifest?: unknown }).publishManifest === "function");
    // Exercise the repeat-identification path as well as the load announcement.
    await page.locator("#content-frame").evaluate(element => {
      delete (element as HTMLIFrameElement).dataset.loadedDeployment;
      (element as HTMLIFrameElement).contentWindow!.postMessage({ type: "viewer-identify" }, "*");
    });
    await expect.poll(() => page.locator("#content-frame").getAttribute("data-loaded-deployment")).toBe("deploy-1");
    version = 2;
    await page.evaluate(() => (window as unknown as { publishManifest: (id: string) => void }).publishManifest("deploy-2"));
    await page.getByRole("status").filter({ hasText: "A newer version of this document was published." }).waitFor();
    expect(renewals).toBe(0);
    expect(shellLoads).toBe(1);
    expect(await frame.locator("body").getAttribute("data-version")).toBe("1");
  });

  it.each(["subscription", "deferred asset", "heartbeat", "malicious reload loop"])("recovers after %s at the same URL with drafts and pending operations", async trigger => {
    if (trigger === "malicious reload loop") publisherBase = `<script>
      function requestReload() {
        document.body.dataset.reloadRequests = String(Number(document.body.dataset.reloadRequests || 0) + 1);
        if (!navigator.userActivation.hasBeenActive) {
          document.body.dataset.unactivatedRequests = String(Number(document.body.dataset.unactivatedRequests || 0) + 1);
        }
        parent.postMessage({ type: 'commentor-viewer-reload' }, '*');
      }
      addEventListener('load', () => {
        // Send an initial burst before automation can confer user activation.
        for (let i = 0; i < 100; i++) requestReload();
        setInterval(requestReload, 10);
      });
    </script>`;
    const page = await harness.newPage();
    await page.context().addCookies([{ name: "better-auth.session_token", value: "fixture.signature", url: harness.origin }]);
    const violations: string[] = [];
    const consoleMessages: string[] = [];
    const failedRequests: string[] = [];
    const settledRequests: string[] = [];
    page.on("requestfinished", request => settledRequests.push(new URL(request.url()).pathname.split("/").pop()!));
    page.on("requestfailed", request => settledRequests.push(new URL(request.url()).pathname.split("/").pop()!));
    page.on("console", message => consoleMessages.push(message.text()));
    page.on("requestfailed", request => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
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
    if (trigger === "malicious reload loop") {
      await frame.waitForFunction(() => Number(document.body.dataset.reloadRequests) >= 125);
      expect(Number(await frame.locator("body").getAttribute("data-unactivated-requests"))).toBeGreaterThanOrEqual(100);
    }
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
    await browserStep("attach the single parent subscription", () => page.waitForFunction(() =>
      typeof (window as unknown as { publishManifest?: unknown }).publishManifest === "function"));
    expect(await page.locator("body").getAttribute("data-clients")).toBe("1");
    version = 2; // Activate a new manifest at the real route's backend boundary.
    await frame.locator("#focus-target").focus();
    if (trigger === "malicious reload loop") {
      // The published script keeps requesting reloads before and after the
      // reader's gesture. Observe another batch to catch repeated announcements.
      await page.locator("#viewer-update-notice").evaluate(notice => {
        notice.dataset.mutations = "0";
        new MutationObserver(records => {
          notice.dataset.mutations = String(Number(notice.dataset.mutations) + records.length);
        }).observe(notice, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
      });
      const requests = await frame.evaluate(() => Number(document.body.dataset.reloadRequests));
      await frame.waitForFunction(count => Number(document.body.dataset.reloadRequests) >= count + 25, requests);
      expect(await page.locator("#viewer-update-notice").getAttribute("data-mutations")).toBe("0");
    } else if (trigger === "subscription") {
      await page.evaluate(manifestKey => {
        (window as unknown as { publishManifest: (key: string) => void }).publishManifest(manifestKey);
      }, `deploy-${version}`);
    } else if (trigger === "deferred asset") {
      await frame.locator("#deferred").evaluate(element => { (element as HTMLImageElement).src = "deferred.svg"; });
      await expect.poll(() => assetStatuses.includes(404), { message: "reject the superseded asset" }).toBe(true);
    } else {
      await page.clock.setFixedTime(Date.now() + 6 * 60_000);
      await frame.evaluate(() => dispatchEvent(new Event("focus")));
    }
    await browserStep("announce new publication", () => page.getByRole("status").filter({ hasText: trigger === "malicious reload loop" ? "Reload this document to continue." : "A newer version of this document was published." }).waitFor());
    expect(await page.getByRole("button", { name: "Reload", exact: true }).count()).toBe(1);
    expect(await frame.locator("#focus-target").evaluate(element => element === document.activeElement)).toBe(true);
    expect(await frame.locator("body").getAttribute("data-version")).toBe("1");
    expect(shellLoads).toBe(1);
    expect(renewals).toBe(trigger === "subscription" || trigger === "malicious reload loop" ? 0 : 1);
    if (trigger === "subscription") {
      // The notice precedes every asset failure; CSS resources cannot trigger it.
      expect(assetStatuses).toEqual([]);
      const paths = ["background.svg", "deferred.woff2", "import.css"];
      expect(deferredResponses).toEqual([]);
      await frame.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = `@import url("import.css");
          @font-face { font-family: Deferred; src: url("deferred.woff2"); }
          #details { background-image: url("background.svg"); font-family: Deferred; }`;
        document.head.append(style);
      });
      await expect.poll(() => paths.every(path => settledRequests.includes(path)), {
        message: "deferred background, font and import all finish or fail",
      }).toBe(true);
      expect(deferredResponses).toHaveLength(3);
      for (const response of deferredResponses) {
        expect(response.status).toBe(404);
        expect(response.type).toBeNull();
        expect(response.nosniff).toBeNull();
      }
      await browserStep("settle failed subresources", () => frame.evaluate(async () => { await document.fonts.ready; }));
    }
    expect(consoleMessages.filter(isOpaqueResponseBlocking)).toEqual([]);
    expect(failedRequests.filter(isOpaqueResponseBlocking)).toEqual([]);
    expect(page.url()).toBe(locationBefore);
    const deniedAsset = await page.request.get(oldAsset);
    expect(deniedAsset.status()).toBe(404);
    expect(deniedAsset.headers()["content-length"]).toBe("0");
    expect(deniedAsset.headers()["transfer-encoding"]).toBeUndefined();
    expect((await deniedAsset.body()).length).toBe(0);
    const nonce = await page.locator('script[data-viewer="parent"]').evaluate(element => (element as HTMLScriptElement).nonce);
    expect(nonce).not.toBe("");
    expect(await page.locator("#viewer-update-notice").evaluate(element => (element.previousElementSibling as HTMLStyleElement).nonce)).toBe(nonce);
    // The shell reloads itself via location.reload(); collect the outgoing
    // document (including the pending write) before it is destroyed.
    await harness.flushCoverage(page);
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
    if (trigger === "malicious reload loop") {
      await frame.waitForFunction(() => Number(document.body.dataset.reloadRequests) >= 125);
      expect(await page.getByRole("button", { name: "Reload", exact: true }).count()).toBe(1);
    } else expect(await page.locator("#viewer-update-notice").isVisible()).toBe(false);
    expect(shellLoads).toBe(2);
    expect(violations).toEqual([]);
  });
});
