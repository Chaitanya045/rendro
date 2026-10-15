import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/logger";
import worker from "@/worker";
import * as minio from "@/minio";
import * as deletion from "@/soft-delete";
import { createLegacyViewerTicket } from "@/viewer-ticket";
import { mockSecurityBackend } from "./fixtures/security-headers";

const cookie = "better-auth.session_token=test-session";
const request = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://rendro.test${path}`, { headers }), {});

beforeEach(() => {
  mockSecurityBackend();
  vi.spyOn(logger, "debug").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(deletion, "isDeleted").mockResolvedValue(false);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function errorResponse(response: Response, status: number, asset: boolean, retryAfter = "1") {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe(asset ? null : "nosniff");
  expect(response.headers.get("Retry-After")).toBe(status === 503 ? retryAfter : null);
  expect(response.headers.has("Location")).toBe(false);
  expect(response.headers.has("Set-Cookie")).toBe(false);
  const body = await response.text();
  expect(body).not.toContain("private-backend-detail");
  if (asset) {
    expect(response.headers.get("Content-Type")).toBeNull();
    expect(body).toBe("");
  } else {
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const nonce = response.headers.get("Content-Security-Policy")?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    const tags = [...body.matchAll(/<(?:script|style)\b[^>]*>/g)];
    expect(tags.length).toBeGreaterThan(0);
    for (const [tag] of tags) expect(tag).toContain(`nonce="${nonce}"`);
    if (status === 503) expect(body).toContain('<a class="retry" href="">Try again</a>');
    else expect(body).toContain("Page not found");
  }
}

const viewers = [
  { name: "public", base: () => Promise.resolve("/p/product") },
  { name: "share", base: () => Promise.resolve("/s/share-token") },
  { name: "legacy", base: async () => `/legacy-view/example/view/${await createLegacyViewerTicket("example", cookie)}` },
];

for (const viewer of viewers) describe(`${viewer.name} viewer backend failures`, () => {
  // Each request reaches the real route and security middleware.
  for (const asset of [false, true]) describe(asset ? "asset" : "document", () => {
    const suffix = asset ? "/files/assets/site.css" : "/files/index.html";
    it.each([400, 401, 403, 404, 410])("preserves indistinguishable denials for upstream %s", async status => {
      const base = await viewer.base();
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("private-backend-detail", { status }))));
      await errorResponse(await request(base + suffix), viewer.name === "legacy" ? 503 : 404, asset);
      expect(minio.getObjectStream).not.toHaveBeenCalled();
    });
    it("keeps revoked, expired or absent resolutions at 404", async () => {
      const base = await viewer.base();
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json(null))));
      await errorResponse(await request(base + suffix), viewer.name === "legacy" ? 503 : 404, asset);
      expect(minio.getObjectStream).not.toHaveBeenCalled();
    });
    it.each([408, 429, 500, 502, 503, 504])("returns retryable 503 for upstream %s", async status => {
      const base = await viewer.base();
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("private-backend-detail", { status, headers: { "Retry-After": "7" } }))));
      await errorResponse(await request(base + suffix), 503, asset, "7");
      expect(minio.getObjectStream).not.toHaveBeenCalled();
    });
    it("returns retryable 503 on transport failure", async () => {
      const base = await viewer.base();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private-backend-detail")));
      await errorResponse(await request(base + suffix), 503, asset);
    });
    it.each([false, true])("bounds stalled lookup/body (body=%s)", async body => {
      const base = await viewer.base();
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal!;
        return body ? Promise.resolve(new Response(new ReadableStream())) : new Promise<Response>(() => {});
      }));
      const pending = request(base + suffix);
      await vi.waitFor(() => expect(signal).toBeDefined());
      await vi.advanceTimersByTimeAsync(5_000);
      await errorResponse(await pending, 503, asset);
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
    it("keeps missing storage objects at 404", async () => {
      vi.mocked(minio.getObjectStream).mockResolvedValue(null);
      await errorResponse(await request(await viewer.base() + suffix), 404, asset);
    });
    it.each(["5xx", "timeout"])("returns 503 for storage %s", async kind => {
      const error = kind === "timeout" ? new DOMException("private-backend-detail", "TimeoutError")
        : Object.assign(new Error("private-backend-detail"), { $metadata: { httpStatusCode: 503 } });
      vi.mocked(minio.getObjectStream).mockRejectedValue(error);
      await errorResponse(await request(await viewer.base() + suffix), 503, asset);
    });
    it("leaves successful content and caching unchanged", async () => {
      const response = await request(await viewer.base() + suffix);
      expect(response.status).toBe(200);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe(viewer.name === "public" ? "public, max-age=0, must-revalidate" : "private, no-store");
      expect(await response.text()).toContain(asset ? "body{color:" : "Publisher document");
    });
  });
  it.each(["0", "invalid", "date"])("normalizes Retry-After %s", async value => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const base = await viewer.base();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 429, headers: {
      "Retry-After": value === "date" ? new Date(Date.now() + 60_000).toUTCString() : value,
    } }))));
    await errorResponse(await request(base + "/files/index.html"), 503, false, value === "date" ? "60" : "1");
  });
  it("treats malformed JSON as retryable", async () => {
    const base = await viewer.base();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("private-backend-detail"))));
    await errorResponse(await request(base + "/files/index.html"), 503, false);
  });
});

