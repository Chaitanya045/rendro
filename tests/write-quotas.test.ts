import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { writeQuotaLimiter, writeQuotaLimits, consumeWriteQuota } from "../convex/writeQuotas";
import { cookieWriteFixture } from "./helpers/cookie-write-fixture";
import { fixture as commentFixture, repoAnchor } from "./helpers/comment-fixture";
import { failure } from "../convex/httpErrors";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("transactional write quotas", () => {
  it.each(Object.keys(writeQuotaLimits) as Array<keyof typeof writeQuotaLimits>)("enforces %s actor and tenant boundaries with isolated controls and refill", async resource => {
    const { backend } = await cookieWriteFixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const config = writeQuotaLimits[resource];
    for (let i = 0; i < config.capacity; i++) await backend.run(ctx => consumeWriteQuota(ctx, resource, "actor", "tenant"));
    await expect(backend.run(ctx => consumeWriteQuota(ctx, resource, "actor", "other-tenant"))).rejects.toMatchObject({ data: { kind: "RateLimited" } });
    await backend.run(ctx => consumeWriteQuota(ctx, resource, "other-actor", "tenant"));
    // Fill only the tenant bucket; a denied write must roll back its user debit.
    const orgConfig = { ...config, rate: config.rate * 10, capacity: config.capacity * 10 };
    await backend.run(ctx => writeQuotaLimiter.limit(ctx, `${resource}:organization`, { key: "full-tenant", config: orgConfig, count: orgConfig.capacity }));
    await expect(backend.run(ctx => consumeWriteQuota(ctx, resource, "fresh", "full-tenant"))).rejects.toMatchObject({ data: { kind: "RateLimited" } });
    for (let i = 0; i < config.capacity; i++) await backend.run(ctx => consumeWriteQuota(ctx, resource, "fresh", "fresh-tenant"));
    vi.mocked(Date.now).mockReturnValue(Date.now() + config.period / config.rate);
    await backend.run(ctx => consumeWriteQuota(ctx, resource, "actor", "tenant"));
  });

  it("limits direct comment RPCs by authenticated author across threads/replies and preserves retry deduplication", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const f = await commentFixture();
    const userId = f.data.users[0].userId;
    const key = `user:${userId}`;
    await f.backend.run(async ctx => {
      await writeQuotaLimiter.reset(ctx, "comments", { key });
      await writeQuotaLimiter.limit(ctx, "comments", { key, count: writeQuotaLimits.comments.capacity - 1 });
    });
    const args = { ...f.scope, body: "new", anchor: repoAnchor(), clientOperationId: "operation-limit-123" };
    const id = await f.viewers.author.mutation(api.repoComments.createThread, args);
    expect(await f.viewers.author.mutation(api.repoComments.createThread, args)).toBe(id);
    await expect(f.viewers.author.mutation(api.repoComments.createThread, { ...args, clientOperationId: undefined })).rejects.toMatchObject({ data: { kind: "RateLimited" } });
    await expect(f.viewers.author.mutation(api.repoComments.addReply, { ...f.scope, threadId: id, body: "denied" })).rejects.toMatchObject({ data: { kind: "RateLimited" } });
    await f.viewers.member.mutation(api.repoComments.addReply, { ...f.scope, threadId: id, body: "allowed" });
    expect((await f.backend.run(ctx => ctx.db.query("repoThreads").collect())).length).toBe(2);
    expect((await f.backend.run(ctx => ctx.db.query("repoReplies").collect())).length).toBe(3);
  });

});

it("sanitizes limiter errors", async () => {
  const limited = failure(new ConvexError({ kind: "RateLimited", name: "private-name", retryAfter: 0 }));
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("1");
  expect(await limited.text()).not.toContain("private-name");
});
