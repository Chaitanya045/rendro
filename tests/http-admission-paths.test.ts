import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
const auth = vi.hoisted(() => ({ authorize: vi.fn(), users: vi.fn() }));
vi.mock("../convex/authorization", () => ({ authorizeHttpOrganization: auth.authorize, httpOrganizationAccess: auth.authorize }));
vi.mock("../convex/auth", () => ({ createAuth: () => ({ $context: Promise.resolve({ adapter: { findMany: auth.users } }) }) }));
import * as credentials from "../convex/credentialHttp";
import * as projects from "../convex/rendroHttp";
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
  ctx.runMutation.mockResolvedValue({ _id: "created", slug: "docs" });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

const writes = [credentials.createCredential, credentials.revokeCredential, projects.createProject];
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
it("rejects missing identities on read routes", async () => {
  for (const action of [credentials.listCredentials, projects.listProjects, projects.managementAccess, projects.managementMembers]) {
    expect((await invoke(action)).status).toBe(400);
  }
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
it("does not promote a classified application failure to an infrastructure response", () => {
  expect(failure(new ConvexError("Controlled failure"), 500).status).toBe(400);
});
