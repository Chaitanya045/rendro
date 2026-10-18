import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const objects = new Map<string, string | Uint8Array>();
  const reads: string[] = [];
  const writes: string[] = [];
  const text = (value: string | Uint8Array) => typeof value === "string" ? value : new TextDecoder().decode(value);
  return {
    objects, reads, writes,
    failWrite: undefined as ((key: string) => boolean) | undefined,
    getObjectText: (key: string) => {
      reads.push(key);
      const value = objects.get(key);
      return Promise.resolve(value === undefined ? null : text(value));
    },
    getObjectStream: (key: string) => {
      const value = objects.get(key);
      return Promise.resolve(value === undefined ? null : new Response(text(value)).body);
    },
    putObject: async (key: string, body: string | Uint8Array) => {
      await Promise.resolve();
      if (storage.failWrite?.(key)) throw new Error("storage failed");
      writes.push(key);
      objects.set(key, body);
    },
    headObject: (key: string) => Promise.resolve(objects.has(key) ? { size: 1, metadata: { sha256: SHA_OF_X } } : null),
    copyObject: (source: string, destination: string) => { objects.set(destination, objects.get(source)!); return Promise.resolve(); },
    listAllKeys: (prefix: string) => Promise.resolve([...objects.keys()].filter(key => key.startsWith(prefix))),
  };
});
const SHA_OF_X = vi.hoisted(() => "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
vi.mock("../src/storage", () => storage);

import deployments from "../src/routes/deployments";
import projectDocs from "../src/routes/project-docs";
import publicRoutes from "../src/routes/public-v2";
import shareRoutes from "../src/routes/share-v2";
import { deploymentIndexObjects } from "../src/deployment-index";
import { deploymentMetadataCache } from "../src/immutable-cache";
import type { DeploymentManifest, ManifestFile } from "../src/stored-manifest";

const ROOT = "tenants/org/projects/project/deployments/deployment";
const MANIFEST_KEY = `${ROOT}/manifest.json`;
const DOCS = "/organizations/org/projects/project/docs";
const SCOPE = "?organizationId=org&projectId=project";
const state = { pathPrefix: "", entryFile: "index.html", grantPath: "index.html", assetPaths: [] as string[] | undefined };

function file(path: string, contentType = "text/html"): ManifestFile {
  return { path, sha256: SHA_OF_X, size: 1, contentType };
}

function manifestOf(files: ManifestFile[]): DeploymentManifest {
  return { version: 1, files: [...files].sort((left, right) => left.path < right.path ? -1 : 1) };
}

async function store(manifest: DeploymentManifest, withIndex = true): Promise<void> {
  storage.objects.set(MANIFEST_KEY, JSON.stringify(manifest));
  for (const entry of manifest.files) storage.objects.set(`${ROOT}/files/${entry.path}`, "x");
  if (!withIndex) return;
  const index = await deploymentIndexObjects(MANIFEST_KEY, manifest, "b".repeat(64));
  for (const shard of index!.shards) storage.objects.set(shard.key, shard.body);
  storage.objects.set(index!.root.key, index!.root.body);
}

function fresh(): void {
  deploymentMetadataCache.clear();
  storage.reads.length = 0;
}

const docsApp = new Hono<{ Variables: { user?: User } }>();
docsApp.use("*", async (c, next) => { c.set("user", { id: "user", name: "Reader", email: "reader@rendro.invalid" } as User); await next(); });
docsApp.route("/", projectDocs);
const cookie = { headers: { Cookie: "__Secure-better-auth.session_token=session" } };

beforeEach(() => {
  storage.objects.clear();
  storage.reads.length = 0;
  storage.writes.length = 0;
  storage.failWrite = undefined;
  Object.assign(state, { pathPrefix: "", entryFile: "index.html", grantPath: "index.html", assetPaths: [] });
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => Promise.resolve(backend(input, init))));
});
function backend(input: string, init?: RequestInit): Response {
  const url = new URL(input);
  const staging = { manifestKey: MANIFEST_KEY, stagingExpiresAt: Date.now() + 3_600_000, previousDeploymentId: "previous" };
  switch (url.pathname) {
    case "/api/rendro/deployments/active": return Response.json({ project: { name: "Docs" }, deployment: { manifestKey: MANIFEST_KEY } });
    case "/api/rendro/deployments/staging": return Response.json({ deployment: staging });
    case "/api/rendro/deployments/start": return Response.json({ deployment: { ...staging, deploymentId: "deployment", objectRoot: ROOT, treeIndexKey: `${ROOT}/tree-index.json` } });
    case "/api/rendro/deployments/fail": return Response.json({ failed: (JSON.parse(init!.body as string) as { reason: string }).reason });
    case "/api/rendro/publications/public": return Response.json({ publication: { slug: "docs", entryFile: state.entryFile, title: "Docs", pathPrefix: state.pathPrefix }, deployment: { manifestKey: MANIFEST_KEY } });
    case "/api/rendro/shares/public": return Response.json({ grant: { documentPath: state.grantPath, expiresAt: Date.now() + 60_000, assetPaths: state.assetPaths }, project: { name: "Docs" }, deployment: { manifestKey: MANIFEST_KEY } });
  }
  return new Response("Not found", { status: 404 });
}
afterEach(() => vi.unstubAllGlobals());

