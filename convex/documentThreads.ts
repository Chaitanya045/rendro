import { consumeWriteQuota } from "./writeQuotas";
import { publicPaginate } from "./publicPagination";
import { publicError } from "./publicErrors";
import { validateClientOperationId, validateCommentAuthor } from "./commentOperations";
import { requireId } from "./ids";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { mutation, query } from "./publicFunctions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
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
    publicError("invalid_input");
  }
}

function authorDisplay(author: { name?: string | null; email?: string | null } | null) {
  const email = (author?.email ?? "").slice(0, MAX_AUTHOR_EMAIL_LENGTH);
  const name = (author?.name ?? "").trim().slice(0, MAX_AUTHOR_NAME_LENGTH);
  return { authorEmail: email, authorName: name || email || "Former member" };
}

const threadScopeArgs = {
  clientOperationId: v.optional(v.string()),
  expectedAuthorId: v.optional(v.string()),
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
      publicError("not_found");
    }
    const threadsPage = await publicPaginate(ctx.db
      .query("documentThreads")
      .withIndex("by_active_document", (index) => index
        .eq("organizationId", args.organizationId)
        .eq("projectId", args.projectId)
        .eq("documentPath", args.documentPath)
        .eq("deletedAt", undefined))
      .order("desc"), {
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
          .withIndex("by_active_thread", (index) => index.eq("threadId", thread._id).eq("deletedAt", undefined))
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
    clientOperationId: v.optional(v.string()),
    expectedAuthorId: v.optional(v.string()),
  },
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    const args = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    const project = await ctx.db.get(args.projectId);
    if (!project || project.organizationId !== args.organizationId) {
      publicError("not_found");
    }
    const body = args.body.trim();
    if (!body || body.length > 10_000) publicError("invalid_input");
    if (!validDocumentPath(args.documentPath)) publicError("invalid_input");
    if (!validAnchor(args.anchor)) publicError("invalid_input");
    validateCommentAuthor(args.expectedAuthorId, authorized.user._id);
    validateClientOperationId(args.clientOperationId);
    // Authorization and scope validation precede the indexed dedup lookup.
    if (args.clientOperationId !== undefined) {
      const existing = await ctx.db.query("documentThreads").withIndex("by_operation", (q) => q
        .eq("organizationId", args.organizationId).eq("projectId", args.projectId)
        .eq("documentPath", args.documentPath).eq("authorId", authorized.user._id)
        .eq("clientOperationId", args.clientOperationId)).unique();
      if (existing) return existing._id;
    }
    await consumeWriteQuota(ctx, "comments", authorized.user._id, args.organizationId);
    const now = Date.now();
    return ctx.db.insert("documentThreads", {
      clientOperationId: args.clientOperationId,
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

// Status retry receipts have a 30-day retention window, including no-op writes.
// Daily indexed cleanup deletes at most 100 rows per transaction and schedules
// another batch when needed. Receipts contain no comment body or draft content.
export const STATUS_RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
async function applyStatus(
  ctx: MutationCtx,
  thread: Doc<"documentThreads">,
  authorId: string,
  field: "resolved" | "archived",
  target: boolean | undefined,
  clientOperationId: string | undefined,
): Promise<boolean> {
  if (clientOperationId !== undefined) {
    if (target === undefined) publicError("invalid_input");
    const receipt = await ctx.db.query("commentStatusReceipts").withIndex("by_operation", (q) => q
      .eq("organizationId", thread.organizationId).eq("projectId", thread.projectId)
      .eq("documentPath", thread.documentPath).eq("threadId", thread._id)
      .eq("authorId", authorId).eq("clientOperationId", clientOperationId)).unique();
    if (receipt) {
      if (receipt.field !== field || receipt.target !== target) publicError("conflict");
      return receipt.target;
    }
    await ctx.db.insert("commentStatusReceipts", {
      organizationId: thread.organizationId, projectId: thread.projectId,
      documentPath: thread.documentPath, threadId: thread._id, authorId,
      clientOperationId, field, target, expiresAt: Date.now() + STATUS_RECEIPT_TTL_MS,
    });
  }
  // Older widgets/parents omit both the ID and target and expect a toggle.
  const applied = target ?? !thread[field];
  if (thread[field] !== applied) await ctx.db.patch(thread._id, { [field]: applied, updatedAt: Date.now() });
  return applied;
}

export const cleanupStatusReceipts = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const expired = await ctx.db.query("commentStatusReceipts")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now())).take(100);
    await Promise.all(expired.map((receipt) => ctx.db.delete(receipt._id)));
    if (expired.length === 100) await ctx.scheduler.runAfter(0, internal.documentThreads.cleanupStatusReceipts, {});
    return null;
  },
});

