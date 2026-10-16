import { afterEach, describe, expect, it, vi } from "vitest";
import shareRoutes from "../src/routes/share-v2";
import * as storage from "../src/minio";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(directory: string, assetPaths?: string[]) {
  const files = [
    ["index.html", "text/html"], ["style", "text/css; charset=windows-1252"], ["image", "image/png"], ["font", "font/woff2"],
    ["script", "application/javascript"], ["sibling.json", "application/json"], ["sibling.pdf", "application/pdf"],
    ["README.md", "text/markdown"], [".env", "text/plain"], ["nested/private.json", "application/json"],
    ["other.htm", "text/html"], ["alias.png", "text/html; charset=utf-8"], ["other.xhtml", "application/xhtml+xml"],
    ["nested/image", "image/png"], ["font.woff2", "application/octet-stream"], ["missing", "text/css"],
  ].map(([path, contentType]) => ({ path: directory + path, contentType }));
  const grant = { documentPath: directory + "index.html", expiresAt: Date.now() + 60_000, ...(assetPaths === undefined ? {} : { assetPaths: assetPaths.map(path => directory + path) }) };
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ grant, project: { name: "Docs" }, deployment: { manifestKey: "root/manifest.json" } }))));
  vi.spyOn(storage, "getObjectText").mockResolvedValue(JSON.stringify({ files }));
  const read = vi.spyOn(storage, "getObjectStream").mockImplementation(key => Promise.resolve(key.endsWith("/missing") ? null : new Response(new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])).body));
  return { read, request: (path: string) => shareRoutes.request("/s/token/files/" + directory + path) };
}

describe.each(["", "guide/"])("share delivery under %j", directory => {
  it("serves exactly the manifest document and allowlist, denying HTML aliases even if listed", async () => {
    const f = fixture(directory, ["style", "image", "font", "script", "other.htm", "alias.png", "other.xhtml", "non-manifest.png", "missing"]);
    for (const path of ["index.html", "style", "image", "font", "script"]) expect((await f.request(path)).status).toBe(200);
    f.read.mockClear();
    for (const path of ["sibling.json", "sibling.pdf", "README.md", ".env", "nested/private.json", "other.htm", "alias.png", "other.xhtml", "non-manifest.png", "nested/image", "font.woff2"]) {
      const response = await f.request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(f.read).not.toHaveBeenCalled();
    expect((await f.request("missing")).status).toBe(404);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("restricts legacy grants to immediate-directory manifest CSS/image/font types", async () => {
    const f = fixture(directory);
    for (const path of ["index.html", "style", "image", "font"]) expect((await f.request(path)).status).toBe(200);
    f.read.mockClear();
    for (const path of ["script", "nested/image", "font.woff2", "sibling.json", "other.htm", "other.xhtml"]) expect((await f.request(path)).status).toBe(404);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("keeps an empty allowlist document-only and fails closed on unavailable manifests", async () => {
    const f = fixture(directory, []);
    expect((await f.request("style")).status).toBe(404);
    vi.mocked(storage.getObjectText).mockResolvedValue(null);
    expect((await f.request("index.html")).status).toBe(404);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("preserves streamed text charset and bytes (#138), including missing charset", async () => {
    const f = fixture(directory, ["style", "script"]);
    const css = await f.request("style?version=1");
    expect(css.headers.get("content-type")).toBe("text/css; charset=windows-1252");
    expect(new Uint8Array(await css.arrayBuffer())).toEqual(new Uint8Array([0x3c, 0x70, 0x3e, 0xe9]));
    expect((await f.request("script")).headers.get("content-type")).toBe("application/javascript");
  });
});
