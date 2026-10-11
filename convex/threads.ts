import { internalMutation, type MutationCtx } from "./_generated/server";
import { query, mutation } from "./publicFunctions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { anchorValidator } from "./schema";
import { validAnchor } from "../src/commentor/mutation-args";
import { authorizeLegacyComment, canModifyLegacyComment, requireLegacyCommentAuthor, legacyOperationArgs, authorizeLegacyThread, legacyBody } from "./legacyComments";

// Retain the v1 complete thread/reply list and original file keys.
export const list = query({
  args: { orgSlug: v.string(), filePath: v.string() },
  handler: async (ctx, { orgSlug, filePath }) => {
    const identity = await authorizeLegacyComment(ctx, orgSlug);
    const threads = await ctx.db.query("threads").withIndex("by_org_file", q => q.eq("orgSlug", orgSlug).eq("filePath", filePath)).order("asc").collect();
    return Promise.all(threads.filter(t => t.deletedAt === undefined).map(async t => ({
      ...t, canDelete: canModifyLegacyComment(identity, t),
      replies: (await ctx.db.query("replies").withIndex("by_thread", q => q.eq("threadId", t._id)).order("asc").collect())
        .filter(r => r.deletedAt === undefined).map(r => ({ ...r, canDelete: canModifyLegacyComment(identity, r) })),
    })));
  },
});

export const create = mutation({
  args: { ...legacyOperationArgs, orgSlug: v.string(), filePath: v.string(), body: v.string(), anchor: anchorValidator },
  handler: async (ctx, args) => {
    const identity = await authorizeLegacyComment(ctx, args.orgSlug, args);
    const body = legacyBody(args.body);
    if (!args.filePath || args.filePath.includes("\\") || args.filePath.split("/").some(part => !part || part === "." || part === "..")) throw new ConvexError("Document path is invalid");
    if (!validAnchor(args.anchor)) throw new ConvexError("Comment anchor is invalid");
    if (args.clientOperationId) {
      const previous = await ctx.db.query("threads").withIndex("by_operation", q => q.eq("orgSlug", args.orgSlug).eq("filePath", args.filePath).eq("authorId", identity.subject).eq("clientOperationId", args.clientOperationId)).unique();
      if (previous) return previous._id;
    }
    return ctx.db.insert("threads", {
      orgSlug: args.orgSlug, filePath: args.filePath, body, anchor: args.anchor,
      authorId: identity.subject, clientOperationId: args.clientOperationId,
      authorEmail: identity.email, authorName: identity.name, resolved: false, archived: false,
    });
  },
});

const statusArgs = { ...legacyOperationArgs, threadId: v.string() };
async function applyStatus(ctx: MutationCtx, thread: Doc<"threads">, authorId: string, field: "resolved" | "archived", target: boolean | undefined, operation?: string) {
  if (operation) {
    if (target === undefined) throw new ConvexError("An operation ID requires an explicit status target");
    const receipt = await ctx.db.query("legacyCommentStatusReceipts").withIndex("by_operation", q => q.eq("threadId", thread._id).eq("authorId", authorId).eq("clientOperationId", operation)).unique();
    if (receipt) {
      if (receipt.field !== field || receipt.target !== target) throw new ConvexError("Operation arguments changed");
      return receipt.target;
    }
    await ctx.db.insert("legacyCommentStatusReceipts", { threadId: thread._id, authorId, clientOperationId: operation, field, target, expiresAt: Date.now() + 30 * 24 * 60 * 60_000 });
  }
  const applied = target ?? !thread[field];
  await ctx.db.patch(thread._id, { [field]: applied });
  return applied;
}
export const resolve = mutation({
  args: { ...statusArgs, resolved: v.optional(v.boolean()) },
  handler: async (ctx, input) => {
    const { thread, identity } = await authorizeLegacyThread(ctx, input);
    if (thread.deletedAt !== undefined) throw new ConvexError("Comment not found");
    return applyStatus(ctx, thread, identity.subject, "resolved", input.resolved, input.clientOperationId);
  },
});
export const archive = mutation({
  args: { ...statusArgs, archived: v.optional(v.boolean()) },
  handler: async (ctx, input) => {
    const { thread, identity } = await authorizeLegacyThread(ctx, input);
    if (thread.deletedAt !== undefined) throw new ConvexError("Comment not found");
    requireLegacyCommentAuthor(identity, thread);
    return applyStatus(ctx, thread, identity.subject, "archived", input.archived, input.clientOperationId);
  },
});
export const remove = mutation({
  args: statusArgs,
  handler: async (ctx, input) => {
    const { thread, identity } = await authorizeLegacyThread(ctx, input);
    const threadId = thread._id;
    requireLegacyCommentAuthor(identity, thread);
    if (thread.deletedAt !== undefined) return;
    const replies = await ctx.db.query("replies").withIndex("by_thread", q => q.eq("threadId", threadId)).collect();
    await Promise.all(replies.map(r => ctx.db.patch(r._id, { body: "", deletedAt: Date.now() })));
    // Keep identity-only tombstones so a delayed retry cannot resurrect a write.
    await ctx.db.patch(threadId, { body: "", anchor: { kind: "element", path: [] }, deletedAt: Date.now() });
  },
});
export const cleanupStatusReceipts = internalMutation({
  args: {}, handler: async ctx => {
    const rows = await ctx.db.query("legacyCommentStatusReceipts").withIndex("by_expiry", q => q.lte("expiresAt", Date.now())).take(100);
    await Promise.all(rows.map(row => ctx.db.delete(row._id)));
    if (rows.length === 100) await ctx.scheduler.runAfter(0, internal.threads.cleanupStatusReceipts, {});
  },
});
