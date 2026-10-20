import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth/minimal";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components, internal } from "../convex/_generated/api";
import { createAuthOptions } from "../convex/auth";
import { beforeDeleteOrganization, deletionResourceLimit } from "../convex/organizationLifecycle";
import { sha256 } from "../convex/credentialHash";
import rateLimiterTest from "./convex-rate-limiter";

const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(transactionLimits: { documentsWritten: number } | boolean = true) {
  const t = convexTest({ schema, modules, transactionLimits });
  t.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  rateLimiterTest.register(t);
  const auth = betterAuth(createAuthOptions({ runQuery: t.query, runMutation: t.mutation } as never));
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({ name: "Owner", email: "owner@example.test", emailVerified: true });
  const session = await context.internalAdapter.createSession(user.id);
  const cookie = `better-auth.session_token=${encodeURIComponent(`${session.token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(session.token).digest("base64")}`)}`;
  const headers = { cookie, origin: "http://localhost:3000", "content-type": "application/json" };
  const post = (path: string, body: unknown) => t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const organization = (organizationId: string) => t.query(components.betterAuth.adapter.findOne, {
    model: "organization", where: [{ field: "_id", value: organizationId }],
  });
  async function seed(slug: string) {
    const response = await post("/api/auth/organization/create", { name: slug, slug });
    expect(response.status).toBe(200);
    const organizationId = (await response.json()).id as string;
    expect(await organization(organizationId)).toMatchObject({ _id: organizationId, slug });
    const actorId = user.id;
    const project = (await t.mutation(internal.projects.createInternal, { organizationId, name: "Docs", slug: "docs", actorId }))!;
    const scope = { organizationId, projectId: project._id };
    const keys = [];
    for (const projectId of [undefined, project._id]) {
      const keyId = `${slug}-${projectId ?? "org"}`, secret = `test-${keyId}`;
      const secretHash = await sha256(secret);
      const id = await t.mutation(internal.apiKeyCredentials.createInternal, {
        organizationId, projectId, keyId, keyPrefix: "test", name: "Test", secretHash, scopes: ["docs:read"], actorId,
      });
      keys.push({ id, keyId, secret, secretHash });
    }
    const oldKey = await t.mutation(internal.apiKeyCredentials.createInternal, {
      organizationId, keyId: `old-${slug}`, keyPrefix: "old", name: "Old", secretHash: `old-${slug}`, scopes: [], actorId,
    });
    await t.run(ctx => ctx.db.patch(oldKey, { revokedAt: 1 }));
    return { ...scope, actorId, oldKey, keys, slug };
  }
  return { t, auth, context, user, session, cookie, headers, post, seed, organization };
}

type Resources = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["seed"]>>;
async function access(f: Awaited<ReturnType<typeof fixture>>, r: Resources, allowed: boolean) {
  expect(r.keys).toHaveLength(2);
  const query = new URLSearchParams({ organizationId: r.organizationId, projectId: r.projectId });
  for (const key of r.keys) {
    const headers = { authorization: `Bearer ${key.secret}` };
    expect((await f.t.fetch(`/api/rendro/credentials/validate?${query}&scope=docs:read`, { headers })).status).toBe(allowed ? 200 : 401);
    expect(await f.t.query(internal.apiKeyCredentials.verifiedIdInternal, { secretHash: key.secretHash })).toEqual(allowed ? { id: key.id, expiresAt: undefined } : null);
  }
  for (const path of ["projects", "projects/get", "credentials", "management/access"]) {
    expect((await f.t.fetch(`/api/rendro/${path}?${query}`, { headers: f.headers })).status).toBe(allowed ? 200 : 403);
  }
}

