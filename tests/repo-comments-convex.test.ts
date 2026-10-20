import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import betterAuthSchema from "../convex/betterAuth/schema";
import {
  GRANT_MAX_MS, PURGE_REPLY_BATCH, PURGE_THREAD_BATCH, REMOVAL_SETTLE_MS, REMOVED_REPO_RETENTION_MS, REVOKE_BATCH,
} from "../convex/repoCommentAccess";
import { MAX_COMMENT_LENGTH, MAX_QUOTE_CONTEXT, MAX_QUOTE_LENGTH, REPO_REPLY_CLEANUP_BATCH, REPO_REPLY_PREVIEW_SIZE, validRepoAnchor, validRepoPath } from "../convex/repoComments";
import schema from "../convex/schema";
import rateLimiterTest from "./convex-rate-limiter";

const modules = import.meta.glob("../convex/**/*.ts");
const internalSecret = process.env.CONVEX_INTERNAL_SECRET!;
const PUBLIC = 9001;
const PRIVATE = 9002;
const OTHER = 9003;
const BLOB = "a".repeat(40);
const pageOpts = { cursor: null, numItems: 20 };

afterEach(() => vi.useRealTimers());

function anchor(overrides: Record<string, unknown> = {}) {
  return { kind: "repo-text" as const, blobSha: BLOB, headingSlug: "install", prefix: "Run ", exact: "pnpm install", suffix: " first", offset: 4, ...overrides };
}

async function world() {
  const backend = convexTest(schema, modules);
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const now = Date.now();
  const users = await backend.run(async (ctx) => Object.fromEntries(await Promise.all(["reader", "other", "nameless"].map(async (name) => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: { name: name === "nameless" ? "" : name, email: `${name}@example.test`, emailVerified: true, createdAt: now, updatedAt: now } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: { token: name, userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 3_600_000 } },
    });
    return [name, { userId: user._id as string, sessionId: session._id as string }] as const;
  }))));
  const as = (name: "reader" | "other" | "nameless") => backend.withIdentity({ subject: users[name].userId, sessionId: users[name].sessionId });
  const grant = (repoId: number, userId: string | null, options: { epoch?: number; ttl?: number } = {}) => backend.mutation(api.repoCommentAccess.grant, {
    internalSecret, repoId, userId, epoch: options.epoch ?? 0, expiresAt: Date.now() + (options.ttl ?? 60_000),
  });
  return { backend, users, as, grant, anonymous: backend };
}

const scope = (repoId: number, path = "docs/guide.md") => ({ repoId, path });

