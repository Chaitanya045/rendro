import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { provenanceValidator } from "./schema";

export const startInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    manifestSha256: v.string(),
    fileCount: v.number(),
    byteCount: v.number(),
    provenance: provenanceValidator,
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    if (args.fileCount < 0 || args.byteCount < 0) {
      throw new ConvexError("Deployment counts must be non-negative");
    }
    const createdAt = Date.now();
    const deploymentId = await ctx.db.insert("deployments", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      status: "staging",
      manifestKey: "pending",
      manifestSha256: args.manifestSha256,
      fileCount: args.fileCount,
      byteCount: args.byteCount,
      provenance: args.provenance,
      createdBy: args.actorId,
      createdAt,
      previousDeploymentId: project.activeDeploymentId,
    });
    const objectRoot = `tenants/${args.organizationId}/projects/${args.projectId}/deployments/${deploymentId}`;
    const manifestKey = `${objectRoot}/manifest.json`;
    const treeIndexKey = `${objectRoot}/tree-index.json`;
    await ctx.db.patch(deploymentId, { manifestKey, treeIndexKey });
    await ctx.db.insert("auditEvents", {
      organizationId: args.organizationId,
      actorId: args.actorId,
      action: "deployment.started",
      resourceType: "deployment",
      resourceId: deploymentId,
      metadata: { projectId: args.projectId, manifestSha256: args.manifestSha256 },
      createdAt,
    });
    return {
      deploymentId,
      objectRoot,
      manifestKey,
      treeIndexKey,
      previousDeploymentId: project.activeDeploymentId,
    };
  },
});

export const getInternal = internalQuery({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    deploymentId: v.id("deployments"),
  },
  handler: async (ctx, args) => {
    const deployment = await ctx.db.get(args.deploymentId);
    if (
      !deployment
      || deployment.organizationId !== args.organizationId
      || deployment.projectId !== args.projectId
    ) return null;
    return deployment;
  },
});

export const listInternal = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("deployments")
      .withIndex("by_project_created", (query) => query.eq("projectId", args.projectId))
      .order("desc")
      .take(100);
  },
});

export const commitInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    deploymentId: v.id("deployments"),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    const deployment = await ctx.db.get(args.deploymentId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    if (
      !deployment
      || deployment.organizationId !== args.organizationId
      || deployment.projectId !== args.projectId
    ) throw new ConvexError("Deployment not found");
    if (deployment.status !== "staging") {
      throw new ConvexError("Only a staging deployment can be committed");
    }
    if (project.activeDeploymentId !== deployment.previousDeploymentId) {
      throw new ConvexError("Active deployment changed; rebase and retry");
    }
    const activatedAt = Date.now();
    if (project.activeDeploymentId) {
      const previous = await ctx.db.get(project.activeDeploymentId);
      if (previous?.status === "active") {
        await ctx.db.patch(previous._id, { status: "superseded" });
      }
    }
    await ctx.db.patch(deployment._id, { status: "active", activatedAt });
    await ctx.db.patch(project._id, { activeDeploymentId: deployment._id });
    await ctx.db.insert("auditEvents", {
      organizationId: args.organizationId,
      actorId: args.actorId,
      action: "deployment.activated",
      resourceType: "deployment",
      resourceId: deployment._id,
      metadata: { projectId: project._id, previousDeploymentId: deployment.previousDeploymentId },
      createdAt: activatedAt,
    });
    return { deploymentId: deployment._id, activatedAt };
  },
});

export const failInternal = internalMutation({
  args: {
    deploymentId: v.id("deployments"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const deployment = await ctx.db.get(args.deploymentId);
    if (!deployment || deployment.status !== "staging") return false;
    await ctx.db.patch(deployment._id, {
      status: "failed",
      failureReason: args.reason.slice(0, 500),
    });
    return true;
  },
});