function startBody(manifest: DeploymentManifest): RequestInit {
  return {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: "org", projectId: "project", manifest, manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") }),
  };
}

describe("deployment start writes an immutable index", () => {
  it("writes every shard before the root, next to the manifest", async () => {
    const manifest = manifestOf(Array.from({ length: 300 }, (_, index) => file(`page-${index}.html`)));
    const response = await deployments.request("/api/rendro/deployments/start", startBody(manifest));
    expect(response.status).toBe(201);
    expect(storage.writes.slice(0, -1).sort()).toEqual([
      `${ROOT}/index/v1/files/0.json`, `${ROOT}/index/v1/files/1.json`,
      `${ROOT}/index/v1/tree/0.json`, `${ROOT}/index/v1/tree/1.json`, MANIFEST_KEY, `${ROOT}/tree-index.json`,
    ]);
    expect(storage.writes.at(-1)).toBe(`${ROOT}/index/v1/root.json`);
    expect(JSON.parse(storage.objects.get(`${ROOT}/index/v1/root.json`) as string)).toMatchObject({
      version: 1, manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), fileCount: 300, shards: 2,
    });
  });

  it("inlines a small deployment's index in its root", async () => {
    expect((await deployments.request("/api/rendro/deployments/start", startBody(manifestOf([file("index.html")])))).status).toBe(201);
    expect(storage.writes.at(-1)).toBe(`${ROOT}/index/v1/root.json`);
    expect(storage.writes.filter(key => key.includes("/index/"))).toHaveLength(1);
  });

  it("never writes a root when a shard write fails, and fails the deployment", async () => {
    storage.failWrite = key => key.endsWith("/files/1.json");
    const manifest = manifestOf(Array.from({ length: 300 }, (_, index) => file(`page-${index}.html`)));
    const response = await deployments.request("/api/rendro/deployments/start", startBody(manifest));
    expect(response.status).toBe(502);
    expect(storage.objects.has(`${ROOT}/index/v1/root.json`)).toBe(false);
    const failure = vi.mocked(fetch).mock.calls.find(([url]) => (url as string).endsWith("/deployments/fail"));
    expect(JSON.parse(failure![1]!.body as string)).toMatchObject({ deploymentId: "deployment", reason: "storage failed" });
  });
});

