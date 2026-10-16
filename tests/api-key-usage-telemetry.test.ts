import rateLimiterTest from "./convex-rate-limiter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import type { GenericActionCtx } from "convex/server";
import { internal } from "../convex/_generated/api";
import type { DataModel } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { API_KEY_USAGE_DEBOUNCE_MS } from "../convex/apiKeyCredentials";
import { apiKeyRateLimiter, apiKeyRateLimits } from "../convex/apiKeyHttp";
import { sha256, validateApiCredential } from "../convex/credentialHttp";

const modules = import.meta.glob("../convex/**/*.ts");
const key = "test-usage-credential-never-log";
const headers = { authorization: `Bearer ${key}` };
const start = Date.UTC(2026, 0, 1);

async function fixture() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const project = await t.mutation(internal.projects.createInternal, {
    organizationId: "org-test", name: "Docs", slug: "docs", actorId: "owner",
  });
  if (!project) throw new Error("Project creation failed");
  const credentialId = await t.mutation(internal.apiKeyCredentials.createInternal, {
    organizationId: "org-test", projectId: project._id, keyId: "usage-key", keyPrefix: "rnd_live_usage-key",
    name: "CI", secretHash: await sha256(key), scopes: ["docs:read", "docs:write"], actorId: "owner",
  });
  const query = new URLSearchParams({ organizationId: "org-test", projectId: project._id, scope: "docs:read" });
  const validate = () => t.fetch(`/api/rendro/credentials/validate?${query}`, { headers });
  const credential = async () => (await t.run(ctx => ctx.db.get(credentialId)))!;
  // Delegates to the real backend while counting every mutation the auth path issues.
  const mutate = t.mutation as unknown as (reference: unknown, args: unknown) => Promise<unknown>;
  const runMutation = vi.fn(mutate);
  const ctx = { runQuery: t.query, runMutation } as unknown as GenericActionCtx<DataModel>;
  const authorize = (requiredScope = "docs:read") => validateApiCredential(
    ctx, new Request("https://rendro.test", { headers }), { organizationId: "org-test", projectId: project._id, requiredScope },
  );
  return { t, clock, project, credentialId, validate, credential, runMutation, authorize };
}

afterEach(() => vi.restoreAllMocks());

