import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "@/worker";
import docs from "@/routes/docs";
import projectDocs from "@/routes/project-docs";
import * as minio from "@/minio";
import * as deletion from "@/soft-delete";
import * as publications from "@/publications";
import * as boundary from "@/storage-boundary";
import * as tickets from "@/viewer-ticket";
import { createShareToken, verifyShareToken } from "@/share-links";
import { docsBase, mockSecurityBackend, testUser } from "./fixtures/security-headers";

const cookie = "better-auth.session_token=route-boundaries";
const request = (path: string, signedIn = true, init: RequestInit = {}) => worker.request(`https://rendro.test${path}`, {
  ...init, headers: { ...(signedIn ? { Cookie: cookie } : {}), ...init.headers },
});
beforeEach(() => {
  mockSecurityBackend();
  vi.spyOn(deletion, "isDeleted").mockResolvedValue(false);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps legacy share creation gated by identity, scope, deletion and object existence", async () => {
  expect((await request("/api/share/create", false)).status).toBe(401);
  expect((await request("/api/share/create")).status).toBe(400);
  for (const key of ["other/index.html", "example/image.svg"]) {
    expect((await request(`/api/share/create?key=${key}`)).status).toBe(key.startsWith("other/") ? 404 : 403);
  }
  vi.mocked(deletion.isDeleted).mockResolvedValueOnce(true);
  expect((await request("/api/share/create?key=example/index.html")).status).toBe(404);
  vi.mocked(minio.headObject).mockResolvedValueOnce(null);
  expect((await request("/api/share/create?key=example/index.html")).status).toBe(404);
  const result = await request("/api/share/create?key=example/index.html");
  expect(result.status).toBe(200);
  const { url } = await result.json() as { url: string };
  expect(verifyShareToken(new URL(url).pathname.slice("/share/".length))).toMatchObject({ ok: true, key: "example/index.html" });
  vi.mocked(minio.headObject).mockRejectedValueOnce(new Error("storage unavailable"));
  expect((await request("/api/share/create?key=example/index.html")).status).toBe(503);
});

it("denies anonymous and deleted/missing legacy bookmarks", async () => {
  expect((await request("/files/example/index.html", false)).status).toBe(401);
  vi.mocked(deletion.isDeleted).mockResolvedValueOnce(true);
  expect((await request("/files/example/index.html")).status).toBe(404);
  vi.mocked(minio.headObject).mockResolvedValueOnce(null);
  expect((await request("/files/example/index.html")).status).toBe(404);
});

it("retires legacy sync operations before credential or storage work", async () => {
  for (const [path, method] of [["upload", "POST"], ["check", "GET"], ["list", "GET"], ["delete", "DELETE"]]) {
    for (const headers of [{}, { Authorization: "Bearer fixture-key" }] as Array<Record<string, string>>) {
      const response = await request(`/api/sync/${path}`, false, { method, headers });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("rendro@2") });
    }
  }
  expect(minio.getObjectStream).not.toHaveBeenCalled();
});

it("filters deleted tree entries while preserving file and directory metadata and pagination", async () => {
  const now = new Date("2026-01-01");
  vi.spyOn(minio, "listImmediate").mockResolvedValue({ entries: [
    { key: "example/index.html", name: "index.html", size: 7, lastModified: now },
    { key: "example/guide/page.html", name: "page.html", size: 3, lastModified: now },
    { key: "example/deleted.html", name: "deleted.html", size: 1, lastModified: now },
  ], isTruncated: true, nextStartAfter: "example/index.html" });
  vi.mocked(deletion.isDeleted).mockImplementation(key => Promise.resolve(key.endsWith("deleted.html")));
  expect((await request("/api/tree/example?prefix=example/a..b/")).status).toBe(400);
  for (const query of ["", "?limit=2000&startAfter=example/a.html"]) {
    const response = await request(`/api/tree/example${query}`);
    expect(response.status).toBe(200);
    const result = await response.json() as { children: Array<{ name: string }>; isTruncated: boolean; nextStartAfter: string };
    expect(result.children.map(node => node.name).sort()).toEqual(["guide", "index.html"]);
    expect(result).toMatchObject({ isTruncated: true, nextStartAfter: "example/index.html" });
  }
  expect(minio.listImmediate).toHaveBeenLastCalledWith("example/", { maxKeys: 1000, startAfter: "example/a.html" });
});

it("preserves external/out-of-tree bases, rejects malformed bases, and handles absent legacy MIME metadata", async () => {
  vi.mocked(minio.headObject).mockResolvedValue({});
  for (const base of ["https://external.test/", "/elsewhere/", "http://["]) {
    vi.mocked(minio.getObjectStream).mockImplementation(() => Promise.resolve(new Response(`<html><head><base href="${base}"></head><body>fixture</body></html>`).body));
    for (const path of ["/legacy-view/example/files/index.html", `${docsBase}/files/index.html`]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(`<base href="${base}">`);
      expect(body).not.toContain("base data-rendro-viewer");
    }
  }
});

