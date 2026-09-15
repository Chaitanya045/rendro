import vm from "node:vm";
import type { User } from "better-auth/types";
import { describe, expect, it, vi } from "vitest";
import { renderControlPlanePage } from "@/routes/control-plane";
import { managementRouteIdentity, renderManagementNavigationRuntime } from "@/routes/management-navigation";

const user = {
  id: "user-a",
  name: "A User",
  email: "user@example.test",
} as User;

function renderedPage(): string {
  return renderControlPlanePage({
    user,
    title: "People",
    eyebrow: "Organization access",
    heading: "People",
    description: "Manage workspace access.",
    organizationId: "org-a",
    active: "people",
    content: '<section id="people">People</section>',
    state: { organizationId: "org-a" },
    script: "window.__pageMounted=true;",
  });
}

function scopeRuntime() {
  const runtime = renderManagementNavigationRuntime();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  let openDialog = false;
  const main = {
    getAttribute: (name: string) => ({
      "data-cp-organization-id": "org-a",
      "data-cp-user-id": "user-a",
      "data-cp-shell-version": "2",
    })[name] ?? null,
  };
  const request = vi.fn();
  const toast = vi.fn();
  const ui = {
    request,
    toast,
    busy: vi.fn(),
    copyText: vi.fn(),
    openDialog: vi.fn(),
    applyTheme: vi.fn(),
  };
  const location = {
    href: "https://rendro.test/organizations/org-a/people",
    origin: "https://rendro.test",
    pathname: "/organizations/org-a/people",
    search: "",
    hash: "",
    assign: vi.fn(),
    replace: vi.fn(),
  };
  const history = { state: null, replaceState: vi.fn(), pushState: vi.fn(), go: vi.fn() };
  const document = {
    querySelector: (selector: string) => selector === ".cp-main[data-cp-route-envelope]" ? main : selector === ".cp-main dialog[open]" && openDialog ? {} : null,
    querySelectorAll: () => [],
    addEventListener: (name: string, callback: (...args: unknown[]) => unknown) => listeners.set(name, callback),
    dispatchEvent: () => true,
  };
  class TestCustomEvent {
    constructor(public type: string, public init: unknown) {}
  }
  const context = vm.createContext({
    window: { RendroUI: ui, fetch: vi.fn(), DOMParser: class {}, AbortController },
    document,
    location,
    history,
    URL,
    AbortController,
    AbortSignal,
    DOMException,
    CustomEvent: TestCustomEvent,
    Element: class {},
    addEventListener: (name: string, callback: (...args: unknown[]) => unknown) => listeners.set(name, callback),
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(runtime, context);
  return { ui: ui as typeof ui & { createPageScope: () => PageScope }, request, toast, setOpenDialog: (value: boolean) => { openDialog = value; } };
}

interface PageScope {
  signal: AbortSignal;
  request(path: string, options?: RequestInit): Promise<unknown>;
  isActive(): boolean;
  onCleanup(callback: () => void): () => void;
  preventNavigation(check: () => boolean): () => void;
  canLeave(detail: unknown): boolean;
  toast(message: string): void;
}

describe("persistent management navigation", () => {
  it("recognizes only the exact progressive-enhancement route set", () => {
    expect(managementRouteIdentity("/organizations/org-a")).toEqual({ organizationId: "org-a", projectId: undefined, section: "overview" });
    expect(managementRouteIdentity("/organizations/org-a/projects/project-a/publications")).toEqual({ organizationId: "org-a", projectId: "project-a", section: "publications" });
    expect(managementRouteIdentity("/organizations/org-a/projects/project-a/shares/")).toEqual({ organizationId: "org-a", projectId: "project-a", section: "shares" });
    expect(managementRouteIdentity("/organizations/org-a/projects/project-a/docs")).toBeNull();
    expect(managementRouteIdentity("/organizations/org-a/onboarding")).toBeNull();
    expect(managementRouteIdentity("/organizations")).toBeNull();
    expect(managementRouteIdentity("/account/security")).toBeNull();
    expect(managementRouteIdentity("/organizations/%E0%A4%A/people")).toBeNull();
  });

  it("emits a user/org/version-bound envelope and marked state and route script", () => {
    const html = renderedPage();
    expect(html).toContain('data-cp-route-envelope="true"');
    expect(html).toContain('data-cp-shell-version="2"');
    expect(html).toContain('data-cp-organization-id="org-a"');
    expect(html).toContain('data-cp-user-id="user-a"');
    expect(html).toContain('<script data-cp-page-state type="application/json">{"organizationId":"org-a"}</script>');
    expect(html).toContain('<script data-cp-page-script>window.__pageMounted=true;</script>');
    expect(html).toContain("credentials:\"same-origin\",cache:\"no-store\"");
    const captureScroll = html.indexOf("departingScroll=window.scrollY||0");
    const closeDrawer = html.indexOf('disposePage();if(typeof ui.setNav==="function")ui.setNav(false,false)');
    const showSkeleton = html.indexOf("showDestinationSkeleton(route,mode,options&&options.scrollY)", closeDrawer);
    const saveHistory = html.indexOf("setHistory(url,mode,departingScroll)", showSkeleton);
    expect(captureScroll).toBeGreaterThan(0);
    expect(closeDrawer).toBeGreaterThan(captureScroll);
    expect(showSkeleton).toBeGreaterThan(closeDrawer);
    expect(saveHistory).toBeGreaterThan(showSkeleton);
    expect(html).toContain("if(!supported(new URL(location.href)))return");
    expect(html).toContain("Loading people and invitations");
    expect(html).toContain("pendingExpectedMarkup.get(pendingContent)!==normalizedServerMarkup(incoming)");
    expect(html).not.toContain("function destinationCopy");
    expect(html).not.toContain("eval(");
    expect(html).not.toContain("new Function");
  });

  it("invalidates old scopes, guards stale helpers, and deduplicates only in-flight scoped GETs", async () => {
    const runtime = scopeRuntime();
    let resolveRequest!: (value: unknown) => void;
    runtime.request.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const first = runtime.ui.createPageScope();
    const cleanup = vi.fn();
    first.onCleanup(cleanup);
    const one = first.request("/api/data");
    const two = first.request("/api/data");
    expect(runtime.request).toHaveBeenCalledTimes(1);
    resolveRequest({ ok: true });
    await expect(Promise.all([one, two])).resolves.toEqual([{ ok: true }, { ok: true }]);
    runtime.request.mockResolvedValueOnce({ ok: true });
    await first.request("/api/data");
    expect(runtime.request).toHaveBeenCalledTimes(2);

    const second = runtime.ui.createPageScope();
    expect(first.isActive()).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    first.toast("stale");
    second.toast("current");
    expect(runtime.toast).toHaveBeenCalledOnce();
    expect(runtime.toast).toHaveBeenCalledWith("current");
  });

  it("blocks a route swap for pending mutations, open dialogs, and page-specific guards", async () => {
    const runtime = scopeRuntime();
    let resolveMutation!: (value: unknown) => void;
    runtime.request.mockImplementation(() => new Promise((resolve) => { resolveMutation = resolve; }));
    const scope = runtime.ui.createPageScope();
    const pending = scope.request("/api/update", { method: "POST" });
    expect(scope.canLeave({ kind: "navigation" })).toBe(false);
    resolveMutation({ ok: true });
    await pending;
    expect(scope.canLeave({ kind: "navigation" })).toBe(true);
    runtime.setOpenDialog(true);
    expect(scope.canLeave({ kind: "navigation" })).toBe(false);
    runtime.setOpenDialog(false);
    const removeGuard = scope.preventNavigation(() => false);
    expect(scope.canLeave({ kind: "navigation" })).toBe(false);
    removeGuard();
    expect(scope.canLeave({ kind: "navigation" })).toBe(true);
  });
});
