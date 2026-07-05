import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const mark = mutation({
  args: { orgSlug: v.string(), fileKey: v.string() },
  handler: async (ctx, args) => {
    // Delete any existing entry for this key
    const existing = await ctx.db.query("deleted_files").withIndex("by_key", q => q.eq("fileKey", args.fileKey)).first();
    if (existing) await ctx.db.delete(existing._id);
    // Insert new
    await ctx.db.insert("deleted_files", { orgSlug: args.orgSlug, fileKey: args.fileKey, deletedAt: new Date().toISOString() });
  },
});

export const isDeleted = query({
  args: { fileKey: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("deleted_files").withIndex("by_key", q => q.eq("fileKey", args.fileKey)).first();
    return row !== null;
  },
});

export const unmark = mutation({
  args: { fileKey: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("deleted_files").withIndex("by_key", q => q.eq("fileKey", args.fileKey)).first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const filterFn = query({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.keys.length === 0) return [];
    const deleted = new Set<string>();
    for (const key of args.keys) {
      const row = await ctx.db.query("deleted_files").withIndex("by_key", q => q.eq("fileKey", key)).first();
      if (row) deleted.add(key);
    }
    return args.keys.filter(k => !deleted.has(k));
  },
});
