import rateLimiterTest from "./convex-rate-limiter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { Hono } from "hono";

// Keep session authorization deterministic; database validation, API-key
// authorization, HTTP actions, and the Worker's forwarding are real.
vi.mock("../convex/authorization", () => ({
  authorizeHttpOrganization: (_ctx: unknown, headers: Headers) => {
    if (headers.get("cookie") !== "session=valid") throw new ConvexError("Authentication required");
    return Promise.resolve({ user: { _id: "owner" }, member: { role: "owner" } });
  },
}));
const storage = vi.hoisted(() => ({
  copyObject: vi.fn(), getObjectText: vi.fn(), headObject: vi.fn(),
  listAllKeys: vi.fn(), putObject: vi.fn(), getObjectStream: vi.fn(),
}));
vi.mock("../src/minio", () => storage);

import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";
import { sha256 } from "../convex/credentialHttp";
import deployments from "../src/routes/deployments";
import publications from "../src/routes/publication-api";
import { proxyConvexRequest } from "../src/auth-proxy";
import projectDocs from "../src/routes/project-docs";
import type { User } from "better-auth/types";

const modules = import.meta.glob("../convex/**/*.ts");
const manifest = { version: 1, files: [] };
const provenance = { source: { kind: "local" as const }, execution: { kind: "local" as const }, cliVersion: "test", manifestSha256: "a".repeat(64) };

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
  const deployment = await backend.mutation(internal.deployments.startInternal, {
    organizationId: "org", projectId: project._id, manifestSha256: "a".repeat(64),
    fileCount: 0, byteCount: 0, provenance, actorId: "owner",
  });
  const scope = { organizationId: "org", projectId: project._id };
  return { backend, scope, deploymentId: deployment.deploymentId, wrongTableId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Route = { path: string; method: "GET" | "POST"; fields: string[]; body: (f: Fixture) => Record<string, unknown> };
const scope = (f: Fixture) => f.scope;
const identity = (f: Fixture) => ({ ...f.scope, deploymentId: f.deploymentId });
const routes: Route[] = [
  { path: "projects/get", method: "GET", fields: ["projectId"], body: scope },
  { path: "credentials", method: "POST", fields: ["projectId"], body: f => ({ ...f.scope, name: "test", scopes: ["docs:read"] }) },
  { path: "credentials/validate", method: "GET", fields: ["projectId"], body: f => ({ ...f.scope, scope: "docs:read" }) },
  { path: "deployments/start", method: "POST", fields: ["projectId"], body: f => ({ ...f.scope, manifestSha256: "a".repeat(64), fileCount: 0, byteCount: 0, provenance }) },
  { path: "deployments/active", method: "GET", fields: ["projectId"], body: scope },
  { path: "deployments/staging", method: "GET", fields: ["projectId", "deploymentId"], body: identity },
  { path: "deployments/commit", method: "POST", fields: ["projectId", "deploymentId"], body: identity },
  { path: "deployments/fail", method: "POST", fields: ["projectId", "deploymentId"], body: f => ({ ...identity(f), reason: "test" }) },
  { path: "deployments", method: "GET", fields: ["projectId"], body: scope },
  { path: "publications", method: "GET", fields: ["projectId"], body: scope },
  { path: "publications", method: "POST", fields: ["projectId", "pinnedDeploymentId"], body: f => ({ ...f.scope, slug: "docs", pathPrefix: "", entryFile: "index.html", trackingMode: "pinned", pinnedDeploymentId: f.deploymentId }) },
  { path: "publications/remove", method: "POST", fields: ["projectId", "publicationId"], body: f => ({ ...f.scope, publicationId: f.wrongTableId }) },
  { path: "shares", method: "GET", fields: ["projectId"], body: scope },
  { path: "shares", method: "POST", fields: ["projectId"], body: f => ({ ...f.scope, documentPath: "index.html", expiresInSeconds: 600 }) },
  { path: "shares/revoke", method: "POST", fields: ["grantId"], body: () => ({ organizationId: "org" }) },
  { path: "retention/purged", method: "POST", fields: ["deploymentId"], body: () => ({ objectCount: 0, purgeToken: "test" }) },
  { path: "migration/project", method: "POST", fields: ["projectId"], body: scope },
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
    vi.stubEnv("RETENTION_SECRET", "valid-key");
    vi.stubEnv("MIGRATION_SECRET", "valid-key");
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
    expect(await f.backend.run(async ctx => (await ctx.db.get(f.deploymentId))?.status)).toBe("staging");
  });

  it("preserves the valid-session active-deployment fallback", async () => {
    const f = await fixture();
    const response = await f.backend.fetch(`/api/rendro/deployments/active?${new URLSearchParams(f.scope)}`, { headers: { cookie: "session=valid", authorization: "Bearer invalid-key" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ project: { _id: f.scope.projectId }, principal: { kind: "session" } });
  });
});

