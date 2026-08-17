import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

function validDocumentPath(value: string): boolean {
  return Boolean(value)
    && !value.includes("\\")
    && value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

export const createInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    documentPath: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId || !project.activeDeploymentId) {
      throw new ConvexError("Project has no active deployment");
    }
    if (!validDocumentPath(args.documentPath)) throw new ConvexError("Invalid document path");
    if (args.expiresAt <= Date.now()) throw new ConvexError("Share expiry must be in the future");
    const now = Date.now();
    const grantId = await ctx.db.insert("shareGrants", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      deploymentId: project.activeDeploymentId,
      documentPath: args.documentPath,
      tokenHash: args.tokenHash,
      expiresAt: args.expiresAt,
      createdBy: args.actorId,
      createdAt: now,
    });
    await ctx.db.insert("auditEvents", {
      organizationId: args.organizationId,
      actorId: args.actorId,
      action: "share.created",
      resourceType: "shareGrant",
      resourceId: grantId,
      metadata: { projectId: args.projectId, deploymentId: project.activeDeploymentId, expiresAt: args.expiresAt },
      createdAt: now,
    });
    return await ctx.db.get(grantId);
  },
});

export const resolveInternal = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const grant = await ctx.db
      .query("shareGrants")
      .withIndex("by_token_hash", (query) => query.eq("tokenHash", args.tokenHash))
      .unique();
    if (!grant || grant.revokedAt || grant.expiresAt <= Date.now()) return null;
    const deployment = await ctx.db.get(grant.deploymentId);
    const project = await ctx.db.get(grant.projectId);
    if (!deployment || !project || deployment.status === "failed" || deployment.status === "staging") return null;
    return { grant, deployment, project };
  },
});

export const listInternal = internalQuery({
  args: { organizationId: v.string(), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const grants = await ctx.db
      .query("shareGrants")
      .withIndex("by_organization", (query) => query.eq("organizationId", args.organizationId))
      .order("desc")
      .take(200);
    return grants.filter((grant) => grant.projectId === args.projectId);
  },
});

export const revokeInternal = internalMutation({
  args: {
    organizationId: v.string(),
    grantId: v.id("shareGrants"),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (!grant || grant.organizationId !== args.organizationId) throw new ConvexError("Share not found");
    if (!grant.revokedAt) await ctx.db.patch(grant._id, { revokedAt: Date.now() });
    await ctx.db.insert("auditEvents", {
      organizationId: args.organizationId,
      actorId: args.actorId,
      action: "share.revoked",
      resourceType: "shareGrant",
      resourceId: grant._id,
      metadata: { projectId: grant.projectId },
      createdAt: Date.now(),
    });
    return true;
  },
});
