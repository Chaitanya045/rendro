import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import rateLimiterTest from "./convex-rate-limiter";
import { registerAuth } from "./helpers/auth-identity";
import { signStorageValidation, STORAGE_ATTESTATION_HEADER, type StorageValidation } from "../shared/storage-attestation";
import worker from "../src/worker";
import * as storage from "../src/minio";

vi.mock("../src/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const modules = import.meta.glob("../convex/**/*.ts");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const secret = process.env.CONVEX_INTERNAL_SECRET!;
const contents = "<h1>Docs</h1>";
const manifest = { version: 1, files: [
  { path: "docs/index.html", sha256: hash(contents), size: contents.length, contentType: "text/html" },
  { path: "docs/style.css", sha256: hash(contents), size: contents.length, contentType: "text/css" },
  { path: "outside.html", sha256: hash(contents), size: contents.length, contentType: "text/html" },
] };
const manifestSha256 = hash(JSON.stringify(manifest));
const provenance = { source: { kind: "local" as const }, execution: { kind: "local" as const }, cliVersion: "test", manifestSha256 };
const json = (body: unknown, key = "all", proof?: string): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(proof ? { [STORAGE_ATTESTATION_HEADER]: proof } : {}) }, body: JSON.stringify(body),
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  registerAuth(t);
  const project = (await t.mutation(internal.projects.createInternal, { organizationId: "org", name: "Docs", slug: "docs", actorId: "owner" }))!;
  const scope = { organizationId: "org", projectId: project._id };
  for (const [key, scopes] of [["all", ["docs:read", "docs:write", "publications:write"]], ["write", ["publications:write"]], ["read", ["docs:read"]]] as const) {
    await t.mutation(internal.apiKeyCredentials.createInternal, { ...scope, keyId: key, keyPrefix: key, name: key, secretHash: hash(key), scopes: [...scopes], actorId: "owner" });
  }
  const objects = new Map<string, string>();
  vi.spyOn(storage, "putObject").mockImplementation((key, body) => { objects.set(key, typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)); return Promise.resolve(); });
  vi.spyOn(storage, "getObjectText").mockImplementation(key => Promise.resolve(objects.get(key) ?? null));
  vi.spyOn(storage, "listAllKeys").mockImplementation(prefix => Promise.resolve([...objects.keys()].filter(key => key.startsWith(prefix))));
  vi.spyOn(storage, "headObject").mockImplementation(key => Promise.resolve(objects.has(key) ? { size: objects.get(key)!.length, metadata: { sha256: hash(objects.get(key)!) } } : null));
  vi.spyOn(storage, "copyObject").mockImplementation((source, target) => { objects.set(target, objects.get(source)!); return Promise.resolve(); });
  const forwarded: Array<{ path: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input); const path = url.pathname + url.search;
    forwarded.push({ path, init });
    return t.fetch(path, init);
  }));
  const start = async () => {
    const response = await worker.request("/api/rendro/deployments/start", json({ ...scope, manifest, manifestSha256, provenance }));
    expect(response.status, await response.clone().text()).toBe(201);
    const { deployment } = await response.json();
    return { ...scope, deploymentId: deployment.deploymentId as string, manifestKey: deployment.manifestKey as string, manifestSha256, fileCount: manifest.files.length };
  };
  const upload = async (deployment: Awaited<ReturnType<typeof start>>) => {
    for (const file of manifest.files) expect((await worker.request(`/api/rendro/deployments/${deployment.deploymentId}/files/${file.path}?${new URLSearchParams(scope)}`, {
      method: "PUT", headers: { authorization: "Bearer all" }, body: contents,
    })).status).toBe(200);
  };
  const commit = (deployment: Awaited<ReturnType<typeof start>>) => worker.request(`/api/rendro/deployments/${deployment.deploymentId}/commit?${new URLSearchParams(scope)}`, json({}));
  const publish = { ...scope, slug: "docs", pathPrefix: "docs", entryFile: "index.html", trackingMode: "track_active" as const };
  return { t, scope, project, objects, forwarded, start, upload, commit, publish };
}

