import { Hono } from "hono";
import type { User } from "better-auth/types";
import { Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as minio from "@/minio";
import * as publications from "@/publications";
import * as softDelete from "@/soft-delete";
import { createShareToken } from "@/share-links";
import projectDocs from "@/routes/project-docs";
import publicDocs from "@/routes/public-v2";
import sharedDocs from "@/routes/share-v2";
import legacyDocs from "@/routes/docs";
import legacyPublic from "@/routes/public";
import legacyShare from "@/routes/share";

const user = { id: "regression-user", email: "reader@example-test.test", name: "Reader" } as User;
const deployment = { manifestKey: "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json", manifestSha256: "fixture" };
const script = 'const headEnd = "</head>"; const bodyStart = "<body>";';
const content = `<script id="publisher-script">${script}</script><style>p::before{content:"</head>"}</style><!-- </head><body> -->`;
const fixtures = [
  ["complete document", `<!doctype html><html><head><meta charset="utf-8">${content}</head><body><p>Résumé 📖</p></body></html>`],
  ["headless document", `<!doctype html><body>${content}<p>Résumé 📖</p></body>`],
  ["fragment", `${content}<p>Résumé 📖</p>`],
];

function authenticated(routes: typeof projectDocs) {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => { c.set("user", user); await next(); });
  app.route("/", routes);
  return app;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(fixtures)("document delivery regression: %s", (_name, html) => {
  it.each(["private", "public", "shared", "legacy-private", "legacy-public", "legacy-shared"])("preserves publisher code through the %s route", async surface => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({
      deployment,
      project: { name: "Regression docs", slug: "docs" },
      publication: { slug: "docs", pathPrefix: "", entryFile: "index.html" },
      grant: { documentPath: "index.html", expiresAt: Date.now() + 60_000 },
    }))));
    vi.spyOn(softDelete, "isDeleted").mockResolvedValue(false);
    vi.spyOn(publications, "getPublication").mockResolvedValue({
      orgSlug: "example-test", slug: "docs", sourcePrefix: "example-test/docs/", entryFile: "index.html",
      title: "Regression docs", createdAt: "2026-09-20", updatedAt: "2026-09-20",
    });
    vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({
      version: 1, files: [{ path: "index.html", sha256: "fixture", size: html.length, contentType: "text/html; charset=utf-8" }],
    }));
    vi.spyOn(minio, "getObjectStream").mockImplementation(() => Promise.resolve(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(html)); controller.close(); },
    })));
    const requests = {
      private: () => authenticated(projectDocs).request("/organizations/org-a/projects/project-a/docs/files/index.html"),
      public: () => publicDocs.request("/p/docs/files/index.html"),
      shared: () => sharedDocs.request("/s/fixture-token/files/index.html"),
      "legacy-private": () => authenticated(legacyDocs).request("/files/example-test/docs/index.html"),
      "legacy-public": () => legacyPublic.request("/public/example-test/docs/files/index.html"),
      "legacy-shared": () => legacyShare.request(`/share/${createShareToken("example-test/docs/index.html")}`),
    };
    const response = await requests[surface as keyof typeof requests]();
    const output = await response.text();
    expect(response.status).toBe(200);
    expect(output).toContain(content);
    expect(output).toContain("Résumé 📖");
    expect(output.match(/data-rendro-mobile-viewport/g)).toHaveLength(1);
    const publisherScript = output.match(/<script id="publisher-script">([\s\S]*?)<\/script>/)?.[1];
    expect(publisherScript).toBe(script);
    expect(() => new Script(publisherScript!)).not.toThrow();
    if (html.startsWith("<!doctype")) expect(output.startsWith("<!doctype html>")).toBe(true);
    if (surface === "private" || surface === "shared") expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    if (!surface.startsWith("legacy")) expect(response.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
  });
});
