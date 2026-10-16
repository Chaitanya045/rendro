import { afterEach, describe, expect, it, vi } from "vitest";
import { shareCreationFixture as fixture } from "./helpers/share-creation";
import type { Doc } from "../convex/_generated/dataModel";
import { admissionHeaders } from "./helpers/cookie-write-fixture";
import { shareProof } from "./helpers/storage-proof";
import { internal } from "../convex/_generated/api";
import { signStorageValidation, STORAGE_ATTESTATION_HEADER } from "../shared/storage-attestation";

import { MAX_HTTP_BODY_BYTES } from "../shared/deployment-limits";
import { MAX_SHARE_ASSET_BYTES, MAX_SHARE_ASSET_PATHS, MAX_SHARE_METADATA_BYTES, SHARE_ASSET_JSON_OVERHEAD, validShareAssets } from "../shared/share-assets";

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const path = "/api/rendro/shares";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("share creation authority", () => {
  it("persists discovered assets, replaces caller lists/proofs, and returns no secret list anonymously", async () => {
    const f = await fixture();
    const response = await f.request({ ...f.body, assetPaths: ["guide/private.json"] }, admissionHeaders({ cookie: f.cookie, [STORAGE_ATTESTATION_HEADER]: "forged", "user-agent": "test", "sec-fetch-site": "same-origin" }));
    expect(response.status).toBe(201);
    const result = await response.json() as { grant: Doc<"shareGrants">; token: string };
    const assetPaths = ["guide/font", "guide/image", "guide/script", "guide/style.css"];
    expect(result.grant.assetPaths).toEqual(assetPaths);
    expect(result.grant.deploymentId).toBe(f.record._id);
    const resolved = await f.backend.query(internal.shareGrants.resolveInternal, { tokenHash: result.grant.tokenHash });
    expect(resolved?.grant.assetPaths).toEqual(assetPaths);
    const anonymous = await (await f.backend.fetch(`/api/rendro/shares/public?token=${result.token}`)).json();
    expect(anonymous.grant).toEqual({ documentPath: f.body.documentPath, expiresAt: result.grant.expiresAt });
    expect(JSON.stringify(anonymous)).not.toContain("assetPaths");
    expect(f.read).toHaveBeenCalledTimes(2);
    await f.backend.run(ctx => ctx.db.patch(result.grant._id, { assetPaths: undefined }));
    expect((await f.backend.query(internal.shareGrants.resolveInternal, { tokenHash: result.grant.tokenHash }))?.grant)
      .toEqual({ documentPath: f.body.documentPath, expiresAt: result.grant.expiresAt });
  });

  it.each([0, 1])("enforces the asset byte boundary through Worker and Convex (+%i byte)", async extraByte => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const f = await fixture();
    // Include multibyte and JSON-escaped characters in both budgets, and a
    // maximum-length manifest document path.
    const metadata = { ...f.body, documentPath: 'guide/é"index.html' };
    metadata.documentPath += "界".repeat(1024 - metadata.documentPath.length);
    expect(jsonBytes(metadata)).toBeLessThan(MAX_SHARE_METADATA_BYTES);
    const assets = Array.from({ length: MAX_SHARE_ASSET_PATHS }, (_, i) => `guide/${i}-` + (i === 0 ? 'é"' : ""));
    const padding = MAX_SHARE_ASSET_BYTES + extraByte - jsonBytes(assets);
    for (let i = 0; i < assets.length; i++) assets[i] += "x".repeat(Math.floor(padding / assets.length) + (i < padding % assets.length ? 1 : 0));
    expect(jsonBytes(assets)).toBe(MAX_SHARE_ASSET_BYTES + extraByte);
    expect(validShareAssets(assets)).toBe(extraByte === 0);
    expect(MAX_SHARE_ASSET_BYTES + MAX_SHARE_METADATA_BYTES + SHARE_ASSET_JSON_OVERHEAD).toBeLessThanOrEqual(MAX_HTTP_BODY_BYTES);
    const maxMetadata = { ...metadata, documentPath: metadata.documentPath + "x".repeat(MAX_SHARE_METADATA_BYTES - jsonBytes(metadata)) };
    expect(jsonBytes(maxMetadata)).toBe(MAX_SHARE_METADATA_BYTES);
    expect(jsonBytes({ ...maxMetadata, assetPaths: assets })).toBe(MAX_HTTP_BODY_BYTES + extraByte);
    const before = await f.backend.run(ctx => ctx.db.query("shareGrants").collect());
    f.manifest.mockResolvedValue(JSON.stringify({ files: [
      { path: metadata.documentPath, contentType: "text/html" },
      ...assets.map(path => ({ path, contentType: "image/png" })),
    ] }));
    const html = '<img srcset="' + assets.map(path => '/' + path.split('/').map(encodeURIComponent).join('/')).join(', ') + '">';
    f.read.mockImplementation(() => Promise.resolve(new Response(html).body));
    // Unsupported fields and caller allowlists cannot enlarge the forwarded body.
    const response = await f.request({ ...metadata, ignored: "x".repeat(1000), assetPaths: ["guide/private.json"] });
    expect(response.status).toBe(extraByte ? 400 : 201);
    const grants = await f.backend.run(ctx => ctx.db.query("shareGrants").collect());
    if (extraByte) {
      expect(await response.json()).toEqual({ error: "document references too many assets to share", code: "share_limit", reason: "assets" });
      expect(f.fetchMock).toHaveBeenCalledTimes(1); // Authorization only; no oversized POST.
      expect(grants).toEqual(before);
    } else {
      const { grant } = await response.json() as { grant: Doc<"shareGrants"> };
      expect(grant.assetPaths).toEqual(assets.sort());
      expect(grants).toEqual([...before, grant]);
      const forwarded = f.fetchMock.mock.calls.find(([url]) => new URL(url).pathname === path)![1]!.body as string;
      expect(new TextEncoder().encode(forwarded).byteLength).toBe(jsonBytes(metadata) + SHARE_ASSET_JSON_OVERHEAD + MAX_SHARE_ASSET_BYTES);
      expect(new TextEncoder().encode(forwarded).byteLength).toBeLessThanOrEqual(MAX_HTTP_BODY_BYTES);
      expect(JSON.parse(forwarded)).toEqual({ ...metadata, assetPaths: assets });
    }
    f.fetchMock.mockClear();
    f.manifest.mockClear();
    // Metadata at its byte cap reaches authorization; one more byte is rejected
    // before backend/storage access, independently of authentication.
    f.fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await f.request(maxMetadata)).status).toBe(403);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    f.fetchMock.mockClear();
    const oversizedMetadata = await f.request({ ...maxMetadata, documentPath: maxMetadata.documentPath + "x" });
    expect(oversizedMetadata.status).toBe(400);
    expect(await oversizedMetadata.json()).toEqual({ error: "Share metadata exceeds the size limit" });
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.manifest).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated creation before storage and does not accept API keys as share authority", async () => {
    const f = await fixture();
    expect((await f.request(f.body, admissionHeaders({ authorization: "Bearer valid-key" }))).status).toBe(403);
    expect(f.manifest).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it("requires a valid proof at Convex and binds document, assets, and active deployment", async () => {
    const f = await fixture();
    const input = { ...f.body, tokenHash: "fresh", expiresAt: Date.now() + 600_000, actorId: f.user._id, assetPaths: ["guide/image"] };
    const { expiresInSeconds: _expires, ...args } = input;
    const proof = await shareProof(f.backend, args);
    for (const change of [{ attestation: undefined }, { attestation: "forged" }, { attestation: proof, documentPath: "other.html" }, { attestation: proof, assetPaths: ["guide/private.json"] }, { attestation: proof, assetPaths: ["../bad"] }]) {
      await expect(f.backend.mutation(internal.shareGrants.createInternal, { ...args, ...change })).rejects.toThrow("validation is required");
    }
    for (const assetPaths of [undefined, 1, [1], ["../bad"], Array(501).fill("a")]) {
      const response = await f.backend.fetch(path, { method: "POST", headers: admissionHeaders({ cookie: f.cookie }), body: JSON.stringify({ ...f.body, assetPaths }) });
      expect(response.status).toBe(400);
    }
    const direct = await f.backend.fetch(path, { method: "POST", headers: admissionHeaders({ cookie: f.cookie }), body: JSON.stringify({ ...f.body, assetPaths: [] }) });
    expect(direct.status).toBe(403);
    const stale = await signStorageValidation({ purpose: "share-assets", ...f.record, deploymentId: f.record._id, documentPath: args.documentPath, assetPaths: args.assetPaths }, process.env.CONVEX_INTERNAL_SECRET!, Date.now() - 61_000);
    await expect(f.backend.mutation(internal.shareGrants.createInternal, { ...args, attestation: stale })).rejects.toThrow("validation is required");
    const next = await f.backend.run(async ctx => {
      const { _id: _id, _creationTime: _time, ...fields } = f.record;
      const id = await ctx.db.insert("deployments", { ...fields, manifestKey: "next/manifest.json" });
      await ctx.db.patch(f.projectId, { activeDeploymentId: id });
      return id;
    });
    await expect(f.backend.mutation(internal.shareGrants.createInternal, { ...args, attestation: proof })).rejects.toThrow("validation is required");
    await f.backend.run(ctx => ctx.db.patch(f.projectId, { activeDeploymentId: f.record._id }));
    for (const patch of [{ status: "staging" as const }, { status: "failed" as const }, { organizationId: "foreign" }, { projectId: await f.backend.run(ctx => ctx.db.insert("projects", { organizationId: f.organizationId, name: "Other", slug: "other", createdBy: "test", createdAt: 1 })) }]) {
      await f.backend.run(ctx => ctx.db.patch(f.record._id, patch));
      await expect(f.backend.mutation(internal.shareGrants.createInternal, { ...args, attestation: proof })).rejects.toThrow("Project has no active deployment");
      await f.backend.run(ctx => ctx.db.patch(f.record._id, { status: "active", organizationId: f.organizationId, projectId: f.projectId }));
    }
    await f.backend.run(ctx => ctx.db.delete(f.record._id));
    await expect(f.backend.mutation(internal.shareGrants.createInternal, { ...args, attestation: proof })).rejects.toThrow("Project has no active deployment");
    expect(next).toBeTruthy();
  });

  it("fails creation when active deployment changes between inspection and persistence", async () => {
    const f = await fixture();
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (url, init) => {
      if (new URL(url).pathname === path) await f.backend.run(ctx => ctx.db.patch(f.projectId, { activeDeploymentId: undefined }));
      return original(url, init);
    });
    expect((await f.request()).status).toBe(403);
  });

  it("rejects malformed inputs and unavailable deployments/manifests", async () => {
    const f = await fixture();
    expect((await f.app.request(path, { method: "POST", body: "{" })).status).toBe(400);
    for (const body of [null, false, {}, { organizationId: "org" }, { organizationId: "org", projectId: "p" }, { ...f.body, documentPath: "../bad" }]) expect((await f.request(body)).status).toBe(400);
    for (const expiresInSeconds of [undefined, null, "600", 59, 60 * 60 * 24 * 30 + 1]) {
      expect((await f.request({ ...f.body, expiresInSeconds })).status).toBe(400);
    }
    expect((await f.app.request(path, { method: "POST", body: JSON.stringify(f.body).replace('"expiresInSeconds":600', '"expiresInSeconds":1e309') })).status).toBe(400);
    for (const deployment of [undefined, { ...f.record, status: "failed" }, { ...f.record, status: "staging" }, { ...f.record, manifestKey: "foreign/manifest.json" }]) {
      f.fetchMock.mockImplementation(() => Promise.resolve(Response.json({ deployment })));
      expect((await f.request()).status).toBe(404);
    }
    f.fetchMock.mockImplementation(() => Promise.resolve(Response.json({ deployment: f.record })));
    f.manifest.mockResolvedValue(null);
    expect((await f.request()).status).toBe(404);
  });

  it.each([
    '<img' + Array.from({ length: 40_000 }, (_, i) => ` a${i}`).join("") + '>',
    '<br>'.repeat(50_001),
    '<div>'.repeat(20_000),
    '<template>'.repeat(10_000),
    '<img src=image><style>' + 'a{background:url(image)}'.repeat(15_000) + '</style>',
  ])("rejects excessive HTML complexity without a partial grant (%#)", async html => {
    // These are deterministic size/work counters. A real clock lets a slow or
    // instrumented machine hit the separate CPU deadline first ("share_busy").
    vi.spyOn(performance, "now").mockReturnValue(0);
    const f = await fixture();
    f.read.mockResolvedValue(new Response(html).body);
    const before = await f.backend.run(ctx => ctx.db.query("shareGrants").collect());
    const response = await f.request();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.stringMatching(/^(Share HTML exceeds the |document too complex to share$)/),
      code: "share_limit",
      reason: expect.stringMatching(/^(tags|attributes|work)$/),
    });
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    expect(await f.backend.run(ctx => ctx.db.query("shareGrants").collect())).toEqual(before);
  });

  it("persists a near-cap unique list once despite many duplicate references", async () => {
    // Persistence/allowlist assertion; the separate CPU matrix uses the real clock.
    vi.spyOn(performance, "now").mockReturnValue(0);
    const f = await fixture();
    const assets = Array.from({ length: 500 }, (_, i) => ({
      path: i === 0 ? "guide/a" : `guide/${i}-${"x".repeat(100)}`, contentType: "image/png",
    }));
    f.manifest.mockResolvedValue(JSON.stringify({ files: [{ path: f.body.documentPath, contentType: "text/html" }, ...assets] }));
    const html = '<img srcset="' + assets.map(file => file.path.slice(6) + ', ').join('') + 'a, '.repeat(10_000) + '">';
    f.read.mockResolvedValue(new Response(html).body);
    const response = await f.request();
    expect(response.status).toBe(201);
    const { grant } = await response.json() as { grant: Doc<"shareGrants"> };
    expect(grant.assetPaths).toEqual(assets.map(file => file.path).sort());
    expect(await f.backend.run(ctx => ctx.db.get(grant._id))).toMatchObject({ assetPaths: grant.assetPaths });
  });

  it("fails clearly without persisting when discovery exceeds bounds or sources disappear", async () => {
    const f = await fixture();
    const files = [{ path: f.body.documentPath, contentType: "text/html" }, ...Array.from({ length: 501 }, (_, i) => ({ path: `guide/${i}.png`, contentType: "image/png" }))];
    f.manifest.mockResolvedValue(JSON.stringify({ files }));
    f.read.mockImplementation(() => Promise.resolve(new Response(files.slice(1).map(file => `<img src="/${file.path}">`).join("")).body));
    const response = await f.request();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "document references too many assets to share", code: "share_limit", reason: "assets" });
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    f.read.mockResolvedValue(null);
    const missing = await f.request();
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "share_unavailable", reason: "unavailable" });
    f.read.mockRejectedValue(new Error("Storage unavailable"));
    expect((await f.request()).status).toBe(500);
  });
});
