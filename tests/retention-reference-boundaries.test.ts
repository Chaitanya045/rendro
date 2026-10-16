import rateLimiterTest from "./convex-rate-limiter";
import { publishWithProof, shareWithProof } from "./helpers/storage-proof";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Doc } from "../convex/_generated/dataModel";
const modules = import.meta.glob("../convex/**/*.ts");

async function fixture() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  rateLimiterTest.register(t);
  const projectId = await t.run(ctx => ctx.db.insert("projects", { organizationId: "org", slug: "docs", name: "Docs", createdBy: "user", createdAt: 1 }));
  const otherProjectId = await t.run(ctx => ctx.db.insert("projects", { organizationId: "other", slug: "other", name: "Other", createdBy: "user", createdAt: 1 }));
  const deploymentId = await t.run(ctx => ctx.db.insert("deployments", { organizationId: "org", projectId, status: "active", manifestKey: "manifest", manifestSha256: "a".repeat(64), fileCount: 1, byteCount: 1, createdAt: Date.now(), createdBy: "user", provenance: { source: { kind: "local" }, execution: { kind: "local" }, cliVersion: "test", manifestSha256: "a".repeat(64) } }));
  await t.run(ctx => ctx.db.patch(projectId, { activeDeploymentId: deploymentId }));
  const publication = { organizationId: "org", projectId, slug: "docs", pathPrefix: "", entryFile: "index.html", trackingMode: "pinned" as const, pinnedDeploymentId: deploymentId, actorId: "user" };
  const share = { organizationId: "org", projectId, documentPath: "index.html", tokenHash: "token", expiresAt: Date.now() + 60_000, actorId: "user" };
  return { t, projectId, otherProjectId, deploymentId, publication, share };
}

describe("publication reference boundaries", () => {
  it("validates project, slug uniqueness, paths, and required deployment before creating references", async () => {
    const f = await fixture();
    for (const [patch, error] of [
      [{ organizationId: "other" }, "Project not found"], [{ slug: "!" }, "Invalid publication slug"], [{ slug: "a".repeat(81) }, "Invalid publication slug"],
      [{ entryFile: "../index.html" }, "Invalid publication path"], [{ pinnedDeploymentId: undefined }, "requires a deployment"],
      [{ projectId: f.otherProjectId, organizationId: "other" }, "Publication deployment not found"],
    ] as const) await expect(publishWithProof(f.t, { ...f.publication, ...patch })).rejects.toThrow(error);
    const created = await publishWithProof(f.t, { ...f.publication, title: " Title ", description: " Description " });
    expect(created).toMatchObject({ title: "Title", description: "Description" });
    await expect(publishWithProof(f.t, f.publication)).rejects.toThrow("already in use");
    expect(await f.t.query(internal.publicationsV2.listInternal, { organizationId: "org" })).toHaveLength(1);
    await f.t.run(ctx => ctx.db.delete(f.projectId));
    await expect(publishWithProof(f.t, { ...f.publication, slug: "other" })).rejects.toThrow("Project not found");
    await expect(f.t.query(internal.publicationsV2.listInternal, { organizationId: "org", projectId: f.projectId })).rejects.toThrow("Project not found");
    expect(await f.t.query(internal.publicationsV2.resolvePublicInternal, { slug: "docs" })).toBeNull();
  });

  it.each(["failed", "staging", "missing"] as const)("refuses %s deployment pins and resolves old references closed", async status => {
    const f = await fixture();
    await publishWithProof(f.t, f.publication);
    if (status === "missing") await f.t.run(ctx => ctx.db.delete(f.deploymentId));
    else await f.t.run(ctx => ctx.db.patch(f.deploymentId, { status }));
    await expect(publishWithProof(f.t, { ...f.publication, slug: "new" })).rejects.toThrow("Publication deployment not found");
    expect(await f.t.query(internal.publicationsV2.resolvePublicInternal, { slug: "docs" })).toBeNull();
  });

  it("resolves both supported reference modes and rejects dangling legacy pins and invalid removal identities", async () => {
    const f = await fixture();
    const pinned = await publishWithProof(f.t, { ...f.publication, title: " ", description: " " });
    const tracked = await publishWithProof(f.t, { ...f.publication, slug: "track", trackingMode: "track_active", pinnedDeploymentId: undefined });
    expect(pinned?.title).toBe("Docs");
    await f.t.run(ctx => ctx.db.patch(pinned!._id, { title: undefined }));
    for (const slug of ["docs", "track"]) expect(await f.t.query(internal.publicationsV2.resolvePublicInternal, { slug })).toMatchObject({ deployment: { manifestKey: "manifest" } });
    expect(await f.t.query(internal.publicationsV2.resolvePublicInternal, { slug: "missing" })).toBeNull();
    const remove = { organizationId: "org", projectId: f.projectId, publicationId: pinned!._id, actorId: "user" };
    await expect(f.t.mutation(internal.publicationsV2.removeInternal, { ...remove, organizationId: "other" })).rejects.toThrow("Publication not found");
    await f.t.run(async ctx => { await ctx.db.patch(pinned!._id, { pinnedDeploymentId: undefined }); await ctx.db.patch(f.projectId, { activeDeploymentId: undefined }); });
    for (const slug of ["docs", "track"]) expect(await f.t.query(internal.publicationsV2.resolvePublicInternal, { slug })).toBeNull();
    await f.t.mutation(internal.publicationsV2.removeInternal, remove);
    await expect(f.t.mutation(internal.publicationsV2.removeInternal, remove)).rejects.toThrow("Publication not found");
    expect(tracked).not.toBeNull();
  });
});

