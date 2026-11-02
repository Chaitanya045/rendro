import { convexTest } from "convex-test";
import { betterAuth } from "better-auth/minimal";
import { hashPassword } from "better-auth/crypto";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components } from "../convex/_generated/api";
import { createAuthOptions } from "../convex/auth";
import { sessionCookieHeaders } from "../convex/sessionLifetime";
import { AUTH_COOKIE_NAMES, AUTH_COOKIE_SUFFIXES, authCookiePair, authCookiePrefix } from "../shared/auth-cookies";
import { proxyAuthRequest } from "@/auth-proxy";
import { sessionCache, sessionMiddleware, sessionViewer } from "@/middleware/session";
import { sessionCacheKey } from "@/session-cache";
import { viewerSessionCookie } from "@/viewer-ticket";
import rateLimiterTest from "./convex-rate-limiter";

const secureOrigin = "https://rendro.test";
const localOrigin = "http://localhost:3000";
const password = "Cookie names password!!";
const retired = (name: string) => `__Secure-better-auth.${name}`;
const current = (name: string) => `__Host-better-auth.${name}`;

afterEach(() => { sessionCache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const pair = (setCookie: string) => setCookie.split(";", 1)[0];
const named = (cookies: string[], name: string) => cookies.find(value => value.startsWith(`${name}=`));

async function fixture(rememberMe: boolean, origin = secureOrigin) {
  sessionCache.clear();
  vi.stubEnv("SITE_URL", origin);
  vi.useFakeTimers({ toFake: ["Date"] });
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  rateLimiterTest.register(backend);
  const auth = betterAuth(createAuthOptions({ runQuery: backend.query, runMutation: backend.mutation } as never));
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({ name: "Reader", email: "cookies@example.test", emailVerified: true });
  await context.internalAdapter.createAccount({ userId: user.id, accountId: user.id, providerId: "credential", password: await hashPassword(password) });
  // Only the network transport is substituted: production auth options, adapter,
  // Worker proxy, session middleware and cache all run for real.
  vi.stubGlobal("fetch", vi.fn((input: string, init: RequestInit) => auth.handler(new Request(`${origin}${new URL(input).pathname}${new URL(input).search}`, init))));
  const app = new Hono<{ Variables: { user?: User } }>();
  // The repository read path's identity, mounted before the middleware as /r/ is.
  app.get("/r/probe", async c => {
    const viewer = await sessionViewer(c.req.raw);
    return viewer.kind === "user" ? c.json({ id: viewer.id }) : c.body(null, 401);
  });
  app.use("*", sessionMiddleware);
  app.all("/api/auth/*", c => proxyAuthRequest(c.req.raw));
  app.get("*", c => c.get("user") ? c.json({ id: c.get("user")!.id }) : c.body(null, 401));
  const login = await app.request(`${origin}/api/auth/sign-in/email`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password, rememberMe }),
  });
  expect(login.status).toBe(200);
  const cookies = login.headers.getSetCookie();
  const token = (await login.json()).token as string;
  const stored = () => backend.query(components.betterAuth.adapter.findOne, { model: "session", where: [{ field: "token", value: token }] });
  const request = (path: string, cookie: string, init: RequestInit = {}) =>
    app.request(`${origin}${path}`, { ...init, headers: { cookie, origin, ...init.headers } });
  return { app, auth, context, cookies, token, user, stored, request, origin };
}

/** Cookie headers of the Worker's own session reads (pages and the /r/ identity), not proxied auth calls. */
function workerSessionReads(): Array<string | null> {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (input as string).endsWith("/api/auth/get-session") && new Headers(init?.headers).get("accept") === "application/json" && !new Headers(init?.headers).has("origin"))
    .map(([, init]) => new Headers(init?.headers).get("cookie"));
}

