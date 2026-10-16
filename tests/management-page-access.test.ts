import rateLimiterTest from "./convex-rate-limiter";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { sessionCache, sessionMiddleware } from "@/middleware/session";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { components, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { securityHeaders } from "@/middleware/security-headers";
import organizationPages from "@/routes/organization-pages";
import projectPages from "@/routes/project-pages";
import apiKeyPages from "@/routes/api-key-pages";
import publicationPages from "@/routes/publication-pages";
import sharePages from "@/routes/share-pages";

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

// Real Convex HTTP actions, membership/session helpers and table ID validation.
// Only transport is replaced; no authorization helper is mocked.
async function fixture(realSession = false) {
  sessionCache.clear();
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const now = Date.now(), token = "management-page-session";
  const records = await backend.run(async ctx => {
    const createOrg = (slug: string) => ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "organization", data: { name: slug, slug, createdAt: now } },
    });
    const organization = await createOrg("member-org");
    const foreign = await createOrg("non-member-org");
    const missing = await createOrg("deleted-org");
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "organization", where: [{ field: "_id", value: missing._id }] },
    });
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "user", data: { name: "Owner", email: "owner@example.test", emailVerified: true, createdAt: now, updatedAt: now },
    } });
    const member = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "member", data: { organizationId: organization._id, userId: user._id, role: "owner", createdAt: now },
    } });
    await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "session", data: { userId: user._id, token, createdAt: now, updatedAt: now, expiresAt: now + 600_000 },
    } });
    return { organizationId: organization._id as string, foreignId: foreign._id as string, missingId: missing._id as string, userId: user._id as string, memberId: member._id as string };
  });
  const createProject = (organizationId: string, slug: string) => backend.mutation(internal.projects.createInternal, { organizationId, name: slug, slug, actorId: records.userId });
  const project = (await createProject(records.organizationId, "docs"))!;
  const foreignProject = (await createProject(records.foreignId, "foreign"))!;
  const missingProject = (await createProject(records.organizationId, "deleted"))!;
  await backend.run(ctx => ctx.db.delete(missingProject._id));
  const signature = createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("base64");
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return backend.fetch(url.pathname + url.search, init);
  });
  vi.stubGlobal("fetch", fetch);
  const user: User = { id: records.userId, name: "Owner", email: "owner@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", securityHeaders);
  if (realSession) app.use("*", sessionMiddleware);
  else app.use("*", async (c, next) => {
    if (c.req.header("Cookie")) c.set("user", user);
    await next();
  });
  app.route("/", organizationPages).route("/", projectPages).route("/", apiKeyPages).route("/", publicationPages).route("/", sharePages);
  const role = (value: string) => backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, {
    input: { model: "member", where: [{ field: "_id", value: records.memberId }], update: { role: value } },
  }));
  return { ...records, user, app, backend, fetch, cookie, role, projectId: project._id, foreignProjectId: foreignProject._id, missingProjectId: missingProject._id };
}

