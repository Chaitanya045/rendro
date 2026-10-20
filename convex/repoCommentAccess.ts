/**
 * Who may read and write comments on repository docs (#254). Access mirrors
 * the read path exactly: Convex cannot ask GitHub or the permission source, so
 * the serving Worker, after its own authorization (capability cookie, revocation
 * epoch, P5's permission source), records a grant here with an internal-secret
 * call. A grant lives no longer than the authorization behind it, and is gone:
 *
 * - at its expiry, through one scheduled function per grant (queries never read
 *   the clock: they only ask whether a grant exists);
 * - when P5 bumps the user's revocation epoch (`revokeUser`), which also refuses
 *   any grant still in flight from before the bump;
 * - when the repository is uninstalled or deleted (`removeRepos`): its comments
 *   are hidden at once. They are purged (`purgeRepos`) only when the control
 *   Worker asks after `REMOVED_REPO_RETENTION_MS`, having confirmed with GitHub
 *   that the app really lost the repository (#258): a removal webhook can be a
 *   replay. If GitHub still grants it, `restoreRepos` shows them again.
 *
 * A grant with `userId: null` records that the repository was public: anyone may
 * read, and signed-in users may write. Otherwise only that user may.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { publicError } from "./publicErrors";
import { mutation } from "./publicFunctions";
import { requireInternalSecret } from "./security";

/** No grant outlives the five-minute capability cookie it rests on, whatever the caller asks. */
export const GRANT_MAX_MS = 5 * 60_000;
/** Comments of an uninstalled or deleted repository are purged no sooner than this after GitHub reported it, and only once GitHub confirms it. */
export const REMOVED_REPO_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** A grant decided before a removal can arrive just after it; it must not bring the comments back. */
export const REMOVAL_SETTLE_MS = 60_000;
/** Every write to a grant re-runs the comment queries that read it, so one is only extended by more than this. */
export const GRANT_EXTEND_SLACK_MS = 10_000;
export const REVOKE_BATCH = 100;
export const PURGE_THREAD_BATCH = 20;
export const PURGE_REPLY_BATCH = 100;
const MAX_REPOS_PER_REMOVAL = 100;
/** Repository comments belong to no organization (GitHub-only): their audit events are found by resource. */
const AUDIT_ORGANIZATION = "";
const AUDIT_ACTOR = "repo-access";

type Ctx = QueryCtx | MutationCtx;
type AuthUser = NonNullable<Awaited<ReturnType<typeof authComponent.safeGetAuthUser>>>;

export function validRepoId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function validUserId(value: string): boolean {
  return value.length > 0 && value.length <= 256;
}

function validEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function repoRow(ctx: Ctx, repoId: number): Promise<Doc<"repoCommentRepos"> | null> {
  return ctx.db.query("repoCommentRepos").withIndex("by_repo", q => q.eq("repoId", repoId)).unique();
}

function grantRow(ctx: Ctx, repoId: number, userId: string | null): Promise<Doc<"repoCommentGrants"> | null> {
  return ctx.db.query("repoCommentGrants").withIndex("by_repo_user", q => q.eq("repoId", repoId).eq("userId", userId)).unique();
}

function epochRow(ctx: Ctx, userId: string): Promise<Doc<"repoCommentEpochs"> | null> {
  return ctx.db.query("repoCommentEpochs").withIndex("by_user", q => q.eq("userId", userId)).unique();
}

export type RepoCommentReader = {
  /** The signed-in reader, or null for an anonymous reader of a public repository. */
  user: AuthUser | null;
  /** The grant the decision rests on. */
  held: Doc<"repoCommentGrants">;
};

async function signedInUser(ctx: Ctx): Promise<AuthUser | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || typeof identity.sessionId !== "string") return null;
  return await authComponent.safeGetAuthUser(ctx) ?? null;
}

