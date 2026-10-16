import rateLimiterTest from "./convex-rate-limiter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { components } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("../convex/**/*.ts");
const betterAuthModules = import.meta.glob("../convex/betterAuth/**/*.ts");

type FixtureResult = {
  runId: string;
  checks: Array<{ name: string; expected: number; actual: number; passed: boolean }>;
  passed: number;
  total: number;
  cleanupDeleted: number;
  remaining: number;
  cleanupFailed: boolean;
  executionError: string | null;
  phase: string;
};

const runFixture = makeFunctionReference<
  "action",
  { confirmDeployment: "deafening-beagle-38" },
  FixtureResult
>("qaPermissionFixtures:run");

const runFixtureWithUnvalidatedArgs = makeFunctionReference<
  "action",
  { confirmDeployment: string },
  FixtureResult
>("qaPermissionFixtures:run");

function fixtureBackend() {
  const backend = convexTest(schema, modules);
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

const paginationOpts = { cursor: null, numItems: 100 };

async function authFixturePages(backend: ReturnType<typeof fixtureBackend>) {
  const [users, organizations, members, sessions] = await Promise.all([
    backend.query(components.betterAuth.adapter.findMany, {
      model: "user",
      paginationOpts,
    }),
    backend.query(components.betterAuth.adapter.findMany, {
      model: "organization",
      paginationOpts,
    }),
    backend.query(components.betterAuth.adapter.findMany, {
      model: "member",
      paginationOpts,
    }),
    backend.query(components.betterAuth.adapter.findMany, {
      model: "session",
      paginationOpts,
    }),
  ]);
  return {
    users: users.page,
    organizations: organizations.page,
    members: members.page,
    sessions: sessions.page,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("QA permission fixtures", () => {
  it("seeds Better Auth fixtures and cleans them up after an HTTP failure", async () => {
    vi.stubEnv("SITE_URL", "https://dev.rendro.app");
    const backend = fixtureBackend();
    let fixturesAtFailure: Awaited<ReturnType<typeof authFixturePages>> | undefined;
    const outboundFailure = new TypeError("controlled test-only HTTP failure");
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      fixturesAtFailure = await authFixturePages(backend);
      throw outboundFailure;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await backend.action(runFixture, {
      confirmDeployment: "deafening-beagle-38",
    });

    expect(result).toMatchObject({
      phase: "authenticate-owner",
      executionError: "TypeError",
      cleanupFailed: false,
      remaining: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://dev.rendro.app/api/auth/get-session",
    );
    expect(fixturesAtFailure).toMatchObject({
      users: { length: 4 },
      organizations: { length: 2 },
      members: { length: 4 },
      sessions: { length: 1 },
    });
    expect(result.runId).toMatch(/^[a-f0-9]{16}$/);

    const applicationFixtures = await backend.run(async (ctx) => ({
      projects: await ctx.db.query("projects").collect(),
      credentials: await ctx.db.query("apiKeyCredentials").collect(),
    }));
    expect(applicationFixtures).toEqual({ projects: [], credentials: [] });

    expect(await authFixturePages(backend)).toEqual({
      users: [],
      organizations: [],
      members: [],
      sessions: [],
    });
  }, 15_000);

  it("rejects a non-development site before seeding or making HTTP calls", async () => {
    vi.stubEnv("SITE_URL", "https://rendro.app");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const backend = fixtureBackend();

    await expect(backend.action(runFixture, {
      confirmDeployment: "deafening-beagle-38",
    })).rejects.toThrow("QA permission fixtures require the dev site");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await authFixturePages(backend)).toEqual({
      users: [],
      organizations: [],
      members: [],
      sessions: [],
    });
  });

  it("rejects the wrong deployment confirmation before executing the action", async () => {
    vi.stubEnv("SITE_URL", "https://dev.rendro.app");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const backend = fixtureBackend();

    await expect(backend.action(runFixtureWithUnvalidatedArgs, {
      confirmDeployment: "production",
    })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await authFixturePages(backend)).toEqual({
      users: [],
      organizations: [],
      members: [],
      sessions: [],
    });
  });
});

const cleanupApplication = makeFunctionReference<"mutation", { runId: string; projectIds: string[]; keyIds: string[] }, number>("qaPermissionFixtures:cleanupApplicationFixtures");
const countApplication = makeFunctionReference<"mutation", { projectIds: string[]; keyIds: string[] }, number>("qaPermissionFixtures:countApplicationFixtures");
const fixtureRun = "0123456789abcdef";

async function applicationFixtures(backend: ReturnType<typeof fixtureBackend>, suffix = fixtureRun) {
  const now = Date.now();
  return backend.run(async ctx => {
    const projectId = await ctx.db.insert("projects", { organizationId: "org", name: "fixture", slug: `owner-${suffix}`, createdBy: "qa", createdAt: now });
    const bystanderId = await ctx.db.insert("projects", { organizationId: "org", name: "bystander", slug: "bystander", createdBy: "qa", createdAt: now });
    await ctx.db.insert("apiKeyCredentials", { organizationId: "org", keyId: "fixture-key", keyPrefix: "p", name: `owner-${suffix}`, secretHash: "h1", scopes: [], createdBy: "qa", createdAt: now });
    await ctx.db.insert("apiKeyCredentials", { organizationId: "org", keyId: "other-key", keyPrefix: "p", name: "other", secretHash: "h2", scopes: [], createdBy: "qa", createdAt: now });
    const audit = (resourceType: string, resourceId: string) => ctx.db.insert("auditEvents", { organizationId: "org", actorId: "qa", action: "x", resourceType, resourceId, createdAt: now });
    await audit("api_key", "fixture-key"); await audit("api_key", "fixture-key"); await audit("api_key", "other-key");
    await audit("project", projectId); await audit("project", bystanderId);
    return { projectId, bystanderId };
  });
}
const tableCounts = (backend: ReturnType<typeof fixtureBackend>) => backend.run(async ctx => ({
  projects: (await ctx.db.query("projects").collect()).map(row => row.slug).sort(),
  credentials: (await ctx.db.query("apiKeyCredentials").collect()).map(row => row.keyId).sort(),
  audits: (await ctx.db.query("auditEvents").collect()).map(row => `${row.resourceType}:${row.resourceId.length > 12 ? "project" : row.resourceId}`).sort(),
}));

describe("QA permission fixture application cleanup", () => {
  it("deletes only the fixture's own credentials, projects and their audit trail", async () => {
    vi.stubEnv("SITE_URL", "https://dev.rendro.app");
    const backend = fixtureBackend();
    const { projectId } = await applicationFixtures(backend);
    expect(await backend.mutation(countApplication, { projectIds: [projectId], keyIds: ["fixture-key", "missing-key"] })).toBe(2);
    // 1 credential + 2 audits + 1 project + 1 audit
    expect(await backend.mutation(cleanupApplication, { runId: fixtureRun, projectIds: [projectId], keyIds: ["fixture-key"] })).toBe(5);
    expect(await tableCounts(backend)).toEqual({ projects: ["bystander"], credentials: ["other-key"], audits: ["api_key:other-key", "project:project"] });
    expect(await backend.mutation(countApplication, { projectIds: [projectId], keyIds: ["fixture-key"] })).toBe(0);
    expect(await backend.mutation(cleanupApplication, { runId: fixtureRun, projectIds: [], keyIds: [] })).toBe(0);
  });

  it.each([
    ["a production site", "https://rendro.app", fixtureRun],
    ["an unset site", "", fixtureRun],
    ["a malformed run ID", "https://dev.rendro.app", "0123456789ABCDEF"],
    ["a short run ID", "https://dev.rendro.app", "0123"],
  ])("refuses cleanup for %s without touching data", async (_label, site, runId) => {
    vi.stubEnv("SITE_URL", site);
    const backend = fixtureBackend();
    const { projectId } = await applicationFixtures(backend);
    const before = await tableCounts(backend);
    await expect(backend.mutation(cleanupApplication, { runId, projectIds: [projectId], keyIds: ["fixture-key"] })).rejects.toThrow("QA fixture cleanup requires the dev site and a valid run ID");
    expect(await tableCounts(backend)).toEqual(before);
  });

  it("refuses to delete credentials or projects that do not carry the run's identity", async () => {
    vi.stubEnv("SITE_URL", "https://dev.rendro.app");
    const backend = fixtureBackend();
    const { projectId, bystanderId } = await applicationFixtures(backend);
    const before = await tableCounts(backend);
    const otherRun = "fedcba9876543210";
    await expect(backend.mutation(cleanupApplication, { runId: fixtureRun, projectIds: [], keyIds: ["missing-key"] })).rejects.toThrow("Credential fixture identity mismatch");
    await expect(backend.mutation(cleanupApplication, { runId: fixtureRun, projectIds: [], keyIds: ["other-key"] })).rejects.toThrow("Credential fixture identity mismatch");
    await expect(backend.mutation(cleanupApplication, { runId: otherRun, projectIds: [], keyIds: ["fixture-key"] })).rejects.toThrow("Credential fixture identity mismatch");
    await expect(backend.mutation(cleanupApplication, { runId: fixtureRun, projectIds: [bystanderId], keyIds: [] })).rejects.toThrow("Project fixture identity mismatch");
    await expect(backend.mutation(cleanupApplication, { runId: otherRun, projectIds: [projectId], keyIds: [] })).rejects.toThrow("Project fixture identity mismatch");
    await backend.run(ctx => ctx.db.delete(projectId));
    await expect(backend.mutation(cleanupApplication, { runId: fixtureRun, projectIds: [projectId], keyIds: [] })).rejects.toThrow("Project fixture identity mismatch");
    // Failed attempts roll back: nothing but the explicitly deleted project changed.
    expect((await tableCounts(backend)).projects).toEqual(["bystander"]);
    expect({ ...(await tableCounts(backend)), projects: before.projects }).toEqual(before);
  });
});
