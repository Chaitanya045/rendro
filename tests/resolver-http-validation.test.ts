import { afterEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("../convex/authorization", () => ({ authorizeHttpOrganization: auth.authorize }));
import { createPublication, removePublication, listPublications } from "../convex/publicationHttp";
import { createShareGrant, revokeShareGrant, listShareGrants } from "../convex/shareGrantHttp";

const publication = { organizationId: "org", projectId: "project", slug: "docs", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" };
const share = { assetPaths: [], organizationId: "org", projectId: "project", documentPath: "index.html", expiresInSeconds: 60 };
type Action = typeof createPublication;
async function invoke(action: Action, body?: unknown, query = "", rawBody?: string, mutationResult: unknown = { slug: "docs" }) {
  const ctx = { runQuery: vi.fn().mockResolvedValue([]), runMutation: vi.fn().mockResolvedValue(mutationResult) };
  const handler = (action as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler;
  const response = await handler(ctx, new Request(`https://backend.test/test${query}`, body === undefined ? {} : {
    method: "POST", headers: { origin: process.env.SITE_URL!, "content-type": "application/json" }, body: rawBody ?? JSON.stringify(body),
  }));
  return { response, ctx };
}
afterEach(() => vi.resetAllMocks());

describe("resolver management input boundaries", () => {
  it.each([createPublication, removePublication, createShareGrant, revokeShareGrant, listShareGrants])("rejects non-object and missing required fields", async action => {
    for (const input of [null, "invalid", {}, []]) {
      const { response, ctx } = await invoke(action, input);
      expect(response.status).toBe(400);
      expect(ctx.runMutation).not.toHaveBeenCalled();
      expect(auth.authorize).not.toHaveBeenCalled();
    }
  });
  it("rejects invalid optional publication fields and share lifetimes", async () => {
    for (const field of ["pinnedDeploymentId", "title", "description"]) {
      expect((await invoke(createPublication, { ...publication, [field]: 123 })).response.status).toBe(400);
    }
    for (const seconds of [59, 30 * 24 * 60 * 60 + 1, "60"]) {
      expect((await invoke(createShareGrant, { ...share, expiresInSeconds: seconds })).response.status).toBe(400);
    }
    expect(auth.authorize).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON and reports unavailable list operations", async () => {
    for (const action of [createPublication, removePublication, createShareGrant, revokeShareGrant]) expect((await invoke(action, {}, "", "{")).response.status).toBe(400);
    auth.authorize.mockRejectedValue(new Error("Backend unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await invoke(listShareGrants, undefined, "?organizationId=org&projectId=project")).response.status).toBe(500);
    vi.restoreAllMocks();
  });
  it("handles an absent creation result without manufacturing a public URL", async () => {
    auth.authorize.mockResolvedValue({ user: { _id: "owner" } });
    expect(await (await invoke(createPublication, publication, "", undefined, null)).response.json()).toEqual({ publication: null, url: null });
    expect((await invoke(listPublications, undefined, "?organizationId=org")).response.status).toBe(200);
  });
  it("requires organization identity for listing", async () => {
    expect((await invoke(listPublications)).response.status).toBe(400);
  });
  it("preserves successful create and revoke responses", async () => {
    auth.authorize.mockResolvedValue({ user: { _id: "owner" } });
    const created = await invoke(createPublication, publication);
    expect(created.response.status).toBe(201);
    expect(await created.response.json()).toEqual({ publication: { slug: "docs" }, url: "/p/docs" });
    const shareResponse = await invoke(createShareGrant, share);
    expect(shareResponse.response.status).toBe(201);
    expect(await shareResponse.response.json()).toMatchObject({ token: expect.any(String), url: expect.stringMatching(/^\/s\//) });
    expect(shareResponse.ctx.runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), actorId: "owner" }));
    expect(await (await invoke(listShareGrants, undefined, "?organizationId=org&projectId=project")).response.json()).toEqual({ shares: [] });
    expect((await invoke(revokeShareGrant, { organizationId: "org", grantId: "grant" })).response.status).toBe(200);
    expect((await invoke(removePublication, { organizationId: "org", projectId: "project", publicationId: "publication" })).response.status).toBe(200);
  });
});
