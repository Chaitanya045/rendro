import { convexTest } from "convex-test";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import { testUtils } from "better-auth/plugins";
import { afterEach, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components } from "../convex/_generated/api";
import { createAuthOptions } from "../convex/auth";
import { organizationReadPaths } from "../convex/sessionReadLimit";
import { authReadWindow } from "../shared/auth-read-window";
import { signAuthClientIp, verifiedAuthRequest } from "../shared/auth-client-ip";

const baseURL = "http://localhost:3000", ip = "192.0.2.71", secret = "organization-read-test-secret-at-least-32";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function fixture(legacy = false) {
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const configured = createAuthOptions({ runMutation: backend.mutation } as never);
  const database: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [], rateLimit: [], organization: [], member: [], invitation: [], team: [], teamMember: [], jwks: [] };
  const auth = betterAuth({ ...configured, baseURL, database: memoryAdapter(database),
    advanced: { ...configured.advanced, database: { generateId: "uuid" } },
    // Credential hashing isn't under test; keep real sign-in routing and limits fast.
    emailAndPassword: { ...configured.emailAndPassword, password: { hash: value => Promise.resolve(value), verify: ({ hash, password }) => Promise.resolve(hash === password) } },
    rateLimit: legacy ? { ...configured.rateLimit, customRules: { ...configured.rateLimit.customRules, "/organization/get-full-organization": { window: 60, max: 100 } } } : configured.rateLimit,
    plugins: [...configured.plugins, testUtils()],
  });
  const context = await auth.$context;
  context.adapter.options!.isRunMutationCtx = true;
  const user = context.test!.createUser({ emailVerified: true }); await context.test!.saveUser(user);
  const login = await context.test!.login({ userId: user.id });
  await context.internalAdapter.createAccount({ userId: user.id, accountId: user.id, providerId: "credential", password: "correct-password-long-enough" });
  const org = await auth.api.createOrganization({ body: { userId: user.id, name: "Readers", slug: "readers" } });
  async function request(path: string, headers: HeadersInit = login.headers, body?: unknown, clientIp = ip) {
    const req = new Request(baseURL + "/api/auth" + path, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (body) { req.headers.set("Content-Type", "application/json"); req.headers.set("Origin", baseURL); }
    (await signAuthClientIp(req, clientIp, secret)).forEach((v, k) => req.headers.set(k, v));
    return auth.handler(await verifiedAuthRequest(req, secret));
  }
  const full = `/organization/get-full-organization?organizationId=${org!.id}`;
  const buckets = () => backend.query(components.betterAuth.adapter.findMany, { model: "rateLimit", paginationOpts: { numItems: 100, cursor: null } }) as Promise<{ page: Array<{ key: string; count: number; lastRequest: number }> }>;
  async function seed(key: string, count: number) {
    await backend.mutation(components.betterAuth.adapter.updateOne, { input: { model: "rateLimit", where: [{ field: "key", value: key }], update: { count } } });
  }
  return { request, full, context, login, user, org: org!, database, backend, buckets, seed };
}

it("reproduces Better Auth's IP/endpoint inactivity limit across minute boundaries and fresh sessions", async () => {
  const f = await fixture(true); vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  f.database.rateLimit.push({ id: "legacy", key: `${ip}|/organization/get-full-organization`, count: 98, lastRequest: start });
  expect((await f.request(f.full)).status).toBe(200);
  vi.setSystemTime(start + 30_000); expect((await f.request(f.full)).status).toBe(200);
  vi.setSystemTime(start + 60_000);
  const fresh = await f.context.test!.login({ userId: f.user.id });
  const response = await f.request(f.full, fresh.headers);
  expect(response.status).toBe(429); expect(response.headers.get("X-Retry-After")).toBe("30");
  vi.setSystemTime(start + 90_001); expect((await f.request(f.full, fresh.headers)).status).toBe(200);
});

it("simulates two users at 68 navigations/minute each for ten minutes with no lookup 429s", () => {
  // 2x the requested 34/minute/user, using the production reducer. No sleeps or
  // thousands of sequential HTTP/crypto round trips. HTTP wiring is tested below.
  const rows = new Map<string, { count: number; lastRequest: number }>();
  let reads = 0;
  for (let navigation = 0; navigation < 680; navigation++) {
    const now = navigation * 60_000 / 68;
    for (const user of ["owner", "member"]) {
      // Conservatively model full + invitations + switcher on EVERY navigation,
      // including pages which actually use zero auth lookups and a cached list.
      for (const _path of organizationReadPaths) {
        for (const key of [`organization-read-ip:${ip}`, `organization-read:${user}`]) {
          const next = authReadWindow(key, rows.get(key) ?? null, now);
          expect(next.retryAfter).toBe(0); rows.set(key, next);
        }
        reads++;
      }
    }
  }
  expect(reads).toBe(4080);
  expect(authReadWindow(`organization-read:fresh-signin`, null, 600_000).retryAfter).toBe(0);
});

