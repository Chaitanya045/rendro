import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const candidatesInternal = internalQuery({
  args: {
    failedBefore: v.number(),
    supersededBefore: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const deployments = await ctx.db.query("deployments").order("asc").take(2_000);
    const candidates = [];
    for (const deployment of deployments) {
      if (candidates.length >= Math.min(args.limit, 100)) break;
      if (deployment.purgedAt || deployment.status === "active" || deployment.status === "staging") continue;
      if (deployment.status === "failed" && deployment.createdAt > args.failedBefore) continue;
      if (deployment.status === "superseded" && deployment.createdAt > args.supersededBefore) continue;
      const publications = await ctx.db
        .query("publications")
        .withIndex("by_project", (query) => query.eq("projectId", deployment.projectId))
        .collect();
      if (publications.some((publication) => publication.pinnedDeploymentId === deployment._id)) continue;
      const grants = await ctx.db
        .query("shareGrants")
        .withIndex("by_organization", (query) => query.eq("organizationId", deployment.organizationId))
        .collect();
      if (grants.some((grant) => grant.deploymentId === deployment._id && !grant.revokedAt && grant.expiresAt > Date.now())) continue;
      candidates.push(deployment);
    }
    return candidates;
  },
});

export const markPurgedInternal = internalMutation({
  args: { deploymentId: v.id("deployments"), objectCount: v.number() },
  handler: async (ctx, args) => {
    const deployment = await ctx.db.get(args.deploymentId);
    if (!deployment || deployment.status === "active" || deployment.status === "staging") return false;
    const now = Date.now();
    await ctx.db.patch(deployment._id, { purgedAt: now });
    await ctx.db.insert("auditEvents", {
      organizationId: deployment.organizationId,
      actorId: "retention-job",
      action: "deployment.purged",
      resourceType: "deployment",
      resourceId: deployment._id,
      metadata: { projectId: deployment.projectId, objectCount: args.objectCount },
      createdAt: now,
    });
    return true;
  },
});
