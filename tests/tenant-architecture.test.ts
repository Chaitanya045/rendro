import { afterEach, describe, expect, it, vi } from "vitest";
import publicRoutes from "@/routes/public-v2";
import shareRoutes from "@/routes/share-v2";
import publicationApiRoutes from "@/routes/publication-api";
import projectDocsRoutes from "@/routes/project-docs";
import * as minio from "@/minio";

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function stream(value = "ok"): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

const publication = {
  publication: {
    slug: "product",
    pathPrefix: "reference",
    entryFile: "index.html",
    title: "Product docs",
  },
  project: { name: "Product", slug: "product" },
  deployment: { manifestKey: "organizations/org-a/projects/project-a/deployments/deploy-a/manifest.json", manifestSha256: "abc" },
};

const manifest = JSON.stringify({
  version: 1,
  files: [
    { path: "reference/index.html", sha256: "a", size: 10, contentType: "text/html; charset=utf-8" },
    { path: "reference/app.css", sha256: "b", size: 10, contentType: "text/css; charset=utf-8" },
    { path: "private.html", sha256: "c", size: 10, contentType: "text/html; charset=utf-8" },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("deployment-backed publications", () => {
  it("serves only objects present inside the explicit publication path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(publication))));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(manifest);
    const read = vi.spyOn(minio, "getObjectStream").mockResolvedValue(stream("<h1>Docs</h1>"));

    const allowed = await publicRoutes.request("/p/product/files/index.html");
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("Docs");
    expect(read).toHaveBeenCalledWith("organizations/org-a/projects/project-a/deployments/deploy-a/files/reference/index.html");

    const privateSibling = await publicRoutes.request("/p/product/files/private.html");
    expect(privateSibling.status).toBe(404);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("returns 404 immediately after publication resolution is removed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Not found" }, 404)));
    const read = vi.spyOn(minio, "getObjectStream");
    const response = await publicRoutes.request("/p/product/files/index.html");
    expect(response.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it("paginates large trees without embedding every manifest entry in the shell", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(publication))));
    const files = Array.from({ length: 205 }, (_, index) => ({
      path: `reference/page-${index}.html`,
      sha256: String(index),
      size: 1,
      contentType: "text/html; charset=utf-8",
    }));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1, files }));
    const first = await publicRoutes.request("/p/product/tree?cursor=0");
    const firstBody = await first.json() as { documents: string[]; cursor: string | null };
    expect(firstBody.documents).toHaveLength(200);
    expect(firstBody.cursor).toBe("200");
    const second = await publicRoutes.request("/p/product/tree?cursor=200");
    const secondBody = await second.json() as { documents: string[]; cursor: string | null };
    expect(secondBody.documents).toHaveLength(5);
    expect(secondBody.cursor).toBeNull();
  });
});

describe("publication release validation", () => {
  it("rejects an entry file absent from the selected deployment", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      deployment: { _id: "deploy-a", manifestKey: publication.deployment.manifestKey, status: "active" },
    })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(minio, "getObjectText").mockResolvedValue(manifest);
    const response = await publicationApiRoutes.request("/api/rendro/publications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId: "org-a",
        projectId: "project-a",
        slug: "missing",
        pathPrefix: "reference",
        entryFile: "missing.html",
        trackingMode: "track_active",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Publication entry file is not present in the selected deployment path",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("revocable private shares", () => {
  const resolution = {
    grant: { documentPath: "guide/index.html", expiresAt: Date.now() + 60_000 },
    deployment: { manifestKey: "organizations/org-a/projects/project-a/deployments/deploy-a/manifest.json" },
    project: { name: "Private guide" },
  };

  it("allows the exact HTML document and same-tree assets but not another HTML document", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(resolution))));
    const read = vi.spyOn(minio, "getObjectStream").mockImplementation(() => Promise.resolve(stream()));
    expect((await shareRoutes.request("/s/token/files/guide/index.html")).status).toBe(200);
    expect((await shareRoutes.request("/s/token/files/guide/app.css")).status).toBe(200);
    expect((await shareRoutes.request("/s/token/files/guide/secret.html")).status).toBe(404);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops serving when the grant lookup is revoked or expired", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Share not found" }, 404)));
    const read = vi.spyOn(minio, "getObjectStream");
    const response = await shareRoutes.request("/s/revoked/files/guide/index.html");
    expect(response.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("private project documents", () => {
  it("rejects tree and file requests without an authenticated session", async () => {
    expect((await projectDocsRoutes.request("/organizations/org-a/projects/project-a/docs/tree")).status).toBe(401);
    expect((await projectDocsRoutes.request("/organizations/org-a/projects/project-a/docs/files/index.html")).status).toBe(404);
  });
});