describe("repository comment access (Convex boundary)", () => {
  it("records grants only through the internal secret, validates them and never lets one outlive five minutes", async () => {
    const { backend, grant } = await world();
    await expect(backend.mutation(api.repoCommentAccess.grant, { internalSecret: "wrong", repoId: PUBLIC, userId: null, epoch: 0, expiresAt: Date.now() + 1_000 }))
      .rejects.toThrow("Forbidden");
    for (const bad of [{ repoId: 0 }, { repoId: 1.5 }, { userId: "" }, { userId: "u".repeat(257) }, { epoch: -1 }, { epoch: 0.5 }, { expiresAt: 1.5 }]) {
      await expect(backend.mutation(api.repoCommentAccess.grant, { internalSecret, repoId: PUBLIC, userId: null, epoch: 0, expiresAt: Date.now() + 1_000, ...bad }))
        .rejects.toThrow("Invalid input");
    }
    expect(await backend.mutation(api.repoCommentAccess.grant, { internalSecret, repoId: PUBLIC, userId: null, epoch: 0, expiresAt: Date.now() - 1 }))
      .toEqual({ granted: false });
    const before = Date.now();
    const answer = await grant(PUBLIC, null, { ttl: 60 * 60_000 });
    expect(answer.granted && answer.expiresAt - before).toBeLessThanOrEqual(GRANT_MAX_MS + 50);
    expect(await backend.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(1);
    // Extending an existing grant patches it; the pending expiry job re-schedules itself.
    await grant(PUBLIC, null, { ttl: 2 * 60 * 60_000 });
    expect(await backend.run(ctx => ctx.db.query("repoCommentGrants").collect())).toHaveLength(1);
    expect(await backend.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(1);
    // A shorter grant never shortens one already held, and one barely longer is not written (it would re-run every query).
    const held = (await backend.run(ctx => ctx.db.query("repoCommentGrants").first()))!.expiresAt;
    expect(await grant(PUBLIC, null, { ttl: 1_000 })).toEqual({ granted: true, expiresAt: held });
    expect(await grant(PUBLIC, null, { ttl: GRANT_MAX_MS })).toEqual({ granted: true, expiresAt: held });
  });

  it("expires grants by a scheduled function, so queries never compare times", async () => {
    vi.useFakeTimers();
    const { backend, anonymous, grant } = await world();
    await grant(PUBLIC, null, { ttl: 10_000 });
    expect((await anonymous.query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts })).isDone).toBe(true);
    // Extended before the first job fires: the job finds a later expiry and re-schedules.
    vi.advanceTimersByTime(5_000);
    await grant(PUBLIC, null, { ttl: 20_000 });
    vi.advanceTimersByTime(5_000);
    await backend.finishInProgressScheduledFunctions();
    expect(await backend.run(ctx => ctx.db.query("repoCommentGrants").collect())).toHaveLength(1);
    vi.advanceTimersByTime(20_000);
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run(ctx => ctx.db.query("repoCommentGrants").collect())).toEqual([]);
    // A job for a grant already gone does nothing.
    const grantId = await backend.run(ctx => ctx.db.insert("repoCommentGrants", { repoId: PUBLIC, userId: null, epoch: 0, expiresAt: 0 }));
    await backend.run(ctx => ctx.db.delete(grantId));
    await backend.mutation(internal.repoCommentAccess.expireGrant, { grantId });
  });

  it("lets anyone read a public repository's comments, and only signed-in readers write", async () => {
    const { anonymous, as, grant } = await world();
    await grant(PUBLIC, null);
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: " Looks good ", anchor: anchor() });
    const page = await anonymous.query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts });
    expect(page.page).toEqual([expect.objectContaining({
      _id: threadId, body: "Looks good", blobSha: BLOB, anchor: anchor(), path: "docs/guide.md", repoId: PUBLIC,
      resolved: false, archived: false, canDelete: false, authorName: "reader", authorEmail: "", replies: [], repliesHasMore: false,
    })]);
    expect((await as("reader").query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts })).page[0].canDelete).toBe(true);
    await expect(anonymous.mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Drive-by", anchor: anchor() })).rejects.toThrow("Unauthenticated");
    await expect(anonymous.mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "Drive-by" })).rejects.toThrow("Unauthenticated");
    await as("other").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "Me too" });
    expect((await anonymous.query(api.repoComments.listReplies, { ...scope(PUBLIC), threadId, paginationOpts: pageOpts })).page)
      .toEqual([expect.objectContaining({ body: "Me too", authorName: "other", authorEmail: "", canDelete: false })]);
    // Invalid repository IDs read like repositories nobody may see.
    expect((await anonymous.query(api.repoComments.listThreads, { ...scope(0), paginationOpts: pageOpts })).page).toEqual([]);
    // Another document of the same repository is its own thread set.
    expect((await anonymous.query(api.repoComments.listThreads, { ...scope(PUBLIC, "docs/other.md"), paginationOpts: pageOpts })).page).toEqual([]);
  });

  it("denies a private repository's comments to everyone but the granted reader, revealing nothing", async () => {
    const { users, anonymous, as, grant } = await world();
    await grant(PRIVATE, users.reader.userId);
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Private note", anchor: anchor() });
    const replyId = await as("reader").mutation(api.repoComments.addReply, { ...scope(PRIVATE), threadId, body: "Reply" });
    for (const viewer of [anonymous, as("other")]) {
      const denied = await viewer.query(api.repoComments.listThreads, { ...scope(PRIVATE), paginationOpts: pageOpts });
      // Exactly what a repository nobody has ever commented on returns.
      expect(denied).toEqual(await viewer.query(api.repoComments.listThreads, { ...scope(OTHER), paginationOpts: pageOpts }));
      expect(denied).toEqual({ page: [], isDone: true, continueCursor: "" });
      expect(await viewer.query(api.repoComments.listReplies, { ...scope(PRIVATE), threadId, paginationOpts: pageOpts })).toEqual(denied);
    }
    const missing = "Comment not found";
    for (const call of [
      () => as("other").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "x", anchor: anchor() }),
      () => as("other").mutation(api.repoComments.addReply, { ...scope(PRIVATE), threadId, body: "x" }),
      () => as("other").mutation(api.repoComments.resolve, { ...scope(PRIVATE), threadId, resolved: true }),
      () => as("other").mutation(api.repoComments.archive, { ...scope(PRIVATE), threadId, archived: true }),
      () => as("other").mutation(api.repoComments.removeThread, { ...scope(PRIVATE), threadId }),
      () => as("other").mutation(api.repoComments.removeReply, { ...scope(PRIVATE), threadId, replyId }),
      () => anonymous.mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "x", anchor: anchor() }),
    ]) await expect(call()).rejects.toThrow(missing);
  });

  it("refuses cross-repository thread and reply IDs exactly like missing ones", async () => {
    const { users, as, grant } = await world();
    await grant(PUBLIC, null);
    await grant(PRIVATE, users.reader.userId);
    const privateThread = await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Secret", anchor: anchor() });
    const privateReply = await as("reader").mutation(api.repoComments.addReply, { ...scope(PRIVATE), threadId: privateThread, body: "Secret reply" });
    const publicThread = await as("other").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Open", anchor: anchor() });
    // `other` may write on the public repository, never through it into the private one.
    for (const call of [
      () => as("other").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId: privateThread, body: "x" }),
      () => as("other").mutation(api.repoComments.resolve, { ...scope(PUBLIC), threadId: privateThread, resolved: true }),
      () => as("other").mutation(api.repoComments.removeThread, { ...scope(PUBLIC), threadId: privateThread }),
      () => as("other").mutation(api.repoComments.removeReply, { ...scope(PUBLIC), threadId: publicThread, replyId: privateReply }),
      () => as("other").mutation(api.repoComments.removeReply, { ...scope(PUBLIC), threadId: privateThread, replyId: privateReply }),
      () => as("reader").mutation(api.repoComments.addReply, { ...scope(PRIVATE, "docs/other.md"), threadId: privateThread, body: "x" }),
      () => as("other").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId: "not-an-id", body: "x" }),
      () => as("other").mutation(api.repoComments.removeReply, { ...scope(PUBLIC), threadId: publicThread, replyId: "not-an-id" }),
      () => as("other").mutation(api.repoComments.removeReply, { ...scope(PUBLIC), threadId: "not-an-id", replyId: privateReply }),
      () => as("other").mutation(api.repoComments.removeThread, { ...scope(PUBLIC), threadId: "not-an-id" }),
    ]) await expect(call()).rejects.toThrow("Comment not found");
    expect(await as("other").query(api.repoComments.listReplies, { ...scope(PUBLIC), threadId: privateThread, paginationOpts: pageOpts })).toEqual({ page: [], isDone: true, continueCursor: "" });
    expect(await as("other").query(api.repoComments.listReplies, { ...scope(PUBLIC), threadId: "not-an-id", paginationOpts: pageOpts })).toEqual({ page: [], isDone: true, continueCursor: "" });
  });

  it("rejects forged anchors, invalid paths, oversized text and page sizes", async () => {
    const { as, grant } = await world();
    await grant(PUBLIC, null);
    const create = (overrides: Record<string, unknown>) => as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "x", anchor: anchor(), ...overrides } as never);
    for (const bad of [
      { anchor: anchor({ blobSha: "nothex" }) }, { anchor: anchor({ blobSha: "A".repeat(40) }) },
      { anchor: anchor({ headingSlug: "a b" }) }, { anchor: anchor({ headingSlug: "x".repeat(257) }) }, { anchor: anchor({ headingSlug: "a\u0000" }) },
      { anchor: anchor({ exact: "  " }) }, { anchor: anchor({ exact: "x".repeat(MAX_QUOTE_LENGTH + 1) }) },
      { anchor: anchor({ prefix: "p".repeat(MAX_QUOTE_CONTEXT + 1) }) }, { anchor: anchor({ suffix: "s".repeat(MAX_QUOTE_CONTEXT + 1) }) },
      { anchor: anchor({ offset: -1 }) }, { anchor: anchor({ offset: 0.5 }) }, { anchor: anchor({ offset: 1e9 }) },
      { anchor: { kind: "text-range", quote: "x", path: ["p"], startOffset: 0, endOffset: 1 } },
      { anchor: { ...anchor(), extra: true } },
      { path: "../secret.md" }, { path: "docs//a.md" }, { path: "docs\\a.md" }, { path: "a\u0001.md" }, { path: "" }, { path: "a/".repeat(600) + "x" },
      { body: "   " }, { body: "x".repeat(MAX_COMMENT_LENGTH + 1) },
      { clientOperationId: " " }, { clientOperationId: "x".repeat(129) },
    ]) await expect(create(bad)).rejects.toThrow("Invalid input");
    await expect(create({ expectedAuthorId: "someone-else" })).rejects.toThrow("Forbidden");
    expect(await create({ anchor: anchor({ blobSha: "b".repeat(64), headingSlug: "" }) })).toEqual(expect.any(String));
    const threadId = await create({});
    await expect(as("reader").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "x".repeat(MAX_COMMENT_LENGTH + 1) })).rejects.toThrow("Invalid input");
    for (const numItems of [0, 21, 1.5]) {
      await expect(as("reader").query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: { cursor: null, numItems } })).rejects.toThrow("Invalid input");
      await expect(as("reader").query(api.repoComments.listReplies, { ...scope(PUBLIC), threadId, paginationOpts: { cursor: null, numItems } })).rejects.toThrow("Invalid input");
    }
    expect((await as("reader").query(api.repoComments.listThreads, { ...scope(PUBLIC, "../x"), paginationOpts: pageOpts })).page).toEqual([]);
    expect(validRepoPath("docs/a.md") && !validRepoPath("docs/./a.md")).toBe(true);
    expect(validRepoAnchor(anchor())).toBe(true);
  });

  it("treats an identity whose session is gone as anonymous, and names deleted authors neutrally", async () => {
    const { backend, users, as, grant } = await world();
    await grant(PRIVATE, users.reader.userId);
    await grant(PUBLIC, null);
    const threadId = await as("other").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Soon orphaned", anchor: anchor() });
    await backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model: "user", where: [{ field: "_id", value: users.other.userId }] } }));
    expect((await as("reader").query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts })).page[0])
      .toMatchObject({ _id: threadId, authorName: "Former reader" });
    await backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model: "session", where: [{ field: "_id", value: users.reader.sessionId }] } }));
    expect((await as("reader").query(api.repoComments.listThreads, { ...scope(PRIVATE), paginationOpts: pageOpts })).page).toEqual([]);
    await expect(as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "x", anchor: anchor() })).rejects.toThrow("Unauthenticated");
  });

  it("rate limits writers per user, on public repositories too", async () => {
    const { as, grant } = await world();
    await grant(PUBLIC, null);
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "first", anchor: anchor() });
    for (let index = 1; index < 30; index += 1) await as("reader").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: `reply ${index}` });
    await expect(as("reader").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "one too many" })).rejects.toThrow(/rate/i);
    await expect(as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "one too many", anchor: anchor() })).rejects.toThrow(/rate/i);
    // Another reader keeps their own budget.
    await as("other").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "mine" });
  });

  it("creates, replies, resolves, archives and deletes, deduplicating retried operations", async () => {
    vi.useFakeTimers();
    const { backend, users, as, grant } = await world();
    await grant(PRIVATE, users.reader.userId);
    await grant(PRIVATE, users.other.userId);
    await grant(PRIVATE, users.nameless.userId);
    const operation = { clientOperationId: "op-1", expectedAuthorId: users.reader.userId };
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Thread", anchor: anchor(), ...operation });
    expect(await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Retry", anchor: anchor(), ...operation })).toBe(threadId);
    const replyId = await as("other").mutation(api.repoComments.addReply, { ...scope(PRIVATE), threadId, body: "Reply", clientOperationId: "r-1" });
    expect(await as("other").mutation(api.repoComments.addReply, { ...scope(PRIVATE), threadId, body: "Retry", clientOperationId: "r-1" })).toBe(replyId);
    await as("nameless").mutation(api.repoComments.addReply, { ...scope(PRIVATE), threadId, body: "Anonymous name" });
    const listed = (await as("reader").query(api.repoComments.listThreads, { ...scope(PRIVATE), paginationOpts: pageOpts })).page[0];
    expect(listed.replies.map(reply => [reply.body, reply.authorName, reply.canDelete])).toEqual([["Reply", "other", false], ["Anonymous name", "Former reader", false]]);
    expect((await as("other").query(api.repoComments.listReplies, { ...scope(PRIVATE), threadId, paginationOpts: pageOpts })).page.map(reply => reply.canDelete)).toEqual([false, true]);

    // Anyone who may write may resolve; the explicit target makes a retry a no-op.
    expect(await as("other").mutation(api.repoComments.resolve, { ...scope(PRIVATE), threadId, resolved: true })).toBe(true);
    expect(await as("other").mutation(api.repoComments.resolve, { ...scope(PRIVATE), threadId, resolved: true })).toBe(true);
    expect(await as("reader").mutation(api.repoComments.resolve, { ...scope(PRIVATE), threadId, resolved: false })).toBe(false);
    // Archive and delete belong to the author.
    await expect(as("other").mutation(api.repoComments.archive, { ...scope(PRIVATE), threadId, archived: true })).rejects.toThrow("Forbidden");
    expect(await as("reader").mutation(api.repoComments.archive, { ...scope(PRIVATE), threadId, archived: true })).toBe(true);
    expect(await as("reader").mutation(api.repoComments.archive, { ...scope(PRIVATE), threadId, archived: true })).toBe(true);
    await expect(as("reader").mutation(api.repoComments.removeReply, { ...scope(PRIVATE), threadId, replyId })).rejects.toThrow("Forbidden");
    await as("other").mutation(api.repoComments.removeReply, { ...scope(PRIVATE), threadId, replyId });
    await as("other").mutation(api.repoComments.removeReply, { ...scope(PRIVATE), threadId, replyId });
    await expect(as("reader").mutation(api.repoComments.removeReply, { ...scope(PRIVATE), threadId, replyId })).rejects.toThrow("Comment not found");
    await expect(as("other").mutation(api.repoComments.removeThread, { ...scope(PRIVATE), threadId })).rejects.toThrow("Forbidden");
    await as("reader").mutation(api.repoComments.removeThread, { ...scope(PRIVATE), threadId });
    await as("reader").mutation(api.repoComments.removeThread, { ...scope(PRIVATE), threadId });
    await expect(as("other").mutation(api.repoComments.removeThread, { ...scope(PRIVATE), threadId })).rejects.toThrow("Comment not found");
    expect((await as("reader").query(api.repoComments.listThreads, { ...scope(PRIVATE), paginationOpts: pageOpts })).page).toEqual([]);
    // A deleted thread takes no replies, and its live replies cannot be removed one by one any more.
    await expect(as("other").mutation(api.repoComments.addReply, { ...scope(PRIVATE), threadId, body: "late" })).rejects.toThrow("Comment not found");
    const live = (await backend.run(ctx => ctx.db.query("repoReplies").collect())).find(reply => reply.deletedAt === undefined)!;
    await expect(as("nameless").mutation(api.repoComments.removeReply, { ...scope(PRIVATE), threadId, replyId: live._id })).rejects.toThrow("Comment not found");
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect((await backend.run(ctx => ctx.db.query("repoReplies").collect())).every(reply => reply.deletedAt !== undefined && reply.body === "")).toBe(true);
    expect(await backend.run(ctx => ctx.db.get(threadId))).toMatchObject({ body: "", anchor: { exact: "-", prefix: "", suffix: "" } });
    // A retried create after deletion still finds its tombstone instead of resurrecting the comment.
    // (Running every timer above also expired the grants.)
    await grant(PRIVATE, users.reader.userId);
    expect(await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Thread", anchor: anchor(), ...operation })).toBe(threadId);
  });

  it("cleans up a deleted thread's replies in batches and previews only the newest replies", async () => {
    vi.useFakeTimers();
    const { backend, users, as, grant } = await world();
    await grant(PRIVATE, users.reader.userId);
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Thread", anchor: anchor() });
    await backend.run(async ctx => {
      for (let index = 0; index < REPO_REPLY_CLEANUP_BATCH + 5; index += 1) {
        await ctx.db.insert("repoReplies", { repoId: PRIVATE, threadId, authorId: users.reader.userId, body: `r${index}`, createdAt: index });
      }
    });
    const thread = (await as("reader").query(api.repoComments.listThreads, { ...scope(PRIVATE), paginationOpts: pageOpts })).page[0];
    expect(thread.replies).toHaveLength(REPO_REPLY_PREVIEW_SIZE);
    expect(thread.repliesHasMore).toBe(true);
    await as("reader").mutation(api.repoComments.removeThread, { ...scope(PRIVATE), threadId });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect((await backend.run(ctx => ctx.db.query("repoReplies").collect())).filter(reply => reply.deletedAt === undefined)).toEqual([]);
    // A cleanup for a live or missing thread does nothing. (Running every timer above also expired the grant.)
    await grant(PRIVATE, users.reader.userId);
    const liveId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Live", anchor: anchor() });
    await backend.mutation(internal.repoComments.cleanupDeletedThread, { threadId: liveId });
    expect(await backend.run(ctx => ctx.db.get(liveId))).toMatchObject({ body: "Live" });
    await backend.run(ctx => ctx.db.delete(liveId));
    await backend.mutation(internal.repoComments.cleanupDeletedThread, { threadId: liveId });
  });

  it("revokes a user's grants at P5's epoch, and refuses a grant decided before it", async () => {
    vi.useFakeTimers();
    const { backend, users, as, grant } = await world();
    await grant(PRIVATE, users.reader.userId, { epoch: 10 });
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Note", anchor: anchor() });
    expect((await as("reader").query(api.repoComments.listThreads, { ...scope(PRIVATE), paginationOpts: pageOpts })).page).toHaveLength(1);
    await expect((backend.mutation as (...args: unknown[]) => Promise<unknown>)(api.repoComments.resolve, {})).rejects.toThrow("Invalid input");
    await expect(backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret: "wrong", userId: users.reader.userId, epoch: 20 })).rejects.toThrow("Forbidden");
    await expect(backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: "", epoch: 20 })).rejects.toThrow("Invalid input");
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.reader.userId, epoch: 20 });
    expect((await as("reader").query(api.repoComments.listThreads, { ...scope(PRIVATE), paginationOpts: pageOpts })).page).toEqual([]);
    await expect(as("reader").mutation(api.repoComments.addReply, { ...scope(PRIVATE), threadId, body: "late" })).rejects.toThrow("Comment not found");
    // Decided before the bump, arriving after it.
    expect(await grant(PRIVATE, users.reader.userId, { epoch: 15 })).toEqual({ granted: false });
    expect((await grant(PRIVATE, users.reader.userId, { epoch: 20 })).granted).toBe(true);
    // A later bump raises the recorded epoch; an older one never lowers it.
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.reader.userId, epoch: 25 });
    expect(await grant(PRIVATE, users.reader.userId, { epoch: 20 })).toEqual({ granted: false });
    expect((await grant(PRIVATE, users.reader.userId, { epoch: 25 })).granted).toBe(true);
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.reader.userId, epoch: 5 });
    expect(await grant(PRIVATE, users.reader.userId, { epoch: 24 })).toEqual({ granted: false });
    // Many grants go in batches.
    await backend.run(async ctx => {
      for (let repoId = 1; repoId <= REVOKE_BATCH + 3; repoId += 1) await ctx.db.insert("repoCommentGrants", { repoId, userId: users.other.userId, epoch: 0, expiresAt: Date.now() + 60_000 });
    });
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.other.userId, epoch: 30 });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect((await backend.run(ctx => ctx.db.query("repoCommentGrants").collect())).filter(row => row.userId === users.other.userId)).toEqual([]);
  });

  it("serves the Worker the first page a reader would see, refusing what a grant would (#284)", async () => {
    const { backend, users, as, grant } = await world();
    const snapshot = (args: Record<string, unknown> = {}) => backend.query(api.repoComments.threadSnapshot, {
      internalSecret, ...scope(PRIVATE), userId: users.reader.userId, epoch: 10, ...args,
    } as never);
    await expect(snapshot({ internalSecret: "wrong" })).rejects.toThrow("Forbidden");
    for (const bad of [{ path: "../x.md" }, { repoId: 0 }, { userId: "" }, { epoch: -1 }, { epoch: 0.5 }]) {
      await expect(snapshot(bad)).rejects.toThrow("Invalid input");
    }
    // A repository no reader has seen has no comments: nothing to read.
    expect(await snapshot()).toMatchObject({ page: [], isDone: true });
    await grant(PRIVATE, users.reader.userId, { epoch: 10 });
    await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Mine", anchor: anchor(), clientOperationId: "op-1" });
    const live = await as("reader").query(api.repoComments.listThreads, { ...scope(PRIVATE), paginationOpts: pageOpts });
    // Before any grant of its own exists in Convex, the page is the one the live query will give this reader.
    await backend.run(async ctx => {
      for (const row of await ctx.db.query("repoCommentGrants").collect()) await ctx.db.delete(row._id);
    });
    const first = await snapshot();
    expect(first.page).toEqual(live.page);
    expect(first.page).toEqual([expect.objectContaining({ body: "Mine", clientOperationId: "op-1", canDelete: true, authorName: "reader", authorEmail: "" })]);
    // A public page names no reader: nothing in it is anyone's to delete.
    expect((await snapshot({ userId: null })).page).toEqual([expect.objectContaining({ canDelete: false })]);
    expect((await snapshot({ path: "docs/other.md" })).page).toEqual([]);
    // Decided before a revocation Convex already holds: refused, as the grant would be.
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.reader.userId, epoch: 20 });
    expect((await snapshot()).page).toEqual([]);
    expect((await snapshot({ epoch: 20 })).page).toHaveLength(1);
    // A removed repository's comments are hidden from the snapshot at once, like everywhere else.
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PRIVATE] });
    expect((await snapshot({ epoch: 20 })).page).toEqual([]);
  });

  it("reads a public first page for the signed-in reader the Worker names, deciding access as the public grant does (#303)", async () => {
    const { backend, users, as, grant } = await world();
    const snapshot = (args: Record<string, unknown> = {}) => backend.query(api.repoComments.threadSnapshot, {
      internalSecret, ...scope(PUBLIC), userId: null, epoch: 0, ...args,
    } as never);
    // A viewer only says whom a page is read for: it never names a reader for a grant that already has one.
    for (const bad of [{ viewerId: "" }, { viewerId: "x".repeat(257) }, { userId: users.reader.userId, viewerId: users.reader.userId }]) {
      await expect(snapshot(bad)).rejects.toThrow("Invalid input");
    }
    await grant(PUBLIC, null);
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Mine", anchor: anchor() });
    await as("other").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "Theirs" });
    await as("reader").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "Mine too" });
    const live = await as("reader").query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts });
    // The author's page is the one their live subscription gives them: their thread and reply are theirs to delete.
    const mine = await snapshot({ viewerId: users.reader.userId });
    expect(mine.page).toEqual(live.page);
    expect(mine.page).toEqual([expect.objectContaining({ body: "Mine", canDelete: true, replies: [
      expect.objectContaining({ body: "Theirs", canDelete: false }), expect.objectContaining({ body: "Mine too", canDelete: true }),
    ] })]);
    // Another reader's page holds the same thread, with only their own reply theirs; the anonymous page, nothing.
    expect((await snapshot({ viewerId: users.other.userId })).page).toEqual([expect.objectContaining({ body: "Mine", canDelete: false, replies: [
      expect.objectContaining({ body: "Theirs", canDelete: true }), expect.objectContaining({ body: "Mine too", canDelete: false }),
    ] })]);
    expect((await snapshot()).page).toEqual([expect.objectContaining({ body: "Mine", canDelete: false, replies: [
      expect.objectContaining({ body: "Theirs", canDelete: false }), expect.objectContaining({ body: "Mine too", canDelete: false }),
    ] })]);
    // A revocation of the reader elsewhere changes nothing here: the page is public, so anyone may read it.
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.reader.userId, epoch: 20 });
    expect((await snapshot({ viewerId: users.reader.userId })).page).toHaveLength(1);
    // What the grant refuses, the snapshot refuses, whoever it is read for: a removed repository shows nothing.
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC] });
    expect((await snapshot({ viewerId: users.reader.userId })).page).toEqual([]);
    expect(await grant(PUBLIC, null)).toEqual({ granted: false });
  });

  it("checks a writer's grant expiry in the mutation even before the expiry job ran", async () => {
    vi.useFakeTimers();
    const { as, grant } = await world();
    await grant(PUBLIC, null, { ttl: 1_000 });
    vi.advanceTimersByTime(2_000);
    await expect(as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "late", anchor: anchor() })).rejects.toThrow("Comment not found");
  });

  it("hides an uninstalled repository's comments at once and purges them only when asked after the retention window", async () => {
    vi.useFakeTimers();
    const { backend, users, anonymous, as, grant } = await world();
    await grant(PUBLIC, null);
    await grant(PUBLIC, users.reader.userId);
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Keep?", anchor: anchor() });
    await as("reader").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "Reply" });
    await expect(backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret: "wrong", repoIds: [PUBLIC] })).rejects.toThrow("Forbidden");
    await expect(backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [0] })).rejects.toThrow("Invalid input");
    await expect(backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: Array.from({ length: 101 }, (_, index) => index + 1) })).rejects.toThrow("Invalid input");
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC, PUBLIC, OTHER] });
    expect((await anonymous.query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts })).page).toEqual([]);
    expect(await backend.run(ctx => ctx.db.query("repoCommentGrants").collect())).toEqual([]);
    // A grant decided just before the removal does not bring the comments back...
    expect(await grant(PUBLIC, null)).toEqual({ granted: false });
    // ...and removing again keeps the first removal time.
    const removedAt = (await backend.run(ctx => ctx.db.query("repoCommentRepos").first()))!.removedAt!;
    vi.advanceTimersByTime(1_000);
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC] });
    expect((await backend.run(ctx => ctx.db.query("repoCommentRepos").first()))!.removedAt).toBe(removedAt);
    // Convex never purges on its own (#258): no job waits for the window, and nothing goes when it ends.
    expect(await backend.run(ctx => ctx.db.system.query("_scheduled_functions").filter(q => q.eq(q.field("name"), "repoCommentAccess:purgeRepo")).collect())).toEqual([]);
    vi.advanceTimersByTime(REMOVED_REPO_RETENTION_MS + 1);
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run(ctx => ctx.db.query("repoThreads").collect())).toHaveLength(1);
    // A purge job scheduled any other way than a confirmed purge does nothing.
    await backend.mutation(internal.repoCommentAccess.purgeRepo, { repoId: PUBLIC, removedAt });
    expect(await backend.run(ctx => ctx.db.query("repoThreads").collect())).toHaveLength(1);
    // The control Worker confirmed the removal with GitHub: now it goes, with an audit event.
    expect(await backend.mutation(api.repoCommentAccess.purgeRepos, { internalSecret, repoIds: [PUBLIC, PUBLIC, OTHER] })).toEqual({ notDue: [] });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run(ctx => ctx.db.query("repoThreads").collect())).toEqual([]);
    expect(await backend.run(ctx => ctx.db.query("repoReplies").collect())).toEqual([]);
    expect(await backend.run(ctx => ctx.db.query("repoCommentRepos").collect())).toEqual([]);
    expect(await backend.run(ctx => ctx.db.query("auditEvents").withIndex("by_resource", q => q.eq("resourceType", "repository").eq("resourceId", String(PUBLIC))).collect()))
      .toMatchObject([{ action: "repository.comments_purged", actorId: "repo-access", metadata: { removedAt } }]);
  });

  it("purges only through the internal secret, and names what Convex's own window still keeps", async () => {
    vi.useFakeTimers();
    const { backend, as, grant } = await world();
    await grant(PUBLIC, null);
    await grant(OTHER, null);
    await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Early", anchor: anchor() });
    for (const name of ["purgeRepos", "restoreRepos"] as const) {
      await expect(backend.mutation(api.repoCommentAccess[name], { internalSecret: "wrong", repoIds: [PUBLIC] })).rejects.toThrow("Forbidden");
      await expect(backend.mutation(api.repoCommentAccess[name], { internalSecret, repoIds: [1.5] })).rejects.toThrow("Invalid input");
    }
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC] });
    const removedAt = Date.now();
    // Asked too early (the removal reached Convex later than the control Worker heard it): nothing goes, and the answer says when.
    vi.advanceTimersByTime(REMOVED_REPO_RETENTION_MS - 1_000);
    expect(await backend.mutation(api.repoCommentAccess.purgeRepos, { internalSecret, repoIds: [PUBLIC, OTHER, PRIVATE] }))
      .toEqual({ notDue: [{ repoId: PUBLIC, dueAt: removedAt + REMOVED_REPO_RETENTION_MS }] });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run(ctx => ctx.db.query("repoThreads").collect())).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(await backend.mutation(api.repoCommentAccess.purgeRepos, { internalSecret, repoIds: [PUBLIC] })).toEqual({ notDue: [] });
    // Asked again while it runs: one purge.
    expect(await backend.mutation(api.repoCommentAccess.purgeRepos, { internalSecret, repoIds: [PUBLIC] })).toEqual({ notDue: [] });
    expect(await backend.run(ctx => ctx.db.system.query("_scheduled_functions").filter(q => q.eq(q.field("name"), "repoCommentAccess:purgeRepo")).collect())).toHaveLength(1);
  });

  it("restores a repository GitHub still grants: its comments show again and a running purge stops", async () => {
    vi.useFakeTimers();
    const { backend, anonymous, as, grant } = await world();
    await grant(PUBLIC, null);
    await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Replayed", anchor: anchor() });
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC] });
    const removedAt = Date.now();
    vi.advanceTimersByTime(REMOVED_REPO_RETENTION_MS);
    await backend.mutation(api.repoCommentAccess.purgeRepos, { internalSecret, repoIds: [PUBLIC] });
    // Restored before the scheduled batch ran: the batch finds the repository back and deletes nothing.
    await backend.mutation(api.repoCommentAccess.restoreRepos, { internalSecret, repoIds: [PUBLIC, OTHER] });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run(ctx => ctx.db.query("repoThreads").collect())).toHaveLength(1);
    expect(await backend.run(async ctx => {
      const row = await ctx.db.query("repoCommentRepos").first();
      return [row?.removedAt ?? null, row?.purgeConfirmedAt ?? null];
    })).toEqual([null, null]);
    expect((await backend.run(ctx => ctx.db.query("auditEvents").collect())).map(event => [event.action, event.resourceId, event.metadata as unknown]))
      .toEqual([["repository.comments_purged", String(PUBLIC), { removedAt }], ["repository.removal_reverted", String(PUBLIC), { removedAt }]]);
    // Readers come back through grants as before; restoring a visible repository again records nothing.
    expect((await grant(PUBLIC, null)).granted).toBe(true);
    expect((await anonymous.query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts })).page).toHaveLength(1);
    await backend.mutation(api.repoCommentAccess.restoreRepos, { internalSecret, repoIds: [PUBLIC] });
    expect(await backend.run(ctx => ctx.db.query("auditEvents").collect())).toHaveLength(2);
  });

  it("keeps a reinstalled repository's comments: a later grant cancels the purge", async () => {
    vi.useFakeTimers();
    const { backend, anonymous, as, grant } = await world();
    await grant(PUBLIC, null);
    await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Survives", anchor: anchor() });
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC] });
    vi.advanceTimersByTime(REMOVAL_SETTLE_MS + 1);
    expect((await grant(PUBLIC, null)).granted).toBe(true);
    expect((await anonymous.query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts })).page).toHaveLength(1);
    vi.advanceTimersByTime(REMOVED_REPO_RETENTION_MS);
    // Nothing hidden: a confirmed purge has nothing to do.
    expect(await backend.mutation(api.repoCommentAccess.purgeRepos, { internalSecret, repoIds: [PUBLIC] })).toEqual({ notDue: [] });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run(ctx => ctx.db.query("repoThreads").collect())).toHaveLength(1);
  });

  it("clears a confirmed purge when a later grant brings the repository back", async () => {
    vi.useFakeTimers();
    const { backend, grant } = await world();
    await grant(PUBLIC, null);
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC] });
    vi.advanceTimersByTime(REMOVED_REPO_RETENTION_MS);
    await backend.mutation(api.repoCommentAccess.purgeRepos, { internalSecret, repoIds: [PUBLIC] });
    expect((await grant(PUBLIC, null)).granted).toBe(true);
    expect(await backend.run(async ctx => {
      const row = await ctx.db.query("repoCommentRepos").first();
      return [row?.removedAt ?? null, row?.purgeConfirmedAt ?? null];
    })).toEqual([null, null]);
  });

  it("purges a large repository in bounded batches", async () => {
    vi.useFakeTimers();
    const { backend, users, grant } = await world();
    await grant(PUBLIC, null);
    await backend.run(async ctx => {
      for (let index = 0; index < PURGE_THREAD_BATCH + 2; index += 1) {
        const threadId = await ctx.db.insert("repoThreads", {
          repoId: PUBLIC, path: "a.md", blobSha: BLOB, anchor: anchor(), authorId: users.reader.userId, body: "t", resolved: false, archived: false, createdAt: index, updatedAt: index,
        });
        if (index === 0) for (let reply = 0; reply < PURGE_REPLY_BATCH + 1; reply += 1) {
          await ctx.db.insert("repoReplies", { repoId: PUBLIC, threadId, authorId: users.reader.userId, body: "r", createdAt: reply });
        }
      }
    });
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC] });
    vi.advanceTimersByTime(REMOVED_REPO_RETENTION_MS + 1);
    await backend.mutation(api.repoCommentAccess.purgeRepos, { internalSecret, repoIds: [PUBLIC] });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run(ctx => ctx.db.query("repoThreads").collect())).toEqual([]);
    expect(await backend.run(ctx => ctx.db.query("repoReplies").collect())).toEqual([]);
    // A stale purge job for a repository that no longer exists does nothing.
    await backend.mutation(internal.repoCommentAccess.purgeRepo, { repoId: PUBLIC, removedAt: 1 });
  });

  it("removes many grants of one repository in batches", async () => {
    vi.useFakeTimers();
    const { backend, grant } = await world();
    await grant(PUBLIC, null);
    await backend.run(async ctx => {
      for (let index = 0; index < REVOKE_BATCH + 2; index += 1) await ctx.db.insert("repoCommentGrants", { repoId: PUBLIC, userId: `user-${index}`, epoch: 0, expiresAt: Date.now() + 60_000 });
    });
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC] });
    await backend.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(1);
    await backend.finishInProgressScheduledFunctions();
    expect(await backend.run(ctx => ctx.db.query("repoCommentGrants").collect())).toEqual([]);
  });
});

