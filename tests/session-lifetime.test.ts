import { convexTest } from "convex-test";
import { betterAuth } from "better-auth/minimal";
import { hashPassword, makeSignature } from "better-auth/crypto";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components } from "../convex/_generated/api";
import { createAuthOptions } from "../convex/auth";
import { proxyAuthRequest } from "@/auth-proxy";
import { sessionCache, sessionMiddleware } from "@/middleware/session";
import { createViewerTicket, readViewerTicket } from "@/viewer-ticket";

const origin = "http://localhost:3000";
const day = 86400_000;
const password = "Local session lifetime password!";
const scope = { organizationId: "org", projectId: "project", manifestKey: "tenants/org/projects/project/deployments/deploy/manifest.json" };

afterEach(() => { sessionCache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture(rememberMe: boolean) {
  sessionCache.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const auth = betterAuth(createAuthOptions({ runQuery: backend.query, runMutation: backend.mutation } as never));
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({ name: "Reader", email: "lifetime@example.test", emailVerified: true });
  await context.internalAdapter.createAccount({ userId: user.id, accountId: user.id, providerId: "credential", password: await hashPassword(password) });
  // Only substitute the network transport; retain production auth, adapter,
  // limiter, Worker proxy, middleware and cache behavior.
  vi.stubGlobal("fetch", vi.fn((input: string, init: RequestInit) => auth.handler(new Request(`${origin}${new URL(input).pathname}`, init))));
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", sessionMiddleware);
  app.all("/api/auth/*", c => proxyAuthRequest(c.req.raw));
  app.get("*", c => c.get("user") ? c.json({ id: c.get("user")!.id }) : c.body(null, 401));
  const login = await app.request(`${origin}/api/auth/sign-in/email`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password, rememberMe }),
  });
  expect(login.status).toBe(200);
  const cookies = login.headers.getSetCookie();
  const cookie = cookies.map(value => value.split(";", 1)[0]).join("; ");
  const tokenCookie = cookies.find(value => value.startsWith("better-auth.session_token="))!;
  const token = (await login.json()).token as string;
  const stored = () => backend.query(components.betterAuth.adapter.findOne, { model: "session", where: [{ field: "token", value: token }] });
  const read = (path = "/organizations/reader", header = cookie) => app.request(`${origin}${path}`, { headers: { cookie: header } });
  return { app, auth, context, backend, token, user, cookie, cookies, tokenCookie, stored, read };
}

it.each([false, true])("preserves cookie attributes and backend lifetime through protected reads (remember=%s)", async remember => {
  const f = await fixture(remember);
  const initial = await f.stored() as { createdAt: number; expiresAt: number };
  expect(initial.expiresAt - initial.createdAt).toBe((remember ? 7 : 1) * day);
  expect(f.tokenCookie).toMatch(/; HttpOnly/i);
  expect(f.tokenCookie).toMatch(/; SameSite=Lax/i);
  if (remember) expect(f.tokenCookie).toMatch(/; Max-Age=604800(?:;|$)/i);
  else {
    expect(f.tokenCookie).not.toMatch(/; (?:Max-Age|Expires)=/i);
    const preference = f.cookies.find(value => value.startsWith("better-auth.dont_remember="));
    expect(preference).toBeDefined();
    expect(preference).not.toMatch(/; (?:Max-Age|Expires)=/i);
  }
  const find = vi.spyOn(f.context.internalAdapter, "findSession");
  for (let i = 0; i < 2; i++) {
    expect(await (await f.read()).json()).toEqual({ id: f.user.id });
  }
  expect(find).toHaveBeenCalledTimes(1); // marker must not disable cache coalescing/hits
  expect((await f.stored()).expiresAt).toBe(initial.expiresAt);
  vi.setSystemTime(Number(initial.createdAt) + (remember ? 2 * day : day - 1000));
  expect((await f.read()).status).toBe(200); // expired cache entry, fresh backend read
  expect((await f.read("/account/security")).status).toBe(200); // always fresh
  const expiry = remember ? Date.now() + 7 * day : initial.expiresAt;
  expect((await f.stored()).expiresAt).toBe(expiry);

  // Ticket-backed authorization also preserves the preference, even without
  // browser cookies on an opaque iframe's asset request.
  const ticket = await readViewerTicket(await createViewerTicket({ ...scope, cookie: f.cookie }), scope);
  expect(ticket).not.toBeNull();
  expect(await f.auth.api.getSession({ headers: new Headers({ cookie: ticket!.cookie }) })).not.toBeNull();
  expect((await f.stored()).expiresAt).toBe(expiry);

  if (!remember) {
    vi.setSystemTime(initial.expiresAt + 1);
    expect((await f.read("/account/security")).status).toBe(401);
    expect(await f.stored()).toBeNull();
  } else {
    const logout = await f.app.request(`${origin}/api/auth/sign-out`, { method: "POST", headers: { cookie: f.cookie, origin } });
    expect(logout.status).toBe(200);
    expect(await f.stored()).toBeNull();
    expect((await f.read()).status).toBe(401);
  }
});

