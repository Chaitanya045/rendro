import rateLimiterTest from "./convex-rate-limiter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";

// Keep session authorization deterministic; database validation, API-key
// authorization, HTTP actions, and the Worker's forwarding are real.
vi.mock("../convex/authorization", () => ({
  authorizeHttpOrganization: (_ctx: unknown, headers: Headers) => {
    if (headers.get("cookie") !== "session=valid") throw new ConvexError("Authentication required");
    return Promise.resolve({ user: { _id: "owner" }, member: { role: "owner" } });
  },
}));
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";
import { sha256 } from "../convex/credentialHttp";
import { proxyConvexRequest } from "../src/auth-proxy";

const modules = import.meta.glob("../convex/**/*.ts");

async function fixture() {
  const backend = convexTest(schema, modules);
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const project = await backend.mutation(internal.projects.createInternal, {
    organizationId: "org", name: "Docs", slug: "docs", actorId: "owner",
  });
  if (!project) throw new Error("Missing test project");
  const wrongTableId = await backend.mutation(internal.apiKeyCredentials.createInternal, {
    organizationId: "org", keyId: "key", keyPrefix: "test", name: "test",
    secretHash: await sha256("valid-key"), actorId: "owner",
    scopes: ["docs:read", "docs:write", "publications:read", "publications:write"],
  });
  const scope = { organizationId: "org", projectId: project._id };
  return { backend, scope, wrongTableId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Route = { path: string; method: "GET" | "POST"; fields: string[]; body: (f: Fixture) => Record<string, unknown> };
const scope = (f: Fixture) => f.scope;
const routes: Route[] = [
  { path: "projects/get", method: "GET", fields: ["projectId"], body: scope },
  { path: "credentials", method: "POST", fields: ["projectId"], body: f => ({ ...f.scope, name: "test", scopes: ["docs:read"] }) },
  { path: "credentials/validate", method: "GET", fields: ["projectId"], body: f => ({ ...f.scope, scope: "docs:read" }) },
  { path: "management/team-members", method: "GET", fields: ["teamId"], body: () => ({ organizationId: "org" }) },
];

async function rejection(response: Response) {
  expect([400, 401, 403, 404]).toContain(response.status);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error: expect.any(String) });
  expect(text).not.toMatch(/ArgumentValidationError|ConvexError|\.ts:\d|at handler|stack/i);
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("HTTP ID boundaries", () => {
  it.each(routes)("$method $path rejects every ID field for each principal", async route => {
    const f = await fixture();
    for (const field of route.fields) {
      for (const badId of ["not-an-id", "", f.wrongTableId]) {
        for (const principal of ["key", "session", "invalid", "fallback"] as const) {
          const headers = new Headers({ origin: process.env.SITE_URL!, "Content-Type": "application/json" });
          headers.set("authorization", `Bearer ${principal === "key" ? "valid-key" : "invalid-key"}`);
          if (principal === "session" || principal === "fallback") headers.set("cookie", "session=valid");
          if (principal === "session") headers.delete("authorization");
          const body = { ...route.body(f), [field]: badId };
          const query = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]));
          const response = await f.backend.fetch(`/api/rendro/${route.path}${route.method === "GET" ? `?${query}` : ""}`, {
            method: route.method, headers, body: route.method === "POST" ? JSON.stringify(body) : undefined,
          });
          await rejection(response);
        }
      }
    }
  });
});

describe("Worker ID boundaries backed by Convex", () => {
  it.each(["valid-key", "invalid-key"])("rejects IDs through the generic proxy with %s", async key => {
    const f = await fixture();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      return f.backend.fetch(`${url.pathname}${url.search}`, init);
    }));
    const headers = { authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    for (const badId of ["not-an-id", f.wrongTableId]) {
      const query = new URLSearchParams({ ...f.scope, projectId: badId });
      await rejection(await proxyConvexRequest(new Request(`https://rendro.test/api/rendro/credentials/validate?${query}&scope=docs:read`, { headers })));
      await rejection(await proxyConvexRequest(new Request(`https://rendro.test/api/rendro/projects/get?${query}`, { headers: { cookie: "session=valid" } })));
    }
  });
});
