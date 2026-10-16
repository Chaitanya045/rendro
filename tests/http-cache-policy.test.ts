import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName, type FunctionArgs, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import type * as AuthModule from "../convex/auth";
import { apiCacheControl } from "../shared/http-cache";
import { STORAGE_ATTESTATION_HEADER } from "../shared/storage-attestation";
import { proxyConvexRequest } from "../src/auth-proxy";
import { cookieWriteFixture } from "./helpers/cookie-write-fixture";
import { shareProof } from "./helpers/storage-proof";

const state = vi.hoisted(() => ({ mode: "success" as "success" | "denied" | "error" }));
function fault() {
  if (state.mode === "denied") throw new ConvexError("Authentication required");
  if (state.mode === "error") throw new Error("https://private.test/s/synthetic-secret");
}
vi.mock("../convex/authorization", () => ({
  authorizeHttpOrganization: () => { fault(); return Promise.resolve({ user: { _id: "user" } }); },
  httpOrganizationAccess: () => { fault(); return Promise.resolve({ organization: { id: "org" }, member: { id: "member", userId: "user", role: "owner" }, userId: "user" }); },
}));
vi.mock("../convex/auth", async importOriginal => ({ ...await importOriginal<typeof AuthModule>(), createAuth: () => ({
  api: { getSession: () => { fault(); return Promise.resolve({ session: { createdAt: Date.now() } }); }, setPassword: () => { fault(); return Promise.resolve(); } },
  $context: Promise.resolve({ sessionConfig: { freshAge: 3600 } }),
  handler: async (request: Request) => {
    fault();
    try { if (request.method === "POST") await request.json(); }
    catch { return Response.json({}, { status: 400 }); }
    return Response.json({ session: "synthetic-session" }, { headers: { "set-cookie": "session=synthetic; Domain=upstream.test; Path=/" } });
  },
}) }));
import http from "../convex/http";
import { httpAction } from "../convex/httpErrors";

