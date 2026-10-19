/**
 * Comments on repository docs (#254): threads anchored to `(repoId, path,
 * blobSha, headingSlug, textQuote)` and their replies. Every read and write is
 * decided by `repoCommentAccess` (a grant the serving Worker recorded after its
 * own authorization), first, before any comment is looked up. A denial is an
 * empty page for reads and "not found" for writes, the same answer a missing
 * thread gets, so nothing reveals whether a repository or thread exists.
 *
 * Anchors are client data and only ever data: readers re-find the quoted text
 * in the page they show (docs/TECHNICAL.md, "Comments on repository docs"), so
 * a forged anchor can at worst fail to find anything.
 */
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { validateClientOperationId, validateCommentAuthor } from "./commentOperations";
import { publicError } from "./publicErrors";
import { mutation, query } from "./publicFunctions";
import { publicPaginate } from "./publicPagination";
import { repoCommentReader, requireRepoCommentWriter } from "./repoCommentAccess";
import { repoAnchorValidator } from "./schema";
import { consumeWriteQuota } from "./writeQuotas";

export const REPO_THREAD_PAGE_SIZE = 20;
export const REPO_REPLY_PREVIEW_SIZE = 10;
export const REPO_REPLY_CLEANUP_BATCH = 100;
export const MAX_COMMENT_LENGTH = 10_000;
export const MAX_REPO_PATH_LENGTH = 1_024;
export const MAX_QUOTE_LENGTH = 4_096;
export const MAX_QUOTE_CONTEXT = 64;
export const MAX_HEADING_SLUG_LENGTH = 256;
const MAX_ANCHOR_OFFSET = 10_000_000;
const MAX_REACTIVE_PAGE_ROWS = 24;
const MAX_PAGE_BYTES_READ = 1_000_000;
const MAX_AUTHOR_NAME_LENGTH = 200;

type Ctx = QueryCtx | MutationCtx;
type RepoAnchor = Doc<"repoThreads">["anchor"];

