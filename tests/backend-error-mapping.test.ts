import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { ConvexError } from "convex/values";
const mocks = vi.hoisted(() => ({ error: vi.fn(), getObjectText: vi.fn(), listAllKeys: vi.fn() }));
vi.mock("../src/logger", () => ({ logger: { error: mocks.error } }));
vi.mock("../src/minio", () => ({ ...mocks, putObject: vi.fn(), copyObject: vi.fn(), headObject: vi.fn() }));
import deploymentApp from "../src/routes/deployments";
import publicationApp from "../src/routes/publication-api";
import { proxyAuthSignOut, proxyConvexRequest } from "../src/auth-proxy";
import { backendFetch } from "../src/backend-fetch";
import { sha256 } from "../convex/credentialHttp";
import { failure, httpAction } from "../convex/httpErrors";
import { httpErrorMessage } from "../cli/src/http-error";

const privateMarkers = ["private-body-marker", "private-secret", "private-token", "private-cookie", "private-query", "private-password"];
const diagnostic = `ArgumentValidationError: ${privateMarkers.join(" ")}\n    at handler (convex/deployments.ts:12:3)`;
function expectPrivateLogs(calls: unknown) {
  // inspect includes non-enumerable Error messages/stacks, unlike JSON.stringify.
  const output = inspect(calls, { depth: null });
  for (const marker of privateMarkers) expect(output).not.toContain(marker);
  expect(output).not.toContain("ArgumentValidationError");
}
const query = "?organizationId=org&projectId=project";
const manifest = { version: 1, files: [] };
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(diagnostic, { status: 500, headers: { "x-internal-detail": "private" } }))));
  mocks.getObjectText.mockResolvedValue(JSON.stringify(manifest));
  mocks.listAllKeys.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

async function sanitized(response: Response) {
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Backend unavailable" });
  expect(response.headers.has("x-internal-detail")).toBe(false);
  expect(mocks.error).toHaveBeenCalledWith({ category: "UpstreamError", operation: expect.stringMatching(/^(proxyConvexRequest|deploymentRequest|publicationRequest)$/), status: 500 }, "Backend request failed");
  expectPrivateLogs(mocks.error.mock.calls);
}

describe("Worker backend error mapping", () => {
  it.each([
    ["GET", `/api/rendro/deployments/check${query}`],
    ["POST", "/api/rendro/deployments/fail"],
    ["PUT", `/api/rendro/deployments/deployment/files/index.html${query}`],
    ["POST", `/api/rendro/deployments/deployment/copy${query}`],
    ["POST", `/api/rendro/deployments/deployment/commit${query}`],
  ])("sanitizes %s %s", async (method, url) => {
    await sanitized(await deploymentApp.request(url, { method, body: method === "GET" ? undefined : "{}" }));
  });

  it("sanitizes start and the final commit call", async () => {
    await sanitized(await deploymentApp.request("/api/rendro/deployments/start", {
      method: "POST", body: JSON.stringify({ organizationId: "org", projectId: "project", manifest, manifestSha256: await sha256(JSON.stringify(manifest)) }),
    }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ deployment: { manifestKey: "manifest" } }));
    await sanitized(await deploymentApp.request(`/api/rendro/deployments/deployment/commit${query}`, { method: "POST" }));
  });

  it.each(["GET", "POST", "remove"])("sanitizes publication %s", async method => {
    const path = method === "remove" ? "/api/rendro/publications/remove" : `/api/rendro/publications${method === "GET" ? query : ""}`;
    await sanitized(await publicationApp.request(path, { method: method === "GET" ? "GET" : "POST", body: method === "GET" ? undefined : JSON.stringify({ organizationId: "org", projectId: "project", pathPrefix: "", entryFile: "index.html" }) }));
  });

  it("sanitizes the final publication write after successful preflight", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ deployment: { _id: "deployment", status: "active", manifestKey: "manifest" } }));
    mocks.getObjectText.mockResolvedValue(JSON.stringify({ version: 1, files: [{ path: "index.html", size: 1, sha256: "a".repeat(64), contentType: "text/html" }] }));
    await sanitized(await publicationApp.request("/api/rendro/publications", { method: "POST", body: JSON.stringify({ organizationId: "org", projectId: "project", pathPrefix: "", entryFile: "index.html" }) }));
  });

  it.each(["/api/rendro/projects/get", "/api/rendro/shares", "/api/auth/organization/get-full-organization"])("sanitizes generic proxy %s", async path => {
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
    }, "deploymentRequest");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Backend unavailable" });
    expect(mocks.error.mock.calls).toEqual([[{ category: "UpstreamError", operation: "deploymentRequest", status }, "Backend request failed"]]);
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
      headers: { cookie: "private-cookie" },
    }));
    expect(response.status).toBe(302);
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
    const response = failure(error, 409, "commitDeployment");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Request failed" });
    expect(log.mock.calls).toEqual([["HTTP request failed", { operation: "commitDeployment", category, status: 500 }]]);
    expectPrivateLogs(log.mock.calls);
  });
  it("catches unexpected failures outside local handler catches", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const action = httpAction(() => Promise.reject(new Error(diagnostic)));
    const handler = (action as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler;
    const response = await handler({}, new Request("https://rendro.test/api/rendro/deployments/active"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Request failed" });
    expect(console.error).toHaveBeenCalledWith("HTTP request failed", { category: "Error", operation: "httpAction", status: 500 });
    expectPrivateLogs(vi.mocked(console.error).mock.calls);
  });
});

describe("CLI error messages", () => {
  it("shows clean 4xx messages and suppresses backend diagnostics", async () => {
    expect(await httpErrorMessage(Response.json({ error: "Invalid ID" }, { status: 400 }))).toBe("400 Invalid ID");
    expect(await httpErrorMessage(Response.json({ error: "Project not found" }, { status: 404 }))).toBe("404 Project not found");
    expect(await httpErrorMessage(new Response(diagnostic, { status: 500 }))).toBe("500 Backend unavailable");
    expect(await httpErrorMessage(new Response("<html>Error</html>", { status: 403 }))).toBe("403 Request failed");
  });
});
