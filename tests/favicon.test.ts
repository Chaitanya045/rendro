import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import { faviconAssets, faviconCacheControl } from "@/routes/favicon";

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
import { app as local } from "@/index";

describe("public favicon assets", () => {
  it.each(Object.entries(faviconAssets))("serves %s in Node and the Worker without authentication", async (path, contentType) => {
    const bytes = readFileSync(`public${path}`);
    const assets = { fetch: vi.fn(() => Promise.resolve(new Response(bytes))) };
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockClear();
    for (const response of [await local.request(path), await worker.request(path, {}, { ASSETS: assets })]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("cache-control")).toBe(faviconCacheControl);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    expect(assets.fetch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    if (path.endsWith(".ico")) expect([...bytes.subarray(0, 6)]).toEqual([0, 0, 1, 0, 2, 0]);
    else expect(bytes.toString()).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  });

  it("does not label or cache a missing asset as an icon", async () => {
    const response = await worker.request("/favicon.svg", {}, { ASSETS: { fetch: () => new Response("missing", { status: 404 }) } });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBeNull();
  });
});
