import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../convex/_generated/api";
import { writeQuotaLimiter, writeQuotaLimits, consumeWriteQuota } from "../convex/writeQuotas";
import { cookieWriteFixture, admissionHeaders } from "./helpers/cookie-write-fixture";
import { fixture as commentFixture, repoAnchor } from "./helpers/comment-fixture";
import { failure } from "../convex/httpErrors";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("transactional write quotas", () => {
  it.each(Object.keys(writeQuotaLimits) as Array<keyof typeof writeQuotaLimits>)("enforces %s actor and organization boundaries with isolated controls and refill", async resource => {
    const { backend } = await cookieWriteFixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const config = writeQuotaLimits[resource];
    for (let i = 0; i < config.capacity; i++) await backend.run(ctx => consumeWriteQuota(ctx, resource, "actor", "tenant"));
    await expect(backend.run(ctx => consumeWriteQuota(ctx, resource, "actor", "other-tenant"))).rejects.toMatchObject({ data: { kind: "RateLimited" } });
    await backend.run(ctx => consumeWriteQuota(ctx, resource, "other-actor", "tenant"));
    // Fill only the organization bucket; a denied write must roll back its user debit.
    const orgConfig = { ...config, rate: config.rate * 10, capacity: config.capacity * 10 };
    await backend.run(ctx => writeQuotaLimiter.limit(ctx, `${resource}:organization`, { key: "full-tenant", config: orgConfig, count: orgConfig.capacity }));
    await expect(backend.run(ctx => consumeWriteQuota(ctx, resource, "fresh", "full-tenant"))).rejects.toMatchObject({ data: { kind: "RateLimited" } });
    for (let i = 0; i < config.capacity; i++) await backend.run(ctx => consumeWriteQuota(ctx, resource, "fresh", "fresh-tenant"));
    vi.mocked(Date.now).mockReturnValue(Date.now() + config.period / config.rate);
    await backend.run(ctx => consumeWriteQuota(ctx, resource, "actor", "tenant"));
  });

  it.each([
    ["projects", "/api/rendro/projects", "projects"],
    ["credentials", "/api/rendro/credentials", "apiKeyCredentials"],
  ] as const)("returns actionable HTTP 429 for %s before any persistent write", async (resource, path, table) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const f = await cookieWriteFixture();
    const key = `user:${f.user._id}`;
    await f.backend.run(async ctx => {
      await writeQuotaLimiter.reset(ctx, resource, { key });
      await writeQuotaLimiter.limit(ctx, resource, { key, count: writeQuotaLimits[resource].capacity - 1 });
    });
    const first = await f.post(path);
    expect(first.status).toBe(201);
    const before = await f.backend.run(ctx => ctx.db.query(table).collect());
    const response = await f.post(path);
    const seconds = Math.ceil(writeQuotaLimits[resource].period / writeQuotaLimits[resource].rate / 1000);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(seconds));
    expect(await response.json()).toEqual({ error: `Too many writes. Please try again in ${seconds} seconds.`, code: "rate_limited" });
    expect(await f.backend.run(ctx => ctx.db.query(table).collect())).toEqual(before);
    // Revocation remains available when creation is exhausted.
    if (resource !== "projects") expect((await f.post("/api/rendro/credentials/revoke")).status).toBe(200);
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

  it("rolls back quotas along with invalid project writes", async () => {
    const { backend } = await cookieWriteFixture();
    const args = { organizationId: "tenant", actorId: "actor", name: "Docs", slug: "invalid_" };
    for (let i = 0; i < writeQuotaLimits.projects.capacity + 1; i++) await expect(backend.mutation(internal.projects.createInternal, args)).rejects.toThrow("Project slug");
    expect(await backend.mutation(internal.projects.createInternal, { ...args, slug: "valid" })).toBeTruthy();
  });
});

it("sanitizes limiter errors and rejects unauthenticated management writes without consuming another actor's quota", async () => {
  const f = await cookieWriteFixture();
  const response = await f.backend.fetch("/api/rendro/projects", { method: "POST", headers: admissionHeaders(), body: JSON.stringify(f.bodies["/api/rendro/projects"]) });
  expect(response.status).toBe(403);
  const limited = failure(new ConvexError({ kind: "RateLimited", name: "private-name", retryAfter: 0 }));
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("1");
  expect(await limited.text()).not.toContain("private-name");
});
