import type { User } from "better-auth/types";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { proxyAuthRequest, proxyAuthSignOut, proxyConvexRequest } from "../src/auth-proxy";
import * as proxy from "../src/auth-proxy";
import { mountSessionRoutes } from "../src/app-routes";
import * as admission from "../shared/request-admission";
import { writeAdmission } from "../src/middleware/write-admission";

const headers = { origin: "https://rendro.test", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const post = (body: unknown) => ({ method: "POST", headers, body: JSON.stringify(body) });
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({}))));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it("forwards Origin and Fetch Metadata through the generic proxy", async () => {
  await proxyConvexRequest(new Request("https://rendro.test/api/auth/set-initial-password", post({})));
  const forwarded = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
  expect(forwarded.get("origin")).toBe(headers.origin);
  expect(forwarded.get("sec-fetch-site")).toBe(headers["sec-fetch-site"]);
});
it("preserves admission failures and sanitizes unexpected middleware errors", async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", writeAdmission);
  app.post("/api/auth/set-initial-password", () => new Response("write"));
  app.onError(() => new Response("server error", { status: 500 }));
  vi.spyOn(admission, "requireCookieWrite").mockImplementation(() => { throw new Error("Unexpected admission failure"); });
  expect((await app.request("/api/auth/set-initial-password", post({}))).status).toBe(500);
});
it("keeps proxy exceptions on the mounted routes as backend errors", async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  mountSessionRoutes(app);
  for (const error of [new Error("offline"), "offline"]) {
    vi.spyOn(proxy, "proxyAuthRequest").mockRejectedValue(error);
    expect((await app.request("/api/auth/get-session")).status).toBe(502);
  }
});
it("handles absent and malformed session responses and cookie-header compatibility", async () => {
  for (const body of ["not-json", "null"]) {
    vi.mocked(fetch).mockResolvedValue(new Response(body));
    expect((await proxyAuthRequest(new Request("https://rendro.test/api/auth/get-session"))).status).toBe(200);
  }
  const response = new Response("ok", { headers: { "set-cookie": "session=test; Domain=backend.test; Path=/" } });
  Object.defineProperty(response.headers, "getSetCookie", { value: undefined });
  vi.mocked(fetch).mockResolvedValue(response);
  expect((await proxyConvexRequest(new Request("https://rendro.test/api/auth/session"))).headers.get("set-cookie")).not.toContain("Domain");
});
it("supports JSON sign-out success, rejection and method responses", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ status: true }));
  for (const [method, origin, status] of [["POST", "https://rendro.test", 200], ["POST", "null", 403], ["DELETE", "https://rendro.test", 405]] as const) {
    const response = await proxyAuthSignOut(new Request("https://rendro.test/api/auth/sign-out", { method, headers: { origin, accept: "application/json" } }));
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/json");
  }
});
