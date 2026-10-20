import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import type { User } from "better-auth/types";
import type { Context, Next } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONVEX_SITE_URL } from "@/config";
import { renderNotFoundPage } from "@/routes/not-found";

const fixtures = vi.hoisted(() => ({
  user: undefined as User | undefined,
}));
vi.mock("@/middleware/session", () => ({
  sessionMiddleware: async (c: Context, next: Next) => {
    c.set("user", fixtures.user);
    await next();
  },
}));
import worker from "@/worker";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
  fixtures.user = undefined;
});
afterEach(() => vi.unstubAllGlobals());

function styles(html: string) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
}

// Compare every byte except the per-response nonce, after checking that every
// executable/style element is authorized by that response's own policy.
function normalizeNonces(response: Response, html: string): string {
  const csp = response.headers.get("Content-Security-Policy")!;
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,\s*)no-store(?:,|$)/);
  const tags = [...html.matchAll(/<(?:style|script)\b[^>]*>/g)];
  expect(tags.length).toBeGreaterThan(0);
  for (const [tag] of tags) expect(tag).toContain(`nonce="${nonce}"`);
  return html.replaceAll(`nonce="${nonce}"`, 'nonce="NORMALIZED"');
}

describe("removed upload-era routes", () => {
  // Shares, publications, the legacy viewer and the upload API are gone (#286): each is the plain not-found page, with no lookup.
  it.each(["/share/token", "/s/token", "/s/token/files/index.html", "/p/product", "/p/product/files/index.html", "/public/acme/product/files/index.html", "/docs/acme", "/docs/acme/guide.html"])("answers %s with the plain not-found page", async path => {
    fixtures.user = { id: "user", email: "user@acme.test", name: "User", emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
    const response = await worker.request(path, { headers: { accept: "text/html" } });
    const html = await response.text();
    expect(response.status).toBe(404);
    expect(html).toContain('<h1 id="not-found-title">Page not found</h1>');
    expect(styles(html)).toEqual(styles(renderNotFoundPage()));
    normalizeNonces(response, html);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("auth error redirects through the Worker", () => {
  it.each([
    ["access_denied", "Sign-in was canceled."],
    ["state_mismatch", "Your sign-in attempt expired or could not be verified."],
    ["state_not_found", "Your sign-in attempt expired or could not be verified."],
    ["state_security_mismatch", "Your sign-in attempt expired or could not be verified."],
    ["invalid_state", "Your sign-in attempt expired or could not be verified."],
    ["unable_to_link_account", "We couldn&#039;t connect that account."],
    ["account_not_linked", "We couldn&#039;t connect that account."],
    ["account_already_linked_to_different_user", "We couldn&#039;t connect that account."],
    ["email_doesn't_match", "We couldn&#039;t connect that account."],
    ["EMAIL_NOT_VERIFIED", "We couldn&#039;t connect that account."],
    ["unexpected_error", "We couldn&#039;t complete sign-in."],
    ["<script>alert(1)</script>", "We couldn&#039;t complete sign-in."],
  ])("renders a friendly alert for %s", async (code, message) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await worker.request(`/api/auth/error?error=${encodeURIComponent(code)}&error_description=private-detail`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/sign-in?error=${encodeURIComponent(code)}`);
    expect(fetchMock).not.toHaveBeenCalled();
    const signIn = await worker.request(response.headers.get("location")!);
    const html = await signIn.text();
    expect(signIn.status).toBe(200);
    normalizeNonces(signIn, html);
    expect(html).toContain(`<p class="message error" id="form-error" role="alert">${message}`);
    expect(html).not.toContain("private-detail");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it.each(["/api/auth/error", "/api/auth/error/", "/api/auth/error?error="])("uses a friendly fallback when %s has no error code", async (path) => {
    const response = await worker.request(path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in?error=unknown_error");
    const signIn = await worker.request(response.headers.get("location")!);
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain("We couldn&#039;t complete sign-in.");
  });

  it("shows linking errors even when a user already has a session", async () => {
    fixtures.user = { id: "user", email: "user@acme.test", name: "User", emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
    const response = await worker.request("/sign-in?error=unable_to_link_account");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("We couldn&#039;t connect that account. Sign in with your existing method and verify your email first.");
  });

  it.each(["/api/auth/error", "https://rendro.test/api/auth/error", `${CONVEX_SITE_URL}/api/auth/error`])("rewrites %s redirects and preserves cookie cleanup", async (errorUrl) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: {
        location: `${errorUrl}?error=access_denied&error_description=private-detail`,
        "set-cookie": "better-auth.state=; Max-Age=0; Path=/; Domain=convex.site; HttpOnly",
      },
    })));
    const response = await worker.request("https://rendro.test/api/auth/callback/oauth?error=access_denied");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in?error=access_denied");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
  });

  it.each(["https://github.com/login/oauth/authorize", "https://rendro.test/home", "https://another.test/api/auth/error?error=access_denied"])("preserves unrelated redirects to %s", async (location) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } })));
    const response = await worker.request("https://rendro.test/api/auth/callback/oauth");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(location);
  });

  it("keeps API errors as JSON for form handlers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "INVALID_EMAIL_OR_PASSWORD" }, { status: 401 })));
    const response = await worker.request("/api/auth/sign-in/email", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "INVALID_EMAIL_OR_PASSWORD" });
  });

  it("handles a real Better Auth OAuth denial and invalid state via the Worker proxy", async () => {
    const origin = "https://rendro.test";
    const auth = betterAuth({
      baseURL: origin,
      secret: "test-auth-secret-32-chars-long!!",
      database: memoryAdapter({}),
      // A stand-in provider: the product has no OAuth sign-in until GitHub (#286), but the error path is the same.
      socialProviders: { github: { clientId: "test", clientSecret: "test" } },
      logger: { disabled: true },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return auth.handler(new Request(`${origin}${url.pathname}${url.search}`, init));
    }));
    const start = await worker.request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "github", callbackURL: `${origin}/home` }),
    });
    expect(start.status).toBe(200);
    const { url } = await start.json() as { url: string };
    const state = new URL(url).searchParams.get("state")!;
    const cookie = start.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const denied = await worker.request(`${origin}/api/auth/callback/github?error=access_denied&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toBe("/sign-in?error=access_denied");
    const signIn = await worker.request(denied.headers.get("location")!);
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain("Sign-in was canceled.");
    const invalid = await worker.request(`${origin}/api/auth/callback/github?error=access_denied&state=invalid`);
    expect(invalid.status).toBe(302);
    expect(invalid.headers.get("location")).toMatch(/^\/sign-in\?error=state_(mismatch|not_found)$/);
  });
});
