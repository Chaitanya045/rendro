/* Async mocks model network completion and rejection without real I/O. */
/* eslint-disable @typescript-eslint/require-await */
import { Window, type HTMLButtonElement } from "happy-dom";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import projectPages from "@/routes/project-pages";
import { renderManagementNavigationRuntime } from "@/routes/management-navigation";
import { createManagementQueryCache } from "@/management-query/cache";
import { managementPagesSource } from "../scripts/management-pages-source";
import { organizationPageStyles } from "@/routes/management-loading";

const windows: Window[] = [];
const access = { id: "org-a", name: "Acme", slug: "acme", userId: "user-a", member: { userId: "user-a", role: "owner" } };
const project = { _id: "project-a", name: "Primary project content", slug: "docs", createdAt: 1 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }
function response(path: string): unknown {
  if (path.includes("management/access")) return access;
  if (path.includes("get-full-organization")) return { ...access, members: [access.member], teams: [] };
  if (path.includes("list-invitations")) return [];
  if (path.includes("projects/get")) return { project };
  if (path.includes("projects?")) return { projects: [project] };
  if (path.includes("deployments?")) return { deployments: [] };
  if (path.includes("publications?")) return { publications: [] };
  if (path.includes("shares?")) return { shares: [] };
  if (path.includes("credentials?")) return { credentials: [] };
  if (path.includes("recent-deployment")) return { deployment: null };
  throw new Error(`Unexpected request: ${path}`);
}
async function setup(respond: (path: string) => Promise<unknown> = async (path) => response(path)) {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => { c.set("user", { id: "user-a", name: "QA", email: "qa@example.test" } as User); await next(); });
  app.route("/", projectPages);
  const html = await (await app.request("/organizations/org-a/projects")).text();
  // Evaluate only repository-owned scripts; never load remote scripts or CSS.
  const win = new Window({ url: "https://rendro.test/organizations/org-a/projects", settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  windows.push(win);
  win.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
  const request = vi.fn(respond), fetch = vi.fn(() => Promise.reject(new Error("Unexpected HTML request")));
  Object.assign(win, { fetch, RendroQueryCore: { create: createManagementQueryCache }, RendroUI: { request, busy() {}, copyText() {}, toast() {}, openDialog(id: string) { win.document.getElementById(id)?.setAttribute("open", ""); }, applyTheme() {}, setNav() {}, syncActiveNav() {}, enhancePage() {} } });
  win.eval(renderManagementNavigationRuntime("org-a"));
  win.eval(await managementPagesSource());
  return { win, request, fetch, navigate: (suffix: string) => win.eval(`RendroUI.navigate(${JSON.stringify("/organizations/org-a" + suffix)})`) as Promise<boolean> };
}
afterEach(async () => { for (const win of windows.splice(0)) { win.dispatchEvent(new win.Event("pagehide")); await win.happyDOM.close(); } });

describe("management critical-path optimization", () => {
  it("shows team membership, removes a member, and preserves organization membership", async () => {
    let roster = [{ id: "team-member-a", userId: "user-other" }];
    const other = { id: "member-other", userId: "user-other", role: "member", user: { name: "Other member" } };
    const { win, navigate, request } = await setup(async (path) => {
      if (path.includes("get-full-organization")) return { ...access, members: [access.member, other], teams: [{ id: "team-a", name: "Documentation" }] };
      if (path.includes("management/team-members")) return { members: roster, nextCursor: null };
      if (path.includes("remove-team-member")) { roster = []; return {}; }
      return response(path);
    });
    Object.assign(win, { confirm: () => true });
    await navigate("/teams"); await flush();
    expect(request.mock.calls.some(([path]) => path.includes("management/team-members"))).toBe(false);
    const view = [...win.document.querySelectorAll("button")].find(button => button.textContent === "View members")!;
    view.click(); await flush();
    expect(win.document.querySelector(".team-roster")?.textContent).toContain("Other member");
    win.document.querySelector<HTMLButtonElement>('.team-roster button[aria-label^="Remove"]')!.click(); await flush();
    expect(win.document.querySelector(".team-roster")?.textContent).toContain("No members in this team");
    expect(request.mock.calls.some(([path]) => path.endsWith("/remove-member"))).toBe(false);
    expect(win.document.querySelector('select option[value="user-other"]')?.hasAttribute("disabled")).toBe(false);
  });
  it("removes organization members only after confirmation and a successful response", async () => {
    const other = { id: "member-other", userId: "user-other", role: "member", user: { name: "Other member" } };
    const { win, navigate, request } = await setup(async (path) => {
      if (path.includes("get-full-organization")) return { ...access, members: [access.member, other], teams: [] };
      if (path.endsWith("/remove-member")) return {};
      return response(path);
    });
    Object.assign(win, { confirm: () => false });
    await navigate("/people"); await flush();
    const remove = win.document.querySelector<HTMLButtonElement>(".remove-member")!;
    remove.click(); await flush();
    expect(request.mock.calls.some(([path]) => path.endsWith("/remove-member"))).toBe(false);
    expect(win.document.querySelectorAll("#member-list tr")).toHaveLength(2);
    Object.assign(win, { confirm: () => true }); remove.click(); await flush();
    expect(win.document.querySelectorAll("#member-list tr")).toHaveLength(1);
    expect(win.document.querySelector(".remove-member")).toBeNull();
  });
  it("closes the create-project dialog before navigating and suppresses duplicate submissions", async () => {
    const create = deferred<unknown>();
    const { win, navigate, request } = await setup(async (path) => path === "/api/rendro/projects" ? create.promise : response(path));
    await navigate("/projects"); await flush();
    const dialog = win.document.querySelector("#project-dialog")!;
    dialog.setAttribute("open", "");
    // The production busy helper sets aria-busy synchronously.
    win.eval('RendroUI.busy=function(button,on){button.disabled=on;button.setAttribute("aria-busy",String(on));}');
    const form = win.document.querySelector("#project-form")!;
    const submit = () => form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    submit(); submit(); await flush();
    expect(request.mock.calls.filter(([path]) => path === "/api/rendro/projects")).toHaveLength(1);
    create.resolve({ project: { _id: "project-a" } }); await flush();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(win.location.pathname).toBe("/organizations/org-a/projects/project-a");
    expect(win.document.querySelector("#project-id")?.textContent).toBe("project-a");
  });
  it("contains long project/commit labels without pushing overview badges outside mobile rows", () => {
    expect(organizationPageStyles).toContain(".overview-row>.cell-primary{min-width:0;flex:1}");
    expect(organizationPageStyles).toContain(".overview-row .cell-secondary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
    expect(organizationPageStyles).toContain(".overview-row>.badge{flex:none}");
  });
  it("mounts all nine routes without an HTML fetch and preserves the shell", async () => {
    const { win, navigate, fetch } = await setup();
    const header = win.document.querySelector(".cp-topbar");
    for (const path of ["", "/people", "/teams", "/settings", "/api-keys", "/projects", "/projects/project-a", "/projects/project-a/publications", "/projects/project-a/shares"]) {
      expect(await navigate(path), path).toBe(true); await flush();
      expect(win.document.querySelector(".cp-topbar"), path).toBe(header);
      expect(win.document.querySelector("main")?.textContent, path).not.toContain("Unable to load");
      expect(win.document.querySelector("main")?.innerHTML, path).not.toContain("__RD_");
      expect(win.document.querySelector(".loading-view,.skeleton-table-row"), path).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("renders project details before history and ignores history after navigation", async () => {
    const history = deferred<unknown>();
    const { win, navigate } = await setup(async (path) => path.includes("deployments?") ? history.promise : response(path));
    await navigate("/projects/project-a"); await flush();
    expect(win.document.querySelector("#project-id")?.textContent).toBe("project-a");
    expect(win.document.querySelector("#deployment-list .loading-view")).not.toBeNull();
    await navigate("/projects"); await flush();
    history.resolve({ deployments: [] }); await flush();
    expect(win.document.querySelector("#project-list")?.textContent).toContain(project.name);
    expect(win.document.querySelector("#deployment-list")).toBeNull();
  });
  it("keeps primary content when deployment history fails", async () => {
    const { win, navigate } = await setup(async (path) => { if (path.includes("deployments?")) throw new Error("History unavailable"); return response(path); });
    await navigate("/projects/project-a"); await flush();
    expect(win.document.querySelector("#project-id")?.textContent).toBe("project-a");
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("Try again");
  });
  it("does not fetch deployment choices until pinned publication mode is selected", async () => {
    const { win, navigate, request } = await setup();
    await navigate("/projects/project-a/publications"); await flush();
    expect(request.mock.calls.some(([path]) => path.includes("deployments?"))).toBe(false);
    const mode = win.document.querySelector('select[name="trackingMode"]')!;
    (mode as unknown as HTMLSelectElement).value = "pinned"; mode.dispatchEvent(new win.Event("change")); await flush();
    expect(request.mock.calls.filter(([path]) => path.includes("deployments?"))).toHaveLength(1);
    expect(win.document.getElementById("publication-error")?.textContent).toContain("Deploy this project");
  });
  it("does not release retained data after access is revoked", async () => {
    let revoked = false;
    const { win, navigate, request } = await setup(async (path) => { if (revoked && path.includes("management/access")) throw Object.assign(new Error("Access revoked"), { status: 403 }); return response(path); });
    await navigate("/projects"); await flush();
    expect(win.document.querySelector("#project-list")?.textContent).toContain(project.name);
    revoked = true; await navigate("/projects"); await flush();
    expect(win.document.querySelector("main")?.textContent).not.toContain(project.name);
    expect(win.document.querySelector("main")?.textContent).toContain("Access revoked");
    expect(request.mock.calls.filter(([path]) => path.includes("/projects?"))).toHaveLength(1);
  });
  it("starts access and data together but paints neither until access resolves", async () => {
    const gate = deferred<unknown>();
    const { win, navigate, request } = await setup(async (path) => path.includes("management/access") ? gate.promise : response(path));
    await navigate("/projects"); await flush();
    expect(request.mock.calls.some(([path]) => path.includes("/projects?"))).toBe(true);
    expect(win.document.querySelector("#project-list")).toBeNull();
    gate.resolve(access); await flush();
    expect(win.document.querySelector("#project-list")?.textContent).toContain(project.name);
  });
  it("renders People members before the invitation request finishes", async () => {
    const gate = deferred<unknown>();
    const { win, navigate } = await setup(async (path) => path.includes("list-invitations") ? gate.promise : response(path));
    await navigate("/people"); await flush();
    expect(win.document.querySelector("#member-list tr")).not.toBeNull();
    expect(win.document.querySelector("#invitation-list .loading-view")).not.toBeNull();
    gate.resolve([]); await flush();
    expect(win.document.querySelector("#invitation-list")?.textContent).toContain("No pending invitations");
  });
});
