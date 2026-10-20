import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type * as AuthModule from "../convex/auth";
import { apiCacheControl } from "../shared/http-cache";
import { proxyConvexRequest } from "../src/auth-proxy";

const state = vi.hoisted(() => ({ mode: "success" as "success" | "denied" | "error" }));
function fault() {
  if (state.mode === "denied") throw new ConvexError("Authentication required");
  if (state.mode === "error") throw new Error("https://private.test/s/synthetic-secret");
}
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

const input = { newPassword: "synthetic-long-password" };
function answer(reference: FunctionReference<"query" | "mutation">, args: Record<string, unknown>) {
  fault();
  if (args.model) return { page: [], isDone: true };
  const name = getFunctionName(reference);
  if (/consume|:limit$/.test(name)) return { ok: true };
  return null;
}
/** Faults arrive as rejections, as from the real Convex client. */
function rpc(reference: FunctionReference<"query" | "mutation">, args: Record<string, unknown>): Promise<unknown> {
  try { return Promise.resolve(answer(reference, args)); } catch (error) { return Promise.reject(error as Error); }
}
const ctx = { runQuery: vi.fn(rpc), runMutation: vi.fn(rpc) };
const routes = http.getRoutes().map(([path, method, action]) => ({ path, method, action }));
function makeRequest(path: string, method: string, malformed = false) {
  const params = malformed ? "" : new URLSearchParams(Object.entries(input).filter(([, v]) => typeof v === "string") as [string, string][]).toString();
  const body: object = input;
  const headers = new Headers({ origin: process.env.SITE_URL!, "content-type": "application/json" });
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
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("cache policy from the live Convex route registrations", () => {
  it.each(routes)("$method $path covers success, denial, faults and malformed input", async ({ path, method, action }) => {
    for (const mode of ["success", "denied", "error", "malformed"] as const) {
      state.mode = mode === "malformed" ? "success" : mode;
      const response = await invoke(action, makeRequest(path, method, mode === "malformed"));
      expect(response.headers.get("cache-control"), `${mode}: ${method} ${path}`).toBe("private, no-store");
      if (mode === "success") {
        expect(response.ok, `${method} ${path}: ${await response.clone().text()}`).toBe(true);
      }
      if (mode === "denied") expect(response.status, path).toBeGreaterThanOrEqual(400);
      if (mode === "error") expect(response.status, path).toBe(500);
      if (mode === "malformed" && !(path === "/api/auth/*" && method === "GET")) {
        expect(response.status, path).toBe(400);
      }
    }
  });

  it.each(routes)("$method $path retains the policy and response through the proxy", async ({ path, method, action }) => {
    for (const mode of ["success", "denied", "error", "malformed"] as const) {
      state.mode = mode === "malformed" ? "success" : mode;
      const request = makeRequest(path, method, mode === "malformed");
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