it("ignores an unsigned preference and still refreshes a remembered session", async () => {
  const f = await fixture(true);
  const initial = await f.stored() as { createdAt: number; expiresAt: number };
  vi.setSystemTime(initial.createdAt + 2 * day);
  expect((await f.read("/account/security", `${f.cookie}; better-auth.dont_remember=true`)).status).toBe(200);
  expect((await f.stored()).expiresAt).toBe(Date.now() + 7 * day);
});

for (const remember of [false, true]) {
  it.each(["omitted", "corrupted", "forged", "signed-false", "signed-true"])(`uses persisted lifetime with %s marker (remember=${remember})`, async marker => {
    const f = await fixture(remember);
    const initial = await f.stored();
    expect(initial.rememberMe).toBe(remember);
    const tokenOnly = f.tokenCookie.split(";", 1)[0];
    const value = marker === "signed-false" || marker === "signed-true" ? marker.slice(7) : "true";
    const signed = `${value}.${await makeSignature(value, f.context.secret)}`;
    const suffix = marker === "omitted" ? "" : `; better-auth.dont_remember=${encodeURIComponent(marker.startsWith("signed-") ? signed : marker === "forged" ? "true" : "true.invalid")}`;
    const cookie = tokenOnly + suffix;
    vi.setSystemTime(Number(initial.createdAt) + (remember ? 2 * day : day - 1000));
    const expiry = remember ? Date.now() + 7 * day : initial.expiresAt;
    for (const path of ["/organizations/reader", "/organizations/reader", "/account/security", "/api/auth/get-session", "/api/auth/organization/list"]) {
      const response = await f.read(path, cookie);
      expect(response.status).toBe(200);
      expect((await f.stored()).expiresAt).toBe(expiry);
      if (!remember) {
        for (const setCookie of response.headers.getSetCookie().filter(c => c.startsWith("better-auth.session_token="))) {
          expect(setCookie).not.toMatch(/; (?:Max-Age|Expires)=/i);
        }
      }
    }
    const ticket = await readViewerTicket(await createViewerTicket({ ...scope, cookie }), scope);
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie: ticket!.cookie }) })).not.toBeNull();
    expect((await f.stored()).expiresAt).toBe(expiry);
    if (!remember) {
      vi.setSystemTime(Number(initial.expiresAt) + 1);
      expect((await f.read("/account/security", cookie)).status).toBe(401);
    }
  });

  it.each([false, true])(`inherits persisted lifetime on password rotation (remember=${remember}, marker intact=%s)`, async intact => {
    const f = await fixture(remember);
    const initial = await f.stored();
    vi.setSystemTime(Number(initial.createdAt) + 60_000);
    const cookie = intact ? f.cookie : f.tokenCookie.split(";", 1)[0];
    const response = await f.app.request(`${origin}/api/auth/change-password`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: password, newPassword: `${password} changed`, revokeOtherSessions: true, rememberMe: !remember }),
    });
    expect(response.status).toBe(200);
    const { token } = await response.json();
    expect(token).not.toBe(f.token);
    expect(await f.stored()).toBeNull();
    const replacement = await f.backend.query(components.betterAuth.adapter.findOne, { model: "session", where: [{ field: "token", value: token }] });
    expect(replacement.rememberMe).toBe(remember);
    expect(replacement.expiresAt - replacement.createdAt).toBe((remember ? 7 : 1) * day);
    const tokenCookie = response.headers.getSetCookie().find(c => c.startsWith("better-auth.session_token="))!;
    if (remember) expect(tokenCookie).toMatch(/; Max-Age=604800(?:;|$)/i);
    else expect(tokenCookie).not.toMatch(/; (?:Max-Age|Expires)=/i);
    expect((await f.read("/account/security", tokenCookie.split(";", 1)[0])).status).toBe(200);
    expect((await f.backend.query(components.betterAuth.adapter.findOne, { model: "session", where: [{ field: "token", value: token }] })).expiresAt).toBe(replacement.expiresAt);
  });
}

