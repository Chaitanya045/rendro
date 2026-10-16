import rateLimiterTest from "./convex-rate-limiter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { components } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";

type Check = { name: string; expected: number; actual: number; passed: boolean };
type Result = { runId: string; checks: Check[]; passed: number; total: number; remaining: number; cleanupFailed: boolean; cleanupDeleted: number; executionError: string | null; phase: string };
const run = makeFunctionReference<"action", { confirmDeployment: "deafening-beagle-38" }, Result>("qaPermissionFixtures:run");
const confirm = "deafening-beagle-38" as const;

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** The dev site is the real Convex HTTP router, optionally rewriting what the fixture sees. */
type Tamper = (path: string, method: string, response: Response) => Response | Promise<Response | undefined> | undefined;
function devSite(tamper?: Tamper) {
  vi.stubEnv("SITE_URL", "https://dev.rendro.app");
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const requests: Array<{ method: string; path: string; cookie: boolean }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://dev.rendro.app");
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, cookie: new Headers(init?.headers).has("cookie") });
    const response = await backend.fetch(`${url.pathname}${url.search}`, init);
    return (await tamper?.(url.pathname, method, response)) ?? response;
  }));
  const count = async (model: string) => ((await backend.query(components.betterAuth.adapter.findMany, { model: model as "user", paginationOpts: { cursor: null, numItems: 500 } })) as { page: unknown[] }).page.length;
  const leftovers = async () => ({
    users: await count("user"), organizations: await count("organization"), members: await count("member"), sessions: await count("session"),
    teams: await count("team"), teamMembers: await count("teamMember"), invitations: await count("invitation"),
    projects: (await backend.run(ctx => ctx.db.query("projects").collect())).length,
    credentials: (await backend.run(ctx => ctx.db.query("apiKeyCredentials").collect())).length,
    audits: (await backend.run(ctx => ctx.db.query("auditEvents").collect())).length,
  });
  return { backend, requests, leftovers };
}
const failed = (result: Result) => result.checks.filter(check => !check.passed).map(check => check.name);
const json = (body: unknown, response: Response, status = response.status) => new Response(JSON.stringify(body), { status, headers: response.headers });
const withoutHeader = (response: Response, header: string) => {
  const headers = new Headers(response.headers);
  headers.delete(header);
  return new Response(response.body, { status: response.status, headers });
};

