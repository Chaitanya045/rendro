import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { PURGE_CLAIM_MS, STAGING_DRAIN_MS, STAGING_LEASE_MS } from "../convex/retentionPolicy";

const modules = import.meta.glob("../convex/**/*.ts");
const now = 100 * 86_400_000;
const provenance = { source: { kind: "local" as const }, execution: { kind: "local" as const }, cliVersion: "test", manifestSha256: "sha" };
function fixture() {
  const backend = convexTest(schema, modules);
  const project = () => backend.run(ctx => ctx.db.insert("projects", { organizationId: "org", name: "Docs", slug: "docs", createdBy: "user", createdAt: 1 }));
  const seed = (projectId: Id<"projects">, fields: Partial<Doc<"deployments">> = {}) => backend.run(ctx => ctx.db.insert("deployments", {
    organizationId: "org", projectId, status: "superseded", createdAt: 1, createdBy: "user", manifestKey: "pending", manifestSha256: "sha", fileCount: 1, byteCount: 1, provenance, ...fields,
  }));
  const pin = (projectId: Id<"projects">, deploymentId: Id<"deployments">, slug = "pin") => backend.mutation(internal.publicationsV2.createInternal, {
    organizationId: "org", projectId, trackingMode: "pinned", pinnedDeploymentId: deploymentId, pathPrefix: "", entryFile: "index.html", slug, actorId: "user",
  });
  const page = (token = "claim") => backend.mutation(internal.retention.candidatesInternal, { token });
  const cycle = async (token = "claim") => {
    const claims = [];
    for (let i = 0; i < 200; i++) {
      const result = await page(token);
      claims.push(...result.deployments);
      if (result.cycleComplete) return claims;
    }
    throw new Error("Scan did not finish");
  };
  return { backend, project, seed, pin, page, cycle };
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => vi.restoreAllMocks());

