import "./fixtures/management-page-presentation";
/* Async mocks model network completion and rejection without real I/O. */
/* eslint-disable @typescript-eslint/require-await */
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLElement } from "happy-dom";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import projectPages from "@/routes/project-pages";
import { renderManagementNavigationRuntime } from "@/routes/management-navigation";
import { createManagementQueryCache } from "@/management-query/cache";
import { managementPagesSource } from "../scripts/management-pages-source";
import { organizationPageStyles } from "@/routes/management-loading";
import { organizationSwitcherRuntime } from "@/routes/organization-switcher";
import { managementUiRuntime } from "@/ui/management-ui";

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
  if (path.includes("credentials?")) return { credentials: [] };
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
  win.eval(managementUiRuntime);
  win.eval(renderManagementNavigationRuntime("org-a"));
  win.eval(managementPagesSource());
  return { win, request, fetch, html, navigate: (suffix: string) => win.eval(`RendroUI.navigate(${JSON.stringify("/organizations/org-a" + suffix)})`) as Promise<boolean> };
}
/** Answers the shared themed confirmation dialog that replaced native confirm(). */
async function answerConfirm(win: Window, accept: boolean) {
  const dialog = win.document.querySelector("#cp-confirm-dialog")!;
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(dialog.querySelector('[data-confirm-accept]')?.className).toContain("destructive");
  dialog.querySelector<HTMLButtonElement>(accept ? "[data-confirm-accept]" : "[data-confirm-cancel]")!.click();
  await flush();
  expect(dialog.hasAttribute("open")).toBe(false);
}
afterEach(async () => { for (const win of windows.splice(0)) { win.dispatchEvent(new win.Event("pagehide")); await win.happyDOM.close(); } });

