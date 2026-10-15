import { commitWithProof, publishWithProof } from "./helpers/storage-proof";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import rateLimiterTest from "./convex-rate-limiter";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha256 } from "../convex/credentialHash";
import { signResolverRequest } from "../shared/resolver-auth";
import { gitRemoteCases } from "./git-remote-fixtures";
import { sanitizeProvenance } from "../shared/provenance";
import publicRoutes from "../src/routes/public-v2";
import shareRoutes from "../src/routes/share-v2";
import { proxyConvexRequest } from "../src/auth-proxy";
import * as storage from "../src/minio";
vi.mock("../src/config", async importOriginal => ({ ...await importOriginal<object>(), CONVEX_SITE_URL: "https://some.convex.site" }));
const modules = import.meta.glob("../convex/**/*.ts");
const secret = process.env.CONVEX_INTERNAL_SECRET!;
const pubPath = "/api/rendro/publications/public?slug=docs";
const sharePath = "/api/rendro/shares/public?token=synthetic-share-token";
const provenance = {
  source: { kind: "git" as const, repository: "https://private-user:synthetic-token@git.example/private/repo.git?token=synthetic-query#synthetic-fragment", commit: "commit-abc123", ref: "refs/heads/main", dirty: true, localPathLabel: "/private/home/user/docs" },
  execution: { kind: "ci" as const, provider: "github-actions", runId: "123", workflow: "Publish", job: "docs", actor: "private-actor" },
  cliVersion: "2.0.0", manifestSha256: "manifest-sha",
};
async function fixture(inputProvenance = provenance) {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const project = (await t.mutation(internal.projects.createInternal, { organizationId: "private-org", name: "Docs", slug: "private-project", actorId: "private-creator" }))!;
  const scope = { organizationId: project.organizationId, projectId: project._id };
  const deployment = await t.mutation(internal.deployments.startInternal, { ...scope, manifestSha256: "manifest-sha", fileCount: 1, byteCount: 1, provenance: inputProvenance, actorId: "private-actor" });
  await commitWithProof(t, { ...scope, deploymentId: deployment.deploymentId, actorId: "private-actor" });
  const publication = (await publishWithProof(t, { ...scope, slug: "docs", entryFile: "index.html", pathPrefix: "private-prefix", trackingMode: "track_active", title: "Public docs", description: "private-description", actorId: "private-creator" }))!;
  const grant = (await t.mutation(internal.shareGrants.createInternal, { ...scope, tokenHash: await sha256("synthetic-share-token"), documentPath: "index.html", expiresAt: Date.now() + 600_000, actorId: "private-creator" }))!;
  const publicPublication = { publication: { slug: "docs", entryFile: "index.html", title: "Public docs" } };
  const publicShare = { grant: { documentPath: "index.html", expiresAt: grant.expiresAt }, project: { name: "Docs" } };
  return { t, scope, deployment, publication, grant, publicPublication, publicShare };
}
async function signed(path: string, now = Date.now()) {
  return signResolverRequest(new Request(`https://some.convex.site${path}`), secret, now);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("minimal publication/share resolver responses", () => {
  it("allowlists exact anonymous and Worker shapes even for historical sensitive records", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.deployment.deploymentId, { provenance }));
    for (const [path, expected] of [[pubPath, f.publicPublication], [sharePath, f.publicShare]] as const) {
      const response = await f.t.fetch(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual(expected);
      for (const headers of [await signed(path, Date.now() - 61_000), await signed(path + "changed"), new Headers({ "x-rendro-resolver-signature": "a".repeat(64), "x-rendro-resolver-time": String(Date.now()) })]) {
        expect(await (await f.t.fetch(path, { headers })).json()).toEqual(expected);
      }
    }
    const workerPublication = { publication: { ...f.publicPublication.publication, pathPrefix: "private-prefix" }, deployment: { manifestKey: f.deployment.manifestKey } };
    const workerShare = { ...f.publicShare, deployment: { manifestKey: f.deployment.manifestKey } };
    expect(await f.t.query(internal.publicationsV2.resolvePublicInternal, { slug: "DOCS" })).toEqual(workerPublication);
    expect(await f.t.query(internal.shareGrants.resolveInternal, { tokenHash: f.grant.tokenHash })).toEqual(workerShare);
    expect(await (await f.t.fetch(pubPath, { headers: await signed(pubPath) })).json()).toEqual(workerPublication);
    expect(await (await f.t.fetch(sharePath, { headers: await signed(sharePath) })).json()).toEqual(workerShare);
    const headers = await signed(pubPath);
    vi.stubEnv("CONVEX_INTERNAL_SECRET", "");
    expect(await (await f.t.fetch(pubPath, { headers })).json()).toEqual(f.publicPublication);
  });

  it("accepts a rewritten resolver host but rejects changed paths and capability queries", async () => {
    const f = await fixture();
    for (const path of [pubPath, sharePath]) {
      const headers = await signResolverRequest(new Request(`https://worker-backend.example${path}`), secret);
      const response = await f.t.fetch(path, { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).deployment).toEqual({ manifestKey: f.deployment.manifestKey });
      for (const changed of [path.replace("/public?", "/other?"), path + "changed"]) {
        const wrongHeaders = await signResolverRequest(new Request(`https://worker-backend.example${changed}`), secret);
        expect((await (await f.t.fetch(path, { headers: wrongHeaders })).json()).deployment).toBeUndefined();
      }
    }
  });

  it("keeps anonymous proxy calls public, including caller-supplied proof headers", async () => {
    const f = await fixture();
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => { const u = new URL(input); return f.t.fetch(u.pathname + u.search, init); }));
    for (const [path, expected] of [[pubPath, f.publicPublication], [sharePath, f.publicShare]] as const) {
      const headers = await signed(path);
      headers.set("origin", "https://reader.example");
      headers.set("sec-fetch-site", "cross-site");
      const response = await proxyConvexRequest(new Request(`http://worker.test${path}`, { headers }));
      expect(await response.json()).toEqual(expected);
      const forwarded = new Headers(vi.mocked(fetch).mock.calls.at(-1)![1]?.headers);
      expect(forwarded.get("origin")).toBe("https://reader.example");
      expect(forwarded.get("sec-fetch-site")).toBe("cross-site");
      expect(forwarded.has("x-rendro-resolver-signature")).toBe(false);
      expect(forwarded.has("x-rendro-resolver-time")).toBe(false);
    }
  });

  it("keeps signed resolver GETs readable with forwarded cross-site headers", async () => {
    const f = await fixture();
    for (const path of [pubPath, sharePath]) {
      const headers = await signed(path);
      headers.set("origin", "https://reader.example");
      headers.set("sec-fetch-site", "cross-site");
      headers.set("cookie", "synthetic-cookie=value");
      const response = await f.t.fetch(path, { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).deployment).toEqual({ manifestKey: f.deployment.manifestKey });
    }
  });

  it("renders shells, trees and files through the actual signed resolver contract", async () => {
    const f = await fixture();
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => { const u = new URL(input); return f.t.fetch(u.pathname + u.search, init); }));
    vi.spyOn(storage, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1, files: [{ path: "private-prefix/index.html", sha256: "sha", size: 1, contentType: "text/html" }] }));
    const stream = vi.spyOn(storage, "getObjectStream").mockImplementation(() => Promise.resolve(new Response("<html><body>Docs</body></html>").body));
    for (const path of ["/p/docs", "/p/docs/tree", "/p/docs/files/index.html"]) {
      const response = await publicRoutes.request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("private-org");
    }
    expect(stream).toHaveBeenCalledWith(f.deployment.manifestKey.replace("manifest.json", "files/private-prefix/index.html"));
    for (const path of ["/s/synthetic-share-token", "/s/synthetic-share-token/files/index.html"]) {
      const response = await shareRoutes.request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("private-org");
    }
    expect(stream).toHaveBeenCalledWith(f.deployment.manifestKey.replace("manifest.json", "files/index.html"));
  });

  it("fails closed before storage when the backend returns only presentation metadata", async () => {
    const f = await fixture();
    const read = vi.spyOn(storage, "getObjectText");
    const stream = vi.spyOn(storage, "getObjectStream");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json(f.publicPublication))));
    expect((await publicRoutes.request("/p/docs")).status).toBe(503);
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(Response.json(f.publicShare)));
    expect((await shareRoutes.request("/s/synthetic-share-token/files/index.html")).status).toBe(503);
    expect(read).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("rejects absent, expired, revoked and unavailable resolutions", async () => {
    const f = await fixture();
    for (const path of ["/api/rendro/publications/public", "/api/rendro/shares/public"]) expect((await f.t.fetch(path)).status).toBe(400);
    for (const path of [pubPath + "missing", sharePath + "missing"]) expect((await f.t.fetch(path)).status).toBe(404);
    for (const status of ["failed", "staging"] as const) {
      await f.t.run(ctx => ctx.db.patch(f.deployment.deploymentId, { status }));
      for (const path of [pubPath, sharePath]) expect((await f.t.fetch(path, { headers: await signed(path) })).status).toBe(404);
    }
    await f.t.run(ctx => ctx.db.patch(f.deployment.deploymentId, { status: "active" }));
    await f.t.run(ctx => ctx.db.patch(f.grant._id, { expiresAt: 1 }));
    expect((await f.t.fetch(sharePath)).status).toBe(404);
    await f.t.run(ctx => ctx.db.patch(f.grant._id, { expiresAt: Date.now() + 60_000, revokedAt: 1 }));
    expect((await f.t.fetch(sharePath)).status).toBe(404);
    await f.t.run(ctx => ctx.db.patch(f.scope.projectId, { activeDeploymentId: undefined }));
    expect((await f.t.fetch(pubPath)).status).toBe(404);
    await f.t.run(ctx => ctx.db.patch(f.publication._id, { trackingMode: "pinned", pinnedDeploymentId: f.deployment.deploymentId, title: undefined }));
    expect(await (await f.t.fetch(pubPath)).json()).toEqual({ publication: { ...f.publicPublication.publication, title: "Docs" } });
    await f.t.run(ctx => ctx.db.delete(f.scope.projectId));
    expect((await f.t.fetch(pubPath)).status).toBe(404);
    await f.t.run(ctx => ctx.db.patch(f.grant._id, { revokedAt: undefined }));
    expect((await f.t.fetch(sharePath)).status).toBe(404);
  });

  it("revokes a grant idempotently and refuses a foreign grant", async () => {
    const f = await fixture();
    const input = { organizationId: f.scope.organizationId, grantId: f.grant._id, actorId: "owner" };
    await expect(f.t.mutation(internal.shareGrants.revokeInternal, { ...input, organizationId: "outsider" })).rejects.toThrow("Share not found");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await f.t.mutation(internal.shareGrants.revokeInternal, input)).toBe(true);
      expect((await f.t.fetch(sharePath)).status).toBe(404);
    }
    await f.t.run(ctx => ctx.db.delete(f.grant._id));
    await expect(f.t.mutation(internal.shareGrants.revokeInternal, input)).rejects.toThrow("Share not found");
  });

  it("fails closed for missing deployments and pinned pointers", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.delete(f.deployment.deploymentId));
    for (const path of [pubPath, sharePath]) expect((await f.t.fetch(path)).status).toBe(404);
    await f.t.run(ctx => ctx.db.patch(f.publication._id, { trackingMode: "pinned", pinnedDeploymentId: undefined }));
    expect((await f.t.fetch(pubPath)).status).toBe(404);
  });

  it("rejects invalid publication and share creation without creating usable capabilities", async () => {
    const f = await fixture();
    const publication = { ...f.scope, slug: "new-docs", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" as const, actorId: "owner" };
    for (const input of [{ ...publication, organizationId: "outsider" }, { ...publication, slug: "INVALID!" }, { ...publication, slug: "docs" }, { ...publication, trackingMode: "pinned" as const }]) {
      await expect(publishWithProof(f.t, input)).rejects.toThrow();
    }
    expect(await f.t.query(internal.publicationsV2.listInternal, { organizationId: f.scope.organizationId })).toHaveLength(1);
    const grant = { ...f.scope, tokenHash: "new-hash", documentPath: "index.html", expiresAt: Date.now() + 60_000, actorId: "owner" };
    for (const input of [{ ...grant, organizationId: "outsider" }, { ...grant, documentPath: "../private.html" }, { ...grant, expiresAt: 0 }]) {
      await expect(f.t.mutation(internal.shareGrants.createInternal, input)).rejects.toThrow();
    }
    expect(await f.t.query(internal.shareGrants.resolveInternal, { tokenHash: "new-hash" })).toBeNull();
  });

  it("rejects invalid deployment transitions while keeping authorized history useful", async () => {
    const f = await fixture();
    const input = { ...f.scope, manifestSha256: "sha", fileCount: -1, byteCount: 0, provenance, actorId: "owner" };
    await expect(f.t.mutation(internal.deployments.startInternal, input)).rejects.toThrow("non-negative");
    const commit = { ...f.scope, deploymentId: f.deployment.deploymentId, actorId: "owner" };
    await expect(commitWithProof(f.t, { ...commit, organizationId: "outsider" })).rejects.toThrow("Project not found");
    await expect(commitWithProof(f.t, commit)).rejects.toThrow("staging");
    const sibling = (await f.t.mutation(internal.projects.createInternal, { organizationId: f.scope.organizationId, name: "Sibling", slug: "sibling", actorId: "owner" }))!;
    await expect(commitWithProof(f.t, { ...commit, projectId: sibling._id })).rejects.toThrow("Deployment not found");
    const next = await f.t.mutation(internal.deployments.startInternal, { ...input, fileCount: 0 });
    await f.t.run(ctx => ctx.db.patch(f.deployment.deploymentId, { status: "superseded" }));
    expect(await commitWithProof(f.t, { ...commit, deploymentId: next.deploymentId })).toHaveProperty("deploymentId", next.deploymentId);
    await f.t.run(ctx => ctx.db.delete(f.scope.projectId));
    expect(await f.t.query(internal.deployments.latestForOrganization, { organizationId: f.scope.organizationId })).toBeNull();
  });

  it("validates provenance shape and caps persisted strings at the mutation boundary", async () => {
    const f = await fixture();
    const input = { ...f.scope, manifestSha256: "sha", fileCount: 0, byteCount: 0, provenance, actorId: "owner" };
    await expect(f.t.mutation(internal.deployments.startInternal, { ...input, provenance: { ...provenance, source: { ...provenance.source, repository: 123 as unknown as string } } })).rejects.toThrow();
    const long = { ...provenance, source: { ...provenance.source, ref: "x".repeat(5000) } };
    const result = await f.t.mutation(internal.deployments.startInternal, { ...input, provenance: long });
    expect((await f.t.run(ctx => ctx.db.get(result.deploymentId)))?.provenance.source.ref).toBe("x".repeat(256));
    await f.t.run(ctx => ctx.db.patch(f.deployment.deploymentId, { provenance: { ...provenance, source: { ...provenance.source, commit: "https://user:synthetic-token@git.example/commit" } } }));
    expect((await f.t.query(internal.deployments.latestForOrganization, { organizationId: f.scope.organizationId }))?.commit).toBe("https://git.example/commit");
  });

  it.each(gitRemoteCases.concat([[provenance.source.repository, "https://git.example/private/repo.git"]]))("sanitizes remote %j before storage and on authorized historical reads", async (repository, expectedRepository) => {
    const input = { ...provenance, source: { ...provenance.source, repository } };
    const f = await fixture(input);
    const expected = sanitizeProvenance(input);
    expect(expected.source.repository).toBe(expectedRepository);
    expect((await f.t.run(ctx => ctx.db.get(f.deployment.deploymentId)))?.provenance).toEqual(expected);
    await f.t.run(ctx => ctx.db.patch(f.deployment.deploymentId, { provenance: input }));
    await f.t.mutation(internal.apiKeyCredentials.createInternal, { ...f.scope, keyId: "read-key", keyPrefix: "test", name: "Test", secretHash: await sha256("read-secret"), scopes: ["docs:read"], actorId: "owner" });
    const headers = { authorization: "Bearer read-secret" };
    const query = new URLSearchParams(f.scope);
    for (const path of ["/api/rendro/deployments", "/api/rendro/deployments/active"]) {
      const response = await f.t.fetch(`${path}?${query}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      const deployment = body.deployment ?? body.deployments[0];
      expect(deployment.provenance).toEqual(expected);
      expect(JSON.stringify(body)).not.toMatch(/synthetic-token|synthetic-query|synthetic-fragment|private-user/);
      expect(deployment.provenance.source.commit).toBe("commit-abc123");
      expect(deployment.provenance.execution.runId).toBe("123");
    }
    expect(await f.t.query(internal.deployments.getInternal, { ...f.scope, organizationId: "outsider", deploymentId: f.deployment.deploymentId })).toBeNull();
    await expect(f.t.query(internal.deployments.listInternal, { ...f.scope, organizationId: "outsider" })).rejects.toThrow("Project not found");
  });
});
