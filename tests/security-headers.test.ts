import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import * as orgs from "@/orgs";
import * as minio from "@/minio";
import * as apiKeys from "@/api-keys";
import { securityHeaders } from "@/middleware/security-headers";
import { nonceAttribute } from "@/middleware/html-nonce";
import { createShareToken } from "@/share-links";
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
}
beforeEach(mockSecurityBackend);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shared response security policy", () => {
  it.each(["/", "/sign-in", "/sign-in?error=access_denied", "/verify-email", "/sign-up", "/forgot-password", "/reset-password", "/organizations/org-a", "/account/security", "/accept-invitation/test", docsBase, "/docs/example", "/p/product", "/public/example/product", "/s/test", "/docs/unknown", "/missing"])("protects trusted HTML: %s", async path => {
    const response = await request(path, path.startsWith("/organizations") || path.startsWith("/docs") || path === "/account/security" || path.startsWith("/accept-invitation/"));
    if (path === "/organizations/org-a" || path === "/accept-invitation/test") {
      expect(response.status, "authorized management page must render, not a styled error").toBe(200);
    }
    common(response);
    expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,\s*)no-store(?:,|$)/);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    const csp = response.headers.get("Content-Security-Policy")!;
    for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "script-src-attr 'none'", "form-action 'self' https://accounts.google.com", "http://127.0.0.1:3210", "ws://127.0.0.1:3210"]) expect(csp).toContain(directive);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp.match(/script-src [^;]+/)![0]).not.toContain("'unsafe-inline'");
    const nonce = csp.match(/'nonce-([^']+)'/)![1];
    const html = await response.text();
    expect(html).toContain(`nonce="${nonce}"`);
    if (!csp.includes("style-src 'self' 'unsafe-inline'")) {
      for (const tag of html.matchAll(/<style\b[^>]*>/g)) expect(tag[0]).toContain(`nonce="${nonce}"`);
    }
    for (const tag of html.matchAll(/<script\b[^>]*>/g)) {
      if (!tag[0].includes(" src=") || /data-viewer=|src="\/lazy-tree\.js/.test(tag[0])) {
        expect(tag[0]).toContain(`nonce="${nonce}"`);
      }
    }
  });

  it.each(["/share/unknown", "/p/product/files/missing.html", "/s/test/files/missing.html", `${docsBase}/view/invalid/files/index.html`])("uses nonces and no-store for styled document errors: %s", async path => {
    const response = await request(path);
    expect(response.status).toBe(404);
    const csp = response.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("sandbox");
    const nonce = csp.match(/'nonce-([^']+)'/)![1];
    expect(await response.text()).toContain(`nonce="${nonce}"`);
    expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,\s*)no-store(?:,|$)/);
  });

  it.each(["/p/product/files/index.html", "/public/example/product/files/index.html", "/p/product/tree", "/public/example/product/tree", "/public/example/product/sitemap.xml", "/p/product/files/assets/site.css"])("keeps cacheable responses nonce-free: %s", async path => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("public, max-age=0, must-revalidate");
    expect(response.headers.get("Content-Security-Policy") ?? "").not.toContain("nonce-");
    expect(await response.text()).not.toMatch(/\bnonce\s*=/i);
  });

  it("keeps the legacy API-key page non-storable without persisting its nonce in starter HTML", async () => {
    vi.mocked(orgs.orgExists).mockResolvedValue(false);
    vi.spyOn(apiKeys, "createOrgApiKey").mockResolvedValue("fixture-api-key");
    const put = vi.spyOn(minio, "putObject").mockResolvedValue(undefined);
    const response = await worker.request("https://rendro.test/api/orgs", {
      method: "POST", headers: { origin: process.env.SITE_URL!, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ org: "example", displayName: "Example" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const nonce = response.headers.get("Content-Security-Policy")!.match(/'nonce-([^']+)'/)![1];
    expect(await response.text()).toContain(`nonce="${nonce}"`);
    expect(put).toHaveBeenCalledOnce();
    expect(String(put.mock.calls[0][1])).not.toMatch(/\bnonce\s*=/i);
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
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const nonce = response.headers.get("Content-Security-Policy")!.match(/'nonce-([^']+)'/)![1];
      expect(await response.text()).toBe(`<script nonce="${nonce}">trusted()</script><script>untrusted()</script>`);
    }
  });

  it("skips HSTS on HTTP, even with a spoofed forwarded protocol", async () => {
    const response = await worker.request("http://localhost/", { headers: { "X-Forwarded-Proto": "https" } });
    expect(response.headers.has("Strict-Transport-Security")).toBe(false);
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("keeps the private sandbox, ticket base, CORS and sensitive caching policies", async () => {
    const response = await request(`${docsBase}/files/index.html`, true);
    sandbox(response);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain('<script>window.publisherLoaded=true</script>');
    const url = html.match(/<base data-rendro-viewer href="([^"]+)"/)![1];
    const asset = await request(url.replace(/index.html$/, "assets/site.css"));
    common(asset);
    expect(asset.headers.get("Access-Control-Allow-Origin")).toBe("null");
    expect(asset.headers.get("Cache-Control")).toBe("private, no-store");
    expect(asset.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(asset.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox; frame-ancestors 'self'");
    expect(asset.headers.has("X-Frame-Options")).toBe(false);
  });

  it.each(["/p/product/files/index.html", "/s/test/files/index.html"])("keeps publisher sandbox and bytes: %s", async path => {
    const response = await request(path);
    sandbox(response);
    expect(await response.text()).toContain('<script>window.publisherLoaded=true</script>');
  });

  it("sandboxes legacy public shares and redirects private bookmarks into the isolated viewer", async () => {
    const token = createShareToken("example/index.html");
    sandbox(await request(`/share/${token}`));
    const response = await request("/files/example/index.html", true);
    common(response);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/docs/example/index.html");
    sandbox(await request("/legacy-view/example/files/index.html", true));
  });

  it.each(["/health", "/api/auth/get-session", "/p/product/tree"])("adds baseline headers without an HTML CSP: %s", async path => {
    const response = await request(path);
    common(response);
    expect(response.headers.has("Content-Security-Policy")).toBe(false);
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

  it("covers static assets and preserves their cache headers", async () => {
    const response = await worker.request("https://rendro.test/management-query.js", {}, {
      ASSETS: { fetch: () => new Response("/* asset */", { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600" } }) },
    });
    common(response);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(response.headers.has("Content-Security-Policy")).toBe(false);
    expect(await response.text()).not.toMatch(/\bnonce\s*=/i);
  });

  it("covers CORS preflights, redirects, and error responses", async () => {
    const preflight = await worker.request("https://rendro.test/api/sync/upload", { method: "OPTIONS", headers: { Origin: "https://other.test", "Access-Control-Request-Method": "POST" } });
    common(preflight);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    common(await request("/organizations"));
    vi.mocked(fetch).mockRejectedValue(new Error("backend failed"));
    const error = await request("/api/auth/get-session");
    common(error);
    expect(error.status).toBe(502);
    expect(error.headers.has("Content-Security-Policy")).toBe(false);
  });
});