describe("editing repository comments (#287)", () => {
  type Viewer = Pick<ReturnType<Awaited<ReturnType<typeof world>>["as"]>, "mutation">;
  const edit = (viewer: Viewer, args: Record<string, unknown>) => viewer.mutation(api.repoComments.editThread, args as never);
  const editReply = (viewer: Viewer, args: Record<string, unknown>) => viewer.mutation(api.repoComments.editReply, args as never);

  it("lets only the author edit a thread or a reply, whatever its status, and shows every reader the edit", async () => {
    const { backend, users, anonymous, as, grant } = await world();
    await grant(PUBLIC, null);
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Frist", anchor: anchor() });
    const theirs = await as("other").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "Theirs" });
    const mine = await as("reader").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "Mine" });
    const before = (await anonymous.query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts })).page[0];
    expect(before).toMatchObject({ canEdit: false, canDelete: false });
    expect(before.editedAt).toBeUndefined();
    expect(await edit(as("reader"), { ...scope(PUBLIC), threadId, body: " First ", clientOperationId: "edit-1" })).toBeNull();
    expect(await editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId: mine, body: "Mine, edited" })).toBeNull();
    // Every reader sees the new text and when it changed; only its author may edit it again.
    const page = async (viewer: Pick<typeof anonymous, "query">) => (await viewer.query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts })).page[0];
    const read = await page(anonymous);
    expect(read).toMatchObject({ body: "First", editedAt: expect.any(Number), editOperationId: "edit-1", canEdit: false });
    expect(read.replies.map(reply => [reply.body, Boolean(reply.editedAt), reply.canEdit])).toEqual([["Theirs", false, false], ["Mine, edited", true, false]]);
    expect(read.replies[1].editOperationId).toBeUndefined();
    const author = await page(as("reader"));
    expect([author.canEdit, ...author.replies.map(reply => reply.canEdit)]).toEqual([true, false, true]);
    const other = await page(as("other"));
    expect([other.canEdit, ...other.replies.map(reply => reply.canEdit)]).toEqual([false, true, false]);
    expect((await as("other").query(api.repoComments.listReplies, { ...scope(PUBLIC), threadId, paginationOpts: pageOpts })).page
      .map(reply => [reply.body, reply.canEdit, typeof reply.editedAt])).toEqual([["Mine, edited", false, "number"], ["Theirs", true, "undefined"]]);
    // The Worker's first page (#284, #303) is the same page, read for the reader it names.
    const snapshot = await backend.query(api.repoComments.threadSnapshot, { internalSecret, ...scope(PUBLIC), userId: null, epoch: 0, viewerId: users.reader.userId });
    expect(snapshot.page).toEqual((await as("reader").query(api.repoComments.listThreads, { ...scope(PUBLIC), paginationOpts: pageOpts })).page);
    // A forged edit of someone else's comment is refused as archive and delete are; an anonymous one asks to sign in.
    await expect(edit(as("other"), { ...scope(PUBLIC), threadId, body: "Hijacked" })).rejects.toThrow("Forbidden");
    await expect(editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId: theirs, body: "Hijacked" })).rejects.toThrow("Forbidden");
    await expect(anonymous.mutation(api.repoComments.editThread, { ...scope(PUBLIC), threadId, body: "Drive-by" })).rejects.toThrow("Unauthenticated");
    await expect(anonymous.mutation(api.repoComments.editReply, { ...scope(PUBLIC), threadId, replyId: mine, body: "Drive-by" })).rejects.toThrow("Unauthenticated");
    // Resolved or archived, like replies and resolving: the author may still correct it.
    await as("other").mutation(api.repoComments.resolve, { ...scope(PUBLIC), threadId, resolved: true });
    await edit(as("reader"), { ...scope(PUBLIC), threadId, body: "Resolved, edited" });
    await as("reader").mutation(api.repoComments.archive, { ...scope(PUBLIC), threadId, archived: true });
    await edit(as("reader"), { ...scope(PUBLIC), threadId, body: "Archived, edited" });
    await editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId: mine, body: "Archived reply, edited" });
    const archived = await page(anonymous);
    expect([archived.body, archived.resolved, archived.archived, archived.replies[1].body]).toEqual(["Archived, edited", true, true, "Archived reply, edited"]);
    // An edit without an operation clears the last one's, so no later echo is mistaken for it.
    expect(archived.editOperationId).toBeUndefined();
    const stored = await backend.run(ctx => ctx.db.get(threadId));
    expect(stored!.updatedAt).toBe(stored!.editedAt);
  });

  it("validates an edit's text as a create does, and its target as every other write does", async () => {
    const { backend, users, as, grant } = await world();
    await grant(PUBLIC, null);
    await grant(PRIVATE, users.reader.userId);
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Thread", anchor: anchor() });
    const replyId = await as("reader").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "Reply" });
    const otherThread = await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "Other", anchor: anchor() });
    const privateThread = await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Private", anchor: anchor() });
    for (const bad of [
      { body: "   " }, { body: "" }, { body: "x".repeat(MAX_COMMENT_LENGTH + 1) }, { clientOperationId: " " }, { clientOperationId: "x".repeat(129) },
    ]) {
      await expect(edit(as("reader"), { ...scope(PUBLIC), threadId, body: "x", ...bad })).rejects.toThrow("Invalid input");
      await expect(editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId, body: "x", ...bad })).rejects.toThrow("Invalid input");
    }
    await expect(edit(as("reader"), { ...scope(PUBLIC), threadId, body: "x", expectedAuthorId: users.other.userId })).rejects.toThrow("Forbidden");
    // The longest body a create accepts is an edit's longest too.
    await edit(as("reader"), { ...scope(PUBLIC), threadId, body: "x".repeat(MAX_COMMENT_LENGTH) });
    for (const call of [
      () => edit(as("reader"), { ...scope(PUBLIC), threadId: "not-an-id", body: "x" }),
      () => edit(as("reader"), { ...scope(PUBLIC), threadId: replyId, body: "x" }),
      () => edit(as("reader"), { ...scope(PUBLIC, "docs/other.md"), threadId, body: "x" }),
      () => edit(as("reader"), { ...scope(PUBLIC), threadId: privateThread, body: "x" }),
      () => editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId: "not-an-id", body: "x" }),
      () => editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId: threadId, body: "x" }),
      () => editReply(as("reader"), { ...scope(PUBLIC), threadId: otherThread, replyId, body: "x" }),
    ]) await expect(call()).rejects.toThrow("Comment not found");
    // Deleted comments are gone for edits too, and a deleted reply stays deleted.
    await as("reader").mutation(api.repoComments.removeReply, { ...scope(PUBLIC), threadId, replyId });
    await expect(editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId, body: "Back?" })).rejects.toThrow("Comment not found");
    await as("reader").mutation(api.repoComments.removeThread, { ...scope(PUBLIC), threadId });
    await expect(edit(as("reader"), { ...scope(PUBLIC), threadId, body: "Back?" })).rejects.toThrow("Comment not found");
    expect(await backend.run(ctx => ctx.db.get(threadId))).toMatchObject({ body: "" });
  });

  it("deduplicates a retried edit, and spends the write quota only on an edit that writes", async () => {
    const { backend, as, grant } = await world();
    await grant(PUBLIC, null);
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "v0", anchor: anchor() });
    const replyId = await as("reader").mutation(api.repoComments.addReply, { ...scope(PUBLIC), threadId, body: "r0" });
    await edit(as("reader"), { ...scope(PUBLIC), threadId, body: "v1", clientOperationId: "op-1" });
    const first = await backend.run(ctx => ctx.db.get(threadId));
    // The same operation again (a retry after an unknown outcome) writes nothing, even with other text.
    await edit(as("reader"), { ...scope(PUBLIC), threadId, body: "v1", clientOperationId: "op-1" });
    await edit(as("reader"), { ...scope(PUBLIC), threadId, body: "changed meanwhile", clientOperationId: "op-1" });
    expect(await backend.run(ctx => ctx.db.get(threadId))).toEqual(first);
    // Unchanged text is no edit at all: no marker, no write.
    await editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId, body: " r0 ", clientOperationId: "op-r" });
    expect((await backend.run(ctx => ctx.db.get(replyId)))!.editedAt).toBeUndefined();
    // Two creates and one edit have written so far: 27 more edits reach the 30-a-minute limit, and the next is refused.
    for (let index = 0; index < 27; index += 1) {
      await editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId, body: `r${index + 1}`, clientOperationId: `reply-${index}` });
    }
    await expect(edit(as("reader"), { ...scope(PUBLIC), threadId, body: "one too many", clientOperationId: "op-2" })).rejects.toThrow(/rate/i);
    expect((await backend.run(ctx => ctx.db.get(threadId)))!.body).toBe("v1");
    // Retries and no-op edits still answer while the quota is spent.
    await edit(as("reader"), { ...scope(PUBLIC), threadId, body: "v1", clientOperationId: "op-1" });
    await edit(as("reader"), { ...scope(PUBLIC), threadId, body: "v1", clientOperationId: "op-3" });
    await editReply(as("reader"), { ...scope(PUBLIC), threadId, replyId, body: "r27", clientOperationId: "reply-26" });
    // Another reader keeps their own budget, and still may not edit the author's text.
    await expect(edit(as("other"), { ...scope(PUBLIC), threadId, body: "v2" })).rejects.toThrow("Forbidden");
  });

  it("refuses an edit after revocation, repository removal or grant expiry, as every other write", async () => {
    vi.useFakeTimers();
    const { backend, users, as, grant } = await world();
    await grant(PRIVATE, users.reader.userId, { epoch: 1 });
    const threadId = await as("reader").mutation(api.repoComments.createThread, { ...scope(PRIVATE), body: "Note", anchor: anchor() });
    const replyId = await as("reader").mutation(api.repoComments.addReply, { ...scope(PRIVATE), threadId, body: "Reply" });
    // Someone without a grant learns nothing: "not found", as for a thread that does not exist.
    await expect(edit(as("other"), { ...scope(PRIVATE), threadId, body: "x" })).rejects.toThrow("Comment not found");
    await expect(editReply(as("other"), { ...scope(PRIVATE), threadId, replyId, body: "x" })).rejects.toThrow("Comment not found");
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.reader.userId, epoch: 2 });
    await expect(edit(as("reader"), { ...scope(PRIVATE), threadId, body: "After revocation" })).rejects.toThrow("Comment not found");
    await expect(editReply(as("reader"), { ...scope(PRIVATE), threadId, replyId, body: "After revocation" })).rejects.toThrow("Comment not found");
    await grant(PRIVATE, users.reader.userId, { epoch: 2, ttl: 1_000 });
    vi.advanceTimersByTime(2_000);
    await expect(edit(as("reader"), { ...scope(PRIVATE), threadId, body: "After expiry" })).rejects.toThrow("Comment not found");
    await grant(PRIVATE, users.reader.userId, { epoch: 2 });
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PRIVATE] });
    await expect(edit(as("reader"), { ...scope(PRIVATE), threadId, body: "After removal" })).rejects.toThrow("Comment not found");
    await expect(editReply(as("reader"), { ...scope(PRIVATE), threadId, replyId, body: "After removal" })).rejects.toThrow("Comment not found");
    expect((await backend.run(ctx => ctx.db.get(threadId)))!.body).toBe("Note");
    expect((await backend.run(ctx => ctx.db.get(replyId)))!.body).toBe("Reply");
  });
});
