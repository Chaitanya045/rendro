import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireOrgIdentity } from "./security";

// Add a flat reply to a thread.
export const add = mutation({
  args: {
    threadId: v.id("threads"),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new Error("thread not found");
    const identity = await requireOrgIdentity(ctx, thread.orgSlug);
    return await ctx.db.insert("replies", {
      ...args,
      authorEmail: identity.email,
      authorName: identity.name,
    });
  },
});
