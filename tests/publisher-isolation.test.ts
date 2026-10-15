import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import { assetContentType, isHtmlAsset, normalizeMediaType } from "@/routes/asset-headers";
import { cookie, mediaCases, publisherIsolationFixture } from "./fixtures/publisher-isolation";

const htmlPolicy = "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'";
const assetPolicy = "sandbox; frame-ancestors 'self'";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("inventories every publisher byte-serving module and mounted route", async () => {
  const { routes } = await publisherIsolationFixture();
  const directory = new URL("../src/routes/", import.meta.url);
  const streaming = readdirSync(directory).filter(name => name !== "share-api.ts" && /\bgetObjectStream\(/.test(readFileSync(new URL(name, directory), "utf8")));
  expect(streaming.sort()).toEqual(["docs.ts", "project-docs.ts", "public-v2.ts", "public.ts", "share-v2.ts", "share.ts"]);
  for (const name of streaming) expect(readFileSync(new URL(name, directory), "utf8")).toContain("assetHeaders(");
  const mounted = [...new Set(worker.routes.filter(route => route.method === "GET" &&
    (route.path.includes("/files/") || route.path === "/share/:token")).map(route => route.path))];
  expect(mounted.sort()).toEqual([...routes.map(route => route.pattern), "/files/:key{.+}"].sort());
  // /files/* is now a bookmark redirect; publications.ts returns structured JSON,
  // and the legacy sitemap constructs escaped XML, never raw publisher bytes.
  const bookmark = await worker.request("https://rendro.test/files/example/index.html", { headers: { Cookie: cookie } });
  expect(bookmark.status).toBe(302);
  expect(await bookmark.text()).toBe("");
});

describe.each(mediaCases.map((file, index) => ({ ...file, index })))("publisher MIME $type ($path)", file => {
  it("isolates every serving route, preserving asset bytes and authorization-specific CORS", async () => {
    const { routes } = await publisherIsolationFixture();
    for (const route of routes) {
      const response = await worker.request(`https://rendro.test${route.url(file.index)}`, {
        headers: { Origin: "null", ...(route.signedIn ? { Cookie: cookie } : {}) },
      });
      expect(response.status, route.name).toBe(200);
      // Legacy HTML-only capabilities force HTML; modern delivery uses manifest MIME.
      const type = route.legacyHtml ? "text/html" : file.expected;
      expect(response.headers.get("Content-Type")?.split(";")[0], route.name).toBe(type);
      expect(response.headers.get("Content-Security-Policy"), route.name).toBe(type === "text/html" ? htmlPolicy
        : (["share", "private", "private ticket"].includes(route.name) ? "default-src 'none'; " : "") + assetPolicy);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(route.cors);
      expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
      const body = new Uint8Array(await response.arrayBuffer());
      if (type !== "text/html") expect(body).toEqual(typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body);
      else if (typeof file.body === "string") expect(new TextDecoder().decode(body)).toContain(file.body.includes("Publisher fixture") ? "Publisher fixture" : file.body);
    }
  });
});

it("fails closed on missing assets and denies legacy non-HTML publication paths", async () => {
  const { routes } = await publisherIsolationFixture();
  vi.mocked((await import("@/minio")).getObjectStream).mockResolvedValue(null);
  for (const route of routes) {
    const response = await worker.request(`https://rendro.test${route.url(0)}`, { headers: route.signedIn ? { Cookie: cookie } : {} });
    expect(response.status, route.name).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.text()).not.toContain("Publisher fixture");
  }
  for (const file of mediaCases.filter(file => !file.path.endsWith(".html"))) {
    expect((await worker.request(`https://rendro.test/public/example/product/files/${file.path}`)).status).toBe(404);
  }
});

it("normalizes MIME essences without mistaking active or invalid types for HTML", () => {
  for (const invalid of ["", "text", "text/", "/html", "text/html\r\nInjected: value", "text/html,application/xml", "text /html"]) {
    expect(normalizeMediaType(invalid)).toBe("application/octet-stream");
  }
  expect(normalizeMediaType(" TEXT/HTML ; charset=utf-7; extra=anything")).toBe("text/html");
  expect(assetContentType("page.html", "Text/HTML; charset=utf-7")).toBe("text/html");
  expect(assetContentType("unknown")).toBe("application/octet-stream");
  expect(isHtmlAsset("page.html")).toBe(true);
  expect(isHtmlAsset("page.html", "text/html-extra")).toBe(false);
  expect(isHtmlAsset("page.html", "application/xhtml+xml")).toBe(false);
});

it("uses normalized exact HTML types for both document trees and shell selection", async () => {
  await publisherIsolationFixture();
  for (const base of ["/p/product", "/organizations/org-a/projects/project-a/docs"]) {
    const headers = { Cookie: cookie };
    const tree = await worker.request(`https://rendro.test${base}/tree`, { headers });
    expect(tree.status).toBe(200);
    expect((await tree.json() as { documents: string[] }).documents).toEqual(["index.html", "mixed.html"]);
    for (const path of ["index.html", "mixed.html", "prefix.bin", "invalid.bin", "document.xhtml"]) {
      const response = await worker.request(`https://rendro.test${base}?doc=${path}`, { headers });
      expect(response.status, path).toBe(path.endsWith(".html") ? 200 : 404);
    }
  }
});
