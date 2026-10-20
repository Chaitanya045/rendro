import rateLimiterTest from "./convex-rate-limiter";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { components } from "../convex/_generated/api";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";

// The Better Auth component's adapter, with real session records in convex-test.
async function fixture() {
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const now = Date.now();
  const ids = await backend.run(async ctx => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "user", data: { name: "Owner", email: "owner@example.test", emailVerified: true, createdAt: now, updatedAt: now },
    } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "session", data: { userId: user._id, token: "test-session-token", createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
    } });
    return { userId: user._id as string, sessionId: session._id as string };
  });
  return { backend, ...ids };
}

describe("Better Auth adapter IDs", () => {
  it("guards adapter reads and writes while preserving valid selectors", async () => {
    const f = await fixture();
    // A malformed id and a real id of another table name no session.
    for (const id of ["not-an-id", f.userId]) {
      const where = [{ field: "_id" as const, value: id }];
      expect(await f.backend.query(components.betterAuth.adapter.findOne, { model: "session", where })).toBeNull();
      expect(await f.backend.mutation(components.betterAuth.adapter.updateOne, { input: { model: "session", where, update: { ipAddress: "x" } } })).toBeNull();
      await f.backend.mutation(components.betterAuth.adapter.deleteOne, { input: { model: "session", where } });
      expect(await f.backend.mutation(components.betterAuth.adapter.updateMany, { input: { model: "session", where, update: { ipAddress: "x" } }, paginationOpts: { numItems: 10, cursor: null } })).toMatchObject({ count: 0 });
      expect(await f.backend.mutation(components.betterAuth.adapter.deleteMany, { input: { model: "session", where }, paginationOpts: { numItems: 10, cursor: null } })).toMatchObject({ count: 0 });
    }
    const result = await f.backend.query(components.betterAuth.adapter.findMany, {
      model: "session", where: [{ field: "_id", operator: "in", value: [f.sessionId, f.userId, "not-an-id"] }], paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page.map((row: { _id: string }) => row._id)).toEqual([f.sessionId]);
    expect(await f.backend.mutation(components.betterAuth.adapter.updateOne, { input: { model: "session", where: [{ field: "_id", value: f.sessionId }], update: { ipAddress: "192.0.2.1" } } })).toMatchObject({ ipAddress: "192.0.2.1" });
  });
});
