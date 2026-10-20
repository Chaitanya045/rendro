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
import { legacyCookieMigration, promoteLegacyCookies, sessionCookieHeaders } from "../convex/sessionLifetime";
import { AUTH_COOKIE_NAMES, authCookiePair, authCookiePrefix } from "../shared/auth-cookies";
import { proxyAuthRequest } from "@/auth-proxy";
import { sessionCache, sessionMiddleware } from "@/middleware/session";
import { viewerSessionCookie } from "@/viewer-ticket";
import rateLimiterTest from "./convex-rate-limiter";

const secureOrigin = "https://rendro.test";
const localOrigin = "http://localhost:3000";
const day = 86_400_000;
const password = "Cookie migration password!!";
const legacy = (name: string) => `__Secure-better-auth.${name}`;
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

/** The cookie header a pre-#89 browser sends: the same signed values under `__Secure-` names. */
function legacyHeader(cookies: string[]): string {
  return cookies.map(pair).map(value => value.replace(/^__Host-better-auth\./, "__Secure-better-auth.")).join("; ");
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
    expect((await f.request("/organizations/reader", f.cookies.map(pair).join("; "))).status).toBe(200);
  });

  it("keeps unprefixed, non-Secure cookies for local HTTP development", async () => {
    const f = await fixture(true, localOrigin);
    const token = named(f.cookies, "better-auth.session_token")!;
    expect(token).not.toMatch(/; Secure/i);
    for (const cookie of f.cookies) expect(cookie).toMatch(/^better-auth\./);
    expect((await f.request("/organizations/reader", f.cookies.map(pair).join("; "))).status).toBe(200);
  });

  it("derives the prefix from the site origin", () => {
    expect(authCookiePrefix("https://rendro.app")).toBe("__Host-better-auth");
    expect(authCookiePrefix("http://localhost:8787")).toBe("better-auth");
    expect(authCookiePrefix(undefined)).toBe("better-auth");
    expect(AUTH_COOKIE_NAMES).toContain("__Host-better-auth.convex_jwt");
    expect(AUTH_COOKIE_NAMES).toContain("__Secure-better-auth.dont_remember");
    expect(AUTH_COOKIE_NAMES).toContain("better-auth.session_data.1");
    expect(authCookiePair("session_token").test("__Host-better-auth.session_token=v")).toBe(true);
    expect(authCookiePair("session_token").test("__Secure-better-auth.session_token=v")).toBe(true);
    expect(authCookiePair("session_token").test("better-auth.session_token=v")).toBe(true);
    expect(authCookiePair("session_token").test("__host-better-auth.session_token=v")).toBe(false);
    expect(authCookiePair("dont_remember").test("better-auth.dont_remember=")).toBe(false);
  });
});

