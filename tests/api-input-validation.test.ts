import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { betterAuth } from "better-auth/minimal";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { internal } from "../convex/_generated/api";
import { createAuthOptions } from "../convex/auth";
import { API_KEY_MAX_LIFETIME_MS, sha256, validExpiresAt } from "../convex/credentialHttp";
import { failure } from "../convex/httpErrors";
import { hasIllFormedText, IllFormedTextError, INVALID_TEXT_MESSAGE, jsonTextHasIllFormedText, requireWellFormedBody } from "../shared/text-input";
import rateLimiterTest from "./convex-rate-limiter";
import worker from "../src/worker";

const origin = "http://localhost:3000";
const transports = ["convex", "worker"] as const;
type Transport = typeof transports[number];
const lone = "a\ud800b";
const day = 24 * 60 * 60 * 1000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture() {
  const t = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  t.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  rateLimiterTest.register(t);
  const context = await betterAuth(createAuthOptions({ runQuery: t.query, runMutation: t.mutation } as never)).$context;
  const user = await context.internalAdapter.createUser({ name: "owner", email: "owner@example.test", emailVerified: true });
  const { token } = await context.internalAdapter.createSession(user.id);
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("base64")}`)}`;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    return t.fetch(`${url.pathname}${url.search}`, init);
  }));
  // Raw text lets a test send an escape sequence no JSON.stringify call would produce.
  function call(transport: Transport, path: string, body?: unknown, raw?: string) {
    const headers: Record<string, string> = { origin, cookie };
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined) headers["content-type"] = "application/json";
    const init = { method: payload === undefined ? "GET" : "POST", headers, ...(payload === undefined ? {} : { body: payload }) };
    return transport === "worker" ? worker.request(`${origin}${path}`, init) : t.fetch(path, init);
  }
  const created = await call("convex", "/api/auth/organization/create", { name: "Acme", slug: "acme" });
  expect(created.status).toBe(200);
  const organizationId = (await created.json() as { id: string }).id;
  return { t, call, organizationId };
}

describe("well-formed text helpers", () => {
  it("walks keys, nested arrays and objects without recursion", () => {
    expect(hasIllFormedText("fine 😀")).toBe(false);
    expect(hasIllFormedText(lone)).toBe(true);
    expect(hasIllFormedText(["ok", { deep: ["ok", { [lone]: 1 }] }])).toBe(true);
    expect(hasIllFormedText({ list: ["ok", [lone]] })).toBe(true);
    expect(hasIllFormedText({ ok: [1, true, null, undefined, { more: "text" }] })).toBe(false);
    let nested: unknown = lone;
    for (let level = 0; level < 200_000; level++) nested = [nested];
    expect(hasIllFormedText(nested)).toBe(true);
  });

  it("flags only surrogate escapes that decode to an unpaired surrogate", () => {
    expect(jsonTextHasIllFormedText('{"a":"\\ud800"}')).toBe(true);
    expect(jsonTextHasIllFormedText('{"a":"\\udc00x"}')).toBe(true);
    expect(jsonTextHasIllFormedText('{"a":"\\ud83d\\ude00"}')).toBe(false);
    // An escaped backslash followed by plain text is not an escape sequence.
    expect(jsonTextHasIllFormedText('{"a":"\\\\ud800"}')).toBe(false);
    expect(jsonTextHasIllFormedText('{"\\ud800":1}')).toBe(true);
    expect(jsonTextHasIllFormedText('{"a":"plain 😀"}')).toBe(false);
    // Text that is not JSON is left for the handler's own parse error.
    expect(jsonTextHasIllFormedText('{"a":"\\ud800"')).toBe(false);
    expect(jsonTextHasIllFormedText("not json \\ud800")).toBe(false);
  });

  it("rejects an ill-formed write body without consuming it and ignores reads and empty bodies", async () => {
    const post = (body?: string) => new Request("https://rendro.test/x", { method: "POST", body });
    const request = post('{"name":"\\ud800"}');
    const error = await requireWellFormedBody(request).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(IllFormedTextError);
    expect(request.bodyUsed).toBe(false);
    const response = (error as IllFormedTextError).response();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: INVALID_TEXT_MESSAGE });
    await expect(requireWellFormedBody(post('{"name":"ok"}'))).resolves.toBeUndefined();
    await expect(requireWellFormedBody(post())).resolves.toBeUndefined();
    await expect(requireWellFormedBody(new Request("https://rendro.test/x"))).resolves.toBeUndefined();
    const get = new Request("https://rendro.test/x?q=%ED%A0%80");
    expect(new URL(get.url).searchParams.get("q")?.isWellFormed()).toBe(true);
    expect(failure(new IllFormedTextError()).status).toBe(400);
  });
});

