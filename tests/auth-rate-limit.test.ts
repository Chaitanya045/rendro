import { convexTest } from "convex-test";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components } from "../convex/_generated/api";
import { Hono } from "hono";
import { sessionMiddleware } from "@/middleware/session";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import { testUtils } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthOptions } from "../convex/auth";
import { cacheJwksResponse } from "../convex/authHttp";
import { AUTH_CLIENT_IP_HEADER, signAuthClientIp, verifiedAuthRequest } from "../shared/auth-client-ip";

// Keep the long simulated-traffic regression from emitting thousands of logs.
vi.mock("@/logger", () => ({ logger: { debug() {}, warn() {}, error() {} } }));

const baseURL = "http://localhost:3000";
const secret = "auth-rate-limit-internal-secret-at-least-32";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function runtime() {
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const configured = createAuthOptions({
    runMutation: (_reference: unknown, args: { key: string }) =>
      backend.run(ctx => ctx.runMutation(components.betterAuth.sessionReadLimit.consume, args)),
  } as never);
  const database: Record<string, unknown[]> = {
    user: [], session: [], account: [], verification: [], jwks: [], rateLimit: [],
  };
  const auth = betterAuth({
    ...configured,
    baseURL,
    plugins: [...configured.plugins, testUtils()],
    database: memoryAdapter(database),
    advanced: { ...configured.advanced, database: { generateId: "uuid" } },
  });
  // The real Convex HTTP action adapter supports mutations. Give the test
  // adapter the same capability so the plugin can generate signing keys.
  const context = await auth.$context;
  if (!context.adapter.options) throw new Error("Memory adapter options are required");
  context.adapter.options.isRunMutationCtx = true;
  async function request(path: string, ip?: string, headers?: HeadersInit) {
    const social = path === "/sign-in/social";
    const post = path === "/sign-in/email" || social;
    const req = new Request(`${baseURL}/api/auth${path}`, {
      method: post ? "POST" : "GET",
      ...(post ? {
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify(social ? { provider: "google", callbackURL: baseURL }
          : { email: "missing@rendro.invalid", password: "wrong-password-long-enough" }),
      } : {}),
    });
    new Headers(headers).forEach((v, k) => req.headers.set(k, v));
    if (ip) (await signAuthClientIp(req, ip, secret)).forEach((v, k) => req.headers.set(k, v));
    const response = await auth.handler(await verifiedAuthRequest(req, secret));
    return cacheJwksResponse(req, response);
  }
  return { request, database, context, backend };
}