describe("current cookie names", () => {
  it.each([false, true])("uses host-only __Host- cookies over HTTPS (remember=%s)", async remember => {
    const f = await fixture(remember);
    const token = named(f.cookies, current("session_token"))!;
    expect(token).toBeDefined();
    expect(token).toMatch(/; Path=\/(?:;|$)/);
    expect(token).toMatch(/; Secure(?:;|$)/i);
    expect(token).toMatch(/; HttpOnly(?:;|$)/i);
    expect(token).toMatch(/; SameSite=Lax(?:;|$)/i);
    expect(token).not.toMatch(/; Domain=/i);
    if (remember) expect(token).toMatch(/; Max-Age=604800(?:;|$)/);
    else {
      expect(token).not.toMatch(/; (?:Max-Age|Expires)=/i);
      const preference = named(f.cookies, current("dont_remember"))!;
      expect(preference).toMatch(/; Secure(?:;|$)/i);
      expect(preference).not.toMatch(/; (?:Max-Age|Expires|Domain)=/i);
    }
    // Every cookie Better Auth and the Convex plugin set shares the prefix.
    for (const cookie of f.cookies) {
      expect(cookie).toMatch(/^__Host-better-auth\./);
      expect(cookie).toMatch(/; Secure(?:;|$)/i);
      expect(cookie).toMatch(/; Path=\/(?:;|$)/);
      expect(cookie).not.toMatch(/; Domain=/i);
    }
    expect(named(f.cookies, current("convex_jwt"))).toBeDefined();
    expect((await f.request("/home", f.cookies.map(pair).join("; "))).status).toBe(200);
  });

  it("keeps unprefixed, non-Secure cookies for local HTTP development", async () => {
    const f = await fixture(true, localOrigin);
    const token = named(f.cookies, "better-auth.session_token")!;
    expect(token).not.toMatch(/; Secure/i);
    for (const cookie of f.cookies) expect(cookie).toMatch(/^better-auth\./);
    expect((await f.request("/home", f.cookies.map(pair).join("; "))).status).toBe(200);
  });

  it("derives the prefix and the one session-cookie pattern from the site origin", () => {
    expect(authCookiePrefix("https://rendro.app")).toBe("__Host-better-auth");
    expect(authCookiePrefix("http://localhost:8787")).toBe("better-auth");
    expect(authCookiePrefix(undefined)).toBe("better-auth");
    expect(AUTH_COOKIE_NAMES).toContain("__Host-better-auth.convex_jwt");
    expect(AUTH_COOKIE_NAMES).toContain("__Secure-better-auth.dont_remember");
    expect(AUTH_COOKIE_NAMES).toContain("better-auth.session_data.1");
    const https = (name: string) => authCookiePair("https://rendro.app", "session_token").test(`${name}=v`);
    const http = (name: string) => authCookiePair("http://localhost:8787", "session_token").test(`${name}=v`);
    expect([https(current("session_token")), https(retired("session_token")), https("better-auth.session_token")]).toEqual([true, false, false]);
    expect([http(current("session_token")), http(retired("session_token")), http("better-auth.session_token")]).toEqual([false, false, true]);
    expect(https("__host-better-auth.session_token")).toBe(false);
    expect(authCookiePair(undefined, "dont_remember").test("better-auth.dont_remember=")).toBe(false);
    expect(authCookiePair("https://rendro.app", "dont_remember").test(`${retired("dont_remember")}=true.sig`)).toBe(false);
  });
});

