import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth/minimal";
import { convexTest } from "convex-test";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { api, components, internal } from "../convex/_generated/api";
import { authComponent, createAuthOptions } from "../convex/auth";
import { requireOrganizationRole } from "../convex/authorization";
import { beforeDeleteOrganization, deletionResourceLimit } from "../convex/organizationLifecycle";
import { sha256 } from "../convex/credentialHash";
import rateLimiterTest from "./convex-rate-limiter";
import projectDocs from "../src/routes/project-docs";
import { createViewerTicket } from "../src/viewer-ticket";
import * as storage from "../src/minio";

const modules = import.meta.glob("../convex/**/*.ts");
const provenance = { source: { kind: "local" as const }, execution: { kind: "local" as const }, cliVersion: "test", manifestSha256: "manifest" };
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
  async function seed(slug: string) {
    const response = await post("/api/auth/organization/create", { name: slug, slug });
    expect(response.status).toBe(200);
    const organizationId = (await response.json()).id as string;
    const actorId = user.id;
    const project = (await t.mutation(internal.projects.createInternal, { organizationId, name: "Docs", slug: "docs", actorId }))!;
    const scope = { organizationId, projectId: project._id };
    const start = { ...scope, manifestSha256: "manifest", fileCount: 1, byteCount: 1, provenance, actorId };
    const first = await t.mutation(internal.deployments.startInternal, start);
    await t.mutation(internal.deployments.commitInternal, { ...scope, deploymentId: first.deploymentId, actorId });
    const active = await t.mutation(internal.deployments.startInternal, start);
    await t.mutation(internal.deployments.commitInternal, { ...scope, deploymentId: active.deploymentId, actorId });
    const staging = await t.mutation(internal.deployments.startInternal, start);
    const failed = await t.mutation(internal.deployments.startInternal, start);
    await t.mutation(internal.deployments.failInternal, { ...scope, deploymentId: failed.deploymentId, reason: "Interrupted" });
    const keys = [];
    for (const projectId of [undefined, project._id]) {
      const keyId = `${slug}-${projectId ?? "org"}`, secret = `test-${keyId}`;
      const secretHash = await sha256(secret);
      const id = await t.mutation(internal.apiKeyCredentials.createInternal, {
        organizationId, projectId, keyId, keyPrefix: "test", name: "Test", secretHash,
        scopes: ["docs:read", "docs:write", "publications:read", "publications:write"], actorId,
      });
      keys.push({ id, keyId, secret, secretHash });
    }
    const publication = (await t.mutation(internal.publicationsV2.createInternal, {
      ...scope, slug, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", actorId,
    }))!;
    await t.mutation(internal.publicationsV2.createInternal, {
      ...scope, slug: `${slug}-pinned`, pathPrefix: "", entryFile: "index.html", trackingMode: "pinned", pinnedDeploymentId: first.deploymentId, actorId,
    });
    const token = `share-${slug}`, tokenHash = await sha256(token);
    const share = (await t.mutation(internal.shareGrants.createInternal, {
      ...scope, documentPath: "index.html", tokenHash, expiresAt: Date.now() + 60_000, actorId,
    }))!;
    const revoked = (await t.mutation(internal.shareGrants.createInternal, {
      ...scope, documentPath: "index.html", tokenHash: `revoked-${slug}`, expiresAt: Date.now() + 60_000, actorId,
    }))!;
    await t.run(ctx => ctx.db.patch(revoked._id, { revokedAt: 1 }));
    const oldKey = await t.mutation(internal.apiKeyCredentials.createInternal, {
      organizationId, keyId: `old-${slug}`, keyPrefix: "old", name: "Old", secretHash: `old-${slug}`, scopes: [], actorId,
    });
    await t.run(ctx => ctx.db.patch(oldKey, { revokedAt: 1 }));
    return { ...scope, actorId, start, active, staging, publication, share, revoked, oldKey, keys, token, tokenHash, slug };
  }
  return { t, auth, context, user, session, cookie, headers, post, seed };
}

