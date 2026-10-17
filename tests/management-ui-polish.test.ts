import "./fixtures/management-page-presentation";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { Window, type HTMLButtonElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import apiKeyPageRoutes from "@/routes/api-key-pages";
import organizationPageRoutes from "@/routes/organization-pages";
import projectPageRoutes from "@/routes/project-pages";
import publicationPageRoutes from "@/routes/publication-pages";
import sharePageRoutes from "@/routes/share-pages";
import {
  API_KEY_SCOPES,
  MANAGEMENT_LABELS,
  managementLabel,
  managementUiRuntime,
  renderScopeFieldset,
} from "@/ui/management-ui";

const user = { id: "user-a", name: "QA", email: "qa@example.test" } as User;
const windows: Window[] = [];
afterEach(async () => { for (const win of windows.splice(0)) await win.happyDOM.close(); });

function pages(): Hono<{ Variables: { user?: User } }> {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => { c.set("user", user); await next(); });
  for (const routes of [organizationPageRoutes, projectPageRoutes, apiKeyPageRoutes, publicationPageRoutes, sharePageRoutes]) app.route("/", routes);
  return app;
}

async function flush() { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }

/** Mounts the real project page script with the shared UI runtime and mocked reads. */
async function projectPage(activeDeploymentId: string | null) {
  const html = await (await pages().request("/organizations/org-a/projects/project-a")).text();
  const win = new Window({ url: "https://rendro.test/organizations/org-a/projects/project-a", settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  windows.push(win);
  win.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
  const access = { id: "org-a", name: "Acme", userId: "user-a", member: { userId: "user-a", role: "owner" } };
  const request = (path: string) => {
    if (path.includes("management/access")) return Promise.resolve(access);
    if (path.includes("get-full-organization")) return Promise.resolve({ ...access, members: [access.member], teams: [] });
    if (path.includes("projects/get")) return Promise.resolve({ project: { _id: "project-a", name: "Docs", slug: "docs", createdAt: 1, activeDeploymentId } });
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  };
  const state = JSON.parse(html.match(/<script data-cp-page-state type="application\/json">([\s\S]*?)<\/script>/)![1]);
  Object.assign(win, { __RENDRO_PAGE_STATE__: state, RendroUI: { request, busy() {}, copyText() {}, toast() {}, openDialog() {} } });
  win.eval(managementUiRuntime);
  win.eval(html.match(/<script data-cp-page-script>([\s\S]*?)<\/script>/)![1]);
  await flush();
  return win;
}

describe("shared management vocabulary", () => {
  it("labels every credential scope accepted by the server", () => {
    const source = readFileSync(new URL("../convex/credentialHttp.ts", import.meta.url), "utf8");
    const allowed = [...source.matchAll(/^\s+"([a-z]+:[a-z]+)",$/gm)].map((match) => match[1]);
    expect(allowed.length).toBeGreaterThan(0);
    expect(API_KEY_SCOPES.slice().sort()).toEqual(allowed.slice().sort());
  });

  it("title-cases statuses, roles and permissions through one map", () => {
    expect(managementLabel("status", "superseded")).toBe("Superseded");
    expect(managementLabel("status", "failed")).toBe("Failed");
    expect(managementLabel("role", "admin")).toBe("Admin");
    expect(managementLabel("release", "undeployed")).toBe("Not deployed");
    expect(managementLabel("scope", "docs:write")).toBe("Push documentation");
    expect(managementLabel("status", "rolled_back")).toBe("Rolled Back");
    for (const labels of Object.values(MANAGEMENT_LABELS)) {
      for (const label of Object.values(labels)) expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    }
  });

  it("groups permission checkboxes in a fieldset with the shared labels on both screens", async () => {
    expect(renderScopeFieldset()).toMatch(/^<fieldset class="scope-fieldset"><legend class="field-label">Permissions<\/legend>/);
    const keys = await (await pages().request("/organizations/org-a/api-keys")).text();
    const onboarding = await (await pages().request("/organizations/org-a/onboarding?projectId=project-a")).text();
    for (const label of Object.values(MANAGEMENT_LABELS.scope)) expect(keys).toContain(`> ${label}</label>`);
    expect(onboarding).toContain("> Read deployments</label>");
    expect(onboarding).toContain("> Push documentation</label>");
    for (const html of [keys, onboarding]) {
      expect(html).not.toContain("Read documentation");
      expect(html).not.toContain("Publish documentation");
    }
  });
});

describe("documentation entry points", () => {
  it("hides the topbar and drawer docs links until a project's deployment is known", async () => {
    const html = await (await pages().request("/organizations/org-a/projects/project-a")).text();
    const links = html.match(/<a [^>]*data-cp-open-docs[^>]*>/g) ?? [];
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toContain(" hidden");
  });

  it("offers Open documentation only when the project has an active deployment", async () => {
    const waiting = await projectPage(null);
    expect(waiting.document.querySelector('.project-actions a[href$="/docs"]')).toBeNull();
    expect(waiting.document.querySelector('.project-actions a[href$="/deployments"]')?.textContent).toBe("View deployments");
    expect(waiting.document.querySelector(".project-docs-note")?.textContent).toContain("Waiting for first deployment");
    for (const link of waiting.document.querySelectorAll("[data-cp-open-docs]")) expect(link.hasAttribute("hidden")).toBe(true);

    const deployed = await projectPage("deployment-a");
    expect(deployed.document.querySelector('.project-actions a[href$="/docs"]')?.textContent).toBe("Open documentation");
    expect(deployed.document.querySelector(".project-docs-note")).toBeNull();
    const links = deployed.document.querySelectorAll("[data-cp-open-docs]");
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.hasAttribute("hidden")).toBe(false);
      expect(link.getAttribute("href")).toBe("/organizations/org-a/projects/project-a/docs");
    }
  });

  it("shows the project and active-deployment IDs in full, truncates them visually, and copies each one or reports a refusal", async () => {
    const win = await projectPage("deployment-" + "0123456789abcdef".repeat(4));
    const full = "deployment-" + "0123456789abcdef".repeat(4);
    const writes: string[] = [];
    let refuse = false;
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: (value: string) => refuse ? Promise.reject(new Error("denied")) : (writes.push(value), Promise.resolve()) } });
    const toast = vi.fn();
    (win as unknown as { RendroUI: { toast: typeof toast } }).RendroUI.toast = toast;
    const idCopy = (id: string) => win.document.querySelector<HTMLButtonElement>(`${id} .cp-id-copy`)!;
    const idText = (id: string) => win.document.querySelector(`${id} .cp-id`)!;
    expect(idText("#project-id").textContent).toBe("project-a");
    expect(idText("#active-deployment").textContent).toBe(full);
    expect(idText("#active-deployment").getAttribute("title")).toBe(full);
    expect(idCopy("#project-id").getAttribute("aria-label")).toBe("Copy project ID");
    expect(idCopy("#active-deployment").getAttribute("aria-label")).toBe("Copy deployment ID");
    // The text node is complete; the layout rule, not the data, is what shortens it.
    expect(readFileSync("src/ui/management-ui.ts", "utf8")).toMatch(/\.cp-id\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);

    idCopy("#project-id").click(); await flush();
    idCopy("#active-deployment").click(); await flush();
    expect(writes).toEqual(["project-a", full]);
    expect(idCopy("#project-id").getAttribute("aria-label")).toBe("project ID copied");
    expect(idCopy("#active-deployment").getAttribute("aria-label")).toBe("deployment ID copied");

    refuse = true;
    idCopy("#active-deployment").click(); await flush();
    expect(toast).toHaveBeenCalledExactlyOnceWith("Unable to copy. Select the value and copy it manually.", "error");
  });

  it("does not render an organization switcher or docs link without an organization", async () => {
    const chooser = await (await pages().request("/organizations?choose=1")).text();
    const invitation = await (await pages().request("/accept-invitation/invite-a")).text();
    for (const html of [chooser, invitation]) {
      expect(html).not.toContain('id="cp-org-switcher"');
      expect(html).not.toContain('id="cp-org-menu"');
      expect(html).not.toMatch(/<a [^>]*data-cp-open-docs/);
    }
  });

  it("carries the organization name and docs link into the mobile drawer", async () => {
    const html = await (await pages().request("/organizations/org-a/people")).text();
    const drawer = html.slice(html.indexOf('<div class="cp-sidebar"'), html.indexOf('<button class="cp-backdrop"'));
    expect(drawer).toContain('class="cp-drawer-org-name" data-org-name');
    expect(drawer).toContain("data-cp-open-docs");
    expect(drawer).toContain('href="/organizations?choose=1"');
  });
});

