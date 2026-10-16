import { commitProof, commitWithProof } from "./helpers/storage-proof";
import { STORAGE_ATTESTATION_HEADER } from "../shared/storage-attestation";
import { describe, expect, it, vi } from "vitest";
import { ConvexError, getDocumentSize } from "convex/values";
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
const provenance = { source: { kind: "local" as const }, execution: { kind: "local" as const }, cliVersion: "test", manifestSha256: "a".repeat(64) };
async function fixture() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const project = await t.mutation(internal.projects.createInternal, { organizationId: "org", name: "Docs", slug: "docs", actorId: "user" });
  await t.mutation(internal.apiKeyCredentials.createInternal, { organizationId: "org", keyId: "key", keyPrefix: "key", name: "test", secretHash: await sha256("key"), scopes: ["docs:read", "docs:write"], actorId: "user" });
  const start = { organizationId: "org", projectId: project!._id, manifestSha256: "a".repeat(64), fileCount: 1, byteCount: 1, provenance };
  const staged = await t.mutation(internal.deployments.startInternal, { ...start, actorId: "user" });
  const identity = { organizationId: "org", projectId: project!._id, deploymentId: staged.deploymentId };
  const post = async (path: string, body: unknown, key = "key") => t.fetch(`/api/rendro/deployments/${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, ...(path === "commit" ? { [STORAGE_ATTESTATION_HEADER]: (await commitProof(t, identity))! } : {}) }, body: JSON.stringify(body) });
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
    await commitWithProof(f.t, { ...f.identity, deploymentId: next.deploymentId, actorId: "user" });
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

it("rejects noncanonical manifest digests at direct authenticated Convex ingress", async () => {
  const f = await fixture();
  for (const manifestSha256 of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "a".repeat(64) + "\n", "x".repeat(60_000)]) {
    const response = await f.post("start", { ...f.start, manifestSha256 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "manifestSha256 must be 64 lowercase hexadecimal characters" });
  }
  expect((await f.post("start", { ...f.start, manifestSha256: "0123456789abcdef".repeat(4) })).status).toBe(201);
});

it("rejects every oversized provenance string before creating a deployment", async () => {
  const f = await fixture();
  const fields = [
    ["source", "repository", 2048], ["source", "commit", 128], ["source", "ref", 256], ["source", "localPathLabel", 512],
    ["execution", "provider", 256], ["execution", "runId", 256], ["execution", "workflow", 256], ["execution", "job", 256], ["execution", "actor", 256],
    ["", "cliVersion", 64], ["", "manifestSha256", 128],
  ] as const;
  for (const [group, name, limit] of fields) {
    const provenance = group
      ? { ...f.start.provenance, [group]: { ...f.start.provenance[group], [name]: "x".repeat(limit + 1) } }
      : { ...f.start.provenance, [name]: "x".repeat(limit + 1) };
    expect((await f.post("start", { ...f.start, provenance })).status).toBe(400);
  }
  const before = await f.t.run(ctx => ctx.db.query("deployments").collect());
  expect(before).toHaveLength(1);
  await expect(f.t.mutation(internal.deployments.startInternal, { ...f.start, actorId: "x".repeat(257) })).rejects.toThrow("length limit");
});

it.each([false, true])("returns only Worker staging fields for credential-bearing legacy rows (renew=%s)", async renew => {
  const f = await fixture();
  await f.t.run(ctx => ctx.db.patch(f.identity.deploymentId, {
    stagingExpiresAt: Date.now() + (renew ? 1000 : 3_600_000),
    provenance: { source: { kind: "git", repository: "https://user:synthetic-password@git.example/repo?token=synthetic-query", ref: "private-ref" }, execution: { kind: "ci", workflow: "private-workflow", actor: "synthetic-ci-token" }, cliVersion: "private-version", manifestSha256: "private-hash" },
  }));
  await f.t.mutation(internal.apiKeyCredentials.createInternal, { organizationId: "org", keyId: "write", keyPrefix: "write", name: "Writer", secretHash: await sha256("write"), scopes: ["docs:write"], actorId: "user" });
  const response = await f.get("/staging", f.identity, { authorization: "Bearer write" });
  expect(response.status).toBe(200);
  const { deployment } = await response.json() as { deployment: { stagingExpiresAt: number } };
  expect(Object.keys(deployment).sort()).toEqual(["manifestKey", "stagingExpiresAt", "treeIndexKey"]);
  expect(JSON.stringify(deployment)).not.toMatch(/synthetic|private|provenance/);
  expect(deployment.stagingExpiresAt).toBeGreaterThan(Date.now());
});

it("returns the actionable restart diagnostic when commit loses the lease", async () => {
  const f = await fixture();
  await f.t.run(ctx => ctx.db.patch(f.identity.deploymentId, { stagingExpiresAt: Date.now() - 1 }));
  const response = await f.post("commit", f.identity);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "Staging lease expired. Run rendro push again to start a new deployment." });
});

it("requires a Worker attestation even for a currently authorized staging deployment", async () => {
  const f = await fixture();
  const response = await f.t.fetch("/api/rendro/deployments/commit", { method: "POST", headers: { authorization: "Bearer key" }, body: JSON.stringify(f.identity) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "Worker storage validation is required" });
});


it("accepts boundary-length strings with bounded generated keys and document size", async () => {
  const f = await fixture();
  const organizationId = "o".repeat(256);
  await f.t.run(ctx => ctx.db.patch(f.projectId, { organizationId }));
  const provenance = {
    source: { kind: "git" as const, repository: "https://git.example/" + "r".repeat(2028), commit: "c".repeat(128), ref: "😀".repeat(128), localPathLabel: "l".repeat(512) },
    execution: { kind: "ci" as const, provider: "p".repeat(256), runId: "r".repeat(256), workflow: "w".repeat(256), job: "j".repeat(256), actor: "a".repeat(256) },
    cliVersion: "v".repeat(64), manifestSha256: "h".repeat(128),
  };
  const start = { ...f.start, organizationId, provenance, actorId: "a".repeat(256) };
  const result = await f.t.mutation(internal.deployments.startInternal, start);
  const row = (await f.t.run(ctx => ctx.db.get(result.deploymentId)))!;
  expect(getDocumentSize(row)).toBeLessThan(16 * 1024);
  expect(row.manifestKey.length).toBeLessThan(1024);
  expect(row.treeIndexKey!.length).toBeLessThan(1024);
  expect(row.provenance.source.ref).toBe(provenance.source.ref);
  const longOrg = organizationId + "o";
  await f.t.run(ctx => ctx.db.patch(f.projectId, { organizationId: longOrg }));
  await expect(f.t.mutation(internal.deployments.startInternal, { ...start, organizationId: longOrg })).rejects.toThrow("length limit");
});