type Resources = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["seed"]>>;
async function access(f: Awaited<ReturnType<typeof fixture>>, r: Resources, allowed: boolean) {
  const query = new URLSearchParams({ organizationId: r.organizationId, projectId: r.projectId });
  for (const key of r.keys) {
    const headers = { authorization: `Bearer ${key.secret}` };
    expect((await f.t.fetch(`/api/rendro/credentials/validate?${query}&scope=docs:read`, { headers })).status).toBe(allowed ? 200 : 401);
    expect(await f.t.query(internal.apiKeyCredentials.verifiedIdInternal, { secretHash: key.secretHash })).toEqual(allowed ? key.id : null);
    for (const path of ["deployments/active", "deployments", "publications"]) {
      expect((await f.t.fetch(`/api/rendro/${path}?${query}`, { headers })).status).toBe(allowed ? 200 : 403);
    }
    expect((await f.t.fetch(`/api/rendro/deployments/staging?${query}&deploymentId=${r.staging.deploymentId}`, { headers })).status).toBe(allowed ? 200 : 401);
    if (!allowed) {
      for (const [path, body] of [
        ["start", r.start],
        ["commit", { organizationId: r.organizationId, projectId: r.projectId, deploymentId: r.staging.deploymentId }],
        ["fail", { organizationId: r.organizationId, projectId: r.projectId, deploymentId: r.staging.deploymentId, reason: "Interrupted" }],
      ] as const) {
        expect((await f.t.fetch(`/api/rendro/deployments/${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
      }
    }
  }
  for (const path of ["projects", "projects/get", "deployments/active", "deployments", "shares", "management/access"]) {
    expect((await f.t.fetch(`/api/rendro/${path}?${query}`, { headers: f.headers })).status).toBe(allowed ? 200 : 403);
  }
  for (const slug of [r.slug, `${r.slug}-pinned`]) {
    expect((await f.t.fetch(`/api/rendro/publications/public?slug=${slug}`)).status).toBe(allowed ? 200 : 404);
  }
  expect((await f.t.fetch(`/api/rendro/shares/public?token=${r.token}`)).status).toBe(allowed ? 200 : 404);
}

describe("organization deletion lifecycle", () => {
  it("revokes all access through the real auth HTTP handler, is idempotent, and isolates other organizations", async () => {
    const f = await fixture(), r = await f.seed("deleted"), other = await f.seed("untouched");
    await access(f, r, true);
    const ticket = await createViewerTicket({ ...r, manifestKey: r.active.manifestKey, cookie: f.cookie });
    const response = await f.post("/api/auth/organization/delete", { organizationId: r.organizationId });
    expect(response.status).toBe(200);
    await access(f, r, false);
    await access(f, other, true);
    expect(await f.t.query(components.betterAuth.adapter.findOne, { model: "organization", where: [{ field: "id", value: r.organizationId }] })).toBeNull();
    const snapshot = () => f.t.run(async ctx => ({
      tombstones: await ctx.db.query("organizationTombstones").collect(),
      keys: await ctx.db.query("apiKeyCredentials").withIndex("by_organization", q => q.eq("organizationId", r.organizationId)).collect(),
      shares: await ctx.db.query("shareGrants").withIndex("by_organization", q => q.eq("organizationId", r.organizationId)).collect(),
      publications: await ctx.db.query("publications").withIndex("by_organization", q => q.eq("organizationId", r.organizationId)).collect(),
      audit: await ctx.db.query("auditEvents").collect(),
    }));
    const before = await snapshot();
    expect(before.tombstones).toHaveLength(1);
    expect(before.keys.every(key => key.revokedAt !== undefined)).toBe(true);
    expect(before.shares.every(share => share.revokedAt !== undefined)).toBe(true);
    expect(before.publications).toEqual([]);
    expect(before.keys.find(key => key._id === r.oldKey)?.revokedAt).toBe(1);
    expect(before.shares.find(share => share._id === r.revoked._id)?.revokedAt).toBe(1);
    await f.t.mutation(internal.organizationLifecycle.deleteInternal, { organizationId: r.organizationId, actorId: r.actorId });
    expect(await snapshot()).toEqual(before);
    expect((await f.post("/api/auth/organization/delete", { organizationId: r.organizationId })).status).toBe(400);
    const candidates = await f.t.query(internal.retention.candidatesInternal, { failedBefore: Date.now() + 1, supersededBefore: Date.now() + 1, limit: 50 });
    expect(candidates.filter(d => d.organizationId === r.organizationId)).toHaveLength(4);

    // A ticket issued before deletion must reauthorize at Convex before R2.
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return f.t.fetch(url.pathname + url.search, init);
    }));
    const read = vi.spyOn(storage, "getObjectText"), stream = vi.spyOn(storage, "getObjectStream");
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", async (c, next) => { c.set("user", f.user); await next(); });
    app.route("/", projectDocs);
    const base = `/organizations/${r.organizationId}/projects/${r.projectId}/docs`;
    for (const path of [`${base}/view/${ticket}/files/index.html`, `${base}/files/index.html`, `${base}/viewer-ticket?manifestKey=${encodeURIComponent(r.active.manifestKey)}`]) {
      expect((await app.request(path, { headers: f.headers })).status).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("denies surviving capabilities and preauthorized writes using only a tombstone", async () => {
    const f = await fixture(), r = await f.seed("partial");
    await f.t.run(ctx => ctx.db.insert("organizationTombstones", { organizationId: r.organizationId, deletedAt: Date.now(), deletedBy: r.actorId }));
    await access(f, r, false);
    const scope = { organizationId: r.organizationId, projectId: r.projectId };
    await expect(f.t.mutation(internal.projects.createInternal, { organizationId: r.organizationId, name: "New", slug: "new", actorId: r.actorId })).rejects.toThrow("Organization membership required");
    await expect(f.t.mutation(internal.apiKeyCredentials.createInternal, { ...scope, keyId: "new", keyPrefix: "new", name: "New", secretHash: "new", scopes: [], actorId: r.actorId })).rejects.toThrow("Organization membership required");
    await expect(f.t.mutation(internal.publicationsV2.createInternal, { ...scope, slug: "new", entryFile: "index.html", pathPrefix: "", trackingMode: "track_active", actorId: r.actorId })).rejects.toThrow("Organization membership required");
    await expect(f.t.mutation(internal.shareGrants.createInternal, { ...scope, tokenHash: "new", documentPath: "index.html", expiresAt: Date.now() + 60_000, actorId: r.actorId })).rejects.toThrow("Organization membership required");
    await expect(f.t.mutation(internal.deployments.startInternal, r.start)).rejects.toThrow("Organization membership required");
    await expect(f.t.mutation(internal.deployments.commitInternal, { ...scope, deploymentId: r.staging.deploymentId, actorId: r.actorId })).rejects.toThrow("Organization membership required");
    expect(await f.t.query(internal.projects.getInternal, scope)).toBeNull();
    expect(await f.t.query(internal.deployments.getInternal, { ...scope, deploymentId: r.active.deploymentId })).toBeNull();
    expect(await f.t.query(internal.deployments.latestForOrganization, { organizationId: r.organizationId })).toBeNull();
    const signed = f.t.withIdentity({ subject: f.user.id, sessionId: f.session.id });
    await expect(signed.query(api.projects.activeDeployment, scope)).rejects.toMatchObject({ data: { code: "not_found" } });
    expect(await f.t.run(ctx => ctx.db.get(r.keys[0].id))).not.toHaveProperty("revokedAt");
    expect(await f.t.run(ctx => ctx.db.get(r.publication._id))).not.toBeNull();
  });

  it("refuses deletion before writes when atomic resource limits are exceeded", async () => {
    const f = await fixture(), r = await f.seed("large");
    await f.t.run(async ctx => {
      for (let i = 0; i <= deletionResourceLimit; i++) await ctx.db.insert("projects", {
        organizationId: r.organizationId, name: "Extra", slug: `extra-${i}`, createdAt: i, createdBy: r.actorId,
      });
    });
    const response = await f.post("/api/auth/organization/delete", { organizationId: r.organizationId });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("could not safely complete");
    expect(await f.t.query(internal.organizationLifecycle.isDeletedInternal, { organizationId: r.organizationId })).toBe(false);
    await access(f, r, true);
    // Exactly the configured bound succeeds; the sentinel row above was not
    // silently omitted from a partial deletion.
    await f.t.run(async ctx => {
      const projects = await ctx.db.query("projects").collect();
      const count = projects.length + (await ctx.db.query("deployments").collect()).length
        + (await ctx.db.query("apiKeyCredentials").collect()).length
        + (await ctx.db.query("shareGrants").collect()).length
        + (await ctx.db.query("publications").collect()).length;
      for (const project of projects.filter(p => p.slug.startsWith("extra-")).slice(0, count - deletionResourceLimit)) await ctx.db.delete(project._id);
    });
    expect((await f.post("/api/auth/organization/delete", { organizationId: r.organizationId })).status).toBe(200);
    await access(f, r, false);
  });

  it("rolls back every revocation and refuses identity deletion on a mid-transaction failure", async () => {
    const limits = { documentsWritten: 8_192 };
    const f = await fixture(limits), r = await f.seed("rollback");
    limits.documentsWritten = 2; // Fail after the tombstone and first credential write.
    const response = await f.post("/api/auth/organization/delete", { organizationId: r.organizationId });
    expect(response.status).toBe(400);
    limits.documentsWritten = 8_192;
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
    await access(f, r, false);
    expect((await request()).status).toBe(200);
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
    await f.t.mutation(internal.apiKeyCredentials.revokeInternal, args);
    expect(await f.t.run(ctx => ctx.db.get(r.keys[0].id))).toEqual(first);
  });

  it("preserves project validation and fails closed for incomplete deployment relationships", async () => {
    const f = await fixture(), r = await f.seed("deployment-edges");
    const scope = { organizationId: r.organizationId, projectId: r.projectId };
    for (const name of ["", "x".repeat(81)]) await expect(f.t.mutation(internal.projects.createInternal, { organizationId: r.organizationId, name, slug: "new", actorId: r.actorId })).rejects.toThrow("Project name");
    for (const slug of ["BAD/slug", "x".repeat(49)]) await expect(f.t.mutation(internal.projects.createInternal, { organizationId: r.organizationId, name: "New", slug, actorId: r.actorId })).rejects.toThrow("Project slug");
    await expect(f.t.mutation(internal.projects.createInternal, { organizationId: r.organizationId, name: "Docs", slug: "docs", actorId: r.actorId })).rejects.toThrow("already exists");
    expect(await f.t.query(internal.projects.getInternal, { ...scope, organizationId: "foreign" })).toBeNull();
    for (const counts of [{ fileCount: -1 }, { byteCount: -1 }]) await expect(f.t.mutation(internal.deployments.startInternal, { ...r.start, ...counts })).rejects.toThrow("non-negative");
    expect(await f.t.query(internal.deployments.getInternal, { ...scope, organizationId: "foreign", deploymentId: r.active.deploymentId })).toBeNull();
    await expect(f.t.query(internal.deployments.listInternal, { ...scope, organizationId: "foreign" })).rejects.toThrow("Project not found");
    const commit = { ...scope, deploymentId: r.staging.deploymentId, actorId: r.actorId };
    await expect(f.t.mutation(internal.deployments.commitInternal, { ...commit, organizationId: "foreign" })).rejects.toThrow("Project not found");
    await expect(f.t.mutation(internal.deployments.commitInternal, { ...commit, deploymentId: r.active.deploymentId })).rejects.toThrow("Only a staging");
    await f.t.run(ctx => ctx.db.patch(r.active.deploymentId, { status: "superseded" }));
    await f.t.mutation(internal.deployments.commitInternal, commit);
    await f.t.run(ctx => ctx.db.delete(r.staging.deploymentId));
    await expect(f.t.mutation(internal.deployments.commitInternal, commit)).rejects.toThrow("Deployment not found");
    await f.t.run(ctx => ctx.db.delete(r.projectId));
    expect(await f.t.query(internal.projects.getInternal, scope)).toBeNull();
    expect(await f.t.query(internal.deployments.latestForOrganization, { organizationId: r.organizationId })).toBeNull();
  });

  it("enforces publication validation and rejects dangling or unavailable capabilities", async () => {
    const f = await fixture(), r = await f.seed("publication-edges");
    const args = { organizationId: r.organizationId, projectId: r.projectId, slug: "new", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" as const, actorId: r.actorId };
    await expect(f.t.mutation(internal.publicationsV2.createInternal, { ...args, organizationId: "foreign" })).rejects.toThrow("Project not found");
    for (const slug of ["BAD/slug", "x".repeat(81)]) await expect(f.t.mutation(internal.publicationsV2.createInternal, { ...args, slug })).rejects.toThrow("Invalid publication slug");
    await expect(f.t.mutation(internal.publicationsV2.createInternal, { ...args, slug: r.slug })).rejects.toThrow("already in use");
    await expect(f.t.mutation(internal.publicationsV2.createInternal, { ...args, trackingMode: "pinned" })).rejects.toThrow("requires a deployment");
    const titled = await f.t.mutation(internal.publicationsV2.createInternal, { ...args, title: " Release ", description: " Notes " });
    expect(titled).toMatchObject({ title: "Release", description: "Notes" });
    expect(await f.t.query(internal.publicationsV2.listInternal, { organizationId: r.organizationId })).toHaveLength(3);
    const resolve = () => f.t.query(internal.publicationsV2.resolvePublicInternal, { slug: r.slug });
    for (const status of ["failed", "staging"] as const) {
      await f.t.run(ctx => ctx.db.patch(r.active.deploymentId, { status }));
      expect(await resolve()).toBeNull();
      await expect(f.t.mutation(internal.publicationsV2.createInternal, { ...args, slug: "pinned", trackingMode: "pinned", pinnedDeploymentId: r.active.deploymentId })).rejects.toThrow("Pinned deployment not found");
    }
    await f.t.run(ctx => ctx.db.delete(r.active.deploymentId));
    expect(await resolve()).toBeNull();
    await f.t.run(ctx => ctx.db.patch(r.projectId, { activeDeploymentId: undefined }));
    expect(await resolve()).toBeNull();
    await f.t.run(ctx => ctx.db.delete(r.projectId));
    expect(await resolve()).toBeNull();
  });

  it("keeps share revocation scoped and rejects unavailable targets and invalid paths", async () => {
    const f = await fixture(), r = await f.seed("share-edges");
    const args = { organizationId: r.organizationId, projectId: r.projectId, documentPath: "index.html", tokenHash: "new", expiresAt: Date.now() + 60_000, actorId: r.actorId };
    await expect(f.t.mutation(internal.shareGrants.createInternal, { ...args, organizationId: "foreign" })).rejects.toThrow("Project has no active deployment");
    for (const documentPath of ["", "bad\\path", "../private", "a//b", "a/./b"]) await expect(f.t.mutation(internal.shareGrants.createInternal, { ...args, documentPath })).rejects.toThrow("Invalid document path");
    await expect(f.t.mutation(internal.shareGrants.createInternal, { ...args, expiresAt: Date.now() - 1 })).rejects.toThrow("expiry must be in the future");
    await expect(f.t.mutation(internal.shareGrants.revokeInternal, { organizationId: "foreign", grantId: r.share._id, actorId: r.actorId })).rejects.toThrow("Share not found");
    const revoke = { organizationId: r.organizationId, grantId: r.share._id, actorId: r.actorId };
    await f.t.mutation(internal.shareGrants.revokeInternal, revoke);
    const first = await f.t.run(ctx => ctx.db.get(r.share._id));
    await f.t.mutation(internal.shareGrants.revokeInternal, revoke);
    expect(await f.t.run(ctx => ctx.db.get(r.share._id))).toEqual(first);
    await f.t.run(ctx => ctx.db.delete(r.share._id));
    await expect(f.t.mutation(internal.shareGrants.revokeInternal, revoke)).rejects.toThrow("Share not found");
    const valid = (await f.t.mutation(internal.shareGrants.createInternal, args))!;
    const resolve = () => f.t.query(internal.shareGrants.resolveInternal, { tokenHash: args.tokenHash });
    for (const status of ["failed", "staging"] as const) {
      await f.t.run(ctx => ctx.db.patch(r.active.deploymentId, { status }));
      expect(await resolve()).toBeNull();
    }
    await f.t.run(ctx => ctx.db.patch(r.active.deploymentId, { status: "active" }));
    await f.t.run(ctx => ctx.db.patch(valid._id, { expiresAt: Date.now() - 1 }));
    expect(await resolve()).toBeNull();
    await f.t.run(ctx => ctx.db.patch(valid._id, { expiresAt: Date.now() + 60_000 }));
    await f.t.run(ctx => ctx.db.delete(r.projectId));
    expect(await resolve()).toBeNull();
    await f.t.run(ctx => ctx.db.delete(r.active.deploymentId));
    expect(await resolve()).toBeNull();
  });

  it("checks reactive viewer membership, role and deployment state independently", async () => {
    const f = await fixture(), r = await f.seed("viewer-edges");
    const scope = { organizationId: r.organizationId, projectId: r.projectId };
    const signed = f.t.withIdentity({ subject: f.user.id, sessionId: f.session.id });
    expect(await signed.query(api.projects.activeDeployment, scope)).toBe(r.active.deploymentId);
    await expect(signed.run(ctx => requireOrganizationRole(ctx, r.organizationId, ["admin"]))).rejects.toMatchObject({ data: { code: "forbidden" } });
    expect(await signed.run(ctx => requireOrganizationRole(ctx, r.organizationId, ["owner"]))).toMatchObject({ member: { role: "owner" } });
    for (const patch of [{ organizationId: "foreign" }, { projectId: (await f.seed("sibling")).projectId }, { status: "failed" as const }]) {
      await f.t.run(ctx => ctx.db.patch(r.active.deploymentId, patch));
      expect(await signed.query(api.projects.activeDeployment, scope)).toBeNull();
      await f.t.run(ctx => ctx.db.patch(r.active.deploymentId, { ...scope, status: "active" }));
    }
    await f.t.run(ctx => ctx.db.delete(r.active.deploymentId));
    expect(await signed.query(api.projects.activeDeployment, scope)).toBeNull();
    await f.t.run(ctx => ctx.db.patch(r.projectId, { activeDeploymentId: undefined }));
    expect(await signed.query(api.projects.activeDeployment, scope)).toBeNull();
    const getUser = vi.spyOn(authComponent, "safeGetAuthUser").mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(signed.query(api.projects.activeDeployment, scope)).rejects.toThrow();
    getUser.mockRestore();
    await f.t.mutation(components.betterAuth.adapter.deleteOne, { input: { model: "organization", where: [{ field: "_id", value: r.organizationId }] } });
    await expect(signed.query(api.projects.activeDeployment, scope)).rejects.toMatchObject({ data: { code: "not_found" } });
  });
});
