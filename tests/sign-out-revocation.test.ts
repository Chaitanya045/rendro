import { createHmac } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../convex/auth";
import { api, components } from "../convex/_generated/api";
import { proxyAuthSignOut } from "@/auth-proxy";
import { sessionCache } from "@/session-cache";
import { fixture, repoAnchor } from "./helpers/comment-fixture";

const origin = "http://localhost:3000";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); sessionCache.clear(); });
async function runtime() {
  const f = await fixture();
  const user = f.data.users[0];
  const token = user.name;
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("base64")}`)}`;
  const handler = async (path: string, init?: RequestInit) => {
    let response!: Response;
    await f.backend.run(async ctx => {
    const auth = createAuth(ctx);
    // Better Auth deliberately skips Origin checks under NODE_ENV=test. Match
    // production for this real-handler regression without changing app options.
    (await auth.$context).skipOriginCheck = false;
    response = await auth.handler(new Request(`${origin}${path}`, init));
    });
    return response;
  };
  const request = (path: string, init?: RequestInit) => handler(`/api/auth${path}`, { ...init, headers: { cookie, ...Object.fromEntries(new Headers(init?.headers)) } });
  const fetch = vi.fn((url: string, init: RequestInit) => handler(new URL(url).pathname, init));
  vi.stubGlobal("fetch", fetch);
  const signOut = (method = "POST", requestOrigin: string | null = origin) => proxyAuthSignOut(new Request(`${origin}/api/auth/sign-out`, {
    method, headers: { cookie, ...(requestOrigin === null ? {} : { origin: requestOrigin }) },
  }));
  return { ...f, user, cookie, request, fetch, signOut };
}

describe("sign-out with the real Better Auth handler", () => {
  it("confirms the original missing-Origin failure and revokes through the POST proxy", async () => {
    const f = await runtime();
    const rejected = await f.request("/sign-out", { method: "POST" });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "MISSING_OR_NULL_ORIGIN" });
    expect(await (await f.request("/get-session?disableCookieCache=true")).json()).toMatchObject({ user: { id: f.user.userId } });
    const response = await f.signOut();
    expect(response.status).toBe(200);
    expect(response.headers.get("clear-site-data")).toBe('"cache"');
    expect(await (await f.request("/get-session?disableCookieCache=true")).json()).toBeNull();
    expect(new Headers(f.fetch.mock.calls[0][1].headers).get("origin")).toBe(origin);
  });

  it("GET renders a POST confirmation and cannot revoke or cause upstream CSRF", async () => {
    const f = await runtime();
    const response = await f.signOut("GET", null);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('method="post" action="/api/auth/sign-out"');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await (await f.request("/get-session?disableCookieCache=true")).json()).not.toBeNull();
  });

  it.each([null, "null", "https://attacker.invalid"])("rejects untrusted Origin %s before forwarding", async requestOrigin => {
    const f = await runtime();
    expect((await f.signOut("POST", requestOrigin)).status).toBe(403);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["GET", "untrusted POST", "POST"])("evicts cached identity on %s, including a lookup racing revocation", async mode => {
    const f = await runtime();
    const resolver = vi.fn(() => Promise.resolve({ kind: "authenticated" as const, user: { id: "user", email: "user@example.test", name: "User", emailVerified: true, image: null, createdAt: 1, updatedAt: 1 }, expiresAt: Date.now() + 60_000 }));
    await sessionCache.lookup(origin, f.cookie, resolver);
    await sessionCache.lookup(origin, f.cookie, resolver);
    expect(resolver).toHaveBeenCalledTimes(1);
    if (mode === "POST") f.fetch.mockImplementationOnce(async () => {
      await sessionCache.lookup(origin, f.cookie, resolver);
      return Response.json({ success: true });
    });
    const response = await f.signOut(mode === "GET" ? "GET" : "POST", mode === "untrusted POST" ? null : origin);
    expect(response.status).toBe(mode === "untrusted POST" ? 403 : 200);
    await sessionCache.lookup(origin, f.cookie, resolver);
    expect(resolver).toHaveBeenCalledTimes(mode === "POST" ? 3 : 2);
  });

  it.each([403, 500, 302, "network"])("retains cookies and offers retry on upstream %s, evicting cached identity", async failure => {
    const f = await runtime();
    const resolver = vi.fn(() => Promise.resolve({ kind: "authenticated" as const, user: { id: "user", email: "user@example.test", name: "User", emailVerified: true, image: null, createdAt: 1, updatedAt: 1 }, expiresAt: Date.now() + 60_000 }));
    await sessionCache.lookup(origin, f.cookie, resolver);
    if (failure === "network") f.fetch.mockRejectedValueOnce(new Error("private diagnostic"));
    else f.fetch.mockResolvedValueOnce(new Response("private diagnostic", { status: failure as number, headers: { "set-cookie": "better-auth.session_token=; Max-Age=0" } }));
    const response = await f.signOut();
    expect(response.status).toBe(502);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("clear-site-data")).toBe(false);
    const body = await response.text();
    expect(body).toContain("Try again");
    expect(body).not.toContain("private diagnostic");
    expect(await (await f.request("/get-session?disableCookieCache=true")).json()).not.toBeNull();
    await sessionCache.lookup(origin, f.cookie, resolver);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("rejects private reads and writes after revocation with an unexpired 15-minute JWT", async () => {
    const f = await runtime();
    const tokenResponse = await f.request("/convex/token");
    expect(tokenResponse.status).toBe(200);
    const { token } = await tokenResponse.json() as { token: string };
    const claims = decodeJwt(token);
    expect(claims.exp! - claims.iat!).toBe(900);
    expect(claims.sessionId).toBe(f.user.sessionId);
    const caller = f.backend.withIdentity({ ...claims, subject: claims.sub! });
    // A private repository whose comments only this reader holds a grant to.
    const privateScope = { repoId: 9102, path: "docs/private.md" };
    await f.backend.mutation(api.repoCommentAccess.grant, {
      internalSecret: process.env.CONVEX_INTERNAL_SECRET!, repoId: privateScope.repoId, userId: f.user.userId, epoch: 0, expiresAt: Date.now() + 60_000,
    });
    await caller.mutation(api.repoComments.createThread, { ...privateScope, body: "Before", anchor: repoAnchor() });
    const read = () => caller.query(api.repoComments.listThreads, { ...privateScope, paginationOpts: { numItems: 10, cursor: null } });
    expect((await read()).page).toHaveLength(1);
    expect((await f.signOut()).status).toBe(200);
    expect(claims.exp! * 1000).toBeGreaterThan(Date.now());
    expect(await f.backend.query(components.betterAuth.adapter.findOne, { model: "session", where: [{ field: "_id", value: f.user.sessionId }] })).toBeNull();
    // The revoked session reads as anonymous: the private repository's comments are an empty page, and no write lands.
    expect(await read()).toEqual({ page: [], isDone: true, continueCursor: "" });
    for (const call of [
      () => caller.mutation(api.repoComments.addReply, { ...f.scope, threadId: f.threadId, body: "Denied" }),
      () => caller.mutation(api.repoComments.createThread, { ...f.scope, body: "Denied", anchor: repoAnchor() }),
    ]) await expect(call()).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  });
});
