import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { apiKeyRateLimiter, apiKeyRateLimits } from "../convex/apiKeyRateLimits";
import { failedIpIdleMs } from "../convex/apiKeyRateLimitBuckets";
import rateLimiterTest from "./convex-rate-limiter";

const modules = import.meta.glob("../convex/**/*.ts");
function fixture() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("inactive failed-key bucket cleanup", () => {
  it("removes component and registry rows in bounded batches, including scheduled continuations", async () => {
    vi.useFakeTimers();
    const t = fixture();
    for (let i = 0; i < 205; i++) {
      await t.mutation(internal.apiKeyRateLimitBuckets.consumeFailedIp, { key: `ip:192.0.2.${i}` });
    }
    vi.setSystemTime(Date.now() + failedIpIdleMs);
    await t.mutation(internal.apiKeyRateLimitBuckets.cleanupFailedIpBuckets, {});
    expect(await t.run(ctx => ctx.db.query("failedApiKeyBuckets").collect())).toHaveLength(105);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await t.run(ctx => ctx.db.query("failedApiKeyBuckets").collect())).toEqual([]);
    for (let i = 0; i < 205; i++) {
      const value = await t.run(ctx => apiKeyRateLimiter.getValue(ctx, "failedIp", { key: `ip:192.0.2.${i}` }));
      expect(value.ts).toBe(0); // Missing component row, not just a refilled one.
    }
  });

  it("preserves depleted and recently reused buckets, even after rejected attempts", async () => {
    vi.useFakeTimers();
    const t = fixture();
    const key = "ip:192.0.2.1";
    await t.mutation(internal.apiKeyRateLimitBuckets.consumeFailedIp, { key });
    vi.setSystemTime(Date.now() + failedIpIdleMs - 1);
    // Empty the now-replenished component bucket, then record a rejected reuse.
    await t.run(ctx => apiKeyRateLimiter.limit(ctx, "failedIp", { key, count: apiKeyRateLimits.failedIp.capacity }));
    expect((await t.mutation(internal.apiKeyRateLimitBuckets.consumeFailedIp, { key })).ok).toBe(false);
    vi.setSystemTime(Date.now() + 1);
    await t.mutation(internal.apiKeyRateLimitBuckets.cleanupFailedIpBuckets, {});
    expect(await t.run(ctx => ctx.db.query("failedApiKeyBuckets").collect())).toHaveLength(1);
    expect((await t.run(ctx => apiKeyRateLimiter.check(ctx, "failedIp", { key }))).ok).toBe(false);
  });

  it.each([true, false])("does not erase concurrent reuse (cleanup first: %s)", async cleanupFirst => {
    vi.useFakeTimers();
    const t = fixture();
    const key = "ip:192.0.2.1";
    await t.mutation(internal.apiKeyRateLimitBuckets.consumeFailedIp, { key });
    vi.setSystemTime(Date.now() + failedIpIdleMs);
    const cleanup = () => t.mutation(internal.apiKeyRateLimitBuckets.cleanupFailedIpBuckets, {});
    const reuse = () => t.mutation(internal.apiKeyRateLimitBuckets.consumeFailedIp, { key });
    await Promise.all((cleanupFirst ? [cleanup, reuse] : [reuse, cleanup]).map(run => run()));
    const buckets = await t.run(ctx => ctx.db.query("failedApiKeyBuckets").collect());
    expect(buckets).toHaveLength(1);
    expect(buckets[0].expiresAt).toBe(Date.now() + failedIpIdleMs);
    const value = await t.run(ctx => apiKeyRateLimiter.getValue(ctx, "failedIp", { key }));
    expect(value.value).toBe(apiKeyRateLimits.failedIp.capacity - 1);
  });
});