describe("read-only API-key authorization with debounced usage telemetry", () => {
  it("writes the credential at most once per window and records again after it elapses", async () => {
    const f = await fixture();
    expect((await f.validate()).status).toBe(200);
    const recorded = await f.credential();
    expect(recorded.lastUsedAt).toBe(start);

    f.clock.mockReturnValue(start + 1_000);
    for (let i = 0; i < 5; i++) expect((await f.validate()).status).toBe(200);
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => f.validate()));
    expect(concurrent.map(response => response.status)).toEqual(Array(10).fill(200));
    f.clock.mockReturnValue(start + API_KEY_USAGE_DEBOUNCE_MS - 1);
    expect((await f.validate()).status).toBe(200);
    // Byte-identical document: no field, including lastUsedAt, was rewritten.
    expect(await f.credential()).toEqual(recorded);

    f.clock.mockReturnValue(start + API_KEY_USAGE_DEBOUNCE_MS);
    expect((await f.validate()).status).toBe(200);
    expect((await f.credential()).lastUsedAt).toBe(start + API_KEY_USAGE_DEBOUNCE_MS);
  });

  it("issues no mutation for valid checks inside the window, sequential or concurrent", async () => {
    const f = await fixture();
    expect(await f.authorize()).toEqual({
      keyId: "usage-key", organizationId: "org-test", projectId: f.project._id, scopes: ["docs:read", "docs:write"],
    });
    expect(f.runMutation).toHaveBeenCalledTimes(1);
    f.runMutation.mockClear();
    f.clock.mockReturnValue(start + 30_000);
    const principals = await Promise.all(Array.from({ length: 20 }, (_, i) => f.authorize(i % 2 ? "docs:write" : "docs:read")));
    expect(principals.every(principal => principal?.keyId === "usage-key")).toBe(true);
    expect(f.runMutation).not.toHaveBeenCalled();
  });

  it("lets only one of several racing stale checks write the credential", async () => {
    const f = await fixture();
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => f.authorize()));
    expect(outcomes.every(principal => principal?.keyId === "usage-key")).toBe(true);
    const writes = await Promise.all(f.runMutation.mock.results.map(result => result.value as Promise<boolean>));
    expect(writes.filter(Boolean)).toHaveLength(1);
    expect((await f.credential()).lastUsedAt).toBe(start);
    expect(await f.t.mutation(internal.apiKeyCredentials.recordUsageInternal, { credentialId: f.credentialId })).toBe(false);
  });

  it.each([
    ["revocation", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.t.mutation(internal.apiKeyCredentials.revokeInternal, { organizationId: "org-test", keyId: "usage-key", actorId: "owner" });
    }],
    ["expiry", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.t.run(ctx => ctx.db.patch(f.credentialId, { expiresAt: start + 2_000 }));
      f.clock.mockReturnValue(start + 2_000);
    }],
    ["scope reduction", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.t.run(ctx => ctx.db.patch(f.credentialId, { scopes: ["docs:write"] }));
    }],
    ["organization deletion", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.t.run(ctx => ctx.db.insert("organizationTombstones", { organizationId: "org-test", deletedAt: start, deletedBy: "owner" }));
    }],
  ])("denies the very next request after %s, inside the debounce window", async (_, change) => {
    const f = await fixture();
    expect((await f.validate()).status).toBe(200);
    f.clock.mockReturnValue(start + 1_000);
    expect((await f.validate()).status).toBe(200);
    const before = await f.credential();
    await change(f);
    const denied = await f.validate();
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "Invalid or insufficient API key" });
    f.runMutation.mockClear();
    expect(await f.authorize()).toBeNull();
    expect(f.runMutation).not.toHaveBeenCalled();
    expect((await f.credential()).lastUsedAt).toBe(before.lastUsedAt);
  });

  it("keeps rate-limit denials authoritative and records no use for them", async () => {
    const f = await fixture();
    const { shards, capacity } = apiKeyRateLimits.credential;
    const random = vi.spyOn(Math, "random");
    for (let shard = 0; shard < shards; shard++) {
      random.mockReturnValue((shard + 0.1) / shards);
      expect((await f.t.run(ctx => apiKeyRateLimiter.limit(ctx, "credential", {
        key: f.credentialId, count: capacity / shards,
      }))).ok).toBe(true);
    }
    random.mockRestore();
    const limited = await f.validate();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Rate limit exceeded", code: "rate_limited" });
    expect((await f.credential()).lastUsedAt).toBeUndefined();
  });

  it("still authorizes when best-effort usage telemetry fails, without logging the key", async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.runMutation.mockRejectedValueOnce(new Error(key));
    expect(await f.authorize()).toMatchObject({ keyId: "usage-key" });
    expect(warn).toHaveBeenCalledWith("API key usage telemetry failed", { operation: "recordUsage" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(key);
    expect((await f.credential()).lastUsedAt).toBeUndefined();
  });

  it("denies a missing bearer without reading or writing, and skips usage for a deleted credential", async () => {
    const f = await fixture();
    const runQuery = vi.fn(), runMutation = vi.fn();
    const ctx = { runQuery, runMutation } as unknown as GenericActionCtx<DataModel>;
    expect(await validateApiCredential(ctx, new Request("https://rendro.test"), {
      organizationId: "org-test", requiredScope: "docs:read",
    })).toBeNull();
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
    await f.t.run(ctx => ctx.db.delete(f.credentialId));
    expect(await f.t.mutation(internal.apiKeyCredentials.recordUsageInternal, { credentialId: f.credentialId })).toBe(false);
  });
});
