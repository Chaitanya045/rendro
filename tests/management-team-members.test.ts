import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), findOne: vi.fn(), findMany: vi.fn(), query: vi.fn() }));
vi.mock("../convex/authorization", () => ({ authorizeHttpOrganization: mocks.authorize, httpOrganizationAccess: vi.fn() }));
vi.mock("../convex/auth", () => ({ createAuth: () => ({ $context: Promise.resolve({ adapter: { findOne: mocks.findOne, findMany: mocks.findMany } }) }) }));
import { createProject, managementTeamMembers } from "../convex/rendroHttp";
const handler = (managementTeamMembers as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler;
const ctx = { runQuery: mocks.query };
const request = (extra = "") => new Request(`https://rendro.test/api/rendro/management/team-members?organizationId=org-a&teamId=team-a${extra}`);
beforeEach(() => { vi.resetAllMocks(); mocks.authorize.mockResolvedValue({}); mocks.query.mockResolvedValueOnce({ organizationId: "org-a" }).mockResolvedValue({ page: [], isDone: true, continueCursor: "" }); });
describe("management team roster", () => {
  it("keeps duplicate-project errors readable without backend stack traces", async () => {
    mocks.authorize.mockResolvedValue({ user: { _id: "user-a" } });
    const create = (createProject as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler;
    const response = await create({ runMutation: vi.fn().mockRejectedValue(Object.assign(new ConvexError("A project with this slug already exists"), { message: "Uncaught ConvexError: A project with this slug already exists\n    at handler (../convex/projects.ts:49:54)" })) }, new Request("https://rendro.test/api/rendro/projects", { method: "POST", headers: { origin: process.env.SITE_URL!, "content-type": "application/json" }, body: JSON.stringify({ organizationId: "org-a", name: "Docs", slug: "docs" }) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "A project with this slug already exists" });
  });
  it("authorizes organization managers before reading a team's roster", async () => {
    const response = await handler(ctx, request());
    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(ctx, expect.any(Headers), "org-a", ["owner", "admin"]);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("returns bounded pages without leaking membership metadata", async () => {
    mocks.query.mockResolvedValue({ page: Array.from({ length: 50 }, (_, i) => ({ _id: String(i), userId: `user-${i}`, secret: "never-return" })), isDone: false, continueCursor: "next-page" });
    const response = await handler(ctx, request("&cursor=prior-page"));
    const body = await response.json() as { members: unknown[]; nextCursor: string };
    expect(body.members).toHaveLength(50); expect(body.nextCursor).toBe("next-page");
    expect(JSON.stringify(body)).not.toContain("never-return");
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ paginationOpts: { numItems: 50, cursor: "prior-page" } }));
  });
  it("rejects cross-organization team IDs before reading members", async () => {
    mocks.query.mockReset().mockResolvedValue({ organizationId: "org-b" });
    expect((await handler(ctx, request())).status).toBe(404);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it("fails closed for unauthorized callers", async () => {
    mocks.authorize.mockRejectedValue(new ConvexError("Insufficient organization role"));
    expect((await handler(ctx, request())).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("fails closed when the cursor query fails", async () => {
    mocks.query.mockRejectedValue(new Error("Invalid cursor"));
    const response = await handler(ctx, request("&cursor=invalid"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Request failed" });
  });
});
