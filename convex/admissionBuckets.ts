import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components, internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";

// No reservations: every quota refills completely within an hour. Round expiry
// up to the next hour so hot readers usually only READ the registry; updating it
// on every admission would serialize all the component's independent shards.
export async function touchAdmissionBucket(ctx: MutationCtx, name: string, key: string): Promise<void> {
  const expiresAt = (Math.floor(Date.now() / HOUR) + 2) * HOUR;
  const bucket = await ctx.db.query("admissionBuckets")
    .withIndex("by_bucket", q => q.eq("name", name).eq("key", key)).unique();
  if (!bucket) await ctx.db.insert("admissionBuckets", { name, key, expiresAt });
  else if (bucket.expiresAt < expiresAt) await ctx.db.patch(bucket._id, { expiresAt });
}

const limiter = new RateLimiter(components.rateLimiter);
// Nine registry rows plus at most ten component shards each = 99 deletions.
export const admissionCleanupBatch = 9;
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const expired = await ctx.db.query("admissionBuckets")
      .withIndex("by_expiry", q => q.lte("expiresAt", Date.now())).take(admissionCleanupBatch);
    for (const bucket of expired) {
      await limiter.reset(ctx, bucket.name, { key: bucket.key });
      await ctx.db.delete(bucket._id);
    }
    if (expired.length === admissionCleanupBatch) {
      await ctx.scheduler.runAfter(0, internal.admissionBuckets.cleanup, {});
    }
    return null;
  },
});
