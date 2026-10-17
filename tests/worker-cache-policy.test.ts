import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { createShareToken } from "../src/share-links";
import { MANAGEMENT_QUERY_VERSION } from "../src/routes/management-asset-versions";
import { mockSecurityBackend, docsBase } from "./fixtures/security-headers";

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

it("covers successful one-time/capability delivery, legacy denials, malformed paths and proxy failures", async () => {
  const token = createShareToken("example/index.html");
  for (const path of [`/share/${token}`, "/s/test", "/s/test/files/index.html", `${docsBase}/files/index.html`, `${docsBase}/viewer-ticket?manifestKey=tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json`]) {
    const response = await worker.request(`https://test${path}`, { headers: { cookie: "better-auth.session_token=test-session" } });
    expect(response.status, path).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  for (const path of ["/share/invalid", "/share/%ZZ", "/share/invalid/extra", "/s/test/extra", "/s/%ZZ/files/%ZZ", "/accept-invitation/invalid", "/reset-password?token=invalid", "/verify-email?token=invalid"]) {
    const response = await worker.request(`https://test${path}`);
    expect(response.headers.get("cache-control"), path).toBe("private, no-store");
    expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
  }
  vi.mocked(fetch).mockRejectedValue(new Error("synthetic transport fault"));
  for (const path of ["/api/auth/get-session", "/api/rendro/shares", "/api/rendro/credentials"]) {
    const response = await worker.request(`https://test${path}`);
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
});

it("preserves the reviewed JWKS, static asset and public publication exceptions", async () => {
  for (const path of ["/p/product/files/index.html", "/p/docs/files/index.html", "/public/example/product/files/index.html", "/p/product/tree"]) {
    const response = await worker.request(`https://test${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  }
  const response = await worker.request(`/management-query.js?v=${MANAGEMENT_QUERY_VERSION}`, {}, { ASSETS: { fetch: () => new Response("asset", { headers: { "Cache-Control": "public, max-age=0, must-revalidate" } }) } });
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
