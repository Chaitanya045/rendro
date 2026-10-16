import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.doUnmock("../src/config"); vi.resetModules(); });
it.each([
  { CONVEX_URL: "", CONVEX_SITE_URL: "ftp://unsupported.test", expected: "connect-src 'self'" },
  { CONVEX_URL: "https://backend.test", CONVEX_SITE_URL: "https://site.test", expected: "wss://backend.test" },
])("handles absent, non-HTTP and TLS connection origins: $CONVEX_URL", async config => {
  vi.resetModules();
  vi.doMock("../src/config", () => config);
  const { securityHeaders } = await import("../src/middleware/security-headers");
  const app = new Hono().use(securityHeaders).get("/", c => c.html("<p>app</p>"));
  expect((await app.request("/")).headers.get("content-security-policy")).toContain(config.expected);
});