describe("share reference boundaries", () => {
  it("requires an existing, active deployment belonging to the same project and organization", async () => {
    const f = await fixture();
    for (const patch of [{ projectId: f.otherProjectId }, { organizationId: "other" }, { status: "superseded" as const }]) {
      await f.t.run(ctx => ctx.db.patch(f.deploymentId, patch));
      await expect(shareWithProof(f.t, f.share)).rejects.toThrow("no active deployment");
      await f.t.run(ctx => ctx.db.patch(f.deploymentId, { projectId: f.projectId, organizationId: "org", status: "active" }));
    }
    await expect(shareWithProof(f.t, { ...f.share, organizationId: "other" })).rejects.toThrow("no active deployment");
    await f.t.run(ctx => ctx.db.delete(f.deploymentId));
    await expect(shareWithProof(f.t, f.share)).rejects.toThrow("no active deployment");
    await f.t.run(ctx => ctx.db.patch(f.projectId, { activeDeploymentId: undefined }));
    await expect(shareWithProof(f.t, f.share)).rejects.toThrow("no active deployment");
    await f.t.run(ctx => ctx.db.delete(f.projectId));
    await expect(shareWithProof(f.t, f.share)).rejects.toThrow("no active deployment");
  });

  it("validates paths and expiry, and supports idempotent revocation with tenant checks", async () => {
    const f = await fixture();
    for (const documentPath of ["", "a\\b", "/index.html", "./index.html", "../index.html"]) await expect(shareWithProof(f.t, { ...f.share, documentPath })).rejects.toThrow("Invalid document path");
    await expect(shareWithProof(f.t, { ...f.share, expiresAt: 1 })).rejects.toThrow("future");
    const grant = await shareWithProof(f.t, f.share);
    expect(await f.t.query(internal.shareGrants.resolveInternal, { tokenHash: "token" })).toMatchObject({ deployment: { manifestKey: "manifest" } });
    expect(await f.t.query(internal.shareGrants.resolveInternal, { tokenHash: "missing" })).toBeNull();
    const revoke = { organizationId: "org", grantId: grant!._id, actorId: "user" };
    await expect(f.t.mutation(internal.shareGrants.revokeInternal, { ...revoke, organizationId: "other" })).rejects.toThrow("Share not found");
    expect(await f.t.mutation(internal.shareGrants.revokeInternal, revoke)).toBe(true);
    expect(await f.t.mutation(internal.shareGrants.revokeInternal, revoke)).toBe(true);
    expect(await f.t.query(internal.shareGrants.resolveInternal, { tokenHash: "token" })).toBeNull();
    await f.t.run(ctx => ctx.db.delete(grant!._id));
    await expect(f.t.mutation(internal.shareGrants.revokeInternal, revoke)).rejects.toThrow("Share not found");
  });

  // Expiry is decided by the httpAction, not this query: see tests/query-clock-purity.test.ts.
  it.each(["failed", "staging", "missing-deployment", "missing-project"])("denies existing shares when %s", async state => {
    const f = await fixture();
    await shareWithProof(f.t, f.share);
    await f.t.run(async ctx => {
      if (state === "missing-deployment") await ctx.db.delete(f.deploymentId);
      else if (state === "missing-project") await ctx.db.delete(f.projectId);
      else await ctx.db.patch(f.deploymentId, { status: state as Doc<"deployments">["status"] });
    });
    expect(await f.t.query(internal.shareGrants.resolveInternal, { tokenHash: "token" })).toBeNull();
  });
});

it("preserves publication attestation checks and rejects a missing tracked deployment", async () => {
  const f = await fixture();
  await expect(f.t.mutation(internal.publicationsV2.createInternal, f.publication)).rejects.toThrow("Worker publication entry validation is required");
  await f.t.run(ctx => ctx.db.patch(f.projectId, { activeDeploymentId: undefined }));
  await expect(publishWithProof(f.t, { ...f.publication, trackingMode: "track_active" })).rejects.toThrow("Publication deployment not found");
});
