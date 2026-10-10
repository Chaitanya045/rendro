import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import type { User } from "better-auth/types";
import type { Context, Next } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShareToken } from "@/share-links";
import { CONVEX_SITE_URL } from "@/config";
import { renderNotFoundPage } from "@/routes/not-found";

const fixtures = vi.hoisted(() => ({
  user: undefined as User | undefined,
  deleted: vi.fn(),
  stream: vi.fn(),
}));
vi.mock("@/middleware/session", () => ({
  sessionMiddleware: async (c: Context, next: Next) => {
    c.set("user", fixtures.user);
    await next();
  },
}));
vi.mock("@/soft-delete", () => ({ isDeleted: fixtures.deleted }));
vi.mock("@/minio", () => ({ getObjectStream: fixtures.stream }));
import worker from "@/worker";

beforeEach(() => {
  fixtures.user = undefined;
  fixtures.deleted.mockReset().mockResolvedValue(false);
  fixtures.stream.mockReset().mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

function styles(html: string) {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
}

async function expectShareError(token: string, status: number) {
  const response = await worker.request(`/share/${token}`);
  const html = await response.text();
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(html).toContain(`Error ${status}`);
  expect(html).toContain("Share link unavailable");
  expect(html).toContain("Ask the sender for a new link.");
  expect(html).toContain('href="/" target="_top">Go to Rendro</a>');
  expect(html).not.toContain(token);
  // Reuse the exact 404 CSS, including both themes and mobile breakpoints.
  expect(styles(html)).toEqual(styles(renderNotFoundPage()));
  expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
  return html;
}

describe("unavailable share pages", () => {
  it("returns a styled 404 for unknown and tampered tokens without looking up documents", async () => {
    await expectShareError("unknown-token", 404);
    await expectShareError(`${createShareToken("private/index.html")}tampered`, 404);
    expect(fixtures.deleted).not.toHaveBeenCalled();
    expect(fixtures.stream).not.toHaveBeenCalled();
  });

  it("returns a styled 410 only for an authenticated expired token", async () => {
    const token = createShareToken("private/index.html", 100);
    await expectShareError(token, 410);
    await expectShareError(`${token}tampered`, 404);
    expect(fixtures.deleted).not.toHaveBeenCalled();
    expect(fixtures.stream).not.toHaveBeenCalled();
  });

  it("does not distinguish withdrawn or missing documents from unknown links", async () => {
    const unknown = await expectShareError("unknown-token", 404);
    const token = createShareToken("private/index.html");
    fixtures.deleted.mockResolvedValue(true);
    expect(await expectShareError(token, 404)).toBe(unknown);
    expect(fixtures.stream).not.toHaveBeenCalled();
    fixtures.deleted.mockResolvedValue(false);
    expect(await expectShareError(token, 404)).toBe(unknown);
  });

  it.each(["unknown", "expired", "revoked"])("keeps opaque %s share grants indistinguishable", async (token) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const response = await worker.request(`/s/${token}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('<h1 id="not-found-title">Page not found</h1>');
  });
});

describe("protected docs error routes", () => {
  it.each(["/docs/unknown-org", "/docs/unknown-org/guide.html"])("redirects signed-out %s to sign-in", async (path) => {
    const response = await worker.request(path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/sign-in?returnTo=${encodeURIComponent(path)}`);
    const signIn = await worker.request(response.headers.get("location")!);
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain("Sign in to Rendro");
  });

  it.each(["/docs/unknown-org", "/docs/unknown-org/guide.html"])("renders the styled 404 for a signed-in user visiting %s", async (path) => {
    fixtures.user = { id: "user", email: "user@acme.test", name: "User", emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
    const response = await worker.request(path);
    const html = await response.text();
    expect(response.status).toBe(404);
    expect(html).toContain('<h1 id="not-found-title">Page not found</h1>');
    expect(html).toContain(path);
    expect(styles(html)).toEqual(styles(renderNotFoundPage()));
  });
});

describe("auth error redirects through the Worker", () => {
  it.each([
    ["access_denied", "Google sign-in was canceled."],
    ["state_mismatch", "Your sign-in attempt expired or could not be verified."],
    ["state_not_found", "Your sign-in attempt expired or could not be verified."],
    ["state_security_mismatch", "Your sign-in attempt expired or could not be verified."],
    ["invalid_state", "Your sign-in attempt expired or could not be verified."],
    ["unable_to_link_account", "We couldn&#039;t connect this Google account."],
    ["account_not_linked", "We couldn&#039;t connect this Google account."],
    ["account_already_linked_to_different_user", "We couldn&#039;t connect this Google account."],
    ["email_doesn't_match", "We couldn&#039;t connect this Google account."],
    ["EMAIL_NOT_VERIFIED", "We couldn&#039;t connect this Google account."],
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
    expect(await response.text()).toContain("try connecting Google from account security");
  });

  it.each(["/api/auth/error", "https://rendro.test/api/auth/error", `${CONVEX_SITE_URL}/api/auth/error`])("rewrites %s redirects and preserves cookie cleanup", async (errorUrl) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: {
        location: `${errorUrl}?error=access_denied&error_description=private-detail`,
        "set-cookie": "better-auth.state=; Max-Age=0; Path=/; Domain=convex.site; HttpOnly",
      },
    })));
    const response = await worker.request("https://rendro.test/api/auth/callback/google?error=access_denied");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in?error=access_denied");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
  });

  it.each(["https://accounts.google.com/oauth", "https://rendro.test/organizations", "https://another.test/api/auth/error?error=access_denied"])("preserves unrelated redirects to %s", async (location) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } })));
    const response = await worker.request("https://rendro.test/api/auth/callback/google");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(location);
  });

  it("keeps API errors as JSON for form handlers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "INVALID_EMAIL_OR_PASSWORD" }, { status: 401 })));
    const response = await worker.request("/api/auth/sign-in/email", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "INVALID_EMAIL_OR_PASSWORD" });
  });

  it("handles a real Better Auth Google denial and invalid state via the Worker proxy", async () => {
    const origin = "https://rendro.test";
    const auth = betterAuth({
      baseURL: origin,
      secret: "test-auth-secret-32-chars-long!!",
      database: memoryAdapter({}),
      socialProviders: { google: { clientId: "test", clientSecret: "test" } },
      logger: { disabled: true },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return auth.handler(new Request(`${origin}${url.pathname}${url.search}`, init));
    }));
    const start = await worker.request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "google", callbackURL: `${origin}/organizations` }),
    });
    expect(start.status).toBe(200);
    const { url } = await start.json() as { url: string };
    const state = new URL(url).searchParams.get("state")!;
    const cookie = start.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const denied = await worker.request(`${origin}/api/auth/callback/google?error=access_denied&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toBe("/sign-in?error=access_denied");
    const signIn = await worker.request(denied.headers.get("location")!);
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain("Google sign-in was canceled.");
    const invalid = await worker.request(`${origin}/api/auth/callback/google?error=access_denied&state=invalid`);
    expect(invalid.status).toBe(302);
    expect(invalid.headers.get("location")).toMatch(/^\/sign-in\?error=state_(mismatch|not_found)$/);
  });
});
