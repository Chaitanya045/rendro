import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { betterAuth } from "better-auth/minimal";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components } from "../convex/_generated/api";
import { internal as authInternal } from "../convex/betterAuth/_generated/api";
import { createAuthOptions } from "../convex/auth";
import { sessionExpiryMs } from "../convex/sessionReadLimit";
import { sessionMiddleware } from "@/middleware/session";

const baseURL = "http://localhost:3000";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture() {
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  // Keep the production database and plugins. Only the Convex RPC transport is
  // local: customTransformOutput in @convex-dev/better-auth returns numeric dates.
  const auth = betterAuth(createAuthOptions({
    runQuery: backend.query,
    runMutation: backend.mutation,
  } as never));
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({ name: "Reader", email: "reader@example.test", emailVerified: true });
  const session = await context.internalAdapter.createSession(user.id);
  const cookie = (token: string) => `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("base64")}`)}`;
  const request = (token = session.token) => auth.handler(new Request(`${baseURL}/api/auth/get-session`, { headers: { cookie: cookie(token) } }));
  const stored = () => backend.query(components.betterAuth.adapter.findOne, { model: "session", where: [{ field: "token", value: session.token }] });
  const buckets = () => backend.query(components.betterAuth.adapter.findMany, { model: "rateLimit", paginationOpts: { numItems: 100, cursor: null } });
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

  it("cleans expired custom windows in bounded indexed batches and preserves credential buckets", async () => {
    vi.useFakeTimers();
    // Run within the component, just like its own cron and continuations.
    const backend = convexTest(authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
    const now = Date.now();
    for (let i = 0; i < 240; i++) {
      await backend.run(ctx => ctx.db.insert("rateLimit", {
        key: i < 110 ? `192.0.2.${i}|/sign-in/email` : `${["session-read:", "session-read-ip:", "session-read-unverified:"][i % 3]}${i}`,
        count: 5, lastRequest: now - 60_000,
      }));
    }
    for (const key of ["session-read:current", "session-read-ip:current", "session-read-unverified:current", "192.0.2.1|/request-password-reset", "192.0.2.1|/send-verification-email"]) {
      await backend.run(ctx => ctx.db.insert("rateLimit", { key, count: 5, lastRequest: now - 59_999 }));
    }
    await backend.mutation(authInternal.sessionReadLimit.cleanup, {});
    // First page contains only built-in buckets: continuation must still run.
    await backend.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await backend.run(ctx => ctx.db.query("rateLimit").collect());
    expect(rows).toHaveLength(115);
    expect(rows.filter(row => row.key.startsWith("session-read"))).toHaveLength(3);
    expect(rows.every(row => row.count === 5)).toBe(true);
  });
});