/**
 * May the caller read comments on `repoId` now? Null when not, with no reason
 * given: a missing, removed, private or revoked repository all look the same.
 * Reads storage only, never the clock, so a cached query result changes exactly
 * when a grant is written or deleted.
 */
export async function repoCommentReader(ctx: Ctx, repoId: number): Promise<RepoCommentReader | null> {
  if (!validRepoId(repoId)) return null;
  const repo = await repoRow(ctx, repoId);
  if (!repo || repo.removedAt !== undefined) return null;
  const user = await signedInUser(ctx);
  const open = await grantRow(ctx, repoId, null);
  if (open) return { user, held: open };
  if (!user) return null;
  const held = await grantRow(ctx, repoId, user._id);
  return held ? { user, held } : null;
}

/**
 * May the serving Worker hand `userId` (null: anyone, for a public repository) the first page of comments on
 * `repoId`, which its own authorization just granted (#284)? It asks while recording the grant, before any grant
 * may exist here, so this refuses exactly what `grant` refuses: a removed repository, and a decision older than a
 * revocation Convex already holds.
 */
export async function repoCommentSnapshotAllowed(ctx: Ctx, repoId: number, userId: string | null, epoch: number): Promise<boolean> {
  if (!validRepoId(repoId) || (userId !== null && !validUserId(userId)) || !validEpoch(epoch)) publicError("invalid_input");
  const repo = await repoRow(ctx, repoId);
  if (!repo || repo.removedAt !== undefined) return false;
  return userId === null || ((await epochRow(ctx, userId))?.epoch ?? 0) <= epoch;
}

/** Writers must be signed in and hold a live grant; mutations may read the clock, so expiry is checked too. */
export async function requireRepoCommentWriter(ctx: MutationCtx, repoId: number): Promise<RepoCommentReader & { user: AuthUser }> {
  const reader = await repoCommentReader(ctx, repoId);
  if (!reader || reader.held.expiresAt <= Date.now()) publicError("not_found");
  if (!reader.user) publicError("unauthenticated");
  return reader as RepoCommentReader & { user: AuthUser };
}

