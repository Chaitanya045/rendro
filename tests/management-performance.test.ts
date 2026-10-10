/* Async mocks model network completion and rejection without real I/O. */
/* eslint-disable @typescript-eslint/require-await */
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLElement } from "happy-dom";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import projectPages from "@/routes/project-pages";
import { renderManagementNavigationRuntime } from "@/routes/management-navigation";
import { createManagementQueryCache } from "@/management-query/cache";
import { managementPagesSource } from "../scripts/management-pages-source";
import { organizationPageStyles, projectPageStyles } from "@/routes/management-loading";
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
  win.eval(managementUiRuntime);
  win.eval(renderManagementNavigationRuntime("org-a"));
  win.eval(await managementPagesSource());
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
  it("shares column sizing across every deployment row and uses the existing mobile table layout", () => {
    expect(projectPageStyles).toContain(".deployment-table{table-layout:fixed}");
    expect(projectPageStyles).toContain(".deployment-table .deployment-files-column{width:100px}");
    expect(projectPageStyles).toContain(".deployment-table .deployment-status-column{width:120px}");
    expect(projectPageStyles).toContain(".deployment-table td{vertical-align:top;overflow-wrap:anywhere}");
    expect(projectPageStyles).toContain("@media(max-width:760px){.deployment-table colgroup{display:none}");
    expect(projectPageStyles).not.toContain(".deployment-row{display:grid");
  });
  it("opens a dedicated history screen from desktop and mobile controls and reuses TanStack data", async () => {
    const { win, navigate, request, html, fetch } = await setup();
    // Exercise the same picker factory/change handler used by the shell.
    win.eval(html.slice(html.indexOf("function enhanceProjectNavigation()"), html.indexOf("  normalizeEmptyMarks(document);enhanceDialogs(document);new MutationObserver")));
    await navigate("/projects/project-a"); await flush();
    expect(request.mock.calls.some(([path]) => path.includes("deployments?"))).toBe(false);
    win.document.querySelector<HTMLElement>('.project-tabs a[href$="/deployments"]')!.click(); await flush();
    expect(win.location.pathname).toBe("/organizations/org-a/projects/project-a/deployments");
    expect(win.location.hash).toBe("");
    expect(win.document.querySelector(".cp-page-heading")?.textContent).toBe("Deployments");
    expect(win.document.querySelector("#project-id")).toBeNull();
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("No deployments yet");
    expect(win.document.querySelector("#deployment-list td")?.getAttribute("colspan")).toBe("4");
    expect(win.document.querySelector(".deployment-table-wrap")?.getAttribute("aria-busy")).toBe("false");
    expect(win.document.querySelector('.project-tabs a[aria-current="page"]')?.textContent).toBe("Deployments");
    await navigate("/projects/project-a/publications"); await flush();
    win.eval("enhanceProjectNavigation()");
    const picker = win.document.querySelector<HTMLSelectElement>(".project-section-picker select")!;
    picker.value = "https://rendro.test/organizations/org-a/projects/project-a/deployments";
    picker.dispatchEvent(new win.Event("change")); await flush();
    expect(win.location.pathname).toContain("/project-a/deployments");
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("No deployments yet");
    win.history.back(); await flush(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(win.location.pathname).toContain("/project-a/publications");
    win.history.forward(); await flush(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(win.location.pathname).toContain("/project-a/deployments");
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("No deployments yet");
    expect(request.mock.calls.filter(([path]) => path.includes("deployments?"))).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shows actual deployment records and renders untrusted source and failure labels as text", async () => {
    const deployments = ["failed", "staging", "active", "superseded"].map((status, index) => ({
      _id: `deployment-${index}`, status, createdAt: 1000 - index, fileCount: 3, byteCount: 2048,
      provenance: { source: index === 0 ? { localPathLabel: '<img src=x onerror="alert(1)">', dirty: true } : { commit: "abcdef1234567890" } },
      ...(index === 0 ? { failureReason: "<script>bad()</script>" } : {}),
    }));
    const { win, navigate } = await setup(async path => path.includes("deployments?") ? { deployments } : response(path));
    await navigate("/projects/project-a/deployments"); await flush();
    const rows = [...win.document.querySelectorAll("#deployment-list .deployment-row")];
    expect(rows).toHaveLength(4);
    expect(win.document.querySelector("#deployment-list")?.tagName).toBe("TBODY");
    expect([...win.document.querySelectorAll(".deployment-table th")].map(cell => cell.textContent)).toEqual(["Deployment", "Source", "Files", "Status"]);
    for (const row of rows) {
      expect(row.tagName).toBe("TR");
      expect([...row.children].map(cell => cell.tagName)).toEqual(["TD", "TD", "TD", "TD"]);
      expect([...row.children].map(cell => cell.getAttribute("data-label"))).toEqual(["Deployment", "Source", "Files", "Status"]);
    }
    // Rows lead with the release date; the ID is secondary, monospace and complete in its title.
    expect(rows.map(row => row.querySelector("strong")?.textContent)).toEqual(deployments.map(item => new Date(item.createdAt).toLocaleString()));
    expect(rows.map(row => row.querySelector(".cp-id")?.textContent)).toEqual(deployments.map(item => item._id));
    expect(rows.map(row => row.querySelector(".cp-id")?.getAttribute("title"))).toEqual(deployments.map(item => item._id));
    expect(rows.map(row => row.querySelector(".badge")?.textContent)).toEqual(["Failed", "Staging", "Active", "Superseded"]);
    expect(rows[2].querySelector(".badge")?.classList.contains("success")).toBe(true);
    expect(rows[0].textContent).toContain("3 files");
    expect(rows[0].textContent).toContain("2 KB");
    expect(rows[0].textContent).toContain("Uncommitted source changes");
    expect(rows[1].textContent).toContain("abcdef123456");
    expect(rows[0].querySelector(".deployment-failure")?.textContent).toBe("<script>bad()</script>");
    expect(rows[0].querySelector(".deployment-failure")?.closest("td")?.getAttribute("data-label")).toBe("Source");
    expect(win.document.querySelector("#deployment-list img,#deployment-list script")).toBeNull();
    expect(win.document.querySelector("#deployment-count")?.textContent).toBe("4 shown");
  });
  it("retains one route-specific skeleton and its selected tab until project access resolves", async () => {
    const gate = deferred<unknown>();
    const { win, navigate } = await setup(async path => path.includes("management/access") ? gate.promise : response(path));
    await navigate("/projects/project-a/deployments"); await flush();
    expect(win.document.querySelectorAll('#project-content [aria-label="Loading deployment history"]')).toHaveLength(1);
    expect(win.document.querySelector(".project-overview")).toBeNull();
    expect(win.document.querySelector('.project-tabs a[aria-current="page"]')?.textContent).toBe("Deployments");
    expect(win.document.querySelector("#deployment-list .deployment-row")).toBeNull();
    expect(win.document.querySelectorAll("#deployment-list .skeleton-table-row")).toHaveLength(4);
    expect([...win.document.querySelectorAll("#deployment-list .skeleton-table-row")].every(row => row.children.length === 4)).toBe(true);
    gate.resolve(access); await flush();
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("No deployments yet");
  });
  it("retries a failed history read without refetching project details", async () => {
    let attempts = 0;
    const { win, navigate, request } = await setup(async path => {
      if (path.includes("deployments?")) { if (++attempts === 1) throw new Error("Temporary failure"); return { deployments: [] }; }
      return response(path);
    });
    await navigate("/projects/project-a/deployments"); await flush();
    win.document.querySelector<HTMLButtonElement>("#deployment-list button")!.click(); await flush();
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("No deployments yet");
    expect(attempts).toBe(2);
    expect(request.mock.calls.filter(([path]) => path.includes("projects/get"))).toHaveLength(1);
  });
  it("never mixes deployment history between projects", async () => {
    const { win, navigate, request } = await setup(async path => path.includes("deployments?") ? {
      deployments: [{ _id: path.includes("projectId=project-b") ? "release-b" : "release-a", status: "active", createdAt: 1, fileCount: 1, byteCount: 1 }],
    } : response(path));
    await navigate("/projects/project-a/deployments"); await flush();
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("release-a");
    await navigate("/projects/project-b/deployments"); await flush();
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("release-b");
    expect(win.document.querySelector("#deployment-list")?.textContent).not.toContain("release-a");
    await navigate("/projects/project-a/deployments"); await flush();
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("release-a");
    expect(request.mock.calls.filter(([path]) => path.includes("deployments?"))).toHaveLength(2);
  });
  it("does not display cached deployment history when membership is revoked", async () => {
    let revoked = false;
    const { win, navigate } = await setup(async path => {
      if (revoked && path.includes("management/access")) throw Object.assign(new Error("Access revoked"), { status: 403 });
      return path.includes("deployments?") ? { deployments: [{ _id: "private-release", status: "active", createdAt: 1, fileCount: 1, byteCount: 1 }] } : response(path);
    });
    await navigate("/projects/project-a/deployments"); await flush();
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("private-release");
    await navigate("/projects"); await flush();
    revoked = true;
    await navigate("/projects/project-a/deployments"); await flush();
    expect(win.document.querySelector("main")?.textContent).toContain("Access revoked");
    expect(win.document.querySelector("main")?.textContent).not.toContain("private-release");
  });
  it("allows members to read history without enabling owner-only project controls", async () => {
    const { win, navigate } = await setup(async path => path.includes("management/access")
      ? { ...access, member: { ...access.member, role: "member" } } : response(path));
    await navigate("/projects/project-a/deployments"); await flush();
    expect(win.document.querySelector("#deployment-list")?.textContent).toContain("No deployments yet");
    expect(win.document.querySelector(".access-note")?.textContent).toContain("read-only project access");
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
  it("mounts all ten routes without an HTML fetch and preserves the shell", async () => {
    const { win, navigate, fetch } = await setup();
    const header = win.document.querySelector(".cp-topbar");
    for (const path of ["", "/people", "/teams", "/settings", "/api-keys", "/projects", "/projects/project-a", "/projects/project-a/deployments", "/projects/project-a/publications", "/projects/project-a/shares"]) {
      expect(await navigate(path), path).toBe(true); await flush();
      expect(win.document.querySelector(".cp-topbar"), path).toBe(header);
      expect(win.document.querySelector("main")?.textContent, path).not.toContain("Unable to load");
      expect(win.document.querySelector("main")?.innerHTML, path).not.toContain("__RD_");
      expect(win.document.querySelector(".loading-view,.skeleton-table-row"), path).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("renders deployment navigation and CLI instructions before history and ignores late history after navigation", async () => {
    const history = deferred<unknown>();
    const { win, navigate } = await setup(async (path) => path.includes("deployments?") ? history.promise : response(path));
    await navigate("/projects/project-a/deployments"); await flush();
    expect(win.document.querySelector(".cp-page-heading")?.textContent).toBe("Deployments");
    expect(win.document.querySelector(".command code")?.textContent).toContain("--project 'project-a'");
    expect(win.document.querySelector("#deployments .loading-view")).not.toBeNull();
    await navigate("/projects"); await flush();
    history.resolve({ deployments: [] }); await flush();
    expect(win.document.querySelector("#project-list")?.textContent).toContain(project.name);
    expect(win.document.querySelector("#deployment-list")).toBeNull();
  });
  it("keeps primary content when deployment history fails", async () => {
    const { win, navigate } = await setup(async (path) => { if (path.includes("deployments?")) throw new Error("History unavailable"); return response(path); });
    await navigate("/projects/project-a/deployments"); await flush();
    expect(win.document.querySelector(".cp-page-heading")?.textContent).toBe("Deployments");
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
