import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import betterAuthSchema from "../convex/betterAuth/schema";
import { GRANT_EXTEND_SLACK_MS, GRANT_MAX_MS, REMOVAL_SETTLE_MS, REVOKE_BATCH } from "../convex/repoCommentAccess";
import schema from "../convex/schema";
import rateLimiterTest from "./convex-rate-limiter";

/**
 * Moderators of repository comments (#259), at the Convex boundary: who is one, how long, what they may do to
 * other readers' comments, and the audit event each action leaves. Reads and writes keep their own grants; a
 * moderator grant alone gives nothing.
 */

const modules = import.meta.glob("../convex/**/*.ts");
const internalSecret = process.env.CONVEX_INTERNAL_SECRET!;
const REPO = 9301;
const OTHER_REPO = 9302;
const BLOB = "a".repeat(40);
const pageOpts = { cursor: null, numItems: 20 };
const scope = (repoId = REPO, path = "docs/guide.md") => ({ repoId, path });
const anchor = { kind: "repo-text" as const, blobSha: BLOB, headingSlug: "install", prefix: "Run ", exact: "pnpm install", suffix: " first", offset: 4 };

afterEach(() => vi.useRealTimers());

async function world() {
  const backend = convexTest(schema, modules);
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const now = Date.now();
  const users = Object.fromEntries(await backend.run(async (ctx) => Promise.all(["author", "moderator", "writer"].map(async (name) => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: { name, email: `${name}@example.test`, emailVerified: true, createdAt: now, updatedAt: now } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: { token: name, userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 3_600_000 } },
    });
    return [name, { userId: user._id as string, sessionId: session._id as string }] as const;
  }))));
  const as = (name: "author" | "moderator" | "writer") => backend.withIdentity({ subject: users[name].userId, sessionId: users[name].sessionId });
  const grant = (repoId: number, userId: string | null, options: { epoch?: number; ttl?: number } = {}) => backend.mutation(api.repoCommentAccess.grant, {
    internalSecret, repoId, userId, epoch: options.epoch ?? 0, expiresAt: Date.now() + (options.ttl ?? 60_000),
  });
  const moderate = (repoId: number, userId: string, options: { role?: "admin" | "maintain"; epoch?: number; ttl?: number } = {}) => backend.mutation(api.repoCommentAccess.grantModerator, {
    internalSecret, repoId, userId, role: options.role ?? "maintain", epoch: options.epoch ?? 0, expiresAt: Date.now() + (options.ttl ?? 60_000),
  });
  // A public repository: every reader holds the open grant, and the moderator holds a role on top of it.
  await grant(REPO, null);
  const threadId = await as("author").mutation(api.repoComments.createThread, { ...scope(), body: "Secret opinion", anchor });
  const replyId = await as("author").mutation(api.repoComments.addReply, { ...scope(), threadId, body: "Another opinion" });
  const audits = () => backend.run(ctx => ctx.db.query("auditEvents").withIndex("by_resource", q => q.eq("resourceType", "repository").eq("resourceId", String(REPO))).collect());
  const moderators = () => backend.run(ctx => ctx.db.query("repoCommentModerators").collect());
  const page = async (name: "author" | "moderator" | "writer") => (await as(name).query(api.repoComments.listThreads, { ...scope(), paginationOpts: pageOpts })).page;
  return { backend, users, as, grant, moderate, threadId, replyId, audits, moderators, page };
}

