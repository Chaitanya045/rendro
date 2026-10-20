import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";

const windowMs = 60_000;
// The shared-IP backstop is split into this many rows of 6,000 / ipShards each.
export const ipShards = 8;

// 600/user/minute covers >8 lookups at 68 navigations/minute. Unverified
// probes get 120; 6,000/IP/minute remains an aggregate shared-IP backstop.
function limit(key: string) {
  return key.startsWith("session-read-ip:") ? 6_000 : key.startsWith("session-read:") ? 600 : 120;
}

// One fixed window, checked/incremented in the caller's transaction. expiresAt
// is set when the window starts: accepted and rejected traffic cannot postpone
// replenishment. Returns 0 when accepted, else whole seconds until the reset.
async function take(ctx: MutationCtx, key: string, max: number, now: number): Promise<number> {
  const row = await ctx.db.query("sessionReadWindow").withIndex("key", q => q.eq("key", key)).unique();
  if (!row || row.expiresAt <= now) {
    const window = { count: 1, expiresAt: now + windowMs };
    if (row) await ctx.db.patch(row._id, window);
    else await ctx.db.insert("sessionReadWindow", { key, ...window });
    return 0;
  }
  if (row.count >= max) return Math.max(1, Math.ceil((row.expiresAt - now) / 1000));
  await ctx.db.patch(row._id, { count: row.count + 1 });
  return 0;
}

export const consume = mutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const now = Date.now();
    if (!key.startsWith("session-read-ip:")) return take(ctx, key, limit(key), now);
    // A busy shared IP would make one row a write hotspot (OCC conflicts). Start
    // at a random shard and move on while shards are full: a request is refused
    // only when every shard is, so the aggregate limit stays exact. Full shards
    // are only read, and Retry-After is the earliest reset among them.
    const first = Math.floor(Math.random() * ipShards);
    let retryAfter = Infinity;
    for (let i = 0; i < ipShards; i++) {
      const wait = await take(ctx, `${key}#${(first + i) % ipShards}`, limit(key) / ipShards, now);
      if (!wait) return 0;
      retryAfter = Math.min(retryAfter, wait);
    }
    return retryAfter;
  },
});

export const cleanupBatch = 100;
// Rows this limiter (and the organization limiter removed in #286) left in
// Better Auth's rateLimit table before #97. Exact key-prefix ranges read only
// those rows, never a credential bucket; once drained, each is an empty range.
export const retiredPrefixes = [
  "session-read:", "session-read-ip:", "session-read-unverified:",
  "organization-read:", "organization-read-ip:", "organization-read-unverified:",
];

// Reads only expired windows: a window at or past expiresAt starts afresh in
// consume, so deleting it never loses live state. Better Auth owns its own
// rateLimit rows and their expiry.
export const cleanup = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const expired = await ctx.db.query("sessionReadWindow")
      .withIndex("expiresAt", q => q.lte("expiresAt", Date.now())).take(cleanupBatch);
    let more = expired.length === cleanupBatch;
    for (const row of expired) await ctx.db.delete(row._id);
    for (const prefix of retiredPrefixes) {
      // ":" + 1 is ";", so this range holds exactly the keys starting with prefix.
      const retired = await ctx.db.query("rateLimit")
        .withIndex("key", q => q.gte("key", prefix).lt("key", `${prefix.slice(0, -1)};`)).take(cleanupBatch);
      more ||= retired.length === cleanupBatch;
      for (const row of retired) await ctx.db.delete(row._id);
    }
    if (more) await ctx.scheduler.runAfter(0, internal.sessionReadLimit.cleanup, {});
    return null;
  },
});
