import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function cleanPath(value: string, allowEmpty: boolean): string {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path) {
    if (allowEmpty) return "";
    throw new ConvexError("Invalid publication path");
  }
  if (path.includes("\\") || path.split("/").some((part) => part === "." || part === "..")) {
    throw new ConvexError("Invalid publication path");
  }
  return path;
}

export const createInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    slug: v.string(),
    pathPrefix: v.string(),
    entryFile: v.string(),
    trackingMode: v.union(v.literal("track_active"), v.literal("pinned")),
    pinnedDeploymentId: v.optional(v.id("deployments")),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    const slug = args.slug.trim().toLowerCase();
    if (!slugPattern.test(slug) || slug.length > 80) throw new ConvexError("Invalid publication slug");
    if (await ctx.db.query("publications").withIndex("by_slug", (query) => query.eq("slug", slug)).unique()) {
      throw new ConvexError("Publication slug is already in use");
    }
    const pathPrefix = cleanPath(args.pathPrefix, true);
    const entryFile = cleanPath(args.entryFile, false);
    if (args.trackingMode === "pinned") {
      if (!args.pinnedDeploymentId) throw new ConvexError("Pinned publication requires a deployment");
      const pinned = await ctx.db.get(args.pinnedDeploymentId);
      if (!pinned || pinned.projectId !== project._id || pinned.status === "failed") {
        throw new ConvexError("Pinned deployment not found");
      }
    }
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      slug,
      pathPrefix,
      entryFile,
      trackingMode: args.trackingMode,
      pinnedDeploymentId: args.pinnedDeploymentId,
      title: args.title?.trim() || project.name,
      description: args.description?.trim() || undefined,
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
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const projectId = args.projectId;
    if (projectId) {
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
    if (!publication) return null;
    const project = await ctx.db.get(publication.projectId);
    if (!project) return null;
    const deploymentId = publication.trackingMode === "pinned"
      ? publication.pinnedDeploymentId
      : project.activeDeploymentId;
    if (!deploymentId) return null;
    const deployment = await ctx.db.get(deploymentId);
    if (!deployment || deployment.status === "failed" || deployment.status === "staging") return null;
    return { publication, project, deployment };
  },
});

export const removeInternal = internalMutation({
  args: {
    organizationId: v.string(),
    publicationId: v.id("publications"),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    const publication = await ctx.db.get(args.publicationId);
    if (!publication || publication.organizationId !== args.organizationId) {
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
