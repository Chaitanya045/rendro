import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCache, SESSION_CACHE_MAX_ENTRIES, sessionCacheKey } from "@/session-cache";
import { sessionCache, sessionMiddleware } from "@/middleware/session";
import { proxyAuthRequest, proxyAuthSignOut } from "@/auth-proxy";
import { logger } from "@/logger";

const cookie = "better-auth.session_token=raw-secret-signed-cookie";
const user = { id: "reader", email: "reader@example.test", name: "Reader", emailVerified: true,
  image: null, createdAt: 1, updatedAt: 1 };
const success = (id = "reader", expiresAt = Date.now() + 60_000) => ({ kind: "authenticated", id, expiresAt });
const payload = () => ({ user, session: { expiresAt: Date.now() + 60_000, token: "raw-backend-token" } });
function app() {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", sessionMiddleware);
  app.get("/", c => c.json({ id: c.get("user")?.id ?? null }));
  return app;
}

beforeEach(() => { sessionCache.clear(); vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { sessionCache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("bounded isolate session cache", () => {
  it("hashes only the cookie value and never stores or logs credentials", async () => {
    expect(await sessionCacheKey(`theme=dark; ${cookie}; better-auth.session_data=unused`))
      .toBe(createHash("sha256").update("raw-secret-signed-cookie").digest("hex"));
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(() => Response.json({ ...payload(), user: { ...user, token: "extra-secret" } })));
    await app().request("/", { headers: { cookie } });
    // Inspect actual retained entries, including resolved promises, not just the
    // hash helper. Response session/token and extra user properties are dropped.
    const entries = (sessionCache as unknown as { entries: Map<string, { value: unknown; pending: Promise<unknown> }> }).entries;
    expect(entries.size).toBe(1);
    expect([...entries.keys()][0]).toMatch(/^[a-f0-9]{64}$/);
    const retained = [...entries.values()];
    expect(JSON.stringify([...[...entries], ...await Promise.all(retained.map(e => e.pending)), debug.mock.calls, warn.mock.calls]))
      .not.toMatch(/raw-secret|raw-backend-token|extra-secret/);
  });

  it("hits without sliding TTL, misses at exactly 15s, and keeps cookies isolated", async () => {
    const cache = new SessionCache<ReturnType<typeof success>>();
    const resolve = vi.fn(() => Promise.resolve(success()));
    await cache.lookup(cookie, resolve);
    vi.setSystemTime(Date.now() + 14_999);
    await cache.lookup(cookie, resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    await cache.lookup(cookie, resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect((await cache.lookup(cookie + "-other", () => Promise.resolve(success("other")))).id).toBe("other");
    expect((await cache.lookup(cookie, resolve)).id).toBe("reader");
    // Identical values under a different cookie name must not share a result.
    expect((await cache.lookup(`__Secure-${cookie}`, () => Promise.resolve(success("secure")))).id).toBe("secure");
  });

  it("coalesces concurrent reads and does not extend TTL by backend latency", async () => {
    const cache = new SessionCache<ReturnType<typeof success>>();
    let finish!: (value: ReturnType<typeof success>) => void;
    const resolve = vi.fn(() => new Promise<ReturnType<typeof success>>(r => { finish = r; }));
    const first = cache.lookup(cookie, resolve);
    const second = cache.lookup(cookie, resolve);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    vi.setSystemTime(Date.now() + 10_000);
    finish(success());
    expect(await first).toEqual(await second);
    vi.setSystemTime(Date.now() + 5_000);
    const next = vi.fn(() => Promise.resolve(success()));
    await cache.lookup(cookie, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("bounds completed and pending entries with LRU eviction", async () => {
    const cache = new SessionCache<ReturnType<typeof success>>();
    for (let i = 0; i < SESSION_CACHE_MAX_ENTRIES; i++) await cache.lookup(`${cookie}-${i}`, () => Promise.resolve(success()));
    const resolve = vi.fn(() => Promise.resolve(success()));
    await cache.lookup(`${cookie}-0`, resolve); // touch oldest
    await cache.lookup(`${cookie}-new`, resolve);
    await cache.lookup(`${cookie}-0`, resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    await cache.lookup(`${cookie}-1`, resolve); // evicted
    expect(resolve).toHaveBeenCalledTimes(2);
    const entries = (cache as unknown as { entries: Map<string, unknown> }).entries;
    expect(entries.size).toBe(SESSION_CACHE_MAX_ENTRIES);
    const pending = Array.from({ length: SESSION_CACHE_MAX_ENTRIES + 1 }, (_, i) =>
      cache.lookup(`${cookie}-pending-${i}`, () => new Promise<ReturnType<typeof success>>(() => {})));
    await vi.waitFor(() => expect([...entries.values()].every(e => !(e as { value?: unknown }).value)).toBe(true));
    expect(entries.size).toBe(SESSION_CACHE_MAX_ENTRIES);
    void pending;
  });

  it.each([{ kind: "anonymous" }, { kind: "failure" }, success("expired", 0)])("never caches %j", async result => {
    const cache = new SessionCache<typeof result>();
    const resolve = vi.fn(() => Promise.resolve(result));
    await cache.lookup(cookie, resolve);
    await cache.lookup(cookie, resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not cache thrown failures or ambiguous/missing cookies", async () => {
    const cache = new SessionCache<ReturnType<typeof success>>();
    const reject = vi.fn(() => Promise.reject(new Error("offline")));
    for (let i = 0; i < 2; i++) await expect(cache.lookup(cookie, reject)).rejects.toThrow("offline");
    expect(reject).toHaveBeenCalledTimes(2);
    for (const header of ["", `${cookie}; __Secure-${cookie}`, `${cookie}; ${cookie}-other`]) {
      const resolve = vi.fn(() => Promise.resolve(success()));
      await cache.lookup(header, resolve);
      await cache.lookup(header, resolve);
      expect(resolve).toHaveBeenCalledTimes(2);
    }
  });

  it("does not repopulate after eviction of an in-flight lookup", async () => {
    const cache = new SessionCache<ReturnType<typeof success>>();
    let finish!: (value: ReturnType<typeof success>) => void;
    const resolve = vi.fn(() => new Promise<ReturnType<typeof success>>(r => { finish = r; }));
    const pending = cache.lookup(cookie, resolve);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    await cache.evict(cookie);
    finish(success());
    await pending;
    const next = vi.fn(() => Promise.resolve(success()));
    await cache.lookup(cookie, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("Worker cache integration", () => {
  it.each(["numeric", "ISO"])("caps TTL at %s session expiry and never caches an expired response", async shape => {
    const expiry = Date.now() + 2_000;
    const fetch = vi.fn(() => Response.json({ user, session: { expiresAt: shape === "ISO" ? new Date(expiry).toISOString() : expiry } }));
    vi.stubGlobal("fetch", fetch);
    const worker = app();
    const read = () => worker.request("/", { headers: { cookie } });
    expect(await (await read()).json()).toEqual({ id: "reader" });
    vi.setSystemTime(expiry - 1);
    await read();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(expiry);
    for (let i = 0; i < 2; i++) expect(await (await read()).json()).toEqual({ id: null });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([429, 500, 503])("never caches a %i lookup failure", async status => {
    const fetch = vi.fn(() => new Response(null, { status, headers: { "Retry-After": "60" } }));
    vi.stubGlobal("fetch", fetch);
    const worker = app();
    for (let i = 0; i < 2; i++) expect((await worker.request("/", { headers: { cookie } })).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(() => Response.json(payload()));
    expect((await worker.request("/", { headers: { cookie } })).status).toBe(200);
  });

  it.each(["GET sign-out", "POST sign-out", "revoke-session", "revoke-sessions", "revoke-other-sessions", "change-password", "reset-password", "delete-user"])("evicts on %s through the Worker", async operation => {
    let revoked = false;
    const fetch = vi.fn((url: string | URL | Request) => {
      if ((typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith("/get-session")) return Response.json(revoked ? null : payload());
      revoked = true;
      return Response.json({ success: true });
    });
    vi.stubGlobal("fetch", fetch);
    const worker = app();
    await worker.request("/", { headers: { cookie } });
    const path = operation.includes("sign-out") ? "sign-out" : operation;
    const req = new Request(`http://localhost:3000/api/auth/${path}`, { method: operation === "GET sign-out" ? "GET" : "POST", headers: { cookie } });
    if (operation === "GET sign-out") await proxyAuthSignOut(req);
    else await proxyAuthRequest(req);
    expect(await (await worker.request("/", { headers: { cookie } })).json()).toEqual({ id: null });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps unrelated entries on sign-out and rejected anonymous revocation", async () => {
    const resolve = vi.fn(() => Promise.resolve({ kind: "authenticated" as const, user, expiresAt: Date.now() + 60_000 }));
    await sessionCache.lookup(cookie, () => Promise.resolve({ kind: "authenticated", user, expiresAt: Date.now() + 60_000 }));
    vi.stubGlobal("fetch", vi.fn(() => Response.json({ error: "Denied" }, { status: 401 })));
    for (const operation of ["sign-out", "revoke-session", "revoke-sessions"]) {
      await proxyAuthRequest(new Request(`http://localhost:3000/api/auth/${operation}`, { method: "POST" }));
    }
    await proxyAuthSignOut(new Request("http://localhost:3000/api/auth/sign-out"));
    await sessionCache.lookup(cookie, resolve);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("invalidates another session on successful targeted revocation or deletion callback redirect", async () => {
    for (const [path, status] of [["revoke-session", 200], ["delete-user/callback", 302]] as const) {
      const resolve = vi.fn(() => Promise.resolve({ kind: "authenticated" as const, user, expiresAt: Date.now() + 60_000 }));
      await sessionCache.lookup(cookie, resolve);
      vi.stubGlobal("fetch", vi.fn(() => new Response(null, { status })));
      await proxyAuthRequest(new Request(`http://localhost:3000/api/auth/${path}`, {
        method: path === "revoke-session" ? "POST" : "GET", headers: { cookie: cookie + "-other" },
      }));
      await sessionCache.lookup(cookie, resolve);
      expect(resolve).toHaveBeenCalledTimes(2);
      sessionCache.clear();
    }
  });

  it("returns retryable 503 instead of stale identity when refresh after TTL fails", async () => {
    const fetch = vi.fn(() => Response.json(payload()));
    vi.stubGlobal("fetch", fetch);
    const worker = app();
    await worker.request("/", { headers: { cookie } });
    vi.setSystemTime(Date.now() + 15_000);
    fetch.mockImplementation(() => new Response(null, { status: 503, headers: { "Retry-After": "60" } }));
    for (let i = 0; i < 2; i++) expect((await worker.request("/", { headers: { cookie } })).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("evicts sign-out even when upstream fails", async () => {
    const fetch = vi.fn(() => Response.json(payload()));
    vi.stubGlobal("fetch", fetch);
    await app().request("/", { headers: { cookie } });
    fetch.mockRejectedValueOnce(new Error("offline"));
    await proxyAuthSignOut(new Request("http://localhost:3000/api/auth/sign-out", { headers: { cookie } }));
    await app().request("/", { headers: { cookie } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
