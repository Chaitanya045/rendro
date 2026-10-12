import AxeBuilder from "@axe-core/playwright";
import * as minio from "@/minio";
import { getRequestListener } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import { COMMENTOR_PARENT_READY, COMMENTOR_PROTOCOL_VERSION } from "@/commentor/parent-protocol";
import { createShareToken } from "@/share-links";
import { docsBase, mockSecurityBackend, publisherHtml, testUser } from "./fixtures/security-headers";
import { browserStep, bundleBrowserAsset, createBrowserHarness, waitForSettled } from "./helpers/browser";

const harness = createBrowserHarness();
const violations: string[] = [];
const consoleCsp: string[] = [];

beforeAll(async () => {
  mockSecurityBackend();
  vi.spyOn(minio, "listImmediate").mockResolvedValue({ entries: [], isTruncated: false });
  // verify runs tests before build:assets, so a clean CI checkout has none of
  // these ignored bundles. Build from source instead of reading stale local JS.
  const assets = new Map<string, string>();
  for (const [path, entry] of [
    ["/private-viewer.js", "src/viewer/entry.ts"],
    ["/lazy-tree.js", "src/lazy-tree/lazy-tree.ts"],
    ["/commentor.js", "src/commentor/commentor.ts"],
  ]) {
    assets.set(path, await bundleBrowserAsset(entry));
  }
  // Exercise the real parent protocol and widget with a deterministic comment
  // backend. Auth/Convex services are fixture boundaries, not live accounts.
  const parent = await browserStep("bundle comment parent fixture", () => build({ stdin: { contents: `
    import { CommentorParentHost } from "./src/commentor/parent-host";
    addEventListener("DOMContentLoaded", () => {
      const host = new CommentorParentHost(document.getElementById("content-frame"), location.origin,
        window.RENDRO_SHARE_CONFIG ?? window.RENDRO_LEGACY_COMMENT_CONFIG, {
          subscribe(scope, update) { update([], { canLoadMore:false, loading:false }); return { unsubscribe(){}, loadMore(){return false;} }; },
          subscribeReplies(scope, id, update) { update([], { canLoadMore:false, loading:false }); return { unsubscribe(){}, loadMore(){return false;} }; },
          async mutate(){ return null; }
        }, ${JSON.stringify(testUser.id)});
      host.start();
    });`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "browser" }));
  assets.set("/commentor-parent.js", parent.outputFiles[0].text);
  const requestListener = getRequestListener(request => worker.fetch(request, {
    ASSETS: { fetch: async (assetRequest: Request) => {
      const path = new URL(assetRequest.url).pathname;
      if (assets.has(path)) return new Response(assets.get(path), { headers: { "Content-Type": "text/javascript" } });
      try {
        return new Response(await readFile(`public${path}`), { headers: { "Content-Type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".svg") ? "image/svg+xml" : "image/webp" } });
      } catch { return new Response(null, { status: 404 }); }
    } },
  }));
  await harness.start((request, response) => {
    void requestListener(request, response).catch(error => response.destroy(error as Error));
  });
  // The harness checks transport readiness; also exercise the real app routes.
  const probe = await harness.newPage();
  try {
    const health = await browserStep("app health check", () => probe.request.get(`${harness.origin}/health`));
    expect(health.status(), "fixture server health check").toBe(200);
    for (const path of assets.keys()) {
      const response = await browserStep(`check fixture asset ${path}`, () => probe.request.get(harness.origin + path));
      expect(response.status(), `fixture asset ${path}`).toBe(200);
      expect(response.headers()["content-type"], `fixture asset MIME ${path}`).toBe("text/javascript");
    }
  } finally { await probe.context().close(); }
});

afterAll(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function pageFor(signedIn = false): Promise<Page> {
  const page = await harness.newPage({ ignoreHTTPSErrors: true });
  if (signedIn) await page.context().addCookies([{ name: "better-auth.session_token", value: "test-session", url: harness.origin }]);
  await page.exposeFunction("recordViolation", (directive: string) => { violations.push(directive); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", event => {
      (window as unknown as { recordViolation: (value: string) => void }).recordViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  page.on("console", message => { if (/content security policy|violates.*policy/i.test(message.text())) consoleCsp.push(message.text()); });
  // Page routes fulfill intentional CDN/font fixtures before the offline guard.
  await page.route(url => url.hostname === "cdn.tailwindcss.com" || url.hostname === "fonts.googleapis.com", route => {
    const url = new URL(route.request().url());
    if (url.hostname === "cdn.tailwindcss.com") return route.fulfill({ contentType: "text/javascript", body: "window.tailwind={}" });
    return route.fulfill({ contentType: "text/css", body: "" });
  });
  return page;
}

async function settled(page: Page) {
  await browserStep("page finishes loading before CSP checks", () => page.waitForLoadState("load"));
  expect(violations).toEqual([]);
  expect(consoleCsp).toEqual([]);
}

describe("Chromium security header smoke", () => {
  it("loads landing and sign-in scripts/styles without CSP violations", async () => {
    const page = await pageFor();
    try {
      for (const path of ["/", "/sign-in"]) {
        await browserStep(`navigate to ${path}`, () => page.goto(harness.origin + path));
        await browserStep("initialize page theme", () => page.waitForFunction(() => Boolean((window as unknown as { RendroTheme?: unknown }).RendroTheme)));
        await settled(page);
        expect(await page.locator("h1").count()).toBeGreaterThan(0);
      }
    } finally { await page.close(); }
  });

  it.each([
    ["/sign-in?error=access_denied", false, 200, "Sign in to Rendro"],
    ["/api/auth/error?error=access_denied", false, 200, "Sign in to Rendro"],
    ["/verify-email?verified=1", false, 200, "Email verified"],
    ["/missing", false, 404, "Page not found"],
    ["/docs/unknown", true, 404, "Page not found"],
    ["/share/unknown", false, 404, "Share link unavailable"],
    [`/share/${createShareToken("example/index.html", 100)}`, false, 410, "Share link unavailable"],
    ["/s/test/files/missing.html", false, 404, "Page not found"],
  ] as const)("loads styled auth/error HTML under CSP: %s", async (path, signedIn, status, heading) => {
    const page = await pageFor(signedIn);
    try {
      const response = (await browserStep(`navigate to ${path}`, () => page.goto(harness.origin + path)))!;
      expect(response.status()).toBe(status);
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(await page.locator("h1").textContent()).toBe(heading);
      if (path.includes("error=access_denied")) expect(await page.locator("#form-error").textContent()).toContain("Google sign-in was canceled.");
      await browserStep("initialize page theme", () => page.waitForFunction(() => Boolean((window as unknown as { RendroTheme?: unknown }).RendroTheme)));
      const nonce = response.headers()["content-security-policy"].match(/'nonce-([^']+)'/)![1];
      const nonces = await page.locator("script:not([src]), style").evaluateAll(elements => elements.map(element => (element as HTMLElement).nonce));
      expect(nonces.length).toBeGreaterThan(0);
      expect(nonces.every(value => value === nonce)).toBe(true);
      if (status >= 400) expect(await page.locator(".panel").evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("1px");
      await settled(page);
    } finally { await page.close(); }
  });

  it("renders trusted document errors inside the opaque viewer", async () => {
    const page = await pageFor();
    try {
      await browserStep("load shell for opaque error frame", () => page.goto(harness.origin + "/"));
      await page.evaluate(path => {
        const iframe = document.createElement("iframe");
        iframe.sandbox.add("allow-scripts");
        iframe.src = path;
        document.body.append(iframe);
      }, `${docsBase}/view/invalid/files/index.html`);
      const frame = page.frameLocator("iframe");
      await browserStep("render opaque document error", () => frame.locator(".panel").waitFor({ state: "visible" }));
      expect(await frame.locator("h1").textContent()).toBe("Page not found");
      expect(await frame.locator("html").getAttribute("class")).toContain("framed");
      expect(await frame.locator(".panel").evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("1px");
      await settled(page);
    } finally { await page.close(); }
  });

  it("runs management navigation under the active document nonce", async () => {
    const page = await pageFor(true);
    try {
      const response = await browserStep("load organization management", () => page.goto(harness.origin + "/organizations/org-a"));
      expect(response?.status()).toBe(200);
      await browserStep("initialize management UI", () => page.waitForFunction(() => Boolean((window as unknown as { RendroUI?: unknown }).RendroUI)));
      // Force the fetched-page fallback, not the prebuilt controller path.
      await page.evaluate(() => { (window as unknown as { RendroManagementPages?: unknown }).RendroManagementPages = undefined; });
      const originalNonce = await page.locator("script[data-cp-page-script]").evaluate(script => (script as HTMLScriptElement).nonce);
      await browserStep("navigate to projects with the current document nonce", async () => {
        await page.locator('.cp-nav a[href="/organizations/org-a/projects"]').click();
        await page.waitForURL("**/organizations/org-a/projects");
        await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("Projects"));
      });
      await settled(page);
      expect(await page.locator("script[data-cp-page-script]").evaluate(script => (script as HTMLScriptElement).nonce)).toBe(originalNonce);
    } finally { await page.close(); }
  });

  it("loads the opaque viewer, ticket CSS and comments bridge, and reloads the viewer under CSP", async () => {
    const page = await pageFor(true);
    try {
      const messages: string[] = [];
      await page.exposeFunction("recordCommentMessage", (type: string) => { messages.push(type); });
      await page.addInitScript(() => {
        addEventListener("message", event => {
          const type: unknown = event.data?.type;
          if (typeof type === "string" && type.startsWith("commentor-")) {
            (window as unknown as { recordCommentMessage: (value: string) => void }).recordCommentMessage(type);
          }
        });
      });
      await browserStep("load viewer shell", () => page.goto(harness.origin + docsBase));
      expect(await page.evaluate(() => typeof (window as unknown as { tailwind?: unknown }).tailwind)).toBe("object");
      await browserStep("tree script selects a document and reveals the iframe", () => page.locator("#content-frame").waitFor({ state: "visible" }));
      const frame = page.frameLocator("#content-frame");
      await browserStep("opaque document and comment widget load", () => frame.locator("#commentor-host").waitFor({ state: "attached" }));
      await expect.poll(() => messages.includes("commentor-parent-update"), {
        message: "commentor-parent-update must arrive after the READY handshake",
      }).toBe(true);
      await expect.poll(() => frame.locator("body").evaluate(body => getComputedStyle(body).color), {
        message: "ticket CSS must set the document body color",
      }).toBe("rgb(1, 2, 3)");
      expect(await frame.locator("body").evaluate(() => { try { void parent.document; return false; } catch { return true; } })).toBe(true);
      await settled(page);
      expect(await page.locator('script[src="/commentor-parent.js?v=11"]').count()).toBe(1);
      expect(await frame.locator('script[src="/commentor.js?v=43"]').count()).toBe(1);
      const originalNonce = await page.locator('script[src="/commentor-parent.js?v=11"]').evaluate(script => (script as HTMLScriptElement).nonce);
      expect(originalNonce).not.toBe("");

      // A version mismatch may only request the parent-owned notice. Reload
      // requires a second, trusted action outside the opaque document.
      await page.locator("#content-frame").evaluate((element, ready) => {
        (element as HTMLIFrameElement).contentWindow!.postMessage(ready, "*");
      }, { type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION + 1, parentGeneration: "future", canReloadViewer: true });
      await frame.getByTestId("commentor-panel-btn").click();
      await frame.getByRole("button", { name: "Show reload notice", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Reload this document to continue." }).waitFor();
      expect(await page.locator('script[src="/commentor-parent.js?v=11"]').evaluate(script => (script as HTMLScriptElement).nonce)).toBe(originalNonce);
      await browserStep("reload through the parent-owned notice", () => Promise.all([
        page.waitForNavigation({ waitUntil: "load" }),
        page.getByRole("button", { name: "Reload", exact: true }).click(),
      ]));
      await expect.poll(() => messages.filter(type => type === "commentor-parent-update").length).toBeGreaterThan(1);
      const refreshedNonce = await page.locator('script[src="/commentor-parent.js?v=11"]').evaluate(script => (script as HTMLScriptElement).nonce);
      expect(refreshedNonce).not.toBe("");
      expect(refreshedNonce).not.toBe(originalNonce);
      await settled(page);
    } finally { await page.close(); }
  });
});


describe("untrusted reload requests across viewer shells", () => {
  it.each([
    ["share", "/s/test", false, false],
    ["public", "/p/product", false, false],
    ["legacy public", "/public/example/product", false, false],
    ["legacy private", "/docs/example/index.html", true, true],
    ["private", `${docsBase}?doc=index.html`, true, true],
  ] as const)("never navigates the %s shell without a parent gesture", async (_name, path, signedIn, offersNotice) => {
    const stream = vi.mocked(minio.getObjectStream);
    const original = stream.getMockImplementation()!;
    stream.mockImplementation(key => key.endsWith(".css") ? original(key) : Promise.resolve(new Response(
      publisherHtml.replace("</body>", `<script>
        function requestReload() {
          document.body.dataset.reloadRequests = String(Number(document.body.dataset.reloadRequests || 0) + 1);
          if (!navigator.userActivation.hasBeenActive) {
            document.body.dataset.unactivatedRequests = String(Number(document.body.dataset.unactivatedRequests || 0) + 1);
          }
          parent.postMessage({ type: 'commentor-viewer-reload', userActivation: true }, '*');
        }
        addEventListener('load', () => {
          // Send an initial burst before automation can confer user activation.
          for (let i = 0; i < 100; i++) requestReload();
          setInterval(requestReload, 10);
        });
      </script></body>`),
    ).body));
    try {
      const page = await pageFor(signedIn);
      let navigations = 0;
      page.on("request", request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
      });
      await page.goto(harness.origin + path);
      let frame = (await (await page.locator("#content-frame").elementHandle())!.contentFrame())!;
      await frame.waitForFunction(() => Number(document.body.dataset.reloadRequests) >= 125);
      expect(Number(await frame.locator("body").getAttribute("data-unactivated-requests"))).toBeGreaterThanOrEqual(100);
      expect(navigations).toBe(1);
      const notice = page.getByRole("complementary", { name: "Document update" });
      expect(await notice.count()).toBe(offersNotice ? 1 : 0);
      if (offersNotice) {
        expect(await notice.getByRole("status").getAttribute("aria-live")).toBe("polite");
        const url = page.url();
        const reload = notice.getByRole("button", { name: "Reload", exact: true });
        await reload.focus();
        await Promise.all([page.waitForEvent("load"), page.keyboard.press("Enter")]);
        frame = (await (await page.locator("#content-frame").elementHandle())!.contentFrame())!;
        await frame.waitForFunction(() => Number(document.body.dataset.reloadRequests) >= 125);
        expect(page.url()).toBe(url);
        expect(navigations).toBe(2);
        expect(await notice.count()).toBe(1);
      }
      await settled(page);
    } finally { stream.mockImplementation(original); }
  });
});

describe("viewer accessibility under CSP", () => {
  it.each([
    ["share", "/s/test", false],
    ["public", "/p/product", false],
    ["legacy public", "/public/example/product", false],
    ["legacy private", "/docs/example/index.html", true],
    ["private", `${docsBase}?doc=index.html`, true],
  ] as const)("exposes one main document landmark in the %s shell", async (_name, path, signedIn) => {
    const page = await pageFor(signedIn);
    const response = await browserStep("load viewer shell", () => page.goto(harness.origin + path));
    expect(response?.status()).toBe(200);
    await browserStep("load the primary document", () => page.frameLocator("#content-frame").locator("h1").waitFor());
    await waitForSettled(page);
    expect(await page.getByRole("main").count()).toBe(1);
    expect(await page.locator("main #content-frame").count()).toBe(1);
    if (_name === "share") {
      const viewport = page.viewportSize()!;
      expect(await page.locator("#content-frame").boundingBox()).toEqual({ x: 0, y: 48, width: viewport.width, height: viewport.height - 48 });
    }
    // Publisher HTML has its own semantics; audit the Rendro shell only.
    const result = await browserStep("axe viewer landmarks", () => new AxeBuilder({ page })
      .options({ preload: false, iframes: false })
      .withRules(["landmark-one-main", "landmark-no-duplicate-main", "landmark-main-is-top-level"])
      .analyze());
    expect(result.violations).toEqual([]);
    expect(result.incomplete).toEqual([]);
    expect(result.passes.map(rule => rule.id)).toContain("landmark-one-main");
    await settled(page);
  });

  it("labels a drafted composer and exposes only named, open tooltips", async () => {
    const page = await pageFor(true);
    await browserStep("open private document", () => page.goto(`${harness.origin}${docsBase}?doc=index.html`));
    const content = page.frameLocator("#content-frame");
    const comment = content.getByTestId("commentor-comment-btn");
    await expect.poll(() => comment.isEnabled()).toBe(true);
    const frame = page.frames().find(candidate => candidate !== page.mainFrame())!;
    const tip = content.getByTestId("commentor-tip");
    expect(await tip.textContent()).toBe("");
    expect(await content.getByRole("tooltip").count()).toBe(0);
    await comment.click();
    await content.locator("p").click();
    const textarea = content.getByRole("textbox", { name: "Comment", exact: true });
    await textarea.fill("Unsent accessibility regression draft");
    await page.mouse.move(0, 0);
    await waitForSettled(frame);
    expect(await textarea.inputValue()).toBe("Unsent accessibility regression draft");
    expect(await content.getByRole("tooltip").count()).toBe(0);
    const audit = () => browserStep("axe comment labels and tooltips", () => new AxeBuilder({ page })
      .include(["#content-frame", "#commentor-host"])
      .options({ preload: false })
      .withRules(["label", "label-title-only", "aria-tooltip-name"])
      .analyze());
    const closed = await audit();
    expect(closed.violations).toEqual([]);
    expect(closed.incomplete).toEqual([]);
    expect(closed.passes.map(rule => rule.id)).toContain("label-title-only");

    await comment.focus();
    await browserStep("show the keyboard tooltip", () => content.getByRole("tooltip").waitFor());
    await waitForSettled(frame);
    expect(await content.getByRole("tooltip", { name: await comment.getAttribute("data-tip") ?? "" }).count()).toBe(1);
    const opened = await audit();
    expect(opened.violations).toEqual([]);
    expect(opened.incomplete).toEqual([]);
    expect(opened.passes.map(rule => rule.id)).toContain("aria-tooltip-name");
    await textarea.focus();
    await waitForSettled(frame);
    expect(await content.getByRole("tooltip").count()).toBe(0);
    expect((await audit()).violations).toEqual([]);
    await settled(page);
  });
});