describe("ill-formed text at the API boundary", () => {
  it.each(transports)("is a 400 validation error, not a backend outage, for project names, keys, publications and auth (%s)", async (transport) => {
    const f = await fixture();
    const expected = { error: INVALID_TEXT_MESSAGE };
    const bodies: Array<[string, unknown]> = [
      ["/api/rendro/projects", { organizationId: f.organizationId, name: lone, slug: "unicode" }],
      ["/api/rendro/projects", { organizationId: f.organizationId, name: "Fine", slug: "a\udc00" }],
      ["/api/rendro/credentials", { organizationId: f.organizationId, name: lone, scopes: ["docs:read"] }],
      ["/api/rendro/publications", { organizationId: f.organizationId, projectId: "p", slug: "s", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", title: lone }],
      ["/api/rendro/shares", { organizationId: f.organizationId, projectId: "p", documentPath: lone, expiresInSeconds: 600 }],
      ["/api/auth/organization/create", { name: lone, slug: "unicode" }],
      ["/api/auth/organization/create-team", { organizationId: f.organizationId, name: `Team ${lone}` }],
      ["/api/auth/organization/update", { organizationId: f.organizationId, data: { name: "x", metadata: { note: [lone] } } }],
    ];
    for (const [path, body] of bodies) {
      const response = await f.call(transport, path, body);
      expect(response.status, path).toBe(400);
      expect(await response.json(), path).toEqual(expected);
    }
    // Raw escapes, nested keys and a lone low surrogate behave the same way.
    for (const raw of ['{"organizationId":"o","name":"\\udfff","slug":"x"}', '{"organizationId":"o","name":"n","slug":"x","\\ud800":1}']) {
      const response = await f.call(transport, "/api/rendro/projects", undefined, raw);
      expect(response.status, raw).toBe(400);
      expect(await response.json(), raw).toEqual(expected);
    }
    expect(await f.t.query(internal.projects.listInternal, { organizationId: f.organizationId })).toEqual([]);
  });

  it.each(transports)("still accepts valid surrogate pairs, escaped backslashes and malformed JSON keeps its own error (%s)", async (transport) => {
    const f = await fixture();
    const emoji = await f.call(transport, "/api/rendro/projects", { organizationId: f.organizationId, name: "Docs 😀", slug: "emoji" });
    expect(emoji.status).toBe(201);
    expect((await emoji.json() as { project: { name: string } }).project.name).toBe("Docs 😀");
    const literal = await f.call(transport, "/api/rendro/projects", undefined, '{"organizationId":"' + f.organizationId + '","name":"\\\\ud800","slug":"literal"}');
    expect(literal.status).toBe(201);
    expect((await literal.json() as { project: { name: string } }).project.name).toBe("\\ud800");
    const broken = await f.call(transport, "/api/rendro/projects", undefined, '{"name":"\\ud800"');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: "Invalid JSON body" });
  });
});