describe("Convex storage validation authority", () => {
  it("rejects malformed deployment requests and unavailable staging lookups", async () => {
    const f = await fixture();
    const valid = { ...f.scope, manifestSha256, fileCount: 3, byteCount: 3 * contents.length, provenance, deploymentId: "id", reason: "failure" };
    for (const operation of ["start", "commit", "fail"]) {
      const path = `/api/rendro/deployments/${operation}`;
      for (const body of [null, "invalid", {}, { ...valid, projectId: 1 }]) expect((await f.t.fetch(path, json(body))).status).toBe(400);
      expect((await f.t.fetch(path, { ...json({}), body: "{" })).status).toBe(400);
    }
    const deployment = await f.start(); await f.upload(deployment); await f.commit(deployment);
    const path = `/api/rendro/deployments/staging?${new URLSearchParams({ ...f.scope, deploymentId: deployment.deploymentId })}`;
    expect((await f.t.fetch(path, { headers: { authorization: "Bearer all" } })).status).toBe(404);
    const id = await f.t.run(ctx => Promise.resolve(ctx.db.normalizeId("deployments", deployment.deploymentId)!));
    await f.t.run(ctx => ctx.db.delete(id));
    expect((await f.t.fetch(path, { headers: { authorization: "Bearer all" } })).status).toBe(404);
  });

  it("rejects malformed uploads and keeps CLI failure cleanup idempotent", async () => {
    const f = await fixture(), deployment = await f.start();
    const path = `/api/rendro/deployments/${deployment.deploymentId}/files/docs/index.html?${new URLSearchParams(f.scope)}`;
    expect((await worker.request(path, { method: "PUT", headers: { authorization: "Bearer all", "content-length": "999" }, body: contents })).status).toBe(413);
    for (const body of ["short", "x".repeat(contents.length)]) expect((await worker.request(path, { method: "PUT", headers: { authorization: "Bearer all" }, body })).status).toBe(body.length === contents.length ? 400 : 413);
    for (let attempt = 0; attempt < 2; attempt++) expect((await worker.request("/api/rendro/deployments/fail", json({ ...f.scope, deploymentId: deployment.deploymentId, reason: "Upload interrupted" }))).status).toBe(200);
    expect((await worker.request("/api/rendro/publications", { ...json({}), body: "{" })).status).toBe(400);
  });

  it("refuses direct activation with a valid key but missing, forged, stale, future or mismatched proofs", async () => {
    const f = await fixture(), deployment = await f.start();
    const fields: StorageValidation = { ...deployment, purpose: "deployment-commit" };
    const proofs: Array<string | undefined> = [undefined, `${Date.now()}.${"a".repeat(64)}`, await signStorageValidation(fields, secret, Date.now() - 60_001), await signStorageValidation(fields, secret, Date.now() + 60_000)];
    for (const field of ["organizationId", "projectId", "deploymentId", "manifestKey", "manifestSha256", "fileCount"] as const) {
      proofs.push(await signStorageValidation({ ...fields, [field]: field === "fileCount" ? 99 : "other" }, secret));
    }
    proofs.push(await signStorageValidation({ ...fields, purpose: "publication-entry", pathPrefix: "docs", entryFile: "index.html", trackingMode: "track_active" }, secret));
    for (const proof of proofs) {
      const response = await f.t.fetch("/api/rendro/deployments/commit", json(deployment, "all", proof));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Worker storage validation is required" });
      expect((await f.t.query(internal.projects.getInternal, f.scope))?.activeDeploymentId).toBeUndefined();
    }
    await expect(f.t.mutation(internal.deployments.commitInternal, { ...f.scope, deploymentId: deployment.deploymentId, actorId: "owner" })).rejects.toThrow("storage validation");
  });

  it("requires exact manifest hash/count and complete storage, then supports upload, copy and activation", async () => {
    const f = await fixture(), first = await f.start();
    expect((await f.commit(first)).status).toBe(409);
    expect(f.forwarded.some(call => call.path === "/api/rendro/deployments/commit")).toBe(false);
    await f.upload(first);
    const id = await f.t.run(ctx => Promise.resolve(ctx.db.normalizeId("deployments", first.deploymentId)!));
    for (const patch of [{ manifestSha256: "wrong" }, { fileCount: 99 }]) {
      await f.t.run(ctx => ctx.db.patch(id, patch));
      expect((await f.commit(first)).status).toBe(409);
      await f.t.run(ctx => ctx.db.patch(id, { manifestSha256, fileCount: 3 }));
    }
    expect((await f.commit(first)).status).toBe(200);
    const second = await f.start();
    expect((await worker.request(`/api/rendro/deployments/${second.deploymentId}/copy?${new URLSearchParams(f.scope)}`, json({ paths: manifest.files.map(file => file.path) }))).status).toBe(200);
    expect((await f.commit(second)).status).toBe(200);
    expect((await f.t.query(internal.projects.getInternal, f.scope))?.activeDeploymentId).toBe(second.deploymentId);
    expect((await f.t.query(internal.deployments.getInternal, { ...f.scope, deploymentId: first.deploymentId }))?.status).toBe("superseded");
    const attested = f.forwarded.filter(call => call.path === "/api/rendro/deployments/commit").at(-1)!;
    expect(new Headers(attested.init?.headers).get(STORAGE_ATTESTATION_HEADER)).toMatch(/^\d+\.[a-f0-9]{64}$/);
    expect((await f.t.fetch(attested.path, attested.init)).status).toBe(409); // A valid proof cannot reactivate a committed record.
  });

  it.each(["write", "read"])("requires both publication scopes for %s-only keys directly and through the Worker", async key => {
    const f = await fixture(), deployment = await f.start(); await f.upload(deployment); await f.commit(deployment);
    const proof = await signStorageValidation({ ...deployment, ...f.publish, purpose: "publication-entry" }, secret);
    for (const invoke of [() => f.t.fetch("/api/rendro/publications", json(f.publish, key, proof)), () => worker.request("/api/rendro/publications", json(f.publish, key, proof))]) {
      expect((await invoke()).status).toBe(403);
    }
    expect(await f.t.query(internal.publicationsV2.listInternal, f.scope)).toEqual([]);
  });

  it.each([
    { entryFile: "missing.html" }, { entryFile: "style.css" }, { entryFile: "../outside.html" },
    { entryFile: "outside.html" }, { pathPrefix: "docs/.." },
  ])("rejects invalid publication entries directly and through the Worker: %j", async patch => {
    const f = await fixture(), deployment = await f.start(); await f.upload(deployment); await f.commit(deployment);
    const proof = await signStorageValidation({ ...deployment, ...f.publish, purpose: "publication-entry" }, secret);
    const body = { ...f.publish, ...patch };
    for (const provided of [undefined, proof]) {
      expect((await f.t.fetch("/api/rendro/publications", json(body, "all", provided))).status).toBe(400);
      expect((await worker.request("/api/rendro/publications", json(body, "all", provided))).status).toBe(400);
    }
    expect(await f.t.query(internal.publicationsV2.listInternal, f.scope)).toEqual([]);
  });

  it.each(["track_active", "pinned"] as const)("creates valid %s publications via Worker and directly with the same proof", async trackingMode => {
    const f = await fixture(), deployment = await f.start(); await f.upload(deployment); await f.commit(deployment);
    const body = { ...f.publish, trackingMode, ...(trackingMode === "pinned" ? { pinnedDeploymentId: deployment.deploymentId } : {}) };
    const response = await worker.request("/api/rendro/publications", json(body));
    expect(response.status, await response.clone().text()).toBe(201);
    const forwarded = f.forwarded.at(-1)!;
    const proof = new Headers(forwarded.init?.headers).get(STORAGE_ATTESTATION_HEADER)!;
    expect((await f.t.fetch("/api/rendro/publications", json({ ...body, slug: "direct" }, "all", proof))).status).toBe(201);
    expect((await f.t.fetch("/api/rendro/publications", json({ ...body, slug: "unattested" }))).status).toBe(400);
  });

  it("enforces the publication form's title and description limits through the Worker and directly", async () => {
    const f = await fixture(), deployment = await f.start(); await f.upload(deployment); await f.commit(deployment);
    const proof = await signStorageValidation({ ...deployment, ...f.publish, purpose: "publication-entry" }, secret);
    for (const patch of [{ title: "T".repeat(101) }, { title: ` ${"T".repeat(100)}` + "x" }, { description: "D".repeat(501) }]) {
      for (const invoke of [() => worker.request("/api/rendro/publications", json({ ...f.publish, ...patch })), () => f.t.fetch("/api/rendro/publications", json({ ...f.publish, ...patch }, "all", proof))]) {
        const response = await invoke();
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "title" in patch ? "Publication title must be at most 100 characters" : "Publication description must be at most 500 characters" });
      }
    }
    expect(await f.t.query(internal.publicationsV2.listInternal, f.scope)).toEqual([]);
    // The limits are inclusive and apply to the trimmed value, like the stored one.
    const created = await worker.request("/api/rendro/publications", json({ ...f.publish, title: `  ${"T".repeat(100)}  `, description: ` ${"D".repeat(500)} ` }));
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await f.t.query(internal.publicationsV2.listInternal, f.scope)).toMatchObject([{ title: "T".repeat(100), description: "D".repeat(500) }]);
  });

  it("rejects publication proofs after active deployment changes but permits verified pinned superseded entries", async () => {
    const f = await fixture(), first = await f.start(); await f.upload(first); await f.commit(first);
    const proof = await signStorageValidation({ ...first, ...f.publish, purpose: "publication-entry" }, secret);
    const second = await f.start(); await f.upload(second); await f.commit(second);
    expect((await f.t.fetch("/api/rendro/publications", json(f.publish, "all", proof))).status).toBe(400);
    expect((await worker.request("/api/rendro/publications", json({ ...f.publish, trackingMode: "pinned", pinnedDeploymentId: first.deploymentId }))).status).toBe(201);
  });

  it("rejects expired, forged and unavailable-deployment publication proofs", async () => {
    const f = await fixture(), deployment = await f.start(); await f.upload(deployment); await f.commit(deployment);
    const fields: StorageValidation = { ...deployment, ...f.publish, purpose: "publication-entry" };
    for (const proof of [
      `${Date.now()}.${"0".repeat(64)}`, await signStorageValidation(fields, secret, Date.now() - 60_001),
      await signStorageValidation({ ...fields, projectId: "another" }, secret),
      await signStorageValidation({ ...fields, deploymentId: "another" }, secret),
    ]) expect((await f.t.fetch("/api/rendro/publications", json(f.publish, "all", proof))).status).toBe(400);
    const proof = await signStorageValidation(fields, secret);
    const id = await f.t.run(ctx => Promise.resolve(ctx.db.normalizeId("deployments", deployment.deploymentId)!));
    const sibling = (await f.t.mutation(internal.projects.createInternal, { organizationId: "org", name: "Sibling", slug: "sibling", actorId: "owner" }))!;
    for (const patch of [{ organizationId: "foreign" }, { projectId: sibling._id }, { status: "staging" as const }, { status: "failed" as const }]) {
      await f.t.run(ctx => ctx.db.patch(id, patch));
      expect((await f.t.fetch("/api/rendro/publications", json(f.publish, "all", proof))).status).toBe(400);
      await f.t.run(ctx => ctx.db.patch(id, { ...f.scope, status: "active" }));
    }
    await f.t.run(ctx => ctx.db.patch(f.project._id, { activeDeploymentId: undefined }));
    expect((await f.t.fetch("/api/rendro/publications", json(f.publish, "all", proof))).status).toBe(400);
    await f.t.run(ctx => ctx.db.delete(id));
    expect((await f.t.fetch("/api/rendro/publications", json({ ...f.publish, trackingMode: "pinned", pinnedDeploymentId: deployment.deploymentId }, "all", proof))).status).toBe(400);
  });

  it("normalizes publication paths identically and replaces caller proof headers", async () => {
    const f = await fixture(), deployment = await f.start(); await f.upload(deployment); await f.commit(deployment);
    const body = { ...f.publish, pathPrefix: " /docs/ ", entryFile: " index.html " };
    const response = await worker.request("/api/rendro/publications", json(body, "all", "caller-proof"));
    expect(response.status).toBe(201);
    expect((await response.json()).publication).toMatchObject({ pathPrefix: "docs", entryFile: "index.html" });
    const proof = new Headers(f.forwarded.at(-1)!.init?.headers).get(STORAGE_ATTESTATION_HEADER)!;
    expect(proof).not.toBe("caller-proof");
    expect((await f.t.fetch("/api/rendro/publications", json({ ...body, slug: "second" }, "all", proof))).status).toBe(201);
    // Valid proof is no substitute for configured backend trust.
    vi.stubEnv("CONVEX_INTERNAL_SECRET", "");
    expect((await f.t.fetch("/api/rendro/publications", json({ ...body, slug: "third" }, "all", proof))).status).toBe(400);
  });

  it("keeps scope, tenant, project and predecessor checks even with a valid proof", async () => {
    const f = await fixture(), left = await f.start(), right = await f.start();
    const proof = await signStorageValidation({ ...right, purpose: "deployment-commit" }, secret);
    expect((await f.t.fetch("/api/rendro/deployments/commit", json(right, "read", proof))).status).toBe(401);
    expect((await f.t.fetch("/api/rendro/deployments/commit", json({ ...right, organizationId: "other" }, "all", proof))).status).toBe(401);
    const sibling = (await f.t.mutation(internal.projects.createInternal, { organizationId: "org", name: "Sibling", slug: "sibling", actorId: "owner" }))!;
    expect((await f.t.fetch("/api/rendro/deployments/commit", json({ ...right, projectId: sibling._id }, "all", proof))).status).toBe(401);
    await f.upload(left); await f.commit(left);
    const stale = await f.t.fetch("/api/rendro/deployments/commit", json(right, "all", proof));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "Active deployment changed; rebase and retry" });
  });

  it("allows the new Worker to send proof headers to an older backend without changing its request body", async () => {
    const f = await fixture(), deployment = await f.start(); await f.upload(deployment);
    const transport = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith("/deployments/commit")) {
        expect(JSON.parse(init!.body as string)).toEqual({ ...f.scope, deploymentId: deployment.deploymentId });
        expect(new Headers(init?.headers).has(STORAGE_ATTESTATION_HEADER)).toBe(true);
        return Response.json({ deploymentId: deployment.deploymentId });
      }
      return transport(input, init);
    });
    expect((await f.commit(deployment)).status).toBe(200);
    vi.mocked(fetch).mockImplementation(transport);
    expect((await f.commit(deployment)).status).toBe(200);
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith("/publications")) {
        expect(JSON.parse(init!.body as string)).toEqual(f.publish);
        expect(new Headers(init?.headers).has(STORAGE_ATTESTATION_HEADER)).toBe(true);
        return Response.json({ publication: { slug: f.publish.slug } }, { status: 201 });
      }
      return transport(input, init);
    });
    expect((await worker.request("/api/rendro/publications", json(f.publish))).status).toBe(201);
  });
});