describe("legacy __Secure- cookie migration", () => {
  it.each([false, true])("keeps a legacy session signed in, then re-issues it under __Host- (remember=%s)", async remember => {
    const f = await fixture(remember);
    const initial = await f.stored();
    const cookie = legacyHeader(f.cookies);
    expect(cookie).toContain(`${legacy("session_token")}=`);
    expect(cookie).not.toContain("__Host-");

    // Reads: Worker pages, cached and uncached, and the server-side session read.
    expect(await (await f.request("/organizations/reader", cookie)).json()).toEqual({ id: f.user.id });
    expect((await f.request("/account/security", cookie)).status).toBe(200);
    expect(await f.auth.api.getSession({ headers: sessionCookieHeaders(new Headers({ cookie })) })).not.toBeNull();

    // Re-issue on the next successful auth read, then expire the legacy names.
    const response = await f.request("/api/auth/get-session", cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).user.id).toBe(f.user.id);
    const setCookies = response.headers.getSetCookie();
    const token = named(setCookies, current("session_token"))!;
    expect(pair(token)).toBe(pair(named(f.cookies, current("session_token"))!));
    expect(token).toMatch(/; Secure(?:;|$)/i);
    expect(token).toMatch(/; Path=\/(?:;|$)/);
    expect(token).not.toMatch(/; Domain=/i);
    if (remember) {
      expect(token).toMatch(/; Max-Age=604800(?:;|$)/);
      expect(named(setCookies, current("dont_remember"))).toBeUndefined();
    } else {
      // #145: a non-remembered session stays a browser-session cookie.
      expect(token).not.toMatch(/; (?:Max-Age|Expires)=/i);
      expect(named(setCookies, current("dont_remember"))).not.toMatch(/; (?:Max-Age|Expires)=/i);
    }
    for (const name of cookie.split("; ").map(value => value.split("=", 1)[0])) {
      expect(named(setCookies, name)).toMatch(/^[^=]+=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    }
    // The re-issue never extends the stored lifetime.
    expect((await f.stored()).expiresAt).toBe(initial.expiresAt);

    // The browser now holds only current cookies, and they authorize.
    const migrated = [...new Map([...f.cookies, ...setCookies].map(value => [value.split("=", 1)[0], value]))]
      .filter(([name, value]) => name.startsWith("__Host-") && !/Max-Age=0/.test(value)).map(([, value]) => pair(value)).join("; ");
    expect((await f.request("/account/security", migrated)).status).toBe(200);
    expect((await f.request("/api/auth/get-session", migrated)).headers.getSetCookie().some(value => value.startsWith("__Secure-"))).toBe(false);
  });

  it("re-issues a remembered refresh only once, through Better Auth's own cookie", async () => {
    const f = await fixture(true);
    const initial = await f.stored();
    vi.setSystemTime(Number(initial.createdAt) + 2 * day);
    const response = await f.request("/api/auth/get-session", legacyHeader(f.cookies));
    const tokens = response.headers.getSetCookie().filter(value => value.startsWith(`${current("session_token")}=`));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatch(/; Max-Age=604800(?:;|$)/);
    expect(named(response.headers.getSetCookie(), legacy("session_token"))).toMatch(/Max-Age=0/);
    expect((await f.stored()).expiresAt).toBe(Date.now() + 7 * day);
  });

  it("uses the persisted lifetime, not a legacy marker, when re-issuing", async () => {
    const f = await fixture(false);
    // A legacy browser that lost its preference cookie still gets a session cookie.
    const cookie = `${legacy("session_token")}=${encodeURIComponent(decodeURIComponent(pair(named(f.cookies, current("session_token"))!).split("=").slice(1).join("=")))}`;
    const token = named((await f.request("/api/auth/get-session", cookie)).headers.getSetCookie(), current("session_token"))!;
    expect(token).not.toMatch(/; (?:Max-Age|Expires)=/i);
  });

  it("migrates on other session-resolving reads", async () => {
    const f = await fixture(true);
    const response = await f.request("/api/auth/organization/list", legacyHeader(f.cookies));
    expect(response.status).toBe(200);
    expect(named(response.headers.getSetCookie(), current("session_token"))).toMatch(/; Max-Age=604800/);
    expect(named(response.headers.getSetCookie(), legacy("session_token"))).toMatch(/Max-Age=0/);
  });

  it("keeps legacy cookies when a request fails or writes, until a session cookie is set", async () => {
    const f = await fixture(true);
    const cookie = legacyHeader(f.cookies);
    const failed = await f.request("/api/auth/organization/get-full-organization?organizationId=missing", cookie);
    expect(failed.ok).toBe(false);
    expect(failed.headers.getSetCookie().filter(value => value.startsWith("__Secure-"))).toEqual([]);
    const write = await f.request("/api/auth/organization/create", cookie, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Migrated", slug: "migrated" }),
    });
    expect(write.status).toBe(200);
    expect(write.headers.getSetCookie().filter(value => value.startsWith("__Secure-"))).toEqual([]);
    expect((await f.request("/account/security", cookie)).status).toBe(200);
  });

  it.each(["forged", "expired"])("expires a %s legacy session on a successful read", async kind => {
    const f = await fixture(false);
    let cookie = `${legacy("session_token")}=forged.value; ${legacy("convex_jwt")}=old`;
    if (kind === "expired") {
      cookie = legacyHeader(f.cookies) + `; ${legacy("convex_jwt")}=old`;
      vi.setSystemTime(Number((await f.stored()).expiresAt) + 1);
    }
    const response = await f.request("/api/auth/get-session", cookie);
    expect(await response.json()).toBeNull();
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.filter(value => value.startsWith(`${current("session_token")}=`) && !/Max-Age=0/.test(value))).toEqual([]);
    expect(named(setCookies, legacy("session_token"))).toMatch(/Max-Age=0/);
    expect(named(setCookies, legacy("convex_jwt"))).toMatch(/Max-Age=0/);
    expect((await f.request("/account/security", cookie)).status).toBe(401);
  });

  it("lets the current cookie win and always expires its shadowed legacy twin", async () => {
    const f = await fixture(true);
    const other = await f.context.internalAdapter.createSession(f.user.id);
    const otherCookie = `${legacy("session_token")}=${encodeURIComponent(`${other.token}.${await signature(f, other.token)}`)}`;
    const cookie = `${otherCookie}; ${f.cookies.map(pair).join("; ")}`;
    const findSession = vi.spyOn(f.context.internalAdapter, "findSession");
    const response = await f.request("/api/auth/get-session", cookie);
    expect((await response.json()).session.token).toBe(f.token);
    expect(findSession.mock.calls.map(([token]) => token)).not.toContain(other.token);
    const setCookies = response.headers.getSetCookie();
    expect(named(setCookies, legacy("session_token"))).toMatch(/Max-Age=0/);
    expect(named(setCookies, current("session_token"))).toBeUndefined();
    // Non-GET and sessionless paths expire shadowed legacy cookies too.
    const ok = await f.request("/api/auth/ok", cookie);
    expect(named(ok.headers.getSetCookie(), legacy("session_token"))).toMatch(/Max-Age=0/);
  });

  it("signs out a legacy session and clears every name", async () => {
    const f = await fixture(true);
    const response = await f.request("/api/auth/sign-out", legacyHeader(f.cookies), { method: "POST" });
    expect(response.status).toBe(200);
    expect(await f.stored()).toBeNull();
    const setCookies = response.headers.getSetCookie();
    for (const name of [current("session_token"), legacy("session_token"), current("dont_remember"), legacy("convex_jwt"), "better-auth.session_token"]) {
      expect(named(setCookies, name), name).toMatch(/Max-Age=0/);
    }
    for (const value of setCookies.filter(value => value.startsWith("__Host-"))) expect(value).not.toMatch(/Domain=/i);
  });

  it("authorizes the filtered session cookie of legacy cookie names", async () => {
    const f = await fixture(false);
    const ticket = { cookie: viewerSessionCookie(legacyHeader(f.cookies)) };
    expect(ticket!.cookie).toMatch(/^__Secure-better-auth\.session_token=[^;]+; __Secure-better-auth\.dont_remember=/);
    expect(await f.auth.api.getSession({ headers: sessionCookieHeaders(new Headers({ cookie: ticket!.cookie })) })).not.toBeNull();
  });

  it("promotes legacy names to the unprefixed local names over HTTP", async () => {
    const f = await fixture(true, localOrigin);
    const cookie = f.cookies.map(pair).map(value => `__Secure-${value}`).join("; ");
    expect((await f.request("/account/security", cookie)).status).toBe(200);
    const response = await f.request("/api/auth/get-session", cookie);
    expect(named(response.headers.getSetCookie(), "better-auth.session_token")).toMatch(/; Max-Age=604800/);
    expect(named(response.headers.getSetCookie(), legacy("session_token"))).toMatch(/Max-Age=0/);
  });

  it("ignores a caller-supplied migration record", async () => {
    const f = await fixture(true);
    const cookie = f.cookies.map(pair).join("; ");
    const response = await f.auth.handler(new Request(`${f.origin}/api/auth/get-session`, {
      headers: { cookie, "x-rendro-legacy-auth-cookies": JSON.stringify({ promoted: [], shadowed: ["victim"] }) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().some(value => value.startsWith("victim="))).toBe(false);
  });

  it("does not migrate server API calls that have no response cookies", async () => {
    const f = await fixture(true);
    const result = await f.auth.api.getSession({ headers: sessionCookieHeaders(new Headers({ cookie: legacyHeader(f.cookies) })), returnHeaders: true });
    expect(result.response).not.toBeNull();
    expect(result.headers.getSetCookie().filter(value => value.includes("session_token"))).toEqual([]);
  });
});

describe("promoteLegacyCookies", () => {
  it.each([
    ["leaves headers without legacy names untouched", "a=1;  b = 2", "a=1;  b = 2", [], []],
    ["renames legacy pairs in place", `a=1; ${legacy("session_token")}=t; b=2`, `a=1; ${current("session_token")}=t; b=2`, [legacy("session_token")], []],
    ["drops a legacy pair shadowed by its current twin", `${legacy("session_token")}=old; ${current("session_token")}=new`, `${current("session_token")}=new`, [], [legacy("session_token")]],
    ["re-escapes values exactly as Better Auth reads them", `${legacy("state")}=%25%3B%22`, `${current("state")}=%25%3B%22`, [legacy("state")], []],
  ])("%s", (_name, header, expected, promoted, shadowed) => {
    expect(promoteLegacyCookies(header, "__Host-better-auth")).toEqual({ header: expected, promoted, shadowed });
  });

  it("keeps the plugin first so every hook reads current names", () => {
    const plugins = createAuthOptions({} as never).plugins;
    expect(plugins[0].id).toBe(legacyCookieMigration().id);
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
