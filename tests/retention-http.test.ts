import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => vi.unstubAllEnvs());

describe("retention operator HTTP", () => {
  it("authenticates both operations and returns non-cacheable claimed pages", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    vi.stubEnv("RETENTION_SECRET", "retention-test");
    for (const [path, method] of [["candidates", "GET"], ["purged", "POST"]]) {
      expect((await t.fetch(`/api/rendro/retention/${path}`, { method })).status).toBe(401);
    }
    const result = await t.fetch("/api/rendro/retention/candidates", { headers: { Authorization: "Bearer retention-test" } });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ deployments: [], cycleComplete: false, scanned: 0 });
    vi.stubEnv("RETENTION_SECRET", undefined);
    expect((await t.fetch("/api/rendro/retention/candidates", { headers: { Authorization: "Bearer undefined" } })).status).toBe(401);
  });

  it.each(["{", "null", "1", "{}", '{"deploymentId":1}', '{"deploymentId":"x","objectCount":0}', '{"deploymentId":"x","purgeToken":"x"}', '{"deploymentId":"x","purgeToken":"x","objectCount":1.5}', '{"deploymentId":"x","purgeToken":"x","objectCount":-1}'])("rejects malformed finalization %s", async body => {
    vi.stubEnv("RETENTION_SECRET", "retention-test");
    const result = await convexTest({ schema, modules, transactionLimits: true }).fetch("/api/rendro/retention/purged", { method: "POST", headers: { Authorization: "Bearer retention-test" }, body });
    expect(result.status).toBe(400);
  });

  it("requires a matching claim for finalization", async () => {
    vi.stubEnv("RETENTION_SECRET", "retention-test");
    const t = convexTest({ schema, modules, transactionLimits: true });
    const deploymentId = await t.run(async ctx => {
      const projectId = await ctx.db.insert("projects", { organizationId: "org", name: "Docs", slug: "docs", createdAt: 1, createdBy: "user" });
      return ctx.db.insert("deployments", { organizationId: "org", projectId, status: "failed", createdAt: 1, createdBy: "user", manifestKey: "pending", manifestSha256: "sha", fileCount: 0, byteCount: 0, provenance: { source: { kind: "local" }, execution: { kind: "local" }, cliVersion: "test", manifestSha256: "sha" } });
    });
    const result = await t.fetch("/api/rendro/retention/purged", { method: "POST", headers: { Authorization: "Bearer retention-test" }, body: JSON.stringify({ deploymentId, purgeToken: "wrong", objectCount: 0 }) });
    expect(await result.json()).toEqual({ purged: false });
  });
});
