import rateLimiterTest from "./convex-rate-limiter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { convexTest } from "convex-test";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";
import { sha256 } from "../convex/credentialHttp";
import { AUTH_CLIENT_IP_HEADER, verifiedAuthRequest } from "../shared/auth-client-ip";
import { CONVEX_INTERNAL_SECRET, CONVEX_SITE_URL } from "../src/config";
import worker from "../src/worker";

const logs = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../src/logger", () => ({ logger: logs }));
const modules = import.meta.glob("../convex/**/*.ts");
const path = "/api/rendro/credentials/validate";

// Only replace the network transport: production Worker routing, header
// forwarding, Convex HTTP actions, and hashed-key database validation are real.
async function fixture(scopes = ["docs:read"]) {
  const backend = convexTest(schema, modules);
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const project = await backend.mutation(internal.projects.createInternal, {
    organizationId: "org-test", name: "Docs", slug: "docs", actorId: "owner",
  });
  if (!project) throw new Error("Project creation failed");
  const keyId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const key = `rnd_live_${keyId}_${await sha256(crypto.randomUUID())}`;
  const credentialId = await backend.mutation(internal.apiKeyCredentials.createInternal, {
    organizationId: "org-test", projectId: project._id, keyId,
    keyPrefix: `rnd_live_${keyId}`, name: "Test", secretHash: await sha256(key),
    scopes, actorId: "owner",
  });
  const forwarded: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe(new URL(CONVEX_SITE_URL).origin);
    forwarded.push(request);
    return backend.fetch(`${url.pathname}${url.search}`, init);
  }));
  const query = new URLSearchParams({ organizationId: "org-test", projectId: project._id, scope: "docs:read" });
  const request = (route = path, authorization: string | null = `Bearer ${key}`) => worker.request(
    `https://rendro.test${route}?${query}`, { headers: authorization ? { authorization } : {} },
  );
  return { backend, project, key, keyId, credentialId, forwarded, query, request };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("API-key requests through the production Worker router", () => {
  it("accepts an active scoped key, then rejects it immediately after revocation", async () => {
    const f = await fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principal: {
      keyId: f.keyId, organizationId: "org-test", projectId: f.project._id, scopes: ["docs:read"],
    } });
    const lastUsedAt = (await f.backend.run(ctx => ctx.db.get(f.credentialId)))?.lastUsedAt;
    expect(lastUsedAt).toEqual(expect.any(Number));
    await f.backend.mutation(internal.apiKeyCredentials.revokeInternal, {
      organizationId: "org-test", keyId: f.keyId, actorId: "owner",
    });
    const rejected = await f.request();
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({ error: "Invalid or insufficient API key" });
    expect((await f.backend.run(ctx => ctx.db.get(f.credentialId)))?.lastUsedAt).toBe(lastUsedAt);
    expect(inspect(Object.values(logs).map(log => log.mock.calls), { depth: null })).not.toContain(f.key);
  });

  it.each([
    "expired", "wrong scope", "wrong organization", "wrong project", "missing project",
    "malformed project", "wrong-table project", "malformed key", "wrong scheme", "missing key",
  ])("rejects %s without recording use", async (kind) => {
    const f = await fixture();
    let authorization: string | null = `Bearer ${f.key}`;
    if (kind === "expired") await f.backend.run(ctx => ctx.db.patch(f.credentialId, { expiresAt: Date.now() - 1 }));
    if (kind === "wrong scope") f.query.set("scope", "docs:write");
    if (kind === "wrong organization") f.query.set("organizationId", "org-other");
    if (kind === "wrong project") {
      const other = await f.backend.mutation(internal.projects.createInternal, {
        organizationId: "org-test", name: "Other", slug: "other", actorId: "owner",
      });
      f.query.set("projectId", other!._id);
    }
    if (kind === "missing project") f.query.delete("projectId");
    if (kind === "malformed project") f.query.set("projectId", "not-an-id");
    if (kind === "wrong-table project") f.query.set("projectId", f.credentialId);
    if (kind === "malformed key") authorization = "Bearer malformed-key";
    if (kind === "wrong scheme") authorization = `Basic ${f.key}`;
    if (kind === "missing key") authorization = null;
    const response = await f.request(path, authorization);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid or insufficient API key" });
    expect((await f.backend.run(ctx => ctx.db.get(f.credentialId)))?.lastUsedAt).toBeUndefined();
  });

  it.each(["organizationId", "scope"])("returns 400 for missing %s", async field => {
    const f = await fixture();
    f.query.delete(field);
    const response = await f.request();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "organizationId and scope are required" });
  });


  it("retains signed ingress IP forwarding and discards spoofed forwarding headers", async () => {
    const f = await fixture();
    const response = await worker.request(`https://rendro.test${path}?${f.query}`, { headers: {
      authorization: `Bearer ${f.key}`, "cf-connecting-ip": "192.0.2.10",
      "x-forwarded-for": "192.0.2.99", [AUTH_CLIENT_IP_HEADER]: "192.0.2.99",
      "x-rendro-client-ip-signature": "forged",
    } });
    expect(response.status).toBe(200);
    const verified = await verifiedAuthRequest(f.forwarded[0], CONVEX_INTERNAL_SECRET);
    expect(verified.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("192.0.2.10");
    expect(verified.headers.get("x-forwarded-for")).toBeNull();
    expect(verified.headers.get("cf-connecting-ip")).toBeNull();
  });

  it.each([
    ["GET", "/api/auth/get-session"], ["POST", "/api/auth/sign-in/email"],
    ["GET", "/api/rendro/credentials"], ["POST", "/api/rendro/credentials/revoke"],
    ["GET", "/api/rendro/projects"], ["GET", "/api/rendro/credentials/validate/extra"],
    ["POST", path], ["POST", "/api/rendro/deployments/commit"],
  ])("does not broaden bearer forwarding to %s %s", async (method, route) => {
    const f = await fixture();
    vi.mocked(fetch).mockImplementation((_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("cookie")).toBe("session=test");
      return Promise.resolve(Response.json({ ok: true }));
    });
    expect((await worker.request(`https://rendro.test${route}`, {
      method, headers: { origin: process.env.SITE_URL!, "content-type": "application/json", authorization: `Bearer ${f.key}`, cookie: "session=test" },
    })).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["upstream", "transport"])("sanitizes %s failures without logging credentials", async kind => {
    const f = await fixture();
    const diagnostic = `Internal failure with ${f.key}`;
    if (kind === "upstream") vi.mocked(fetch).mockResolvedValueOnce(new Response(diagnostic, { status: 500 }));
    else vi.mocked(fetch).mockRejectedValueOnce(new Error(diagnostic));
    const response = await f.request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Backend unavailable" });
    expect(logs.error).toHaveBeenCalledWith({
      category: kind === "upstream" ? "UpstreamError" : "TransportError",
      operation: "proxyConvexRequest", status: kind === "upstream" ? 500 : null,
    }, "Backend request failed");
    expect(inspect(Object.values(logs).map(log => log.mock.calls), { depth: null })).not.toContain(f.key);
  });
});
