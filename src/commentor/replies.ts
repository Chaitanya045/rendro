import { mutation } from "./_generated/server";
import { v } from "convex/values";

// Add a flat reply to a thread.
export const add = mutation({
  args: {
    threadId: v.id("threads"),
    authorEmail: v.string(),
    authorName: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("replies", args);
  },
});
