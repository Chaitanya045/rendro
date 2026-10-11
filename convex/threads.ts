import { requireId } from "./ids";
import { query, mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { anchorValidator } from "./schema";
import { requireIdentity, orgSlugFromEmail, requireOrgIdentity } from "./security";

// List all threads for a file with their replies attached (flat).
export const list = query({
  args: { orgSlug: v.string(), filePath: v.string() },
  handler: async (ctx, { orgSlug, filePath }) => {
    await requireOrgIdentity(ctx, orgSlug);
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_org_file", (q) =>
        q.eq("orgSlug", orgSlug).eq("filePath", filePath),
      )
      .order("asc")
      .collect();

    return Promise.all(
      threads.map(async (t) => ({
        ...t,
        replies: await ctx.db
          .query("replies")
          .withIndex("by_thread", (q) => q.eq("threadId", t._id))
          .order("asc")
          .collect(),
      })),
    );
  },
});

// Create a root comment. Author identity comes only from the signed Convex
// authentication token; client-provided author fields are never accepted.
export const create = mutation({
  args: {
    orgSlug: v.string(),
    filePath: v.string(),
    body: v.string(),
    anchor: anchorValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireOrgIdentity(ctx, args.orgSlug);
    return await ctx.db.insert("threads", {
      ...args,
      authorEmail: identity.email,
      authorName: identity.name,
      resolved: false,
      archived: false,
    });
  },
});

// Toggle resolved/unresolved.
export const resolve = mutation({
  args: { threadId: v.string() },
  handler: async (ctx, input) => {
    const identity = await requireIdentity(ctx);
    const threadId = requireId(ctx, "threads", input.threadId);
    const t = await ctx.db.get(threadId);
    if (!t || orgSlugFromEmail(identity.email) !== t.orgSlug) throw new ConvexError("Comment not found");
    await ctx.db.patch(threadId, { resolved: !t.resolved });
  },
});

// Toggle archived/unarchived. Archived threads are filtered client-side.
export const archive = mutation({
  args: { threadId: v.string() },
  handler: async (ctx, input) => {
    const identity = await requireIdentity(ctx);
    const threadId = requireId(ctx, "threads", input.threadId);
    const t = await ctx.db.get(threadId);
    if (!t || orgSlugFromEmail(identity.email) !== t.orgSlug) throw new ConvexError("Comment not found");
    await ctx.db.patch(threadId, { archived: !(t.archived ?? false) });
  },
});

// Delete a thread and all its replies.
export const remove = mutation({
  args: { threadId: v.string() },
  handler: async (ctx, input) => {
    const identity = await requireIdentity(ctx);
    const threadId = requireId(ctx, "threads", input.threadId);
    const thread = await ctx.db.get(threadId);
    if (!thread || orgSlugFromEmail(identity.email) !== thread.orgSlug) throw new ConvexError("Comment not found");
    const replies = await ctx.db
      .query("replies")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    await Promise.all(replies.map((r) => ctx.db.delete(r._id)));
    await ctx.db.delete(threadId);
  },
});
