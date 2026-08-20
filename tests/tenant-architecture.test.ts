import { Hono } from "hono";
import type { User } from "better-auth/types";
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
    { path: "reference/guide.html", sha256: "d", size: 10, contentType: "text/html; charset=utf-8" },
    { path: "reference/app.css", sha256: "b", size: 10, contentType: "text/css; charset=utf-8" },
    { path: "private.html", sha256: "c", size: 10, contentType: "text/html; charset=utf-8" },
  ],
});
const user: User = {
  id: "user-a",
  email: "owner@example.com",
  name: "Owner",
  emailVerified: true,
  image: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function authenticatedProjectDocs() {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", projectDocsRoutes);
  return app;
}

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

  it("renders the canonical public shell for entry and selected HTML documents", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(publication))));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(manifest);

    const entry = await publicRoutes.request("/p/product");
    const entryHtml = await entry.text();
    expect(entry.status).toBe(200);
    expect(entry.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(entry.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(entryHtml).toContain("Product docs");
    expect(entryHtml).toContain('window.RENDRO_INITIAL_DOC="product/index.html"');
    expect(entryHtml).toContain('window.RENDRO_DOCUMENT_BASE="/p/product"');
    expect(entryHtml).toContain('sandbox="allow-scripts allow-forms allow-popups allow-downloads"');
    expect(entryHtml).not.toContain('id="avatar-btn"');

    const selected = await publicRoutes.request("/p/product?doc=guide.html");
    expect(selected.status).toBe(200);
    expect(await selected.text()).toContain('window.RENDRO_INITIAL_DOC="product/guide.html"');

    const missing = await publicRoutes.request("/p/product?doc=missing.html");
    expect(missing.status).toBe(404);
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

  it("keeps manifest-controlled document paths inside inline state", async () => {
    const hostilePath = 'reference/guide</script><script>window.injected=true</script>.html';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(publication)));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({
      version: 1,
      files: [{ path: hostilePath, sha256: "x", size: 1, contentType: "text/html; charset=utf-8" }],
    }));

    const response = await publicRoutes.request(`/p/product?doc=${encodeURIComponent(hostilePath.slice("reference/".length))}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain("</script><script>window.injected=true");
    expect(html).toContain("guide\\u003c/script>\\u003cscript>window.injected=true\\u003c/script>.html");
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

  it("renders the authenticated project shell with a valid document selection", async () => {
    const app = authenticatedProjectDocs();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      project: { name: "Product" },
      deployment: publication.deployment,
    })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(minio, "getObjectText").mockResolvedValue(manifest);

    const response = await app.request("/organizations/org-a/projects/project-a/docs", {
      headers: { Cookie: "better-auth.session=abc" },
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Product");
    expect(html).toContain('window.RENDRO_INITIAL_DOC="project-a/reference/index.html"');
    expect(html).toContain('href="/organizations/org-a/projects/project-a"');
    expect(html).toContain('"organizationId":"org-a","projectId":"project-a"');
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-downloads"');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/rendro/deployments/active?organizationId=org-a&projectId=project-a"),
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: "better-auth.session=abc" }) }),
    );

    const invalid = await app.request("/organizations/org-a/projects/project-a/docs?doc=reference%2Fapp.css");
    expect(invalid.status).toBe(404);
  });

  it("injects private HTML features without modifying non-HTML assets", async () => {
    const app = authenticatedProjectDocs();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      project: { name: "Product" },
      deployment: publication.deployment,
    }))));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(manifest);
    vi.spyOn(minio, "getObjectStream").mockImplementation((key) => Promise.resolve(
      stream(key.endsWith("app.css") ? "body{color:red}" : "<!doctype html><body><h1>Publisher docs</h1></body>")
    ));

    const htmlResponse = await app.request("/organizations/org-a/projects/project-a/docs/files/reference/index.html");
    const html = await htmlResponse.text();
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(htmlResponse.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
    expect(htmlResponse.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(html).toContain("<h1>Publisher docs</h1>");
    expect(html).toContain('window.COMMENTOR={"convexUrl":');
    expect(html.match(/window\.COMMENTOR=/g)).toHaveLength(1);

    const assetResponse = await app.request("/organizations/org-a/projects/project-a/docs/files/reference/app.css");
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await assetResponse.text()).toBe("body{color:red}");
  });

  it("escapes manifest-controlled paths in private document scripts", async () => {
    const app = authenticatedProjectDocs();
    const hostilePath = 'guide</script><script>window.injected=true</script>.html';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      project: { name: "Product" },
      deployment: publication.deployment,
    })));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({
      version: 1,
      files: [{ path: hostilePath, contentType: "text/html; charset=utf-8" }],
    }));
    vi.spyOn(minio, "getObjectStream").mockResolvedValue(stream("<body>Safe publisher content</body>"));

    const response = await app.request(`/organizations/org-a/projects/project-a/docs/files/${encodeURIComponent(hostilePath)}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain("</script><script>window.injected=true");
    expect(html).toContain("guide\\u003c/script>\\u003cscript>window.injected=true\\u003c/script>.html");
  });

  it("preserves the requested project document in anonymous sign-in redirects", async () => {
    const response = await projectDocsRoutes.request("/organizations/org-a/projects/project-a/docs");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/sign-in?returnTo=%2Forganizations%2Forg-a%2Fprojects%2Fproject-a%2Fdocs",
    );
  });
});