describe("staging uploads and copies read one shard", () => {
  const manifest = manifestOf(Array.from({ length: 1_000 }, (_, index) => file(`dir-${index % 7}/page-${String(index).padStart(4, "0")}.html`)));

  it("validates an upload against its shard without downloading the manifest", async () => {
    await store(manifest);
    storage.objects.delete(`${ROOT}/files/dir-0/page-0000.html`);
    const upload = await deployments.request(`/api/rendro/deployments/deployment/files/dir-0/page-0000.html${SCOPE}`, { method: "PUT", body: "x", headers: { "Content-Length": "1" } });
    expect(upload.status).toBe(200);
    expect(storage.reads).toEqual([`${ROOT}/index/v1/root.json`, expect.stringMatching(/index\/v1\/files\/[0-3]\.json$/)]);
    for (const path of ["dir-0/unknown.html", "dir-0%2Fpage-0000.html", "dir-0/..%2Fdir-1%2Fpage-0001.html"]) {
      const response = await deployments.request(`/api/rendro/deployments/deployment/files/${path}${SCOPE}`, { method: "PUT", body: "x" });
      expect(response.status).toBe(400);
    }
    expect(storage.reads.includes(MANIFEST_KEY)).toBe(false);
  });

  it("copies a full batch reading at most the root and four shards", async () => {
    await store(manifest);
    const paths = manifest.files.slice(0, 16).map(entry => entry.path);
    for (const path of paths) storage.objects.set(`tenants/org/projects/project/deployments/previous/files/${path}`, "x");
    const response = await deployments.request(`/api/rendro/deployments/deployment/copy${SCOPE}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths }),
    });
    expect(response.status).toBe(200);
    expect(storage.reads.length).toBeLessThanOrEqual(5);
    expect(storage.reads.includes(MANIFEST_KEY)).toBe(false);
  });

  it("keeps validating deployments started before the index from their manifest", async () => {
    await store(manifest, false);
    const upload = await deployments.request(`/api/rendro/deployments/deployment/files/dir-0/page-0000.html${SCOPE}`, { method: "PUT", body: "x" });
    expect(upload.status).toBe(200);
    expect(storage.reads).toEqual([`${ROOT}/index/v1/root.json`, MANIFEST_KEY]);
  });
});

describe("scoped tree directory pages", () => {
  const manifest = manifestOf([
    file("index.html"), file("guide/intro.html"), file("guide/deep/leaf.html"), file("guide/style.css", "text/css"),
    file("assets/app.js", "text/javascript"), ...Array.from({ length: 201 }, (_, index) => file(`flat/${String(index).padStart(3, "0")}.html`)),
  ]);

  it("serves the root and each expanded folder as cursor pages", async () => {
    await store(manifest);
    expect(await (await docsApp.request(`${DOCS}/tree?dir=`, cookie)).json()).toEqual({
      children: [{ name: "flat", type: "folder" }, { name: "guide", type: "folder" }, { name: "index.html", type: "file" }], cursor: null,
    });
    expect(await (await docsApp.request(`${DOCS}/tree?dir=guide/`, cookie)).json()).toEqual({
      children: [{ name: "deep", type: "folder" }, { name: "intro.html", type: "file" }], cursor: null,
    });
    const first = await (await docsApp.request(`${DOCS}/tree?dir=flat/`, cookie)).json() as { children: unknown[]; cursor: string };
    expect(first.children).toHaveLength(200);
    expect(first.cursor).toBe("1");
    expect(await (await docsApp.request(`${DOCS}/tree?dir=flat/&cursor=1`, cookie)).json()).toEqual({ children: [{ name: "200.html", type: "file" }], cursor: null });
    expect(await (await docsApp.request(`${DOCS}/tree?dir=missing/`, cookie)).json()).toEqual({ children: [], cursor: null });
    expect(await (await docsApp.request(`${DOCS}/tree?dir=flat/&cursor=7`, cookie)).json()).toEqual({ children: [], cursor: null });
  });

  it("rejects traversal, separators and malformed cursors before reading storage", async () => {
    await store(manifest);
    storage.reads.length = 0;
    for (const query of ["dir=..%2F", "dir=guide", "dir=%2F", "dir=guide%2F%2F", "dir=guide%2F..%2F", "dir=.%2F", "dir=a%5Cb%2F", "dir=%00%2F",
      "dir=&cursor=-1", "dir=&cursor=01", "dir=&cursor=x", "dir=&cursor=1e3", "dir=&cursor=", "dir=&cursor=1234567890"]) {
      const response = await docsApp.request(`${DOCS}/tree?${query}`, cookie);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid tree page" });
    }
    expect(storage.reads).toEqual([]);
  });

  it("keeps the legacy document list for clients that predate directory pages", async () => {
    await store(manifest);
    const page = await (await docsApp.request(`${DOCS}/tree`, cookie)).json() as { documents: string[]; cursor: string };
    expect(page.documents[0]).toBe("flat/000.html");
    expect(page.cursor).toBe("200");
    expect(await (await docsApp.request(`${DOCS}/tree?cursor=200`, cookie)).json()).toEqual({
      documents: ["flat/200.html", "guide/deep/leaf.html", "guide/intro.html", "index.html"], cursor: null,
    });
  });

  it("returns a retryable 503 when neither an index nor a manifest exists for an authorized deployment", async () => {
    expect((await docsApp.request(`${DOCS}/tree?dir=`, cookie)).status).toBe(503);
    expect((await docsApp.request(`${DOCS}/tree`, cookie)).status).toBe(503);
  });

  it("selects index.html, else the first document, and serves assets from the index", async () => {
    await store(manifest);
    fresh();
    const shell = await docsApp.request(DOCS, cookie);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("index.html");
    expect(storage.reads.includes(MANIFEST_KEY)).toBe(false);
    expect((await docsApp.request(`${DOCS}?doc=guide/style.css`, cookie)).status).toBe(404);
    expect((await docsApp.request(`${DOCS}?doc=guide/missing.html`, cookie)).status).toBe(404);
    expect((await docsApp.request(`${DOCS}/files/guide/style.css`, cookie)).status).toBe(200);
    for (const path of ["guide/missing.css", "guide%2Fstyle.css", "guide/..%2Findex.html"]) expect((await docsApp.request(`${DOCS}/files/${path}`, cookie)).status).toBe(404);
    storage.objects.clear();
    fresh();
    await store(manifestOf([file("b/z.html"), file("a.css", "text/css"), file("b/a.html")]));
    expect(await (await docsApp.request(DOCS, cookie)).text()).toContain("b/a.html");
    storage.objects.clear();
    fresh();
    await store(manifestOf([file("a.css", "text/css")]));
    expect((await docsApp.request(DOCS, cookie)).status).toBe(404);
    // A deployment the database vouches for but whose manifest is gone is "could not check", not "no document".
    storage.objects.clear();
    fresh();
    const unreadable = await docsApp.request(DOCS, cookie);
    expect([unreadable.status, unreadable.headers.get("Retry-After"), unreadable.headers.get("Cache-Control")]).toEqual([503, "1", "private, no-store"]);
  });
});

describe("publication and share delivery", () => {
  const manifest = manifestOf([file("index.html"), file("guide/index.html"), file("guide/next/page.html"), file("guide/app.css", "text/css"), file("private.html")]);

  it("scopes publication directory pages to the publication prefix", async () => {
    await store(manifest);
    state.pathPrefix = "guide";
    const root = await publicRoutes.request("/p/docs/tree?dir=");
    expect(root.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(await root.json()).toEqual({ children: [{ name: "next", type: "folder" }, { name: "index.html", type: "file" }], cursor: null });
    expect(await (await publicRoutes.request("/p/docs/tree?dir=next/")).json()).toEqual({ children: [{ name: "page.html", type: "file" }], cursor: null });
    expect(await (await publicRoutes.request("/p/docs/tree?dir=missing/")).json()).toEqual({ children: [], cursor: null });
    for (const query of ["dir=..%2F", "dir=%2F", "dir=next", "dir=&cursor=-1"]) expect((await publicRoutes.request(`/p/docs/tree?${query}`)).status).toBe(400);
    expect(await (await publicRoutes.request("/p/docs/tree")).json()).toEqual({ documents: ["index.html", "next/page.html"], cursor: null, total: 2 });
    expect((await publicRoutes.request("/p/docs?doc=next/page.html")).status).toBe(200);
    expect((await publicRoutes.request("/p/docs?doc=app.css")).status).toBe(404);
    expect((await publicRoutes.request("/p/docs/files/app.css")).status).toBe(200);
    expect((await publicRoutes.request("/p/docs/files/..%2Fprivate.html")).status).toBe(404);
    expect((await publicRoutes.request("/p/docs/files/missing.css")).status).toBe(404);
    state.entryFile = "missing.html";
    expect((await publicRoutes.request("/p/docs")).status).toBe(404);
  });

  it("pages large publication directories with cursors", async () => {
    await store(manifestOf(Array.from({ length: 201 }, (_, index) => file(`${String(index).padStart(3, "0")}.html`))));
    const first = await (await publicRoutes.request("/p/docs/tree?dir=")).json() as { children: unknown[]; cursor: string };
    expect([first.children.length, first.cursor]).toEqual([200, "1"]);
    expect(await (await publicRoutes.request("/p/docs/tree?dir=&cursor=1")).json()).toEqual({ children: [{ name: "200.html", type: "file" }], cursor: null });
  });

  it("returns a retryable 503, not a 404, for publication trees and shells without metadata", async () => {
    for (const path of ["/p/docs/tree?dir=", "/p/docs/tree", "/p/docs", "/p/docs/files/index.html"]) {
      const response = await publicRoutes.request(path);
      expect([path, response.status, response.headers.get("Retry-After"), response.headers.get("Cache-Control")]).toEqual([path, 503, "1", "private, no-store"]);
    }
  });

  it("keeps share grants authoritative over index contents", async () => {
    await store(manifest);
    expect((await shareRoutes.request("/s/token/files/index.html")).status).toBe(200);
    expect((await shareRoutes.request("/s/token/files/private.html")).status).toBe(404);
    expect((await shareRoutes.request("/s/token/files/guide/app.css")).status).toBe(404);
    state.assetPaths = ["guide/app.css"];
    expect((await shareRoutes.request("/s/token/files/guide/app.css")).status).toBe(200);
    expect((await shareRoutes.request("/s/token/files/guide/missing.css")).status).toBe(404);
  });
});
