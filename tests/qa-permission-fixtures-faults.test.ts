import rateLimiterTest from "./convex-rate-limiter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as BetterAuthMinimal from "better-auth/minimal";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { components } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";

type Result = { runId: string; checks: Array<{ name: string; expected: number; actual: number; passed: boolean }>; passed: number; total: number; remaining: number; cleanupFailed: boolean; cleanupDeleted: number; executionError: string | null; phase: string };
type Fault = {
  /** Fixture-only: the instance built with the test-utils plugin. */
  noTestHelpers?: boolean;
  loginWithoutCookie?: boolean;
  legacyResponse?: (real: Response) => Response;
  failing?: Set<string>;
};
const fault = vi.hoisted((): { current: Fault; cleaning: boolean } => ({ current: {}, cleaning: false }));

type TestHelpers = {
  login(input: { userId: string }): Promise<{ session: { token: string }; headers: Headers }>;
  deleteOrganization(id: string): Promise<void>;
};
type Adapter = { findMany(input: { model: string }): Promise<unknown[]>; deleteMany(input: { model: string }): Promise<unknown>; delete(input: { model: string }): Promise<void> };
type InternalAdapter = { deleteUserSessions(id: string): Promise<void>; deleteAccounts(id: string): Promise<void>; deleteUser(id: string): Promise<void> };

vi.mock("better-auth/minimal", async importOriginal => {
  const original = await importOriginal<typeof BetterAuthMinimal>();
  return {
    ...original,
    betterAuth: ((options: Parameters<typeof original.betterAuth>[0]) => {
      const auth = original.betterAuth(options);
      // Only the QA fixture installs the test-utils plugin; the HTTP router's instance is untouched.
      if (!options.plugins?.some(plugin => plugin.id === "test-utils")) return auth;
      const spent = new Set<string>();
      // findTeams fails only for the cleanup lookup; the verification reads that follow must still work.
      const rejection = (name: string): Promise<never> | undefined => {
        if (!fault.cleaning || !fault.current.failing?.has(name) || (name === "findTeams" && spent.has(name))) return undefined;
        spent.add(name);
        return Promise.reject(new Error(`injected ${name} failure`));
      };
      const context = auth.$context.then(real => {
        const adapter = real.adapter as unknown as Adapter;
        const internal = real.internalAdapter as unknown as InternalAdapter;
        const helpers = (real as unknown as { test?: TestHelpers }).test;
        return {
          ...real,
          test: fault.current.noTestHelpers || !helpers ? undefined : {
            ...helpers,
            login: fault.current.loginWithoutCookie
              ? async (input: { userId: string }) => ({ ...(await helpers.login(input)), headers: new Headers() })
              : (input: { userId: string }) => helpers.login(input),
            deleteOrganization: (id: string) => rejection("deleteOrganization") ?? helpers.deleteOrganization(id),
          },
          adapter: {
            ...real.adapter,
            findMany: (input: { model: string }) => (input.model === "team" ? rejection("findTeams") : undefined) ?? adapter.findMany(input),
            deleteMany: (input: { model: string }) => (input.model === "teamMember" ? rejection("deleteTeamMembers") : undefined) ?? adapter.deleteMany(input),
            delete: (input: { model: string }) => (input.model === "team" ? rejection("deleteTeam") : undefined) ?? adapter.delete(input),
          },
          internalAdapter: {
            ...real.internalAdapter,
            deleteUserSessions: (id: string) => {
              // The first call marks the start of the fixture's cleanup phase.
              fault.cleaning = true;
              return rejection("deleteUserSessions") ?? internal.deleteUserSessions(id);
            },
            deleteAccounts: (id: string) => rejection("deleteAccounts") ?? internal.deleteAccounts(id),
            deleteUser: (id: string) => rejection("deleteUser") ?? internal.deleteUser(id),
          },
        };
      });
      const api = Object.create(auth.api) as typeof auth.api;
      Object.assign(api, { getSession: async (input: Parameters<typeof auth.api.getSession>[0]) => {
        const response: unknown = await auth.api.getSession(input);
        return fault.current.legacyResponse && response instanceof Response ? fault.current.legacyResponse(response) : response;
      } });
      return Object.assign(Object.create(auth) as typeof auth, { $context: context, api });
    }) as typeof original.betterAuth,
  };
});

const run = makeFunctionReference<"action", { confirmDeployment: "deafening-beagle-38" }, Result>("qaPermissionFixtures:run");
const confirm = "deafening-beagle-38" as const;
beforeEach(() => { fault.current = {}; fault.cleaning = false; });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function devSite(tamper?: (path: string, method: string, response: Response) => Response | undefined) {
  vi.stubEnv("SITE_URL", "https://dev.rendro.app");
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const response = await backend.fetch(`${url.pathname}${url.search}`, init);
    return tamper?.(url.pathname, init?.method ?? "GET", response) ?? response;
  });
  vi.stubGlobal("fetch", fetchMock);
  const count = async (model: string) => ((await backend.query(components.betterAuth.adapter.findMany, { model: model as "user", paginationOpts: { cursor: null, numItems: 500 } })) as { page: unknown[] }).page.length;
  return { backend, fetchMock, count };
}
const failed = (result: Result) => result.checks.filter(check => !check.passed).map(check => check.name);
const sessionCheck = (result: Result, role: string) => result.checks.find(check => check.name === `get-session:${role}:legacy-cache-prepared`);