describe("recording a moderator grant", () => {
  it("only by the internal secret, validated, bounded to five minutes, and refused for what a read grant would be", async () => {
    const { backend, users, moderate } = await world();
    const args = { internalSecret, repoId: REPO, userId: users.moderator.userId, role: "admin" as const, epoch: 0, expiresAt: Date.now() + 1_000 };
    await expect(backend.mutation(api.repoCommentAccess.grantModerator, { ...args, internalSecret: "wrong" })).rejects.toThrow("Forbidden");
    for (const bad of [{ repoId: 0 }, { repoId: 1.5 }, { userId: "" }, { userId: "u".repeat(257) }, { epoch: -1 }, { epoch: 0.5 }, { expiresAt: 1.5 }]) {
      await expect(backend.mutation(api.repoCommentAccess.grantModerator, { ...args, ...bad })).rejects.toThrow("Invalid input");
    }
    // A role GitHub never gave is not a role: the validator refuses it before any code runs.
    for (const role of ["owner", "write", "triage", "read", "", "Admin"]) {
      await expect(backend.mutation(api.repoCommentAccess.grantModerator, { ...args, role } as never)).rejects.toThrow();
    }
    expect(await backend.mutation(api.repoCommentAccess.grantModerator, { ...args, expiresAt: Date.now() - 1 })).toEqual({ granted: false });
    const before = Date.now();
    const answer = await moderate(REPO, users.moderator.userId, { ttl: 60 * 60_000 });
    expect(answer.granted && answer.expiresAt - before).toBeLessThanOrEqual(GRANT_MAX_MS + 50);
    expect(await backend.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(2);
  });

  it("refuses a repository no read grant made known, a removed one, and a decision older than a revocation", async () => {
    const { backend, users, grant, moderate } = await world();
    expect(await moderate(OTHER_REPO, users.moderator.userId)).toEqual({ granted: false });
    expect(await backend.run(ctx => ctx.db.query("repoCommentRepos").collect())).toHaveLength(1);
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.moderator.userId, epoch: 10 });
    expect(await moderate(REPO, users.moderator.userId, { epoch: 9 })).toEqual({ granted: false });
    expect((await moderate(REPO, users.moderator.userId, { epoch: 10 })).granted).toBe(true);
    // A removal hides the repository, and a role never brings it back, even long after.
    vi.useFakeTimers();
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [REPO] });
    expect(await backend.run(ctx => ctx.db.query("repoCommentModerators").collect())).toEqual([]);
    expect(await moderate(REPO, users.moderator.userId, { epoch: 10 })).toEqual({ granted: false });
    vi.advanceTimersByTime(REMOVAL_SETTLE_MS + 1);
    expect(await moderate(REPO, users.moderator.userId, { epoch: 10 })).toEqual({ granted: false });
    void grant;
  });

  it("extends like a read grant, and replaces the role at once, so a demotion applies as soon as it is recorded", async () => {
    const { backend, users, moderate, moderators } = await world();
    const user = users.moderator.userId;
    const first = await moderate(REPO, user, { role: "admin", ttl: 30_000 });
    expect(first.granted).toBe(true);
    expect(await moderators()).toEqual([expect.objectContaining({ role: "admin", repoId: REPO, userId: user, epoch: 0 })]);
    // A longer expiry extends it (the pending job re-schedules itself); a barely longer one is not written.
    const held = (await moderators())[0].expiresAt;
    expect(await moderate(REPO, user, { role: "admin", ttl: 30_000 + GRANT_EXTEND_SLACK_MS - 1_000 })).toEqual({ granted: true, expiresAt: held });
    const extended = await moderate(REPO, user, { role: "admin", ttl: 120_000 });
    expect(extended.granted && extended.expiresAt).toBeGreaterThan(held);
    // A higher epoch is recorded; a shorter, older decision never shortens or lowers it.
    await moderate(REPO, user, { role: "admin", ttl: 1_000, epoch: 4 });
    expect(await moderators()).toEqual([expect.objectContaining({ epoch: 4 })]);
    expect((await moderators())[0].expiresAt).toBe(extended.granted ? extended.expiresAt : -1);
    // The role stated now replaces the one held, whatever the expiry.
    await moderate(REPO, user, { role: "maintain", ttl: 1_000, epoch: 4 });
    expect(await moderators()).toEqual([expect.objectContaining({ role: "maintain", epoch: 4 })]);
    expect(await backend.run(ctx => ctx.db.query("repoCommentModerators").collect())).toHaveLength(1);
  });

  it("expires by a scheduled function, and is deleted with everything else a user holds on a revocation epoch", async () => {
    vi.useFakeTimers();
    const { backend, users, moderate, moderators } = await world();
    await moderate(REPO, users.moderator.userId, { ttl: 10_000 });
    vi.advanceTimersByTime(5_000);
    await moderate(REPO, users.moderator.userId, { ttl: 20_000 });
    vi.advanceTimersByTime(5_000);
    await backend.finishInProgressScheduledFunctions();
    expect(await moderators()).toHaveLength(1);
    vi.advanceTimersByTime(20_000);
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await moderators()).toEqual([]);
    // A job for a grant already gone does nothing.
    const grantId = await backend.run(ctx => ctx.db.insert("repoCommentModerators", { repoId: REPO, userId: "u", role: "admin", epoch: 0, expiresAt: 0 }));
    await backend.run(ctx => ctx.db.delete(grantId));
    await backend.mutation(internal.repoCommentAccess.expireModerator, { grantId });
    // The control Worker's epoch for the user ends the role, with the read grants.
    await moderate(REPO, users.moderator.userId);
    await moderate(REPO, users.writer.userId);
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.moderator.userId, epoch: 50 });
    expect((await moderators()).map(row => row.userId)).toEqual([users.writer.userId]);
  });

  it("deletes many roles in batches, of a user and of a repository", async () => {
    vi.useFakeTimers();
    const { backend, users, moderate, moderators } = await world();
    await backend.run(async ctx => {
      for (let repoId = 1; repoId <= REVOKE_BATCH + 3; repoId += 1) await ctx.db.insert("repoCommentModerators", { repoId, userId: users.writer.userId, role: "admin", epoch: 0, expiresAt: Date.now() + 60_000 });
      for (let index = 0; index < REVOKE_BATCH + 2; index += 1) await ctx.db.insert("repoCommentModerators", { repoId: REPO, userId: `user-${index}`, role: "maintain", epoch: 0, expiresAt: Date.now() + 60_000 });
    });
    await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId: users.writer.userId, epoch: 30 });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect((await moderators()).filter(row => row.userId === users.writer.userId)).toEqual([]);
    await moderate(REPO, users.moderator.userId);
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [REPO] });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await moderators()).toEqual([]);
  });
});