it("resolves a different revocation target without reusing the caller's session", async () => {
  const f = await fixture(false);
  const other = await f.context.internalAdapter.createSession(f.user.id);
  const response = await f.app.request(`${origin}/api/auth/revoke-session`, {
    method: "POST", headers: { cookie: f.cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ token: other.token }),
  });
  expect(response.status).toBe(200);
  expect(await f.context.internalAdapter.findSession(other.token)).toBeNull();
  expect(await f.stored()).not.toBeNull();
});

it.each([1, 7])("preserves legacy sessions with a %s-day stored duration", async duration => {
  const f = await fixture(false);
  const initial = await f.stored();
  // Model pre-migration records, including already extended non-remembered ones.
  await f.backend.mutation(components.betterAuth.adapter.updateOne, { input: {
    model: "session", where: [{ field: "token", value: f.token }],
    update: { rememberMe: null, expiresAt: initial.createdAt + duration * day },
  } });
  expect((await f.read("/account/security", f.tokenCookie.split(";", 1)[0])).status).toBe(200);
  expect((await f.stored()).expiresAt).toBe(initial.createdAt + duration * day);
});

it.each([false, true])("uses persisted choice when organization selection writes cookies (remember=%s)", async remember => {
  const f = await fixture(remember);
  // Clearing a selection is the cookie-writing path that needs no membership.
  await f.backend.mutation(components.betterAuth.adapter.updateOne, { input: {
    model: "session", where: [{ field: "token", value: f.token }], update: { activeOrganizationId: "selected" },
  } });
  const initial = await f.stored();
  const cookie = `${f.tokenCookie.split(";", 1)[0]}; better-auth.dont_remember=true.invalid`;
  const response = await f.app.request(`${origin}/api/auth/organization/set-active`, {
    method: "POST", headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ organizationId: null, rememberMe: !remember }),
  });
  expect(response.status).toBe(200);
  expect((await f.stored()).rememberMe).toBe(remember);
  expect((await f.stored()).expiresAt).toBe(initial.expiresAt);
  const tokenCookie = response.headers.getSetCookie().find(c => c.startsWith("better-auth.session_token="))!;
  expect(tokenCookie).toBeDefined();
  if (remember) expect(tokenCookie).toMatch(/; Max-Age=604800(?:;|$)/i);
  else expect(tokenCookie).not.toMatch(/; (?:Max-Age|Expires)=/i);
});

it("rejects client writes to the persisted lifetime choice", async () => {
  const f = await fixture(false);
  const initial = await f.stored();
  const response = await f.app.request(`${origin}/api/auth/update-session`, {
    method: "POST", headers: { cookie: f.cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ rememberMe: true }),
  });
  expect(response.status).toBe(400);
  expect(await f.stored()).toEqual(initial);
});