describe("durable retention", () => {
  it("advances past over 2,000 pinned rows and excludes active/purged rows from the scan", async () => {
    const f = fixture(), projectId = await f.project();
    await f.backend.run(async ctx => {
      for (let i = 0; i < 2_001; i++) {
        const row = { organizationId: "org", projectId, createdAt: i, createdBy: "user", manifestKey: "pending", manifestSha256: "sha", fileCount: 1, byteCount: 1, provenance };
        const id = await ctx.db.insert("deployments", { ...row, status: "superseded" });
        await ctx.db.insert("publications", { organizationId: "org", projectId, pinnedDeploymentId: id, trackingMode: "pinned", slug: `pin-${i}`, pathPrefix: "", entryFile: "index.html", createdAt: 1, updatedAt: 1, createdBy: "user" });
        if (i === 0) {
          await ctx.db.insert("deployments", { ...row, status: "failed", purgedAt: 0 });
          await ctx.db.insert("deployments", { ...row, status: "active" });
        }
      }
    });
    const eligible = await f.seed(projectId, { createdAt: 2_002 });
    expect((await f.page()).scanned).toBe(0); // failed: purged rows are excluded by the index
    for (let i = 0; i < 40; i++) {
      const result = await f.page();
      expect(result.scanned).toBe(50);
      expect(result.deployments).toEqual([]);
    }
    // Simulated process restart: no local cursor is supplied to the next run.
    const claims = await f.cycle();
    expect(claims.map(c => c._id)).toEqual([eligible]);
    expect(await f.backend.run(ctx => ctx.db.query("retentionProgress").collect())).toHaveLength(1);
  }, 120_000);

  it("drains multiple pages and recovers lost responses and partial deletion with a new token", async () => {
    const f = fixture(), projectId = await f.project();
    const ids = [];
    for (let i = 0; i < 101; i++) ids.push(await f.seed(projectId, { status: "failed" }));
    expect((await f.page("lost-response")).deployments).toHaveLength(50);
    expect((await f.cycle()).map(c => c._id)).toHaveLength(51);
    expect(await f.cycle()).toEqual([]); // unexpired workers own every claim
    vi.mocked(Date.now).mockReturnValue(now + PURGE_CLAIM_MS);
    const retry = await f.cycle("retry");
    expect(retry.map(c => c._id).sort()).toEqual(ids.sort());
    const deploymentId = ids[0];
    expect(await f.backend.mutation(internal.retention.markPurgedInternal, { deploymentId, purgeToken: "lost-response", objectCount: 1 })).toBe(false);
    const finish = () => f.backend.mutation(internal.retention.markPurgedInternal, { deploymentId, purgeToken: "retry", objectCount: 0 });
    expect(await finish()).toBe(true);
    expect(await finish()).toBe(true);
    expect(await f.backend.run(ctx => ctx.db.query("auditEvents").collect())).toHaveLength(1);
    expect(await f.backend.run(ctx => ctx.db.get(deploymentId))).toMatchObject({ purgedAt: now + PURGE_CLAIM_MS });
  });

  it("gives exactly one winner for each controlled pin/claim ordering and protects pinned bytes", async () => {
    for (const pinFirst of [true, false]) {
      const f = fixture(), projectId = await f.project(), deploymentId = await f.seed(projectId);
      const bytes = new Set([deploymentId]);
      if (pinFirst) await f.pin(projectId, deploymentId);
      const claims = await f.cycle();
      if (!pinFirst) await expect(f.pin(projectId, deploymentId)).rejects.toThrow("Pinned deployment not found");
      for (const claim of claims) {
        bytes.delete(claim._id);
        await f.backend.mutation(internal.retention.markPurgedInternal, { deploymentId: claim._id, purgeToken: claim.purgeToken, objectCount: 1 });
      }
      expect(claims.length).toBe(pinFirst ? 0 : 1);
      expect(bytes.has(deploymentId)).toBe(pinFirst);
      if (!pinFirst) await expect(f.pin(projectId, deploymentId)).rejects.toThrow("Pinned deployment not found");
    }
  });

  it("rejects legacy purged pins, ignores track-active pin input, and denies purge without a claim", async () => {
    const f = fixture(), projectId = await f.project(), deploymentId = await f.seed(projectId, { purgedAt: 0 });
    await expect(f.pin(projectId, deploymentId)).rejects.toThrow("Pinned deployment not found");
    const publication = await f.backend.mutation(internal.publicationsV2.createInternal, { organizationId: "org", projectId, trackingMode: "track_active", pinnedDeploymentId: deploymentId, pathPrefix: "", entryFile: "index.html", slug: "tracked", actorId: "user" });
    expect(publication?.pinnedDeploymentId).toBeUndefined();
    expect(await f.backend.mutation(internal.retention.markPurgedInternal, { deploymentId, purgeToken: "x", objectCount: 0 })).toBe(false);
    await f.backend.run(ctx => ctx.db.delete(deploymentId));
    expect(await f.backend.mutation(internal.retention.markPurgedInternal, { deploymentId, purgeToken: "x", objectCount: 0 })).toBe(false);
  });

  it("protects live shares and active pointers, but not expired or revoked shares", async () => {
    const f = fixture(), projectId = await f.project();
    const live = await f.seed(projectId, { status: "active" });
    await f.backend.run(ctx => ctx.db.patch(projectId, { activeDeploymentId: live }));
    await f.backend.mutation(internal.shareGrants.createInternal, { organizationId: "org", projectId, documentPath: "index.html", tokenHash: "live", expiresAt: now + 100, actorId: "user" });
    const expired = await f.seed(projectId), revoked = await f.seed(projectId), pointer = await f.seed(projectId);
    await f.backend.run(async ctx => {
      await ctx.db.patch(live, { status: "superseded" });
      await ctx.db.patch(projectId, { activeDeploymentId: pointer });
      for (const [deploymentId, expiresAt, revokedAt] of [[expired, now, undefined], [revoked, now + 100, 1]] as const) {
        await ctx.db.insert("shareGrants", { organizationId: "org", projectId, deploymentId, expiresAt, revokedAt, documentPath: "index.html", tokenHash: deploymentId, createdBy: "user", createdAt: 1 });
      }
    });
    expect((await f.cycle()).map(c => c._id).sort()).toEqual([expired, revoked].sort());
    vi.mocked(Date.now).mockReturnValue(now + 100);
    expect((await f.cycle()).map(c => c._id)).toEqual([live]);
  });

  it("claims orphaned deployments without needing a project row", async () => {
    const f = fixture(), projectId = await f.project(), deploymentId = await f.seed(projectId);
    await f.backend.run(ctx => ctx.db.delete(projectId));
    expect((await f.cycle()).map(c => c._id)).toEqual([deploymentId]);
  });
});

