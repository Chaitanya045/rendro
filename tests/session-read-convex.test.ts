import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { betterAuth } from "better-auth/minimal";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components } from "../convex/_generated/api";
import { createAuthOptions } from "../convex/auth";
import { sessionExpiryMs } from "../convex/sessionReadLimit";
import { sessionMiddleware } from "@/middleware/session";

const baseURL = "http://localhost:3000";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture(extra: BetterAuthPlugin[] = []) {
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  // Keep the production database and plugins. Only the Convex RPC transport is
  // local: customTransformOutput in @convex-dev/better-auth returns numeric dates.
  const options = createAuthOptions({
    runQuery: backend.query,
    runMutation: backend.mutation,
  } as never);
  const auth = betterAuth({ ...options, plugins: [...options.plugins, ...extra] });
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({ name: "Reader", email: "reader@example.test", emailVerified: true });
  const session = await context.internalAdapter.createSession(user.id);
  const cookie = (token: string) => `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("base64")}`)}`;
  const request = (token = session.token) => auth.handler(new Request(`${baseURL}/api/auth/get-session`, { headers: { cookie: cookie(token) } }));
  const stored = () => backend.query(components.betterAuth.adapter.findOne, { model: "session", where: [{ field: "token", value: session.token }] });
  const buckets = () => backend.query(components.betterAuth.adapter.findMany, { model: "sessionReadWindow", paginationOpts: { numItems: 100, cursor: null } });
  return { backend, context, user, session, cookie, request, stored, buckets };
}

describe("production Convex session adapter", () => {
  it("serves a numeric-expiry session through HTTP and Worker with one lookup per request", async () => {
    const f = await fixture();
    expect(typeof f.session.expiresAt).toBe("number");
    expect(typeof (await f.stored()).expiresAt).toBe("number");
    const find = vi.spyOn(f.context.internalAdapter, "findSession");
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: f.user.id } });
    expect(find).toHaveBeenCalledTimes(1);
    // The shared adapter reference must not be replaced or mutated by a hook.
    expect(f.context.internalAdapter).toHaveProperty("findSession", find);
    vi.stubGlobal("fetch", vi.fn(() => f.request()));
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", sessionMiddleware);
    app.get("/", c => c.text(c.get("user") ? "signed in" : "signed out"));
    const worker = await app.request("/", { headers: { cookie: f.cookie(f.session.token) } });
    expect(worker.status).toBe(200);
    expect(await worker.text()).toBe("signed in");
    expect(find).toHaveBeenCalledTimes(2);
    await f.context.internalAdapter.deleteSession(f.session.token);
    expect(await (await f.request()).json()).toBeNull();
    expect(find).toHaveBeenCalledTimes(3);
    // Windows live in the application-owned table, never in Better Auth's rateLimit table.
    const namespaces = ((await f.buckets()).page as Array<{ key: string }>).map(row => row.key.replace(/:.*/, ""));
    expect([...new Set(namespaces)].sort())
      .toEqual(["session-read", "session-read-ip", "session-read-unverified"]);
    expect((await f.backend.query(components.betterAuth.adapter.findMany, { model: "rateLimit", paginationOpts: { numItems: 10, cursor: null } })).page).toEqual([]);
  });

  it("expires numeric sessions, reuses null lookups, and never allocates their hash bucket", async () => {
    const f = await fixture();
    await f.backend.mutation(components.betterAuth.adapter.updateOne, { input: {
      model: "session", where: [{ field: "token", value: f.session.token }], update: { expiresAt: Date.now() - 1 },
    } });
    const find = vi.spyOn(f.context.internalAdapter, "findSession");
    for (const token of [f.session.token, "unknown-but-signed"]) {
      const response = await f.request(token);
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    }
    expect(find).toHaveBeenCalledTimes(2);
    expect(await f.stored()).toBeNull();
    expect((await f.buckets()).page.some((row: { key: string }) => row.key.startsWith("session-read:"))).toBe(false);
  });

  it("keeps refresh writes and concurrent sessions isolated", async () => {
    const f = await fixture();
    const other = await f.context.internalAdapter.createSession(f.user.id);
    const oldExpiry = Date.now() + 60_000;
    await f.backend.mutation(components.betterAuth.adapter.updateOne, { input: {
      model: "session", where: [{ field: "token", value: f.session.token }], update: { expiresAt: oldExpiry },
    } });
    const find = vi.spyOn(f.context.internalAdapter, "findSession");
    const results = await Promise.all([f.request(), f.request(other.token), f.request("missing")]);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    const bodies = await Promise.all(results.map(r => r.json()));
    expect(bodies[0].session.token).toBe(f.session.token);
    expect(bodies[1].session.token).toBe(other.token);
    expect(bodies[2]).toBeNull();
    expect(find).toHaveBeenCalledTimes(3);
    expect((await f.stored()).expiresAt).toBeGreaterThan(oldExpiry);
  });

  it("answers only its own token from the request-local lookup: a nested read of another token reaches the store", async () => {
    let other = "";
    const nested: unknown[] = [];
    // A later plugin's middleware on the same read, as any nested lookup would run.
    const probe: BetterAuthPlugin = { id: "nested-lookup-probe", hooks: { before: [{
      matcher: ctx => ctx.path === "/get-session",
      handler: createAuthMiddleware(async ctx => { nested.push(await ctx.context.internalAdapter.findSession(other)); }),
    }] } };
    const f = await fixture([probe]);
    other = (await f.context.internalAdapter.createSession(f.user.id)).token;
    const find = vi.spyOn(f.context.internalAdapter, "findSession");
    const response = await f.request();
    expect(await response.json()).toMatchObject({ session: { token: f.session.token } });
    expect(nested).toEqual([expect.objectContaining({ session: expect.objectContaining({ token: other }) })]);
    // One store read for this request's own token, one for the other: never this session answered for that token.
    expect(find.mock.calls.map(([token]) => token)).toEqual([f.session.token, other]);
  });

  it.each([NaN, Infinity, "invalid", null, {}, new Date(NaN)])("fails closed for invalid expiry %s", async expiresAt => {
    const f = await fixture();
    const persisted = await f.context.internalAdapter.findSession(f.session.token);
    vi.spyOn(f.context.internalAdapter, "findSession").mockResolvedValue({ ...persisted!, session: { ...persisted!.session, expiresAt: expiresAt as Date } });
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect((await f.buckets()).page.some((row: { key: string }) => row.key.startsWith("session-read:"))).toBe(false);
  });

  it("normalizes Date, epoch milliseconds and ISO strings without throwing", () => {
    const ms = Date.now();
    for (const value of [ms, new Date(ms), new Date(ms).toISOString()]) expect(sessionExpiryMs(value)).toBe(ms);
    for (const value of [undefined, null, {}, Symbol(), NaN, Infinity, 1e20, "bad", new Date(NaN)]) expect(sessionExpiryMs(value)).toBe(0);
  });

  it("treats values that throw while being inspected as already expired", () => {
    // A Date-prototyped object passes instanceof but getTime() throws; a revoked
    // proxy throws from instanceof itself. Neither may escape into the auth hook.
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [Object.create(Date.prototype), revoked.proxy]) expect(sessionExpiryMs(value)).toBe(0);
  });
});