describe("organization deletion lifecycle", () => {
  it("revokes all access through the real auth HTTP handler, is idempotent, and isolates other organizations", async () => {
    const f = await fixture(), r = await f.seed("deleted"), other = await f.seed("untouched");
    await access(f, r, true);
    const snapshot = () => f.t.run(async ctx => ({
      tombstones: await ctx.db.query("organizationTombstones").collect(),
      keys: await ctx.db.query("apiKeyCredentials").withIndex("by_organization", q => q.eq("organizationId", r.organizationId)).collect(),
      audit: await ctx.db.query("auditEvents").collect(),
    }));
    const initial = await snapshot();
    expect(initial.tombstones).toHaveLength(0);
    expect(initial.keys).toHaveLength(3);
    const response = await f.post("/api/auth/organization/delete", { organizationId: r.organizationId });
    expect(response.status).toBe(200);
    await access(f, r, false);
    await access(f, other, true);
    expect(await f.organization(r.organizationId)).toBeNull();
    expect(await f.organization(other.organizationId)).toMatchObject({ _id: other.organizationId });
    const before = await snapshot();
    expect(before.tombstones).toEqual([expect.objectContaining({ organizationId: r.organizationId, deletedBy: r.actorId })]);
    expect(before.keys.map(key => key._id)).toEqual(initial.keys.map(key => key._id));
    expect(before.audit.filter(event => event.action === "organization.deleted")).toEqual([
      expect.objectContaining({ organizationId: r.organizationId, resourceId: r.organizationId, actorId: r.actorId }),
    ]);
    expect(before.keys.every(key => key.revokedAt !== undefined)).toBe(true);
    expect(before.keys.find(key => key._id === r.oldKey)?.revokedAt).toBe(1);
    await f.t.mutation(internal.organizationLifecycle.deleteInternal, { organizationId: r.organizationId, actorId: r.actorId });
    expect(await snapshot()).toEqual(before);
    expect((await f.post("/api/auth/organization/delete", { organizationId: r.organizationId })).status).toBe(400);
  });

  it("denies surviving capabilities and preauthorized writes using only a tombstone", async () => {
    const f = await fixture(), r = await f.seed("partial");
    await access(f, r, true);
    await f.t.run(ctx => ctx.db.insert("organizationTombstones", { organizationId: r.organizationId, deletedAt: Date.now(), deletedBy: r.actorId }));
    await access(f, r, false);
    const scope = { organizationId: r.organizationId, projectId: r.projectId };
    await expect(f.t.mutation(internal.projects.createInternal, { organizationId: r.organizationId, name: "New", slug: "new", actorId: r.actorId })).rejects.toThrow("Organization membership required");
    await expect(f.t.mutation(internal.apiKeyCredentials.createInternal, { ...scope, keyId: "new", keyPrefix: "new", name: "New", secretHash: "new", scopes: [], actorId: r.actorId })).rejects.toThrow("Organization membership required");
    expect(await f.t.query(internal.projects.getInternal, scope)).toBeNull();
    expect(await f.t.run(ctx => ctx.db.get(r.keys[0].id))).toMatchObject({ _id: r.keys[0].id, secretHash: r.keys[0].secretHash });
    expect(await f.t.run(ctx => ctx.db.get(r.keys[0].id))).not.toHaveProperty("revokedAt");
  });

  it("refuses deletion before writes when atomic resource limits are exceeded", async () => {
    const f = await fixture(), r = await f.seed("large");
    const extraKey = (i: number) => ({ organizationId: r.organizationId, keyId: `extra-${i}`, keyPrefix: "extra", name: "Extra", secretHash: `extra-${i}`, scopes: [], createdAt: i, createdBy: r.actorId, revokedAt: 1 });
    // The seeded three plus these make one more than the bound.
    await f.t.run(async ctx => {
      for (let i = 0; i < deletionResourceLimit - 2; i++) await ctx.db.insert("apiKeyCredentials", extraKey(i));
    });
    const response = await f.post("/api/auth/organization/delete", { organizationId: r.organizationId });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("could not safely complete");
    expect(await f.organization(r.organizationId)).toMatchObject({ _id: r.organizationId });
    expect(await f.t.query(internal.organizationLifecycle.isDeletedInternal, { organizationId: r.organizationId })).toBe(false);
    await access(f, r, true);
    // Exactly the configured bound succeeds; the sentinel row above was not
    // silently omitted from a partial deletion.
    await f.t.run(async ctx => {
      const extra = await ctx.db.query("apiKeyCredentials").filter(q => q.eq(q.field("keyId"), "extra-0")).unique();
      await ctx.db.delete(extra!._id);
    });
    expect(await f.t.run(async ctx => (await ctx.db.query("apiKeyCredentials").collect()).length)).toBe(deletionResourceLimit);
    expect((await f.post("/api/auth/organization/delete", { organizationId: r.organizationId })).status).toBe(200);
    expect(await f.organization(r.organizationId)).toBeNull();
    await access(f, r, false);
  });

  it("rolls back every revocation and refuses identity deletion on a mid-transaction failure", async () => {
    const limits = { documentsWritten: 8_192 };
    const f = await fixture(limits), r = await f.seed("rollback");
    limits.documentsWritten = 2; // Fail after the tombstone and first credential write.
    const response = await f.post("/api/auth/organization/delete", { organizationId: r.organizationId });
    expect(response.status).toBe(400);
    limits.documentsWritten = 8_192;
    expect(await f.organization(r.organizationId)).toMatchObject({ _id: r.organizationId });
    expect(await f.t.query(internal.organizationLifecycle.isDeletedInternal, { organizationId: r.organizationId })).toBe(false);
    for (const key of r.keys) expect(await f.t.run(ctx => ctx.db.get(key.id))).not.toHaveProperty("revokedAt");
    await access(f, r, true);
  });

  it("keeps access revoked if identity cleanup fails, and permits a safe retry", async () => {
    const f = await fixture(), r = await f.seed("retry");
    // Fault only the identity adapter after the production before-delete hook.
    const remove = vi.spyOn(f.context.adapter, "deleteMany").mockRejectedValueOnce(new Error("Identity storage unavailable"));
    const request = () => f.auth.handler(new Request("http://localhost:3000/api/auth/organization/delete", {
      method: "POST", headers: f.headers, body: JSON.stringify({ organizationId: r.organizationId }),
    }));
    expect((await request()).status).toBe(500);
    expect(remove).toHaveBeenCalled();
    expect(await f.organization(r.organizationId)).toMatchObject({ _id: r.organizationId });
    await access(f, r, false);
    expect((await request()).status).toBe(200);
    expect(await f.organization(r.organizationId)).toBeNull();
    expect(await f.t.run(ctx => ctx.db.query("organizationTombstones").collect())).toHaveLength(1);
  });

  it("rejects deletion without mutation capability", async () => {
    await expect(beforeDeleteOrganization({} as never, "org", "owner")).rejects.toMatchObject({ status: "BAD_REQUEST" });
  });

  it("does not revoke an organization for a non-owner or anonymous request", async () => {
    const f = await fixture(), r = await f.seed("authorized");
    expect((await f.t.fetch("/api/auth/organization/delete", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ organizationId: r.organizationId }) })).status).toBe(401);
    await f.t.mutation(components.betterAuth.adapter.updateOne, { input: { model: "member", where: [{ field: "organizationId", value: r.organizationId }], update: { role: "admin" } } });
    expect((await f.post("/api/auth/organization/delete", { organizationId: r.organizationId })).status).toBe(403);
    expect(await f.organization(r.organizationId)).toMatchObject({ _id: r.organizationId });
    expect(await f.t.query(internal.organizationLifecycle.isDeletedInternal, { organizationId: r.organizationId })).toBe(false);
    await access(f, r, true);
  });
});


