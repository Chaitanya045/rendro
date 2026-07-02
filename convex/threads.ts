import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { anchorValidator } from "./schema";

// List all threads for a file with their replies attached (flat).
export const list = query({
  args: { orgSlug: v.string(), filePath: v.string() },
  handler: async (ctx, { orgSlug, filePath }) => {
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

// Create a root comment. Author is supplied by the client under the
// trusted-org model (one shared org per slug). Real auth plugs in here.
export const create = mutation({
  args: {
    orgSlug: v.string(),
    filePath: v.string(),
    authorEmail: v.string(),
    authorName: v.string(),
    body: v.string(),
    anchor: anchorValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("threads", {
      ...args,
      resolved: false,
      archived: false,
    });
  },
});

// Toggle resolved/unresolved.
export const resolve = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const t = await ctx.db.get(threadId);
    if (!t) throw new Error("thread not found");
    await ctx.db.patch(threadId, { resolved: !t.resolved });
  },
});

// Toggle archived/unarchived. Archived threads are filtered client-side.
export const archive = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const t = await ctx.db.get(threadId);
    if (!t) throw new Error("thread not found");
    await ctx.db.patch(threadId, { archived: !(t.archived ?? false) });
  },
});

// Delete a thread and all its replies.
export const remove = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const replies = await ctx.db
      .query("replies")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    await Promise.all(replies.map((r) => ctx.db.delete(r._id)));
    await ctx.db.delete(threadId);
  },
});
