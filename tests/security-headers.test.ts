import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import { securityHeaders } from "@/middleware/security-headers";
import { nonceAttribute } from "@/middleware/html-nonce";
import { LAZY_TREE_VERSION } from "@/viewer/asset-versions";
import { docsBase, mockSecurityBackend } from "./fixtures/security-headers";

const cookie = "better-auth.session_token=test-session";
const request = (path: string, signedIn = false) => worker.request(`https://rendro.test${path}`, {
  headers: signedIn ? { Cookie: cookie } : {},
});
function common(response: Response) {
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=15552000");
  for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
    expect(response.headers.get("Permissions-Policy")).toContain(`${feature}=()`);
  }
}
function sandbox(response: Response) {
  common(response);
  expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  expect(response.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'");
  // Opaque-origin documents: COOP would refuse them in sandboxed
  // popups, and CORP would block their own no-cors subresource loads.
  expect(response.headers.has("Cross-Origin-Opener-Policy")).toBe(false);
  expect(response.headers.has("Cross-Origin-Resource-Policy")).toBe(false);
}
beforeEach(mockSecurityBackend);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shared response security policy", () => {
  it.each(["/", "/sign-in", "/sign-in?error=access_denied", "/verify-email", "/sign-up", "/forgot-password", "/reset-password", "/home", "/account/security", docsBase, "/docs/example", "/missing"])("protects trusted HTML: %s", async path => {
    const response = await request(path, path === "/home" || path === "/account/security");
    if (path === "/home") expect(response.status, "the signed-in home must render, not a styled error").toBe(200);
    common(response);
    expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,\s*)no-store(?:,|$)/);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    const csp = response.headers.get("Content-Security-Policy")!;
    for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "script-src-attr 'none'", "form-action 'self' https://accounts.google.com", "http://127.0.0.1:3210", "ws://127.0.0.1:3210"]) expect(csp).toContain(directive);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp.match(/script-src [^;]+/)![0]).not.toContain("'unsafe-inline'");
    // Fonts are self-hosted: no font CDN in any directive, and fonts only from this origin.
    expect(csp).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
    expect(csp.match(/font-src [^;]+/)![0]).toBe("font-src 'self'");
    expect(csp.match(/style-src [^;]+/)![0]).not.toMatch(/https?:/);
    const nonce = csp.match(/'nonce-([^']+)'/)![1];
    const html = await response.text();
    expect(html).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
    expect(html).toContain(`nonce="${nonce}"`);
    for (const tag of html.matchAll(/<style\b[^>]*>/g)) expect(tag[0]).toContain(`nonce="${nonce}"`);
    // 'strict-dynamic' ignores 'self': every parser-inserted script and script
    // preload must carry the request nonce, or CSP3 browsers refuse it.
    expect(csp.match(/script-src [^;]+/)![0]).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    for (const tag of html.matchAll(/<script\b[^>]*>|<link\b[^>]*\bas="script"[^>]*>/g)) expect(tag[0]).toContain(`nonce="${nonce}"`);
    expect(csp).not.toMatch(/tailwind|cdn\./i);
    expect(html).not.toMatch(/cdn\.tailwindcss\.com/);
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it.each([
    // Every trusted page, the repository shell's 404 among them: nonced styles only.
    [docsBase, false], ["/", false], ["/sign-in", false], ["/home", true], ["/account/security", true],
  ] as const)("uses nonced styles only: %s", async (path, signedIn) => {
    const csp = (await request(path, signedIn)).headers.get("Content-Security-Policy")!;
    const nonce = csp.match(/'nonce-([^']+)'/)![1];
    expect(csp.match(/style-src [^;]+/)![0]).toBe(`style-src 'self' 'nonce-${nonce}'`);
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
  });

  it("never lets trusted HTML be stored, whatever caching its route asked for", async () => {
    const app = new Hono().use(securityHeaders)
      .get("/public-page", c => c.html(`<!doctype html><style${nonceAttribute()}>p{}</style><p>Page</p>`, 200, { "Cache-Control": "public, max-age=3600" }))
      .get("/private-page", c => c.html("<!doctype html><p>Page</p>", 200, { "Cache-Control": "private, max-age=60" }));
    // A stored copy would replay its nonce: every such policy becomes private, no-store.
    expect((await app.request("https://rendro.test/public-page")).headers.get("Cache-Control")).toBe("private, no-store");
    expect((await app.request("https://rendro.test/private-page")).headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("uses nonces and no-store for styled document errors inside the frame", async () => {
    const path = `${docsBase}/files/missing.html`;
    const app = new Hono().use(securityHeaders).get(path, c => c.html(`<!doctype html><style${nonceAttribute()}>p{}</style><p>Missing</p>`, 404));
    const response = await app.request(`https://rendro.test${path}`);
    expect(response.status).toBe(404);
    // Framed inside the viewer: no opener policy, but never embeddable cross-origin.
    expect(response.headers.has("Cross-Origin-Opener-Policy")).toBe(false);
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const csp = response.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("sandbox");
    const nonce = csp.match(/'nonce-([^']+)'/)![1];
    expect(await response.text()).toContain(`nonce="${nonce}"`);
    expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,\s*)no-store(?:,|$)/);
  });

  it("keeps cacheable document responses nonce-free and their cache policy", async () => {
    const path = `${docsBase}/@${"a".repeat(40)}/files/index.html`;
    const app = new Hono().use(securityHeaders).get(path, c => c.html("<h1>Document</h1>", 200, { "Cache-Control": "public, max-age=31536000, immutable" }));
    const response = await app.request(`https://rendro.test${path}`);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Content-Security-Policy") ?? "").not.toContain("nonce-");
    expect(await response.text()).toBe("<h1>Document</h1>");
  });

  it("isolates nonces across concurrent requests and never stamps arbitrary scripts", async () => {
    const app = new Hono().use(securityHeaders).get("/", async c => {
      await Promise.resolve();
      return c.html(`<script${nonceAttribute()}>trusted()</script><script>untrusted()</script>`);
    });
    const responses = await Promise.all(Array.from({ length: 10 }, async () => await app.request("/")));
    const policies = responses.map(response => response.headers.get("Content-Security-Policy"));
    expect(new Set(policies).size).toBe(10);
    for (const response of responses) {
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const nonce = response.headers.get("Content-Security-Policy")!.match(/'nonce-([^']+)'/)![1];
      expect(await response.text()).toBe(`<script nonce="${nonce}">trusted()</script><script>untrusted()</script>`);
    }
  });

  it("adds the fallback sandbox when a document response has no CSP", async () => {
    for (const path of [`${docsBase}/files/index.html`, `${docsBase}/~main/view/ticket/files/index.html`]) {
      const app = new Hono().use(securityHeaders).get(path, c => c.html("<h1>Document</h1>"));
      const response = await app.request(`https://rendro.test${path}`);
      sandbox(response);
      expect(await response.text()).toBe("<h1>Document</h1>");
    }
  });

  it("skips HSTS on HTTP, even with a spoofed forwarded protocol", async () => {
    const response = await worker.request("http://localhost/", { headers: { "X-Forwarded-Proto": "https" } });
    expect(response.headers.has("Strict-Transport-Security")).toBe(false);
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it.each(["/health", "/api/auth/get-session"])("adds baseline headers without an HTML CSP: %s", async path => {
    const response = await request(path);
    common(response);
    expect(response.headers.has("Content-Security-Policy")).toBe(false);
    expect(response.headers.has("Cross-Origin-Opener-Policy")).toBe(false);
    // Only API data refuses cross-origin no-cors embedding; health stays as it was.
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(path.startsWith("/api/") ? "same-origin" : null);
  });

  it("keeps auth error redirects in the baseline header class", async () => {
    for (const path of ["/api/auth/error?error=access_denied", "/api/auth/callback/google"]) {
      vi.mocked(fetch).mockResolvedValue(new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1:3211/api/auth/error?error=access_denied" },
      }));
      const response = await request(path);
      common(response);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/sign-in?error=access_denied");
      expect(response.headers.has("Content-Security-Policy")).toBe(false);
      expect(response.headers.has("X-Frame-Options")).toBe(false);
    }
  });

  it("covers static assets and applies the public asset cache policy", async () => {
    const response = await worker.request(`https://rendro.test/lazy-tree.js?v=${LAZY_TREE_VERSION}`, {}, {
      ASSETS: { fetch: () => new Response("/* asset */", { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600" } }) },
    });
    common(response);
    // Opaque viewer frames load app scripts with no-cors <script src>.
    expect(response.headers.has("Cross-Origin-Resource-Policy")).toBe(false);
    expect(response.headers.has("Cross-Origin-Opener-Policy")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.has("Content-Security-Policy")).toBe(false);
    expect(await response.text()).not.toMatch(/\bnonce\s*=/i);
  });

  it("covers CORS preflights, redirects, and error responses", async () => {
    // The one preflight route left is the Better Auth proxy, which answers through Convex.
    const preflight = await worker.request("https://rendro.test/api/auth/sign-in/email", { method: "OPTIONS", headers: { Origin: "https://other.test", "Access-Control-Request-Method": "POST" } });
    common(preflight);
    common(await request("/home"));
    vi.mocked(fetch).mockRejectedValue(new Error("backend failed"));
    const error = await request("/api/auth/get-session");
    common(error);
    expect(error.status).toBe(502);
    expect(error.headers.has("Content-Security-Policy")).toBe(false);
    expect(error.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(preflight.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });
});