describe("API key expiry", () => {
  it("accepts only a finite integer in the future and within the longest lifetime", () => {
    const now = 1_700_000_000_000;
    expect(API_KEY_MAX_LIFETIME_MS).toBe(366 * day);
    for (const value of [now + 1, now + 30 * day, now + 365 * day, now + API_KEY_MAX_LIFETIME_MS]) expect(validExpiresAt(value, now), String(value)).toBe(true);
    for (const value of [now, now - 1, 0, -1, now + API_KEY_MAX_LIFETIME_MS + 1, 1e300, 1e21, 8.64e15 + 1, Number.MAX_SAFE_INTEGER + 2, now + 1.5, NaN, Infinity, -Infinity, "1900000000000", null, undefined, {}, true]) {
      expect(validExpiresAt(value, now), String(value)).toBe(false);
    }
  });

  it.each(transports)("rejects out-of-range expiries with the existing 400 shape and keeps the product choices (%s)", async (transport) => {
    const f = await fixture();
    const create = (expiresAt: unknown, name = "Key") => f.call(transport, "/api/rendro/credentials", { organizationId: f.organizationId, name, scopes: ["docs:read"], expiresAt });
    const now = Date.now();
    for (const expiresAt of [1e300, now - 1000, now + 400 * day, now + 1.5 * day + 0.5, "soon", null, -1, 0]) {
      const response = await create(expiresAt);
      expect(response.status, String(expiresAt)).toBe(400);
      expect(await response.json(), String(expiresAt)).toEqual({ error: "Invalid credential fields" });
    }
    for (const [name, expiresAt] of [["30", now + 30 * day], ["90", now + 90 * day], ["365", now + 365 * day], ["never", undefined]] as const) {
      const response = await create(expiresAt, name);
      expect(response.status, name).toBe(201);
      expect((await response.json() as { credential: { expiresAt?: number } }).credential.expiresAt).toBe(expiresAt);
    }
    const stored = await f.t.query(internal.apiKeyCredentials.listInternal, { organizationId: f.organizationId });
    expect(stored.map(key => key.name).sort()).toEqual(["30", "365", "90", "never"]);
  });

  it("keeps authorizing keys stored before the range was enforced", async () => {
    const f = await fixture();
    const project = (await f.t.mutation(internal.projects.createInternal, { organizationId: f.organizationId, name: "Docs", slug: "docs", actorId: "owner" }))!;
    const secretHash = await sha256("far-future-key");
    await f.t.mutation(internal.apiKeyCredentials.createInternal, {
      organizationId: f.organizationId, projectId: project._id, keyId: "far", keyPrefix: "far", name: "Far", secretHash, scopes: ["docs:read"], expiresAt: 1e300, actorId: "owner",
    });
    const query = new URLSearchParams({ organizationId: f.organizationId, projectId: project._id, scope: "docs:read" });
    const response = await f.t.fetch(`/api/rendro/credentials/validate?${query}`, { headers: { authorization: "Bearer far-future-key" } });
    expect(response.status).toBe(200);
  });
});

describe("API key permissions", () => {
  it.each(transports)("are stored once, in first-seen order, and unknown permissions still fail (%s)", async (transport) => {
    const f = await fixture();
    const create = (scopes: unknown) => f.call(transport, "/api/rendro/credentials", { organizationId: f.organizationId, name: "Dup", scopes });
    const created = await create(["docs:write", "docs:read", "docs:write", "docs:read", "docs:read"]);
    expect(created.status).toBe(201);
    expect((await created.json() as { credential: { scopes: string[] } }).credential.scopes).toEqual(["docs:write", "docs:read"]);
    const [stored] = await f.t.query(internal.apiKeyCredentials.listInternal, { organizationId: f.organizationId });
    expect(stored.scopes).toEqual(["docs:write", "docs:read"]);
    for (const scopes of [["docs:read", "docs:admin"], [], "docs:read", [1], null]) {
      const response = await create(scopes);
      expect(response.status, JSON.stringify(scopes)).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid credential fields" });
    }
  });

  it("still authorize keys that were stored with repeated permissions", async () => {
    const f = await fixture();
    const secretHash = await sha256("duplicate-scope-key");
    await f.t.mutation(internal.apiKeyCredentials.createInternal, {
      organizationId: f.organizationId, keyId: "dup", keyPrefix: "dup", name: "Dup", secretHash, scopes: ["docs:read", "docs:read", "publications:read"], actorId: "owner",
    });
    const validate = (scope: string) => f.t.fetch(`/api/rendro/credentials/validate?${new URLSearchParams({ organizationId: f.organizationId, scope })}`, { headers: { authorization: "Bearer duplicate-scope-key" } });
    const allowed = await validate("docs:read");
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ principal: { keyId: "dup", scopes: ["docs:read", "docs:read", "publications:read"] } });
    expect((await validate("publications:read")).status).toBe(200);
    expect((await validate("docs:write")).status).toBe(401);
  });
});
