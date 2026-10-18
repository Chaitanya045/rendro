import { readFileSync } from "node:fs";
import { vi } from "vitest";
import * as blobs from "@/storage";
import { createShareToken } from "@/share-links";
import { createLegacyViewerTicket, createViewerTicket } from "@/viewer-ticket";
import { docsBase, mockSecurityBackend } from "./security-headers";

export const cookie = "better-auth.session_token=isolation-fixture";
export const manifestKey = "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json";
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><p>Publisher fixture</p></body></html>';
export const mediaCases = [
  { path: "index.html", type: "text/html", expected: "text/html", body: html },
  { path: "mixed.html", type: ' Text/HTML ; CHARSET="UTF-8"; ignored=value', expected: "text/html", body: html },
  { path: "image.svg", type: "image/svg+xml", expected: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>' },
  { path: "mixed.svg", type: " IMAGE/SVG+XML ; charset=utf-8", expected: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  { path: "document.xhtml", type: "Application/XHTML+XML; charset=UTF-8", expected: "application/xhtml+xml", body: '<html xmlns="http://www.w3.org/1999/xhtml"><body>Publisher fixture</body></html>' },
  { path: "document.xml", type: "Application/XML; charset=utf-8", expected: "application/xml", body: "<document>Publisher fixture</document>" },
  { path: "text.xml", type: "TEXT/XML", expected: "text/xml", body: "<document/>" },
  { path: "unknown.bin", type: "application/x-publisher-active", expected: "application/x-publisher-active", body: html },
  { path: "invalid.bin", type: "text/html, image/svg+xml", expected: "application/octet-stream", body: html },
  { path: "empty.bin", type: "", expected: "application/octet-stream", body: html },
  { path: "prefix.bin", type: "text/html-extra", expected: "text/html-extra", body: html },
  { path: "style.css", type: "TEXT/CSS; charset=UTF-8", expected: "text/css", body: '@font-face{font-family:Fixture;src:url(font.woff2)} #font{font-family:Fixture;color:rgb(1,2,3)}' },
  { path: "font.woff2", type: "application/octet-stream", expected: "font/woff2", body: new Uint8Array(readFileSync(new URL("./viewer-font.woff2", import.meta.url))) },
  { path: "data.json", type: "Application/JSON; ignored=value", expected: "application/json", body: '{"fixture":true}' },
  { path: "script.js", type: "Application/JavaScript; charset=utf-8", expected: "application/javascript", body: "/* publisher fixture */" },
];

/** Real Worker routes, with only identity/metadata and blob storage substituted. */
export async function publisherIsolationFixture(assetPaths?: string[]) {
  mockSecurityBackend();
  const files = mediaCases.map((entry, i) => ({ ...entry, legacyPath: `case-${i}.html` }));
  const find = (key: string) => files.find(file => key.endsWith(`/${file.path}`) || key === `example/${file.legacyPath}`);
  vi.mocked(blobs.getObjectText).mockResolvedValue(JSON.stringify({ version: 1, files: files.map(file => ({
    path: file.path, contentType: file.type, sha256: "a", size: Buffer.byteLength(file.body),
  })) }));
  vi.mocked(blobs.headObject).mockImplementation(key => Promise.resolve(find(key) ? { contentType: find(key)!.type } : null));
  vi.mocked(blobs.getObjectStream).mockImplementation(key => Promise.resolve(find(key) ? new Response(find(key)!.body).body : null));
  const backend = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/shares/public")) {
      const index = Number(url.searchParams.get("token"));
      const file = files[index];
      return Promise.resolve(file ? Response.json({ grant: { documentPath: file.path, ...(assetPaths === undefined ? {} : { assetPaths }), expiresAt: Date.now() + 60_000 },
        deployment: { manifestKey }, project: { name: "Fixture" } }) : new Response(null, { status: 404 }));
    }
    return backend(input, init);
  });
  const ticket = await createViewerTicket({ organizationId: "org-a", projectId: "project-a", manifestKey, cookie });
  const legacyTicket = await createLegacyViewerTicket("example", cookie);
  const routes = [
    { name: "public", pattern: "/p/:slug/files/*", url: (i: number) => `/p/product/files/${files[i].path}`, signedIn: false, cors: "null", legacyHtml: false },
    { name: "share", pattern: "/s/:token/files/*", url: (i: number) => `/s/${i}/files/${files[i].path}`, signedIn: false, cors: "null", legacyHtml: false },
    { name: "private", pattern: "/organizations/:organizationId/projects/:projectId/docs/files/*", url: (i: number) => `${docsBase}/files/${files[i].path}`, signedIn: true, cors: null, legacyHtml: false },
    { name: "private ticket", pattern: "/organizations/:organizationId/projects/:projectId/docs/view/:viewerToken/files/*", url: (i: number) => `${docsBase}/view/${ticket}/files/${files[i].path}`, signedIn: false, cors: "null", legacyHtml: false },
    { name: "legacy private", pattern: "/legacy-view/:org/files/*", url: (i: number) => `/legacy-view/example/files/${files[i].path}`, signedIn: true, cors: null, legacyHtml: false },
    { name: "legacy ticket", pattern: "/legacy-view/:org/view/:viewerToken/files/*", url: (i: number) => `/legacy-view/example/view/${legacyTicket}/files/${files[i].path}`, signedIn: false, cors: "null", legacyHtml: false },
    { name: "legacy publication", pattern: "/public/:org/:slug/files/:path{.+}", url: (i: number) => `/public/example/product/files/${files[i].legacyPath}`, signedIn: false, cors: null, legacyHtml: true },
    { name: "legacy share", pattern: "/share/:token", url: (i: number) => `/share/${createShareToken(`example/${files[i].legacyPath}`)}`, signedIn: false, cors: null, legacyHtml: true },
  ];
  return { files, routes };
}