it("enforces authenticated user buckets across sessions/IPs and resets without inactivity", async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.now();
  expect((await f.request(f.full)).status).toBe(200);
  const find = vi.spyOn(f.context.internalAdapter, "findSession");
  const row = (await f.buckets()).page.find((row: { key: string }) => row.key.startsWith("organization-read:"))!;
  expect(row.key).toMatch(/^organization-read:[a-f0-9]{64}$/);
  expect(JSON.stringify(await f.buckets())).not.toContain(f.login.session.token);
  await f.seed(row.key, 599);
  expect((await f.request("/organization/list")).status).toBe(200);
  expect(find).toHaveBeenCalledTimes(1);
  const fresh = await f.context.test!.login({ userId: f.user.id });
  const limited = await f.request(f.full, fresh.headers, undefined, "192.0.2.72");
  expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("60");
  // Another user behind the same IP gets their own budget.
  const other = f.context.test!.createUser({ emailVerified: true }); await f.context.test!.saveUser(other);
  const otherLogin = await f.context.test!.login({ userId: other.id });
  expect((await f.request("/organization/list", otherLogin.headers)).status).toBe(200);
  vi.setSystemTime(start + 60_000);
  expect((await f.request(f.full)).status).toBe(200);
  expect(f.database.rateLimit).toEqual([]);
});

it("keeps the IP backstop and unverified bucket, and still checks revoked membership/session", async () => {
  const f = await fixture();
  expect((await f.request(f.full)).status).toBe(200);
  await f.seed(`organization-read-ip:${ip}`, 6000);
  expect((await f.request(f.full)).status).toBe(429);
  // The router rejects the trailing-slash spelling; it cannot bypass the limiter.
  expect((await f.request("/organization/list/")).status).toBe(404);
  await f.seed(`organization-read-ip:${ip}`, 0);
  expect((await f.request("/organization/list", { cookie: "better-auth.session_token=forged" })).status).toBe(401);
  await f.seed(`organization-read-unverified:${ip}`, 120);
  expect((await f.request("/organization/list", { "x-user-id": f.user.id, cookie: "better-auth.session_token=different-forged" })).status).toBe(429);
  await f.context.adapter.deleteMany({ model: "member", where: [{ field: "organizationId", value: f.org.id }] });
  expect((await f.request(f.full)).status).toBe(403);
  await f.context.internalAdapter.deleteSession(f.login.session.token);
  expect((await f.request(f.full, f.login.headers, undefined, "192.0.2.73")).status).toBe(401);
});

it("allows a fresh sign-in after org browsing while sign-in and invitation writes stay strict", async () => {
  const f = await fixture();
  await f.request(f.full);
  const rows = (await f.buckets()).page;
  const row = rows.find((row: { key: string }) => row.key.startsWith("organization-read:"))!;
  await f.seed(row.key, 500);
  const credentials = { email: f.user.email, password: "correct-password-long-enough" };
  const login = await f.request("/sign-in/email", {}, credentials); expect(login.status).toBe(200);
  for (let i = 1; i < 5; i++) expect((await f.request("/sign-in/email", {}, credentials)).status).toBe(200);
  expect((await f.request("/sign-in/email", {}, credentials)).status).toBe(429);
  expect((await f.request(f.full)).status).toBe(200);
  f.database.rateLimit.push({ id: "invite-limit", key: `${ip}|/organization/invite-member`, count: 10, lastRequest: Date.now() });
  expect((await f.request("/organization/invite-member", f.login.headers, { organizationId: f.org.id, email: "invite@example.test", role: "member" })).status).toBe(429);
  const rules = createAuthOptions({} as never).rateLimit.customRules;
  expect(rules).toMatchObject({ "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 3600, max: 5 }, "/request-password-reset": { window: 3600, max: 5 }, "/send-verification-email": { window: 3600, max: 5 }, "/organization/invite-member": { window: 60, max: 10 } });
});

it("runs ten continuous HTTP window transitions for two users at the simulated burst counts, then signs in", async () => {
  const f = await fixture();
  const other = f.context.test!.createUser({ emailVerified: true }); await f.context.test!.saveUser(other);
  const login = await f.context.test!.login({ userId: other.id });
  await f.context.adapter.create({ model: "member", data: { organizationId: f.org.id, userId: other.id, role: "member", createdAt: new Date() } });
  vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.now();
  for (let minute = 0; minute < 10; minute++) {
    vi.setSystemTime(start + minute * 60_000);
    for (const headers of [f.login.headers, login.headers]) expect((await f.request(f.full, headers)).status).toBe(200);
    const rows = (await f.buckets()).page;
    expect(rows.filter((row: { key: string }) => row.key.startsWith("organization-read:"))).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ count: row.key.includes("-ip:") ? 2 : 1, lastRequest: start + minute * 60_000 });
    // The reducer test exercises every one of these reads; seed their resulting
    // counts here to bound expensive HTTP work without skipping window rollover.
    for (const row of rows) await f.seed(row.key, row.key.includes("-ip:") ? 406 : 203);
    vi.setSystemTime(start + minute * 60_000 + 59_000);
    for (const headers of [f.login.headers, login.headers]) expect((await f.request("/organization/list", headers)).status).toBe(200);
  }
  const fresh = await f.request("/sign-in/email", {}, { email: f.user.email, password: "correct-password-long-enough" });
  expect(fresh.status).toBe(200);
  const headers = new Headers({ cookie: fresh.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") });
  expect((await f.request(f.full, headers)).status).toBe(200);
});
