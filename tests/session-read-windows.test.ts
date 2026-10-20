import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import authSchema from "../convex/betterAuth/schema";
import { api, internal } from "../convex/betterAuth/_generated/api";
import { cleanupBatch, ipShards, retiredPrefixes } from "../convex/betterAuth/sessionReadLimit";

const modules = import.meta.glob("../convex/betterAuth/**/*.ts");
const start = Date.UTC(2026, 9, 21, 12);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// Run within the component, just like its own cron and continuations.
function component() {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  return convexTest({ schema: authSchema, modules, transactionLimits: true });
}
type Component = ReturnType<typeof component>;

// Better Auth's own buckets: stale for a day, and keys right beside the retired
// prefixes, which the exact ranges must not reach.
async function seedBuiltIns(t: Component, count: number) {
  const neighbours = ["session-read", "session-read;x", "session-reads:x", "session-read-ipx:x", "organization-read", "organization-read-unverifiedx:x"];
  await t.run(async ctx => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("rateLimit", { key: `203.0.${i >> 8}.${i & 255}|/sign-in/email`, count: 5, lastRequest: start - 86_400_000 });
    }
    for (const key of neighbours) await ctx.db.insert("rateLimit", { key, count: 5, lastRequest: start - 86_400_000 });
  });
  return t.run(ctx => ctx.db.query("rateLimit").collect());
}

async function seedWindows(t: Component, expired: number, live: number[]) {
  await t.run(async ctx => {
    for (let i = 0; i < expired; i++) {
      // The last expired window ends exactly now: consume would start it afresh.
      const expiresAt = start - (i === expired - 1 ? 0 : 1 + i);
      await ctx.db.insert("sessionReadWindow", { key: `session-read:expired-${i}`, count: 3, expiresAt });
    }
    for (const [i, ahead] of live.entries()) {
      await ctx.db.insert("sessionReadWindow", { key: `session-read-ip:live-${i}#0`, count: 3, expiresAt: start + ahead });
    }
  });
}

// One cleanup transaction, with its reads. convex-test counts two document
// reads per deleted row (the index range and the delete) and one per query.
function measuredCleanup(t: Component) {
  return t.run(async ctx => {
    await ctx.runMutation(internal.sessionReadLimit.cleanup, {});
    const metrics = await ctx.meta.getTransactionMetrics();
    return { documentsRead: metrics.documentsRead.used, databaseQueries: metrics.databaseQueries.used };
  });
}

const windows = (t: Component) => t.run(ctx => ctx.db.query("sessionReadWindow").collect());

describe("session-read window cleanup", () => {
  it("reads only expired custom windows, however many stale built-in buckets exist", async () => {
    const measured = [];
    for (const builtIns of [0, 5_000]) {
      const t = component();
      const before = await seedBuiltIns(t, builtIns);
      await seedWindows(t, 7, [1, 59_999]);
      measured.push(await measuredCleanup(t));
      expect((await windows(t)).map(row => row.key).sort()).toEqual(["session-read-ip:live-0#0", "session-read-ip:live-1#0"]);
      // Built-in buckets are untouched, stale ones included.
      expect(await t.run(ctx => ctx.db.query("rateLimit").collect())).toEqual(before);
      expect(before).toHaveLength(builtIns + 6);
    }
    // 7 deletions; one window query plus one empty range per retired prefix.
    expect(measured).toEqual([
      { documentsRead: 14, databaseQueries: 1 + retiredPrefixes.length },
      { documentsRead: 14, databaseQueries: 1 + retiredPrefixes.length },
    ]);
  });

  it("drains retired rows from Better Auth's table in bounded, continued batches", async () => {
    const t = component();
    const builtIns = await seedBuiltIns(t, 300);
    await seedWindows(t, 250, [1]);
    await t.run(async ctx => {
      for (const prefix of retiredPrefixes) {
        // Live retired windows go as well: consume no longer reads this table.
        for (let i = 0; i < (prefix === "session-read-ip:" ? 150 : 1); i++) {
          await ctx.db.insert("rateLimit", { key: `${prefix}${i}`, count: 9, lastRequest: start - i });
        }
      }
    });
    const first = await measuredCleanup(t);
    // Each source is bounded by its batch: 100 windows, 100 + 5 retired rows.
    expect(first).toEqual({ documentsRead: 2 * (cleanupBatch + cleanupBatch + 5), databaseQueries: 1 + retiredPrefixes.length });
    expect(await windows(t)).toHaveLength(150 + 1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await windows(t)).map(row => row.key)).toEqual(["session-read-ip:live-0#0"]);
    expect(await t.run(ctx => ctx.db.query("rateLimit").collect())).toEqual(builtIns);
  });

  it("schedules no continuation once every source is below its batch", async () => {
    const t = component();
    await seedWindows(t, cleanupBatch - 1, []);
    await t.mutation(internal.sessionReadLimit.cleanup, {});
    expect(await windows(t)).toEqual([]);
    expect(await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });

  it.each([true, false])("keeps a window restarted at its expiry boundary (cleanup first: %s)", async cleanupFirst => {
    const t = component();
    const key = "session-read-unverified:boundary";
    expect(await t.mutation(api.sessionReadLimit.consume, { key })).toBe(0);
    vi.setSystemTime(start + 60_000);
    const cleanup = () => t.mutation(internal.sessionReadLimit.cleanup, {});
    const consume = () => t.mutation(api.sessionReadLimit.consume, { key });
    await Promise.all((cleanupFirst ? [cleanup, consume] : [consume, cleanup]).map(run => run()));
    expect(await windows(t)).toMatchObject([{ key, count: 1, expiresAt: start + 120_000 }]);
  });
});