/** The serving Worker's record of an authorization it just made. */
export const grant = mutation({
  args: {
    internalSecret: v.string(),
    repoId: v.number(),
    userId: v.union(v.string(), v.null()),
    epoch: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<{ granted: false } | { granted: true; expiresAt: number }> => {
    requireInternalSecret(args.internalSecret);
    if (!validRepoId(args.repoId) || (args.userId !== null && !validUserId(args.userId))
      || !validEpoch(args.epoch) || !Number.isSafeInteger(args.expiresAt)) publicError("invalid_input");
    const now = Date.now();
    const expiresAt = Math.min(args.expiresAt, now + GRANT_MAX_MS);
    if (expiresAt <= now) return { granted: false };
    // Decided before a revocation that already reached us: the reader no longer holds it.
    if (args.userId !== null && ((await epochRow(ctx, args.userId))?.epoch ?? 0) > args.epoch) return { granted: false };
    const repo = await repoRow(ctx, args.repoId);
    if (!repo) await ctx.db.insert("repoCommentRepos", { repoId: args.repoId });
    else if (repo.removedAt !== undefined) {
      // Too close to the removal to tell from a decision made before it; a reinstall is seen on the next renewal.
      if (now - repo.removedAt < REMOVAL_SETTLE_MS) return { granted: false };
      await ctx.db.patch(repo._id, { removedAt: undefined, purgeConfirmedAt: undefined });
    }
    const existing = await grantRow(ctx, args.repoId, args.userId);
    if (!existing) {
      const grantId = await ctx.db.insert("repoCommentGrants", { repoId: args.repoId, userId: args.userId, epoch: args.epoch, expiresAt });
      await ctx.scheduler.runAt(expiresAt, internal.repoCommentAccess.expireGrant, { grantId });
      return { granted: true, expiresAt };
    }
    // The pending expiry job re-schedules itself when it finds the grant extended.
    if (existing.expiresAt < expiresAt - GRANT_EXTEND_SLACK_MS || existing.epoch < args.epoch) {
      const extended = { expiresAt: Math.max(existing.expiresAt, expiresAt), epoch: Math.max(existing.epoch, args.epoch) };
      await ctx.db.patch(existing._id, extended);
      return { granted: true, expiresAt: extended.expiresAt };
    }
    return { granted: true, expiresAt: existing.expiresAt };
  },
});

export const expireGrant = internalMutation({
  args: { grantId: v.id("repoCommentGrants") },
  handler: async (ctx, { grantId }): Promise<null> => {
    const row = await ctx.db.get(grantId);
    if (!row) return null;
    if (row.expiresAt <= Date.now()) await ctx.db.delete(grantId);
    else await ctx.scheduler.runAt(row.expiresAt, internal.repoCommentAccess.expireGrant, { grantId });
    return null;
  },
});

async function deleteUserGrants(ctx: MutationCtx, userId: string): Promise<void> {
  const grants = await ctx.db.query("repoCommentGrants").withIndex("by_user", q => q.eq("userId", userId)).take(REVOKE_BATCH + 1);
  await Promise.all(grants.slice(0, REVOKE_BATCH).map(row => ctx.db.delete(row._id)));
  if (grants.length > REVOKE_BATCH) await ctx.scheduler.runAfter(0, internal.repoCommentAccess.revokeRemaining, { userId });
}

/** P5's revocation epoch for `userId` (the value it wrote to KV): every grant the user holds ends now. */
export const revokeUser = mutation({
  args: { internalSecret: v.string(), userId: v.string(), epoch: v.number() },
  handler: async (ctx, args): Promise<null> => {
    requireInternalSecret(args.internalSecret);
    if (!validUserId(args.userId) || !validEpoch(args.epoch)) publicError("invalid_input");
    const existing = await epochRow(ctx, args.userId);
    if (!existing) await ctx.db.insert("repoCommentEpochs", { userId: args.userId, epoch: args.epoch });
    else if (existing.epoch < args.epoch) await ctx.db.patch(existing._id, { epoch: args.epoch });
    await deleteUserGrants(ctx, args.userId);
    return null;
  },
});

export const revokeRemaining = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<null> => {
    await deleteUserGrants(ctx, userId);
    return null;
  },
});

async function deleteRepoGrants(ctx: MutationCtx, repoId: number): Promise<void> {
  const grants = await ctx.db.query("repoCommentGrants").withIndex("by_repo_user", q => q.eq("repoId", repoId)).take(REVOKE_BATCH + 1);
  await Promise.all(grants.slice(0, REVOKE_BATCH).map(row => ctx.db.delete(row._id)));
  if (grants.length > REVOKE_BATCH) await ctx.scheduler.runAfter(0, internal.repoCommentAccess.removeRemaining, { repoId });
}

const repoIdsArgs = { internalSecret: v.string(), repoIds: v.array(v.number()) };

function requireRepoIds(args: { internalSecret: string; repoIds: number[] }): Set<number> {
  requireInternalSecret(args.internalSecret);
  if (args.repoIds.length > MAX_REPOS_PER_REMOVAL || !args.repoIds.every(validRepoId)) publicError("invalid_input");
  return new Set(args.repoIds);
}

async function audit(ctx: MutationCtx, action: string, repoId: number, metadata: Record<string, number>, now: number): Promise<void> {
  await ctx.db.insert("auditEvents", {
    organizationId: AUDIT_ORGANIZATION, actorId: AUDIT_ACTOR, action, resourceType: "repository", resourceId: String(repoId), metadata, createdAt: now,
  });
}

