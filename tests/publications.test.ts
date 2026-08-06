import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { User } from "better-auth/types";

const objects = new Map<string, string>();
const deleted = new Set<string>();

function emptyImmediateList() {
  return { entries: [], isTruncated: false };
}

vi.mock("@/minio", () => ({
  buildTree: vi.fn(() => []),
  deleteObject: vi.fn((key: string) => {
    objects.delete(key);
    return Promise.resolve();
  }),
  getObjectStream: vi.fn((key: string) => {
    const value = objects.get(key);
    if (value === undefined) return Promise.resolve(null);
    const bytes = new TextEncoder().encode(value);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return Promise.resolve(stream);
  }),
  headObject: vi.fn((key: string) => Promise.resolve(objects.has(key) ? { size: objects.get(key)?.length } : null)),
  listImmediate: vi.fn(() => Promise.resolve(emptyImmediateList())),
  listAllKeys: vi.fn((prefix: string) => Promise.resolve(Array.from(objects.keys()).filter((key) => key.startsWith(prefix)))),
  putObject: vi.fn((key: string, body: string | Uint8Array) => {
    objects.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
    return Promise.resolve();
  }),
}));

vi.mock("@/soft-delete", () => ({
  filterDeleted: vi.fn((keys: string[]) => Promise.resolve(keys.filter((key) => !deleted.has(key)))),
  isDeleted: vi.fn((key: string) => Promise.resolve(deleted.has(key))),
}));

vi.mock("@/api-keys", () => ({
  validateApiKey: vi.fn((key: string) => Promise.resolve(key === "valid-key" ? "acme" : null)),
}));

import publicRoutes from "@/routes/public";
import publicationRoutes from "@/routes/publications";
import docsRoutes from "@/routes/docs";
import {
  getPublication,
  listPublishedDocumentPaths,
  PublicationError,
  savePublication,
} from "@/publications";

function seedDocuments(): void {
  objects.set("acme/repo/product/index.html", "<h1>Public home</h1>");
  objects.set("acme/repo/product/guide.html", "<h1>Public guide</h1>");
  objects.set("acme/repo/private/secret.html", "<h1>Private</h1>");
}

beforeEach(() => {
  objects.clear();
  deleted.clear();
  seedDocuments();
});

describe("publication persistence", () => {
  it("publishes an HTML folder prefix without copying documents", async () => {
    const result = await savePublication({
      orgSlug: "acme",
      slug: "product",
      sourcePrefix: "acme/repo/product/",
      title: "Product docs",
      entryFile: "index.html",
    });

    expect(result.documentCount).toBe(2);
    expect(result.publication.sourcePrefix).toBe("acme/repo/product/");
    expect(await getPublication("acme", "product")).toEqual(result.publication);
    expect(objects.get("acme/repo/product/index.html")).toBe("<h1>Public home</h1>");
  });

  it("rejects cross-org, traversal, and overlapping prefixes", async () => {
    await expect(savePublication({
      orgSlug: "acme",
      slug: "bad",
      sourcePrefix: "other/repo/product/",
      entryFile: "index.html",
    })).rejects.toMatchObject({ status: 400 });

    await expect(savePublication({
      orgSlug: "acme",
      slug: "bad",
      sourcePrefix: "acme/repo/../private/",
      entryFile: "index.html",
    })).rejects.toMatchObject({ status: 400 });

    await savePublication({
      orgSlug: "acme",
      slug: "product",
      sourcePrefix: "acme/repo/product/",
      entryFile: "index.html",
    });
    await expect(savePublication({
      orgSlug: "acme",
      slug: "nested",
      sourcePrefix: "acme/repo/product/nested/",
      entryFile: "index.html",
    })).rejects.toBeInstanceOf(PublicationError);
  });

  it("automatically includes new files and filters soft-deleted files", async () => {
    const { publication } = await savePublication({
      orgSlug: "acme",
      slug: "product",
      sourcePrefix: "acme/repo/product/",
      entryFile: "index.html",
    });
    objects.set("acme/repo/product/new.html", "<h1>New</h1>");
    deleted.add("acme/repo/product/guide.html");

    expect(await listPublishedDocumentPaths(publication)).toEqual(["index.html", "new.html"]);
  });
});

