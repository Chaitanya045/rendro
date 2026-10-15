import type { User } from "better-auth/types";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
const storage = vi.hoisted(() => ({ copyObject: vi.fn(), headObject: vi.fn(), getObjectText: vi.fn(), listAllKeys: vi.fn(), putObject: vi.fn() }));
vi.mock("../src/minio", () => storage);
import deployments from "../src/routes/deployments";
import publications from "../src/routes/publication-api";
import migration from "../src/routes/migration";
import { proxyAuthRequest, proxyAuthSignOut, proxyConvexRequest } from "../src/auth-proxy";
import * as proxy from "../src/auth-proxy";
import { mountSessionRoutes } from "../src/app-routes";
import * as admission from "../shared/request-admission";
import { writeAdmission } from "../src/middleware/write-admission";

const file = { path: "index.html", sha256: "a".repeat(64), size: 1, contentType: "text/html" };
const manifest = { version: 1, files: [file] };
const scope = "?organizationId=org&projectId=project";
const headers = { authorization: "Bearer key", origin: "https://rendro.test", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const post = (body: unknown) => ({ method: "POST", headers, body: body === "invalid-json" ? "{" : JSON.stringify(body) });
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ deployment: { manifestKey: "manifest", previousDeploymentId: "previous" } }))));
  storage.getObjectText.mockResolvedValue(JSON.stringify(manifest));
  storage.headObject.mockResolvedValue({ size: 1, metadata: { sha256: file.sha256 } });
  storage.putObject.mockResolvedValue(undefined);
  storage.listAllKeys.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it("rejects malformed publication fields before upstream access", async () => {
  for (const body of [null, {}, { organizationId: "org" }, { organizationId: "org", projectId: "project" }, { organizationId: "org", projectId: "project", pathPrefix: "" }]) {
    expect((await publications.request("/api/rendro/publications", post(body))).status).toBe(400);
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects malformed deployment fields, manifests and checksums before upstream writes", async () => {
  const start = (body: unknown) => deployments.request("/api/rendro/deployments/start", post(body));
  for (const body of ["invalid-json", null, {}, { manifest }]) expect((await start(body)).status).toBe(400);
  for (const invalid of [null, {}, { version: 1 }, { version: 1, files: [null] }, { version: 1, files: [{}] }, { version: 1, files: [{ ...file, path: 1 }] }, { version: 1, files: [{ ...file, sha256: 1 }] }, { version: 1, files: [{ ...file, size: "1" }] }, { version: 1, files: [file, { ...file, path: "a.html" }] }]) {
    expect((await start({ organizationId: "org", projectId: "project", manifest: invalid })).status).toBe(400);
  }
  expect((await start({ organizationId: "org", projectId: "project", manifest, manifestSha256: "incorrect" })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([new Error("storage failed"), "storage failed"])("fails a deployment when initializing storage fails (%#)", async error => {
  const hash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  storage.putObject.mockRejectedValue(error);
  vi.mocked(fetch).mockResolvedValue(Response.json({ deployment: { deploymentId: "deployment", manifestKey: "manifest", treeIndexKey: "tree" } }));
  expect((await deployments.request("/api/rendro/deployments/start", post({ organizationId: "org", projectId: "project", manifest, manifestSha256: hash }))).status).toBe(502);
  expect(fetch).toHaveBeenCalledTimes(2);
  const init = vi.mocked(fetch).mock.calls[1][1]!;
  expect(JSON.parse(init.body as string)).toMatchObject({ deploymentId: "deployment", reason: "storage failed" });
  expect(new Headers(init.headers).get("origin")).toBe(headers.origin);
});
it("rejects missing manifest objects, malformed stored JSON and unlisted uploads", async () => {
  for (const text of [null, "{", JSON.stringify({ version: 1 })]) {
    storage.getObjectText.mockResolvedValue(text);
    expect(await (await deployments.request("/api/rendro/deployments/check")).json()).toMatchObject({ manifest: null });
    for (const operation of ["copy", "commit"]) {
      expect((await deployments.request(`/api/rendro/deployments/id/${operation}${scope}`, post({ paths: [] }))).status).toBe(404);
    }
  }
  storage.getObjectText.mockResolvedValue(JSON.stringify(manifest));
  expect((await deployments.request(`/api/rendro/deployments/id/files/missing.html${scope}`, { method: "PUT", body: "x" })).status).toBe(400);
});
it("rejects copy and commit requests without identity and handles absent predecessor", async () => {
  for (const operation of ["copy", "commit"]) expect((await deployments.request(`/api/rendro/deployments/id/${operation}`, post({}))).status).toBe(400);
  vi.mocked(fetch).mockResolvedValue(Response.json({ deployment: { manifestKey: "manifest" } }));
  expect((await deployments.request(`/api/rendro/deployments/id/copy${scope}`, post({}))).status).toBe(400);
});
it("validates copy requests and source metadata before copying", async () => {
  const copy = (body: unknown) => deployments.request(`/api/rendro/deployments/id/copy${scope}`, post(body));
  expect((await copy("invalid-json")).status).toBe(400);
  expect((await copy(null)).status).toBe(200);
  expect((await copy({ paths: [42] })).status).toBe(400);
  expect((await copy({ paths: ["missing.html"] })).status).toBe(500);
  for (const metadata of [null, { size: 2 }, { size: 1 }, { size: 1, metadata: { sha256: "wrong" } }]) {
    storage.headObject.mockResolvedValue(metadata);
    expect((await copy({ paths: ["index.html"] })).status).toBe(500);
  }
  expect(storage.copyObject).not.toHaveBeenCalled();
});
it("rejects incomplete deployment object sets at commit", async () => {
  for (const keys of [[], ["tenants/org/projects/project/deployments/id/files/other.html"]]) {
    storage.listAllKeys.mockResolvedValue(keys);
    expect((await deployments.request(`/api/rendro/deployments/id/commit${scope}`, post({}))).status).toBe(409);
  }
});
it("forwards Origin and Fetch Metadata through operator and generic proxies", async () => {
  for (const invoke of [() => migration.request("/api/rendro/migration/project", post({})), () => proxyConvexRequest(new Request("https://rendro.test/api/rendro/projects", post({})))]) {
    vi.mocked(fetch).mockClear();
    await invoke();
    const forwarded = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(forwarded.get("origin")).toBe(headers.origin);
    expect(forwarded.get("sec-fetch-site")).toBe(headers["sec-fetch-site"]);
  }
});
it("preserves admission failures and sanitizes unexpected middleware errors", async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", writeAdmission);
  app.post("/api/orgs", () => new Response("write"));
  app.onError(() => new Response("server error", { status: 500 }));
  vi.spyOn(admission, "requireCookieWrite").mockImplementation(() => { throw new Error("Unexpected admission failure"); });
  expect((await app.request("/api/orgs", post({}))).status).toBe(500);
});
it("keeps proxy exceptions on the mounted routes as backend errors", async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  mountSessionRoutes(app);
  for (const error of [new Error("offline"), "offline"]) {
    vi.spyOn(proxy, "proxyAuthRequest").mockRejectedValue(error);
    vi.spyOn(proxy, "proxyConvexRequest").mockRejectedValue(error);
    expect((await app.request("/api/auth/get-session")).status).toBe(502);
    expect((await app.request("/api/rendro/projects")).status).toBe(502);
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
