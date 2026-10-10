import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { components } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";
const modules = import.meta.glob("../convex/**/*.ts"), authModules = import.meta.glob("../convex/betterAuth/**/*.ts");
const args = { confirmDeployment: "deafening-beagle-38", organizationId: "not-a-fixture", runId: "b9f26d8a16c043e7" };
afterEach(() => vi.unstubAllEnvs());
describe("large QA workspace safeguards", () => {
  it.each(["seed", "cleanup"])("refuses %s on production", async action => {
    vi.stubEnv("SITE_URL", "https://rendro.app");
    const backend = convexTest(schema, modules);
    await expect(backend.action(makeFunctionReference<"action">(`qaWorkspaceFixtures:${action}`), args)).rejects.toThrow("DEV fixture identity required");
  });
  it.each(["seed", "cleanup"])("refuses %s for a non-fixture organization", async action => {
    vi.stubEnv("SITE_URL", "https://dev.rendro.app");
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, authModules);
    const org = await backend.mutation(components.betterAuth.adapter.create, { input: { model: "organization", data: { name: "Real organization", slug: "real-org", createdAt: Date.now() } } }) as { _id: string };
    await expect(backend.action(makeFunctionReference<"action">(`qaWorkspaceFixtures:${action}`), { ...args, organizationId: org._id })).rejects.toThrow("Fixture organization mismatch");
    const remaining = await backend.query(components.betterAuth.adapter.findMany, { model: "organization", paginationOpts: { cursor: null, numItems: 10 } }) as { page: unknown[] };
    expect(remaining.page).toHaveLength(1);
  });
});
