import { Window, type HTMLButtonElement, type HTMLElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSelects } from "@/ui/select";
import { selectStyles } from "@/ui/select-styles";
import { renderControlPlanePage } from "@/routes/control-plane";
import type { User } from "better-auth/types";

const windows: Window[] = [];
const cleanups: (() => void)[] = [];
function setup(html = '<form><label>Release mode<select class="select" name="mode" required><option value="">Choose a mode</option><option value="active">Tracks active</option><option value="pinned">Pinned</option><option value="disabled" disabled>Disabled</option></select></label></form>') {
  const win = new Window(); windows.push(win);
  win.document.body.innerHTML = html;
  const installed = installSelects(win.document as unknown as Document); cleanups.push(() => installed.destroy());
  const select = win.document.querySelector("select")!;
  const trigger = win.document.querySelector<HTMLButtonElement>(".rd-select-trigger")!;
  const popup = win.document.querySelector<HTMLElement>(".rd-select-popup")!;
  const key = (value: string) => trigger.dispatchEvent(new win.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  return { win, select, trigger, popup, key, installed, flush: () => win.happyDOM.whenAsyncComplete() };
}
afterEach(async () => { cleanups.splice(0).forEach((cleanup) => cleanup()); await Promise.all(windows.splice(0).map((win) => win.happyDOM.close())); });

describe("shared shadcn-style select", () => {
  it("preserves native form controls and exposes a named combobox", () => {
    const { select, trigger, popup } = setup();
    expect(select.getAttribute("aria-hidden")).toBe("true");
    expect(select.tabIndex).toBe(-1);
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.getAttribute("aria-label")).toBe("Release mode");
    expect(trigger.getAttribute("aria-controls")).toBe(popup.id);
    expect(trigger.getAttribute("aria-required")).toBe("true");
    expect(trigger.type).toBe("button");
  });
  it("opens one shared list, commits by keyboard and dispatches native input/change once", () => {
    const { win, select, trigger, popup, key } = setup();
    const input = vi.fn(), change = vi.fn(); select.addEventListener("input", input); select.addEventListener("change", change);
    trigger.focus(); key("ArrowDown"); key("ArrowDown"); key("Enter");
    expect(select.value).toBe("active"); expect(trigger.textContent).toBe("Tracks active");
    expect(popup.hidden).toBe(true); expect(win.document.activeElement).toBe(trigger);
    expect(new win.FormData(select.form!).get("mode")).toBe("active");
    expect(input).toHaveBeenCalledOnce(); expect(change).toHaveBeenCalledOnce();
  });
  it("Escape cancels pending selection and doesn't escape into the enclosing dialog", () => {
    const { win, select, trigger, key } = setup();
    const outer = vi.fn(); win.document.addEventListener("keydown", outer);
    key("Enter"); key("ArrowDown"); key("Escape");
    expect(select.value).toBe(""); expect(trigger.getAttribute("aria-expanded")).toBe("false"); expect(outer).not.toHaveBeenCalled();
  });
  it("supports Home/End and skips disabled options", () => {
    const { select, key } = setup();
    key("End"); key("Enter"); expect(select.value).toBe("pinned");
    key("Home"); key("Enter"); expect(select.value).toBe("");
  });
  it("supports typeahead and commits on Tab without trapping focus", () => {
    const { select, trigger, key } = setup();
    key("p"); expect(select.value).toBe(""); key("Tab"); expect(select.value).toBe("pinned");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it("retains full long labels as text without interpreting markup", () => {
    const { select, trigger, popup } = setup();
    select.options[1].textContent = '<img src=x onerror=alert(1)> Long project label'; select.value = "active";
    expect(trigger.textContent).toContain("<img src=x"); expect(popup.querySelector("img")).toBeNull();
  });
  it("mirrors server-confirmed values, rollback and disabled state synchronously", () => {
    const { select, trigger, key } = setup();
    select.value = "active"; expect(trigger.textContent).toBe("Tracks active");
    select.value = "pinned"; expect(trigger.textContent).toBe("Pinned");
    select.value = "active"; expect(trigger.textContent).toBe("Tracks active");
    key("Enter"); select.disabled = true;
    expect(trigger.disabled).toBe(true); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    select.disabled = false; expect(trigger.disabled).toBe(false);
  });
  it("supports async options and native form reset", async () => {
    const { select, trigger, flush } = setup();
    select.innerHTML = '<option value="new">New deployment</option><option value="other">Other deployment</option>';
    await flush(); expect(trigger.textContent).toBe("New deployment");
    select.value = "other"; select.form!.reset(); await flush(); expect(trigger.textContent).toBe("New deployment");
  });
  it("routes native required validation to the visible trigger", () => {
    const { select, trigger, win } = setup();
    select.dispatchEvent(new win.Event("invalid", { cancelable: true }));
    expect(trigger.getAttribute("aria-invalid")).toBe("true"); expect(win.document.activeElement).toBe(trigger);
    expect(win.document.querySelector<HTMLElement>(".rd-select-validation")?.hidden).toBe(false);
    expect(trigger.getAttribute("aria-describedby")).toContain("-error");
    select.value = "active";
    expect(win.document.querySelector<HTMLElement>(".rd-select-validation")?.hidden).toBe(true);
    expect(trigger.hasAttribute("aria-invalid")).toBe(false);
  });
  it("renders a selected check and disabled options with ARIA state", () => {
    const { select, popup } = setup(); select.value = "active";
    expect(popup.querySelector('[aria-selected="true"]')?.textContent).toBe("Tracks active");
    expect(popup.querySelector('[aria-disabled="true"]')?.textContent).toBe("Disabled");
  });
  it("keeps popups inside modal dialogs and removes orphan popups on navigation", async () => {
    const { select, popup, win, flush } = setup('<dialog open><label>Scope<select class="select"><option>A</option></select></label></dialog>');
    expect(popup.closest("dialog")).not.toBeNull(); select.closest("dialog")!.remove(); await flush();
    expect(win.document.querySelector(".rd-select-popup")).toBeNull();
  });
  it("enhances dynamically inserted selects once and only opens one popup", async () => {
    const { win, trigger, flush, popup } = setup();
    const extra = win.document.createElement("select"); extra.className = "select"; extra.innerHTML = "<option>Member</option>"; win.document.body.append(extra);
    await flush(); expect(win.document.querySelectorAll(".rd-select-trigger")).toHaveLength(2);
    trigger.click(); (extra.nextElementSibling as unknown as HTMLButtonElement).click();
    expect(popup.hidden).toBe(true); expect(win.document.querySelectorAll('.rd-select-trigger[aria-expanded="true"]')).toHaveLength(1);
  });
  it("closes on outside pointer and route leave without changing the value", () => {
    const { win, trigger, select } = setup(); trigger.click();
    win.document.body.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true })); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click(); win.document.dispatchEvent(new win.Event("rendro:before-route-leave")); expect(trigger.getAttribute("aria-expanded")).toBe("false"); expect(select.value).toBe("");
  });
  it("leaves multi-selects and listboxes native", () => {
    const { win } = setup('<select class="select" multiple><option>A</option></select><select class="select" size="3"><option>A</option></select>');
    expect(win.document.querySelectorAll(".rd-select-trigger")).toHaveLength(0);
  });
  it("restores native operation on teardown", () => {
    const { select, installed, win } = setup(); installed.destroy();
    expect(select.hasAttribute("aria-hidden")).toBe(false); expect(select.hasAttribute("data-rd-select")).toBe(false);
    expect(Object.hasOwn(select, "value")).toBe(false); expect(win.document.querySelectorAll(".rd-select-trigger,.rd-select-popup")).toHaveLength(0);
  });
  it("shares dark, mobile, reduced-motion and forced-colors styles", () => {
    expect(selectStyles).toContain("html.dark .rd-select-popup"); expect(selectStyles).toContain("min-height:44px");
    expect(selectStyles).toContain("prefers-reduced-motion:reduce"); expect(selectStyles).toContain("forced-colors:active");
  });
  it("does not rebuild a popup when shell synchronization writes the same value", () => {
    const { select, popup } = setup(); select.value = "active";
    const option = popup.firstElementChild;
    for (let count = 0; count < 20; count++) { select.value = "active"; select.selectedIndex = 1; select.disabled = false; }
    expect(popup.firstElementChild).toBe(option);
  });
  it("settles with the actual shell observer and project-section synchronization", async () => {
    const win = new Window({ url: "https://rendro.test/organizations/org-a/projects/project-a", settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    windows.push(win);
    const html = renderControlPlanePage({ user: { id: "a", name: "QA", email: "qa@example.test" } as User, organizationId: "org-a", title: "Project", heading: "Project", eyebrow: "QA", description: "QA", content: '<nav class="project-tabs"><a class="active" href="/organizations/org-a/projects/project-a">Overview</a><a href="/organizations/org-a/projects/project-a/publications">Publications</a></nav>', script: "" });
    win.document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] || "";
    const component = installSelects(win.document as unknown as Document); cleanups.push(() => component.destroy());
    win.eval("window.RendroTheme={mount:()=>({apply(){}})}");
    const runtime = Array.from(win.document.querySelectorAll("script")).find((script) => script.textContent.includes("window.RendroUI={"))?.textContent;
    expect(runtime).toBeTruthy(); win.eval(runtime || "");
    await win.happyDOM.whenAsyncComplete();
    const popup = win.document.querySelector(".rd-select-popup"), option = popup?.firstElementChild;
    expect(win.document.querySelectorAll(".rd-select-trigger")).toHaveLength(1);
    for (let count = 0; count < 10; count++) win.eval("window.RendroUI.enhancePage()");
    await win.happyDOM.whenAsyncComplete();
    expect(popup?.firstElementChild).toBe(option);
    expect(win.document.querySelectorAll(".rd-select-popup")).toHaveLength(1);
  });
});
