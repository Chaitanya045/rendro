import { HOUR } from "@convex-dev/rate-limiter";
import { afterEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { admissionCleanupBatch } from "../convex/admissionBuckets";
import { anonymousLimiter, anonymousLimits } from "../convex/anonymousAdmission";
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

it("bounds cleanup including component shards, continues, and removes actor, tenant and anonymous state", async () => {
  const t = fixture();
  for (let i = 0; i < 20; i++) await t.mutation(internal.anonymousAdmission.consume, { ip: `ip-${i}` });
  for (const resource of Object.keys(writeQuotaLimits) as Array<keyof typeof writeQuotaLimits>) {
    const config = writeQuotaLimits[resource];
    expect(config.capacity * config.period / config.rate).toBeLessThanOrEqual(HOUR);
    await t.run(ctx => consumeWriteQuota(ctx, resource, "actor", "tenant"));
  }
  for (const config of Object.values(anonymousLimits)) {
    expect(config.capacity * config.period / config.rate).toBeLessThanOrEqual(HOUR);
    expect(admissionCleanupBatch * (config.shards + 1) + 1).toBeLessThanOrEqual(100);
  }
  await t.mutation(internal.anonymousAdmission.consume, { ip: null });
  vi.setSystemTime(12 * HOUR - 1);
  await t.mutation(internal.admissionBuckets.cleanup, {});
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toHaveLength(29);
  vi.setSystemTime(12 * HOUR);
  await t.mutation(internal.admissionBuckets.cleanup, {});
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toHaveLength(29 - admissionCleanupBatch);
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toEqual([]);
  for (let i = 0; i < 20; i++) expect((await t.run(ctx => anonymousLimiter.getValue(ctx, "resolution", { key: `ip-${i}`, sampleShards: 10 }))).ts).toBe(0);
  expect((await t.run(ctx => anonymousLimiter.getValue(ctx, "unverifiedResolution", { key: "unverified", sampleShards: 10 }))).ts).toBe(0);
  for (const resource of Object.keys(writeQuotaLimits) as Array<keyof typeof writeQuotaLimits>) {
    expect((await t.run(ctx => writeQuotaLimiter.getValue(ctx, resource, { key: "user:actor" }))).ts).toBe(0);
    expect((await t.run(ctx => writeQuotaLimiter.getValue(ctx, `${resource}:organization`, { key: "tenant", config: writeQuotaLimits[resource] }))).ts).toBe(0);
  }
});

it("refreshes expiry atomically on anonymous denials without rewriting it on every read", async () => {
  const t = fixture();
  const consume = () => t.mutation(internal.anonymousAdmission.consume, { ip: "ip" });
  const registry = () => t.run(ctx => ctx.db.query("admissionBuckets").unique());
  await consume();
  const first = await registry();
  await consume();
  expect(await registry()).toEqual(first);
  vi.setSystemTime(12 * HOUR - 1);
  // Exhaust every real component shard, then deny at the old expiry boundary.
  const random = vi.spyOn(Math, "random");
  await t.run(ctx => anonymousLimiter.reset(ctx, "resolution", { key: "ip" }));
  for (let shard = 0; shard < 10; shard++) {
    random.mockReturnValue((shard + 0.1) / 10);
    await t.run(ctx => anonymousLimiter.limit(ctx, "resolution", { key: "ip", count: 120 }));
  }
  expect((await consume()).ok).toBe(false);
  expect((await registry())?.expiresAt).toBe(13 * HOUR);
  vi.setSystemTime(12 * HOUR);
  await t.mutation(internal.admissionBuckets.cleanup, {});
  expect((await consume()).ok).toBe(false);
  expect((await registry())?.expiresAt).toBe(14 * HOUR);
});

it("keeps actor and organization expiry with their write transaction and rolls back failed quota attempts", async () => {
  const t = fixture();
  await t.run(ctx => consumeWriteQuota(ctx, "projects", "actor", "tenant"));
  vi.setSystemTime(12 * HOUR - 1);
  await t.run(async ctx => {
    for (let i = 0; i < 20; i++) await consumeWriteQuota(ctx, "projects", "actor", "tenant");
  });
  const before = await t.run(ctx => ctx.db.query("admissionBuckets").collect());
  vi.setSystemTime(12 * HOUR);
  await expect(t.run(ctx => consumeWriteQuota(ctx, "projects", "actor", "other-tenant"))).rejects.toMatchObject({ data: { kind: "RateLimited" } });
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toEqual(before);
  await t.mutation(internal.admissionBuckets.cleanup, {});
  expect((await t.run(ctx => writeQuotaLimiter.check(ctx, "projects", { key: "user:actor" }))).ok).toBe(false);
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toHaveLength(2);
});

it.each([true, false])("does not erase reuse at the cleanup boundary (cleanup first: %s)", async cleanupFirst => {
  const t = fixture();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const reuse = () => t.mutation(internal.anonymousAdmission.consume, { ip: "ip" });
  const cleanup = () => t.mutation(internal.admissionBuckets.cleanup, {});
  await reuse();
  vi.setSystemTime(12 * HOUR);
  await Promise.all((cleanupFirst ? [cleanup, reuse] : [reuse, cleanup]).map(run => run()));
  expect(await t.run(ctx => ctx.db.query("admissionBuckets").collect())).toMatchObject([{ expiresAt: 14 * HOUR }]);
  // Both calls select shard zero; refill/cleanup then reuse must leave its debit.
  expect((await t.run(ctx => anonymousLimiter.getValue(ctx, "resolution", { key: "ip" }))).value).toBe(119);
});
