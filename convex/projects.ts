import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const listInternal = internalQuery({
  args: { organizationId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("projects")
      .withIndex("by_organization", (query) => query.eq("organizationId", args.organizationId))
      .order("desc")
      .collect();
  },
});

export const getInternal = internalQuery({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) return null;
    return project;
  },
});

export const createInternal = internalMutation({
  args: {
    organizationId: v.string(),
    name: v.string(),
    slug: v.string(),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const slug = args.slug.trim().toLowerCase();
    if (!name || name.length > 80) throw new ConvexError("Project name must be 1–80 characters");
    if (!slugPattern.test(slug) || slug.length > 48) {
      throw new ConvexError("Project slug must contain lowercase letters, numbers, and hyphens");
    }
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_organization_slug", (query) =>
        query.eq("organizationId", args.organizationId).eq("slug", slug))
      .unique();
    if (existing) throw new ConvexError("A project with this slug already exists");
    const createdAt = Date.now();
    const projectId = await ctx.db.insert("projects", {
      organizationId: args.organizationId,
      name,
      slug,
      createdBy: args.actorId,
      createdAt,
    });
    await ctx.db.insert("auditEvents", {
      organizationId: args.organizationId,
      actorId: args.actorId,
      action: "project.created",
      resourceType: "project",
      resourceId: projectId,
      metadata: { name, slug },
      createdAt,
    });
    return await ctx.db.get(projectId);
  },
});