type Page = { name: string; suffix: string; content: string; project?: boolean };
const pages: Page[] = [
  { name: "overview", suffix: "", content: 'id="organization-content"' },
  { name: "projects", suffix: "/projects", content: 'id="project-content"' },
  { name: "people", suffix: "/people", content: "Loading people and invitations" },
  { name: "teams", suffix: "/teams", content: "Loading teams" },
  { name: "settings", suffix: "/settings", content: "Loading organization settings" },
  { name: "keys", suffix: "/api-keys", content: 'id="key-list"' },
  { name: "onboarding", suffix: "/onboarding", content: "Loading project setup" },
  { name: "onboarding project", suffix: "/onboarding?projectId=PROJECT", content: "Loading deployment setup", project: true },
  { name: "project detail", suffix: "/projects/PROJECT", content: "Loading project overview", project: true },
  { name: "deployments", suffix: "/projects/PROJECT/deployments", content: "Loading deployment history", project: true },
  { name: "publications", suffix: "/projects/PROJECT/publications", content: 'id="publication-list"', project: true },
  { name: "shares", suffix: "/projects/PROJECT/shares", content: 'id="share-list"', project: true },
];
function path(page: Page, org: string, project = "unused") {
  return `/organizations/${encodeURIComponent(org)}${page.suffix.replace("PROJECT", encodeURIComponent(project))}`;
}
async function notFound(response: Response, requestedPath: string) {
  const html = await response.text();
  expect(response.status).toBe(404);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(html).toContain('Error 404');
  expect(html).toContain('<h1 id="not-found-title">Page not found</h1>');
  expect(html).toContain('<main class="page" aria-labelledby="not-found-title">');
  expect(html).toContain('aria-labelledby="requested-path-label"');
  expect(html).toContain('href="/favicon.ico"');
  expect(html).toContain('href="/favicon.svg"');
  expect(html).toContain('href="/organizations?choose=1" target="_top">Manage organizations</a>');
  expect(html).not.toMatch(/Unable to load|__RENDRO_PAGE_STATE__|ConvexError|membership required|Invalid ID/);
  const nonce = response.headers.get("Content-Security-Policy")?.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  for (const [tag] of html.matchAll(/<(?:script|style)\b[^>]*>/g)) expect(tag).toContain(`nonce="${nonce}"`);
  expect(response.headers.get("Content-Security-Policy")).not.toMatch(/(?:script|style)-src [^;]*'unsafe-inline'/);
  // Apart from the caller's own URL and fresh nonce, every unavailable page is identical.
  return html.replaceAll(`nonce="${nonce}"`, 'nonce="NORMALIZED"').replaceAll(requestedPath.split("?")[0], "/REQUESTED");
}

const windows: Window[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const win of windows.splice(0)) await win.happyDOM.close(); });

describe.each(pages)("$name management page authorization", page => {
  it("resolves members once and makes all inaccessible IDs indistinguishable", async () => {
    const f = await fixture();
    const headers = { Cookie: `${f.cookie}; better-auth.session_data=malformed; __Secure-better-auth.session_data.0=malformed`, Authorization: "Bearer ignored-by-page-auth" };
    const validPath = path(page, f.organizationId, f.projectId);
    for (const role of ["owner", "admin", "member", "member, admin"]) {
      await f.role(role);
      f.fetch.mockClear();
      const response = await f.app.request(validPath, { headers });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(page.content);
      // Insufficient mutation roles retain the existing read-only/restricted UI.
      expect(f.fetch).toHaveBeenCalledTimes(1);
      const [target, init] = f.fetch.mock.calls[0];
      expect(typeof target === "string" ? target : target instanceof URL ? target.href : target.url).toContain(page.project ? "/projects/get?" : "/management/access?");
      expect(new Headers(init?.headers).get("Cookie")).toBe(f.cookie);
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.redirect).toBe("manual");
    }
    let expectedError: string | undefined;
    for (const org of ["not-a-valid-id", f.memberId, f.missingId, f.foreignId]) {
      f.fetch.mockClear();
      const requestedPath = path(page, org, f.projectId);
      const error = await notFound(await f.app.request(requestedPath, { headers }), requestedPath);
      expectedError ??= error;
      expect(error).toBe(expectedError);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
    if (page.project) {
      for (const project of ["not-a-valid-id", f.organizationId, f.missingProjectId, f.foreignProjectId]) {
        f.fetch.mockClear();
        const requestedPath = path(page, f.organizationId, project);
        expect(await notFound(await f.app.request(requestedPath, { headers }), requestedPath)).toBe(expectedError);
        expect(f.fetch).toHaveBeenCalledTimes(1);
      }
    }
    f.fetch.mockClear();
    const signedOut = await f.app.request(validPath);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("Location")).toBe(`/sign-in?returnTo=${encodeURIComponent(validPath.split("?")[0])}`);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

it("rechecks membership after removal instead of caching successful access", async () => {
  const f = await fixture(), url = path(pages[0], f.organizationId);
  expect((await f.app.request(url, { headers: { Cookie: f.cookie } })).status).toBe(200);
  await f.backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "member", where: [{ field: "_id", value: f.memberId }] },
  }));
  await notFound(await f.app.request(url, { headers: { Cookie: f.cookie } }), url);
});

it("rejects an explicitly empty onboarding project ID", async () => {
  const f = await fixture(), url = `/organizations/${f.organizationId}/onboarding?projectId=`;
  await notFound(await f.app.request(url, { headers: { Cookie: f.cookie } }), url);
});

