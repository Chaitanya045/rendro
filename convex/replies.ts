import { requireId } from "./ids";
import { mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireIdentity, orgSlugFromEmail } from "./security";

// Add a flat reply to a thread.
export const add = mutation({
  args: {
    threadId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, input) => {
    const identity = await requireIdentity(ctx);
    const args = {
      ...input,
      threadId: requireId(ctx, "threads", input.threadId),
    };
    const thread = await ctx.db.get(args.threadId);
    if (!thread || orgSlugFromEmail(identity.email) !== thread.orgSlug) throw new ConvexError("Comment not found");
    return await ctx.db.insert("replies", {
      ...args,
      authorEmail: identity.email,
      authorName: identity.name,
    });
  },
});
