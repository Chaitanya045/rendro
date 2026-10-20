import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { components } from "../convex/_generated/api";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";

async function fixture() {
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const now = Date.now();
  const create = (model: string, data: Record<string, unknown>) => backend.mutation(components.betterAuth.adapter.create, { input: { model, data } as never }) as Promise<{ _id: string }>;
  const user = (name: string) => create("user", { name, email: `${name}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
  const reader = await user("reader");
  const other = await user("other");
  // A real id of another table: never a user.
  const session = await create("session", { token: "token", userId: reader._id, createdAt: now, updatedAt: now, expiresAt: now + 60_000 });
  return { backend, reader, other, session };
}
const page = { numItems: 10, cursor: null };

describe("Better Auth adapter _id selector normalization", () => {
  const names = async (f: Awaited<ReturnType<typeof fixture>>, where: Array<{ field: string; operator?: string; value: unknown }>) =>
    ((await f.backend.query(components.betterAuth.adapter.findMany, { model: "user", where: where as never, paginationOpts: page })).page as Array<{ name: string }>).map(row => row.name).sort();

  it("leaves non-_id clauses and unsupported _id operators untouched", async () => {
    const f = await fixture();
    expect(await names(f, [{ field: "name", value: "reader" }])).toEqual(["reader"]);
    // not_in is not rewritten: it still excludes the real id rather than becoming an empty selector.
    expect(await names(f, [{ field: "_id", operator: "not_in", value: [f.reader._id] }])).toEqual(["other"]);
    // Operators the upstream adapter does not allow on _id are still rejected, not silently widened.
    await expect(names(f, [{ field: "_id", operator: "ne", value: f.reader._id }])).rejects.toThrow("_id can only be used with eq, in, or not_in");
    // A non-array "in" value is passed through for the upstream adapter to reject, not coerced.
    await expect(names(f, [{ field: "_id", operator: "in", value: f.reader._id }])).rejects.toThrow();
  });

  it("matches only real ids for explicit eq and in selectors, dropping foreign, malformed and non-string ids", async () => {
    const f = await fixture();
    expect(await names(f, [{ field: "_id", operator: "eq", value: f.reader._id }])).toEqual(["reader"]);
    expect(await names(f, [{ field: "_id", operator: "eq", value: "not-an-id" }])).toEqual([]);
    expect(await names(f, [{ field: "_id", operator: "in", value: [f.reader._id, f.other._id, f.session._id, "not-an-id"] }])).toEqual(["other", "reader"]);
    // Non-string members of an id list can never name a record.
    expect(await names(f, [{ field: "_id", operator: "in", value: [7] }])).toEqual([]);
  });

  it("keeps requests without selectors working", async () => {
    const f = await fixture();
    const rows = await f.backend.query(components.betterAuth.adapter.findMany, { model: "user", paginationOpts: page });
    expect(rows.page).toHaveLength(2);
  });
});