describe("organization capability boundary regressions", () => {
  it("keeps credential listings secret-free and revocation scoped and repeatable", async () => {
    const f = await fixture(), r = await f.seed("credential-edges");
    const listed = await f.t.query(internal.apiKeyCredentials.listInternal, { organizationId: r.organizationId });
    expect(listed).toHaveLength(3);
    expect(listed.every(key => !("secretHash" in key))).toBe(true);
    for (const args of [{ organizationId: r.organizationId, keyId: "missing" }, { organizationId: "foreign", keyId: r.keys[0].keyId }]) {
      await expect(f.t.mutation(internal.apiKeyCredentials.revokeInternal, { ...args, actorId: r.actorId })).rejects.toThrow("API key not found");
    }
    const args = { organizationId: r.organizationId, keyId: r.keys[0].keyId, actorId: r.actorId };
    await f.t.mutation(internal.apiKeyCredentials.revokeInternal, args);
    const first = await f.t.run(ctx => ctx.db.get(r.keys[0].id));
    expect(first).toMatchObject({ _id: r.keys[0].id, revokedAt: expect.any(Number) });
    await f.t.mutation(internal.apiKeyCredentials.revokeInternal, args);
    expect(await f.t.run(ctx => ctx.db.get(r.keys[0].id))).toEqual(first);
  });

  it("preserves project validation", async () => {
    const f = await fixture(), r = await f.seed("project-edges");
    const scope = { organizationId: r.organizationId, projectId: r.projectId };
    for (const name of ["", "x".repeat(81)]) await expect(f.t.mutation(internal.projects.createInternal, { organizationId: r.organizationId, name, slug: "new", actorId: r.actorId })).rejects.toThrow("Project name");
    for (const slug of ["BAD/slug", "x".repeat(49)]) await expect(f.t.mutation(internal.projects.createInternal, { organizationId: r.organizationId, name: "New", slug, actorId: r.actorId })).rejects.toThrow("Project slug");
    await expect(f.t.mutation(internal.projects.createInternal, { organizationId: r.organizationId, name: "Docs", slug: "docs", actorId: r.actorId })).rejects.toThrow("already exists");
    expect(await f.t.query(internal.projects.getInternal, { ...scope, organizationId: "foreign" })).toBeNull();
    await f.t.run(ctx => ctx.db.delete(r.projectId));
    expect(await f.t.query(internal.projects.getInternal, scope)).toBeNull();
  });
});
