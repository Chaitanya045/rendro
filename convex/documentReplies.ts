import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authComponent } from "./auth";
import { canDeleteComment, requireCommentAuthorOrAdmin, requireOrganizationMember } from "./authorization";

export const DOCUMENT_REPLY_PAGE_SIZE = 20;
const MAX_REACTIVE_PAGE_ROWS = 24;
const MAX_PAGE_BYTES_READ = 1_000_000;
const MAX_AUTHOR_NAME_LENGTH = 200;
const MAX_AUTHOR_EMAIL_LENGTH = 320;

function authorDisplay(author: { name?: string | null; email?: string | null } | null) {
  const email = (author?.email ?? "").slice(0, MAX_AUTHOR_EMAIL_LENGTH);
  const name = (author?.name ?? "").trim().slice(0, MAX_AUTHOR_NAME_LENGTH);
  return { authorEmail: email, authorName: name || email || "Former member" };
}

export const list = query({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    documentPath: v.string(),
    threadId: v.id("documentThreads"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems < 1
      || args.paginationOpts.numItems > DOCUMENT_REPLY_PAGE_SIZE
    ) throw new ConvexError(`Page size must be between 1 and ${DOCUMENT_REPLY_PAGE_SIZE}`);
    const thread = await ctx.db.get(args.threadId);
    if (
      !thread
      || thread.deletedAt !== undefined
      || thread.organizationId !== args.organizationId
      || thread.projectId !== args.projectId
      || thread.documentPath !== args.documentPath
    ) throw new ConvexError("Comment not found");
    const authorized = await requireOrganizationMember(ctx, thread.organizationId);
    const repliesPage = await ctx.db
      .query("documentReplies")
      .withIndex("by_thread", (index) => index.eq("threadId", args.threadId))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        maximumRowsRead: MAX_REACTIVE_PAGE_ROWS,
        maximumBytesRead: MAX_PAGE_BYTES_READ,
      });
    const authorRequests = new Map<string, ReturnType<typeof authComponent.getAnyUserById>>();
    const page = await Promise.all(repliesPage.page.map(async (reply) => {
      let request = authorRequests.get(reply.authorId);
      if (!request) {
        request = authComponent.getAnyUserById(ctx, reply.authorId);
        authorRequests.set(reply.authorId, request);
      }
      const author = await request;
      return {
        ...reply,
        canDelete: canDeleteComment(authorized, reply.authorId),
        ...authorDisplay(author),
      };
    }));
    return { ...repliesPage, page };
  },
});

export const add = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    documentPath: v.string(),
    threadId: v.id("documentThreads"),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (
      !thread
      || thread.deletedAt !== undefined
      || thread.organizationId !== args.organizationId
      || thread.projectId !== args.projectId
      || thread.documentPath !== args.documentPath
    ) throw new ConvexError("Comment not found");
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

// Delete one reply only after checking both its parent document and its author.
export const remove = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    documentPath: v.string(),
    threadId: v.id("documentThreads"),
    replyId: v.id("documentReplies"),
  },
  handler: async (ctx, { replyId, threadId, ...scope }) => {
    const thread = await ctx.db.get(threadId);
    const reply = await ctx.db.get(replyId);
    if (
      !thread
      || thread.deletedAt !== undefined
      || thread.organizationId !== scope.organizationId
      || thread.projectId !== scope.projectId
      || thread.documentPath !== scope.documentPath
      || !reply
      || reply.threadId !== threadId
      || reply.organizationId !== thread.organizationId
    ) throw new ConvexError("Comment not found");
    const authorized = await requireOrganizationMember(ctx, thread.organizationId);
    requireCommentAuthorOrAdmin(authorized, reply.authorId);
    await ctx.db.delete(replyId);
  },
});