// Resolving/reopening is collaborative triage, available to any current member.
export const resolve = mutation({
  args: { ...threadScopeArgs, resolved: v.optional(v.boolean()) },
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    validateCommentAuthor(input.expectedAuthorId, authorized.user._id);
    validateClientOperationId(input.clientOperationId);
    const threadId = requireId(ctx, "documentThreads", input.threadId);
    const scope = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.deletedAt !== undefined || !threadMatchesScope(thread, scope)) {
      publicError("not_found");
    }
    return applyStatus(ctx, thread, authorized.user._id, "resolved", input.resolved, input.clientOperationId);
  },
});

export const archive = mutation({
  args: { ...threadScopeArgs, archived: v.optional(v.boolean()) },
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    validateCommentAuthor(input.expectedAuthorId, authorized.user._id);
    validateClientOperationId(input.clientOperationId);
    const threadId = requireId(ctx, "documentThreads", input.threadId);
    const scope = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.deletedAt !== undefined || !threadMatchesScope(thread, scope)) {
      publicError("not_found");
    }
    requireCommentAuthorOrAdmin(authorized, thread.authorId);
    return applyStatus(ctx, thread, authorized.user._id, "archived", input.archived, input.clientOperationId);
  },
});

export const remove = mutation({
  args: threadScopeArgs,
  handler: async (ctx, input) => {
    const authorized = await requireOrganizationMember(ctx, input.organizationId);
    validateCommentAuthor(input.expectedAuthorId, authorized.user._id);
    validateClientOperationId(input.clientOperationId);
    const threadId = requireId(ctx, "documentThreads", input.threadId);
    const scope = { ...input, projectId: requireId(ctx, "projects", input.projectId) };
    const thread = await ctx.db.get(threadId);
    const project = await ctx.db.get(scope.projectId);
    if (!project || project.organizationId !== scope.organizationId) publicError("not_found");
    if (!thread) publicError("not_found");
    if (!threadMatchesScope(thread, scope)) publicError("not_found");
    requireCommentAuthorOrAdmin(authorized, thread.authorId);
    if (thread.deletedAt !== undefined) return;
    await ctx.db.patch(threadId, { deletedAt: Date.now() });
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
      .withIndex("by_active_thread", (index) => index.eq("threadId", threadId).eq("deletedAt", undefined))
      .take(DOCUMENT_REPLY_CLEANUP_BATCH_SIZE + 1);
    await Promise.all(replies
      .slice(0, DOCUMENT_REPLY_CLEANUP_BATCH_SIZE)
      .map((reply) => ctx.db.patch(reply._id, { deletedAt: Date.now(), body: "" })));
    if (replies.length > DOCUMENT_REPLY_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.documentThreads.cleanupDeletedThread, { threadId });
    } else {
      // Keep scrubbed scope/author records even for older comments. They prove
      // a deletion retry is authorized without acknowledging arbitrary absent
      // IDs (which would distinguish them from inaccessible existing records).
      // Dedup keys also prevent delayed creates from resurrecting comments.
      await ctx.db.patch(threadId, { body: "", anchor: { kind: "element", path: [] } });
    }
    return null;
  },
});
