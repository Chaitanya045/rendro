import { v } from "convex/values";
import { mutation } from "./_generated/server";

// Reuse the component rateLimit table. Each bucket is checked/incremented in
// one atomic transaction. lastRequest is the WINDOW START, never the last hit:
// accepted and rejected traffic cannot postpone replenishment.
export const consume = mutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const now = Date.now();
    // 6,000/minute supports 50 sessions at their full 120/minute allowance.
    const max = key.startsWith("session-read-ip:") ? 6_000 : 120;
    const row = await ctx.db.query("rateLimit").withIndex("key", q => q.eq("key", key)).unique();
    if (!row) {
      await ctx.db.insert("rateLimit", { key, count: 1, lastRequest: now });
    } else if (now - row.lastRequest >= 60_000) {
      await ctx.db.patch(row._id, { count: 1, lastRequest: now });
    } else if (row.count >= max) {
      return Math.max(1, Math.ceil((60_000 - (now - row.lastRequest)) / 1_000));
    } else {
      await ctx.db.patch(row._id, { count: row.count + 1 });
    }
    return 0;
  },
});