const BLOB_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A repository path as the read path accepts it: no empty, `.` or `..` segment, no backslash or control character. */
export function validRepoPath(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REPO_PATH_LENGTH && !value.includes("\\") && !CONTROL.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function validRepoAnchor(anchor: RepoAnchor): boolean {
  return BLOB_SHA.test(anchor.blobSha)
    && anchor.headingSlug.length <= MAX_HEADING_SLUG_LENGTH && !/\s/.test(anchor.headingSlug) && !CONTROL.test(anchor.headingSlug)
    && anchor.exact.trim().length > 0 && anchor.exact.length <= MAX_QUOTE_LENGTH
    && anchor.prefix.length <= MAX_QUOTE_CONTEXT && anchor.suffix.length <= MAX_QUOTE_CONTEXT
    && Number.isSafeInteger(anchor.offset) && anchor.offset >= 0 && anchor.offset <= MAX_ANCHOR_OFFSET;
}

function validPageSize(numItems: number, max: number): boolean {
  return Number.isSafeInteger(numItems) && numItems >= 1 && numItems <= max;
}

function emptyPage() {
  return { page: [], isDone: true, continueCursor: "" };
}

/** Names only: comments on public repositories are visible to anyone, so no email address ever leaves Convex. */
function authorDisplay(author: { name?: string | null } | null) {
  return { authorEmail: "", authorName: (author?.name ?? "").trim().slice(0, MAX_AUTHOR_NAME_LENGTH) || "Former reader" };
}

function authors(ctx: Ctx) {
  const requests = new Map<string, ReturnType<typeof authComponent.getAnyUserById>>();
  return (authorId: string) => {
    let request = requests.get(authorId);
    if (!request) {
      request = authComponent.getAnyUserById(ctx, authorId);
      requests.set(authorId, request);
    }
    return request;
  };
}

function normalizeId<T extends "repoThreads" | "repoReplies">(ctx: Ctx, table: T, value: string): Id<T> | null {
  return ctx.db.normalizeId(table, value);
}

/** The thread, if it is live and belongs to this repository document. Called only after access is decided. */
async function scopedThread(ctx: Ctx, repoId: number, path: string, value: string): Promise<Doc<"repoThreads"> | null> {
  const threadId = normalizeId(ctx, "repoThreads", value);
  const thread = threadId ? await ctx.db.get(threadId) : null;
  return thread && thread.deletedAt === undefined && thread.repoId === repoId && thread.path === path ? thread : null;
}

const scopeArgs = { repoId: v.number(), path: v.string() };
const operationArgs = { clientOperationId: v.optional(v.string()), expectedAuthorId: v.optional(v.string()) };

export const listThreads = query({
  args: { ...scopeArgs, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    if (!validPageSize(args.paginationOpts.numItems, REPO_THREAD_PAGE_SIZE)) publicError("invalid_input");
    const reader = await repoCommentReader(ctx, args.repoId);
    if (!reader || !validRepoPath(args.path)) return emptyPage();
    const threads = await publicPaginate(ctx.db.query("repoThreads")
      .withIndex("by_repo_path", q => q.eq("repoId", args.repoId).eq("path", args.path).eq("deletedAt", undefined))
      .order("desc"), { ...args.paginationOpts, maximumRowsRead: MAX_REACTIVE_PAGE_ROWS, maximumBytesRead: MAX_PAGE_BYTES_READ });
    const author = authors(ctx);
    const userId = reader.user?._id ?? null;
    const page = await Promise.all(threads.page.map(async thread => {
      const [threadAuthor, newest] = await Promise.all([
        author(thread.authorId),
        ctx.db.query("repoReplies").withIndex("by_thread", q => q.eq("threadId", thread._id).eq("deletedAt", undefined))
          .order("desc").take(REPO_REPLY_PREVIEW_SIZE + 1),
      ]);
      const replies = await Promise.all(newest.slice(0, REPO_REPLY_PREVIEW_SIZE).reverse().map(async reply => ({
        _id: reply._id, _creationTime: reply._creationTime, clientOperationId: reply.clientOperationId, body: reply.body,
        canDelete: reply.authorId === userId, ...authorDisplay(await author(reply.authorId)),
      })));
      return {
        _id: thread._id, _creationTime: thread._creationTime, clientOperationId: thread.clientOperationId,
        repoId: thread.repoId, path: thread.path, blobSha: thread.blobSha, anchor: thread.anchor, body: thread.body,
        resolved: thread.resolved, archived: thread.archived, canDelete: thread.authorId === userId,
        ...authorDisplay(threadAuthor), replies, repliesHasMore: newest.length > REPO_REPLY_PREVIEW_SIZE,
      };
    }));
    return { ...threads, page };
  },
});

export const listReplies = query({
  args: { ...scopeArgs, threadId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    if (!validPageSize(args.paginationOpts.numItems, REPO_THREAD_PAGE_SIZE)) publicError("invalid_input");
    const reader = await repoCommentReader(ctx, args.repoId);
    const thread = reader ? await scopedThread(ctx, args.repoId, args.path, args.threadId) : null;
    if (!reader || !thread) return emptyPage();
    const replies = await publicPaginate(ctx.db.query("repoReplies")
      .withIndex("by_thread", q => q.eq("threadId", thread._id).eq("deletedAt", undefined))
      .order("desc"), { ...args.paginationOpts, maximumRowsRead: MAX_REACTIVE_PAGE_ROWS, maximumBytesRead: MAX_PAGE_BYTES_READ });
    const author = authors(ctx);
    const userId = reader.user?._id ?? null;
    const page = await Promise.all(replies.page.map(async reply => ({
      _id: reply._id, _creationTime: reply._creationTime, clientOperationId: reply.clientOperationId, body: reply.body,
      canDelete: reply.authorId === userId, ...authorDisplay(await author(reply.authorId)),
    })));
    return { ...replies, page };
  },
});

function commentBody(value: string): string {
  const body = value.trim();
  if (!body || body.length > MAX_COMMENT_LENGTH) publicError("invalid_input");
  return body;
}

export const createThread = mutation({
  args: { ...scopeArgs, ...operationArgs, body: v.string(), anchor: repoAnchorValidator },
  handler: async (ctx, args): Promise<Id<"repoThreads">> => {
    const { user } = await requireRepoCommentWriter(ctx, args.repoId);
    if (!validRepoPath(args.path) || !validRepoAnchor(args.anchor)) publicError("invalid_input");
    const body = commentBody(args.body);
    validateCommentAuthor(args.expectedAuthorId, user._id);
    validateClientOperationId(args.clientOperationId);
    if (args.clientOperationId !== undefined) {
      const existing = await ctx.db.query("repoThreads").withIndex("by_operation", q => q
        .eq("repoId", args.repoId).eq("authorId", user._id).eq("clientOperationId", args.clientOperationId)).unique();
      if (existing) return existing._id;
    }
    await consumeWriteQuota(ctx, "comments", user._id, `repo:${args.repoId}`);
    const now = Date.now();
    return ctx.db.insert("repoThreads", {
      repoId: args.repoId, path: args.path, blobSha: args.anchor.blobSha, anchor: args.anchor, authorId: user._id, body,
      resolved: false, archived: false, clientOperationId: args.clientOperationId, createdAt: now, updatedAt: now,
    });
  },
});

async function writableThread(ctx: MutationCtx, args: { repoId: number; path: string; threadId: string; clientOperationId?: string; expectedAuthorId?: string }) {
  const { user } = await requireRepoCommentWriter(ctx, args.repoId);
  validateCommentAuthor(args.expectedAuthorId, user._id);
  validateClientOperationId(args.clientOperationId);
  const thread = await scopedThread(ctx, args.repoId, args.path, args.threadId);
  if (!thread) publicError("not_found");
  return { user, thread };
}

/** Resolving is collaborative triage: anyone who may write here may resolve or reopen. The target is explicit, so a retry is idempotent. */
export const resolve = mutation({
  args: { ...scopeArgs, ...operationArgs, threadId: v.string(), resolved: v.boolean() },
  handler: async (ctx, args): Promise<boolean> => {
    const { thread } = await writableThread(ctx, args);
    if (thread.resolved !== args.resolved) await ctx.db.patch(thread._id, { resolved: args.resolved, updatedAt: Date.now() });
    return args.resolved;
  },
});

/** Archive hides a thread, so like deletion it is the author's alone. */
export const archive = mutation({
  args: { ...scopeArgs, ...operationArgs, threadId: v.string(), archived: v.boolean() },
  handler: async (ctx, args): Promise<boolean> => {
    const { user, thread } = await writableThread(ctx, args);
    if (thread.authorId !== user._id) publicError("forbidden");
    if (thread.archived !== args.archived) await ctx.db.patch(thread._id, { archived: args.archived, updatedAt: Date.now() });
    return args.archived;
  },
});

export const removeThread = mutation({
  args: { ...scopeArgs, ...operationArgs, threadId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const { user } = await requireRepoCommentWriter(ctx, args.repoId);
    validateCommentAuthor(args.expectedAuthorId, user._id);
    validateClientOperationId(args.clientOperationId);
    const threadId = normalizeId(ctx, "repoThreads", args.threadId);
    const thread = threadId ? await ctx.db.get(threadId) : null;
    // A retried deletion finds its own tombstone; anyone else's or another document's is "not found".
    if (!thread || thread.repoId !== args.repoId || thread.path !== args.path) publicError("not_found");
    if (thread.authorId !== user._id) publicError(thread.deletedAt === undefined ? "forbidden" : "not_found");
    if (thread.deletedAt !== undefined) return null;
    await ctx.db.patch(thread._id, { deletedAt: Date.now(), body: "" });
    await ctx.scheduler.runAfter(0, internal.repoComments.cleanupDeletedThread, { threadId: thread._id });
    return null;
  },
});

/** Replies of a deleted thread go in batches; the thread stays as a scrubbed tombstone so retries and stale creates stay decided. */
export const cleanupDeletedThread = internalMutation({
  args: { threadId: v.id("repoThreads") },
  handler: async (ctx, { threadId }): Promise<null> => {
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.deletedAt === undefined) return null;
    const replies = await ctx.db.query("repoReplies").withIndex("by_thread", q => q.eq("threadId", threadId).eq("deletedAt", undefined))
      .take(REPO_REPLY_CLEANUP_BATCH + 1);
    const now = Date.now();
    await Promise.all(replies.slice(0, REPO_REPLY_CLEANUP_BATCH).map(reply => ctx.db.patch(reply._id, { deletedAt: now, body: "" })));
    if (replies.length > REPO_REPLY_CLEANUP_BATCH) await ctx.scheduler.runAfter(0, internal.repoComments.cleanupDeletedThread, { threadId });
    else await ctx.db.patch(threadId, { anchor: { ...thread.anchor, prefix: "", exact: "-", suffix: "" } });
    return null;
  },
});

