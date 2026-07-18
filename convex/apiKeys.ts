import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: { orgSlug: v.string(), keyHash: v.string() },
  handler: async (ctx, args) => {
    // Delete existing key
    const existing = await ctx.db.query("api_keys").withIndex("by_hash", q => q.eq("keyHash", args.keyHash)).first();
    if (existing) await ctx.db.delete(existing._id);
    // Also delete any old key for this org
    const oldKeys = await ctx.db.query("api_keys").filter(q => q.eq(q.field("orgSlug"), args.orgSlug)).collect();
    for (const k of oldKeys) await ctx.db.delete(k._id);
    // Insert new
    await ctx.db.insert("api_keys", { orgSlug: args.orgSlug, keyHash: args.keyHash, createdAt: new Date().toISOString() });
  },
});

export const validate = query({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("api_keys").withIndex("by_hash", q => q.eq("keyHash", args.keyHash)).first();
    return row?.orgSlug ?? null;
  },
});