describe("Worker ID boundaries backed by Convex", () => {
  it.each(["valid-key", "invalid-key"])("rejects IDs before storage access with %s", async key => {
    const f = await fixture();
    const app = new Hono().route("/", deployments).route("/", publications);
    app.all("/api/rendro/*", c => proxyConvexRequest(c.req.raw));
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      return f.backend.fetch(`${url.pathname}${url.search}`, init);
    }));
    const headers = { authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    for (const badId of ["not-an-id", f.wrongTableId]) {
      const query = new URLSearchParams({ ...f.scope, projectId: badId });
      await rejection(await app.request(`/api/rendro/deployments/check?${query}`, { headers }));
      await rejection(await app.request("/api/rendro/deployments/start", { method: "POST", headers, body: JSON.stringify({ ...f.scope, projectId: badId, manifest, manifestSha256: await sha256(JSON.stringify(manifest)), provenance }) }));
      for (const field of ["projectId", "deploymentId"] as const) {
        const values = { ...identity(f), [field]: badId };
        const query = new URLSearchParams({ organizationId: values.organizationId, projectId: values.projectId });
        for (const [suffix, method] of [["files/index.html", "PUT"], ["copy", "POST"], ["commit", "POST"]]) {
          await rejection(await app.request(`/api/rendro/deployments/${values.deploymentId}/${suffix}?${query}`, { method, headers, body: "{}" }));
        }
        await rejection(await app.request("/api/rendro/deployments/fail", { method: "POST", headers, body: JSON.stringify({ ...values, reason: "test" }) }));
      }
      await rejection(await app.request(`/api/rendro/publications?${query}`, { headers }));
      await rejection(await app.request("/api/rendro/publications", { method: "POST", headers, body: JSON.stringify({ ...f.scope, projectId: badId, slug: "docs", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" }) }));
      await rejection(await app.request("/api/rendro/publications", { method: "POST", headers, body: JSON.stringify({ ...f.scope, pinnedDeploymentId: badId, slug: "docs", pathPrefix: "", entryFile: "index.html", trackingMode: "pinned" }) }));
      await rejection(await app.request("/api/rendro/publications/remove", { method: "POST", headers, body: JSON.stringify({ ...f.scope, publicationId: badId }) }));
      await rejection(await app.request(`/api/rendro/projects/get?${query}`, { headers: { cookie: "session=valid" } }));
    }
    for (const mock of Object.values(storage)) expect(mock).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects project viewer IDs with valid session=%s", async validSession => {
    const f = await fixture();
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", async (c, next) => {
      if (validSession) c.set("user", { id: "owner", name: "Owner", email: "owner@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await next();
    });
    app.route("/", projectDocs);
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input);
      return f.backend.fetch(`${url.pathname}${url.search}`, init);
    }));
    for (const badId of ["not-an-id", f.wrongTableId]) {
      for (const suffix of ["", "/tree", "/files/index.html"]) {
        const response = await app.request(`/organizations/org/projects/${badId}/docs${suffix}`, { headers: { cookie: `session=${validSession ? "valid" : "invalid"}` } });
        expect(response.status).toBe(validSession || suffix === "/files/index.html" ? 404 : suffix === "/tree" ? 401 : 302);
        expect(await response.text()).not.toMatch(/ArgumentValidationError|ConvexError|\.ts:\d|at handler/);
      }
    }
    for (const mock of Object.values(storage)) expect(mock).not.toHaveBeenCalled();
  });
});