it("rechecks storage boundaries even after earlier route and ticket validation", async () => {
  const modern = vi.spyOn(boundary, "modernStorageKey").mockReturnValueOnce(null);
  expect((await request(`${docsBase}/files/index.html`)).status).toBe(404);
  modern.mockRestore();
  const legacy = vi.spyOn(boundary, "isLegacyStorageKey").mockReturnValueOnce(false);
  expect((await request("/legacy-view/example/files/index.html")).status).toBe(404);
  legacy.mockRestore();
  const token = await tickets.createLegacyViewerTicket("example", cookie);
  const ticket = await tickets.readLegacyViewerTicket(token, "example");
  vi.spyOn(tickets, "readLegacyViewerTicket").mockResolvedValueOnce({ ...ticket!, storagePrefix: "other/" });
  expect((await request(`/legacy-view/example/view/${token}/files/index.html`, false)).status).toBe(404);
  expect(minio.getObjectStream).not.toHaveBeenCalled();
});

it.each([{ user: {} }, { user: { id: "user-a" } }])("fails closed on a malformed ticket session: %j", async session => {
  const token = await tickets.createLegacyViewerTicket("example", cookie);
  vi.mocked(fetch).mockResolvedValue(Response.json(session));
  const response = await request(`/legacy-view/example/view/${token}/files/index.html`, false);
  expect(response.status).toBe(503);
  expect(minio.getObjectStream).not.toHaveBeenCalled();
});

it("handles absent/malformed manifests without granting access to publisher objects", async () => {
  for (const manifest of [null, "not-json", JSON.stringify({ files: [] })]) {
    vi.mocked(minio.getObjectText).mockResolvedValue(manifest);
    for (const base of [docsBase, "/p/product"]) {
      expect((await request(base)).status).toBe(404);
      expect((await request(`${base}/tree`)).status).toBe(manifest?.includes("files") ? 200 : 404);
    }
  }
  expect(minio.getObjectStream).not.toHaveBeenCalled();
});

it("rejects invalid and empty public/private shell document selections", async () => {
  for (const path of ["/p/product?doc=", "/p/product?doc=../outside.html", `${docsBase}?doc=../outside.html`]) {
    expect((await request(path)).status).toBe(404);
  }
  for (const query of ["?doc=another.html", "?docQuery=not-a-query"]) expect((await request(`/s/test${query}`)).status).toBe(query.startsWith("?doc=") ? 404 : 400);
});

it("paginates the authorized private document tree", async () => {
  vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ files: Array.from({ length: 201 }, (_, i) => ({ path: `${i}.html`, contentType: "Text/HTML" })) }));
  const first = await (await request(`${docsBase}/tree`)).json() as { documents: string[]; cursor: string };
  expect(first.documents).toHaveLength(200);
  expect(first.cursor).toBe("200");
  expect(await (await request(`${docsBase}/tree?cursor=200`)).json()).toEqual({ documents: ["200.html"], cursor: null });
});

it("requires an actual session cookie before issuing a private viewer ticket", async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => { c.set("user", testUser); await next(); });
  app.route("/", projectDocs);
  app.route("/", docs);
  expect((await app.request(`${docsBase}/viewer-ticket?manifestKey=anything`)).status).toBe(401);
});

it.each(["invalid", new Date(Date.now() + 30_000).toUTCString()])("normalizes private viewer Retry-After: %s", async value => {
  const backend = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).includes("/deployments/active")
    ? Promise.resolve(new Response(null, { status: 503, headers: { "Retry-After": value } })) : backend(input, init));
  const response = await request(`${docsBase}/files/index.html`);
  expect(response.status).toBe(503);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
});

it("keeps legacy publication and share failures opaque and handles storage stream failures", async () => {
  const expired = createShareToken("example/index.html", Math.floor(Date.now() / 1000) - 8 * 86400);
  expect((await request(`/share/${expired}`, false)).status).toBe(410);
  const share = `/share/${createShareToken("example/index.html")}`;
  vi.mocked(deletion.isDeleted).mockResolvedValueOnce(true);
  expect((await request(share, false)).status).toBe(404);
  vi.mocked(minio.getObjectStream).mockRejectedValue(new Error("storage unavailable"));
  for (const path of [share, "/public/example/product/files/index.html"]) expect((await request(path, false)).status).toBe(503);
  for (const query of ["?doc=unknown.html", "?doc=image.svg"]) expect((await request(`/public/example/product${query}`, false)).status).toBe(404);
  expect((await request("/public/example/product/files/%ZZ", false)).status).toBe(404);
  vi.mocked(publications.getPublication).mockResolvedValue(null);
  for (const suffix of ["", "/tree", "/sitemap.xml"]) expect((await request(`/public/example/product${suffix}`, false)).status).toBe(404);
});

it("handles empty storage chunks without changing public HTML delivery", async () => {
  vi.mocked(minio.getObjectStream).mockImplementation(() => Promise.resolve(new ReadableStream({ start(controller) {
    // Exercise a storage adapter emitting a missing chunk before valid bytes.
    controller.enqueue(undefined);
    controller.enqueue(new TextEncoder().encode("<body>fixture</body>"));
    controller.close();
  } })));
  for (const path of ["/p/product/files/index.html", "/public/example/product/files/index.html"]) {
    const response = await request(path, false);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fixture");
  }
});

it("preserves a private access denial when cancelling its upstream response fails", async () => {
  const backend = vi.mocked(fetch).getMockImplementation()!;
  const cancel = vi.fn(() => Promise.reject(new Error("closed transport")));
  vi.mocked(fetch).mockImplementation((input, init) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).includes("/deployments/active")
    ? Promise.resolve(new Response(new ReadableStream({ cancel }), { status: 403 })) : backend(input, init));
  expect((await request(`${docsBase}/files/index.html`)).status).toBe(404);
  expect(cancel).toHaveBeenCalledOnce();
  expect(minio.getObjectStream).not.toHaveBeenCalled();
});
