import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { anonymousAdmission } from "../src/middleware/anonymous-admission";
import { registerAuthClientIp } from "../src/auth-client-ip";
import { AUTH_CLIENT_IP_HEADER, verifiedAuthRequest } from "../shared/auth-client-ip";

const app = new Hono();
app.use("*", anonymousAdmission);
const work = vi.fn(() => Response.json({ content: true }));
app.get("*", work);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
it("admits legacy public work with a signed IP and no caller-controlled forwarding headers", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const verified = await verifiedAuthRequest(new Request(url, init), process.env.CONVEX_INTERNAL_SECRET);
    expect(verified.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("192.0.2.1");
    return Response.json({ admitted: true });
  }));
  const request = new Request("https://rendro.test/public/old/docs", { headers: { "x-forwarded-for": "192.0.2.9" } });
  registerAuthClientIp(request, "192.0.2.1");
  expect((await app.request(request)).status).toBe(200);
  expect(work).toHaveBeenCalledOnce();
});
it.each([429, 503, 404, 200])("fails closed on denied or malformed legacy admission (%s)", async status => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({}, { status, headers: { "Retry-After": "7" } }))));
  const response = await app.request("/share/invalid");
  expect(response.status).toBe(status === 429 ? 429 : 503);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("retry-after")).toBe([429, 503].includes(status) ? "7" : "1");
  expect(work).not.toHaveBeenCalled();
});

it("fails closed when IP signing fails or admission returns null", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json(null))));
  expect((await app.request("/public/old/docs")).status).toBe(503);
  const ingress = await import("../src/auth-client-ip");
  vi.spyOn(ingress, "authClientIpHeaders").mockRejectedValue(new Error("signing unavailable"));
  expect((await app.request("/public/old/docs")).status).toBe(503);
  expect(work).not.toHaveBeenCalled();
});

it("forwards verified ingress proofs from modern publication and share resolvers", async () => {
  const [{ default: publications }, { default: shares }] = await Promise.all([
    import("../src/routes/public-v2"), import("../src/routes/share-v2"),
  ]);
  const routes = new Hono();
  routes.route("/", publications);
  routes.route("/", shares);
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const verified = await verifiedAuthRequest(new Request(url, init), process.env.CONVEX_INTERNAL_SECRET);
    expect(verified.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("192.0.2.1");
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  for (const path of ["/p/missing", "/s/missing"]) {
    const request = new Request("https://rendro.test" + path);
    registerAuthClientIp(request, "192.0.2.1");
    expect((await routes.request(request)).status).toBe(404);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
});
