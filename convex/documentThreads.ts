import { requireId } from "./ids";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { canDeleteComment, requireCommentAuthorOrAdmin, requireOrganizationMember } from "./authorization";
import { anchorValidator } from "./schema";

export const DOCUMENT_THREAD_PAGE_SIZE = 20;
export const DOCUMENT_REPLY_PREVIEW_SIZE = 10;
export const DOCUMENT_REPLY_CLEANUP_BATCH_SIZE = 100;
const MAX_REACTIVE_PAGE_ROWS = 24;
const MAX_PAGE_BYTES_READ = 1_000_000;
const MAX_ANCHOR_PATH_PARTS = 64;
const MAX_ANCHOR_PATH_PART_LENGTH = 256;
const MAX_ANCHOR_QUOTE_LENGTH = 4_096;
const MAX_ANCHOR_OFFSET = 1_000_000;
const MAX_AUTHOR_NAME_LENGTH = 200;
const MAX_AUTHOR_EMAIL_LENGTH = 320;

function validDocumentPath(value: string): boolean {
  return Boolean(value)
    && !value.includes("\\")
    && value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

function validAnchor(anchor:
  | { kind: "element"; path: string[] }
  | { kind: "text-range"; quote: string; path: string[]; startOffset: number; endOffset: number },
): boolean {
  if (
    anchor.path.length === 0
    || anchor.path.length > MAX_ANCHOR_PATH_PARTS
    || anchor.path.some((part) => !part.trim() || part.length > MAX_ANCHOR_PATH_PART_LENGTH)
  ) return false;
  if (anchor.kind === "element") return true;
  return Boolean(
    anchor.quote.trim()
    && anchor.quote.length <= MAX_ANCHOR_QUOTE_LENGTH
    && Number.isSafeInteger(anchor.startOffset)
    && anchor.startOffset >= 0
    && anchor.startOffset <= MAX_ANCHOR_OFFSET
    && Number.isSafeInteger(anchor.endOffset)
    && anchor.endOffset >= 0
    && anchor.endOffset <= MAX_ANCHOR_OFFSET
  );
}

function assertValidPageSize(numItems: number): void {
  if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > DOCUMENT_THREAD_PAGE_SIZE) {
    throw new ConvexError(`Page size must be between 1 and ${DOCUMENT_THREAD_PAGE_SIZE}`);
  }
}

function authorDisplay(author: { name?: string | null; email?: string | null } | null) {
  const email = (author?.email ?? "").slice(0, MAX_AUTHOR_EMAIL_LENGTH);
  const name = (author?.name ?? "").trim().slice(0, MAX_AUTHOR_NAME_LENGTH);
  return { authorEmail: email, authorName: name || email || "Former member" };
}

const threadScopeArgs = {
  organizationId: v.string(),
  projectId: v.string(),
  documentPath: v.string(),
  threadId: v.string(),
};

function threadMatchesScope(
  thread: { organizationId: string; projectId: Id<"projects">; documentPath: string },
  scope: { organizationId: string; projectId: Id<"projects">; documentPath: string },
): boolean {
  return Boolean(thread.organizationId === scope.organizationId
    && thread.projectId === scope.projectId
    && thread.documentPath === scope.documentPath);
}