describe("staging leases", () => {
  it("renews active uploads, rejects late renewal and commit, and drains expired and legacy leases", async () => {
    const f = fixture(), projectId = await f.project();
    const start = await f.backend.mutation(internal.deployments.startInternal, { organizationId: "org", projectId, fileCount: 1, byteCount: 1, manifestSha256: "sha", provenance, actorId: "user" });
    const identity = { organizationId: "org", projectId, deploymentId: start.deploymentId };
    expect(start.stagingExpiresAt).toBe(now + STAGING_LEASE_MS);
    expect((await f.backend.mutation(internal.deployments.refreshStagingInternal, identity))?.stagingExpiresAt).toBe(start.stagingExpiresAt);
    vi.mocked(Date.now).mockReturnValue(now + STAGING_LEASE_MS - 1);
    expect((await f.backend.mutation(internal.deployments.refreshStagingInternal, identity))?.stagingExpiresAt).toBe(now + 2 * STAGING_LEASE_MS - 1);
    const legacy = await f.seed(projectId, { status: "staging" });
    const recentLegacy = await f.seed(projectId, { status: "staging", createdAt: now });
    const live = await f.seed(projectId, { status: "staging", stagingExpiresAt: now + 10 * STAGING_DRAIN_MS });
    expect((await f.cycle()).map(c => c._id)).toEqual([legacy]);
    expect(await f.backend.run(ctx => ctx.db.get(legacy))).toMatchObject({ status: "failed", failureReason: "Staging lease expired", purgeState: "purging" });
    vi.mocked(Date.now).mockReturnValue(now + 2 * STAGING_LEASE_MS - 1);
    expect(await f.backend.mutation(internal.deployments.refreshStagingInternal, identity)).toBeNull();
    await expect(f.backend.mutation(internal.deployments.commitInternal, { ...identity, actorId: "user" })).rejects.toThrow("Staging lease expired");
    await f.cycle(); // update the fixed scan cutoff
    expect((await f.cycle()).map(c => c._id)).not.toContain(start.deploymentId);
    vi.mocked(Date.now).mockReturnValue(now + 2 * STAGING_LEASE_MS + STAGING_DRAIN_MS);
    const drained = [...await f.cycle(), ...await f.cycle()].map(c => c._id);
    expect(drained).toContain(start.deploymentId);
    expect(drained).toContain(recentLegacy);
    expect(drained).not.toContain(live);
  });

  it("checks lease renewal identity/status and retains recently failed upload leases", async () => {
    const f = fixture(), projectId = await f.project(), other = await f.project();
    const deploymentId = await f.seed(projectId, { status: "staging", stagingExpiresAt: now + 1 });
    const identity = { organizationId: "org", projectId, deploymentId };
    expect(await f.backend.mutation(internal.deployments.refreshStagingInternal, { ...identity, organizationId: "other" })).toBeNull();
    expect(await f.backend.mutation(internal.deployments.refreshStagingInternal, { ...identity, projectId: other })).toBeNull();
    await f.backend.mutation(internal.deployments.failInternal, { ...identity, reason: "interrupted" });
    expect(await f.backend.mutation(internal.deployments.refreshStagingInternal, identity)).toBeNull();
    expect(await f.cycle()).toEqual([]);
    await f.backend.run(ctx => ctx.db.delete(deploymentId));
    expect(await f.backend.mutation(internal.deployments.refreshStagingInternal, identity)).toBeNull();
  });
});

describe("references cannot expose purged storage", () => {
  it.each([{ purgeState: "purging" as const }, { purgedAt: 0 }])("rejects shares and public resolution for %j", async fields => {
    const f = fixture(), projectId = await f.project(), deploymentId = await f.seed(projectId, { status: "active" });
    await f.backend.run(ctx => ctx.db.patch(projectId, { activeDeploymentId: deploymentId }));
    await f.pin(projectId, deploymentId);
    await f.backend.mutation(internal.shareGrants.createInternal, { organizationId: "org", projectId, documentPath: "index.html", tokenHash: "live", expiresAt: now + 100, actorId: "user" });
    await f.backend.run(ctx => ctx.db.patch(deploymentId, fields));
    await expect(f.backend.mutation(internal.shareGrants.createInternal, { organizationId: "org", projectId, documentPath: "index.html", tokenHash: "new", expiresAt: now + 100, actorId: "user" })).rejects.toThrow("Project has no active deployment");
    expect(await f.backend.query(internal.shareGrants.resolveInternal, { tokenHash: "live" })).toBeNull();
    expect(await f.backend.query(internal.publicationsV2.resolvePublicInternal, { slug: "pin" })).toBeNull();
  });
});