it.each(["network", "redirect", "server", "invalid-json", "wrong-identity"])("fails closed without leaking %s errors", async failure => {
  const f = await fixture();
  f.fetch.mockImplementation(() => failure === "network" ? Promise.reject(new Error("private backend detail")) : Promise.resolve(
    failure === "redirect" ? new Response(null, { status: 302, headers: { Location: "https://example.test" } })
      : failure === "server" ? new Response("private backend detail", { status: 500 })
        : failure === "invalid-json" ? new Response("not json") : Response.json({ id: f.organizationId, userId: "someone-else" }),
  ));
  const response = await f.app.request(path(pages[0], f.organizationId), { headers: { Cookie: f.cookie } });
  await unavailable(response);
});

async function unavailable(response: Response, retryAfter = "1") {
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Retry-After")).toBe(retryAfter);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  const html = await response.text();
  expect(html).toContain("503 · Temporarily unavailable");
  expect(html).toContain('class="retry" href="">Try again</a>');
  expect(html).toContain('aria-labelledby="session-error-title"');
  expect(html).toContain('href="/favicon.ico"');
  expect(html).not.toContain("private backend detail");
  const nonce = response.headers.get("Content-Security-Policy")?.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  for (const [tag] of html.matchAll(/<(?:script|style)\b[^>]*>/g)) expect(tag).toContain(`nonce="${nonce}"`);
}

it("resolves invitations only for recipients and gives the same 404 for every unavailable ID", async () => {
  const f = await fixture(), now = Date.now();
  const invite = (email: string, status = "pending", expiresAt = now + 60_000) => f.backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.create, { input: {
    model: "invitation", data: { organizationId: f.organizationId, inviterId: f.userId, email, role: "member", status, expiresAt, createdAt: now },
  } }));
  const valid = await invite("OWNER@example.test");
  const other = await invite("other@example.test");
  const expired = await invite("owner@example.test", "pending", now - 1000);
  const accepted = await invite("owner@example.test", "accepted");
  const rejected = await invite("owner@example.test", "rejected");
  const canceled = await invite("owner@example.test", "canceled");
  const missing = await invite("owner@example.test");
  await f.backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model: "invitation", where: [{ field: "_id", value: missing._id }] } }));
  const headers = { Cookie: f.cookie };
  const validPath = `/accept-invitation/${valid._id}`;
  const response = await f.app.request(validPath, { headers });
  expect(response.status).toBe(200);
  const invitationHtml = await response.text();
  expect(invitationHtml).toContain('data-cp-initial-data type="application/json"');
  const browser = await startBrowser(invitationHtml, validPath, f);
  expect(browser.document.querySelector("#accept")).not.toBeNull();
  expect(f.fetch.mock.calls.filter(([input]) => requestUrl(input).includes("get-invitation"))).toHaveLength(1);
  let expected: string | undefined;
  for (const id of ["not-a-valid-id", f.organizationId, missing._id, other._id, expired._id, accepted._id, rejected._id, canceled._id]) {
    const url = `/accept-invitation/${id}`;
    const body = await notFound(await f.app.request(url, { headers }), url);
    expected ??= body;
    expect(body).toBe(expected);
  }
  // Recipients need no existing organization membership. Keep a different inviter.
  const inviter = await f.backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: "Inviter", email: "inviter@example.test", emailVerified: true, createdAt: now, updatedAt: now } } }));
  await f.backend.run(async ctx => {
    await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "member", data: { organizationId: f.organizationId, userId: inviter._id, role: "owner", createdAt: now } } });
    await ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "invitation", where: [{ field: "_id", value: valid._id }], update: { inviterId: inviter._id } } });
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model: "member", where: [{ field: "_id", value: f.memberId }] } });
  });
  expect((await f.app.request(validPath, { headers })).status).toBe(200);
  const signedOut = await f.app.request(validPath);
  expect(signedOut.status).toBe(302);
  expect(signedOut.headers.get("Location")).toBe(`/sign-in?returnTo=${encodeURIComponent(validPath)}`);
});