describe("QA permission fixtures against the production HTTP router", () => {
  it("proves the full role matrix, then leaves no fixture data behind", async () => {
    const site = devSite();
    const result = await site.backend.action(run, { confirmDeployment: confirm });
    expect(result).toMatchObject({ executionError: null, cleanupFailed: false, remaining: 0, phase: "http-permission-matrix" });
    expect(failed(result)).toEqual([]);
    expect(result.passed).toBe(result.total);
    expect(result.total).toBe(105);
    const expectations = Object.fromEntries(result.checks.map(check => [check.name, check.expected]));
    expect(expectations).toMatchObject({
      "management:access:owner": 200, "management:access:admin": 200, "management:access:member": 200,
      "management:access:outsider": 403, "management:access:anonymous": 401,
      "projects:create:owner": 201, "projects:create:admin": 201, "projects:create:member": 403,
      "credentials:list:member": 403, "credentials:create:admin": 201, "credentials:create:member": 403,
      "teams:roster:admin": 200, "teams:roster:member": 403, "teams:add:member-denied": 403,
      "role:self-escalation": 403, "role:downgraded-admin-loses-write": 403, "role:promoted-member-gains-write": 201,
      "role:removed-member-loses-read": 403, "foreign-project:lookup-denied": 404,
      "invitations:accepted-member-cannot-write": 403, "session:expired-cached-denied": 403,
      "session:revoked-cached-native-organization-denied": 401,
    });
    expect(result.cleanupDeleted).toBe(12);
    expect(result.runId).toMatch(/^[a-f0-9]{16}$/);
    // Every request that carried a role came from a real signed cookie; anonymous ones had none.
    expect(site.requests.filter(request => !request.cookie).length).toBeGreaterThan(0);
    expect(await site.leftovers()).toEqual({ users: 0, organizations: 0, members: 0, sessions: 0, teams: 0, teamMembers: 0, invitations: 0, projects: 0, credentials: 0, audits: 0 });
  }, 120_000);

  it("reports exactly the checks that a forged or weakened site would fail", async () => {
    const site = devSite(async (path, method, response) => {
      if (path === "/api/auth/organization/get-full-organization" && response.ok) return withoutHeader(json({}, response), "cache-control");
      if (path === "/api/rendro/management/access" && response.ok) return withoutHeader(json({ ...(await response.clone().json() as object), members: [] }, response), "cache-control");
      if (path === "/api/rendro/management/members") return json({ members: [], nextCursor: "more" }, response);
      if (path === "/api/rendro/management/team-members" && response.ok) return withoutHeader(json({}, response), "cache-control");
      if (path === "/api/rendro/projects" && method === "POST" && response.status === 201) {
        // The outsider's project in a foreign organization is acknowledged without its identifier.
        const created = await response.clone().json() as { project?: { slug?: string } };
        return created.project?.slug?.startsWith("foreign-") ? json({}, response) : undefined;
      }
      if (path === "/api/auth/organization/update-team") {
        // Acknowledged, but the rename is lost afterwards.
        await site.backend.mutation(components.betterAuth.adapter.updateMany, { input: { model: "team", update: { name: "reverted" } } as never, paginationOpts: { cursor: null, numItems: 100 } });
        return undefined;
      }
      if (path === "/api/auth/organization/remove-member" && method === "POST") return json({ forged: true }, response, 200);
      return undefined;
    });
    const result = await site.backend.action(run, { confirmDeployment: confirm });
    expect(result).toMatchObject({ executionError: null, cleanupFailed: false, remaining: 0 });
    const names = failed(result);
    expect(names).toEqual([
      "management:access:owner:minimal", "management:access:admin:minimal", "management:access:member:minimal",
      "members:cursor:owner:complete", "members:cursor:admin:complete", "members:cursor:member:complete",
      "organizations:rename-persisted", "organizations:creator-is-owner",
      "organizations:last-owner-removal-denied", "teams:rename-persisted", "teams:roster:added-member-visible", "teams:roster:no-store",
    ]);
    // With no foreign project ID the lookup is made with a placeholder and is still denied.
    expect(result.checks.find(check => check.name === "foreign-project:lookup-denied")).toMatchObject({ expected: 404, actual: 404, passed: true });
    expect(result.passed).toBe(result.total - names.length);
    for (const check of result.checks.filter(c => !c.passed)) expect(check.actual).not.toBe(check.expected);
    // Unrelated role checks are unaffected by tampering with response bodies.
    expect(result.checks.find(check => check.name === "projects:create:member")).toMatchObject({ expected: 403, actual: 403, passed: true });
  }, 120_000);

  it("aborts safely, with only the error name, when creation responses cannot be parsed", async () => {
    const site = devSite((path, method, response) => {
      const creates = method === "POST" && (path === "/api/rendro/projects" || path === "/api/rendro/credentials" || path === "/api/auth/organization/create-team");
      return creates ? new Response("not json", { status: response.status }) : undefined;
    });
    const result = await site.backend.action(run, { confirmDeployment: confirm });
    // Without a captured team ID the fixture stops before the invitation and session phases.
    expect(result).toMatchObject({ executionError: "Error", phase: "http-permission-matrix", cleanupFailed: false });
    expect(JSON.stringify(result)).not.toContain("Fixture team unavailable");
    expect(result.checks.some(check => check.name === "teams:rename")).toBe(false);
    expect(result.checks.some(check => check.name === "teams:create:owner" && check.passed)).toBe(true);
    const state = await site.leftovers();
    // Projects, credentials and organizations whose responses were unreadable are not tracked by ID.
    expect(state).toMatchObject({ users: 0, sessions: 0 });
  }, 120_000);

  it("aborts when organization creation returns no identifier", async () => {
    const site = devSite((path, _method, response) => path === "/api/auth/organization/create" ? json({}, response) : undefined);
    const result = await site.backend.action(run, { confirmDeployment: confirm });
    expect(result).toMatchObject({ executionError: "Error", cleanupFailed: false });
    expect(result.checks.at(-1)).toMatchObject({ name: "organizations:create", expected: 200, actual: 200, passed: true });
    // The organization the router created is unknown to the fixture (it never saw its ID), so only
    // the identities it did seed are asserted gone here.
    expect(await site.leftovers()).toMatchObject({ users: 0, sessions: 0, projects: 0 });
  }, 120_000);

  it("stops at the first session whose identity does not match the seeded user", async () => {
    let tampered = false;
    const site = devSite((path, _method, response) => {
      if (path !== "/api/auth/get-session" || tampered) return undefined;
      tampered = true;
      return json(null, response);
    });
    const result = await site.backend.action(run, { confirmDeployment: confirm });
    expect(result).toMatchObject({ executionError: "Error", phase: "authenticate-owner", remaining: 0, cleanupFailed: false });
    expect(result.checks).toEqual([
      { name: "get-session:owner", expected: 200, actual: 200, passed: true },
      { name: "get-session:owner:identity", expected: 1, actual: 0, passed: false },
    ]);
    expect(await site.leftovers()).toMatchObject({ users: 0, organizations: 0, sessions: 0 });
  }, 120_000);
});