// Deterministic stand-in for Convex's per-execution Math.random.
function seededRandom(seed: number) {
  return () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
}
const ipKey = "session-read-ip:203.0.113.1";
const shardKey = (shard: number) => `${ipKey}#${shard}`;

describe("session-read window accounting", () => {
  it.each([
    ["session-read-unverified:203.0.113.1", 120],
    ["session-read:0123abcd", 600],
  ])("accepts exactly the limit of %s under concurrent requests", async (key, max) => {
    const t = component();
    expect(await t.mutation(api.sessionReadLimit.consume, { key })).toBe(0);
    // Skip setup traffic only: the window, its expiry and its key stay real.
    await t.run(async ctx => {
      const row = await ctx.db.query("sessionReadWindow").withIndex("key", q => q.eq("key", key)).unique();
      await ctx.db.patch(row!._id, { count: max - 20 });
    });
    vi.setSystemTime(start + 30_500);
    const results = await Promise.all(Array.from({ length: 40 }, () => t.mutation(api.sessionReadLimit.consume, { key })));
    expect(results.filter(retryAfter => retryAfter === 0)).toHaveLength(20);
    // Retry-After counts whole seconds to the fixed window's end.
    expect(results.filter(retryAfter => retryAfter === 30)).toHaveLength(20);
    expect(await windows(t)).toMatchObject([{ key, count: max, expiresAt: start + 60_000 }]);
    vi.setSystemTime(start + 59_999);
    expect(await t.mutation(api.sessionReadLimit.consume, { key })).toBe(1);
    vi.setSystemTime(start + 60_000);
    expect(await t.mutation(api.sessionReadLimit.consume, { key })).toBe(0);
    expect(await windows(t)).toMatchObject([{ key, count: 1, expiresAt: start + 120_000 }]);
    // The limiter never writes Better Auth's table.
    expect(await t.run(ctx => ctx.db.query("rateLimit").collect())).toEqual([]);
  });

  it("spreads one IP's concurrent reads over its shards instead of one hot row", async () => {
    const t = component();
    vi.spyOn(Math, "random").mockImplementation(seededRandom(97));
    const results = await Promise.all(Array.from({ length: 800 }, () => t.mutation(api.sessionReadLimit.consume, { key: ipKey })));
    expect(results.every(retryAfter => retryAfter === 0)).toBe(true);
    const rows = await windows(t);
    // Before #97 all 800 writes hit one row; now each shard takes about an eighth.
    expect(rows.map(row => row.key).sort()).toEqual(Array.from({ length: ipShards }, (_, shard) => shardKey(shard)));
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(800);
    expect(Math.max(...rows.map(row => row.count))).toBeLessThan(2 * 800 / ipShards);
    expect(rows.every(row => row.expiresAt === start + 60_000)).toBe(true);
  });

  it("accepts exactly 6,000 IP reads per window under concurrency, however the shards fill", async () => {
    const t = component();
    vi.spyOn(Math, "random").mockImplementation(seededRandom(6_000));
    // Uneven shards, as random starts leave them: some full, one never written.
    const counts = [750, 750, 749, 700, 745, 746, 0, 740];
    await t.run(async ctx => {
      for (const [shard, count] of counts.entries()) {
        if (count) await ctx.db.insert("sessionReadWindow", { key: shardKey(shard), count, expiresAt: start + 60_000 });
      }
    });
    vi.setSystemTime(start + 30_500);
    const results = await Promise.all(Array.from({ length: 1_000 }, () => t.mutation(api.sessionReadLimit.consume, { key: ipKey })));
    const accepted = 6_000 - counts.reduce((sum, count) => sum + count, 0);
    expect(results.filter(retryAfter => retryAfter === 0)).toHaveLength(accepted);
    expect(results.filter(retryAfter => retryAfter === 30)).toHaveLength(1_000 - accepted);
    const rows = await windows(t);
    expect(rows.map(row => row.count)).toEqual(Array<number>(ipShards).fill(750));
    // The never-written shard opened its own window when first used.
    expect(rows.find(row => row.key === shardKey(6))).toMatchObject({ expiresAt: start + 90_500 });
  });

  it("moves past full shards from a random start, wrapping around, and reports the earliest reset", async () => {
    const t = component();
    const random = vi.spyOn(Math, "random");
    await t.run(async ctx => {
      for (let shard = 0; shard < ipShards; shard++) {
        // Shard 2 resets first, 20 seconds in; the others at 40 seconds.
        await ctx.db.insert("sessionReadWindow", { key: shardKey(shard), count: 750, expiresAt: start + (shard === 2 ? 20_000 : 40_000) });
      }
    });
    random.mockReturnValue(0.99);
    expect(await t.mutation(api.sessionReadLimit.consume, { key: ipKey })).toBe(20);
    vi.setSystemTime(start + 19_001);
    expect(await t.mutation(api.sessionReadLimit.consume, { key: ipKey })).toBe(1);
    // Retrying at the reported time succeeds whichever shard it starts from:
    // from shard 7 it wraps through 0 and 1 to reach 2.
    vi.setSystemTime(start + 20_000);
    expect(await t.mutation(api.sessionReadLimit.consume, { key: ipKey })).toBe(0);
    expect((await windows(t)).find(row => row.key === shardKey(2))).toMatchObject({ count: 1, expiresAt: start + 80_000 });
    random.mockReturnValue(0.3);
    expect(await t.mutation(api.sessionReadLimit.consume, { key: ipKey })).toBe(0);
    expect((await windows(t)).find(row => row.key === shardKey(2))).toMatchObject({ count: 2 });
  });
});