describe("QA permission fixture failure handling", () => {
  it("refuses to run, without any HTTP traffic, when Better Auth test helpers are unavailable", async () => {
    fault.current = { noTestHelpers: true };
    const site = devSite();
    await expect(site.backend.action(run, { confirmDeployment: confirm })).rejects.toThrow("Better Auth test fixture helpers unavailable");
    expect(site.fetchMock).not.toHaveBeenCalled();
    expect(await site.count("user")).toBe(0);
    expect(await site.count("organization")).toBe(0);
  });

  it("does not send a cookie when the login helper yields none, so the first session is rejected", async () => {
    fault.current = { loginWithoutCookie: true };
    const site = devSite();
    const result = await site.backend.action(run, { confirmDeployment: confirm });
    expect(result).toMatchObject({ executionError: "Error", phase: "authenticate-owner", remaining: 0, cleanupFailed: false });
    expect(failed(result)).toEqual(["get-session:owner:identity"]);
    expect(site.fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(site.fetchMock.mock.calls[0]![1]?.headers).has("cookie")).toBe(false);
    expect(await site.count("user")).toBe(0);
  }, 120_000);

  it("reports a generic error name when something other than an Error is thrown", async () => {
    const site = devSite();
    site.fetchMock.mockRejectedValueOnce("secret-bearing string failure");
    const result = await site.backend.action(run, { confirmDeployment: confirm });
    expect(result).toMatchObject({ executionError: "UnknownError", phase: "authenticate-owner", cleanupFailed: false, remaining: 0 });
    expect(JSON.stringify(result)).not.toContain("secret-bearing");
    expect(await site.count("user")).toBe(0);
  }, 120_000);

  describe("legacy cache cookie preparation", () => {
    const legacy = (make: (real: Response) => Response) => async () => {
      fault.current = { legacyResponse: make };
      const site = devSite();
      return site.backend.action(run, { confirmDeployment: confirm });
    };
    const noGetSetCookie = (cookie: string | null) => (real: Response) => {
      const headers = new Headers(real.headers);
      headers.delete("set-cookie");
      if (cookie) headers.set("set-cookie", cookie);
      Object.defineProperty(headers, "getSetCookie", { value: undefined });
      // Only the headers are consumed; Response.headers itself is read-only.
      return { headers } as unknown as Response;
    };

    it("falls back to the combined Set-Cookie header when getSetCookie is unavailable", async () => {
      const result = await legacy(noGetSetCookie("better-auth.session_data=signed.value; Path=/; HttpOnly"))();
      expect(result.executionError).toBeNull();
      expect(sessionCheck(result, "owner")).toMatchObject({ passed: true, actual: 1 });
    }, 120_000);

    it("records a failed preparation when no cookie can be captured, from either API", async () => {
      for (const make of [noGetSetCookie(null), (real: Response) => { const headers = new Headers(real.headers); headers.delete("set-cookie"); return new Response(real.body, { status: real.status, headers }); }]) {
        const result = await legacy(make)();
        for (const role of ["owner", "admin", "member", "outsider"]) expect(sessionCheck(result, role)).toMatchObject({ passed: false, actual: 0 });
        expect(result.cleanupFailed).toBe(false);
        expect(result.remaining).toBe(0);
      }
    }, 120_000);
  });

  it("flags cleanup failures and counts what is left, without hiding the matrix result", async () => {
    // Responses with unusable IDs make both application-data cleanup and its verification fail.
    fault.current = { failing: new Set(["deleteUserSessions", "findTeams", "deleteOrganization", "deleteAccounts", "deleteUser"]) };
    const site = devSite((path, method, response) => path === "/api/rendro/projects" && method === "POST" && response.status === 201
      ? new Response(JSON.stringify({ project: { _id: "not-an-id" } }), { status: 201, headers: response.headers }) : undefined);
    const result = await site.backend.action(run, { confirmDeployment: confirm });
    expect(result).toMatchObject({ executionError: null, cleanupFailed: true, cleanupDeleted: 0 });
    expect(result.passed).toBe(result.total);
    // 4 users + 3 organizations remain; the unverifiable application count is reported as -1.
    expect(result.remaining).toBeGreaterThan(0);
    expect(await site.count("user")).toBe(4);
    expect(await site.count("organization")).toBe(3);
    expect(result.remaining).toBe(-1 + (await site.count("user")) + (await site.count("organization")) + (await site.count("member")) + (await site.count("team")) + (await site.count("invitation")) + (await site.count("teamMember")) + (await site.count("session")) + (await site.count("account")));
  }, 120_000);

  it("flags team and membership cleanup failures but still removes everything else", async () => {
    fault.current = { failing: new Set(["deleteTeamMembers", "deleteTeam"]) };
    const site = devSite();
    const result = await site.backend.action(run, { confirmDeployment: confirm });
    expect(result).toMatchObject({ executionError: null, cleanupFailed: true });
    expect(await site.count("user")).toBe(0);
    expect(await site.count("organization")).toBe(0);
    // Whatever team rows and rosters survived are exactly what verification reports.
    const survivors = (await site.count("team")) + (await site.count("teamMember"));
    expect(survivors).toBeGreaterThan(0);
    expect(result.remaining).toBe(survivors);
  }, 120_000);
});
