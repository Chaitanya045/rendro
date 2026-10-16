import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { vi } from "vitest";
import projectDocs from "@/routes/project-docs";
import publicDocs from "@/routes/public-v2";
import shareDocs from "@/routes/share-v2";
import { securityHeaders } from "@/middleware/security-headers";
import { createViewerTicket } from "@/viewer-ticket";
import { collectShareAssets } from "@/share-assets";
import * as minio from "@/minio";

export const privateBase = "/organizations/org/projects/project/docs";
export const fixtureCookie = "better-auth.session_token=fixture.signature";
export const fontTypes = [
  ["woff2", "font/woff2"], ["woff", "font/woff"], ["ttf", "font/ttf"],
  ["otf", "font/otf"], ["eot", "application/vnd.ms-fontobject"],
] as const;
const manifestKey = "tenants/org/projects/project/deployments/deploy/manifest.json";
const publisherHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Asset fixture</title>
<link rel="stylesheet" href="assets/site.css"></head><body><p id="font">AAAA</p>
<img id="image" crossorigin="anonymous" src="assets/image.svg">
<script type="module" src="assets/module.js"></script>
<link rel="preload" as="fetch" crossorigin="anonymous" href="assets/data.json">
<script>fetch(new URL('assets/data.json', document.baseURI)).then(r => r.json()).then(data => {
  document.body.dataset.fetched = data.value;
});</script></body></html>`;

export async function createAssetFixture() {
  const files = [
    { path: "guide/index.html", contentType: "text/html", body: publisherHtml },
    { path: "guide/assets/site.css", contentType: "text/css", body: '@font-face { font-family: Fixture; src: url(font.woff2) format("woff2"); } #font { font-family: Fixture; }' + fontTypes.flatMap(([extension]) => [extension, extension.toUpperCase()].map(ext => `@font-face { font-family: Unused-${ext}; src: url(font.${ext}); }`)).join("") },
    { path: "guide/assets/image.svg", contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>' },
    { path: "guide/assets/module.js", contentType: "application/javascript", body: 'document.body.dataset.module = "loaded";' },
    { path: "guide/assets/data.json", contentType: "application/json", body: '{"value":"loaded"}' },
    ...fontTypes.flatMap(([extension]) => [extension, extension.toUpperCase()].map(ext => ({
      path: `guide/assets/font.${ext}`, contentType: "application/octet-stream",
      body: new Uint8Array(readFileSync(new URL("./viewer-font.woff2", import.meta.url))),
    }))),
  ];
  const assetPaths = await collectShareAssets({ files }, "guide/index.html", path => Promise.resolve(new Response(files.find(file => file.path === path)!.body).body));
  const backend = vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const common = { project: { name: "Docs", slug: "docs" }, deployment: { manifestKey } };
    if (url.pathname.endsWith("/deployments/active")) return Promise.resolve(Response.json(common));
    if (url.pathname.endsWith("/publications/public")) return Promise.resolve(Response.json({ ...common,
      publication: { slug: "fixture", pathPrefix: "guide", entryFile: "index.html" } }));
    if (url.pathname.endsWith("/shares/public")) return Promise.resolve(Response.json({ ...common,
      grant: { documentPath: "guide/index.html", assetPaths, expiresAt: Date.now() + 60_000 } }));
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  vi.stubGlobal("fetch", backend);
  vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1, files }));
  const objects = vi.spyOn(minio, "getObjectStream").mockImplementation(key => {
    const file = files.find(file => key === `${manifestKey.slice(0, -"manifest.json".length)}files/${file.path}`);
    return Promise.resolve(file ? new Response(file.body).body : null);
  });
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", securityHeaders);
  app.use("*", async (c, next) => {
    if (c.req.header("Cookie") === fixtureCookie) c.set("user", { id: "test", name: "Test", email: "test@example.test" } as User);
    await next();
  });
  app.route("/", projectDocs);
  app.route("/", publicDocs);
  app.route("/", shareDocs);
  const ticket = await createViewerTicket({ organizationId: "org", projectId: "project", manifestKey, cookie: fixtureCookie });
  return { app, backend, objects, viewers: [
    { name: "public", prefix: "/p/fixture/files/", cors: "null", cookie: false },
    { name: "share", prefix: "/s/fixture/files/guide/", cors: "null", cookie: false },
    { name: "private ticket", prefix: `${privateBase}/view/${ticket}/files/guide/`, cors: "null", cookie: false },
    { name: "private cookie", prefix: `${privateBase}/files/guide/`, cors: null, cookie: true },
  ] };
}
