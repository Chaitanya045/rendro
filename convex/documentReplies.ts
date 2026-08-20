import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireOrganizationMember } from "./authorization";

export const add = mutation({
  args: {
    threadId: v.id("documentThreads"),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError("Comment not found");
    const authorized = await requireOrganizationMember(ctx, thread.organizationId);
    const body = args.body.trim();
    if (!body || body.length > 10_000) throw new ConvexError("Reply body is invalid");
    const now = Date.now();
    return ctx.db.insert("documentReplies", {
      threadId: args.threadId,
      organizationId: thread.organizationId,
      authorId: authorized.user._id,
      body,
      createdAt: now,
      updatedAt: now,
    });
  },
});
