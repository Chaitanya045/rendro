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

// Real Convex HTTP actions, membership/session helpers and table ID validation.
// Only transport is replaced; no authorization helper is mocked.
async function fixture() {
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
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
  app.use("*", async (c, next) => {
    if (c.req.header("Cookie")) c.set("user", user);
    await next();
  });
  app.route("/", organizationPages).route("/", projectPages).route("/", apiKeyPages).route("/", publicationPages).route("/", sharePages);
  const role = (value: string) => backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.updateOne, {
    input: { model: "member", where: [{ field: "_id", value: records.memberId }], update: { role: value } },
  }));
  return { ...records, app, backend, fetch, cookie, role, projectId: project._id, foreignProjectId: foreignProject._id, missingProjectId: missingProject._id };
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

afterEach(() => vi.unstubAllGlobals());

describe.each(pages)("$name management page authorization", page => {
  it("resolves members once and makes all inaccessible IDs indistinguishable", async () => {
    const f = await fixture();
    const headers = { Cookie: f.cookie, Authorization: "Bearer ignored-by-page-auth" };
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
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("Unable to verify workspace access. Please try again.");
});
