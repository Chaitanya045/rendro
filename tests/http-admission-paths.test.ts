import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
const auth = vi.hoisted(() => ({ authorize: vi.fn(), users: vi.fn() }));
vi.mock("../convex/authorization", () => ({ authorizeHttpOrganization: auth.authorize, httpOrganizationAccess: auth.authorize }));
vi.mock("../convex/auth", () => ({ createAuth: () => ({ $context: Promise.resolve({ adapter: { findMany: auth.users } }) }) }));
import * as credentials from "../convex/credentialHttp";
import * as shares from "../convex/shareGrantHttp";
import * as publications from "../convex/publicationHttp";
import * as projects from "../convex/rendroHttp";
import * as retention from "../convex/retentionHttp";
import { ensureMigrationProject } from "../convex/migrationHttp";
import { failure } from "../convex/httpErrors";

type Action = typeof credentials.createCredential;
const ctx = { runQuery: vi.fn(), runMutation: vi.fn() };
async function invoke(action: Action, body: unknown = {}, query = "", extraHeaders: Record<string, string> = {}) {
  const handler = (action as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler;
  return handler(ctx, new Request(`https://backend.test/action${query}`, {
    method: "POST", headers: { origin: process.env.SITE_URL!, "content-type": "application/json", ...extraHeaders },
    body: body === "invalid-json" ? "{" : JSON.stringify(body),
  }));
}
beforeEach(() => {
  auth.authorize.mockResolvedValue({ user: { _id: "owner" } });
  auth.users.mockResolvedValue([]);
  ctx.runQuery.mockResolvedValue({ _id: "project" });
  ctx.runMutation.mockImplementation((reference: FunctionReference<"mutation">) => Promise.resolve(
    getFunctionName(reference) === "anonymousAdmission:consume" ? { ok: true } : { _id: "created", slug: "docs" },
  ));
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

const writes = [credentials.createCredential, credentials.revokeCredential, shares.createShareGrant, shares.revokeShareGrant, publications.createPublication, publications.removePublication, projects.createProject];
it.each(writes)("rejects malformed and incomplete JSON before authorizing a cookie write (%#)", async action => {
  for (const body of ["invalid-json", null, "string", {}, []]) {
    expect((await invoke(action, body)).status).toBe(400);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  }
});
it("validates credential fields and optional expiry before authorization", async () => {
  const valid = { organizationId: "org", name: "Key", scopes: ["docs:read"] };
  for (const patch of [{ scopes: "docs:read" }, { scopes: [4] }, { scopes: ["unknown"] }, { scopes: [] }, { name: "" }, { name: "a".repeat(81) }, { projectId: 4 }, { expiresAt: "future" }, { expiresAt: 0 }]) {
    expect((await invoke(credentials.createCredential, { ...valid, ...patch })).status).toBe(400);
  }
  expect((await invoke(credentials.createCredential, { ...valid, projectId: "project", expiresAt: Date.now() + 60_000 })).status).toBe(201);
  ctx.runQuery.mockResolvedValue(null);
  expect((await invoke(credentials.createCredential, { ...valid, projectId: "missing" })).status).toBe(404);
});
it("validates publication optional fields and preserves null results", async () => {
  const valid = { organizationId: "org", projectId: "project", slug: "docs", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" };
  for (const patch of [{ pinnedDeploymentId: 1 }, { title: 1 }, { description: 1 }]) {
    expect((await invoke(publications.createPublication, { ...valid, ...patch })).status).toBe(400);
  }
  ctx.runMutation.mockResolvedValue(null);
  expect(await (await invoke(publications.createPublication, valid)).json()).toEqual({ publication: null, url: null });
});
it("validates share expiry bounds before authorization", async () => {
  for (const expiresInSeconds of ["600", 59, 30 * 86400 + 1]) {
    expect((await invoke(shares.createShareGrant, { organizationId: "org", projectId: "project", documentPath: "index.html", expiresInSeconds })).status).toBe(400);
  }
  expect(auth.authorize).not.toHaveBeenCalled();
});
it("rejects missing identities on read routes", async () => {
  for (const action of [credentials.listCredentials, publications.listPublications, projects.listProjects, projects.managementAccess, projects.managementRecentDeployment, projects.managementMembers, shares.resolveShareGrant, publications.resolvePublicPublication]) {
    expect((await invoke(action)).status).toBe(400);
  }
});
it("handles public capability presence and absence without session authority", async () => {
  const share = { grant: { documentPath: "index.html", expiresAt: 123 }, project: { name: "Docs" } };
  const publication = { publication: { slug: "docs", entryFile: "index.html", title: "Docs" } };
  for (const [action, query, result] of [[shares.resolveShareGrant, "?token=token", share], [publications.resolvePublicPublication, "?slug=docs", publication]] as const) {
    ctx.runQuery.mockResolvedValue(null);
    expect((await invoke(action, {}, query)).status).toBe(404);
    ctx.runQuery.mockResolvedValue({ ...result, deployment: { manifestKey: "private/manifest.json" } });
    expect(await (await invoke(action, {}, query)).json()).toEqual(result);
  }
  expect(auth.authorize).not.toHaveBeenCalled();
});
it("completes paginated member rows and handles deleted users without changing authority", async () => {
  for (const isDone of [true, false]) {
    ctx.runQuery.mockResolvedValue({ page: [{ _id: "member", userId: "one", role: "member", createdAt: 1 }, { _id: "gone", userId: "gone", role: "member", createdAt: 1 }], isDone, continueCursor: "next" });
    auth.users.mockResolvedValue([{ id: "one", name: "One", email: "one@example.test" }]);
    const response = await invoke(projects.managementMembers, {}, "?organizationId=org&cursor=previous");
    expect(await response.json()).toMatchObject({ members: [{ user: { id: "one" } }, { user: null }], nextCursor: isDone ? null : "next" });
  }
  ctx.runQuery.mockResolvedValue({ page: [], isDone: true });
  expect(await (await invoke(projects.managementMembers, {}, "?organizationId=org")).json()).toEqual({ members: [], nextCursor: null });
  auth.authorize.mockRejectedValue(new ConvexError("Authentication required"));
  expect((await invoke(projects.managementMembers, {}, "?organizationId=org")).status).toBe(403);
});
it("keeps operator-secret routes independent of browser-cookie admission", async () => {
  vi.stubEnv("RETENTION_SECRET", "operator");
  vi.stubEnv("MIGRATION_SECRET", "operator");
  const bearer = { authorization: "Bearer operator", origin: "null" };
  expect((await invoke(retention.listRetentionCandidates)).status).toBe(401);
  expect((await invoke(retention.listRetentionCandidates, {}, "", bearer)).status).toBe(200);
  for (const body of ["invalid-json", null, {}, { deploymentId: "deployment" }]) {
    expect((await invoke(retention.markRetentionPurged, body, "", bearer)).status).toBe(400);
  }
  expect((await invoke(retention.markRetentionPurged, { deploymentId: "deployment", objectCount: 0, purgeToken: "claim" }, "", bearer)).status).toBe(200);
  for (const body of ["invalid-json", null, {}, { organizationId: "org" }, { organizationId: "org", projectId: 1 }]) {
    expect((await invoke(ensureMigrationProject, body, "", bearer)).status).toBe(400);
  }
  ctx.runQuery.mockResolvedValue({ _id: "empty" });
  expect((await invoke(ensureMigrationProject, { organizationId: "org", projectId: "empty" }, "", bearer)).status).toBe(200);
  ctx.runQuery.mockResolvedValueOnce({ _id: "project", activeDeploymentId: "active" }).mockResolvedValueOnce(null);
  expect((await invoke(ensureMigrationProject, { organizationId: "org", projectId: "project" }, "", bearer)).status).toBe(409);
  ctx.runQuery.mockResolvedValueOnce([{ _id: "existing", slug: "docs", activeDeploymentId: "active" }]).mockResolvedValueOnce(null);
  expect((await invoke(ensureMigrationProject, { organizationId: "org", name: "Docs", slug: "docs" }, "", bearer)).status).toBe(409);
});
it("does not promote a classified application failure to an infrastructure response", () => {
  expect(failure(new ConvexError("Controlled failure"), 500).status).toBe(400);
});
