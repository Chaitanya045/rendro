import { requireId } from "./ids";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireOrgIdentity } from "./security";

// Add a flat reply to a thread.
export const add = mutation({
  args: {
    threadId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, input) => {
    const args = {
      ...input,
      threadId: requireId(ctx, "threads", input.threadId),
    };
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
