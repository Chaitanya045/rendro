import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import { fontCacheControl, fontResponseHeaders, renderFontHead } from "@/routes/fonts";
import { fontManifest } from "@/routes/font-manifest";
import { securityHeaders } from "@/middleware/security-headers";
import { Hono } from "hono";

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
import { app as local } from "@/index";

const fontFiles = [fontManifest.icons.file, ...fontManifest.inter.faces.map(face => face.file)];
const licenses = ["LICENSE-Inter-OFL-1.1.txt", "LICENSE-Material-Symbols-Apache-2.0.txt"];

afterEach(() => vi.restoreAllMocks());

describe("self-hosted font response headers", () => {
  it("marks content-hashed woff2 files immutable with the font MIME type", () => {
    expect(fontCacheControl).toBe("public, max-age=31536000, immutable");
    for (const file of fontFiles) {
      expect(file).toMatch(/\.[0-9a-f]{10}\.woff2$/);
      expect(fontResponseHeaders(`/fonts/${file}`)).toEqual({ "Content-Type": "font/woff2", "Cache-Control": fontCacheControl });
    }
  });

  it("serves license texts as plain text with a short cache", () => {
    for (const file of licenses) expect(fontResponseHeaders(`/fonts/${file}`)).toEqual({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" });
  });

  it.each([
    "/fonts/inter-latin.woff2", "/fonts/inter-latin.ABCDEF0123.woff2", "/fonts/inter-latin.abcdef012.woff2",
    "/fonts/inter-latin.abcdef0123.ttf", "/fonts/sub/inter-latin.abcdef0123.woff2", "/fonts/", "/fonts/LICENSE.sh",
    "/fonts/../worker.ts", "/fonts/%2e%2e/worker.ts",
  ])("does not treat %s as a font asset", path => expect(fontResponseHeaders(path)).toBeUndefined());
});

describe("Node and Worker serve fonts identically", () => {
  const assetsFor = (bytes: Buffer) => ({ fetch: vi.fn(() => Promise.resolve(new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=0, must-revalidate" } }))) });

  it.each([...fontFiles, ...licenses])("serves %s without authentication or third-party requests", async file => {
    const path = `/fonts/${file}`;
    const bytes = readFileSync(`public${path}`);
    const assets = assetsFor(bytes);
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockClear();
    const expected = fontResponseHeaders(path)!;
    for (const response of [await local.request(path), await worker.request(path, {}, { ASSETS: assets })]) {
      expect(response.status).toBe(200);
      for (const [name, value] of Object.entries(expected)) expect(response.headers.get(name)).toBe(value);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    expect(assets.fetch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers HEAD with the same headers and no body", async () => {
    const path = `/fonts/${fontManifest.icons.file}`;
    for (const response of [await local.request(path, { method: "HEAD" }), await worker.request(path, { method: "HEAD" }, { ASSETS: assetsFor(readFileSync(`public${path}`)) })]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(fontCacheControl);
      expect(await response.text()).toBe("");
    }
  });

  it.each(["/fonts/inter-latin.woff2", "/fonts/README.md", "/fonts/"])("returns an empty 404 for %s", async path => {
    const assets = assetsFor(Buffer.from("must not be served"));
    for (const response of [await local.request(path), await worker.request(path, {}, { ASSETS: assets })]) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it("does not cache a missing hashed font as immutable", async () => {
    const path = "/fonts/inter-latin.0123456789.woff2";
    const response = await worker.request(path, {}, { ASSETS: { fetch: () => new Response("missing", { status: 404 }) } });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).not.toBe("font/woff2");
    const localMissing = await local.request(path);
    expect(localMissing.status).toBe(404);
    expect(localMissing.headers.get("cache-control")).toBe("private, no-store");
  });

  it("falls back to the styled 404 when the Worker has no assets binding", async () => {
    const response = await worker.request(`/fonts/${fontManifest.icons.file}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("font/woff2");
    expect(response.headers.get("cache-control")).not.toContain("immutable");
  });

  it("keeps the outer security headers on font responses without replacing their cache policy", async () => {
    const app = new Hono().use(securityHeaders).get("/fonts/x", c => c.body("x", 200, fontResponseHeaders(`/fonts/${fontFiles[0]}`)!));
    const response = await app.request("https://rendro.test/fonts/x");
    expect(response.headers.get("cache-control")).toBe(fontCacheControl);
    expect(response.headers.get("strict-transport-security")).toBe("max-age=15552000");
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});

describe("font document head", () => {
  const origin = /(?:https?:)?\/\/[a-z0-9.-]+/i;

  it("preloads the Latin file and the icon font with crossorigin, from this origin only", () => {
    const head = renderFontHead({ icons: true });
    expect(head).toContain(`<link rel="preload" href="/fonts/${fontManifest.inter.faces[0].file}" as="font" type="font/woff2" crossorigin>`);
    expect(head).toContain(`<link rel="preload" href="/fonts/${fontManifest.icons.file}" as="font" type="font/woff2" crossorigin>`);
    expect(head.match(/rel="preload"/g)).toHaveLength(2);
    expect(head).not.toMatch(origin);
  });

  it("uses swap for Inter and block for the icon font", () => {
    const css = renderFontHead({ icons: true });
    const faces = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map(match => match[1]);
    const inter = faces.filter(face => face.includes("font-family:Inter"));
    const icon = faces.filter(face => face.includes('font-family:"Material Symbols Outlined"'));
    expect(inter).toHaveLength(fontManifest.inter.faces.length * fontManifest.inter.weights.length);
    expect(inter.every(face => face.includes("font-display:swap") && face.includes('format("woff2")'))).toBe(true);
    expect(icon).toHaveLength(1);
    expect(icon[0]).toContain("font-display:block");
    for (const weight of fontManifest.inter.weights) expect(inter.some(face => face.includes(`font-weight:${weight};`))).toBe(true);
  });

  it("declares the more specific Latin subset last so it wins overlapping code points", () => {
    const css = renderFontHead();
    expect(css.lastIndexOf(fontManifest.inter.faces[0].file)).toBeGreaterThan(css.indexOf(fontManifest.inter.faces[1].file));
  });

  it("bounds every icon box so a missing font cannot change layout", () => {
    const rule = renderFontHead({ icons: true }).match(/\.material-symbols-outlined\{([^}]*)\}/)![1];
    for (const declaration of ['font-family:"Material Symbols Outlined"', "display:inline-block", "flex:none", "width:1em", "overflow:hidden", "white-space:nowrap"]) expect(rule).toContain(declaration);
  });

  it("omits the icon font on pages without icons and honors a weight subset", () => {
    const head = renderFontHead({ weights: [400, 600, 700] });
    expect(head).not.toContain("Material Symbols");
    expect(head).not.toContain(fontManifest.icons.file);
    expect(head.match(/rel="preload"/g)).toHaveLength(1);
    expect(head).not.toContain("font-weight:500;");
    expect(head).toContain("font-weight:600;");
  });
});
