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

type AuthPage = { page: Array<Record<string, unknown> & { _id: string }> };
const runId = "b9f26d8a16c043e7";
const seedRef = makeFunctionReference<"action">("qaWorkspaceFixtures:seed");
const cleanupRef = makeFunctionReference<"action">("qaWorkspaceFixtures:cleanup");
const applicationRef = makeFunctionReference<"mutation">("qaWorkspaceFixtures:application");
const confirm = "deafening-beagle-38";

function lifecycleBackend() {
  vi.stubEnv("SITE_URL", "https://dev.rendro.app");
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, authModules);
  const create = (model: string, data: Record<string, unknown>) =>
    backend.mutation(components.betterAuth.adapter.create, { input: { model, data } as never }) as Promise<{ _id: string }>;
  const rows = async (model: string, where?: Array<{ field: string; value: unknown }>) =>
    (await backend.query(components.betterAuth.adapter.findMany, { model: model as "user", where: where as never, paginationOpts: { cursor: null, numItems: 1000 } }) as AuthPage).page;
  return { backend, create, rows };
}
async function fixtureOrganization(f: ReturnType<typeof lifecycleBackend>, slug = `qa-regression-${runId}`) {
  return f.create("organization", { name: "QA regression", slug, createdAt: Date.now() });
}

