import { authReadWindow } from "../../shared/auth-read-window";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";

// Reuse the component rateLimit table. Each bucket is checked/incremented in
// one atomic transaction. lastRequest is the WINDOW START, never the last hit:
// accepted and rejected traffic cannot postpone replenishment.
export const consume = mutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("rateLimit").withIndex("key", q => q.eq("key", key)).unique();
    const { retryAfter, ...next } = authReadWindow(key, row, Date.now());
    if (retryAfter) return retryAfter;
    if (row) await ctx.db.patch(row._id, next);
    else await ctx.db.insert("rateLimit", { key, ...next });
    return 0;
  },
});

// This includes pre-cleanup-version rows without a migration. Paginate the
// expired window index so stale built-in buckets cannot starve custom cleanup.
// Only our namespaces are deleted; Better Auth owns credential bucket policy.
export const cleanup = internalMutation({
  args: { cursor: v.optional(v.string()), cutoff: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const cutoff = args.cutoff ?? Date.now() - 60_000;
    const batch = await ctx.db.query("rateLimit")
      .withIndex("lastRequest", q => q.lte("lastRequest", cutoff))
      .paginate({ cursor: args.cursor ?? null, numItems: 100 });
    for (const row of batch.page) {
      // The organization-read rows are the retired organization limiter's (#286): expired ones are still collected.
      if (["session-read:", "session-read-ip:", "session-read-unverified:", "organization-read:", "organization-read-ip:", "organization-read-unverified:"].some(prefix => row.key.startsWith(prefix))) {
        await ctx.db.delete(row._id);
      }
    }
    if (!batch.isDone) await ctx.scheduler.runAfter(0, internal.sessionReadLimit.cleanup, {
      cutoff, cursor: batch.continueCursor,
    });
    return null;
  },
});