async function startBrowser(html: string, url: string, f: Awaited<ReturnType<typeof fixture>>) {
  const win = new Window({ url: `https://rendro.test${url}`, settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  windows.push(win);
  Object.assign(win, { AbortController, AbortSignal, structuredClone });
  win.document.write(html.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/g, (tag, attrs: string) => attrs.includes('type="application/json"') ? tag : ""));
  win.fetch = ((input: string, init?: RequestInit) => f.fetch(new URL(input, win.location.href), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Cookie: f.cookie } })) as unknown as typeof win.fetch;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (match[1].includes('type="application/json"')) continue;
    // Model a streamed document pausing before its controller. Hydration must
    // survive this delay, and unused data must be cleared after startup.
    if (match[1].includes("data-cp-page-script")) await new Promise(resolve => setTimeout(resolve, 10));
    const src = match[1].match(/src="([^"?]+)/)?.[1];
    if (src === "/management-query.js" || src === "/select.js") win.eval(readFileSync(`public${src}`, "utf8"));
    else if (!src) win.eval(match[2]);
  }
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
  return win;
}

it.each(pages)("reuses the SSR lookup during $name controller startup, then refreshes live", async page => {
  const f = await fixture(), url = path(page, f.organizationId, f.projectId);
  const response = await f.app.request(url, { headers: { Cookie: f.cookie } });
  const html = await response.text();
  const initial = JSON.parse(html.match(/data-cp-initial-data type="application\/json">([\s\S]*?)<\/script>/)![1]) as { path: string };
  const win = await startBrowser(html, url, f);
  const count = () => f.fetch.mock.calls.filter(([input]) => new URL(requestUrl(input)).pathname === new URL(initial.path, "https://rendro.test").pathname).length;
  expect([...win.document.querySelectorAll("h2")].map(node => node.textContent).join(" "), [...win.document.querySelectorAll(".empty p")].map(node => node.textContent).join(" ")).not.toMatch(/Unable to load|could not be confirmed/);
  expect(win.document.querySelector("script[data-cp-initial-data]")).toBeNull();
  // One load shares its freshly authorized SSR result, including dependent
  // invitations/credential choices. A subsequent read must refresh live.
  const initialCalls = 1;
  expect(count()).toBe(initialCalls);
  await win.eval(`window.RendroUI.request(${JSON.stringify(initial.path)})`);
  expect(count()).toBe(initialCalls + 1);
});

it.each([429, 500, 502, 503, 504])("preserves retryable recovery for upstream %s after a real successful session lookup", async status => {
  const f = await fixture(true), transport = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((input, init) => requestUrl(input).includes("/get-session") ? transport(input, init)
    : Promise.resolve(new Response("private backend detail", { status, headers: { "Retry-After": "7" } })));
  for (const url of [path(pages[0], f.organizationId), path(pages[8], f.organizationId, f.projectId), "/accept-invitation/unavailable"]) {
    await unavailable(await f.app.request(url, { headers: { Cookie: f.cookie } }), "7");
  }
  expect(f.fetch.mock.calls.some(([input]) => requestUrl(input).includes("/get-session"))).toBe(true);
});

it.each(["headers", "body"])("bounds a stalled lookup %s and aborts upstream work", async stall => {
  const f = await fixture();
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  f.fetch.mockImplementation((_input, init) => {
    signal = init?.signal ?? undefined;
    return stall === "headers" ? new Promise<Response>(() => {})
      : Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); } })));
  });
  const result = f.app.request(path(pages[0], f.organizationId), { headers: { Cookie: f.cookie } });
  await vi.advanceTimersByTimeAsync(5_001);
  await unavailable(await result);
  expect(signal?.aborted).toBe(true);
});

it("escapes authorized initial data without creating executable markup", async () => {
  const f = await fixture();
  const name = '</script><script>alert("secret")</script> & \u2028';
  await f.backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, { input: { model: "organization", where: [{ field: "_id", value: f.organizationId }], update: { name } } }));
  const response = await f.app.request(path(pages[4], f.organizationId), { headers: { Cookie: f.cookie } });
  const html = await response.text();
  expect(html).not.toContain(name);
  const payload = html.match(/<script([^>]*data-cp-initial-data[^>]*)>([\s\S]*?)<\/script>/)!;
  expect(payload[1]).toContain('type="application/json"');
  expect(payload[1]).toContain('nonce="');
  expect(JSON.parse(payload[2]).data.name).toBe(name);
});

