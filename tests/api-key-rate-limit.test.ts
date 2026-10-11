import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import rateLimiterTest from "./convex-rate-limiter";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { apiKeyRateLimiter, apiKeyRateLimits } from "../convex/apiKeyHttp";
import { sha256 } from "../convex/credentialHash";
import { signAuthClientIp } from "../shared/auth-client-ip";
import { MAX_REUSED_FILES_PER_REQUEST } from "../shared/deployment-limits";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "test-credential-never-log";
const validatePath = "/api/rendro/credentials/validate?organizationId=org&scope=docs:read";
const headers = { authorization: `Bearer ${secret}` };
const apiRoutes = [
  ["GET", "credentials/validate"], ["POST", "deployments/start"],
  ["GET", "deployments/active"], ["GET", "deployments/staging"],
  ["POST", "deployments/commit"], ["POST", "deployments/fail"],
  ["GET", "deployments"], ["GET", "publications"],
  ["POST", "publications"], ["POST", "publications/remove"],
];

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

afterEach(() => vi.restoreAllMocks());

describe("authoritative API-key rate limits", () => {
  it("shares the verified credential budget across every action, malformed input, tenants and scopes; recovers", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { t, credentialId } = await fixture();
    await t.run(ctx => apiKeyRateLimiter.limit(ctx, "credential", {
      key: credentialId, count: apiKeyRateLimits.credential.capacity - 1,
    }));
    expect((await t.fetch(validatePath, { headers })).status).toBe(200);
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
    await expectLimited(await signed("192.0.2.1", "new-wrong-key", "/api/rendro/deployments/staging"));
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
    await t.run(ctx => apiKeyRateLimiter.limit(ctx, "credential", {
      key: credentialId, count: apiKeyRateLimits.credential.capacity,
    }));
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

  it("allows the CLI pattern for a 10,000-file cold deploy plus a large incremental deploy without refill", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const { t } = await fixture();
    const project = await t.mutation(internal.projects.createInternal, {
      organizationId: "org", name: "Docs", slug: "docs", actorId: "owner",
    });
    const identity = { organizationId: "org", projectId: project!._id };
    const query = new URLSearchParams(identity);
    for (const [changed, reused] of [[10_000, 0], [500, 9_500]]) {
      expect((await t.fetch(`/api/rendro/deployments/active?${query}`, { headers })).status).toBe(200);
      const start = await t.fetch("/api/rendro/deployments/start", {
        method: "POST", headers, body: JSON.stringify({ ...identity,
          manifestSha256: "hash", fileCount: changed + reused, byteCount: 1,
          provenance: { source: { kind: "local" }, execution: { kind: "local" }, cliVersion: "test", manifestSha256: "hash" },
        }),
      });
      expect(start.status).toBe(201);
      const { deployment } = await start.json() as { deployment: { deploymentId: string } };
      const deploymentIdentity = { ...identity, deploymentId: deployment.deploymentId };
      const stagingPath = `/api/rendro/deployments/staging?${new URLSearchParams(deploymentIdentity)}`;
      // One staging authorization per upload/copy batch, plus one at commit.
      for (let i = 0; i < changed + Math.ceil(reused / MAX_REUSED_FILES_PER_REQUEST) + 1; i++) {
        expect((await t.fetch(stagingPath, { headers })).status).toBe(200);
      }
      expect((await t.fetch("/api/rendro/deployments/commit", {
        method: "POST", headers, body: JSON.stringify(deploymentIdentity),
      })).status).toBe(200);
    }
  }, 120_000);
});
