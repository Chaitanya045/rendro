import { afterEach, describe, expect, it, vi } from "vitest";
import publicRoutes from "@/routes/public-v2";
import * as minio from "@/minio";

const resolution = {
  publication: { slug: "product", pathPrefix: "public", entryFile: "index.html", title: "Product" },
  project: { name: "Product", slug: "product" },
  deployment: {
    manifestKey: "organizations/org-a/projects/project-a/deployments/deploy-a/manifest.json",
    manifestSha256: "manifest",
  },
};

const manifest = JSON.stringify({
  version: 1,
  files: [
    { path: "public/index.html", sha256: "index", size: 10, contentType: "text/html; charset=utf-8" },
    { path: "public/assets/app.css", sha256: "css", size: 10, contentType: "text/css; charset=utf-8" },
    { path: "private/secret.html", sha256: "secret", size: 10, contentType: "text/html; charset=utf-8" },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("anonymous publication revocation and path isolation", () => {
  it.each(["/p/product", "/p/product/tree", "/p/product/files/index.html"])(
    "returns 404 after publication revocation without reading storage: %s",
    async (path) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Not found" }, { status: 404 })));
      const manifestRead = vi.spyOn(minio, "getObjectText");
      const objectRead = vi.spyOn(minio, "getObjectStream");

      expect((await publicRoutes.request(path)).status).toBe(404);
      expect(manifestRead).not.toHaveBeenCalled();
      expect(objectRead).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/p/product/files/secret.html",
    "/p/product/files/%252e%252e%252fprivate%252fsecret.html",
    "/p/product/files/%255cprivate%255csecret.html",
    "/p/product/files/%E0%A4%A.html",
  ])("rejects outside, multiply encoded, and malformed paths without object reads: %s", async (path) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(resolution)));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(manifest);
    const objectRead = vi.spyOn(minio, "getObjectStream");

    expect((await publicRoutes.request(path)).status).toBe(404);
    expect(objectRead).not.toHaveBeenCalled();
  });

  it("serves only a manifest-listed asset inside the publication prefix", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(resolution)));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(manifest);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("body{}"));
        controller.close();
      },
    });
    const objectRead = vi.spyOn(minio, "getObjectStream").mockResolvedValue(body);

    const response = await publicRoutes.request("/p/product/files/assets/app.css");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(objectRead).toHaveBeenCalledWith(
      "organizations/org-a/projects/project-a/deployments/deploy-a/files/public/assets/app.css",
    );
  });
});