describe("large QA workspace lifecycle", () => {
  it("seeds a disposable workspace, refuses to reseed, and cleans up only its own data", async () => {
    const f = lifecycleBackend();
    const org = await fixtureOrganization(f);
    const bystanderOrg = await f.create("organization", { name: "Bystander", slug: "bystander", createdAt: Date.now() });
    const now = Date.now();
    const bystander = await f.create("user", { name: "Real user", email: "real@example.test", emailVerified: true, createdAt: now, updatedAt: now });
    const session = await f.create("session", { token: "real-token", userId: bystander._id, createdAt: now, updatedAt: now, expiresAt: now + 60_000, activeOrganizationId: org._id, activeTeamId: "stale-team" });
    const bystanderSession = await f.create("session", { token: "other-token", userId: bystander._id, createdAt: now, updatedAt: now, expiresAt: now + 60_000, activeOrganizationId: bystanderOrg._id });
    const bystanderProject = await f.backend.run(ctx => ctx.db.insert("projects", { organizationId: bystanderOrg._id, name: "Keep", slug: "keep", createdBy: "real", createdAt: now }));
    const bystanderAudit = await f.backend.run(ctx => ctx.db.insert("auditEvents", { organizationId: bystanderOrg._id, actorId: "real", action: "project.create", resourceType: "project", resourceId: "keep", createdAt: now }));

    const seeded = await f.backend.action(seedRef, { confirmDeployment: confirm, organizationId: org._id, runId });
    expect(seeded).toEqual({ runId, organizationId: org._id, users: 120, projects: 120, teams: 12 });

    const members = await f.rows("member", [{ field: "organizationId", value: org._id }]);
    expect(members).toHaveLength(120);
    expect(members.filter(member => member.role === "admin")).toHaveLength(1);
    expect(members.filter(member => member.role === "member")).toHaveLength(119);
    const users = (await f.rows("user")).filter(user => String(user.email).endsWith(`-${runId}@rendro.invalid`));
    expect(users).toHaveLength(120);
    expect(users.every(user => user.emailVerified === true)).toBe(true);
    expect(users.map(user => user.name)).toContain("QA Member 120");
    expect(await f.rows("team", [{ field: "organizationId", value: org._id }])).toHaveLength(12);
    // Synthetic users never get credentials or sessions.
    expect(await f.rows("account")).toEqual([]);
    expect((await f.rows("session")).map(row => row._id).sort()).toEqual([session._id, bystanderSession._id].sort());
    const projects = await f.backend.run(ctx => ctx.db.query("projects").withIndex("by_organization", q => q.eq("organizationId", org._id)).collect());
    expect(projects).toHaveLength(120);
    expect(projects.every(project => project.createdBy === `qa-${runId}` && project.slug.startsWith("qa-scale-"))).toBe(true);
    expect(projects.find(project => project.slug === "qa-scale-120")?.name).toBe("QA scale project 120 — long documentation product title");

    // The second attempt fails at the first existing user, before changing anything.
    await expect(f.backend.action(seedRef, { confirmDeployment: confirm, organizationId: org._id, runId })).rejects.toThrow("Fixture already seeded; clean up first");
    expect(await f.rows("member", [{ field: "organizationId", value: org._id }])).toHaveLength(120);
    // The application half independently refuses duplicate project seeds.
    await expect(f.backend.mutation(applicationRef, { organizationId: org._id, runId, cleanup: false })).rejects.toThrow("Fixture already seeded");

    // Audit rows for the fixture workspace are removed with its projects.
    await f.backend.run(ctx => ctx.db.insert("auditEvents", { organizationId: org._id, actorId: "qa", action: "project.create", resourceType: "project", resourceId: "x", createdAt: now }));
    const result = await f.backend.action(cleanupRef, { confirmDeployment: confirm, organizationId: org._id, runId });
    expect(result).toEqual({ runId, deletedApplication: 121, deletedUsers: 120, remaining: 0 });

    expect(await f.rows("organization")).toMatchObject([{ _id: bystanderOrg._id, slug: "bystander" }]);
    expect(await f.rows("member")).toEqual([]);
    expect(await f.rows("team")).toEqual([]);
    expect((await f.rows("user")).map(user => user._id)).toEqual([bystander._id]);
    // The signed-in user's session survives; only the pointer to the deleted workspace is cleared.
    const survivors = await f.rows("session");
    expect(survivors).toHaveLength(2);
    expect(survivors.find(row => row._id === session._id)).toMatchObject({ token: "real-token", activeOrganizationId: null, activeTeamId: null });
    expect(survivors.find(row => row._id === bystanderSession._id)).toMatchObject({ activeOrganizationId: bystanderOrg._id });
    const after = await f.backend.run(async ctx => ({ projects: await ctx.db.query("projects").collect(), audits: await ctx.db.query("auditEvents").collect() }));
    expect(after.projects.map(project => project._id)).toEqual([bystanderProject]);
    expect(after.audits.map(audit => audit._id)).toEqual([bystanderAudit]);
  }, 90_000);

  it("cleans up a partially seeded workspace, including teams, rosters and invitations", async () => {
    const f = lifecycleBackend();
    const org = await fixtureOrganization(f);
    const now = Date.now();
    // Only some deterministic users exist, as after an interrupted seed.
    const user = await f.create("user", { name: "QA Member 001", email: `qa-scale-0-${runId}@rendro.invalid`, emailVerified: true, createdAt: now, updatedAt: now });
    await f.create("account", { userId: user._id, accountId: "a", providerId: "credential", createdAt: now, updatedAt: now });
    await f.create("session", { token: "synthetic", userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 60_000 });
    await f.create("member", { organizationId: org._id, userId: user._id, role: "admin", createdAt: now });
    const team = await f.create("team", { organizationId: org._id, name: "QA team 1", createdAt: now });
    await f.create("teamMember", { teamId: team._id, userId: user._id, createdAt: now });
    await f.create("invitation", { organizationId: org._id, email: "x@example.test", role: "member", status: "pending", inviterId: user._id, expiresAt: now + 60_000, createdAt: now });

    const result = await f.backend.action(cleanupRef, { confirmDeployment: confirm, organizationId: org._id, runId });
    expect(result).toEqual({ runId, deletedApplication: 0, deletedUsers: 1, remaining: 0 });
    for (const model of ["organization", "user", "account", "session", "member", "team", "teamMember", "invitation"]) expect(await f.rows(model), model).toEqual([]);
  });

  it("refuses cleanup while API keys still reference the workspace", async () => {
    const f = lifecycleBackend();
    const org = await fixtureOrganization(f);
    const now = Date.now();
    const projectId = await f.backend.run(ctx => ctx.db.insert("projects", { organizationId: org._id, name: "P", slug: "p", createdBy: "qa", createdAt: now }));
    const run = () => f.backend.action(cleanupRef, { confirmDeployment: confirm, organizationId: org._id, runId });
    const keyId = await f.backend.run(ctx => ctx.db.insert("apiKeyCredentials", { organizationId: org._id, keyId: "k", keyPrefix: "p", name: "n", secretHash: "h", scopes: [], createdBy: "qa", createdAt: now }));
    await expect(run()).rejects.toThrow("Workspace has additional resources; explicit cleanup required");
    // Nothing was removed by the refused attempts.
    expect(await f.rows("organization")).toHaveLength(1);
    expect(await f.backend.run(ctx => ctx.db.get(projectId))).not.toBeNull();
    expect(await f.backend.run(ctx => ctx.db.get(keyId))).not.toBeNull();
  });

  it("rejects absent or malformed organization identifiers before changing anything", async () => {
    const f = lifecycleBackend();
    const org = await fixtureOrganization(f);
    await f.backend.mutation(components.betterAuth.adapter.deleteOne, { input: { model: "organization", where: [{ field: "_id", value: org._id }] } });
    for (const action of [seedRef, cleanupRef]) {
      for (const organizationId of [org._id, "not-an-id", ""]) {
        await expect(f.backend.action(action, { confirmDeployment: confirm, organizationId, runId }), `${organizationId}`).rejects.toThrow("Fixture organization mismatch");
      }
    }
    for (const cleanup of [true, false]) await expect(f.backend.mutation(applicationRef, { organizationId: org._id, runId, cleanup })).rejects.toThrow("Fixture organization mismatch");
    expect(await f.rows("user")).toEqual([]);
    expect(await f.backend.run(ctx => ctx.db.query("projects").collect())).toEqual([]);
  });

  it("rejects malformed run identifiers for the internal mutation before touching data", async () => {
    const f = lifecycleBackend();
    const org = await fixtureOrganization(f, "qa-regression-NOT-HEX");
    for (const bad of ["", "B9F26D8A16C043E7", "b9f26d8a16c043e", "b9f26d8a16c043e7x"]) {
      await expect(f.backend.mutation(applicationRef, { organizationId: org._id, runId: bad, cleanup: true })).rejects.toThrow("DEV fixture identity required");
      await expect(f.backend.action(seedRef, { confirmDeployment: confirm, organizationId: org._id, runId: bad })).rejects.toThrow("DEV fixture identity required");
    }
    expect(await f.rows("organization")).toHaveLength(1);
  });
});