describe("what a moderator may do", () => {
  it("shows every reader what they may delete: a moderator everything, a writer only their own", async () => {
    const { users, moderate, page, as, threadId } = await world();
    const before = await page("moderator");
    expect(before[0]).toMatchObject({ canDelete: false, canEdit: false, replies: [expect.objectContaining({ canDelete: false, canEdit: false })] });
    await moderate(REPO, users.moderator.userId);
    const moderated = await page("moderator");
    // Delete and archive of others' comments, never an edit of them.
    expect(moderated[0]).toMatchObject({ canDelete: true, canEdit: false, replies: [expect.objectContaining({ canDelete: true, canEdit: false })] });
    expect(await page("writer")).toEqual(before);
    expect((await page("author"))[0]).toMatchObject({ canDelete: true, canEdit: true });
    const replies = await as("moderator").query(api.repoComments.listReplies, { ...scope(), threadId, paginationOpts: pageOpts });
    expect(replies.page).toEqual([expect.objectContaining({ canDelete: true, canEdit: false })]);
    expect((await as("writer").query(api.repoComments.listReplies, { ...scope(), threadId, paginationOpts: pageOpts })).page[0]).toMatchObject({ canDelete: false });
    // A moderator of this repository is nothing elsewhere.
    await as("author").mutation(api.repoComments.createThread, { ...scope(OTHER_REPO), body: "x", anchor }).catch(() => undefined);
  });

  it("archives and unarchives another reader's thread, and audits each change once, without the text", async () => {
    const { users, moderate, as, threadId, audits, page } = await world();
    await moderate(REPO, users.moderator.userId, { role: "admin" });
    expect(await as("moderator").mutation(api.repoComments.archive, { ...scope(), threadId, archived: true })).toBe(true);
    // A retry changes nothing and writes nothing.
    expect(await as("moderator").mutation(api.repoComments.archive, { ...scope(), threadId, archived: true })).toBe(true);
    expect((await page("author"))[0]).toMatchObject({ archived: true });
    expect(await as("moderator").mutation(api.repoComments.archive, { ...scope(), threadId, archived: false })).toBe(false);
    const events = await audits();
    expect(events.map(event => event.action)).toEqual(["comment.thread_archived", "comment.thread_unarchived"]);
    expect(events[0]).toMatchObject({
      actorId: users.moderator.userId, organizationId: "", resourceType: "repository", resourceId: String(REPO),
      metadata: { role: "admin", threadId, authorId: users.author.userId, path: "docs/guide.md" },
    });
    expect(events[0].createdAt).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/Secret opinion|Another opinion/);
  });

  it("deletes another reader's thread and reply, audited once with the role, the comment and its author", async () => {
    const { users, moderate, as, threadId, replyId, audits, backend } = await world();
    await moderate(REPO, users.moderator.userId, { role: "maintain" });
    const writerReply = await as("writer").mutation(api.repoComments.addReply, { ...scope(), threadId, body: "Writer's words" });
    await as("moderator").mutation(api.repoComments.removeReply, { ...scope(), threadId, replyId });
    // A retry finds the tombstone, as the author's own retry does, and does not write a second event.
    expect(await as("moderator").mutation(api.repoComments.removeReply, { ...scope(), threadId, replyId })).toBeNull();
    await as("moderator").mutation(api.repoComments.removeThread, { ...scope(), threadId });
    expect(await as("moderator").mutation(api.repoComments.removeThread, { ...scope(), threadId })).toBeNull();
    const events = await audits();
    expect(events.map(event => event.action)).toEqual(["comment.reply_deleted", "comment.thread_deleted"]);
    expect(events[0].metadata).toEqual({ role: "maintain", threadId, replyId, authorId: users.author.userId, path: "docs/guide.md" });
    expect(events[1].metadata).toEqual({ role: "maintain", threadId, authorId: users.author.userId, path: "docs/guide.md" });
    expect(JSON.stringify(events)).not.toMatch(/Secret opinion|Another opinion|Writer's words/);
    // The comments really are gone, replies of the deleted thread included.
    vi.useFakeTimers();
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(writerReply).toBeTruthy();
    expect((await as("author").query(api.repoComments.listThreads, { ...scope(), paginationOpts: pageOpts })).page).toEqual([]);
  });

  it("leaves a moderator's own comments to their author's rights, and audits only what is moderation", async () => {
    const { users, moderate, as, audits } = await world();
    await moderate(REPO, users.moderator.userId);
    const own = await as("moderator").mutation(api.repoComments.createThread, { ...scope(), body: "Mine", anchor });
    const ownReply = await as("moderator").mutation(api.repoComments.addReply, { ...scope(), threadId: own, body: "Mine too" });
    await as("moderator").mutation(api.repoComments.archive, { ...scope(), threadId: own, archived: true });
    await as("moderator").mutation(api.repoComments.removeReply, { ...scope(), threadId: own, replyId: ownReply });
    await as("moderator").mutation(api.repoComments.removeThread, { ...scope(), threadId: own });
    expect(await audits()).toEqual([]);
    // Authors of their own comments are never audited, with or without a role.
    const mine = await as("author").mutation(api.repoComments.createThread, { ...scope(), body: "Authored", anchor });
    await as("author").mutation(api.repoComments.archive, { ...scope(), threadId: mine, archived: true });
    await as("author").mutation(api.repoComments.removeThread, { ...scope(), threadId: mine });
    expect(await audits()).toEqual([]);
  });

  it("is refused to everyone else: writers, readers without a role, other repositories, expired and forged claims", async () => {
    const { backend, users, moderate, as, grant, threadId, replyId, audits } = await world();
    const attempts = (who: "writer" | "moderator") => [
      () => as(who).mutation(api.repoComments.archive, { ...scope(), threadId, archived: true }),
      () => as(who).mutation(api.repoComments.removeThread, { ...scope(), threadId }),
      () => as(who).mutation(api.repoComments.removeReply, { ...scope(), threadId, replyId }),
    ];
    for (const attempt of attempts("writer")) await expect(attempt()).rejects.toThrow("Forbidden");
    // A role on another repository is nothing here.
    await grant(OTHER_REPO, null);
    await moderate(OTHER_REPO, users.moderator.userId);
    for (const attempt of attempts("moderator")) await expect(attempt()).rejects.toThrow("Forbidden");
    // Another reader's role is not the caller's.
    await moderate(REPO, users.writer.userId);
    for (const attempt of attempts("moderator")) await expect(attempt()).rejects.toThrow("Forbidden");
    // Editing and resolving keep their rules: a role does not edit others' words.
    await expect(as("writer").mutation(api.repoComments.editThread, { ...scope(), threadId, body: "Changed" })).rejects.toThrow("Forbidden");
    await expect(as("writer").mutation(api.repoComments.editReply, { ...scope(), threadId, replyId, body: "Changed" })).rejects.toThrow("Forbidden");
    expect(await as("writer").mutation(api.repoComments.resolve, { ...scope(), threadId, resolved: true })).toBe(true);
    // A claim of authorship that is not the caller's is refused before any role is considered.
    await moderate(REPO, users.moderator.userId);
    await expect(as("moderator").mutation(api.repoComments.removeThread, { ...scope(), threadId, expectedAuthorId: users.author.userId })).rejects.toThrow("Forbidden");
    // Expired: refused at the call, even before the job that deletes the row has run.
    await backend.run(async ctx => {
      const row = (await ctx.db.query("repoCommentModerators").collect()).find(held => held.userId === users.moderator.userId && held.repoId === REPO)!;
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    for (const attempt of attempts("moderator")) await expect(attempt()).rejects.toThrow("Forbidden");
    expect(await audits()).toEqual([]);
  });

  it("needs the write grant too: a moderator whose read grant ended can do nothing, and a tombstone stays as it was", async () => {
    const { backend, users, moderate, as, threadId, replyId, grant } = await world();
    await moderate(REPO, users.moderator.userId);
    // Another thread is deleted by its author, so it is a tombstone to everyone.
    const gone = await as("author").mutation(api.repoComments.createThread, { ...scope(), body: "Gone", anchor });
    await as("author").mutation(api.repoComments.removeThread, { ...scope(), threadId: gone });
    expect(await as("moderator").mutation(api.repoComments.removeThread, { ...scope(), threadId: gone })).toBeNull();
    await expect(as("writer").mutation(api.repoComments.removeThread, { ...scope(), threadId: gone })).rejects.toThrow("Comment not found");
    await expect(as("moderator").mutation(api.repoComments.archive, { ...scope(), threadId: gone, archived: true })).rejects.toThrow("Comment not found");
    // The read grant goes (the repository was removed): the role is gone with it, and nothing works.
    await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds: [REPO] });
    await expect(as("moderator").mutation(api.repoComments.removeThread, { ...scope(), threadId })).rejects.toThrow("Comment not found");
    await expect(as("moderator").mutation(api.repoComments.removeReply, { ...scope(), threadId, replyId })).rejects.toThrow("Comment not found");
    void grant;
  });

  it("cannot delete a reply of another thread or document through a role", async () => {
    const { users, moderate, as, threadId, replyId } = await world();
    await moderate(REPO, users.moderator.userId);
    const other = await as("author").mutation(api.repoComments.createThread, { ...scope(REPO, "docs/other.md"), body: "Elsewhere", anchor });
    await expect(as("moderator").mutation(api.repoComments.removeReply, { ...scope(REPO, "docs/other.md"), threadId: other, replyId })).rejects.toThrow("Comment not found");
    await expect(as("moderator").mutation(api.repoComments.removeThread, { ...scope(REPO, "docs/other.md"), threadId })).rejects.toThrow("Comment not found");
    await expect(as("moderator").mutation(api.repoComments.archive, { ...scope(REPO, "docs/other.md"), threadId, archived: true })).rejects.toThrow("Comment not found");
  });
});

