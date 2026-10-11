import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { betterAuth } from "better-auth/minimal";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components, internal } from "../convex/_generated/api";
import { createAuthOptions } from "../convex/auth";
import * as authModule from "../convex/auth";
import { httpOrganizationAccess } from "../convex/authorization";
import { sessionCache, sessionMiddleware } from "@/middleware/session";
import { registerAuthClientIp } from "@/auth-client-ip";
import { mountSessionRoutes } from "@/app-routes";
import * as minio from "@/minio";

vi.mock("@/logger", () => ({ logger: { debug() {}, warn() {}, error() {} } }));
// Vitest timeouts do not cancel async bodies. Stop the round loop and drain
// work (including fixture setup) before another test can share Date/fetch/cache.
let activeCase: { stopped: boolean; done?: Promise<void> } | undefined;
function runCase(work: (state: { stopped: boolean }) => Promise<void>) {
  const state = { stopped: false, done: undefined as Promise<void> | undefined };
  activeCase = state;
  state.done = work(state);
  return state.done;
}
afterEach(async () => {
  try {
    if (activeCase) {
      activeCase.stopped = true;
      await activeCase.done?.catch(() => {});
    }
  } finally {
    activeCase = undefined;
    sessionCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

async function fixture() {
  sessionCache.clear();
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const auth = betterAuth(createAuthOptions({ runQuery: backend.query, runMutation: backend.mutation } as never));
  const context = await auth.$context;
  const organization = await backend.mutation(components.betterAuth.adapter.create, { input: { model: "organization", data: {
    name: "Browsing", slug: "browsing", createdAt: Date.now(),
  } } });
  const organizationId = organization._id as string;
  const readers = [];
  for (const role of ["owner", "member"]) {
    const user = await context.internalAdapter.createUser({ name: role, email: `${role}@example.test`, emailVerified: true });
    const session = await context.internalAdapter.createSession(user.id);
    await backend.mutation(components.betterAuth.adapter.create, { input: { model: "member", data: {
      organizationId, userId: user.id, role, createdAt: Date.now(),
    } } });
    const signed = `${session.token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(session.token).digest("base64")}`;
    readers.push({ user, session, cookie: `better-auth.session_token=${encodeURIComponent(signed)}` });
  }
  const project = await backend.mutation(internal.projects.createInternal, { organizationId, name: "Docs", slug: "docs", actorId: readers[0].user.id });
  const projectId = project!._id;
  const deployment = await backend.mutation(internal.deployments.startInternal, {
    organizationId, projectId, actorId: readers[0].user.id, manifestSha256: "a".repeat(64), fileCount: 8, byteCount: 800,
    provenance: { source: { kind: "local" }, execution: { kind: "local" }, cliVersion: "test", manifestSha256: "a".repeat(64) },
  });
  await backend.mutation(internal.deployments.commitInternal, { organizationId, projectId, deploymentId: deployment.deploymentId, actorId: readers[0].user.id });
  const pages = ["index.html", "guide/next.html", "space name.html", "日本語.html", "100%.html", "hash#name.html", "no-head.html", "base.html"];
  vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1, files: pages.map(path => ({ path, contentType: "text/html", sha256: "b".repeat(64), size: 100 })) }));
  vi.spyOn(minio, "getObjectStream").mockImplementation(() => Promise.resolve(new Response("<html><head></head><body><h1>Docs</h1></body></html>").body));
  const counts = { session: 0, authorization: 0, errors: [] as number[] };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/api/auth/get-session") counts.session++;
    if (url.pathname === "/api/rendro/deployments/active") counts.authorization++;
    const response = await backend.fetch(url.pathname + url.search, init);
    if ([429, 503].includes(response.status)) counts.errors.push(response.status);
    return response;
  }));
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => {
    // Model the Worker's trusted ingress registration, not a raw forwarding
    // header (which intentionally cannot select a rate-limit bucket).
    registerAuthClientIp(c.req.raw, "192.0.2.60");
    await next();
  });
  app.use("*", sessionMiddleware);
  app.get("/organizations/cache-probe", c => c.json({ id: c.get("user")?.id ?? null }));
  app.get("/organizations/browsing-probe", async c => {
    // Retain fresh production session + membership authorization, but omit
    // project/manifest reads, HTML rendering, streams and ticket encryption.
    // This is the production navigation guard used by document authorization;
    // getSession already reads the user, so omit its extra getAnyUserById read.
    const authorized = await httpOrganizationAccess(
      { runQuery: backend.query, runMutation: backend.mutation } as never,
      c.req.raw.headers, organizationId,
    );
    counts.authorization++;
    return c.json({ id: c.get("user")?.id, authorizedId: authorized.userId });
  });
  mountSessionRoutes(app);
  return { reuseAuth: () => vi.spyOn(authModule, "createAuth").mockReturnValue(auth), app, organizationId, context, readers, backend, counts, pages, base: `/organizations/${organizationId}/projects/${projectId}/docs`, manifestKey: deployment.manifestKey };
}

