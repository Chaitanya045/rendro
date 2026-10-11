import { v } from "convex/values";
import { mutation } from "./_generated/server";

// Uses the existing component rateLimit table and its cleanup. A single Convex
// transaction makes concurrent requests share one atomic check/increment.
export const consume = mutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const now = Date.now();
    const row = await ctx.db.query("rateLimit").withIndex("key", q => q.eq("key", key)).unique();
    if (!row) {
      await ctx.db.insert("rateLimit", { key, count: 1, lastRequest: now });
    } else if (now - row.lastRequest >= 60_000) {
      await ctx.db.patch(row._id, { count: 1, lastRequest: now });
    } else if (row.count >= 120) {
      return Math.max(1, Math.ceil((60_000 - (now - row.lastRequest)) / 1_000));
    } else {
      await ctx.db.patch(row._id, { count: row.count + 1 });
    }
    return 0;
  },
});