it.each(["/p/product", "/s/share-token", "/s/tree", "/p/product/files/tree"])("returns a styled uncached 503 for the %s shell", async path => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))));
  await errorResponse(await request(path), 503, false);
});
it.each([404, 503])("returns uncached public tree errors (%s)", async status => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status }))));
  const response = await request("/p/product/tree");
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.get("Retry-After")).toBe(status === 503 ? "1" : null);
});
it.each(["index.html", "assets/site.css"])("classifies canonical legacy session failures for %s", async path => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 503, headers: { "Retry-After": "7" } }))));
  await errorResponse(await request(`/legacy-view/example/files/${path}`, { cookie }), 503, path.endsWith(".css"), "7");
});
it("ignores an ambient session when revalidating a legacy ticket", async () => {
  const base = await viewers[2].base();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (!(input instanceof Request ? input.url : input.toString()).endsWith("/api/query")) {
      expect((input instanceof Request ? input.url : input.toString())).toContain("management/access");
      expect(new Headers(init?.headers).get("cookie")).toBe(cookie);
    }
    return original(input, init);
  });
  expect((await request(base + "/files/index.html", { cookie: "better-auth.session_token=unrelated" })).status).toBe(200);
});
it.each(["index.html", "assets/site.css"])("keeps deleted legacy %s at 404", async path => {
  vi.mocked(deletion.isDeleted).mockResolvedValue(true);
  await errorResponse(await request(await viewers[2].base() + "/files/" + path), 404, path.endsWith(".css"));
  expect(minio.getObjectStream).not.toHaveBeenCalled();
});
it.each([500, 429])("fails closed on legacy deletion backend %s", async status => {
  vi.mocked(deletion.isDeleted).mockRestore();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => (input instanceof Request ? input.url : input.toString()).endsWith("/api/query")
    ? Promise.resolve(new Response(null, { status })) : original(input, init));
  await errorResponse(await request(await viewers[2].base() + "/files/index.html"), 503, false);
  expect(minio.getObjectStream).not.toHaveBeenCalled();
});
it.each(["/p/product", "/s/share-token"])("keeps missing %s shells uncached", async path => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
  await errorResponse(await request(path), 404, false);
});
it.each(["/p/product", "/p/product/files/index.html", "/p/product/files/assets/site.css"])("returns 503 for failed manifest reads at %s", async path => {
  vi.mocked(minio.getObjectText).mockRejectedValue(new Error("private-backend-detail"));
  await errorResponse(await request(path), 503, path.endsWith(".css"));
});
it.each([false, true])("honors a real legacy deletion result (%s)", async deleted => {
  vi.mocked(deletion.isDeleted).mockRestore();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => (input instanceof Request ? input.url : input.toString()).endsWith("/api/query") && JSON.parse(init?.body as string).path === "deletedFiles:isDeleted"
    ? Promise.resolve(Response.json({ status: "success", value: deleted })) : original(input, init));
  const response = await request(await viewers[2].base() + "/files/index.html");
  if (deleted) await errorResponse(response, 404, false);
  else expect(response.status).toBe(200);
});
it("rejects an expired legacy ticket without consulting the failing backend", async () => {
  vi.useFakeTimers();
  const base = await viewers[2].base();
  vi.advanceTimersByTime(16 * 60_000);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private-backend-detail")));
  await errorResponse(await request(base + "/files/index.html"), 404, false);
  expect(fetch).not.toHaveBeenCalled();
});