describe("publication management routes", () => {
  it("requires authentication and derives the organization from the API key", async () => {
    const unauthorized = await publicationRoutes.request("https://rendro.test/api/publications");
    expect(unauthorized.status).toBe(401);

    const crossOrg = await publicationRoutes.request("https://rendro.test/api/publications", {
      method: "POST",
      headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "product",
        sourcePrefix: "other/repo/product/",
        entryFile: "index.html",
      }),
    });
    expect(crossOrg.status).toBe(400);
  });

  it("creates, lists, and unpublishes a folder", async () => {
    const create = await publicationRoutes.request("https://rendro.test/api/publications", {
      method: "POST",
      headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "product",
        sourcePrefix: "acme/repo/product/",
        title: "Product docs",
        entryFile: "index.html",
      }),
    });
    expect(create.status).toBe(200);
    await expect(create.json()).resolves.toMatchObject({
      documentCount: 2,
      url: "https://rendro.test/public/acme/product",
    });

    const list = await publicationRoutes.request("https://rendro.test/api/publications", {
      headers: { Authorization: "Bearer valid-key" },
    });
    await expect(list.json()).resolves.toMatchObject({ publications: [{ slug: "product" }] });

    const remove = await publicationRoutes.request("https://rendro.test/api/publications/product", {
      method: "DELETE",
      headers: { Authorization: "Bearer valid-key" },
    });
    expect(remove.status).toBe(200);
    expect(await getPublication("acme", "product")).toBeNull();
  });
});

describe("anonymous public routes", () => {
  beforeEach(async () => {
    await savePublication({
      orgSlug: "acme",
      slug: "product",
      sourcePrefix: "acme/repo/product/",
      title: "Product docs",
      entryFile: "index.html",
    });
  });

  it("renders a public shell and streams published documents without a session", async () => {
    const shell = await publicRoutes.request("https://rendro.test/public/acme/product");
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain("<title>Product docs — Rendro</title>");
    expect(html).toContain('<header class="topbar">');
    expect(html).toContain('<span class="topbar-logo">acme</span>');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('id="content-frame"');
    expect(html).toContain('data-tree-org="acme" data-publication-base="/public/acme/product"');
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-downloads"');
    expect(html).toContain('src="/lazy-tree.js?v=25"');
    expect(html).not.toContain('<div class="topbar-avatar"');
    expect(html).not.toContain("commentor.js");

    const document = await publicRoutes.request("https://rendro.test/public/acme/product/files/guide.html");
    expect(document.status).toBe(200);

    const tree = await publicRoutes.request("https://rendro.test/public/acme/product/tree");
    expect(tree.status).toBe(200);
    await expect(tree.json()).resolves.toMatchObject({
      entryFile: "index.html",
      documents: ["guide.html", "index.html"],
    });

    const sitemap = await publicRoutes.request("https://rendro.test/public/acme/product/sitemap.xml");
    expect(sitemap.status).toBe(200);
    const sitemapXml = await sitemap.text();
    expect(sitemapXml).toContain("guide.html");
    expect(sitemapXml).not.toContain("secret.html");
    const documentHtml = await document.text();
    expect(documentHtml).toContain("<h1>Public guide</h1>");
    expect(documentHtml).toContain('type:"doc-loaded"');
    expect(documentHtml).toContain('type:"doc-navigate"');
    expect(documentHtml).not.toContain("window.COMMENTOR");
    expect(documentHtml).not.toContain("commentor.js");
    expect(document.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("does not expose private siblings, traversal paths, or deleted documents", async () => {
    const sibling = await publicRoutes.request("https://rendro.test/public/acme/product/files/private/secret.html");
    expect(sibling.status).toBe(404);

    const traversal = await publicRoutes.request("https://rendro.test/public/acme/product/files/%252e%252e%252fprivate%252fsecret.html");
    expect(traversal.status).toBe(404);

    deleted.add("acme/repo/product/guide.html");
    const removed = await publicRoutes.request("https://rendro.test/public/acme/product/files/guide.html");
    expect(removed.status).toBe(404);
  });
});

describe("private tree routes", () => {
  it("requires a session and enforces the session organization", async () => {
    const anonymous = await docsRoutes.request("https://rendro.test/api/tree/acme?prefix=acme%2F");
    expect(anonymous.status).toBe(401);

    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", async (c, next) => {
      c.set("user", {
        id: "user",
        email: "owner@acme.com",
        name: "Owner",
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await next();
    });
    app.route("/", docsRoutes);
    const crossOrg = await app.request("https://rendro.test/api/tree/other?prefix=other%2F");
    expect(crossOrg.status).toBe(403);
  });
});
