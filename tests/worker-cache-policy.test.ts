import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { LAZY_TREE_VERSION } from "../src/viewer/asset-versions";
import { mockSecurityBackend } from "./fixtures/security-headers";

const routes = worker.routes.filter(route => route.method !== "ALL");
const pathFor = (path: string) => path.replace(/:[\w]+(?:\{[^}]+\})?/g, "synthetic-token").replaceAll("*", "synthetic-token");
beforeEach(mockSecurityBackend);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Worker cache policy from all actual route registrations", () => {
  it.each(routes)("$method $path is private across backend success, denial, failure and malformed input", async ({ method, path }) => {
    for (const status of [200, 403, 429, 500]) {
      vi.mocked(fetch).mockImplementation(() => Promise.resolve(Response.json({}, { status })));
      for (const body of ["{}", "{"]) {
        const response = await worker.request(`https://test${pathFor(path)}?token=synthetic-token`, {
          method, headers: { origin: "https://test", "content-type": "application/json", authorization: "Bearer synthetic-key" },
          ...(["GET", "HEAD"].includes(method) ? {} : { body }),
        });
        expect(response.headers.get("cache-control"), `${method} ${path} upstream=${status}`).toContain("no-store");
        if (/^\/api|:(?:token|viewerToken)/.test(path)) expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    }
  });
});

it("covers one-time capability pages, malformed paths and proxy failures", async () => {
  for (const path of ["/reset-password?token=invalid", "/reset-password/%ZZ", "/verify-email?token=invalid"]) {
    const response = await worker.request(`https://test${path}`);
    expect(response.headers.get("cache-control"), path).toBe("private, no-store");
    expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
  }
  vi.mocked(fetch).mockRejectedValue(new Error("synthetic transport fault"));
  for (const path of ["/api/auth/get-session", "/api/auth/list-accounts"]) {
    const response = await worker.request(`https://test${path}`);
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
});

it("preserves the reviewed JWKS and static asset exceptions", async () => {
  const response = await worker.request(`/lazy-tree.js?v=${LAZY_TREE_VERSION}`, {}, { ASSETS: { fetch: () => new Response("asset", { headers: { "Cache-Control": "public, max-age=0, must-revalidate" } }) } });
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  for (const [status, cookies, expected] of [
    [200, false, "public, max-age=300, must-revalidate"],
    [200, true, "private, no-store"],
    [403, false, "private, no-store"],
    [500, false, "private, no-store"],
  ] as const) {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(Response.json({}, { status, headers: cookies ? { "set-cookie": "session=synthetic" } : {} })));
    const jwks = await worker.request("https://test/api/auth/convex/jwks");
    expect(jwks.headers.get("cache-control")).toBe(expected);
  }
});
