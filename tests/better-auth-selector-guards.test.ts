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
  const organization = await create("organization", { name: "Org", slug: "org", createdAt: now });
  const other = await create("organization", { name: "Other", slug: "other", createdAt: now });
  const team = await create("team", { organizationId: organization._id, name: "Team", createdAt: now });
  return { backend, create, organization, other, team };
}
const page = { numItems: 10, cursor: null };

describe("Better Auth team lookup", () => {
  it("returns the owning organization for a real team only", async () => {
    const f = await fixture();
    const lookup = (teamId: string) => f.backend.query(components.betterAuth.teamLookup.get, { teamId });
    expect(await lookup(f.team._id)).toEqual({ organizationId: f.organization._id });
    // Malformed, wrong-table, and well-formed-but-deleted IDs are indistinguishable absences.
    expect(await lookup("not-an-id")).toBeNull();
    expect(await lookup(f.organization._id)).toBeNull();
    await f.backend.mutation(components.betterAuth.adapter.deleteOne, { input: { model: "team", where: [{ field: "_id", value: f.team._id }] } });
    expect(await lookup(f.team._id)).toBeNull();
  });
});

describe("Better Auth adapter _id selector normalization", () => {
  it("leaves non-_id clauses and unsupported _id operators untouched", async () => {
    const f = await fixture();
    const slugs = async (where: Array<{ field: string; operator?: string; value: unknown }>) =>
      ((await f.backend.query(components.betterAuth.adapter.findMany, { model: "organization", where: where as never, paginationOpts: page })).page as Array<{ slug: string }>).map(row => row.slug).sort();
    expect(await slugs([{ field: "slug", value: "org" }])).toEqual(["org"]);
    // not_in is not rewritten: it still excludes the real id rather than becoming an empty selector.
    expect(await slugs([{ field: "_id", operator: "not_in", value: [f.organization._id] }])).toEqual(["other"]);
    // Operators the upstream adapter does not allow on _id are still rejected, not silently widened.
    await expect(slugs([{ field: "_id", operator: "ne", value: f.organization._id }])).rejects.toThrow("_id can only be used with eq, in, or not_in");
    // A non-array "in" value is passed through for the upstream adapter to reject, not coerced.
    await expect(slugs([{ field: "_id", operator: "in", value: f.organization._id }])).rejects.toThrow();
  });

  it("matches only real ids for explicit eq and in selectors, dropping foreign, malformed and non-string ids", async () => {
    const f = await fixture();
    const slugs = async (where: Array<{ field: string; operator?: string; value: unknown }>) =>
      ((await f.backend.query(components.betterAuth.adapter.findMany, { model: "organization", where: where as never, paginationOpts: page })).page as Array<{ slug: string }>).map(row => row.slug).sort();
    expect(await slugs([{ field: "_id", operator: "eq", value: f.organization._id }])).toEqual(["org"]);
    expect(await slugs([{ field: "_id", operator: "eq", value: "not-an-id" }])).toEqual([]);
    expect(await slugs([{ field: "_id", operator: "in", value: [f.organization._id, f.other._id, f.team._id, "not-an-id"] }])).toEqual(["org", "other"]);
    // Non-string members of an id list can never name a record.
    expect(await slugs([{ field: "_id", operator: "in", value: [7] }])).toEqual([]);
  });

  it("keeps requests without selectors working", async () => {
    const f = await fixture();
    const rows = await f.backend.query(components.betterAuth.adapter.findMany, { model: "organization", paginationOpts: page });
    expect(rows.page).toHaveLength(2);
  });
});
