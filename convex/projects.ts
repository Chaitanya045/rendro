import { isOrganizationDeleted, requireActiveOrganization } from "./organizationLifecycle";
import { isPublicErrorData } from "../src/shared/public-errors";
import { requireId } from "./ids";
import { requireOrganizationMember } from "./authorization";
import { query } from "./publicFunctions";
import { publicError } from "./publicErrors";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const listInternal = internalQuery({
  args: { organizationId: v.string() },
  handler: async (ctx, args) => {
    await requireActiveOrganization(ctx, args.organizationId);
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
    projectId: v.string(),
  },
  handler: async (ctx, input) => {
    if (await isOrganizationDeleted(ctx, input.organizationId)) return null;
    const args = {
      ...input,
      projectId: ctx.db.normalizeId("projects", input.projectId),
    };
    if (!args.projectId) return null;
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
    await requireActiveOrganization(ctx, args.organizationId);
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

/** Small reactive signal for an authorized, already-open private viewer. */
export const activeDeployment = query({
  args: { organizationId: v.string(), projectId: v.string() },
  handler: async (ctx, args) => {
    try {
      await requireOrganizationMember(ctx, args.organizationId);
    } catch (error) {
      // This background signal has no sign-in UX: hide all access denials alike.
      if (error instanceof ConvexError && isPublicErrorData(error.data)
        && ["unauthenticated", "forbidden", "not_found"].includes(error.data.code)) publicError("not_found");
      throw error;
    }
    const projectId = requireId(ctx, "projects", args.projectId);
    const project = await ctx.db.get(projectId);
    if (!project || project.organizationId !== args.organizationId) publicError("not_found");
    if (!project.activeDeploymentId) return null;
    const deployment = await ctx.db.get(project.activeDeploymentId);
    if (!deployment || deployment.organizationId !== args.organizationId
      || deployment.projectId !== project._id || deployment.status !== "active") return null;
    return deployment._id;
  },
});