export const addReply = mutation({
  args: { ...scopeArgs, ...operationArgs, threadId: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<Id<"repoReplies">> => {
    const { user, thread } = await writableThread(ctx, args);
    const body = commentBody(args.body);
    if (args.clientOperationId !== undefined) {
      const existing = await ctx.db.query("repoReplies").withIndex("by_operation", q => q
        .eq("threadId", thread._id).eq("authorId", user._id).eq("clientOperationId", args.clientOperationId)).unique();
      if (existing) return existing._id;
    }
    await consumeWriteQuota(ctx, "comments", user._id, `repo:${args.repoId}`);
    return ctx.db.insert("repoReplies", {
      repoId: args.repoId, threadId: thread._id, authorId: user._id, body, clientOperationId: args.clientOperationId, createdAt: Date.now(),
    });
  },
});

export const removeReply = mutation({
  args: { ...scopeArgs, ...operationArgs, threadId: v.string(), replyId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const { user } = await requireRepoCommentWriter(ctx, args.repoId);
    validateCommentAuthor(args.expectedAuthorId, user._id);
    validateClientOperationId(args.clientOperationId);
    const threadId = normalizeId(ctx, "repoThreads", args.threadId);
    const replyId = normalizeId(ctx, "repoReplies", args.replyId);
    const thread = threadId ? await ctx.db.get(threadId) : null;
    const reply = replyId ? await ctx.db.get(replyId) : null;
    if (!thread || thread.repoId !== args.repoId || thread.path !== args.path || !reply || reply.threadId !== thread._id) publicError("not_found");
    if (thread.deletedAt !== undefined && reply.deletedAt === undefined) publicError("not_found");
    if (reply.authorId !== user._id) publicError(reply.deletedAt === undefined ? "forbidden" : "not_found");
    if (reply.deletedAt !== undefined) return null;
    await ctx.db.patch(reply._id, { deletedAt: Date.now(), body: "" });
    return null;
  },
});