describe("shared confirmation dialog", () => {
  it("resolves false on Escape, true on accept, and returns focus to the trigger", async () => {
    const win = new Window({ url: "https://rendro.test/", settings: { enableJavaScriptEvaluation: true } });
    windows.push(win);
    win.document.write('<main class="cp-main"><button id="trigger">Remove</button></main>');
    Object.assign(win, { RendroUI: {} });
    win.eval(managementUiRuntime);
    const ui = (win as unknown as { RendroUI: { confirm(options: object): Promise<boolean> } }).RendroUI;
    const trigger = win.document.getElementById("trigger") as unknown as HTMLButtonElement;

    trigger.focus();
    const cancelled = ui.confirm({ title: "Remove member?", message: "They lose access.", confirmLabel: "Remove member" });
    const dialog = win.document.querySelector("main > #cp-confirm-dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.querySelector("#cp-confirm-title")?.textContent).toBe("Remove member?");
    expect(dialog.querySelector("[data-confirm-accept]")?.className).toBe("button destructive");
    expect(win.document.activeElement).toBe(dialog.querySelector("[data-confirm-cancel]"));
    dialog.dispatchEvent(new win.Event("cancel", { cancelable: true }));
    await expect(cancelled).resolves.toBe(false);
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(win.document.activeElement).toBe(trigger);

    const accepted = ui.confirm({ title: "Revoke key?", confirmLabel: "Revoke key" });
    dialog.querySelector<HTMLButtonElement>("[data-confirm-accept]")!.click();
    await expect(accepted).resolves.toBe(true);
    expect(win.document.querySelectorAll("#cp-confirm-dialog")).toHaveLength(1);
  });

  it("replaces every native destructive confirm() in management pages", async () => {
    const app = pages();
    for (const path of ["/organizations/org-a/people", "/organizations/org-a/teams", "/organizations/org-a/api-keys", "/organizations/org-a/projects/project-a/publications", "/organizations/org-a/projects/project-a/shares"]) {
      const script = (await (await app.request(path)).text()).match(/<script data-cp-page-script>([\s\S]*?)<\/script>/)![1];
      // Only the synchronous unsaved-settings navigation guard may still use the native prompt.
      const native = script.match(/(^|[^.\w])confirm\([^)]*\)/g) ?? [];
      expect(native.filter((call) => !call.includes("Discard unsaved organization changes?")), path).toEqual([]);
      expect(script, path).toContain("ui.confirm({");
    }
  });
});