it.each(["invalid", "0", "date"])("normalizes %s Retry-After without exposing upstream content", async kind => {
  const f = await fixture();
  const date = new Date(Math.ceil(Date.now() / 1000) * 1000 + 20_000);
  f.fetch.mockResolvedValue(new Response("private backend detail", { status: 503, headers: { "Retry-After": kind === "date" ? date.toUTCString() : kind } }));
  const response = await f.app.request(path(pages[0], f.organizationId), { headers: { Cookie: f.cookie } });
  const seconds = response.headers.get("Retry-After")!;
  if (kind === "date") expect(Number(seconds)).toBeGreaterThanOrEqual(19);
  else expect(seconds).toBe("1");
  await unavailable(response, seconds);
});

it("keeps a revoked backend session signed out without embedding initial data", async () => {
  const f = await fixture();
  f.fetch.mockResolvedValue(new Response(null, { status: 401 }));
  const url = path(pages[0], f.organizationId);
  const response = await f.app.request(url, { headers: { Cookie: f.cookie } });
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(`/sign-in?returnTo=${encodeURIComponent(url)}`);
  expect(await response.text()).not.toContain("data-cp-initial-data");
});

const invitationId = "invitation-under-test";
const future = () => new Date(Date.now() + 60_000).toISOString();
const staleInvitation = [
  ["a null body", () => null],
  ["another invitation id", () => ({ id: "someone-elses", email: "owner@example.test", status: "pending", expiresAt: future() })],
  ["another recipient", () => ({ id: invitationId, email: "other@example.test", status: "pending", expiresAt: future() })],
  ["a missing recipient", () => ({ id: invitationId, status: "pending", expiresAt: future() })],
  ["a non-string recipient", () => ({ id: invitationId, email: 7, status: "pending", expiresAt: future() })],
  ["a settled status", () => ({ id: invitationId, email: "owner@example.test", status: "accepted", expiresAt: future() })],
  ["a missing expiry", () => ({ id: invitationId, email: "owner@example.test", status: "pending" })],
  ["an expired invitation", () => ({ id: invitationId, email: "owner@example.test", status: "pending", expiresAt: new Date(Date.now() - 1000).toISOString() })],
  ["an unparseable expiry", () => ({ id: invitationId, email: "owner@example.test", status: "pending", expiresAt: "never" })],
] as const;

it.each(staleInvitation)("re-verifies the backend invitation and denies %s with the generic 404", async (_name, body) => {
  const f = await fixture(), url = `/accept-invitation/${invitationId}`;
  await sessionCache.lookup(f.cookie, () => Promise.resolve({ kind: "authenticated" as const, expiresAt: Date.now() + 60_000, user: { ...f.user, createdAt: 1, updatedAt: 1, image: null } }));
  f.fetch.mockImplementation(() => Promise.resolve(Response.json(body())));
  const invited = await notFound(await f.app.request(url, { headers: { Cookie: f.cookie } }), url);
  // A denial must not leave a cached session able to serve later cached pages.
  const resolve = vi.fn(() => Promise.resolve({ kind: "anonymous" as const }));
  await sessionCache.lookup(f.cookie, resolve);
  expect(resolve).toHaveBeenCalledOnce();
  // The page is indistinguishable from an unknown invitation, not a 503 or a leak.
  const unknown = await notFound(await f.app.request("/accept-invitation/unknown", { headers: { Cookie: f.cookie } }), "/accept-invitation/unknown");
  expect(invited).toBe(unknown);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it("forwards no credentials when an authenticated context has no cookie header, and the backend decides", async () => {
  const f = await fixture(), url = path(pages[0], f.organizationId);
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => { c.set("user", f.user); await next(); });
  app.route("/", organizationPages);
  f.fetch.mockResolvedValue(new Response(null, { status: 401 }));
  const response = await app.request(url);
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(`/sign-in?returnTo=${encodeURIComponent(url)}`);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const headers = new Headers(f.fetch.mock.calls[0][1]?.headers);
  expect(headers.has("Cookie")).toBe(false);
  expect(headers.get("Accept")).toBe("application/json");
});
