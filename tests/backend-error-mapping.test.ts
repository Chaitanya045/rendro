import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { ConvexError } from "convex/values";
const mocks = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../src/logger", () => ({ logger: { error: mocks.error } }));
import { proxyAuthSignOut, proxyConvexRequest } from "../src/auth-proxy";
import { backendFetch } from "../src/backend-fetch";
import { failure, httpAction } from "../convex/httpErrors";

const privateMarkers = ["private-body-marker", "private-secret", "private-token", "private-cookie", "private-query", "private-password"];
const diagnostic = `ArgumentValidationError: ${privateMarkers.join(" ")}\n    at handler (convex/projects.ts:12:3)`;
function expectPrivateLogs(calls: unknown) {
  // inspect includes non-enumerable Error messages/stacks, unlike JSON.stringify.
  const output = inspect(calls, { depth: null });
  for (const marker of privateMarkers) expect(output).not.toContain(marker);
  expect(output).not.toContain("ArgumentValidationError");
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(diagnostic, { status: 500, headers: { "x-internal-detail": "private" } }))));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

async function sanitized(response: Response) {
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Backend unavailable" });
  expect(response.headers.has("x-internal-detail")).toBe(false);
  expect(mocks.error).toHaveBeenCalledWith({ category: "UpstreamError", operation: "proxyConvexRequest", status: 500 }, "Backend request failed");
  expectPrivateLogs(mocks.error.mock.calls);
}

describe("Worker backend error mapping", () => {
  it.each(["/api/rendro/projects/get", "/api/rendro/credentials", "/api/auth/organization/get-full-organization"])("sanitizes generic proxy %s", async path => {
    await sanitized(await proxyConvexRequest(new Request(`https://rendro.test${path}`)));
  });

  it("preserves controlled 4xx and successful responses", async () => {
    for (const status of [200, 400, 403, 404]) {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Invalid ID" }, { status }));
      const response = await proxyConvexRequest(new Request("https://rendro.test/api/rendro/projects/get"));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "Invalid ID" });
    }
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each([500, 503, 599])("logs only fixed metadata for upstream %s", async status => {
    const upstream = Response.json({ error: diagnostic, code: "private-secret" }, {
      status, headers: { "set-cookie": "private-cookie", "x-internal-detail": "private-token" },
    });
    vi.mocked(fetch).mockResolvedValueOnce(upstream);
    const response = await backendFetch("https://user:private-password@backend.test/private-secret?token=private-query", {
      method: "POST", body: diagnostic,
      headers: { authorization: "Bearer private-token", cookie: "private-cookie" },
    }, "proxyConvexRequest");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Backend unavailable" });
    expect(mocks.error.mock.calls).toEqual([[{ category: "UpstreamError", operation: "proxyConvexRequest", status }, "Backend request failed"]]);
    expectPrivateLogs(mocks.error.mock.calls);
    expect(upstream.bodyUsed).toBe(false);
  });

  it.each([
    new Error(diagnostic, { cause: { token: "private-token" } }),
    new TypeError(diagnostic),
    { message: diagnostic, token: "private-token" },
    diagnostic,
  ])("maps transport failures without logging exceptions (%#)", async error => {
    vi.mocked(fetch).mockRejectedValueOnce(error);
    const response = await proxyConvexRequest(new Request("https://rendro.test/api/rendro/projects/get?token=private-query", {
      headers: { cookie: "private-cookie" },
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Backend unavailable" });
    expect(mocks.error.mock.calls).toEqual([[{ category: "TransportError", operation: "proxyConvexRequest", status: null }, "Backend request failed"]]);
    expectPrivateLogs(mocks.error.mock.calls);
  });

  it("keeps sign-out transport diagnostics private", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error(diagnostic));
    const response = await proxyAuthSignOut(new Request("https://rendro.test/api/auth/sign-out?token=private-query", {
      method: "POST", headers: { cookie: "private-cookie", origin: "https://rendro.test" },
    }));
    expect(response.status).toBe(502);
    expect(mocks.error.mock.calls).toEqual([[{ category: "TransportError", operation: "proxyAuthSignOut", status: null }, "Auth sign-out proxy error"]]);
    expectPrivateLogs(mocks.error.mock.calls);
  });
});

describe("Convex HTTP error boundary", () => {
  it.each([
    ["invalid_id", 400], ["invalid_input", 400], ["not_found", 404],
    ["unauthenticated", 401], ["forbidden", 403], ["conflict", 409],
  ] as const)("maps structured %s failures without exposing the runtime message", async (code, status) => {
    const error = new ConvexError({ code, message: "Safe error" });
    error.message = diagnostic;
    const response = failure(error, 500);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Safe error" });
  });
  it("uses only structured application data, never wrapped stack messages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new ConvexError("Invalid ID");
    error.message = diagnostic;
    const response = failure(error, 409);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid ID" });
    expect(console.error).not.toHaveBeenCalled();
  });
  it.each([
    [new Error(diagnostic), "Error"],
    [new TypeError(diagnostic), "TypeError"],
    [new RangeError(diagnostic), "RangeError"],
    [new ConvexError({ message: diagnostic, token: "private-token" }), "Error"],
    [{ message: diagnostic, token: "private-token" }, "Unknown"],
  ])("logs only safe Convex failure metadata (%#)", async (error, category) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = failure(error, 409, "createProject");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Request failed" });
    expect(log.mock.calls).toEqual([["HTTP request failed", { operation: "createProject", category, status: 500 }]]);
    expectPrivateLogs(log.mock.calls);
  });
  it("catches unexpected failures outside local handler catches", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const action = httpAction(() => Promise.reject(new Error(diagnostic)));
    const handler = (action as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler;
    const response = await handler({}, new Request("https://rendro.test/api/rendro/projects"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Request failed" });
    expect(console.error).toHaveBeenCalledWith("HTTP request failed", { category: "Error", operation: "httpAction", status: 500 });
    expectPrivateLogs(vi.mocked(console.error).mock.calls);
  });
});
