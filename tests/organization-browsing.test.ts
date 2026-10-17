import { Window } from "happy-dom";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { build } from "esbuild";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import organizations from "@/routes/organization-pages";
import projects from "@/routes/project-pages";
import keys from "@/routes/api-key-pages";
import shares from "@/routes/share-pages";
import { managementPagesSource } from "../scripts/management-pages-source";

const user = { id: "user-a", name: "Reader", email: "reader@example.test" } as User;
const organization = { id: "org-a", name: "Workspace", slug: "workspace", members: [{ id: "m-a", userId: user.id, role: "owner", user }], teams: [] };
const access = { id: organization.id, name: organization.name, slug: organization.slug, userId: user.id, member: organization.members[0] };
const project = { _id: "project-a", organizationId: organization.id, name: "Docs", slug: "docs", createdAt: 1 };
const routes = ["", "/projects", "/projects/project-a", "/people", "/api-keys", "/projects/project-a/shares", "/teams", "/projects/project-a/deployments"];
const windows: Window[] = [];
let bundle: string;
beforeAll(async () => { bundle = (await build({ entryPoints: ["src/management-query/browser.ts"], bundle: true, write: false, format: "iife", platform: "browser" })).outputFiles[0].text; });
afterEach(async () => { for (const win of windows.splice(0)) await win.happyDOM.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function data(path: string) {
  switch (new URL(path, "http://localhost:3000").pathname) {
    case "/api/rendro/management/access": return access;
    case "/api/auth/organization/get-full-organization": return organization;
    case "/api/auth/organization/list": return [organization];
    case "/api/auth/organization/list-invitations": return [];
    case "/api/rendro/projects": return { projects: [project] };
    case "/api/rendro/projects/get": return { project };
    case "/api/rendro/deployments": return { deployments: [] };
    case "/api/rendro/credentials": return { credentials: [] };
    case "/api/rendro/shares": return { shares: [] };
    case "/api/rendro/management/recent-deployment": return { deployment: null };
    default: throw new Error(`Unexpected request: ${path}`);
  }
}
async function flush() { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
async function fixture(route: string) {
  const serverCalls: string[] = [], calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => { serverCalls.push(new URL(url).pathname); return Promise.resolve(Response.json(data(url))); }));
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => { c.set("user", user); await next(); });
  for (const pages of [organizations, projects, keys, shares]) app.route("/", pages);
  const path = "/organizations/org-a" + route;
  const response = await app.request(path); expect(response.status).toBe(200);
  const win = new Window({ url: "http://localhost:3000" + path, settings: { enableJavaScriptEvaluation: false, suppressInsecureJavaScriptEnvironmentWarning: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } }); windows.push(win);
  const fetch = vi.fn((url: string) => { calls.push(new URL(url, win.location.href).pathname); return Promise.resolve(Response.json(data(url))); });
  win.fetch = fetch as unknown as typeof win.fetch;
  Object.assign(win, { structuredClone });
  win.document.write(await response.text());
  win.happyDOM.settings.enableJavaScriptEvaluation = true;
  for (const script of win.document.querySelectorAll("script")) {
    if (script.src.includes("management-query.js")) win.eval(bundle);
    else if (!script.src && script.type !== "application/json") win.eval(script.textContent);
  }
  win.eval(managementPagesSource());
  await flush();
  function ready() { expect(win.document.querySelector(".cp-content")!.textContent).not.toMatch(/Unable to load|Request failed/); expect(win.document.querySelector(".cp-content .loading-view,.cp-content .skeleton-table-row")).toBeNull(); }
  ready();
  return { win, calls, serverCalls, fetch, ready };
}
const expected = [[4, 4, 2], [1, 1, 0], [1, 1, 0], [2, 3, 2], [2, 2, 0], [2, 2, 0], [2, 3, 2], [2, 1, 0]];  // /teams: one extra session read for the active team
it.each(routes)("bounds initial and client navigation requests for %s", async route => {
  const f = await fixture(route);
  const initial = [...f.calls];
  f.calls.length = 0;
  await f.win.eval(`window.RendroUI.navigate(${JSON.stringify("/organizations/org-a" + route)})`);
  await flush(); f.ready();
  const [initialCount, navigationCount, authCount] = expected[routes.indexOf(route)];
  expect(initial).toHaveLength(initialCount); expect(f.calls).toHaveLength(navigationCount);
  for (const requests of [initial, f.calls]) expect(requests.filter(path => path.startsWith("/api/auth/"))).toHaveLength(authCount);
  expect(f.serverCalls).toHaveLength(1);
  // Every navigation freshly authorizes, even when all page data is cached.
  expect(f.calls.filter(path => path === "/api/rendro/management/access")).toHaveLength(1);
});

it("shares the switcher list across menu opens and client navigation", async () => {
  const f = await fixture("");
  const request = () => f.win.eval('window.RendroUI.request("/api/auth/organization/list")') as Promise<unknown>;
  await request(); await request();
  await f.win.eval('window.RendroUI.navigate("/organizations/org-a/people")'); await flush();
  await request();
  expect(f.calls.filter(path => path === "/api/auth/organization/list")).toHaveLength(1);
});
it.each([429, 503])("renders a styled retry state for org lookup %s and keeps navigation working", async status => {
  const f = await fixture("");
  const normal = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async url => url.includes("get-full-organization")
    ? Response.json({ message: "raw upstream detail" }, { status, headers: { "Retry-After": "60" } }) : normal(url));
  await f.win.eval('window.RendroUI.navigate("/organizations/org-a/people")'); await flush();
  const content = f.win.document.querySelector(".cp-content")!;
  expect(content.textContent).toContain("Organization information is temporarily unavailable");
  expect(content.textContent).not.toContain("raw upstream detail");
  const retry = content.querySelector(".empty button")!;
  expect(retry.textContent).toBe("Try again");
  f.fetch.mockImplementation(normal);
  (retry as unknown as { click(): void }).click(); await flush(); f.ready();
  await f.win.eval('window.RendroUI.navigate("/organizations/org-a/projects")'); await flush(); f.ready();
  expect(f.win.location.pathname).toBe("/organizations/org-a/projects");
});

it.each(routes)("bounds first client navigation with a cold data cache for %s", async route => {
  // People loads no cacheable project/deployment data, so the target starts cold.
  const f = await fixture("/people"); f.calls.length = 0;
  await f.win.eval(`window.RendroUI.navigate(${JSON.stringify("/organizations/org-a" + route)})`);
  await flush(); f.ready();
  expect(f.calls).toHaveLength([5, 2, 2, 3, 3, 3, 3, 3][routes.indexOf(route)]);
  expect(f.calls.filter(path => path === "/api/rendro/management/access")).toHaveLength(1);
});
