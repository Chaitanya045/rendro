import { HOUR, type RateLimitReturns } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { apiKeyRateLimiter, apiKeyRateLimits } from "./apiKeyRateLimits";

// No reservations are used. After this much inactivity even an empty bucket
// is full, so deleting it cannot grant extra tokens. Keep at least an hour.
export const failedIpIdleMs = Math.max(HOUR,
  apiKeyRateLimits.failedIp.capacity * apiKeyRateLimits.failedIp.period / apiKeyRateLimits.failedIp.rate);

export const consumeFailedIp = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<RateLimitReturns> => {
    const bucket = await ctx.db.query("failedApiKeyBuckets")
      .withIndex("by_key", q => q.eq("key", key)).unique();
    const expiresAt = Date.now() + failedIpIdleMs;
    if (bucket) await ctx.db.patch(bucket._id, { expiresAt });
    else await ctx.db.insert("failedApiKeyBuckets", { key, expiresAt });
    // Registry and component writes share this transaction, including rejected
    // attempts. Cleanup racing reuse conflicts and retries with fresh state.
    return apiKeyRateLimiter.limit(ctx, "failedIp", { key });
  },
});

export const cleanupFailedIpBuckets = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const expired = await ctx.db.query("failedApiKeyBuckets")
      .withIndex("by_expiry", q => q.lte("expiresAt", Date.now())).take(100);
    for (const bucket of expired) {
      await apiKeyRateLimiter.reset(ctx, "failedIp", { key: bucket.key });
      await ctx.db.delete(bucket._id);
    }
    if (expired.length === 100) {
      await ctx.scheduler.runAfter(0, internal.apiKeyRateLimitBuckets.cleanupFailedIpBuckets, {});
    }
    return null;
  },
});
