import { internalMutation, type MutationCtx } from "./_generated/server";
import { query, mutation } from "./publicFunctions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { publicError } from "./publicErrors";
import { anchorValidator } from "./schema";
import { validAnchor } from "../src/commentor/mutation-args";
import { authorizeLegacyComment, canModifyLegacyComment, requireLegacyCommentAuthor, legacyOperationArgs, authorizeLegacyThread, legacyBody } from "./legacyComments";

// The v1 response has no cursor. Reject oversized histories rather than truncate.
export const legacyCommentLimit = 100;
export const list = query({
  args: { orgSlug: v.string(), filePath: v.string() },
  handler: async (ctx, { orgSlug, filePath }) => {
    const identity = await authorizeLegacyComment(ctx, orgSlug);
    const threads = await ctx.db.query("threads").withIndex("by_org_file", q => q.eq("orgSlug", orgSlug).eq("filePath", filePath)).order("asc").take(legacyCommentLimit + 1);
    let count = threads.length;
    if (count > legacyCommentLimit) publicError("invalid_input");
    const result = [];
    for (const thread of threads) {
      if (thread.deletedAt !== undefined) continue;
      const replies = await ctx.db.query("replies").withIndex("by_thread", q => q.eq("threadId", thread._id)).order("asc").take(legacyCommentLimit - count + 1);
      count += replies.length;
      if (count > legacyCommentLimit) publicError("invalid_input");
      result.push({ ...thread, canDelete: canModifyLegacyComment(identity, thread), replies: replies
        .filter(reply => reply.deletedAt === undefined).map(reply => ({ ...reply, canDelete: canModifyLegacyComment(identity, reply) })) });
    }
    return result;
  },
});

export const create = mutation({
  args: { ...legacyOperationArgs, orgSlug: v.string(), filePath: v.string(), body: v.string(), anchor: anchorValidator },
  handler: async (ctx, args) => {
    const identity = await authorizeLegacyComment(ctx, args.orgSlug, args);
    const body = legacyBody(args.body);
    if (!args.filePath || args.filePath.includes("\\") || args.filePath.split("/").some(part => !part || part === "." || part === "..")) publicError("invalid_input");
    if (!validAnchor(args.anchor)) publicError("invalid_input");
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
    if (target === undefined) publicError("invalid_input");
    const receipt = await ctx.db.query("legacyCommentStatusReceipts").withIndex("by_operation", q => q.eq("threadId", thread._id).eq("authorId", authorId).eq("clientOperationId", operation)).unique();
    if (receipt) {
      if (receipt.field !== field || receipt.target !== target) publicError("conflict");
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
    if (thread.deletedAt !== undefined) publicError("not_found");
    return applyStatus(ctx, thread, identity.subject, "resolved", input.resolved, input.clientOperationId);
  },
});
export const archive = mutation({
  args: { ...statusArgs, archived: v.optional(v.boolean()) },
  handler: async (ctx, input) => {
    const { thread, identity } = await authorizeLegacyThread(ctx, input);
    if (thread.deletedAt !== undefined) publicError("not_found");
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
    const replies = await ctx.db.query("replies").withIndex("by_thread", q => q.eq("threadId", threadId)).take(legacyCommentLimit + 1);
    if (replies.length > legacyCommentLimit) publicError("invalid_input");
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
