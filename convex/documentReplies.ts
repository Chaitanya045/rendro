import { publicError } from "./publicErrors";
import { validateClientOperationId, validateCommentAuthor } from "./commentOperations";
import { requireId } from "./ids";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./publicFunctions";
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
    projectId: v.string(),
    documentPath: v.string(),
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    const args = {
      ...input,
      projectId: requireId(ctx, "projects", input.projectId),
      threadId: requireId(ctx, "documentThreads", input.threadId),
    };
    if (
      !Number.isSafeInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems < 1
      || args.paginationOpts.numItems > DOCUMENT_REPLY_PAGE_SIZE
    ) throw publicError("invalid_input", `Page size must be between 1 and ${DOCUMENT_REPLY_PAGE_SIZE}`);
    const thread = await ctx.db.get(args.threadId);
    if (
      !thread
      || thread.deletedAt !== undefined
      || thread.organizationId !== args.organizationId
      || thread.projectId !== args.projectId
      || thread.documentPath !== args.documentPath
    ) throw publicError("not_found");
    const repliesPage = await ctx.db
      .query("documentReplies")
      .withIndex("by_active_thread", (index) => index.eq("threadId", args.threadId).eq("deletedAt", undefined))
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
    projectId: v.string(),
    documentPath: v.string(),
    threadId: v.string(),
    body: v.string(),
    clientOperationId: v.optional(v.string()),
    expectedAuthorId: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    const args = {
      ...input,
      projectId: requireId(ctx, "projects", input.projectId),
      threadId: requireId(ctx, "documentThreads", input.threadId),
    };
    const thread = await ctx.db.get(args.threadId);
    if (
      !thread
      || thread.deletedAt !== undefined
      || thread.organizationId !== args.organizationId
      || thread.projectId !== args.projectId
      || thread.documentPath !== args.documentPath
    ) throw publicError("not_found");
    const body = args.body.trim();
    if (!body || body.length > 10_000) throw publicError("invalid_input", "Reply body is invalid");
    validateCommentAuthor(args.expectedAuthorId, authorized.user._id);
    validateClientOperationId(args.clientOperationId);
    if (args.clientOperationId !== undefined) {
      const existing = await ctx.db.query("documentReplies").withIndex("by_operation", (q) => q
        .eq("organizationId", args.organizationId).eq("threadId", args.threadId)
        .eq("authorId", authorized.user._id).eq("clientOperationId", args.clientOperationId)).unique();
      if (existing) return existing._id;
    }
    const now = Date.now();
    return ctx.db.insert("documentReplies", {
      clientOperationId: args.clientOperationId,
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
    projectId: v.string(),
    documentPath: v.string(),
    threadId: v.string(),
    replyId: v.string(),
    clientOperationId: v.optional(v.string()),
    expectedAuthorId: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    validateCommentAuthor(input.expectedAuthorId, authorized.user._id);
    validateClientOperationId(input.clientOperationId);
    const replyId = requireId(ctx, "documentReplies", input.replyId);
    const threadId = requireId(ctx, "documentThreads", input.threadId);
    const scope = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    const thread = await ctx.db.get(threadId);
    const reply = await ctx.db.get(replyId);
    const project = await ctx.db.get(scope.projectId);
    if (!project || project.organizationId !== scope.organizationId) throw publicError("not_found");
    if (
      !thread
      || thread.organizationId !== scope.organizationId
      || thread.projectId !== scope.projectId
      || thread.documentPath !== scope.documentPath
    ) throw publicError("not_found");
    if (!reply) throw publicError("not_found");
    if (reply.threadId !== threadId || reply.organizationId !== thread.organizationId) throw publicError("not_found");
    if (thread.deletedAt !== undefined && reply.deletedAt === undefined) throw publicError("not_found");
    requireCommentAuthorOrAdmin(authorized, reply.authorId);
    if (reply.deletedAt !== undefined) return;
    // Retain scope and author proof for authorized deletion retries.
    await ctx.db.patch(replyId, { deletedAt: Date.now(), body: "" });
  },
});
