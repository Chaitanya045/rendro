import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import rateLimiterTest from "./convex-rate-limiter";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { sha256 } from "../convex/credentialHash";
vi.mock("../convex/authorization", () => ({ authorizeHttpOrganization: (_ctx: unknown, headers: Headers) => {
  if (headers.get("cookie") !== "session=valid") throw new ConvexError("Authentication required");
  return Promise.resolve({ user: { _id: "user" } });
} }));
const modules = import.meta.glob("../convex/**/*.ts");
const provenance = { source: { kind: "local" as const }, execution: { kind: "local" as const }, cliVersion: "test", manifestSha256: "sha" };
async function fixture() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const project = await t.mutation(internal.projects.createInternal, { organizationId: "org", name: "Docs", slug: "docs", actorId: "user" });
  await t.mutation(internal.apiKeyCredentials.createInternal, { organizationId: "org", keyId: "key", keyPrefix: "key", name: "test", secretHash: await sha256("key"), scopes: ["docs:read", "docs:write"], actorId: "user" });
  const start = { organizationId: "org", projectId: project!._id, manifestSha256: "sha", fileCount: 1, byteCount: 1, provenance };
  const staged = await t.mutation(internal.deployments.startInternal, { ...start, actorId: "user" });
  const identity = { organizationId: "org", projectId: project!._id, deploymentId: staged.deploymentId };
  const post = (path: string, body: unknown, key = "key") => t.fetch(`/api/rendro/deployments/${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const get = (path: string, fields: Record<string, string>, headers = { authorization: "Bearer key" } as Record<string, string>) => t.fetch(`/api/rendro/deployments${path}?${new URLSearchParams(fields)}`, { headers });
  return { t, projectId: project!._id, start, identity, post, get };
}

describe("Convex deployment HTTP boundaries", () => {
  it("rejects malformed start/commit/fail bodies and every missing field", async () => {
    const f = await fixture();
    const valid = { start: f.start, commit: f.identity, fail: { ...f.identity, reason: "cancelled" } };
    for (const path of ["start", "commit", "fail"] as const) {
      expect((await f.t.fetch(`/api/rendro/deployments/${path}`, { method: "POST", headers: { authorization: "Bearer key" }, body: "{" })).status).toBe(400);
      for (const body of [null, "text", {}]) expect((await f.post(path, body)).status).toBe(400);
      for (const key of Object.keys(valid[path])) {
        expect((await f.post(path, { ...valid[path], [key]: undefined })).status).toBe(400);
      }
      expect((await f.post(path, valid[path], "wrong")).status).toBe(401);
    }
    expect((await f.post("start", { ...f.start, provenance: 1 })).status).toBe(400);
    expect((await f.post("start", { ...f.start, fileCount: -1 })).status).toBe(400);
    expect((await f.post("start", { ...f.start, byteCount: -1 })).status).toBe(400);
    expect((await f.post("start", f.start)).status).toBe(201);
    expect((await f.post("fail", { ...f.identity, reason: "cancelled" })).status).toBe(200);
    expect((await f.post("commit", f.identity)).status).toBe(409);
  });

  it("renews staging through HTTP, denies failed leases, commits successfully, and returns the active deployment", async () => {
    const f = await fixture();
    expect((await f.get("/staging", f.identity)).status).toBe(200);
    expect((await f.post("commit", f.identity)).status).toBe(200);
    expect((await f.get("/staging", f.identity)).status).toBe(404);
    expect(await (await f.get("/active", f.identity)).json()).toMatchObject({ deployment: { _id: f.identity.deploymentId }, principal: { kind: "api-key" } });
    expect(await (await f.get("/active", f.identity, { cookie: "session=valid" })).json()).toMatchObject({ principal: { kind: "session", userId: "user" } });
    expect((await f.get("", f.identity)).status).toBe(200);
    expect((await f.get("", f.identity, { cookie: "session=valid" })).status).toBe(200);
  });

  it("returns an actionable conflict for an expired lease without reviving it", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.identity.deploymentId, { stagingExpiresAt: Date.now() - 1 }));
    const response = await f.get("/staging", f.identity);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "Staging lease expired. Run rendro push again to start a new deployment." });
  });

  it("rejects incomplete read identities, absent projects, and unauthorized sessions", async () => {
    const f = await fixture();
    for (const path of ["/staging", "/active", ""]) {
      for (const field of path === "/staging" ? ["organizationId", "projectId", "deploymentId"] : ["organizationId", "projectId"]) {
        const fields: Record<string, string> = { ...f.identity }; delete fields[field];
        expect((await f.get(path, fields)).status).toBe(400);
      }
    }
    expect((await f.get("/staging", f.identity, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await f.get("/active", f.identity, {})).status).toBe(403);
    expect((await f.get("", f.identity, {})).status).toBe(403);
    await f.t.run(ctx => ctx.db.delete(f.projectId));
    expect((await f.get("/active", f.identity)).status).toBe(404);
    expect((await f.get("", f.identity)).status).toBe(404);
  });

  it("enforces deployment scope and state independently of HTTP authorization", async () => {
    const f = await fixture();
    const other = await f.t.mutation(internal.projects.createInternal, { organizationId: "org", name: "Other", slug: "other", actorId: "user" });
    const get = (patch: Partial<typeof f.identity>) => f.t.query(internal.deployments.getInternal, { ...f.identity, ...patch });
    expect(await get({ organizationId: "other" })).toBeNull();
    expect(await get({ projectId: other!._id })).toBeNull();
    await expect(f.t.mutation(internal.deployments.commitInternal, { ...f.identity, organizationId: "other", actorId: "user" })).rejects.toThrow("Project not found");
    await expect(f.t.mutation(internal.deployments.commitInternal, { ...f.identity, projectId: other!._id, actorId: "user" })).rejects.toThrow("Deployment not found");
    await f.t.run(ctx => ctx.db.patch(f.identity.deploymentId, { organizationId: "other" }));
    await expect(f.t.mutation(internal.deployments.commitInternal, { ...f.identity, actorId: "user" })).rejects.toThrow("Deployment not found");
    await f.t.run(ctx => ctx.db.delete(f.identity.deploymentId));
    expect(await get({})).toBeNull();
    await expect(f.t.mutation(internal.deployments.commitInternal, { ...f.identity, actorId: "user" })).rejects.toThrow("Deployment not found");
    await f.t.run(ctx => ctx.db.delete(f.projectId));
    await expect(f.t.mutation(internal.deployments.commitInternal, { ...f.identity, actorId: "user" })).rejects.toThrow("Project not found");
  });

  it.each([false, true])("handles a stale predecessor pointer (missing=%s) without mutating it", async missing => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.projectId, { activeDeploymentId: f.identity.deploymentId }));
    const next = await f.t.mutation(internal.deployments.startInternal, { ...f.start, actorId: "user" });
    if (missing) await f.t.run(ctx => ctx.db.delete(f.identity.deploymentId));
    await f.t.mutation(internal.deployments.commitInternal, { ...f.identity, deploymentId: next.deploymentId, actorId: "user" });
    expect((await f.t.run(ctx => ctx.db.get(next.deploymentId)))?.status).toBe("active");
  });

  it("does not return latest deployment summaries for foreign or deleted projects", async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      await ctx.db.patch(f.identity.deploymentId, { activatedAt: 1 });
      await ctx.db.patch(f.projectId, { organizationId: "other" });
    });
    expect(await f.t.query(internal.deployments.latestForOrganization, { organizationId: "org" })).toBeNull();
    await f.t.run(ctx => ctx.db.delete(f.projectId));
    expect(await f.t.query(internal.deployments.latestForOrganization, { organizationId: "org" })).toBeNull();
  });
});
