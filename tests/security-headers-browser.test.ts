import { serve, type ServerType } from "@hono/node-server";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import { createShareToken } from "@/share-links";
import { docsBase, mockSecurityBackend } from "./fixtures/security-headers";

let server: ServerType;
let browser: Browser;
let origin: string;
const violations: string[] = [];
const consoleCsp: string[] = [];

beforeAll(async () => {
  mockSecurityBackend();
  // Exercise the real parent protocol and widget with a deterministic comment
  // backend. Auth/Convex services are fixture boundaries, not live accounts.
  const parent = await build({ stdin: { contents: `
    import { CommentorParentHost } from "./src/commentor/parent-host";
    addEventListener("DOMContentLoaded", () => {
      const host = new CommentorParentHost(document.getElementById("content-frame"), location.origin,
        window.RENDRO_SHARE_CONFIG, {
          subscribe(scope, update) { update([], { canLoadMore:false, loading:false }); return { unsubscribe(){}, loadMore(){return false;} }; },
          subscribeReplies(scope, id, update) { update([], { canLoadMore:false, loading:false }); return { unsubscribe(){}, loadMore(){return false;} }; },
          async mutate(){ return null; }
        });
      host.start();
    });`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "browser" });
  server = serve({ hostname: "127.0.0.1", port: 0, fetch: request => worker.fetch(request, {
    ASSETS: { fetch: async (assetRequest: Request) => {
      const path = new URL(assetRequest.url).pathname;
      if (path === "/commentor-parent.js") return new Response(parent.outputFiles[0].text, { headers: { "Content-Type": "text/javascript" } });
      try {
        return new Response(await readFile(`public${path}`), { headers: { "Content-Type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".svg") ? "image/svg+xml" : "image/webp" } });
      } catch { return new Response(null, { status: 404 }); }
    } },
  }) });
  await new Promise<void>(resolve => server.on("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined) });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function pageFor(signedIn = false): Promise<Page> {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  if (signedIn) await page.context().addCookies([{ name: "better-auth.session_token", value: "test-session", url: origin }]);
  await page.exposeFunction("recordViolation", (directive: string) => { violations.push(directive); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", event => {
      (window as unknown as { recordViolation: (value: string) => void }).recordViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  page.on("console", message => { if (/content security policy|violates.*policy/i.test(message.text())) consoleCsp.push(message.text()); });
  if (!process.env.CSP_SMOKE_EXTERNAL) {
    // Offline CI: test origin allowances without depending on font/CDN uptime.
    // CSP_SMOKE_EXTERNAL=1 runs the same smoke against the real CDN/font assets.
    await page.route("https://fonts.googleapis.com/**", route => route.fulfill({ contentType: "text/css", body: "" }));
    await page.route("https://cdn.tailwindcss.com/**", route => route.fulfill({ contentType: "text/javascript", body: "window.tailwind={}" }));
    await page.route("https://cdn.tailwindcss.com?**", route => route.fulfill({ contentType: "text/javascript", body: "window.tailwind={}" }));
  }
  return page;
}

async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
  expect(violations).toEqual([]);
  expect(consoleCsp).toEqual([]);
}

describe("Chromium security header smoke", () => {
  it("loads landing and sign-in scripts/styles without CSP violations", async () => {
    const page = await pageFor();
    try {
      for (const path of ["/", "/sign-in"]) {
        await page.goto(origin + path);
        await page.waitForFunction(() => Boolean((window as unknown as { RendroTheme?: unknown }).RendroTheme));
        await settled(page);
        expect(await page.locator("h1").count()).toBeGreaterThan(0);
      }
    } finally { await page.close(); }
  }, 20_000);

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
      const response = (await page.goto(origin + path))!;
      expect(response.status()).toBe(status);
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(await page.locator("h1").textContent()).toBe(heading);
      if (path.includes("error=access_denied")) expect(await page.locator("#form-error").textContent()).toContain("Google sign-in was canceled.");
      await page.waitForFunction(() => Boolean((window as unknown as { RendroTheme?: unknown }).RendroTheme));
      const nonce = response.headers()["content-security-policy"].match(/'nonce-([^']+)'/)![1];
      const nonces = await page.locator("script:not([src]), style").evaluateAll(elements => elements.map(element => (element as HTMLElement).nonce));
      expect(nonces.length).toBeGreaterThan(0);
      expect(nonces.every(value => value === nonce)).toBe(true);
      if (status >= 400) expect(await page.locator(".panel").evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("1px");
      await settled(page);
    } finally { await page.close(); }
  }, 20_000);

  it("renders trusted document errors inside the opaque viewer", async () => {
    const page = await pageFor();
    try {
      await page.goto(origin + "/");
      await page.evaluate(path => {
        const iframe = document.createElement("iframe");
        iframe.sandbox.add("allow-scripts");
        iframe.src = path;
        document.body.append(iframe);
      }, `${docsBase}/view/invalid/files/index.html`);
      const frame = page.frameLocator("iframe");
      await frame.locator(".panel").waitFor({ state: "visible" });
      expect(await frame.locator("h1").textContent()).toBe("Page not found");
      expect(await frame.locator("html").getAttribute("class")).toContain("framed");
      expect(await frame.locator(".panel").evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("1px");
      await settled(page);
    } finally { await page.close(); }
  }, 20_000);

  it("runs management navigation under the active document nonce", async () => {
    const page = await pageFor(true);
    try {
      await page.goto(origin + "/organizations/org-a");
      await page.waitForFunction(() => Boolean((window as unknown as { RendroUI?: unknown }).RendroUI));
      // Force the fetched-page fallback, not the prebuilt controller path.
      await page.evaluate(() => { (window as unknown as { RendroManagementPages?: unknown }).RendroManagementPages = undefined; });
      const originalNonce = await page.locator("script[data-cp-page-script]").evaluate(script => (script as HTMLScriptElement).nonce);
      await page.locator('.cp-nav a[href="/organizations/org-a/projects"]').click();
      await page.waitForURL("**/organizations/org-a/projects");
      await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("Projects"));
      await settled(page);
      expect(await page.locator("script[data-cp-page-script]").evaluate(script => (script as HTMLScriptElement).nonce)).toBe(originalNonce);
    } finally { await page.close(); }
  }, 20_000);

  it("loads the opaque viewer, ticket CSS and comments postMessage bridge", async () => {
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
      await page.goto(origin + docsBase);
      if (process.env.CSP_SMOKE_EXTERNAL) expect(await page.evaluate(() => typeof (window as unknown as { tailwind?: unknown }).tailwind)).toBe("object");
      const frameElement = page.locator("#content-frame");
      await frameElement.waitFor({ state: "visible" });
      const frame = page.frames().find(frame => frame.url().includes("/files/index.html"))!;
      await frame.locator("#commentor-host").waitFor({ state: "attached" });
      await expect.poll(() => messages.includes("commentor-parent-update")).toBe(true);
      expect(await frame.evaluate(() => getComputedStyle(document.body).color)).toBe("rgb(1, 2, 3)");
      expect(await frame.evaluate(() => { try { void parent.document; return false; } catch { return true; } })).toBe(true);
      await settled(page);
    } finally { await page.close(); }
  }, 20_000);
});