describe("auth rate limits", () => {
  it("serves sustained verifier traffic beyond the former shared 100-request limit", async () => {
    const { request, database } = await runtime();
    for (let i = 0; i < 150; i++) {
      const response = await request("/convex/jwks");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
      const data = await response.json() as { keys: Array<Record<string, unknown>> };
      expect(data.keys.length).toBeGreaterThan(0);
      expect(data.keys[0]).not.toHaveProperty("d");
    }
    expect(database.rateLimit).toHaveLength(0);
  });

  it("exempts token refresh and discovery but still requires a session for tokens", async () => {
    const { request, database } = await runtime();
    for (let i = 0; i < 105; i++) {
      const token = await request("/convex/token");
      expect(token.status).toBe(401);
      expect(token.headers.get("cache-control") ?? "").not.toContain("public");
      expect((await request("/convex/.well-known/openid-configuration")).status).toBe(200);
    }
    expect(database.rateLimit).toHaveLength(0);
    expect(createAuthOptions({} as never).rateLimit.customRules["/token"]).toBe(false);
  });

  it("limits sign-in per verified client even after machine traffic", async () => {
    const { request, database } = await runtime();
    for (let i = 0; i < 5; i++) expect((await request("/sign-in/email", "192.0.2.1")).status).toBe(401);
    expect((await request("/sign-in/email", "192.0.2.1")).status).toBe(429);
    expect((await request("/convex/jwks", "192.0.2.1")).status).toBe(200);
    expect((await request("/sign-in/email", "192.0.2.2")).status).toBe(401);
    expect(database.rateLimit).toHaveLength(2);
    expect(database.rateLimit).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "192.0.2.1|/sign-in/email", count: 5 }),
      expect.objectContaining({ key: "192.0.2.2|/sign-in/email", count: 1 }),
    ]));
  });

  it("keeps authenticated session reads in their own bucket after ten failed sign-ins", async () => {
    const { request, database, context } = await runtime();
    const user = context.test!.createUser({ emailVerified: true });
    await context.test!.saveUser(user);
    const login = await context.test!.login({ userId: user.id });
    const ip = "192.0.2.38";
    for (let i = 0; i < 10; i++) {
      expect((await request("/sign-in/email", ip)).status).toBe(i < 5 ? 401 : 429);
    }
    // Exercise the verified 120/minute session bucket, beyond the default
    // 100/minute limit, including a query-string variant.
    for (let i = 0; i < 120; i++) {
      const path = i % 2 ? "/get-session?probe=1" : "/get-session";
      const response = await request(path, ip, login.headers);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ user: { id: user.id } });
    }
    expect(database.rateLimit).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: `${ip}|/sign-in/email`, count: 5 }),
    ]));
    expect((await request("/get-session", ip, login.headers)).status).toBe(429);
    expect((await request("/sign-in/email", ip)).status).toBe(429);
  });

  it("supports two browsing sessions behind one IP and limits a hammering session across IPs", async () => {
    const { request, context, backend } = await runtime();
    const user = context.test!.createUser({ emailVerified: true });
    await context.test!.saveUser(user);
    const sessions = await Promise.all([0, 1].map(() => context.test!.login({ userId: user.id })));
    const app = new Hono();
    app.use("*", sessionMiddleware);
    app.get("/", c => c.text("OK"));
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => request("/get-session", "192.0.2.38", init.headers));
    // 180 navigations/minute across two sessions used to exhaust the shared
    // 120 bucket. Freeze time so this cannot pass by crossing a window boundary.
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 90; i++) {
      for (const login of sessions) expect((await app.request("/", { headers: login.headers })).status).toBe(200);
    }
    for (let i = 90; i < 120; i++) expect((await request("/get-session", "192.0.2.99", sessions[0].headers)).status).toBe(200);
    const limited = await request("/get-session", "192.0.2.100", sessions[0].headers);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const alternate = new Headers(sessions[0].headers);
    alternate.set("cookie", alternate.get("cookie")!.replace(/session_token=(.)/, (_, first: string) => `session_token=%${first.charCodeAt(0).toString(16)}`));
    expect((await request("/get-session", "192.0.2.101", alternate)).status).toBe(429);
    expect((await app.request("/", { headers: sessions[0].headers })).status).toBe(503);
    expect((await app.request("/", { headers: sessions[1].headers })).status).toBe(200);
    const rows = await backend.run(ctx => ctx.runQuery(components.betterAuth.adapter.findMany, { model: "rateLimit", paginationOpts: { numItems: 10, cursor: null } }));
    const sessionRows = rows.page.filter((row: { key: string }) => row.key.startsWith("session-read:"));
    expect(sessionRows).toHaveLength(2);
    for (const row of sessionRows) expect(row.key).toMatch(/^session-read:[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(sessions[0].session.token);
    vi.setSystemTime(Date.now() + 60_001);
    expect((await request("/get-session", "192.0.2.38", sessions[0].headers)).status).toBe(200);
  });

  it("does not let unsigned cookies or caller-supplied identifiers split the fallback bucket", async () => {
    const { request } = await runtime();
    for (let i = 0; i < 121; i++) {
      const response = await request("/get-session", "192.0.2.5", {
        cookie: `better-auth.session_token=forged-${i}.signature`,
        "x-session-id": String(i), "x-rendro-session-key": String(i),
      });
      expect(response.status).toBe(i < 120 ? 200 : 429);
      if (i < 120) expect(await response.json()).toBeNull();
    }
  });

  it("serves two users at 75 reads/minute each for 65 minutes without shared-IP 503s", async () => {
    const { request, context, database } = await runtime();
    const sessions = [];
    for (let i = 0; i < 2; i++) {
      const user = context.test!.createUser({ emailVerified: true });
      await context.test!.saveUser(user);
      sessions.push(await context.test!.login({ userId: user.id }));
    }
    const app = new Hono();
    app.use("*", sessionMiddleware);
    app.get("/", c => c.text("OK"));
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => request("/get-session", "192.0.2.38", init.headers));
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    for (let i = 0; i < 65 * 150; i++) {
      vi.setSystemTime(start + i * 400);
      expect((await app.request("/", { headers: sessions[i % 2].headers })).status, `read ${i + 1}`).toBe(200);
    }
    // /get-session must never enter Better Auth's inactivity-based IP limiter.
    expect(database.rateLimit).toHaveLength(0);
  }, 120_000);

  it("limits the shared-IP backstop before session resolution and recovers without an idle gap", async () => {
    const { request, context, backend } = await runtime();
    const user = context.test!.createUser({ emailVerified: true });
    await context.test!.saveUser(user);
    const login = await context.test!.login({ userId: user.id });
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    // Fill the real atomic backstop. Requests are distributed throughout the
    // window so an implementation that moves lastRequest on each hit fails.
    for (let i = 0; i < 6_000; i++) {
      vi.setSystemTime(start + i * 9);
      expect(await backend.run(ctx => ctx.runMutation(components.betterAuth.sessionReadLimit.consume,
        { key: "session-read-ip:192.0.2.6" }))).toBe(0);
    }
    const findSession = vi.spyOn(context.internalAdapter, "findSession");
    const limited = await request("/get-session", "192.0.2.6", login.headers);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect(findSession).not.toHaveBeenCalled();
    expect((await request("/get-session", "192.0.2.7", login.headers)).status).toBe(200);
    vi.setSystemTime(start + 59_999);
    expect((await request("/get-session", "192.0.2.6", login.headers)).status).toBe(429);
    vi.setSystemTime(start + 60_000);
    expect((await request("/get-session", "192.0.2.6", login.headers)).status).toBe(200);
  }, 30_000);

  it("keeps renamed OAuth state, unrelated cookies and expired sessions in the unauthenticated IP bucket", async () => {
    const { request, context, backend } = await runtime();
    const cookies: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await request("/sign-in/social", "192.0.2.8");
      expect(response.status).toBe(200);
      const state = response.headers.getSetCookie().find(cookie => cookie.startsWith("better-auth.state="));
      expect(state).toBeDefined();
      cookies.push(state!.split(";")[0].replace("better-auth.state=", "better-auth.session_token="));
    }
    const user = context.test!.createUser({ emailVerified: true });
    await context.test!.saveUser(user);
    const login = await context.test!.login({ userId: user.id });
    const validCookie = login.headers.get("cookie")!;
    // A real session in any cookie other than the exact configured name must
    // not allocate a session bucket either.
    cookies.push(validCookie.replace("better-auth.session_token=", "unrelated.signed_cookie="));
    cookies.push(validCookie.replace("better-auth.session_token=", "better-auth.state="));
    const expired = await context.test!.login({ userId: user.id });
    await context.internalAdapter.updateSession(expired.session.token, { expiresAt: new Date(Date.now() - 1) });
    cookies.push(expired.headers.get("cookie")!);
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const cookie of cookies) {
      const response = await request("/get-session", "192.0.2.8", { cookie });
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    }
    for (let i = cookies.length; i < 120; i++) {
      expect((await request("/get-session", "192.0.2.8")).status).toBe(200);
    }
    for (const cookie of cookies) {
      expect((await request("/get-session", "192.0.2.8", { cookie })).status).toBe(429);
    }
    const rows = await backend.run(ctx => ctx.runQuery(components.betterAuth.adapter.findMany,
      { model: "rateLimit", paginationOpts: { numItems: 20, cursor: null } }));
    expect(rows.page.map((row: { key: string }) => row.key).sort()).toEqual([
      "session-read-ip:192.0.2.8", "session-read-unverified:192.0.2.8",
    ]);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await request("/get-session", "192.0.2.8", { cookie: cookies[0] })).status).toBe(200);
  });

  it("keeps strict credential, reset and verification rules without broad exemptions", () => {
    const { rateLimit, advanced } = createAuthOptions({} as never);
    expect(rateLimit).toMatchObject({ enabled: true, storage: "database", max: 100 });
    expect(rateLimit.customRules).toMatchObject({
      "/get-session": false,
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 3600, max: 5 },
      "/request-password-reset": { window: 3600, max: 5 },
      "/send-verification-email": { window: 3600, max: 5 },
    });
    expect(Object.keys(rateLimit.customRules).some((path) => path.includes("*"))).toBe(false);
    expect(advanced.ipAddress.ipAddressHeaders).toEqual([AUTH_CLIENT_IP_HEADER]);
  });

  it("keeps direct requests in one limited fallback bucket regardless of unverified headers", async () => {
    const { request, database } = await runtime();
    for (let i = 0; i < 6; i++) {
      const response = await request("/sign-in/email", undefined, {
        "x-forwarded-for": `192.0.2.${i + 1}`,
        "cf-connecting-ip": `192.0.2.${i + 1}`,
        [AUTH_CLIENT_IP_HEADER]: `192.0.2.${i + 1}`,
      });
      expect(response.status).toBe(i < 5 ? 401 : 429);
    }
    expect(database.rateLimit).toHaveLength(1);
  });

  it.each([
    ["GET", "/convex/jwks", 429, {}],
    ["GET", "/convex/jwks", 500, {}],
    ["GET", "/convex/jwks", 200, { "set-cookie": "session=private" }],
    ["POST", "/convex/jwks", 200, {}],
    ["GET", "/convex/token", 200, {}],
    ["GET", "/get-session", 200, {}],
  ] as const)("does not publicly cache %s %s (%i)", (method, path, status, headers) => {
    const response = new Response("{}", { status, headers });
    expect(cacheJwksResponse(new Request(`${baseURL}/api/auth${path}`, { method }), response)).toBe(response);
    expect(response.headers.get("cache-control")).toBeNull();
  });
});
