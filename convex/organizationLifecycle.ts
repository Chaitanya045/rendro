import type { GenericCtx } from "@convex-dev/better-auth";
import { APIError } from "better-auth/api";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

export async function isOrganizationDeleted(ctx: GenericCtx<DataModel>, organizationId: string): Promise<boolean> {
  if (!("db" in ctx)) return ctx.runQuery(internal.organizationLifecycle.isDeletedInternal, { organizationId });
  return (await ctx.db.query("organizationTombstones")
    .withIndex("by_organization", q => q.eq("organizationId", organizationId)).unique()) !== null;
}

export async function requireActiveOrganization(ctx: GenericCtx<DataModel>, organizationId: string): Promise<void> {
  if (await isOrganizationDeleted(ctx, organizationId)) throw new ConvexError("Organization membership required");
}

export const isDeletedInternal = internalQuery({
  args: { organizationId: v.string() },
  handler: (ctx, { organizationId }): Promise<boolean> => isOrganizationDeleted(ctx, organizationId),
});

// The auth component has its own transactions. Commit ALL application-side
// revocations before allowing identity deletion, never in an after hook. If
// identity cleanup subsequently fails, the permanent tombstone still denies
// access and the owner can retry the auth deletion safely.
export async function beforeDeleteOrganization(ctx: GenericCtx<DataModel>, organizationId: string, actorId: string): Promise<void> {
  try {
    if (!("runMutation" in ctx)) throw new Error("Mutation context required");
    await ctx.runMutation(internal.organizationLifecycle.deleteInternal, { organizationId, actorId });
  } catch {
    throw new APIError("BAD_REQUEST", { message: "Organization deletion could not safely complete. No identity deletion was performed." });
  }
}

// Bound the entire transaction, never silently truncate revocation. Larger
// organizations are refused before any write; database size/time limits also
// roll back this transaction and prevent Better Auth deletion.
export const deletionResourceLimit = 1_000;
export const deleteInternal = internalMutation({
  args: { organizationId: v.string(), actorId: v.string() },
  handler: async (ctx, { organizationId, actorId }) => {
    if (await isOrganizationDeleted(ctx, organizationId)) return;
    const keys = await ctx.db.query("apiKeyCredentials").withIndex("by_organization", q => q.eq("organizationId", organizationId)).take(deletionResourceLimit + 1);
    const publications = await ctx.db.query("publications").withIndex("by_organization", q => q.eq("organizationId", organizationId)).take(deletionResourceLimit + 1);
    const shares = await ctx.db.query("shareGrants").withIndex("by_organization", q => q.eq("organizationId", organizationId)).take(deletionResourceLimit + 1);
    const projects = await ctx.db.query("projects").withIndex("by_organization", q => q.eq("organizationId", organizationId)).take(deletionResourceLimit + 1);
    const deployments = await ctx.db.query("deployments").withIndex("by_organization_status", q => q.eq("organizationId", organizationId)).take(deletionResourceLimit + 1);
    if (keys.length + publications.length + shares.length + projects.length + deployments.length > deletionResourceLimit) {
      throw new ConvexError("Organization exceeds the atomic deletion resource limit");
    }
    const deletedAt = Date.now();
    await ctx.db.insert("organizationTombstones", { organizationId, deletedAt, deletedBy: actorId });
    for (const key of keys) if (key.revokedAt === undefined) await ctx.db.patch(key._id, { revokedAt: deletedAt });
    for (const publication of publications) await ctx.db.delete(publication._id);
    for (const share of shares) if (share.revokedAt === undefined) await ctx.db.patch(share._id, { revokedAt: deletedAt });
    for (const project of projects) await ctx.db.patch(project._id, { activeDeploymentId: undefined });
    for (const deployment of deployments) {
      if (deployment.status === "active") await ctx.db.patch(deployment._id, { status: "superseded" });
      if (deployment.status === "staging") await ctx.db.patch(deployment._id, { status: "failed", failureReason: "Organization deleted" });
    }
    await ctx.db.insert("auditEvents", {
      organizationId, actorId, action: "organization.deleted", resourceType: "organization", resourceId: organizationId, createdAt: deletedAt,
    });
  },
});
