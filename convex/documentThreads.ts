import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authComponent } from "./auth";
import { requireOrganizationMember } from "./authorization";
import { anchorValidator } from "./schema";

function validDocumentPath(value: string): boolean {
  return Boolean(value)
    && !value.includes("\\")
    && value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

export const list = query({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    documentPath: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOrganizationMember(ctx, args.organizationId);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    const threads = await ctx.db
      .query("documentThreads")
      .withIndex("by_document", (index) => index
        .eq("organizationId", args.organizationId)
        .eq("projectId", args.projectId)
        .eq("documentPath", args.documentPath))
      .order("asc")
      .collect();

    return Promise.all(threads.map(async (thread) => {
      const [author, replies] = await Promise.all([
        authComponent.getAnyUserById(ctx, thread.authorId),
        ctx.db
          .query("documentReplies")
          .withIndex("by_thread", (index) => index.eq("threadId", thread._id))
          .order("asc")
          .collect(),
      ]);
      const enrichedReplies = await Promise.all(replies.map(async (reply) => {
        const replyAuthor = await authComponent.getAnyUserById(ctx, reply.authorId);
        return {
          ...reply,
          authorEmail: replyAuthor?.email ?? "",
          authorName: replyAuthor?.name?.trim() || replyAuthor?.email || "Former member",
        };
      }));
      return {
        ...thread,
        authorEmail: author?.email ?? "",
        authorName: author?.name?.trim() || author?.email || "Former member",
        replies: enrichedReplies,
      };
    }));
  },
});

export const create = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    documentPath: v.string(),
    body: v.string(),
    anchor: anchorValidator,
  },
  handler: async (ctx, args) => {
    const authorized = await requireOrganizationMember(ctx, args.organizationId);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    const body = args.body.trim();
    if (!body || body.length > 10_000) throw new ConvexError("Comment body is invalid");
    if (!validDocumentPath(args.documentPath)) throw new ConvexError("Document path is invalid");
    const now = Date.now();
    return ctx.db.insert("documentThreads", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      documentPath: args.documentPath,
      deploymentId: project.activeDeploymentId,
      authorId: authorized.user._id,
      body,
      anchor: args.anchor,
      resolved: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const resolve = mutation({
  args: { threadId: v.id("documentThreads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new ConvexError("Comment not found");
    await requireOrganizationMember(ctx, thread.organizationId);
    await ctx.db.patch(threadId, { resolved: !thread.resolved, updatedAt: Date.now() });
  },
});

export const archive = mutation({
  args: { threadId: v.id("documentThreads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new ConvexError("Comment not found");
    await requireOrganizationMember(ctx, thread.organizationId);
    await ctx.db.patch(threadId, { archived: !thread.archived, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { threadId: v.id("documentThreads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new ConvexError("Comment not found");
    await requireOrganizationMember(ctx, thread.organizationId);
    const replies = await ctx.db
      .query("documentReplies")
      .withIndex("by_thread", (index) => index.eq("threadId", threadId))
      .collect();
    await Promise.all(replies.map((reply) => ctx.db.delete(reply._id)));
    await ctx.db.delete(threadId);
  },
});
