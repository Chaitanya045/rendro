import { isDeploymentPurging } from "./retentionPolicy";
import { verifyStorageValidation } from "../shared/storage-attestation";
import { isOrganizationDeleted, requireActiveOrganization } from "./organizationLifecycle";
import type { WorkerPublication } from "../shared/resolver-dto";
import { requireId } from "./ids";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { cleanPublicationPath } from "../shared/v2-paths";
import { PUBLICATION_DESCRIPTION_MAX_LENGTH, PUBLICATION_TITLE_MAX_LENGTH } from "../shared/text-input";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    slug: v.string(),
    pathPrefix: v.string(),
    entryFile: v.string(),
    trackingMode: v.union(v.literal("track_active"), v.literal("pinned")),
    pinnedDeploymentId: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    actorId: v.string(),
    attestation: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    await requireActiveOrganization(ctx, input.organizationId);
    // The publication form limits these; the API must too.
    const title = input.title?.trim();
    const description = input.description?.trim();
    if (title && title.length > PUBLICATION_TITLE_MAX_LENGTH) {
      throw new ConvexError(`Publication title must be at most ${PUBLICATION_TITLE_MAX_LENGTH} characters`);
    }
    if (description && description.length > PUBLICATION_DESCRIPTION_MAX_LENGTH) {
      throw new ConvexError(`Publication description must be at most ${PUBLICATION_DESCRIPTION_MAX_LENGTH} characters`);
    }
    const args = {
      ...input,
      projectId: requireId(ctx, "projects", input.projectId),
      pinnedDeploymentId: input.pinnedDeploymentId === undefined ? undefined : requireId(ctx, "deployments", input.pinnedDeploymentId),
    };
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    const slug = args.slug.trim().toLowerCase();
    if (!slugPattern.test(slug) || slug.length > 80) throw new ConvexError("Invalid publication slug");
    if (await ctx.db.query("publications").withIndex("by_slug", (query) => query.eq("slug", slug)).unique()) {
      throw new ConvexError("Publication slug is already in use");
    }
    const pathPrefix = cleanPublicationPath(args.pathPrefix, true);
    const entryFile = cleanPublicationPath(args.entryFile, false);
    if (pathPrefix === null || entryFile === null) throw new ConvexError("Invalid publication path");
    const deploymentId = args.trackingMode === "pinned" ? args.pinnedDeploymentId : project.activeDeploymentId;
    if (args.trackingMode === "pinned" && !deploymentId) throw new ConvexError("Pinned publication requires a deployment");
    const deployment = deploymentId ? await ctx.db.get(deploymentId) : null;
    if (
      !deployment
      || deployment.organizationId !== args.organizationId
      || deployment.projectId !== project._id
      || await isDeploymentPurging(ctx, deployment)
      || deployment.status === "failed"
      || deployment.status === "staging"
    ) throw new ConvexError("Publication deployment not found");
    // Resolve track_active inside this transaction: a concurrent commit must not
    // publish against a different manifest from the one the Worker inspected.
    if (!await verifyStorageValidation({
      purpose: "publication-entry", ...deployment, deploymentId: deployment._id,
      pathPrefix, entryFile, trackingMode: args.trackingMode,
    }, args.attestation, process.env.CONVEX_INTERNAL_SECRET)) {
      throw new ConvexError("Worker publication entry validation is required");
    }
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      slug,
      pathPrefix,
      entryFile,
      trackingMode: args.trackingMode,
      pinnedDeploymentId: args.trackingMode === "pinned" ? args.pinnedDeploymentId : undefined,
      title: title || project.name,
      description: description || undefined,
      createdBy: args.actorId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("auditEvents", {
      organizationId: args.organizationId,
      actorId: args.actorId,
      action: "publication.created",
      resourceType: "publication",
      resourceId: publicationId,
      metadata: { projectId: args.projectId, slug, trackingMode: args.trackingMode },
      createdAt: now,
    });
    return await ctx.db.get(publicationId);
  },
});

export const listInternal = internalQuery({
  args: {
    organizationId: v.string(),
    projectId: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    await requireActiveOrganization(ctx, input.organizationId);
    const args = {
      ...input,
      projectId: input.projectId === undefined ? undefined : requireId(ctx, "projects", input.projectId),
    };
    const projectId = args.projectId;
    if (projectId) {
      const project = await ctx.db.get(projectId);
      if (!project || project.organizationId !== args.organizationId) {
        throw new ConvexError("Project not found");
      }
      return ctx.db
        .query("publications")
        .withIndex("by_project", (query) => query.eq("projectId", projectId))
        .order("desc")
        .collect();
    }
    return ctx.db
      .query("publications")
      .withIndex("by_organization", (query) => query.eq("organizationId", args.organizationId))
      .order("desc")
      .collect();
  },
});

export const resolvePublicInternal = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const publication = await ctx.db
      .query("publications")
      .withIndex("by_slug", (query) => query.eq("slug", args.slug.toLowerCase()))
      .unique();
    if (!publication || await isOrganizationDeleted(ctx, publication.organizationId)) return null;
    const project = await ctx.db.get(publication.projectId);
    if (!project) return null;
    const deploymentId = publication.trackingMode === "pinned"
      ? publication.pinnedDeploymentId
      : project.activeDeploymentId;
    if (!deploymentId) return null;
    const deployment = await ctx.db.get(deploymentId);
    if (!deployment || await isDeploymentPurging(ctx, deployment) || deployment.status === "failed" || deployment.status === "staging") return null;
    return {
      publication: {
        slug: publication.slug,
        pathPrefix: publication.pathPrefix,
        entryFile: publication.entryFile,
        title: publication.title || project.name,
      },
      deployment: { manifestKey: deployment.manifestKey },
    } satisfies WorkerPublication;
  },
});

export const removeInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    publicationId: v.string(),
    actorId: v.string(),
  },
  handler: async (ctx, input) => {
    await requireActiveOrganization(ctx, input.organizationId);
    const args = {
      ...input,
      projectId: requireId(ctx, "projects", input.projectId),
      publicationId: requireId(ctx, "publications", input.publicationId),
    };
    const publication = await ctx.db.get(args.publicationId);
    if (
      !publication
      || publication.organizationId !== args.organizationId
      || publication.projectId !== args.projectId
    ) {
      throw new ConvexError("Publication not found");
    }
    await ctx.db.delete(publication._id);
    await ctx.db.insert("auditEvents", {
      organizationId: args.organizationId,
      actorId: args.actorId,
      action: "publication.removed",
      resourceType: "publication",
      resourceId: publication._id,
      metadata: { slug: publication.slug, projectId: publication.projectId },
      createdAt: Date.now(),
    });
    return true;
  },
});
