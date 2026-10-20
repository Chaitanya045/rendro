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
import { repoCommentReader, repoCommentSnapshotAllowed, requireRepoCommentWriter, validUserId } from "./repoCommentAccess";
import { repoAnchorValidator } from "./schema";
import { requireInternalSecret } from "./security";
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

type PageOptions = { numItems: number; cursor: string | null };

/** What a page carries of the edit (#287): when it was, and its operation, so the editor's live echo is recognised. */
function edit(row: { editedAt?: number; editOperationId?: string }) {
  return { editedAt: row.editedAt, editOperationId: row.editOperationId };
}

/** A reply as `userId` (null: anonymous) sees it: only its author may delete or edit it. */
async function replyRow(reply: Doc<"repoReplies">, userId: string | null, author: ReturnType<typeof authors>) {
  const own = reply.authorId === userId;
  return {
    _id: reply._id, _creationTime: reply._creationTime, clientOperationId: reply.clientOperationId, body: reply.body, ...edit(reply),
    canDelete: own, canEdit: own, ...authorDisplay(await author(reply.authorId)),
  };
}

/** One page of a document's live threads, newest first, each with its newest replies, as `userId` (null: anonymous) sees it. */
async function threadPage(ctx: QueryCtx, repoId: number, path: string, userId: string | null, paginationOpts: PageOptions) {
  const threads = await publicPaginate(ctx.db.query("repoThreads")
    .withIndex("by_repo_path", q => q.eq("repoId", repoId).eq("path", path).eq("deletedAt", undefined))
    .order("desc"), { ...paginationOpts, maximumRowsRead: MAX_REACTIVE_PAGE_ROWS, maximumBytesRead: MAX_PAGE_BYTES_READ });
  const author = authors(ctx);
  const page = await Promise.all(threads.page.map(async thread => {
    const [threadAuthor, newest] = await Promise.all([
      author(thread.authorId),
      ctx.db.query("repoReplies").withIndex("by_thread", q => q.eq("threadId", thread._id).eq("deletedAt", undefined))
        .order("desc").take(REPO_REPLY_PREVIEW_SIZE + 1),
    ]);
    const replies = await Promise.all(newest.slice(0, REPO_REPLY_PREVIEW_SIZE).reverse().map(reply => replyRow(reply, userId, author)));
    const own = thread.authorId === userId;
    return {
      _id: thread._id, _creationTime: thread._creationTime, clientOperationId: thread.clientOperationId,
      repoId: thread.repoId, path: thread.path, blobSha: thread.blobSha, anchor: thread.anchor, body: thread.body, ...edit(thread),
      resolved: thread.resolved, archived: thread.archived, canDelete: own, canEdit: own,
      ...authorDisplay(threadAuthor), replies, repliesHasMore: newest.length > REPO_REPLY_PREVIEW_SIZE,
    };
  }));
  return { ...threads, page };
}

export const listThreads = query({
  args: { ...scopeArgs, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    if (!validPageSize(args.paginationOpts.numItems, REPO_THREAD_PAGE_SIZE)) publicError("invalid_input");
    const reader = await repoCommentReader(ctx, args.repoId);
    if (!reader || !validRepoPath(args.path)) return emptyPage();
    return threadPage(ctx, args.repoId, args.path, reader.user?._id ?? null, args.paginationOpts);
  },
});

/**
 * The first page of a document's threads for the serving Worker (#284), so the repository shell can show comments
 * before its Convex socket is up. Internal-secret only: the Worker calls it after `authorizeRepo` granted this reader
 * the repository, alongside recording the grant, and hands the page only to that reader (`private, no-store`). The
 * page is the one `listThreads` gives the same reader; what `grant` would refuse is an empty page here too.
 *
 * `userId` is whom the grant names (null: anyone, for a public repository) and decides access, exactly as `grant`
 * does. A public page is the same for every reader except which threads and replies the reader may delete or edit, so the
 * Worker names its signed-in reader as `viewerId` (#303), and the page is read for them. A private page is always
 * read for the grant's own reader.
 */
export const threadSnapshot = query({
  args: { internalSecret: v.string(), ...scopeArgs, userId: v.union(v.string(), v.null()), epoch: v.number(), viewerId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!validRepoPath(args.path) || (args.viewerId !== undefined && (args.userId !== null || !validUserId(args.viewerId)))) {
      publicError("invalid_input");
    }
    if (!await repoCommentSnapshotAllowed(ctx, args.repoId, args.userId, args.epoch)) return emptyPage();
    return threadPage(ctx, args.repoId, args.path, args.userId ?? args.viewerId ?? null, { numItems: REPO_THREAD_PAGE_SIZE, cursor: null });
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
    const page = await Promise.all(replies.page.map(reply => replyRow(reply, userId, author)));
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

/**
 * The author's text only, after the fact (#287). Whether the edit is still needed: not for a retry of the operation that
 * made the last edit, nor for a body that changes nothing. Only an edit that writes spends the writer's quota.
 */
async function editDue(ctx: MutationCtx, row: { body: string; editOperationId?: string }, userId: string, repoId: number, body: string, clientOperationId?: string) {
  if ((clientOperationId !== undefined && row.editOperationId === clientOperationId) || row.body === body) return false;
  await consumeWriteQuota(ctx, "comments", userId, `repo:${repoId}`);
  return true;
}

/**
 * Editing a thread is its author's alone, like archive and delete. Status does not matter, as for replies and resolving:
 * an author may correct a resolved or archived thread too. A deleted one is "not found".
 */
export const editThread = mutation({
  args: { ...scopeArgs, ...operationArgs, threadId: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const { user, thread } = await writableThread(ctx, args);
    if (thread.authorId !== user._id) publicError("forbidden");
    const body = commentBody(args.body);
    if (!await editDue(ctx, thread, user._id, args.repoId, body, args.clientOperationId)) return null;
    const now = Date.now();
    await ctx.db.patch(thread._id, { body, editedAt: now, editOperationId: args.clientOperationId, updatedAt: now });
    return null;
  },
});

/** A reply is edited by its author alone, on a live thread of this document. */
export const editReply = mutation({
  args: { ...scopeArgs, ...operationArgs, threadId: v.string(), replyId: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const { user, thread } = await writableThread(ctx, args);
    const replyId = normalizeId(ctx, "repoReplies", args.replyId);
    const reply = replyId ? await ctx.db.get(replyId) : null;
    if (!reply || reply.threadId !== thread._id || reply.deletedAt !== undefined) publicError("not_found");
    if (reply.authorId !== user._id) publicError("forbidden");
    const body = commentBody(args.body);
    if (!await editDue(ctx, reply, user._id, args.repoId, body, args.clientOperationId)) return null;
    await ctx.db.patch(reply._id, { body, editedAt: Date.now(), editOperationId: args.clientOperationId });
    return null;
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