const input = {
  organizationId: "org", projectId: "project", deploymentId: "deployment", teamId: "team",
  name: "Test", slug: "test", keyId: "key", grantId: "grant", publicationId: "publication",
  scopes: ["docs:read"], scope: "docs:read", documentPath: "index.html", expiresInSeconds: 60,
  manifestSha256: "a".repeat(64), fileCount: 0, byteCount: 0, provenance: {}, reason: "test",
  pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", token: "synthetic-share",
  objectCount: 0, purgeToken: "synthetic-purge", newPassword: "synthetic-long-password",
};
let shareFixture: Awaited<ReturnType<typeof cookieWriteFixture>> | undefined;
async function rpc(reference: FunctionReference<"query" | "mutation">, args: Record<string, unknown>) {
  fault();
  if (args.model) return { page: [], isDone: true };
  if (args.teamId) return { organizationId: "org" };
  const name = getFunctionName(reference);
  // Exercise the real insertion/attestation contract, not a synthetic success.
  if (name === "shareGrants:createInternal") return shareFixture!.backend.mutation(
    internal.shareGrants.createInternal, args as FunctionArgs<typeof internal.shareGrants.createInternal>,
  );
  if (/consume|:limit$/.test(name)) return { ok: true };
  if (name.endsWith(":verifiedIdInternal")) return null; // exercise the failed-IP limiter without bypassing it
  if (name.endsWith(":validateInternal")) return { principal: { keyId: "key" }, credentialId: "key", recordUsage: false };
  if (name === "shareGrants:resolveInternal") return { grant: { documentPath: "index.html", expiresAt: Date.now() + 1000 }, project: { name: "Test" } };
  if (name === "publicationsV2:resolvePublicInternal") return { publication: { slug: "test", title: "Test", entryFile: "index.html" } };
  return { _id: "project", slug: "test" };
}
const ctx = { runQuery: vi.fn(rpc), runMutation: vi.fn(rpc) };
const routes = http.getRoutes().map(([path, method, action]) => ({ path, method, action }));
async function makeRequest(path: string, method: string, malformed = false) {
  const params = malformed ? "" : new URLSearchParams(Object.entries(input).filter(([, v]) => typeof v === "string") as [string, string][]).toString();
  let body: object = input;
  const headers = new Headers({ origin: process.env.SITE_URL!, "content-type": "application/json", authorization: state.mode === "denied" ? "Bearer invalid" : "Bearer synthetic-operator" });
  if (path === "/api/rendro/shares" && method === "POST") {
    shareFixture ??= await cookieWriteFixture();
    body = shareFixture.bodies[path];
    headers.set(STORAGE_ATTESTATION_HEADER, (await shareProof(shareFixture.backend, {
      projectId: shareFixture.projectId, documentPath: "index.html", assetPaths: [],
    }))!);
  }
  return new Request(`http://localhost:3000${path.replace(/\*$/, "get-session")}?${params}`, {
    method,
    headers,
    ...(method === "POST" ? { body: malformed ? "{" : JSON.stringify(body) } : {}),
  });
}
function invoke(action: unknown, request: Request) {
  return (action as { _handler(ctx: unknown, request: Request): Promise<Response> })._handler(ctx, request);
}
beforeEach(() => {
  state.mode = "success";
  shareFixture = undefined;
  vi.stubEnv("RETENTION_SECRET", "synthetic-operator");
  vi.stubEnv("MIGRATION_SECRET", "synthetic-operator");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("cache policy from the live Convex route registrations", () => {
  it.each(routes)("$method $path covers success, denial, faults and malformed input", async ({ path, method, action }) => {
    for (const mode of ["success", "denied", "error", "malformed"] as const) {
      state.mode = mode === "malformed" ? "success" : mode;
      const response = await invoke(action, await makeRequest(path, method, mode === "malformed"));
      expect(response.headers.get("cache-control"), `${mode}: ${method} ${path}`).toBe("private, no-store");
      if (mode === "success") {
        expect(response.ok, `${method} ${path}: ${await response.clone().text()}`).toBe(true);
        if (shareFixture) {
          const { grant } = await response.json() as { grant: Doc<"shareGrants"> };
          expect(grant).toMatchObject({ projectId: shareFixture.projectId, documentPath: "index.html", assetPaths: [] });
          expect(await shareFixture.backend.run(ctx => ctx.db.get(grant._id))).toEqual(grant);
        }
      }
      if (mode === "denied") expect(response.status, path).toBeGreaterThanOrEqual(400);
      if (mode === "error") expect(response.status, path).toBe(500);
      if (mode === "malformed" && !path.includes("admission/public") && !path.includes("retention/candidates") && !(path === "/api/auth/*" && method === "GET")) {
        expect(response.status, path).toBe(400);
      }
    }
  });

  it.each(routes)("$method $path retains the policy and response through the proxy", async ({ path, method, action }) => {
    for (const mode of ["success", "denied", "error", "malformed"] as const) {
      state.mode = mode === "malformed" ? "success" : mode;
      const request = await makeRequest(path, method, mode === "malformed");
      const upstream = await invoke(action, request.clone());
      if (mode === "success") expect(upstream.ok, `${method} ${path}: ${await upstream.clone().text()}`).toBe(true);
      const payload = await upstream.clone().text();
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(upstream)));
      const response = await proxyConvexRequest(request);
      expect(response.status).toBe(mode === "error" ? 502 : upstream.status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe(mode === "error" ? JSON.stringify({ error: "Backend unavailable" }) : payload);
      expect(response.headers.get("set-cookie") ?? "").not.toContain("Domain=");
    }
  });

  it.each(["missing", "forged", "changed-assets"])("keeps rejected share attestations private (%s)", async invalid => {
    const path = "/api/rendro/shares";
    const request = await makeRequest(path, "POST");
    const body = await request.json();
    if (invalid === "missing") request.headers.delete(STORAGE_ATTESTATION_HEADER);
    if (invalid === "forged") request.headers.set(STORAGE_ATTESTATION_HEADER, "forged");
    if (invalid === "changed-assets") body.assetPaths = ["private.json"];
    const before = await shareFixture!.backend.run(ctx => ctx.db.query("shareGrants").collect());
    const action = routes.find(route => route.path === path && route.method === "POST")!.action;
    const response = await invoke(action, new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) }));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await shareFixture!.backend.run(ctx => ctx.db.query("shareGrants").collect())).toEqual(before);
  });

  it("defaults future handlers and failures to private even when they attempt public caching", async () => {
    for (const status of [200, 201, 204, 302, 400, 401, 403, 404, 413, 429, 500, 503]) {
      const action = httpAction(() => Promise.resolve(new Response(null, { status, headers: { "Cache-Control": "public, max-age=999", "Retry-After": "2" } })));
      const response = await invoke(action, new Request("https://test/api/future"));
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("retry-after")).toBe("2");
    }
  });

  it("prevents intermediary reuse between users and after revocation", async () => {
    const cache = new Map<string, Response>();
    let calls = 0;
    const action = httpAction((_ctx, request) => {
      calls++;
      return Promise.resolve(Response.json({ user: request.headers.get("cookie") }, { status: calls > 2 ? 403 : 200 }));
    });
    const read = async (cookie: string) => {
      const request = new Request("https://test/api/private", { headers: { cookie } });
      const response = cache.get(request.url)?.clone() ?? await invoke(action, request);
      if (!/no-store/.test(response.headers.get("cache-control") ?? "")) cache.set(request.url, response.clone());
      return response;
    };
    expect(await (await read("user-a")).json()).toEqual({ user: "user-a" });
    expect(await (await read("user-b")).json()).toEqual({ user: "user-b" });
    expect((await read("user-a")).status).toBe(403);
    expect(calls).toBe(3);
    expect(cache.size).toBe(0);
  });
});

it("allows only exact successful cookie-free GET JWKS responses to be public", async () => {
  for (const [method, path, status, cookies, expected] of [
    ["GET", "/api/auth/convex/jwks", 200, false, "public, max-age=300, must-revalidate"],
    ["GET", "/api/auth/convex/jwks", 200, true, "private, no-store"],
    ["GET", "/api/auth/convex/jwks", 403, false, "private, no-store"],
    ["GET", "/api/auth/convex/jwks", 500, false, "private, no-store"],
    ["POST", "/api/auth/convex/jwks", 200, false, "private, no-store"],
    ["GET", "/api/auth/convex/jwks/", 200, false, "private, no-store"],
    ["GET", "/api/auth/convex/token", 200, false, "private, no-store"],
  ] as const) {
    const request = new Request(`https://test${path}`, { method });
    const action = httpAction(() => Promise.resolve(new Response(null, { status, headers: cookies ? { "set-cookie": "session=synthetic" } : {} })));
    const response = await invoke(action, request);
    expect(apiCacheControl(request, response)).toBe(expected);
    expect(response.headers.get("cache-control")).toBe(expected);
  }
});
