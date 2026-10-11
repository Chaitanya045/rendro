import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import { testUtils } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthOptions } from "../convex/auth";
import { cacheJwksResponse } from "../convex/authHttp";
import { AUTH_CLIENT_IP_HEADER, signAuthClientIp, verifiedAuthRequest } from "../shared/auth-client-ip";

const baseURL = "http://localhost:3000";
const secret = "auth-rate-limit-internal-secret-at-least-32";

afterEach(() => vi.unstubAllEnvs());

async function runtime() {
  const configured = createAuthOptions({} as never);
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
    const post = path === "/sign-in/email";
    const req = new Request(`${baseURL}/api/auth${path}`, {
      method: post ? "POST" : "GET",
      ...(post ? {
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ email: "missing@rendro.invalid", password: "wrong-password-long-enough" }),
      } : {}),
    });
    new Headers(headers).forEach((v, k) => req.headers.set(k, v));
    if (ip) (await signAuthClientIp(req, ip, secret)).forEach((v, k) => req.headers.set(k, v));
    const response = await auth.handler(await verifiedAuthRequest(req, secret));
    return cacheJwksResponse(req, response);
  }
  return { request, database, context };
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
    // Exercise the configured 120/minute session bucket, beyond the default
    // 100/minute limit, including a query-string variant.
    for (let i = 0; i < 120; i++) {
      const path = i % 2 ? "/get-session?probe=1" : "/get-session";
      const response = await request(path, ip, login.headers);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ user: { id: user.id } });
    }
    expect(database.rateLimit).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: `${ip}|/sign-in/email`, count: 5 }),
      expect.objectContaining({ key: `${ip}|/get-session`, count: 120 }),
    ]));
    expect((await request("/get-session", ip, login.headers)).status).toBe(429);
    expect((await request("/sign-in/email", ip)).status).toBe(429);
  });

  it("keeps strict credential, reset and verification rules without broad exemptions", () => {
    const { rateLimit, advanced } = createAuthOptions({} as never);
    expect(rateLimit).toMatchObject({ enabled: true, storage: "database", max: 100 });
    expect(rateLimit.customRules).toMatchObject({
      "/get-session": { window: 60, max: 120 },
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
