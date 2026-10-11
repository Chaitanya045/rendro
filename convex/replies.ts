import { requireId } from "./ids";
import { mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { authorizeLegacyThread, legacyOperationArgs, legacyBody, requireLegacyCommentAuthor } from "./legacyComments";

export const add = mutation({
  args: { ...legacyOperationArgs, threadId: v.string(), body: v.string() },
  handler: async (ctx, input) => {
    const { thread, identity } = await authorizeLegacyThread(ctx, input);
    const threadId = thread._id;
    const body = legacyBody(input.body);
    if (input.clientOperationId) {
      const previous = await ctx.db.query("replies").withIndex("by_operation", q => q.eq("threadId", threadId).eq("authorId", identity.subject).eq("clientOperationId", input.clientOperationId)).unique();
      if (previous) return previous._id;
    }
    if (thread.deletedAt !== undefined) throw new ConvexError("Comment not found");
    return ctx.db.insert("replies", { threadId, body, authorId: identity.subject, clientOperationId: input.clientOperationId, authorEmail: identity.email, authorName: identity.name });
  },
});
export const remove = mutation({
  args: { ...legacyOperationArgs, threadId: v.string(), replyId: v.string() },
  handler: async (ctx, input) => {
    const { thread, identity } = await authorizeLegacyThread(ctx, input);
    const threadId = thread._id;
    const reply = await ctx.db.get(requireId(ctx, "replies", input.replyId));
    if (!reply || reply.threadId !== threadId) throw new ConvexError("Comment not found");
    requireLegacyCommentAuthor(identity, reply);
    if (reply.deletedAt === undefined) await ctx.db.patch(reply._id, { body: "", deletedAt: Date.now() });
  },
});
