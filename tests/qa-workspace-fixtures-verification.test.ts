import { afterEach, describe, expect, it, vi } from "vitest";
import type * as RendroAuth from "../convex/auth";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { components } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";

// Simulate a Better Auth backend that acknowledges deletes without applying
// them. The cleanup report must surface such leftovers instead of claiming success.
const skipped = vi.hoisted(() => ({ models: new Set<string>(), users: false }));
vi.mock("../convex/auth", async importOriginal => {
  const original = await importOriginal<typeof RendroAuth>();
  return {
    ...original,
    createAuth: (ctx: Parameters<typeof original.createAuth>[0]) => {
      const auth = original.createAuth(ctx);
      const context = auth.$context.then(real => ({
        ...real,
        adapter: { ...real.adapter, delete: (input: { model: string }): Promise<void> => skipped.models.has(input.model) ? Promise.resolve() : real.adapter.delete(input as never) },
        internalAdapter: { ...real.internalAdapter, deleteUser: (id: string): Promise<void> => skipped.users ? Promise.resolve() : real.internalAdapter.deleteUser(id) },
      }));
      return Object.assign(Object.create(auth) as typeof auth, { $context: context });
    },
  };
});

const runId = "b9f26d8a16c043e7";
const cleanup = makeFunctionReference<"action">("qaWorkspaceFixtures:cleanup");
afterEach(() => { vi.unstubAllEnvs(); skipped.models.clear(); skipped.users = false; });

async function workspace() {
  vi.stubEnv("SITE_URL", "https://dev.rendro.app");
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const create = (model: string, data: Record<string, unknown>) => backend.mutation(components.betterAuth.adapter.create, { input: { model, data } as never }) as Promise<{ _id: string }>;
  const now = Date.now();
  const organization = await create("organization", { name: "QA", slug: `qa-regression-${runId}`, createdAt: now });
  for (const index of [0, 1]) await create("user", { name: `QA ${index}`, email: `qa-scale-${index}-${runId}@rendro.invalid`, emailVerified: true, createdAt: now, updatedAt: now });
  const count = async (model: string) => ((await backend.query(components.betterAuth.adapter.findMany, { model: model as "user", paginationOpts: { cursor: null, numItems: 100 } })) as { page: unknown[] }).page.length;
  return { backend, organization, count };
}

describe("QA workspace cleanup verification", () => {
  it("reports leftover organization and user records instead of a clean result", async () => {
    const f = await workspace();
    skipped.models.add("organization");
    skipped.users = true;
    const result = await f.backend.action(cleanup, { confirmDeployment: "deafening-beagle-38", organizationId: f.organization._id, runId });
    expect(result).toEqual({ runId, deletedApplication: 0, deletedUsers: 2, remaining: 3 });
    expect(await f.count("organization")).toBe(1);
    expect(await f.count("user")).toBe(2);
  });

  it("reports zero remaining when every delete is applied", async () => {
    const f = await workspace();
    const result = await f.backend.action(cleanup, { confirmDeployment: "deafening-beagle-38", organizationId: f.organization._id, runId });
    expect(result).toEqual({ runId, deletedApplication: 0, deletedUsers: 2, remaining: 0 });
    expect(await f.count("organization")).toBe(0);
    expect(await f.count("user")).toBe(0);
  });
});
