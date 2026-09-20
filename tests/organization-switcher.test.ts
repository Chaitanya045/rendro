import { Window, type HTMLButtonElement, type HTMLElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "better-auth/types";
import { renderControlPlanePage } from "@/routes/control-plane";
import { organizationSwitcherRuntime, organizationSwitcherStyles, renderOrganizationLabelBootstrap } from "@/routes/organization-switcher";
import { createOrganizationListCache } from "@/management-query/organizations";

const windows: Window[] = [];
const caches: ReturnType<typeof createOrganizationListCache>[] = [];
const organizations = [{ id: "org-a", name: "Acme" }, { id: "org-b", name: "Beta" }];
function page(organizationId?: string) {
  return renderControlPlanePage({ user: { id: "u", name: "QA", email: "qa@example.test" } as User, organizationId, title: "Test", eyebrow: "", heading: "Test", description: "", content: "", script: "" });
}
function setup(respond: () => Promise<unknown> = () => Promise.resolve(organizations), cached = false) {
  const win = new Window({ url: "https://rendro.test/organizations/org-a/projects", settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  windows.push(win);
  win.document.write(page("org-a").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
  const request = vi.fn(respond), navigate = vi.fn(() => Promise.resolve(true)), toast = vi.fn();
  const cache = cached ? createOrganizationListCache({ userId: "u", origin: "https://rendro.test" }, request) : null;
  if (cache) caches.push(cache);
  const uiRequest = cache ? cache.request : request;
  Object.assign(win, { RendroUI: { request: uiRequest, navigate, toast } });
  win.eval(organizationSwitcherRuntime);
  const trigger = win.document.querySelector<HTMLButtonElement>("#cp-org-switcher")!;
  const menu = win.document.querySelector<HTMLElement>("#cp-org-menu")!;
  const key = (target: HTMLElement, value: string) => target.dispatchEvent(new win.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  return { win, request, navigate, toast, trigger, menu, key, uiRequest };
}
async function flush() { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
afterEach(async () => { await Promise.all(caches.splice(0).map(cache => cache.clear())); for (const win of windows.splice(0)) { win.dispatchEvent(new win.Event("pagehide")); await win.happyDOM.close(); } });

describe("header organization switcher", () => {
  it("reopens from TanStack cache, then refetches after a confirmed organization creation", async () => {
    const { trigger, menu, request, uiRequest } = setup(undefined, true);
    trigger.click(); await flush(); trigger.click(); trigger.click(); await flush();
    expect(request).toHaveBeenCalledOnce(); expect(menu.textContent).toContain("Beta");
    trigger.click(); await uiRequest("/api/auth/organization/create", { method: "POST" });
    request.mockResolvedValue([...organizations, { id: "new", name: "New organization" }]);
    trigger.click(); await flush();
    expect(request).toHaveBeenCalledTimes(3); expect(menu.textContent).toContain("New organization");
  });
  it("keeps the logo in the current workspace and provides a no-JS chooser fallback", () => {
    expect(page("org-a")).toContain('class="cp-brand" href="/organizations/org-a"');
    expect(page()).toContain('class="cp-brand" href="/organizations"');
    expect(page("org-a")).toContain('id="cp-org-switcher" href="/organizations?choose=1"');
  });
  it("opens locally, loads on demand and marks the current organization", async () => {
    const { trigger, menu, request, navigate, win } = setup();
    expect(trigger.tagName).toBe("BUTTON"); expect(request).not.toHaveBeenCalled();
    trigger.click(); expect(menu.hidden).toBe(false); expect(menu.textContent).toContain("Loading organizations");
    await flush();
    expect(request).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
    expect(request.mock.calls[0]).toMatchObject(["/api/auth/organization/list", { signal: expect.anything() }]);
    expect(menu.querySelector('[aria-current="true"]')?.textContent).toContain("Acme");
    expect(win.document.activeElement?.getAttribute("aria-current")).toBe("true");
  });
  it("updates the selected organization immediately while navigation is pending", async () => {
    const { trigger, menu, navigate, win } = setup(); trigger.click(); await flush();
    menu.querySelector<HTMLElement>('[data-organization-id="org-b"]')!.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://rendro.test/organizations/org-b/projects");
    expect(menu.hidden).toBe(true); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.querySelector("[data-org-name]")?.textContent).toBe("Beta");
    expect(trigger.querySelector("[data-org-mark]")?.textContent).toBe("B");
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    // Only a one-use display hint crosses the document boundary, not the query cache.
    expect(JSON.parse(win.sessionStorage.getItem("rendro-org-navigation-label")!)).toMatchObject({ userId: "u", organizationId: "org-b", name: "Beta" });
  });
  it.each([
    ["/organizations/org-a", "/organizations/org-b"],
    ["/organizations/org-a/projects", "/organizations/org-b/projects"],
    ["/organizations/org-a/projects/project-a", "/organizations/org-b/projects"],
    ["/organizations/org-a/projects/project-a/publications", "/organizations/org-b/projects"],
    ["/organizations/org-a/people", "/organizations/org-b/people"],
    ["/organizations/org-a/teams", "/organizations/org-b/teams"],
    ["/organizations/org-a/settings", "/organizations/org-b/settings"],
    ["/organizations/org-a/api-keys", "/organizations/org-b/api-keys"],
  ])("preserves the selected sidebar section from %s", async (source, destination) => {
    const { win, trigger, menu } = setup(); win.history.replaceState({}, "", source);
    trigger.click(); await flush();
    expect(menu.querySelector<HTMLElement>('[data-organization-id="org-b"]')?.getAttribute("href")).toBe(destination);
  });
  it("paints the destination name before loading the query bundle or making API calls", () => {
    const { win } = setup();
    win.sessionStorage.setItem("rendro-org-navigation-label", JSON.stringify({ userId: "u", organizationId: "org-b", name: "Beta", createdAt: Date.now() }));
    win.eval(renderOrganizationLabelBootstrap("u", "org-b"));
    expect(win.document.querySelector("[data-org-name]")?.textContent).toBe("Beta");
    expect(win.document.querySelector("[data-org-mark]")?.textContent).toBe("B");
    expect(win.sessionStorage.getItem("rendro-org-navigation-label")).toBeNull();
    const html = page("org-b");
    expect(html.indexOf("<script data-cp-org-label>")).toBeLessThan(html.indexOf('<script src="/select.js'));
    expect(html.indexOf("<script data-cp-org-label>")).toBeLessThan(html.indexOf('<script src="/management-query.js'));
  });
  it.each([
    { userId: "other" }, { organizationId: "other" }, { createdAt: 0 }, { createdAt: Date.now() + 120000 }, { name: "" }, { name: 42 }, { name: "a".repeat(257) },
  ])("discards mismatched, stale or malformed navigation labels: %j", change => {
    const { win } = setup();
    win.sessionStorage.setItem("rendro-org-navigation-label", JSON.stringify({ userId: "u", organizationId: "org-b", name: "Beta", createdAt: Date.now(), ...change }));
    win.eval(renderOrganizationLabelBootstrap("u", "org-b"));
    expect(win.document.querySelector("[data-org-name]")?.textContent).toBe("Organization");
    expect(win.sessionStorage.getItem("rendro-org-navigation-label")).toBeNull();
  });
  it("renders navigation labels as text and lets the confirmed server name replace them", () => {
    const { win } = setup(); const name = '<img src=x onerror="alert(1)">';
    win.sessionStorage.setItem("rendro-org-navigation-label", JSON.stringify({ userId: "u", organizationId: "org-b", name, createdAt: Date.now() }));
    win.eval(renderOrganizationLabelBootstrap("u", "org-b"));
    const label = win.document.querySelector("[data-org-name]")!;
    expect(label.textContent).toBe(name); expect(label.querySelector("img")).toBeNull();
    label.textContent = "Confirmed rename"; win.eval(renderOrganizationLabelBootstrap("u", "org-b"));
    expect(label.textContent).toBe("Confirmed rename");
  });
  it("continues navigating when session storage is unavailable", async () => {
    const { win, trigger, menu, navigate } = setup();
    Object.defineProperty(win, "sessionStorage", { get() { throw new Error("Blocked storage"); } });
    expect(() => { win.eval(renderOrganizationLabelBootstrap("u", "org-b")); }).not.toThrow();
    trigger.click(); await flush(); menu.querySelector<HTMLElement>('[data-organization-id="org-b"]')!.click();
    expect(navigate).toHaveBeenCalledOnce();
  });
  it("clears the label handoff on failed navigation", async () => {
    const { win, trigger, menu, navigate, toast } = setup(); navigate.mockRejectedValueOnce(new Error("Navigation failed"));
    trigger.click(); await flush(); menu.querySelector<HTMLElement>('[data-organization-id="org-b"]')!.click(); await flush();
    expect(win.sessionStorage.getItem("rendro-org-navigation-label")).toBeNull();
    expect(trigger.textContent).toContain("Organization");
    expect(trigger.hasAttribute("aria-busy")).toBe(false); expect(trigger.hasAttribute("aria-disabled")).toBe(false);
    expect(toast).toHaveBeenCalledWith("Unable to switch organization. Please try again.", "error");
  });
  it("rolls the optimistic label back when a route-leave guard blocks navigation", async () => {
    const { win, trigger, menu, navigate, toast } = setup(); navigate.mockResolvedValueOnce(false);
    trigger.click(); await flush(); menu.querySelector<HTMLElement>('[data-organization-id="org-b"]')!.click();
    expect(trigger.querySelector("[data-org-name]")?.textContent).toBe("Beta");
    await flush();
    expect(trigger.querySelector("[data-org-name]")?.textContent).toBe("Organization");
    expect(trigger.querySelector("[data-org-mark]")?.textContent).toBe("R");
    expect(trigger.hasAttribute("aria-busy")).toBe(false); expect(trigger.hasAttribute("aria-disabled")).toBe(false);
    expect(win.sessionStorage.getItem("rendro-org-navigation-label")).toBeNull(); expect(toast).not.toHaveBeenCalled();
  });
  it("keeps the current organization on the current page", async () => {
    const { trigger, menu, navigate } = setup(); trigger.click(); await flush();
    menu.querySelector<HTMLElement>('[aria-current="true"]')!.click();
    expect(navigate).not.toHaveBeenCalled(); expect(menu.hidden).toBe(true);
  });
  it("supports arrows, Home/End, typeahead, Space selection and Escape focus restoration", async () => {
    const { trigger, menu, key, win, navigate } = setup();
    key(trigger, "ArrowDown"); await flush(); key(menu, "ArrowDown");
    expect(win.document.activeElement?.textContent).toContain("Beta");
    key(menu, "End"); expect(win.document.activeElement?.textContent).toBe("Manage organizations");
    key(menu, "Home"); expect(win.document.activeElement?.textContent).toContain("Acme");
    key(menu, "b"); expect(win.document.activeElement?.textContent).toContain("Beta");
    key(menu, "Escape"); expect(menu.hidden).toBe(true); expect(win.document.activeElement).toBe(trigger);
    trigger.click(); await flush(); key(menu, "ArrowDown"); key(menu, " ");
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://rendro.test/organizations/org-b/projects");
  });
  it("shows recoverable failures and delegates reopened reads to the shared requester", async () => {
    let fail = true;
    const { trigger, menu, request } = setup(() => fail ? Promise.reject(new Error("offline")) : Promise.resolve(organizations));
    trigger.click(); await flush(); expect(menu.textContent).toContain("Unable to load organizations");
    fail = false; menu.querySelector<HTMLButtonElement>("button")!.click(); await flush();
    expect(menu.textContent).toContain("Beta"); expect(menu.hasAttribute("aria-busy")).toBe(false);
    trigger.click(); trigger.click(); await flush(); expect(request).toHaveBeenCalledTimes(3);
  });
  it("ignores late responses after close or reopening", async () => {
    let resolve!: (value: unknown) => void;
    let count = 0;
    const { trigger, menu } = setup(() => ++count === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve(organizations));
    trigger.click(); trigger.click(); trigger.click(); await flush();
    resolve([{ id: "stale", name: "Stale organization" }]); await flush();
    expect(menu.textContent).toContain("Beta"); expect(menu.textContent).not.toContain("Stale organization");
  });
  it("dismisses on outside input, focus departure and route leave", async () => {
    const { trigger, menu, win } = setup(); trigger.click(); await flush();
    win.document.body.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true })); expect(menu.hidden).toBe(true);
    trigger.click(); await flush(); win.document.querySelector<HTMLElement>(".cp-brand")!.focus(); expect(menu.hidden).toBe(true);
    trigger.click(); await flush(); win.document.dispatchEvent(new win.Event("rendro:before-route-leave")); expect(menu.hidden).toBe(true);
  });
  it("handles empty membership and hostile names as text", async () => {
    const { trigger, menu } = setup(() => Promise.resolve([{ id: "a/b", name: '<img src=x onerror="alert(1)">' }]));
    trigger.click(); await flush(); expect(menu.querySelector("img")).toBeNull();
    expect(menu.querySelector('[data-org-options] a')?.getAttribute("href")).toBe("/organizations/a%2Fb/projects");
    const empty = setup(() => Promise.resolve([])); empty.trigger.click(); await flush();
    expect(empty.menu.textContent).toContain("No organizations yet"); expect(empty.menu.textContent).toContain("Manage organizations");
  });
  it("preserves modified-click browser behavior", async () => {
    const { trigger, menu, navigate, win } = setup(); trigger.click(); await flush();
    const event = new win.MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true });
    menu.querySelector<HTMLElement>('[data-organization-id="org-b"]')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(navigate).not.toHaveBeenCalled();
  });
  it("uses contained popup sizing, shared motion and mobile touch targets", () => {
    expect(organizationSwitcherStyles).toContain("max-width:calc(100vw - 16px)");
    expect(organizationSwitcherStyles).toContain("min-height:44px");
    expect(organizationSwitcherStyles).toContain("prefers-reduced-motion:reduce");
    expect(organizationSwitcherStyles).toContain("var(--cp-container)");
  });
});