it.each([
  ["round-4 observed volume", 91, 600_000 / 91, 62],
  ["round-4 1.2s cadence without page-load overhead", 500, 1_200, 78],
])("serves owner and member for ten minutes: %s", (_label, rounds, interval, expectedReads) => runCase(async state => {
  const f = await fixture();
  if (state.stopped) return;
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  // Keep every cadence timestamp: ceil(15_000 / interval) rounds per cache
  // refresh yields 2 * ceil(rounds / ceil(15_000 / interval)) = 62 / 78 reads.
  // Hits never extend TTL. The first >=15s (and all eight document paths) use
  // real shell/tree/file/ticket fan-out, including a cold and refreshed cache.
  // Remaining requests still run real Worker middleware and fresh production
  // authorization; only session-irrelevant document work is omitted.
  const fullRounds = Math.max(8, Math.ceil(15_000 / interval) + 1);
  for (let i = 0; i < rounds && !state.stopped; i++) {
    vi.setSystemTime(start + i * interval);
    const fullFanout = i < fullRounds;
    // Reuse the real Better Auth instance after the full-fidelity window.
    // Reconstructing its plugins per authorization dominates this in-process
    // fixture. Each call still dispatches getSession and reads session/member/
    // organization/user rows afresh; neither results nor limiter are mocked.
    if (i === fullRounds) f.reuseAuth();
    const results = await Promise.allSettled(f.readers.flatMap(reader => {
      const path = f.pages[i % 8];
      const headers = { cookie: reader.cookie };
      const paths = fullFanout ? [
        `${f.base}?${new URLSearchParams({ doc: path })}`, `${f.base}/tree`,
        `${f.base}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
        `${f.base}/viewer-ticket?${new URLSearchParams({ manifestKey: f.manifestKey })}`,
      ] : Array<string>(4).fill("/organizations/browsing-probe");
      return paths.map(async path => {
        const response = await f.app.request(path, { headers });
        expect(response.status).toBe(200);
        if (fullFanout) await response.text();
        else expect(await response.json()).toEqual({ id: reader.user.id, authorizedId: reader.user.id });
      });
    }));
    // Unlike Promise.all, a failed assertion cannot leave sibling requests
    // running after cleanup. Rethrow only after the entire round has settled.
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  if (state.stopped) return;
  expect(f.counts).toEqual({ session: expectedReads, authorization: rounds * 8, errors: [] });
  const rows = await f.backend.query(components.betterAuth.adapter.findMany, { model: "rateLimit", paginationOpts: { numItems: 20, cursor: null } });
  expect(rows.page.filter((row: { key: string }) => row.key.startsWith("session-read:"))).toHaveLength(2);
  expect(rows.page.filter((row: { key: string }) => row.key.startsWith("session-read-ip:")).map((row: { key: string }) => row.key))
    .toEqual(["session-read-ip:192.0.2.60"]);
}), 120_000);

it.each([false, true])("recognizes real Convex revocation by 15s while document authorization denies immediately (reused auth: %s)", reuseAuth => runCase(async () => {
  const f = await fixture();
  if (reuseAuth) f.reuseAuth();
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const headers = { cookie: f.readers[0].cookie };
  expect(await (await f.app.request("/organizations/cache-probe", { headers })).json()).toEqual({ id: f.readers[0].user.id });
  await f.context.internalAdapter.deleteSession(f.readers[0].session.token);
  vi.setSystemTime(start + 14_999);
  expect(await (await f.app.request("/organizations/cache-probe", { headers })).json()).toEqual({ id: f.readers[0].user.id });
  expect((await f.app.request(f.base, { headers })).status).toBe(404);
  // The authoritative document denial evicts immediately, before TTL expiry.
  expect(await (await f.app.request("/organizations/cache-probe", { headers })).json()).toEqual({ id: null });
  expect(f.counts.session).toBe(2);
}));

it.each([false, true])("ends the revoked-session redirect chain at sign-in (another warm isolate: %s)", otherIsolate => runCase(async () => {
  const f = await fixture();
  const cookie = f.readers[0].cookie;
  const headers = { cookie };
  const path = `/organizations/${f.organizationId}`;
  expect((await f.app.request(path, { headers })).status).toBe(200);
  const oldIdentity = await sessionCache.lookup(cookie, () => { throw new Error("Expected a warm identity"); });
  await f.context.internalAdapter.deleteSession(f.readers[0].session.token);
  const denied = await f.app.request(path, { headers });
  expect(denied.status).toBe(302);
  expect(denied.headers.get("location")).toBe(`/sign-in?returnTo=${encodeURIComponent(path)}`);
  expect(await (await f.app.request("/organizations/cache-probe", { headers })).json()).toEqual({ id: null });
  // Model landing on an isolate that has not observed the authorization denial.
  if (otherIsolate) await sessionCache.lookup(cookie, () => Promise.resolve(oldIdentity));
  const signIn = await f.app.request(denied.headers.get("location")!, { headers });
  expect(signIn.status).toBe(200);
  expect(signIn.headers.get("location")).toBeNull();
  expect(await signIn.text()).toContain("Sign in");
}));

it.each([false, true])("evicts after membership removal and denies both management and document access (reused auth: %s)", reuseAuth => runCase(async () => {
  const f = await fixture();
  if (reuseAuth) f.reuseAuth();
  const reader = f.readers[1];
  const headers = { cookie: reader.cookie };
  const path = `/organizations/${f.organizationId}`;
  expect((await f.app.request(path, { headers })).status).toBe(200);
  await f.backend.mutation(components.betterAuth.adapter.deleteMany, { input: {
    model: "member", where: [{ field: "userId", value: reader.user.id }],
  }, paginationOpts: { numItems: 100, cursor: null } });
  expect((await f.app.request(path, { headers })).status).toBe(404);
  const before = f.counts.session;
  expect((await f.app.request(f.base, { headers })).status).toBe(404);
  expect(f.counts.session).toBe(before + 1);
  // Better Auth's organization mutation rejects removed members with 400.
  await f.app.request("/organizations/cache-probe", { headers });
  const deniedMutation = await f.app.request("/api/auth/organization/update", {
    method: "POST", headers: { ...headers, origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify({ organizationId: f.organizationId, data: { name: "Denied update" } }),
  });
  expect(deniedMutation.status).toBe(400);
  const afterDenial = f.counts.session;
  await f.app.request("/organizations/cache-probe", { headers });
  expect(f.counts.session).toBe(afterDenial + 1);
  // Identity remains valid, but the redirect terminates at an access denial.
  const signIn = await f.app.request(`/sign-in?returnTo=${encodeURIComponent(path)}`, { headers });
  expect(signIn.status).toBe(302);
  expect((await f.app.request(signIn.headers.get("location")!, { headers })).status).toBe(404);
}));

it.each(["sign-out", "change-password"])("does not reuse identity after real %s", operation => runCase(async () => {
  const f = await fixture();
  const reader = f.readers[0];
  const headers = { cookie: reader.cookie };
  expect((await f.app.request(f.base, { headers })).status).toBe(200);
  let mutationCookie = reader.cookie;
  let body = {};
  if (operation === "change-password") {
    await f.context.internalAdapter.createAccount({
      userId: reader.user.id, accountId: reader.user.id, providerId: "credential",
      password: await f.context.password.hash("old-password-long-enough"),
    });
    const other = await f.context.internalAdapter.createSession(reader.user.id);
    const signed = `${other.token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(other.token).digest("base64")}`;
    mutationCookie = `better-auth.session_token=${encodeURIComponent(signed)}`;
    body = { currentPassword: "old-password-long-enough", newPassword: "new-password-long-enough", revokeOtherSessions: true };
  }
  const changed = await f.app.request(`http://localhost:3000/api/auth/${operation}`, {
    method: "POST", headers: { cookie: mutationCookie, origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(changed.status).toBe(200);
  expect(await f.context.internalAdapter.findSession(reader.session.token)).toBeNull();
  expect(await (await f.app.request("/organizations/cache-probe", { headers })).json()).toEqual({ id: null });
  expect((await f.app.request("/sign-in", { headers })).status).toBe(200);
}));
