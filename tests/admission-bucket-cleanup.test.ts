import { HOUR } from "@convex-dev/rate-limiter";
import { afterEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { admissionCleanupBatch } from "../convex/admissionBuckets";
import { consumeWriteQuota, writeQuotaLimiter, writeQuotaLimits } from "../convex/writeQuotas";
import rateLimiterTest from "./convex-rate-limiter";

const modules = import.meta.glob("../convex/**/*.ts");
function fixture() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  rateLimiterTest.register(t);
  vi.useFakeTimers();
  vi.setSystemTime(10 * HOUR);
  return t;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("bounds cleanup, continues, and removes actor and tenant state", async () => {
  const t = fixture();
  for (let i = 0; i < 20; i++) await t.run(ctx => consumeWriteQuota(ctx, "comments", `actor-${i}`, `tenant-${i % 2}`));
  for (const resource of Object.keys(writeQuotaLimits) as Array<keyof typeof writeQuotaLimits>) {
    const config = writeQuotaLimits[resource];
    expect(config.capacity * config.period / config.rate).toBeLessThanOrEqual(HOUR);
    await t.run(ctx => consumeWriteQuota(ctx, resource, "actor", "tenant"));
  }
  const registered = (await t.run(ctx => ctx.db.query("admissionBuckets").collect())).length;
  expect(registered).toBeGreaterThan(admissionCleanupBatch);
  vi.setSystemTime(12 * HOUR - 1);
  await t.mutation(internal.admissionBuckets.cleanup, {});
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toHaveLength(registered);
  vi.setSystemTime(12 * HOUR);
  await t.mutation(internal.admissionBuckets.cleanup, {});
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toHaveLength(registered - admissionCleanupBatch);
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toEqual([]);
  for (let i = 0; i < 20; i++) expect((await t.run(ctx => writeQuotaLimiter.getValue(ctx, "comments", { key: `user:actor-${i}` }))).ts).toBe(0);
  for (const resource of Object.keys(writeQuotaLimits) as Array<keyof typeof writeQuotaLimits>) {
    expect((await t.run(ctx => writeQuotaLimiter.getValue(ctx, resource, { key: "user:actor" }))).ts).toBe(0);
    expect((await t.run(ctx => writeQuotaLimiter.getValue(ctx, `${resource}:organization`, { key: "tenant", config: writeQuotaLimits[resource] }))).ts).toBe(0);
  }
});

it("keeps actor and tenant expiry with their write transaction and rolls back failed quota attempts", async () => {
  const t = fixture();
  await t.run(ctx => consumeWriteQuota(ctx, "comments", "actor", "tenant"));
  vi.setSystemTime(12 * HOUR - 1);
  await t.run(async ctx => {
    for (let i = 0; i < writeQuotaLimits.comments.capacity; i++) await consumeWriteQuota(ctx, "comments", "actor", "tenant");
  });
  const before = await t.run(ctx => ctx.db.query("admissionBuckets").collect());
  vi.setSystemTime(12 * HOUR);
  await expect(t.run(ctx => consumeWriteQuota(ctx, "comments", "actor", "other-tenant"))).rejects.toMatchObject({ data: { kind: "RateLimited" } });
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toEqual(before);
  await t.mutation(internal.admissionBuckets.cleanup, {});
  expect((await t.run(ctx => writeQuotaLimiter.check(ctx, "comments", { key: "user:actor" }))).ok).toBe(false);
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toHaveLength(2);
});

it.each([true, false])("does not erase reuse at the cleanup boundary (cleanup first: %s)", async cleanupFirst => {
  const t = fixture();
  const reuse = () => t.run(ctx => consumeWriteQuota(ctx, "comments", "actor", "tenant"));
  const cleanup = () => t.mutation(internal.admissionBuckets.cleanup, {});
  await reuse();
  vi.setSystemTime(12 * HOUR);
  await Promise.all((cleanupFirst ? [cleanup, reuse] : [reuse, cleanup]).map(run => run()));
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toMatchObject([{ expiresAt: 14 * HOUR }, { expiresAt: 14 * HOUR }]);
  // Refill/cleanup then reuse must leave the reuse's debit.
  expect((await t.run(ctx => writeQuotaLimiter.getValue(ctx, "comments", { key: "user:actor" }))).value).toBe(writeQuotaLimits.comments.capacity - 1);
});