// HTTPS reads only `__Host-` names. The retired pre-#89 names and the unprefixed local names, which any sibling
// subdomain can set with a parent Domain, are never a session there (#208).
describe.each([["retired __Secure-", "__Secure-better-auth."], ["unprefixed", "better-auth."]])("%s cookie names on HTTPS (#208)", (_label, other) => {
  /** The same signed values under `other` instead of the current `__Host-` names. */
  const renamed = (cookies: string[]) => cookies.map(pair).map(value => value.replace(/^__Host-better-auth\./, other)).join("; ");

  it.each([false, true])("never honours or looks up such a session cookie on its own (remember=%s)", async remember => {
    const f = await fixture(remember);
    const cookie = renamed(f.cookies);
    expect(cookie).toContain(`${other}session_token=`);
    expect(cookie).not.toContain("__Host-");
    const findSession = vi.spyOn(f.context.internalAdapter, "findSession");

    // Worker: pages, the /r/ identity, the viewer-ticket filter and the session cache see no session token at all.
    expect((await f.request("/home", cookie)).status).toBe(401);
    expect((await f.request("/account/security", cookie)).status).toBe(401);
    expect((await f.request("/r/probe", cookie)).status).toBe(401);
    expect(workerSessionReads()).toEqual([]);
    expect(viewerSessionCookie(f.origin, cookie)).toBe("");
    expect(await sessionCacheKey(f.origin, cookie)).toBeNull();

    // Convex: through the Worker proxy, the bare HTTP handler and server-side reads.
    const proxied = await f.request("/api/auth/get-session", cookie);
    expect(await proxied.json()).toBeNull();
    expect(proxied.headers.getSetCookie().filter(value => /session_token=[^;]/.test(value))).toEqual([]);
    const direct = await f.auth.handler(new Request(`${f.origin}/api/auth/get-session`, { headers: { cookie } }));
    expect(await direct.json()).toBeNull();
    expect(await f.auth.api.getSession({ headers: sessionCookieHeaders(new Headers({ cookie })) })).toBeNull();
    expect(findSession).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])("keeps the current session when such a cookie of another session comes %s it", async position => {
    const f = await fixture(true);
    const stranger = await f.context.internalAdapter.createUser({ name: "Other", email: "other@example.test", emailVerified: true });
    const otherSession = await f.context.internalAdapter.createSession(stranger.id);
    const planted = `${other}session_token=${encodeURIComponent(`${otherSession.token}.${await signature(f, otherSession.token)}`)}`;
    const currentPairs = f.cookies.map(pair).join("; ");
    const cookie = position === "before" ? `${planted}; ${currentPairs}` : `${currentPairs}; ${planted}`;
    const findSession = vi.spyOn(f.context.internalAdapter, "findSession");

    // Worker: only the current token is forwarded, cached and attributed.
    const forwarded = viewerSessionCookie(f.origin, cookie);
    expect(forwarded).toBe(viewerSessionCookie(f.origin, currentPairs));
    expect(forwarded.split("; ").every(value => value.startsWith("__Host-"))).toBe(true);
    expect(await sessionCacheKey(f.origin, cookie)).toBe(await sessionCacheKey(f.origin, currentPairs));
    expect(await (await f.request("/home", cookie)).json()).toEqual({ id: f.user.id });
    expect(await (await f.request("/r/probe", cookie)).json()).toEqual({ id: f.user.id });
    expect(new Set(workerSessionReads())).toEqual(new Set([forwarded]));

    // Convex: the session resolves from the current cookie alone, and the other one is left as it is.
    const response = await f.request("/api/auth/get-session", cookie);
    expect((await response.json()).session.token).toBe(f.token);
    expect(response.headers.getSetCookie().filter(value => value.startsWith(`${other}session_token=`))).toEqual([]);
    expect((await f.auth.api.getSession({ headers: sessionCookieHeaders(new Headers({ cookie })) }))?.user.id).toBe(f.user.id);
    expect(findSession.mock.calls.map(([token]) => token)).not.toContain(otherSession.token);
  });

  it("signs out the current session and expires every such name", async () => {
    const f = await fixture(true);
    const cookie = `${f.cookies.map(pair).join("; ")}; ${renamed(f.cookies)}`;
    const response = await f.request("/api/auth/sign-out", cookie, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await f.stored()).toBeNull();
    const setCookies = response.headers.getSetCookie();
    for (const suffix of AUTH_COOKIE_SUFFIXES) {
      expect(named(setCookies, `${other}${suffix}`), suffix).toMatch(other.startsWith("__Secure-")
        ? /^[^=]+=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax; Secure$/
        : /^[^=]+=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax$/);
      expect(named(setCookies, current(suffix)), suffix).toMatch(/Max-Age=0/);
    }
    for (const value of setCookies.filter(value => value.startsWith("__Host-"))) expect(value).not.toMatch(/Domain=/i);
  });
});

describe("prefixed cookie names on local HTTP (#208)", () => {
  it.each(["__Secure-", "__Host-"])("never honours or looks up a %s session cookie", async prefix => {
    const f = await fixture(true, localOrigin);
    const cookie = f.cookies.map(pair).map(value => `${prefix}${value}`).join("; ");
    expect((await f.request("/account/security", cookie)).status).toBe(401);
    expect(workerSessionReads()).toEqual([]);
    expect(await (await f.request("/api/auth/get-session", cookie)).json()).toBeNull();
  });
});

describe("sessionCookieHeaders", () => {
  it("passes the cookie header through unchanged", () => {
    const cookie = `${retired("session_token")}=a; ${current("session_token")}=b`;
    expect(sessionCookieHeaders(new Headers({ cookie })).get("cookie")).toBe(cookie);
  });

  it("returns no headers for a missing cookie or bearer requests", () => {
    expect([...sessionCookieHeaders(new Headers())]).toEqual([]);
    expect([...sessionCookieHeaders(new Headers({ cookie: "a=1", authorization: "Bearer x" }))]).toEqual([]);
  });
});

async function signature(f: Awaited<ReturnType<typeof fixture>>, value: string): Promise<string> {
  const { makeSignature } = await import("better-auth/crypto");
  return makeSignature(value, f.context.secret);
}
