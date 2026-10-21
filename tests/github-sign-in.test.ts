import { convexTest } from "convex-test";
import { betterAuth } from "better-auth/minimal";
import { hashPassword } from "better-auth/crypto";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components } from "../convex/_generated/api";
import { createAuthOptions } from "../convex/auth";
import { proxyAuthRequest } from "@/auth-proxy";
import { sessionCache, sessionMiddleware } from "@/middleware/session";
import { logger } from "@/logger";
import authPageRoutes from "@/routes/auth-pages";
import { httpTokenRefresher } from "../src/repo-access/tokens";
import { GITHUB_HAND_OFF_HEADER } from "../shared/github-hand-off";
import { FakeGitHub, type FakeEmail, type FakeUser } from "./helpers/fake-github";
import rateLimiterTest from "./convex-rate-limiter";

const origin = "https://rendro.test";
const password = "GitHub sign-in password!!";
const verified = (email: string): FakeEmail[] => [{ email, primary: true, verified: true }];

afterEach(() => { sessionCache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

type Call = { path: string; body: Record<string, unknown> };

/** A browser's cookie jar: Set-Cookie in, Cookie out. */
class Jar {
  private readonly cookies = new Map<string, string>();
  store(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";", 1);
      const [name, ...value] = pair.split("=");
      if (/max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value.join("="));
    }
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function world(options: { github?: boolean; email?: "on" | "off"; repoAccess?: boolean } = {}) {
  vi.stubEnv("SITE_URL", origin);
  const github = new FakeGitHub();
  if (options.github !== false) {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", github.clientId);
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", github.clientSecret);
  }
  if (options.email) vi.stubEnv("AUTH_EMAIL_SIGN_IN", options.email);
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  rateLimiterTest.register(backend);
  const ctx = { runQuery: backend.query, runMutation: backend.mutation } as never;
  const context = await betterAuth(createAuthOptions(ctx)).$context;
  // Convex builds one Better Auth instance per HTTP request (convex/http.ts); so does this harness.
  const convexSite = (request: Request) => betterAuth(createAuthOptions(ctx)).handler(request);
  // Only the network is substituted: GitHub is the fake, Convex's HTTP actions run in-process.
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "github.com" || url.hostname === "api.github.com") return github.publicFetch(input, init);
    return convexSite(new Request(`${origin}${url.pathname}${url.search}`, init));
  }));
  // The control Worker's account endpoints, behind the serving Worker's REPO_ACCESS binding.
  const calls: Call[] = [];
  const accounts = { status: 204 };
  const repoAccess = { fetch: async (request: Request) => {
    calls.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
    return new Response(null, { status: accounts.status });
  } };
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", sessionMiddleware);
  app.all("/api/auth/*", c => proxyAuthRequest(c.req.raw, options.repoAccess === false ? null : repoAccess));
  app.route("/", authPageRoutes);
  app.get("/whoami", c => c.get("user") ? c.json({ id: c.get("user")!.id, email: c.get("user")!.email }) : c.body(null, 401));
  async function request(jar: Jar, path: string, init: RequestInit = {}) {
    const response = await app.request(`${origin}${path}`, { ...init, headers: { cookie: jar.header(), origin, ...init.headers } });
    jar.store(response);
    return response;
  }
  const post = (jar: Jar, path: string, body: unknown) => request(jar, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** The sign-in page's button: Better Auth answers with GitHub's authorize URL. */
  async function start(jar: Jar, path = "/api/auth/sign-in/social", callbackURL = `${origin}/home`) {
    const response = await post(jar, path, { provider: "github", callbackURL });
    expect(response.status).toBe(200);
    return new URL((await response.json() as { url: string }).url);
  }
  /** GitHub's decision, then the browser's request to the callback it redirects to. */
  function finish(jar: Jar, authorize: URL, user: FakeUser, decision: "approve" | "deny" = "approve") {
    const callback = new URL(github.authorize(authorize.searchParams, user, decision));
    return request(jar, `${callback.pathname}${callback.search}`);
  }
  async function signIn(user: FakeUser, jar = new Jar()) {
    return { jar, response: await finish(jar, await start(jar), user) };
  }
  async function whoami(jar: Jar) {
    const response = await request(jar, "/whoami");
    return response.status === 200 ? await response.json() as { id: string; email: string } : null;
  }
  async function emailUser(email: string, emailVerified = true) {
    const user = await context.internalAdapter.createUser({ name: "Reader", email, emailVerified });
    await context.internalAdapter.createAccount({ userId: user.id, accountId: user.id, providerId: "credential", password: await hashPassword(password) });
    return user;
  }
  async function signInWithPassword(email: string) {
    const jar = new Jar();
    expect((await post(jar, "/api/auth/sign-in/email", { email, password })).status).toBe(200);
    return jar;
  }
  const githubAccounts = () => backend.query(components.betterAuth.adapter.findMany, { model: "account", where: [{ field: "providerId", value: "github" }], paginationOpts: { cursor: null, numItems: 100 } })
    .then((result: { page: Array<Record<string, unknown>> }) => result.page);
  /** Every Better Auth row Convex holds, as text. */
  async function everything() {
    const rows = [];
    for (const model of ["user", "session", "account", "verification"] as const) {
      rows.push(...(await backend.query(components.betterAuth.adapter.findMany, { model, paginationOpts: { cursor: null, numItems: 100 } }) as { page: unknown[] }).page);
    }
    return JSON.stringify(rows);
  }
  return { github, context, calls, accounts, request, post, start, finish, signIn, whoami, emailUser, signInWithPassword, githubAccounts, everything };
}

