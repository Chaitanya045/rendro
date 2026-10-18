import { afterEach, beforeEach, expect, it, vi } from "vitest";
import publicRoutes from "../src/routes/public-v2";
import shareRoutes from "../src/routes/share-v2";
import * as storage from "../src/minio";
import { deploymentMetadataCache } from "../src/immutable-cache";
const publication = { publication: { slug: "docs", entryFile: "index.html", title: "Docs", pathPrefix: "" }, deployment: { manifestKey: "root/manifest.json" } };
const share = { grant: { documentPath: "index.html", expiresAt: Date.now() + 60_000 }, project: { name: "Docs" }, deployment: publication.deployment };
const manifest = JSON.stringify({ version: 1, files: [{ path: "index.html", sha256: "sha", size: 1, contentType: "text/html" }] });
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: string) => Promise.resolve(Response.json(input.includes("/shares/") ? share : publication))));
  vi.spyOn(storage, "getObjectText").mockResolvedValue(manifest);
  vi.spyOn(storage, "getObjectStream").mockImplementation(() => Promise.resolve(new Response("<h1>Docs</h1>").body));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("rejects invalid selected documents before serving the publication shell", async () => {
  for (const doc of ["", "../private.html", "missing.html"]) expect((await publicRoutes.request(`/p/docs?doc=${encodeURIComponent(doc)}`)).status).toBe(404);
});
it("handles unavailable manifests and objects without a successful viewer response", async () => {
  vi.mocked(storage.getObjectText).mockResolvedValue(null);
  for (const path of ["/p/docs", "/p/docs/tree", "/p/docs/files/index.html"]) expect((await publicRoutes.request(path)).status).toBe(404);
  vi.mocked(storage.getObjectText).mockResolvedValue(manifest);
  vi.mocked(storage.getObjectStream).mockResolvedValue(null);
  expect((await publicRoutes.request("/p/docs/files/index.html")).status).toBe(404);
  expect((await shareRoutes.request("/s/test/files/index.html")).status).toBe(404);
});
it("paginates root publications and renders HTML fragments", async () => {
  vi.mocked(storage.getObjectText).mockResolvedValue(JSON.stringify({ version: 1, files: Array.from({ length: 201 }, (_, i) => ({ path: `${i}.html`, sha256: "sha", size: 1, contentType: "text/html" })) }));
  expect(await (await publicRoutes.request("/p/docs/tree")).json()).toMatchObject({ cursor: "200", total: 201 });
  expect(await (await publicRoutes.request("/p/docs/tree?cursor=200")).json()).toEqual({ documents: ["200.html"], cursor: null, total: 201 });
  // Deployment manifests are immutable; model a new deployment's isolate.
  deploymentMetadataCache.clear();
  vi.mocked(storage.getObjectText).mockResolvedValue(manifest);
  vi.mocked(storage.getObjectStream).mockResolvedValue(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array());
    controller.enqueue(new TextEncoder().encode("<h1>Docs</h1>"));
    controller.close();
  } }));
  const response = await publicRoutes.request("/p/docs/files/index.html");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<h1>Docs</h1>");
});
it("keeps share shells and files confined to their capability", async () => {
  expect((await shareRoutes.request("/s/test?doc=other.html")).status).toBe(404);
  expect((await shareRoutes.request("/s/test?doc=index.html&docQuery=invalid")).status).toBe(400);
  expect((await shareRoutes.request("/s/test?doc=index.html&docQuery=%3Fx%3D1")).status).toBe(200);
  expect((await shareRoutes.request("/s/test/files/other.html")).status).toBe(404);
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
  expect((await shareRoutes.request("/s/test")).status).toBe(404);
});
