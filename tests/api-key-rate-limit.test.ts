import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import rateLimiterTest from "./convex-rate-limiter";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { apiKeyRateLimiter, apiKeyRateLimits } from "../convex/apiKeyHttp";
import { sha256 } from "../convex/credentialHash";
import { signAuthClientIp } from "../shared/auth-client-ip";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "test-credential-never-log";
const validatePath = "/api/rendro/credentials/validate?organizationId=org&scope=docs:read";
const headers = { authorization: `Bearer ${secret}` };
// The one route API keys still authorize (#286 removed the upload and publication routes).
const apiRoutes = [["GET", "credentials/validate"]];

async function fixture() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const credentialId = await t.mutation(internal.apiKeyCredentials.createInternal, {
    organizationId: "org", keyId: "key", keyPrefix: "test", name: "Test",
    secretHash: await sha256(secret), scopes: ["docs:read", "docs:write"], actorId: "owner",
  });
  return { t, credentialId };
}

async function expectLimited(response: Response) {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(await response.json()).toEqual({ error: "Rate limit exceeded", code: "rate_limited" });
}

// Fill each shard deterministically; a single oversized debit is invalid for
// a sharded bucket. Leave random selection enabled for actual HTTP requests.
async function exhaustCredential(t: Awaited<ReturnType<typeof fixture>>["t"], key: string, remainingPerShard = 0) {
  const { shards, capacity } = apiKeyRateLimits.credential;
  const random = vi.spyOn(Math, "random");
  try {
    for (let shard = 0; shard < shards; shard++) {
      random.mockReturnValue((shard + 0.1) / shards);
      expect((await t.run(ctx => apiKeyRateLimiter.limit(ctx, "credential", {
        key, count: capacity / shards - remainingPerShard,
      }))).ok).toBe(true);
    }
  } finally { random.mockRestore(); }
}

afterEach(() => vi.restoreAllMocks());

describe("authoritative API-key rate limits", () => {
  it("shares the verified credential budget across every action, malformed input, tenants and scopes; recovers", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { t, credentialId } = await fixture();
    await exhaustCredential(t, credentialId);
    for (const [method, path] of apiRoutes) {
      // Limiting must happen even before body/identity parsing fails.
      await expectLimited(await t.fetch(`/api/rendro/${path}?organizationId=foreign&scope=other`, {
        method, headers, body: method === "POST" ? "bad-json" : undefined,
      }));
    }
    vi.mocked(Date.now).mockReturnValue(now + 60_000);
    expect((await t.fetch(validatePath, { headers })).status).toBe(200);
  });

  it("limits failed keys by signed IP across keys/routes and isolates other IPs and valid keys", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const { t } = await fixture();
    const signed = async (ip: string, key: string, path = validatePath) => {
      const request = new Request(`https://test.convex.site${path}`);
      const h = await signAuthClientIp(request, ip, process.env.CONVEX_INTERNAL_SECRET!);
      h.set("authorization", `Bearer ${key}`);
      return t.fetch(path, { headers: h });
    };
    for (let i = 0; i < apiKeyRateLimits.failedIp.capacity; i++) {
      expect((await signed("192.0.2.1", `wrong-${i}`)).status).toBe(401);
    }
    await expectLimited(await signed("192.0.2.1", "new-wrong-key", "/api/rendro/credentials/validate?organizationId=other&scope=docs:write"));
    expect((await signed("192.0.2.2", "wrong")).status).toBe(401);
    expect((await signed("192.0.2.1", secret)).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(Date.now() + 60_000);
    expect((await signed("192.0.2.1", "wrong")).status).toBe(401);
  });

  it("uses one fallback bucket for missing, malformed, forged, revoked and expired credentials", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const { t, credentialId } = await fixture();
    await t.run(ctx => apiKeyRateLimiter.limit(ctx, "failedIp", {
      key: "unverified", count: apiKeyRateLimits.failedIp.capacity,
    }));
    for (const authorization of [undefined, "Basic bad", "Bearer wrong"]) {
      for (const ip of ["192.0.2.1", "192.0.2.2"]) {
        await expectLimited(await t.fetch(validatePath, { headers: {
          ...(authorization ? { authorization } : {}),
          "x-rendro-verified-client-ip": ip, "x-forwarded-for": ip,
          "cf-connecting-ip": ip, "x-rendro-client-ip": ip,
          "x-rendro-client-ip-time": String(Date.now()), "x-rendro-client-ip-signature": "0".repeat(64),
        } }));
      }
    }
    await t.run(ctx => ctx.db.patch(credentialId, { expiresAt: Date.now() }));
    await expectLimited(await t.fetch(validatePath, { headers }));
    await t.run(ctx => ctx.db.patch(credentialId, { expiresAt: undefined, revokedAt: Date.now() }));
    await expectLimited(await t.fetch(validatePath, { headers }));
  });

  it("isolates credentials and never logs a rejected key", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { t, credentialId } = await fixture();
    await exhaustCredential(t, credentialId);
    await t.mutation(internal.apiKeyCredentials.createInternal, {
      organizationId: "org", keyId: "other", keyPrefix: "test", name: "Other",
      secretHash: await sha256("other-secret"), scopes: ["docs:read"], actorId: "owner",
    });
    expect((await t.fetch(validatePath, { headers: { authorization: "Bearer other-secret" } })).status).toBe(200);
    await expectLimited(await t.fetch(validatePath, { headers }));
    expect(log).not.toHaveBeenCalled();
  });

  it("fails closed and redacts unexpected limiter faults", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { t } = await fixture();
    vi.spyOn(apiKeyRateLimiter, "limit").mockRejectedValue(new Error(`backend failure: ${secret}`));
    const response = await t.fetch(validatePath, { headers });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Request failed" });
    expect(log).toHaveBeenCalledWith("HTTP request failed", { operation: "httpAction", category: "Error", status: 500 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it("handles 20 parallel authorizations and enforces the aggregate sharded budget", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const { t, credentialId } = await fixture();
    const batch = () => Promise.all(Array.from({ length: 20 }, () => t.fetch(validatePath, { headers })));
    expect((await batch()).map(r => r.status)).toEqual(Array(20).fill(200));
    // Reset only in the test, then leave exactly one token on each shard.
    await t.run(ctx => apiKeyRateLimiter.reset(ctx, "credential", { key: credentialId }));
    await exhaustCredential(t, credentialId, 1);
    // Seed shard selection for reproducibility while still exercising the real
    // component's two-choice distribution and concurrent HTTP actions.
    let seed = 47;
    vi.spyOn(Math, "random").mockImplementation(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    });
    const responses: Response[] = [];
    for (let i = 0; i < 10; i++) responses.push(...await batch());
    expect(responses.every(r => r.status === 200 || r.status === 429)).toBe(true);
    const allowed = responses.filter(r => r.status === 200).length;
    expect(allowed).toBeGreaterThanOrEqual(45);
    expect(allowed).toBeLessThanOrEqual(50);
    vi.mocked(Date.now).mockReturnValue(Date.now() + 1_000);
    const refilled: Response[] = [];
    for (let i = 0; i < 10; i++) refilled.push(...await batch());
    expect(refilled.every(r => r.status === 200 || r.status === 429)).toBe(true);
    const allowedAfterRefill = refilled.filter(r => r.status === 200).length;
    expect(allowedAfterRefill).toBeGreaterThanOrEqual(90);
    // Exactly 100 tokens/sec in aggregate, plus any unused burst tokens.
    expect(allowedAfterRefill).toBeLessThanOrEqual(100 + 50 - allowed);
  });
});