describe("GitHub sign-in (#338)", () => {
  it("asks GitHub for a code with a state and an S256 PKCE challenge, and signs a new reader in", async () => {
    const w = await world();
    const person = w.github.user("octo-reader", 7001, verified("octo@example.test"));
    const jar = new Jar();
    const authorize = await w.start(jar);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(w.github.clientId);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/github`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(authorize.searchParams.get("state")).toBeTruthy();
    const response = await w.finish(jar, authorize, person);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${origin}/home`);
    expect(response.headers.has(GITHUB_HAND_OFF_HEADER)).toBe(false);
    const reader = await w.whoami(jar);
    expect(reader?.email).toBe("octo@example.test");
    const [account] = await w.githubAccounts();
    expect(account).toMatchObject({ userId: reader!.id, accountId: "7001" });
  });

  it("hands the GitHub identity and refreshable tokens to the control Worker, and never stores a token in Convex", async () => {
    const w = await world();
    const person = w.github.user("octo-reader", 7001, verified("octo@example.test"));
    const { jar } = await w.signIn(person);
    const reader = await w.whoami(jar);
    expect(w.calls).toHaveLength(1);
    const [{ path, body }] = w.calls;
    expect(path).toBe("/v1/accounts/link");
    expect(body).toMatchObject({ userId: reader!.id, githubId: 7001, login: "octo-reader" });
    const tokens = body.tokens as { accessToken: string; refreshToken: string; accessTokenExpiresAt: number; refreshTokenExpiresAt: number };
    expect(tokens.accessToken).toMatch(/^ghu_/);
    expect(tokens.refreshToken).toMatch(/^ghr_/);
    expect(tokens.accessTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(tokens.refreshTokenExpiresAt).toBeGreaterThan(tokens.accessTokenExpiresAt);
    // The token is the reader's own, and its refresh token is what the control Worker renews it with.
    expect((await w.github.publicFetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tokens.accessToken}` } })).status).toBe(200);
    const refresher = httpTokenRefresher({ clientId: w.github.clientId, clientSecret: w.github.clientSecret, webOrigin: w.github.webOrigin, fetch: w.github.fetch, now: () => Date.now() });
    expect(await refresher.refresh(tokens.refreshToken)).toMatchObject({ kind: "refreshed" });
    const stored = await w.everything();
    expect(stored).not.toContain(tokens.accessToken);
    expect(stored).not.toContain(tokens.refreshToken);
    const [account] = await w.githubAccounts();
    expect(account.accessToken ?? null).toBeNull();
    expect(account.refreshToken ?? null).toBeNull();
  });

  it("hands the fresh tokens over again on every sign-in, still storing none", async () => {
    const w = await world();
    const person = w.github.user("octo-reader", 7001, verified("octo@example.test"));
    await w.signIn(person);
    await w.signIn(person);
    expect(w.calls).toHaveLength(2);
    const [first, second] = w.calls.map(call => (call.body.tokens as { accessToken: string }).accessToken);
    expect(first).not.toBe(second);
    expect(w.calls[0].body.userId).toBe(w.calls[1].body.userId);
    const stored = await w.everything();
    expect(stored).not.toContain(first);
    expect(stored).not.toContain(second);
  });

  it("returns a denial to the sign-in page with fixed copy, signed out and with nothing handed over", async () => {
    const w = await world();
    const person = w.github.user("octo-reader", 7001, verified("octo@example.test"));
    const jar = new Jar();
    const response = await w.finish(jar, await w.start(jar), person, "deny");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in?error=access_denied");
    expect(await w.whoami(jar)).toBeNull();
    expect(w.calls).toEqual([]);
    const page = await (await w.request(jar, "/sign-in?error=access_denied")).text();
    expect(page).toContain("Sign-in was canceled. Try again or sign in with your email and password.");
    expect(page).not.toContain("The user has denied");
  });

  it("refuses a callback whose state does not belong to this browser", async () => {
    const w = await world();
    const person = w.github.user("octo-reader", 7001, verified("octo@example.test"));
    const victim = new Jar();
    const authorize = await w.start(new Jar());
    const response = await w.finish(victim, authorize, person);
    expect(response.headers.get("location")).toBe("/sign-in?error=state_mismatch");
    expect(await w.whoami(victim)).toBeNull();
    expect(w.calls).toEqual([]);
  });

  it("refuses a tampered state and a replayed callback", async () => {
    const w = await world();
    const person = w.github.user("octo-reader", 7001, verified("octo@example.test"));
    const jar = new Jar();
    const authorize = await w.start(jar);
    const callback = new URL(w.github.authorize(authorize.searchParams, person));
    callback.searchParams.set("state", "forged-state");
    expect((await w.request(jar, `${callback.pathname}${callback.search}`)).headers.get("location")).toMatch(/^\/sign-in\?error=state_/);
    const fresh = new Jar();
    const again = await w.start(fresh);
    const real = new URL(w.github.authorize(again.searchParams, person));
    expect((await w.request(fresh, `${real.pathname}${real.search}`)).headers.get("location")).toBe(`${origin}/home`);
    expect((await w.request(fresh, `${real.pathname}${real.search}`)).headers.get("location")).toMatch(/^\/sign-in\?error=/);
    expect(w.calls).toHaveLength(1);
  });

  it("refuses a GitHub account without a verified address, and ignores unverified ones", async () => {
    const w = await world();
    const person = w.github.user("octo-unverified", 7002, [{ email: "claimed@example.test", primary: true, verified: false }]);
    const { jar, response } = await w.signIn(person);
    expect(response.headers.get("location")).toBe("/sign-in?error=email_not_found");
    expect(await w.whoami(jar)).toBeNull();
    expect(await (await w.request(jar, "/sign-in?error=email_not_found")).text()).toContain("Your GitHub account has no verified email address.");
    // A secondary verified address is used when the primary one is unverified.
    w.github.emails.set(person.id, [{ email: "claimed@example.test", primary: true, verified: false }, { email: "real@example.test", primary: false, verified: true }]);
    const second = await w.signIn(person);
    expect((await w.whoami(second.jar))?.email).toBe("real@example.test");
  });

  it("links GitHub to an account whose address was verified here", async () => {
    const w = await world();
    const existing = await w.emailUser("shared@example.test");
    const person = w.github.user("octo-linked", 7003, verified("shared@example.test"));
    const { jar, response } = await w.signIn(person);
    expect(response.headers.get("location")).toBe(`${origin}/home`);
    expect((await w.whoami(jar))?.id).toBe(existing.id);
    expect(w.calls[0].body).toMatchObject({ userId: existing.id, githubId: 7003 });
    expect(await w.everything()).not.toContain((w.calls[0].body.tokens as { accessToken: string }).accessToken);
  });

  it("does not link GitHub to an account whose address was never verified here", async () => {
    const w = await world();
    await w.emailUser("unproven@example.test", false);
    const person = w.github.user("octo-claimant", 7004, verified("unproven@example.test"));
    const { jar, response } = await w.signIn(person);
    expect(response.headers.get("location")).toBe("/sign-in?error=account_not_linked");
    expect(await w.whoami(jar)).toBeNull();
    expect(await w.githubAccounts()).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it("links GitHub from a signed-in account with the same address, and refuses one with another address", async () => {
    const w = await world();
    await w.emailUser("member@example.test");
    const jar = await w.signInWithPassword("member@example.test");
    const other = w.github.user("octo-other", 7005, verified("someone-else@example.test"));
    const refused = await w.finish(jar, await w.start(jar, "/api/auth/link-social", `${origin}/account/security`), other);
    expect(refused.headers.get("location")).toBe("/sign-in?error=email_doesn't_match");
    expect(await w.githubAccounts()).toEqual([]);
    expect(w.calls).toEqual([]);
    const same = w.github.user("octo-member", 7006, verified("member@example.test"));
    const linked = await w.finish(jar, await w.start(jar, "/api/auth/link-social", `${origin}/account/security`), same);
    expect(linked.headers.get("location")).toBe(`${origin}/account/security`);
    const reader = await w.whoami(jar);
    expect(w.calls).toEqual([{ path: "/v1/accounts/link", body: expect.objectContaining({ userId: reader!.id, githubId: 7006, login: "octo-member" }) }]);
  });

  it("refuses to link a GitHub account that already belongs to another reader", async () => {
    const w = await world();
    const person = w.github.user("octo-first", 7007, verified("first@example.test"));
    await w.signIn(person);
    // The GitHub account's address changes; a reader with the new address tries to link it.
    w.github.emails.set(person.id, verified("second@example.test"));
    await w.emailUser("second@example.test");
    const jar = await w.signInWithPassword("second@example.test");
    const response = await w.finish(jar, await w.start(jar, "/api/auth/link-social", `${origin}/account/security`), person);
    expect(response.headers.get("location")).toBe("/sign-in?error=account_already_linked_to_different_user");
    expect(w.calls).toHaveLength(1);
  });

  it("keeps the reader signed in, without GitHub access, when the control Worker cannot take the hand-off", async () => {
    const w = await world();
    const errors = vi.spyOn(logger, "error");
    w.accounts.status = 503;
    const person = w.github.user("octo-reader", 7001, verified("octo@example.test"));
    const { jar, response } = await w.signIn(person);
    expect(response.headers.get("location")).toBe(`${origin}/home`);
    expect(await w.whoami(jar)).not.toBeNull();
    expect(errors).toHaveBeenCalledWith({ category: "GitHubHandOff", outcome: "unavailable" }, "GitHub account was not linked");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("ghu_");
    // The next sign-in links again.
    w.accounts.status = 204;
    await w.signIn(person);
    expect(w.calls.at(-1)?.path).toBe("/v1/accounts/link");
  });

  it("strips the hand-off and forwards nothing without the control Worker's binding", async () => {
    const w = await world({ repoAccess: false });
    const person = w.github.user("octo-reader", 7001, verified("octo@example.test"));
    const { jar, response } = await w.signIn(person);
    expect(response.headers.has(GITHUB_HAND_OFF_HEADER)).toBe(false);
    expect(await w.whoami(jar)).not.toBeNull();
    expect(w.calls).toEqual([]);
  });
});

describe("unlinking GitHub (#338)", () => {
  it("drops the tokens in the control Worker before Convex unlinks the account", async () => {
    const w = await world();
    const person = w.github.user("octo-member", 7006, verified("member@example.test"));
    await w.emailUser("member@example.test");
    const { jar } = await w.signIn(person);
    const reader = await w.whoami(jar);
    const response = await w.post(jar, "/api/auth/unlink-account", { providerId: "github" });
    expect(response.status).toBe(200);
    expect(w.calls.at(-1)).toEqual({ path: "/v1/accounts/unlink", body: { userId: reader!.id } });
    expect(await w.githubAccounts()).toEqual([]);
  });

  it("never unlinks the last sign-in method", async () => {
    const w = await world();
    const person = w.github.user("octo-only", 7008, verified("only@example.test"));
    const { jar } = await w.signIn(person);
    const response = await w.post(jar, "/api/auth/unlink-account", { providerId: "github" });
    expect(response.status).toBe(400);
    expect(await w.githubAccounts()).toHaveLength(1);
    expect(await w.whoami(jar)).not.toBeNull();
  });

  it("unlinks nothing when the control Worker cannot drop the tokens", async () => {
    const w = await world();
    const person = w.github.user("octo-member", 7006, verified("member@example.test"));
    await w.emailUser("member@example.test");
    const { jar } = await w.signIn(person);
    w.accounts.status = 503;
    const response = await w.post(jar, "/api/auth/unlink-account", { providerId: "github" });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await w.githubAccounts()).toHaveLength(1);
  });

  it("leaves other unlinks, malformed bodies and anonymous callers to Convex", async () => {
    const w = await world();
    const jar = new Jar();
    expect((await w.post(jar, "/api/auth/unlink-account", { providerId: "github" })).status).toBe(401);
    expect((await w.request(jar, "/api/auth/unlink-account", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBeGreaterThanOrEqual(400);
    await w.emailUser("member@example.test");
    const signedIn = await w.signInWithPassword("member@example.test");
    expect((await w.post(signedIn, "/api/auth/unlink-account", { providerId: "credential" })).status).toBe(400);
    expect(w.calls).toEqual([]);
  });
});

describe("the email sign-in switch (#338)", () => {
  it("leaves email sign-in on by default, beside GitHub", async () => {
    const w = await world();
    await w.emailUser("member@example.test");
    await w.signInWithPassword("member@example.test");
    const page = await (await w.request(new Jar(), "/sign-in")).text();
    expect(page).toContain("Sign in with GitHub");
    expect(page).toContain('id="auth-form"');
    expect((await w.request(new Jar(), "/sign-up")).status).toBe(200);
  });

  it("makes sign-in GitHub-only when AUTH_EMAIL_SIGN_IN=off", async () => {
    const w = await world({ email: "off" });
    await w.emailUser("member@example.test");
    const jar = new Jar();
    expect((await w.post(jar, "/api/auth/sign-in/email", { email: "member@example.test", password })).status).toBe(404);
    expect((await w.post(jar, "/api/auth/sign-up/email", { name: "New", email: "new@example.test", password })).status).toBe(404);
    const page = await (await w.request(jar, "/sign-in?error=access_denied")).text();
    expect(page).toContain("Sign in with GitHub");
    expect(page).not.toContain('id="auth-form"');
    expect(page).toContain("Sign-in was canceled. Try again when you are ready.");
    expect((await w.request(jar, "/sign-up")).headers.get("location")).toBe("/sign-in");
    expect((await w.request(jar, "/sign-up?returnTo=%2Fhome")).headers.get("location")).toBe("/sign-in?returnTo=%2Fhome");
    // An existing email account still signs in, through GitHub, with its verified address.
    const person = w.github.user("octo-member", 7006, verified("member@example.test"));
    const { jar: github } = await w.signIn(person);
    expect((await w.whoami(github))?.email).toBe("member@example.test");
  });

  it("ignores AUTH_EMAIL_SIGN_IN=off while GitHub is not configured", async () => {
    const w = await world({ github: false, email: "off" });
    await w.emailUser("member@example.test");
    await w.signInWithPassword("member@example.test");
    const page = await (await w.request(new Jar(), "/sign-in")).text();
    expect(page).not.toContain("Sign in with GitHub");
    expect(page).toContain('id="auth-form"');
    expect((await w.post(new Jar(), "/api/auth/sign-in/social", { provider: "github", callbackURL: `${origin}/home` })).status).toBe(404);
  });
});