export const list = query({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    documentPath: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    const args = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    assertValidPageSize(args.paginationOpts.numItems);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    const threadsPage = await ctx.db
      .query("documentThreads")
      .withIndex("by_active_document", (index) => index
        .eq("organizationId", args.organizationId)
        .eq("projectId", args.projectId)
        .eq("documentPath", args.documentPath)
        .eq("deletedAt", undefined))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        maximumRowsRead: MAX_REACTIVE_PAGE_ROWS,
        maximumBytesRead: MAX_PAGE_BYTES_READ,
      });

    const authorRequests = new Map<
      string,
      ReturnType<typeof authComponent.getAnyUserById>
    >();
    const authorById = (authorId: string) => {
      const existing = authorRequests.get(authorId);
      if (existing) return existing;
      const request = authComponent.getAnyUserById(ctx, authorId);
      authorRequests.set(authorId, request);
      return request;
    };

    const page = await Promise.all(threadsPage.page.map(async (thread) => {
      const [author, newestReplies] = await Promise.all([
        authorById(thread.authorId),
        ctx.db
          .query("documentReplies")
          .withIndex("by_thread", (index) => index.eq("threadId", thread._id))
          .order("desc")
          .take(DOCUMENT_REPLY_PREVIEW_SIZE + 1),
      ]);
      const replies = newestReplies.slice(0, DOCUMENT_REPLY_PREVIEW_SIZE).reverse();
      const enrichedReplies = await Promise.all(replies.map(async (reply) => {
        const replyAuthor = await authorById(reply.authorId);
        return {
          ...reply,
          canDelete: canDeleteComment(authorized, reply.authorId),
          ...authorDisplay(replyAuthor),
        };
      }));
      return {
        ...thread,
        canDelete: canDeleteComment(authorized, thread.authorId),
        ...authorDisplay(author),
        replies: enrichedReplies,
        repliesHasMore: newestReplies.length > DOCUMENT_REPLY_PREVIEW_SIZE,
      };
    }));
    return { ...threadsPage, page };
  },
});

export const create = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    documentPath: v.string(),
    body: v.string(),
    anchor: anchorValidator,
  },
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    const args = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      throw new ConvexError("Project not found");
    }
    const body = args.body.trim();
    if (!body || body.length > 10_000) throw new ConvexError("Comment body is invalid");
    if (!validDocumentPath(args.documentPath)) throw new ConvexError("Document path is invalid");
    if (!validAnchor(args.anchor)) throw new ConvexError("Comment anchor is invalid");
    const now = Date.now();
    return ctx.db.insert("documentThreads", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      documentPath: args.documentPath,
      deploymentId: project.activeDeploymentId,
      authorId: authorized.user._id,
      body,
      anchor: args.anchor,
      resolved: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Resolving/reopening is collaborative triage, available to any current member.
export const resolve = mutation({
  args: threadScopeArgs,
  handler: async (ctx, input) => {
    await requireOrganizationMember(ctx, input.organizationId);
    const threadId = requireId(ctx, "documentThreads", input.threadId);
    const scope = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.deletedAt !== undefined || !threadMatchesScope(thread, scope)) {
      throw new ConvexError("Comment not found");
    }
    await ctx.db.patch(threadId, { resolved: !thread.resolved, updatedAt: Date.now() });
  },
});

export const archive = mutation({
  args: threadScopeArgs,
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    const threadId = requireId(ctx, "documentThreads", input.threadId);
    const scope = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.deletedAt !== undefined || !threadMatchesScope(thread, scope)) {
      throw new ConvexError("Comment not found");
    }
    requireCommentAuthorOrAdmin(authorized, thread.authorId);
    await ctx.db.patch(threadId, { archived: !thread.archived, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: threadScopeArgs,
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    const threadId = requireId(ctx, "documentThreads", input.threadId);
    const scope = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    const thread = await ctx.db.get(threadId);
    if (!thread || !threadMatchesScope(thread, scope)) throw new ConvexError("Comment not found");
    requireCommentAuthorOrAdmin(authorized, thread.authorId);
    if (thread.deletedAt === undefined) await ctx.db.patch(threadId, { deletedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.documentThreads.cleanupDeletedThread, { threadId });
  },
});

export const cleanupDeletedThread = internalMutation({
  args: { threadId: v.id("documentThreads") },
  handler: async (ctx, { threadId }): Promise<null> => {
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.deletedAt === undefined) return null;
    const replies = await ctx.db
      .query("documentReplies")
      .withIndex("by_thread", (index) => index.eq("threadId", threadId))
      .take(DOCUMENT_REPLY_CLEANUP_BATCH_SIZE + 1);
    await Promise.all(replies
      .slice(0, DOCUMENT_REPLY_CLEANUP_BATCH_SIZE)
      .map((reply) => ctx.db.delete(reply._id)));
    if (replies.length > DOCUMENT_REPLY_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.documentThreads.cleanupDeletedThread, { threadId });
    } else {
      await ctx.db.delete(threadId);
    }
    return null;
  },
});
