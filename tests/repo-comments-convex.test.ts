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

  it("checks a writer's grant expiry in the mutation even before the expiry job ran", async () => {
    vi.useFakeTimers();
    const { as, grant } = await world();
    await grant(PUBLIC, null, { ttl: 1_000 });
    vi.advanceTimersByTime(2_000);
    await expect(as("reader").mutation(api.repoComments.createThread, { ...scope(PUBLIC), body: "late", anchor: anchor() })).rejects.toThrow("Comment not found");
  });

  it("hides an uninstalled repository's comments at once and purges them after the retention window", async () => {
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
    // ...and removing again keeps the first removal time (one purge job).
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [PUBLIC] });
    vi.advanceTimersByTime(REMOVED_REPO_RETENTION_MS + 1);
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run(ctx => ctx.db.query("repoThreads").collect())).toEqual([]);
    expect(await backend.run(ctx => ctx.db.query("repoReplies").collect())).toEqual([]);
    expect(await backend.run(ctx => ctx.db.query("repoCommentRepos").collect())).toEqual([]);
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
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run(ctx => ctx.db.query("repoThreads").collect())).toHaveLength(1);
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
