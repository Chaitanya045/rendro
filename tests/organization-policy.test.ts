import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { betterAuth } from "better-auth/minimal";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components } from "../convex/_generated/api";
import { createAuthOptions } from "../convex/auth";
import { invitationListPrivacy, isOrganizationSlug, organizationFieldHooks } from "../convex/organizationPolicy";
import rateLimiterTest from "./convex-rate-limiter";
import worker from "../src/worker";

const origin = "http://localhost:3000";
const roles = ["owner", "admin", "member", "outsider"] as const;
type Role = typeof roles[number];
type Caller = Role | "anonymous";
const transports = ["convex", "worker"] as const;
type Transport = typeof transports[number];

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture() {
  const t = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  t.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  rateLimiterTest.register(t);
  const auth = betterAuth(createAuthOptions({ runQuery: t.query, runMutation: t.mutation } as never));
  const context = await auth.$context;
  const users = {} as Record<Role, { id: string; email: string }>;
  const tokens = {} as Record<Role, string>;
  const cookies = {} as Record<Caller, string | undefined>;
  for (const role of roles) {
    users[role] = await context.internalAdapter.createUser({ name: role, email: `${role}@example.test`, emailVerified: true });
    const { token } = await context.internalAdapter.createSession(users[role].id);
    tokens[role] = token;
    cookies[role] = `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("base64")}`)}`;
  }
  // Only the network transport is replaced: the production Worker proxy reaches
  // the real Convex HTTP router, Better Auth handler, plugins and adapter.
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    return t.fetch(`${url.pathname}${url.search}`, init);
  }));
  function call(transport: Transport, caller: Caller, path: string, body?: unknown) {
    const headers: Record<string, string> = { origin };
    if (cookies[caller]) headers.cookie = cookies[caller];
    if (body !== undefined) headers["content-type"] = "application/json";
    const init = { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    return transport === "worker" ? worker.request(`${origin}${path}`, init) : t.fetch(path, init);
  }
  const created = await call("convex", "owner", "/api/auth/organization/create", { name: "Acme", slug: "acme" });
  expect(created.status).toBe(200);
  const organizationId = (await created.json()).id as string;
  const elsewhere = await call("convex", "outsider", "/api/auth/organization/create", { name: "Elsewhere", slug: "elsewhere" });
  expect(elsewhere.status).toBe(200);
  const members = {} as Record<"admin" | "member", string>;
  for (const role of ["admin", "member"] as const) {
    members[role] = String((await context.adapter.create<{ id: string }>({
      model: "member", data: { organizationId, userId: users[role].id, role, createdAt: new Date() },
    })).id);
  }
  await context.adapter.create({ model: "invitation", data: {
    organizationId, email: "invitee@example.test", role: "member", status: "pending",
    inviterId: users.owner.id, expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
  } });
  const organization = async (id: string) => await t.query(components.betterAuth.adapter.findOne, {
    model: "organization", where: [{ field: "_id", value: id }],
  }) as { slug: string; name: string } | null;
  const setRole = (role: "admin" | "member", value: string) => context.adapter.update({
    model: "member", where: [{ field: "id", value: members[role] }], update: { role: value },
  });
  return { t, auth, context, users, tokens, cookies, call, organizationId, elsewhereId: (await elsewhere.json() as { id: string }).id, organization, setRole };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const list = (f: Fixture, transport: Transport, caller: Caller, organizationId = f.organizationId) =>
  f.call(transport, caller, `/api/auth/organization/list-invitations?organizationId=${encodeURIComponent(organizationId)}`);
const full = (f: Fixture, transport: Transport, caller: Caller, organizationId = f.organizationId) =>
  f.call(transport, caller, `/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(organizationId)}`);

describe("organization invitation list", () => {
  it.each(transports)("is readable only by owners and admins through every endpoint that returns it (%s)", async (transport) => {
    const f = await fixture();
    for (const role of ["owner", "admin"] as const) {
      const listed = await list(f, transport, role);
      expect(listed.status, role).toBe(200);
      expect((await listed.json() as Array<{ email: string }>).map(entry => entry.email), role).toEqual(["invitee@example.test"]);
      const organization = await full(f, transport, role);
      expect(organization.status, role).toBe(200);
      expect((await organization.json() as { invitations: Array<{ email: string }> }).invitations.map(entry => entry.email), role).toEqual(["invitee@example.test"]);
    }

    const denied = await list(f, transport, "member");
    expect(denied.status).toBe(403);
    const deniedBody = await denied.text();
    expect(JSON.parse(deniedBody)).toMatchObject({ code: "YOU_ARE_NOT_ALLOWED_TO_LIST_INVITATIONS" });
    expect(deniedBody).not.toContain("invitee@example.test");
    // Members keep the organization and roster they need; only invitations are withheld.
    const memberView = await full(f, transport, "member");
    expect(memberView.status).toBe(200);
    const memberBody = await memberView.text();
    expect(memberBody).not.toContain("invitee@example.test");
    const memberOrganization = JSON.parse(memberBody) as { id: string; name: string; invitations: unknown[]; members: Array<{ user: { email: string } }> };
    expect(memberOrganization).toMatchObject({ id: f.organizationId, name: "Acme", invitations: [] });
    expect(memberOrganization.members.map(entry => entry.user.email).sort()).toEqual(["admin@example.test", "member@example.test", "owner@example.test"]);

    // Non-members and anonymous callers keep Better Auth's own denials.
    expect((await list(f, transport, "outsider")).status).toBe(403);
    expect((await full(f, transport, "outsider")).status).toBe(403);
    expect((await list(f, transport, "anonymous")).status).toBe(401);
    expect((await full(f, transport, "anonymous")).status).toBe(401);
    // A manager of another organization gains nothing here.
    expect((await list(f, transport, "outsider", f.elsewhereId)).status).toBe(200);
    expect((await list(f, transport, "member", f.elsewhereId)).status).toBe(403);
  });

  it.each(transports)("applies the active organization when no organization is named (%s)", async (transport) => {
    const f = await fixture();
    for (const role of ["owner", "member"] as const) {
      await f.context.internalAdapter.updateSession(f.tokens[role], { activeOrganizationId: f.organizationId });
    }
    expect((await f.call(transport, "owner", "/api/auth/organization/list-invitations")).status).toBe(200);
    expect((await f.call(transport, "member", "/api/auth/organization/list-invitations")).status).toBe(403);
    const memberView = await f.call(transport, "member", "/api/auth/organization/get-full-organization");
    expect(await memberView.json()).toMatchObject({ id: f.organizationId, invitations: [] });
    // Without an organization, Better Auth's own responses are unchanged.
    expect((await f.call(transport, "admin", "/api/auth/organization/list-invitations")).status).toBe(400);
    const none = await f.call(transport, "admin", "/api/auth/organization/get-full-organization");
    expect(none.status).toBe(200);
    expect(await none.json()).toBeNull();
  });

  it("reads the caller's role freshly on every request", async () => {
    const f = await fixture();
    expect((await list(f, "convex", "admin")).status).toBe(200);
    await f.setRole("admin", "member");
    expect((await list(f, "convex", "admin")).status).toBe(403);
    expect(await (await full(f, "convex", "admin")).json()).toMatchObject({ invitations: [] });
    await f.setRole("member", "member, admin");
    expect((await list(f, "convex", "member")).status).toBe(200);
    expect((await (await full(f, "convex", "member")).json() as { invitations: unknown[] }).invitations).toHaveLength(1);
  });

  it("applies to server API calls as well as HTTP", async () => {
    const f = await fixture();
    const headers = (role: Role) => new Headers({ cookie: f.cookies[role]! });
    const query = { organizationId: f.organizationId };
    await expect(f.auth.api.listInvitations({ headers: headers("member"), query })).rejects.toMatchObject({ statusCode: 403 });
    expect(await f.auth.api.getFullOrganization({ headers: headers("member"), query })).toMatchObject({ invitations: [] });
    // The hook re-resolves the endpoint's session from the request-local lookup.
    const find = vi.spyOn(f.context.internalAdapter, "findSession");
    expect(await f.auth.api.listInvitations({ headers: headers("owner"), query })).toHaveLength(1);
    expect(await f.auth.api.getFullOrganization({ headers: headers("owner"), query })).toMatchObject({ invitations: [{ email: "invitee@example.test" }] });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("fails closed for results it cannot attribute to a manager", async () => {
    const [hook] = invitationListPrivacy().hooks!.after!;
    const secret = process.env.AUTH_SECRET!;
    const cookie = `better-auth.session_token=${encodeURIComponent(`token.${createHmac("sha256", secret).update("token").digest("base64")}`)}`;
    const findSession = vi.fn(() => Promise.resolve({ user: { id: "user" }, session: {} }));
    const findOne = vi.fn(() => Promise.resolve({ role: "owner" }));
    const run = (path: string, returned: unknown, query?: unknown, signed = true) => hook.handler({
      path, query, headers: new Headers(signed ? { cookie } : {}),
      context: { returned, secret, authCookies: { sessionToken: { name: "better-auth.session_token" } }, internalAdapter: { findSession }, adapter: { findOne } },
    } as never);
    const forbidden = { statusCode: 403 };
    // Neither a named nor an active organization.
    await expect(run("/organization/list-invitations", [])).rejects.toMatchObject(forbidden);
    // No session cookie, or a session that no longer resolves.
    await expect(run("/organization/list-invitations", [], { organizationId: "org" }, false)).rejects.toMatchObject(forbidden);
    expect(await run("/organization/get-full-organization", { id: "org", invitations: [{}] }, undefined, false)).toEqual({ id: "org", invitations: [] });
    findSession.mockResolvedValueOnce(null as never);
    await expect(run("/organization/list-invitations", [], { organizationId: "org" })).rejects.toMatchObject(forbidden);
    await expect(run("/organization/list-invitations", [{ organizationId: 7 }], { organizationId: "org" })).rejects.toMatchObject(forbidden);
    expect(await run("/organization/get-full-organization", "unexpected")).toBeUndefined();
    expect(await run("/organization/list-invitations", [{ organizationId: "org" }], { organizationId: "org" })).toBeUndefined();
    findOne.mockResolvedValueOnce(null as never);
    expect(await run("/organization/get-full-organization", { id: "org", invitations: [{}] })).toEqual({ id: "org", invitations: [] });
    // A list spanning organizations needs management rights in each one.
    findOne.mockResolvedValueOnce({ role: "admin" }).mockResolvedValueOnce({ role: "member" });
    await expect(run("/organization/list-invitations", [{ organizationId: "other" }], { organizationId: "org" })).rejects.toBeInstanceOf(APIError);
  });
});

describe("organization slug", () => {
  const invalid = ["Not A Slug", "UPPER", "-lead", "trail-", "double--hyphen", "under_score", "a".repeat(49), "ünïcode", " padded", ""];

  it("accepts exactly the form's lowercase hyphenated format up to 48 characters", () => {
    for (const slug of ["a", "acme-docs", "a1-b2-c3", "a".repeat(48)]) expect(isOrganizationSlug(slug), slug).toBe(true);
    for (const slug of [...invalid, undefined, 7]) expect(isOrganizationSlug(slug), String(slug)).toBe(false);
  });

  it.each(transports)("is validated on create and update before anything is written (%s)", async (transport) => {
    const f = await fixture();
    const count = async () => (await f.t.query(components.betterAuth.adapter.findMany, {
      model: "organization", paginationOpts: { numItems: 100, cursor: null },
    }) as { page: unknown[] }).page.length;
    const before = await count();
    for (const slug of invalid) {
      const response = await f.call(transport, "owner", "/api/auth/organization/create", { name: "Bad", slug });
      expect(response.status, JSON.stringify(slug)).toBe(400);
      // Better Auth rejects the empty slug in its own schema before the hook.
      if (slug) expect(await response.json(), slug).toMatchObject({ code: "INVALID_ORGANIZATION_SLUG", message: "Organization slug must contain lowercase letters, numbers, and hyphens" });
    }
    expect(await count()).toBe(before);
    expect((await f.call(transport, "owner", "/api/auth/organization/create", { name: "Long", slug: "a".repeat(48) })).status).toBe(200);

    for (const slug of invalid.filter(Boolean)) {
      const response = await f.call(transport, "owner", "/api/auth/organization/update", { organizationId: f.organizationId, data: { slug } });
      expect(response.status, slug).toBe(400);
      expect(await response.json(), slug).toMatchObject({ code: "INVALID_ORGANIZATION_SLUG" });
    }
    expect(await f.organization(f.organizationId)).toMatchObject({ slug: "acme", name: "Acme" });
    const renamed = await f.call(transport, "admin", "/api/auth/organization/update", { organizationId: f.organizationId, data: { name: "Acme Docs", slug: "acme-docs" } });
    expect(renamed.status).toBe(200);
    expect(await f.organization(f.organizationId)).toMatchObject({ slug: "acme-docs", name: "Acme Docs" });

    // Role and authentication checks still come first, with their own errors.
    expect((await f.call(transport, "member", "/api/auth/organization/update", { organizationId: f.organizationId, data: { slug: "Bad Slug" } })).status).toBe(403);
    expect((await f.call(transport, "outsider", "/api/auth/organization/update", { organizationId: f.organizationId, data: { slug: "Bad Slug" } })).status).toBe(400);
    expect((await f.call(transport, "anonymous", "/api/auth/organization/update", { organizationId: f.organizationId, data: { slug: "Bad Slug" } })).status).toBe(401);
    expect((await f.call(transport, "anonymous", "/api/auth/organization/create", { name: "Bad", slug: "Bad Slug" })).status).toBe(401);
    expect(await f.organization(f.organizationId)).toMatchObject({ slug: "acme-docs" });
  });

  it("keeps organizations with legacy slugs working and validates only a new slug", async () => {
    const f = await fixture();
    const legacy = await f.context.adapter.create<{ id: string }>({ model: "organization", data: { name: "Legacy", slug: "Legacy Org", createdAt: new Date() } });
    const legacyId = String(legacy.id);
    await f.context.adapter.create({ model: "member", data: { organizationId: legacyId, userId: f.users.owner.id, role: "owner", createdAt: new Date() } });
    const update = (data: object) => f.call("convex", "owner", "/api/auth/organization/update", { organizationId: legacyId, data });
    expect((await full(f, "convex", "owner", legacyId)).status).toBe(200);
    expect((await update({ name: "Legacy renamed" })).status).toBe(200);
    // The settings form always resubmits the stored slug alongside the name.
    expect((await update({ name: "Legacy again", slug: "Legacy Org" })).status).toBe(200);
    expect(await f.organization(legacyId)).toMatchObject({ name: "Legacy again", slug: "Legacy Org" });
    expect((await update({ slug: "Another Legacy" })).status).toBe(400);
    expect((await update({ slug: "legacy-org" })).status).toBe(200);
    expect(await f.organization(legacyId)).toMatchObject({ slug: "legacy-org" });
  });

  it("applies to server API organization creation without a session", async () => {
    const f = await fixture();
    await expect(f.auth.api.createOrganization({ body: { userId: f.users.member.id, name: "Bad", slug: "Bad Slug" } })).rejects.toMatchObject({ statusCode: 400 });
    expect(await f.auth.api.createOrganization({ body: { userId: f.users.member.id, name: "Good", slug: "good" } })).toMatchObject({ slug: "good" });
  });

  it("compares a new invalid slug against the stored one", async () => {
    const current = vi.fn(() => Promise.resolve(undefined));
    const hooks = organizationFieldHooks(current);
    await expect(hooks.beforeUpdateOrganization({ organization: { slug: "Bad" }, member: { organizationId: "missing" } })).rejects.toMatchObject({ statusCode: 400 });
    expect(current).toHaveBeenCalledWith("missing");
    await hooks.beforeUpdateOrganization({ organization: {}, member: { organizationId: "org" } });
    expect(current).toHaveBeenCalledTimes(1);
  });
});

describe("organization name", () => {
  const message = "Organization name must be 1–80 characters";
  const invalid = ["", "   ", "x".repeat(81), `  ${"x".repeat(81)}  `, 7, null];

  it.each(transports)("is trimmed and limited to the form's 80 characters when created and renamed (%s)", async (transport) => {
    const f = await fixture();
    const before = (await f.t.query(components.betterAuth.adapter.findMany, { model: "organization", paginationOpts: { numItems: 100, cursor: null } }) as { page: unknown[] }).page.length;
    for (const name of invalid) {
      const response = await f.call(transport, "owner", "/api/auth/organization/create", { name, slug: "bad-name" });
      expect(response.status, JSON.stringify(name)).toBe(400);
      // Better Auth rejects a missing or non-text name in its own schema before the hook.
      if (typeof name === "string" && name) expect(await response.json(), name).toMatchObject({ code: "INVALID_ORGANIZATION_NAME", message });
    }
    const count = async () => (await f.t.query(components.betterAuth.adapter.findMany, { model: "organization", paginationOpts: { numItems: 100, cursor: null } }) as { page: unknown[] }).page.length;
    expect(await count()).toBe(before);
    const created = await f.call(transport, "owner", "/api/auth/organization/create", { name: `  ${"n".repeat(80)}  `, slug: "long-name" });
    expect(created.status).toBe(200);
    expect(await f.organization((await created.json() as { id: string }).id)).toMatchObject({ name: "n".repeat(80) });

    for (const name of invalid.filter(value => typeof value === "string" && value)) {
      const response = await f.call(transport, "owner", "/api/auth/organization/update", { organizationId: f.organizationId, data: { name } });
      expect(response.status, String(name)).toBe(400);
      expect(await response.json(), String(name)).toMatchObject({ code: "INVALID_ORGANIZATION_NAME", message });
    }
    expect(await f.organization(f.organizationId)).toMatchObject({ name: "Acme" });
    expect((await f.call(transport, "admin", "/api/auth/organization/update", { organizationId: f.organizationId, data: { name: "  Acme Docs  " } })).status).toBe(200);
    expect(await f.organization(f.organizationId)).toMatchObject({ name: "Acme Docs", slug: "acme" });
    // Role checks still come first, with their own errors.
    expect((await f.call(transport, "member", "/api/auth/organization/update", { organizationId: f.organizationId, data: { name: "x".repeat(81) } })).status).toBe(403);
  });

  it("refuses a name that is not text when the hooks are called directly", async () => {
    const hooks = organizationFieldHooks(() => Promise.resolve({ name: "Stored" }));
    expect(() => hooks.beforeCreateOrganization({ organization: { name: 7, slug: "ok" } })).toThrowError(expect.objectContaining({ statusCode: 400 }));
    await expect(hooks.beforeUpdateOrganization({ organization: { name: 7 }, member: { organizationId: "org" } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(hooks.beforeUpdateOrganization({ organization: { name: "Stored" }, member: { organizationId: "org" } })).resolves.toEqual({ data: { name: "Stored" } });
  });

  it("keeps organizations with a legacy name working and validates only a new name", async () => {
    const f = await fixture();
    const longName = "L".repeat(120);
    const legacy = await f.context.adapter.create<{ id: string }>({ model: "organization", data: { name: longName, slug: "legacy-name", createdAt: new Date() } });
    const legacyId = String(legacy.id);
    await f.context.adapter.create({ model: "member", data: { organizationId: legacyId, userId: f.users.owner.id, role: "owner", createdAt: new Date() } });
    const update = (data: object) => f.call("convex", "owner", "/api/auth/organization/update", { organizationId: legacyId, data });
    // The settings form always resubmits the stored name alongside the slug.
    expect((await update({ name: longName, slug: "legacy-name-2" })).status).toBe(200);
    expect((await update({ name: `${longName}!` })).status).toBe(400);
    expect((await update({ name: "Short" })).status).toBe(200);
    expect(await f.organization(legacyId)).toMatchObject({ name: "Short", slug: "legacy-name-2" });
  });
});
