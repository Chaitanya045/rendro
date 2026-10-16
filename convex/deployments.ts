import { validDeploymentCounts } from "../shared/deployment-limits";
import { verifyStorageValidation } from "../shared/storage-attestation";
import { isOrganizationDeleted, requireActiveOrganization } from "./organizationLifecycle";
import { sanitizeProvenance } from "../shared/provenance";
import { requireId } from "./ids";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { STAGING_LEASE_MS, stagingExpiry } from "./retentionPolicy";
import { provenanceValidator } from "./schema";

export const startInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    manifestSha256: v.string(),
    fileCount: v.number(),
    byteCount: v.number(),
    provenance: provenanceValidator,
    actorId: v.string(),
  },
  handler: async (ctx, input) => {
    await requireActiveOrganization(ctx, input.organizationId);
    const args = {
      ...input,
      projectId: requireId(ctx, "projects", input.projectId),
    };
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    if (!validDeploymentCounts(args.fileCount, args.byteCount)) {
      throw new ConvexError("Deployment counts must be safe non-negative integers within 1,000 files and 128 MiB");
    }
    if (args.manifestSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(args.manifestSha256)) throw new ConvexError("manifestSha256 must be 64 lowercase hexadecimal characters");
    // Match the provenance display/storage caps from #123, rejecting oversized
    // inputs before sanitation. All storage keys are derived from bounded IDs.
    const strings: [string | undefined, number][] = [
      [args.organizationId, 256], [input.projectId, 256], [args.actorId, 256],
      [args.provenance.source.repository, 2048], [args.provenance.source.commit, 128],
      [args.provenance.source.ref, 256], [args.provenance.source.localPathLabel, 512],
      [args.provenance.execution.provider, 256], [args.provenance.execution.runId, 256],
      [args.provenance.execution.workflow, 256], [args.provenance.execution.job, 256],
      [args.provenance.execution.actor, 256], [args.provenance.cliVersion, 64],
      [args.provenance.manifestSha256, 128],
    ];
    if (strings.some(([value, cap]) => value !== undefined && value.length > cap)) {
      throw new ConvexError("Deployment string exceeds its length limit");
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
      provenance: sanitizeProvenance(args.provenance),
      createdBy: args.actorId,
      createdAt,
      stagingExpiresAt: createdAt + STAGING_LEASE_MS,
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
      stagingExpiresAt: createdAt + STAGING_LEASE_MS,
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
    projectId: v.string(),
    deploymentId: v.string(),
  },
  handler: async (ctx, input) => {
    if (await isOrganizationDeleted(ctx, input.organizationId)) return null;
    const args = {
      ...input,
      projectId: requireId(ctx, "projects", input.projectId),
      deploymentId: requireId(ctx, "deployments", input.deploymentId),
    };
    const deployment = await ctx.db.get(args.deploymentId);
    if (
      !deployment
      || deployment.organizationId !== args.organizationId
      || deployment.projectId !== args.projectId
    ) return null;
    return { ...deployment, provenance: sanitizeProvenance(deployment.provenance) };
  },
});

export const listInternal = internalQuery({
  args: { organizationId: v.string(), projectId: v.string() },
  handler: async (ctx, input) => {
    await requireActiveOrganization(ctx, input.organizationId);
    const args = {
      ...input,
      projectId: requireId(ctx, "projects", input.projectId),
    };
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    const deployments = await ctx.db
      .query("deployments")
      .withIndex("by_project_created", (query) => query.eq("projectId", args.projectId))
      .order("desc")
      .take(100);
    return deployments.map(deployment => ({ ...deployment, provenance: sanitizeProvenance(deployment.provenance) }));
  },
});

export const latestForOrganization = internalQuery({
  args: { organizationId: v.string() },
  handler: async (ctx, { organizationId }) => {
    if (await isOrganizationDeleted(ctx, organizationId)) return null;
    const latest = await ctx.db.query("deployments")
      .withIndex("by_organization_activated", (q) => q.eq("organizationId", organizationId).gt("activatedAt", 0))
      .order("desc").first();
    if (!latest) return null;
    const project = await ctx.db.get(latest.projectId);
    if (!project || project.organizationId !== organizationId) return null;
    return { projectId: latest.projectId, projectName: project.name, status: latest.status, activatedAt: latest.activatedAt, commit: sanitizeProvenance(latest.provenance).source.commit };
  },
});

export const commitInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    deploymentId: v.string(),
    actorId: v.string(),
    attestation: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    await requireActiveOrganization(ctx, input.organizationId);
    const args = {
      ...input,
      projectId: requireId(ctx, "projects", input.projectId),
      deploymentId: requireId(ctx, "deployments", input.deploymentId),
    };
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
    if (stagingExpiry(deployment) <= Date.now()) throw new ConvexError({ code: "conflict", message: "Staging lease expired. Run rendro push again to start a new deployment." });
    if (project.activeDeploymentId !== deployment.previousDeploymentId) {
      throw new ConvexError("Active deployment changed; rebase and retry");
    }
    if (!await verifyStorageValidation({
      purpose: "deployment-commit", ...deployment, deploymentId: deployment._id,
    }, args.attestation, process.env.CONVEX_INTERNAL_SECRET)) {
      throw new ConvexError("Worker storage validation is required");
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
    organizationId: v.string(),
    projectId: v.string(),
    deploymentId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, input) => {
    await requireActiveOrganization(ctx, input.organizationId);
    const args = {
      ...input,
      projectId: requireId(ctx, "projects", input.projectId),
      deploymentId: requireId(ctx, "deployments", input.deploymentId),
    };
    const deployment = await ctx.db.get(args.deploymentId);
    if (
      !deployment
      || deployment.organizationId !== args.organizationId
      || deployment.projectId !== args.projectId
      || deployment.status !== "staging"
    ) return false;
    await ctx.db.patch(deployment._id, {
      status: "failed",
      failureReason: args.reason.slice(0, 500),
    });
    return true;
  },
});

// Upload/copy authorization renews the lease in the same transaction that reads
// staging state. Expired leases cannot be resurrected, even before the janitor runs.
export const refreshStagingInternal = internalMutation({
  args: { organizationId: v.string(), projectId: v.string(), deploymentId: v.string() },
  handler: async (ctx, input) => {
    await requireActiveOrganization(ctx, input.organizationId);
    const projectId = requireId(ctx, "projects", input.projectId);
    const deployment = await ctx.db.get(requireId(ctx, "deployments", input.deploymentId));
    if (!deployment || deployment.organizationId !== input.organizationId || deployment.projectId !== projectId
      || deployment.status !== "staging") return null;
    if (stagingExpiry(deployment) <= Date.now()) throw new ConvexError({ code: "conflict", message: "Staging lease expired. Run rendro push again to start a new deployment." });
    const staging = {
      manifestKey: deployment.manifestKey,
      treeIndexKey: deployment.treeIndexKey,
      previousDeploymentId: deployment.previousDeploymentId,
    };
    if (stagingExpiry(deployment) > Date.now() + STAGING_LEASE_MS - 10 * 60 * 1000) {
      return { ...staging, stagingExpiresAt: stagingExpiry(deployment) };
    }
    const stagingExpiresAt = Date.now() + STAGING_LEASE_MS;
    await ctx.db.patch(deployment._id, { stagingExpiresAt });
    return { ...staging, stagingExpiresAt };
  },
});