/** P5 saw these repositories uninstalled or deleted: hide their comments now. Nothing is purged until GitHub confirms it (`purgeRepos`). */
export const removeRepos = mutation({
  args: repoIdsArgs,
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    for (const repoId of requireRepoIds(args)) {
      const repo = await repoRow(ctx, repoId);
      // Never seen by a reader: nothing to hide or purge.
      if (!repo) continue;
      if (repo.removedAt === undefined) await ctx.db.patch(repo._id, { removedAt: now });
      await deleteRepoGrants(ctx, repoId);
    }
    return null;
  },
});

/**
 * The control Worker confirmed with GitHub, just now, that the app lost these repositories: purge
 * the comments of each one hidden for the whole retention window. The window is Convex's own, so
 * the answer names the repositories not due yet. Anything not hidden has nothing to purge.
 */
export const purgeRepos = mutation({
  args: repoIdsArgs,
  handler: async (ctx, args): Promise<{ notDue: Array<{ repoId: number; dueAt: number }> }> => {
    const now = Date.now();
    const notDue: Array<{ repoId: number; dueAt: number }> = [];
    for (const repoId of requireRepoIds(args)) {
      const repo = await repoRow(ctx, repoId);
      if (!repo || repo.removedAt === undefined || repo.purgeConfirmedAt !== undefined) continue;
      const dueAt = repo.removedAt + REMOVED_REPO_RETENTION_MS;
      if (dueAt > now) {
        notDue.push({ repoId, dueAt });
        continue;
      }
      await ctx.db.patch(repo._id, { purgeConfirmedAt: now });
      await audit(ctx, "repository.comments_purged", repoId, { removedAt: repo.removedAt }, now);
      await ctx.scheduler.runAfter(0, internal.repoCommentAccess.purgeRepo, { repoId, removedAt: repo.removedAt });
    }
    return { notDue };
  },
});

/** GitHub still grants the app these repositories (a replayed removal, or a reinstall): show their comments again and stop any purge. */
export const restoreRepos = mutation({
  args: repoIdsArgs,
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    for (const repoId of requireRepoIds(args)) {
      const repo = await repoRow(ctx, repoId);
      if (!repo || repo.removedAt === undefined) continue;
      await ctx.db.patch(repo._id, { removedAt: undefined, purgeConfirmedAt: undefined });
      await audit(ctx, "repository.removal_reverted", repoId, { removedAt: repo.removedAt }, now);
    }
    return null;
  },
});

export const removeRemaining = internalMutation({
  args: { repoId: v.number() },
  handler: async (ctx, { repoId }): Promise<null> => {
    await deleteRepoGrants(ctx, repoId);
    return null;
  },
});

/** Delete a confirmed removed repository's comments in bounded batches. A restore or reinstall in the meantime stops it. */
export const purgeRepo = internalMutation({
  args: { repoId: v.number(), removedAt: v.number() },
  handler: async (ctx, { repoId, removedAt }): Promise<null> => {
    const repo = await repoRow(ctx, repoId);
    // Only a purge GitHub confirmed (`purgeRepos`) runs; a job scheduled any other way does nothing.
    if (!repo || repo.removedAt !== removedAt || repo.purgeConfirmedAt === undefined) return null;
    const threads = await ctx.db.query("repoThreads").withIndex("by_repo_blob", q => q.eq("repoId", repoId)).take(PURGE_THREAD_BATCH);
    if (threads.length === 0) {
      await ctx.db.delete(repo._id);
      return null;
    }
    let budget = PURGE_REPLY_BATCH;
    for (const thread of threads) {
      const replies = await ctx.db.query("repoReplies").withIndex("by_thread", q => q.eq("threadId", thread._id)).take(budget + 1);
      const doomed = replies.slice(0, budget);
      await Promise.all(doomed.map(reply => ctx.db.delete(reply._id)));
      budget -= doomed.length;
      if (replies.length > doomed.length) break;
      await ctx.db.delete(thread._id);
    }
    await ctx.scheduler.runAfter(0, internal.repoCommentAccess.purgeRepo, { repoId, removedAt });
    return null;
  },
});
