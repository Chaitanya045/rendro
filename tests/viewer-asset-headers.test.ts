import { Hono } from "hono";
import { assetError } from "@/routes/asset-headers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetFixture, fixtureCookie, fontTypes, privateBase } from "./fixtures/viewer-assets";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(["public", "share", "private ticket", "private cookie"])("%s asset headers", name => {
  it.each(fontTypes)("serves %s fonts with the correct MIME and scoped CORS", async (extension, type) => {
    const { app, viewers } = await createAssetFixture();
    const viewer = viewers.find(viewer => viewer.name === name)!;
    for (const ext of [extension, extension.toUpperCase()]) {
      for (const origin of ["null", "https://untrusted.example"]) {
        const response = await app.request(`${viewer.prefix}assets/font.${ext}`, { headers: {
          Origin: origin, ...(viewer.cookie ? { Cookie: fixtureCookie } : {}),
        } });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe(type);
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(viewer.cors);
        expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
        expect(response.headers.get("Cache-Control")).toBe(name === "public"
          ? "public, max-age=0, must-revalidate" : "private, no-store");
        if (name !== "public") expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      }
    }
  });

  it("uses the same CORS policy for images, modules, fetches and HTML", async () => {
    const { app, viewers } = await createAssetFixture();
    const viewer = viewers.find(viewer => viewer.name === name)!;
    for (const [path, type] of [["assets/image.svg", "image/svg+xml"], ["assets/module.js", "application/javascript"],
      ["assets/data.json", "application/json"], ["index.html", "text/html"]]) {
      const response = await app.request(viewer.prefix + path, { headers: {
        Origin: "null", ...(viewer.cookie ? { Cookie: fixtureCookie } : {}),
      } });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")?.split(";")[0]).toBe(type);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(viewer.cors);
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      if (path.endsWith(".html")) {
        expect(response.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
        expect(response.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
      }
    }
  });
});

it("does not grant CORS access to missing or unauthorized assets", async () => {
  const { app, backend, objects, viewers } = await createAssetFixture();
  for (const viewer of viewers) {
    const missing = await app.request(`${viewer.prefix}assets/missing.woff2`, { headers: { Origin: "null" } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Access-Control-Allow-Origin")).toBeNull();
  }
  const canonical = await app.request(`${privateBase}/files/guide/assets/font.woff2`, { headers: { Origin: "null" } });
  expect(canonical.status).toBe(404);
  expect(canonical.headers.get("Access-Control-Allow-Origin")).toBeNull();
  backend.mockImplementation(() => Promise.resolve(new Response(null, { status: 404 })));
  objects.mockClear();
  for (const viewer of viewers) {
    const revoked = await app.request(`${viewer.prefix}assets/font.woff2`, { headers: {
      Origin: "null", ...(viewer.cookie ? { Cookie: fixtureCookie } : {}),
    } });
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get("Access-Control-Allow-Origin")).toBeNull();
  }
  expect(objects).not.toHaveBeenCalled();
});

describe.each(["public", "share", "private ticket", "private cookie"])("%s asset errors", name => {
  it.each([
    ["missing.PNG", "*/*"], ["missing.woff2", "*/*"], ["missing.CSS", "*/*"], ["missing.mjs", "*/*"],
    ["missing", "image/avif,image/webp,*/*;q=0.8"], ["missing", "font/woff2"],
    ["missing", "text/css,*/*;q=0.1"], ["missing", "application/javascript"],
  ])("uses empty untyped failures for %s (%s)", async (path, accept) => {
    const { app, viewers, backend } = await createAssetFixture();
    const viewer = viewers.find(viewer => viewer.name === name)!;
    const headers = { Accept: accept, ...(viewer.cookie ? { Cookie: fixtureCookie } : {}) };
    for (const denied of [false, true]) {
      if (denied) backend.mockImplementation(() => Promise.resolve(new Response(null, { status: 403 })));
      const result = await app.request(viewer.prefix + path, { headers });
      expect(result.status).toBe(404);
      expect(result.headers.get("Content-Type")).toBeNull();
      expect(result.headers.get("X-Content-Type-Options")).toBeNull();
      expect(result.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await result.text()).toBe("");
    }
    const document = await app.request(viewer.prefix + "missing.html", { headers: { ...headers, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8" } });
    expect(document.status).toBe(404);
    expect(document.headers.get("Content-Type")).toContain("text/html");
    expect(await document.text()).toContain("<!DOCTYPE html>");
  });
});

it("preserves a forbidden status for empty asset errors", async () => {
  const app = new Hono();
  app.get("/*", c => assetError(c, () => "<h1>Forbidden</h1>", 403));
  const result = await app.request("/image%2Epng");
  expect(result.status).toBe(403);
  expect(result.headers.get("X-Content-Type-Options")).toBeNull();
  expect(await result.text()).toBe("");
});

it.each([400, 401, 403, 404, 429, 500, 502, 503, 504] as const)("preserves status %s and retry headers without caching asset errors", async status => {
  const app = new Hono();
  const html = vi.fn(() => "<!DOCTYPE html><h1>Temporarily unavailable</h1>");
  app.get("/*", c => {
    c.header("Cache-Control", "public, max-age=3600");
    c.header("Retry-After", "9");
    return assetError(c, html, status);
  });
  for (const path of ["image.png", "font.woff2", "style.css", "script.js"]) {
    const response = await app.request(`/${path}`);
    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Type")).toBeNull();
    expect(response.headers.get("Retry-After")).toBe("9");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBeNull();
    expect(await response.text()).not.toMatch(/<[^>]+>/);
  }
  expect(html).not.toHaveBeenCalled();
  const document = await app.request("/index.html", { headers: { Accept: "text/html,image/webp,*/*" } });
  expect(document.status).toBe(status);
  expect(document.headers.get("Content-Type")).toContain("text/html");
  expect(document.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await document.text()).toContain("<!DOCTYPE html>");
});