describe("management critical-path optimization", () => {
  it("retains one route-specific skeleton until project access resolves", async () => {
    const gate = deferred<unknown>();
    const { win, navigate } = await setup(async path => path.includes("management/access") ? gate.promise : response(path));
    await navigate("/projects/project-a"); await flush();
    expect(win.document.querySelectorAll('#project-content [aria-label="Loading project overview"]')).toHaveLength(1);
    expect(win.document.querySelector("#project-id")).toBeNull();
    gate.resolve(access); await flush();
    expect(win.document.querySelector("#project-content .loading-view")).toBeNull();
    expect(win.document.querySelector("#project-id .cp-id")?.textContent).toBe("project-a");
  });
  it("lets members read a project without enabling owner-only project controls", async () => {
    const { win, navigate } = await setup(async path => path.includes("management/access")
      ? { ...access, member: { ...access.member, role: "member" } } : response(path));
    await navigate("/projects/project-a"); await flush();
    expect(win.document.querySelector("#project-id .cp-id")?.textContent).toBe("project-a");
    expect(win.document.querySelector<HTMLButtonElement>('#project-form button[type="submit"]')?.disabled).toBe(true);
  });
  it.each([
    { discard: false, nativeCancel: false },
    { discard: true, nativeCancel: false },
    { discard: true, nativeCancel: true },
  ])("integrates dirty Settings, navigation guards and organization switching: %j", async ({ discard, nativeCancel }) => {
    const { win, navigate, request } = await setup(async path => path === "/api/auth/organization/list"
      ? [{ id: "org-a", name: "Acme" }, { id: "org-b", name: "Beta" }] : response(path));
    await navigate("/settings"); await flush();
    win.eval(organizationSwitcherRuntime);
    const confirm = vi.fn(() => discard);
    Object.assign(win, { confirm });
    const input = win.document.querySelector<HTMLInputElement>('#settings-form [name="name"]')!;
    input.value = "Unsaved organization name";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    const unloads: boolean[] = [];
    if (nativeCancel) win.addEventListener("beforeunload", event => event.preventDefault());
    // Only native location departure is mocked. The Settings controller,
    // route guard, switcher, and event handlers are the application code.
    const assign = vi.spyOn(win.location, "assign").mockImplementation(() => {
      const event = new win.Event("beforeunload", { cancelable: true });
      win.dispatchEvent(event); unloads.push(event.defaultPrevented);
    });
    const trigger = win.document.querySelector<HTMLButtonElement>("#cp-org-switcher")!;
    trigger.click(); await flush();
    win.document.querySelector<HTMLElement>('[data-organization-id="org-b"]')!.click();
    await flush(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(confirm).toHaveBeenCalledExactlyOnceWith("Discard unsaved organization changes?");
    expect(assign).toHaveBeenCalledTimes(discard ? 1 : 0);
    expect(unloads).toEqual(discard ? [nativeCancel] : []);
    expect(input.value).toBe("Unsaved organization name");
    expect(request.mock.calls.some(([path]) => path === "/api/auth/organization/update")).toBe(false);
    if (discard && !nativeCancel) {
      expect(trigger.querySelector("[data-org-name]")?.textContent).toBe("Beta");
      win.dispatchEvent(new win.Event("pagehide")); win.dispatchEvent(new win.Event("pageshow"));
    }
    expect(trigger.querySelector("[data-org-name]")?.textContent).toBe("Acme");
    expect(trigger.hasAttribute("aria-disabled")).toBe(false);
    trigger.click(); await flush();
    expect(win.document.querySelector<HTMLElement>("#cp-org-menu")!.hidden).toBe(false);
    assign.mockRestore();
  });
  it("shows team membership, removes a member, and preserves organization membership", async () => {
    let roster = [{ id: "team-member-a", userId: "user-other" }];
    const other = { id: "member-other", userId: "user-other", role: "member", user: { name: "Other member" } };
    const { win, navigate, request } = await setup(async (path) => {
      if (path.includes("get-full-organization")) return { ...access, members: [access.member, other], teams: [{ id: "team-a", name: "Documentation" }] };
      if (path.includes("management/team-members")) return { members: roster, nextCursor: null };
      if (path.includes("remove-team-member")) { roster = []; return {}; }
      return response(path);
    });
    await navigate("/teams"); await flush();
    expect(request.mock.calls.some(([path]) => path.includes("management/team-members"))).toBe(false);
    const view = [...win.document.querySelectorAll("button")].find(button => button.textContent === "View members")!;
    view.click(); await flush();
    expect(win.document.querySelector(".team-roster")?.textContent).toContain("Other member");
    win.document.querySelector<HTMLButtonElement>('.team-roster button[aria-label^="Remove"]')!.click(); await flush();
    expect(request.mock.calls.some(([path]) => path.includes("remove-team-member"))).toBe(false);
    await answerConfirm(win, true);
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
    await navigate("/people"); await flush();
    const remove = win.document.querySelector<HTMLButtonElement>(".remove-member")!;
    remove.click(); await flush();
    expect(win.document.querySelector("#cp-confirm-title")?.textContent).toBe("Remove member?");
    await answerConfirm(win, false);
    expect(request.mock.calls.some(([path]) => path.endsWith("/remove-member"))).toBe(false);
    expect(win.document.querySelectorAll("#member-list tr")).toHaveLength(2);
    remove.click(); await flush();
    await answerConfirm(win, true);
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
    expect(win.document.querySelector("#project-id .cp-id")?.textContent).toBe("project-a");
  });
  it("contains long project/commit labels without pushing overview badges outside mobile rows", () => {
    expect(organizationPageStyles).toContain(".overview-row>.cell-primary{min-width:0;flex:1}");
    expect(organizationPageStyles).toContain(".overview-row .cell-secondary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
    expect(organizationPageStyles).toContain(".overview-row>.badge{flex:none}");
  });
  it("mounts all seven routes without an HTML fetch and preserves the shell", async () => {
    const { win, navigate, fetch } = await setup();
    const header = win.document.querySelector(".cp-topbar");
    for (const path of ["", "/people", "/teams", "/settings", "/api-keys", "/projects", "/projects/project-a"]) {
      expect(await navigate(path), path).toBe(true); await flush();
      expect(win.document.querySelector(".cp-topbar"), path).toBe(header);
      expect(win.document.querySelector("main")?.textContent, path).not.toContain("Unable to load");
      expect(win.document.querySelector("main")?.innerHTML, path).not.toContain("__RD_");
      expect(win.document.querySelector(".loading-view,.skeleton-table-row"), path).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
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
  it("guards unload only while Settings has unsaved edits, and a save or a revert clears the guard", async () => {
    const { win, navigate } = await setup(async path => path === "/api/auth/organization/update" ? { name: "Renamed", slug: "renamed" } : response(path));
    await navigate("/settings"); await flush();
    const unload = () => { const event = new win.Event("beforeunload", { cancelable: true }); win.dispatchEvent(event); return event.defaultPrevented; };
    const name = win.document.querySelector<HTMLInputElement>('#settings-form [name="name"]')!;
    const original = name.value;
    expect(unload()).toBe(false);
    name.value = "Unsaved name"; name.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(unload()).toBe(true);
    name.value = original; name.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(unload()).toBe(false);
    name.value = "Renamed"; name.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(unload()).toBe(true);
    win.document.querySelector("#settings-form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); await flush();
    expect(name.value).toBe("Renamed");
    expect(unload()).toBe(false);
  });
  it("shows project, member and team counts and the setup checklist on the overview", async () => {
    const { win, navigate } = await setup();
    await navigate(""); await flush();
    const metrics = [...win.document.querySelectorAll(".overview-metrics .metric")].map(card => [card.querySelector("strong")?.textContent, card.querySelector("span")?.textContent]);
    expect(metrics).toEqual([["1", "Projects"], ["1", "Members"], ["0", "Teams"]]);
    const checklist = [...win.document.querySelectorAll("#workspace-checklist .checklist-row")].map(row => [row.textContent, row.classList.contains("complete")]);
    expect(checklist).toEqual([["DoneOrganization created", true], ["DoneCreate a project", true], ["Invite a teammate (optional)", false]]);
  });
  it("shows only the first five projects on the overview and links to the full list", async () => {
    const projects = Array.from({ length: 7 }, (_, index) => ({ ...project, _id: `project-${index}`, name: `Project ${index}`, slug: `project-${index}` }));
    const { win, navigate } = await setup(async path => path.includes("projects?") ? { projects } : response(path));
    await navigate(""); await flush();
    const rows = [...win.document.querySelectorAll<HTMLElement>("#overview-projects .overview-row")];
    expect(rows.map(row => row.querySelector("strong")?.textContent)).toEqual(["Project 0", "Project 1", "Project 2", "Project 3", "Project 4"]);
    expect(rows.map(row => row.getAttribute("href"))).toEqual(projects.slice(0, 5).map(item => `/organizations/org-a/projects/${item._id}`));
    const all = [...win.document.querySelectorAll("a")].find(link => link.textContent === "All projects")!;
    expect(all.getAttribute("href")).toBe("/organizations/org-a/projects");
    expect(win.document.querySelector("#overview-projects")?.textContent).not.toContain("Project 5");
  });
  it.each([
    ["owner", "No projects yet. Create the first project to connect your documentation."],
    ["admin", "No projects yet. Create the first project to connect your documentation."],
    ["member", "No projects yet. An owner or admin can create the first project."],
  ])("overview with no projects gives a %s this guidance: %s", async (role, advice) => {
    const member = { ...access.member, role };
    const { win, navigate } = await setup(async path => path.includes("get-full-organization") ? { ...access, member, members: [member], teams: [] }
      : path.includes("management/access") ? { ...access, member } : path.includes("projects?") ? { projects: [] } : response(path));
    await navigate(""); await flush();
    expect(win.document.querySelector("#overview-projects .mini-empty")?.textContent).toBe(advice);
    expect(win.document.querySelectorAll("#overview-projects .overview-row")).toHaveLength(0);
  });
  it("lists projects behind a loading skeleton that gives way to the owner's empty guidance", async () => {
    const gate = deferred<unknown>();
    const { win, navigate } = await setup(async path => path.includes("management/access") ? gate.promise : path.includes("projects?") ? { projects: [] } : response(path));
    await navigate("/projects"); await flush();
    expect(win.document.querySelector(".loading-view,.skeleton-table-row")).not.toBeNull();
    expect(win.document.querySelector("#project-list")).toBeNull();
    gate.resolve(access); await flush();
    expect(win.document.querySelector(".loading-view,.skeleton-table-row")).toBeNull();
    const empty = win.document.querySelector(".empty")!;
    expect(empty.querySelector("h2")?.textContent).toBe("No projects yet");
    expect(empty.querySelector("p")?.textContent).toBe("Create the first documentation product for this organization.");
    expect(empty.querySelector("button")?.textContent).toBe("Create project");
  });
  it("tells a member an owner or admin must create the first project, without a create action", async () => {
    const member = { ...access.member, role: "member" };
    const { win, navigate } = await setup(async path => path.includes("get-full-organization") ? { ...access, member, members: [member], teams: [] }
      : path.includes("management/access") ? { ...access, member } : path.includes("projects?") ? { projects: [] } : response(path));
    await navigate("/projects"); await flush();
    expect(win.document.querySelector(".empty p")?.textContent).toBe("An owner or admin can create the first documentation product.");
    expect(win.document.querySelector(".empty button")).toBeNull();
  });
  it("shows a project list failure with its message and recovers through Try again", async () => {
    let failing = true;
    const { win, navigate } = await setup(async path => {
      if (path.includes("projects?") && failing) throw new Error("Projects unavailable");
      return response(path);
    });
    await navigate("/projects"); await flush();
    expect(win.document.querySelector(".empty h2")?.textContent).toBe("Unable to load projects");
    expect(win.document.querySelector(".empty p")?.textContent).toBe("Projects unavailable");
    failing = false;
    win.document.querySelector<HTMLButtonElement>(".empty button")!.click(); await flush();
    expect(win.document.querySelector(".empty")).toBeNull();
    expect(win.document.querySelector("#project-list")?.textContent).toContain(project.name);
  });
});