describe("the first page for the Worker (#259)", () => {
  const snapshot = (backend: ReturnType<typeof convexTest>, args: Record<string, unknown>) => backend.query(api.repoComments.threadSnapshot, {
    internalSecret, ...scope(), userId: null, epoch: 0, ...args,
  } as never);

  it("shows a moderator everything it may delete, told so by the Worker before any grant exists, and refuses a claim with no reader", async () => {
    const { backend, users } = await world();
    const plain = await snapshot(backend, { viewerId: users.moderator.userId });
    expect(plain.page[0]).toMatchObject({ canDelete: false });
    const told = await snapshot(backend, { viewerId: users.moderator.userId, moderator: true });
    expect(told.page[0]).toMatchObject({ canDelete: true, canEdit: false, replies: [expect.objectContaining({ canDelete: true, canEdit: false })] });
    // False is the same as absent; a private grant's reader is its own page's reader.
    expect((await snapshot(backend, { viewerId: users.moderator.userId, moderator: false })).page[0]).toMatchObject({ canDelete: false });
    expect((await snapshot(backend, { userId: users.author.userId, moderator: true })).page[0]).toMatchObject({ canDelete: true, canEdit: true });
    // No reader to be a moderator for: refused, never an anonymous page that deletes.
    await expect(snapshot(backend, { moderator: true })).rejects.toThrow("Invalid input");
    await expect(snapshot(backend, { userId: "", moderator: true })).rejects.toThrow("Invalid input");
    // The page is a hint; the mutation still decides from the grant.
    await expect(backend.withIdentity({ subject: users.moderator.userId, sessionId: users.moderator.sessionId })
      .mutation(api.repoComments.removeThread, { ...scope(), threadId: told.page[0]._id })).rejects.toThrow("Forbidden");
  });
});
