import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
const storage = vi.hoisted(() => ({ copyObject: vi.fn(), getObjectText: vi.fn(), headObject: vi.fn(), listAllKeys: vi.fn(), putObject: vi.fn() }));
vi.mock("../src/minio", () => storage);
import deployments from "../src/routes/deployments";
import publications from "../src/routes/publication-api";
import { proxyConvexRequest } from "../src/auth-proxy";
import { registerAuthClientIp } from "../src/auth-client-ip";
import { AUTH_CLIENT_IP_HEADER, verifiedAuthRequest } from "../shared/auth-client-ip";
import { sha256 } from "../convex/credentialHash";

const app = new Hono().route("/", deployments).route("/", publications);
app.all("/api/rendro/*", c => proxyConvexRequest(c.req.raw));
const query = "?organizationId=org&projectId=project";
const routes = [
  ["GET", `credentials/validate${query}&scope=docs:read`, "credentials/validate", "GET"],
  ["GET", `deployments/check${query}`, "deployments/active", "GET"],
  ["POST", "deployments/start", "deployments/start", "POST"],
  ["PUT", `deployments/staging/files/index.html${query}`, "deployments/staging", "GET"],
  ["POST", `deployments/staging/copy${query}`, "deployments/staging", "GET"],
  ["POST", `deployments/staging/commit${query}`, "deployments/staging", "GET"],
  ["POST", "deployments/fail", "deployments/fail", "POST"],
  ["GET", `publications${query}`, "publications", "GET"],
  ["POST", "publications", "deployments/active", "GET"],
  ["POST", "publications/remove", "publications/remove", "POST"],
];

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(routes)("preserves 429 and signs the rewritten backend IP for %s %s", async (method, path, backendPath, backendMethod) => {
  const manifest = { version: 1, files: [] };
  const body = JSON.stringify({ organizationId: "org", projectId: "project", manifest,
    manifestSha256: await sha256(JSON.stringify(manifest)), pathPrefix: "", entryFile: "index.html" });
  const request = new Request(`https://rendro.test/api/rendro/${path}`, {
    method, body: method === "GET" ? undefined : body,
    headers: { authorization: "Bearer never-log-this", "x-rendro-verified-client-ip": "192.0.2.99" },
  });
  registerAuthClientIp(request, "192.0.2.10");
  vi.stubGlobal("fetch", vi.fn(async (target: string, init: RequestInit) => {
    expect(new URL(target).pathname).toBe(`/api/rendro/${backendPath}`);
    expect(init.method).toBe(backendMethod);
    const verified = await verifiedAuthRequest(new Request(target, init), process.env.CONVEX_INTERNAL_SECRET);
    expect(verified.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("192.0.2.10");
    return Response.json({ error: "Rate limit exceeded", code: "rate_limited" }, {
      status: 429, headers: { "Retry-After": "3" },
    });
  }));
  const response = await app.fetch(request);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("3");
  expect(await response.json()).toEqual({ error: "Rate limit exceeded", code: "rate_limited" });
  expect(fetch).toHaveBeenCalledOnce();
  for (const mock of Object.values(storage)) expect(mock).not.toHaveBeenCalled();
});
