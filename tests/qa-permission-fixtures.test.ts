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
  });

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
