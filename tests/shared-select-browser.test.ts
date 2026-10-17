import type { Page } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import { selectStyles } from "@/ui/select-styles";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
const labels = ["Alpha", "Alpine", "Beta", "Gamma", "Delta"];
const longOptions = Array.from({ length: 40 }, (_, index) => `<option>Item ${index}</option>`).join("");
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--cp-surface:#fff;--cp-strong:#111;--cp-border:#999;--cp-container:#ddd;--cp-muted:#555;--cp-danger:#b00}
body{margin:0;font:14px system-ui}.select{width:240px;height:40px;box-sizing:border-box}
#bottom-wrap{position:fixed;left:16px;bottom:8px}${selectStyles}</style></head><body>
<form id="form">
<label>Release mode <small>(required)</small><select class="select" id="mode" name="mode" required aria-describedby="mode-help">
<option value="">Choose a mode</option><option>Alpha</option><option>Alpine</option><option>Beta</option><option disabled>Gamma</option><option>Delta</option></select></label>
<p id="mode-help">Pick how releases are tracked.</p>
<span id="grouped-first">Grouped</span> <span id="grouped-second">choice</span>
<select class="select" id="grouped" aria-labelledby="grouped-first grouped-second">
<optgroup label="Team"><option>Ann</option><option>Bo</option></optgroup>
<optgroup label="Locked" disabled><option>Locked one</option></optgroup><option></option></select>
<label>Fallback name <select class="select" id="dangling" aria-labelledby="missing-id also-missing"><option>X</option></select></label>
<select class="select" id="named" aria-label="Named choice" tabindex="5" aria-hidden="false"><option>One</option><option>Two</option></select>
<select class="select" id="locked" aria-label="Nothing allowed"><option disabled>No</option><option disabled>Way</option></select>
<select class="select" id="empty" aria-label="Empty"></select>
<select class="select" id="long" aria-label="Long list">${longOptions}</select>
<select class="select" id="off" aria-label="Disabled" disabled><option>Off</option></select>
<button type="reset" id="reset">Reset</button><button type="submit" id="submit">Submit</button>
</form>
<dialog id="dialog"><select class="select" id="modal" aria-label="In dialog"><option>First</option><option>Second</option></select><button id="dialog-close">Close</button></dialog>
<div id="bottom-wrap"><select class="select" id="bottom" aria-label="Bottom"><option>A</option><option>B</option><option>C</option><option>D</option><option>E</option><option>F</option></select></div>
<div style="height:1600px"></div>
<script>
window.changes = [];
for (const select of document.querySelectorAll("select")) {
  select.addEventListener("change", () => changes.push(select.id + "=" + select.value));
}
document.getElementById("form").addEventListener("submit", event => { event.preventDefault(); document.body.dataset.submitted = "true"; });
</script><script src="/select.js"></script></body></html>`;

beforeAll(async () => {
  const assets = new Map([["/select.js", await bundleBrowserAsset("src/ui/select-browser.ts")]]);
  await harness.start((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(page); }, assets);
});

async function open() {
  const tab = await harness.newPage({ viewport: { width: 800, height: 500 } });
  // Typeahead and its buffer timeout read the page clock: freeze it so only explicit advances reset the buffer.
  await tab.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await browserStep("load select fixture", () => tab.goto(harness.origin));
  await tab.locator(".rd-select-trigger").first().waitFor();
  return tab;
}
const trigger = (tab: Page, id: string) => tab.locator(`#${id} + .rd-select-trigger`);
const popup = (tab: Page, id: string) => tab.locator(`.rd-select-popup[aria-label="${id}"]`);
async function state(tab: Page, id: string) {
  return tab.evaluate(selectId => {
    const select = document.getElementById(selectId) as HTMLSelectElement;
    const button = select.nextElementSibling as HTMLButtonElement;
    const list = document.getElementById(button.getAttribute("aria-controls")!)!;
    const active = list.querySelector<HTMLElement>('[data-active="true"]');
    return {
      value: select.value, text: button.textContent, expanded: button.getAttribute("aria-expanded"), hidden: list.hidden,
      activeText: active?.textContent ?? null, activeId: button.getAttribute("aria-activedescendant"), activeElementId: active?.id ?? null,
      focused: document.activeElement === button, scrollTop: list.scrollTop, side: (list as HTMLElement).dataset.side ?? null,
    };
  }, id);
}

describe("shared select in Chromium", () => {
  it("names the combobox from labels, ignoring hints, and exposes groups and native attributes", async () => {
    const tab = await open();
    expect(await trigger(tab, "mode").getAttribute("aria-label")).toBe("Release mode");
    expect(await trigger(tab, "mode").getAttribute("aria-describedby")).toBe("mode-help");
    expect(await trigger(tab, "mode").getAttribute("aria-required")).toBe("true");
    expect(await trigger(tab, "grouped").getAttribute("aria-label")).toBe("Grouped choice");
    expect(await trigger(tab, "named").getAttribute("aria-label")).toBe("Named choice");
    // References to missing elements are ignored, so the native label still names it.
    expect(await trigger(tab, "dangling").getAttribute("aria-label")).toBe("Fallback name");
    await trigger(tab, "grouped").click();
    const list = popup(tab, "Grouped choice");
    expect(await list.locator(".rd-select-group").allTextContents()).toEqual(["Team", "Locked"]);
    expect(await list.locator(".rd-select-group").first().getAttribute("role")).toBe("presentation");
    expect(await list.locator('[role="option"]').evaluateAll(items => items.map(item => [item.textContent, item.getAttribute("aria-disabled")])))
      .toEqual([["Ann", "false"], ["Bo", "false"], ["Locked one", "true"], ["", "false"]]);
    // Native hints set after enhancement are mirrored by the shell's observer.
    await tab.evaluate(() => {
      const select = document.getElementById("named")!;
      select.setAttribute("aria-describedby", "mode-help"); select.setAttribute("aria-invalid", "true");
    });
    await tab.waitForFunction(() => document.querySelector("#named + .rd-select-trigger")!.getAttribute("aria-invalid") === "true");
    expect(await trigger(tab, "named").getAttribute("aria-describedby")).toBe("mode-help");
    await tab.evaluate(() => document.getElementById("named")!.removeAttribute("aria-describedby"));
    await tab.waitForFunction(() => !document.querySelector("#named + .rd-select-trigger")!.hasAttribute("aria-describedby"));
  });

  it.each(["ArrowDown", "Enter", "Space"])("opens with %s on the selected option and keeps the native value until commit", async key => {
    const tab = await open();
    await trigger(tab, "mode").focus();
    await tab.keyboard.press(key === "Space" ? " " : key);
    expect(await state(tab, "mode")).toMatchObject({ expanded: "true", hidden: false, value: "", activeText: "Choose a mode" });
    expect(await state(tab, "mode")).toMatchObject({ activeId: expect.stringContaining("-option-0") });
    await tab.keyboard.press("ArrowDown");
    expect(await state(tab, "mode")).toMatchObject({ activeText: "Alpha", value: "", text: "Choose a mode" });
  });

  it("navigates with arrows, Home/End and page keys, skipping disabled options, then commits with Enter", async () => {
    const tab = await open();
    const events = () => tab.evaluate(() => (window as unknown as { changes: string[] }).changes);
    await trigger(tab, "mode").focus();
    await tab.keyboard.press("ArrowDown");
    await tab.keyboard.press("ArrowDown"); await tab.keyboard.press("ArrowDown");
    expect((await state(tab, "mode")).activeText).toBe("Alpine");
    await tab.keyboard.press("ArrowDown"); await tab.keyboard.press("ArrowDown");
    expect((await state(tab, "mode")).activeText).toBe("Delta");
    await tab.keyboard.press("ArrowUp");
    expect((await state(tab, "mode")).activeText).toBe("Beta");
    await tab.keyboard.press("End"); expect((await state(tab, "mode")).activeText).toBe("Delta");
    await tab.keyboard.press("Home"); expect((await state(tab, "mode")).activeText).toBe("Choose a mode");
    await tab.keyboard.press("PageDown"); expect((await state(tab, "mode")).activeText).toBe("Delta");
    await tab.keyboard.press("PageUp"); expect((await state(tab, "mode")).activeText).toBe("Choose a mode");
    await tab.keyboard.press("End");
    await tab.keyboard.press("Enter");
    expect(await state(tab, "mode")).toMatchObject({ value: "Delta", text: "Delta", expanded: "false", hidden: true, focused: true, activeId: null });
    expect(await events()).toEqual(["mode=Delta"]);
    // Re-selecting the current value closes without another change event.
    await tab.keyboard.press("Enter"); await tab.keyboard.press("Enter");
    expect(await events()).toEqual(["mode=Delta"]);
  });

  it("supports Alt+Arrow disclosure, Escape, Tab commit and ignores Ctrl/Meta shortcuts", async () => {
    const tab = await open();
    await trigger(tab, "mode").focus();
    await tab.keyboard.press("Control+ArrowDown"); await tab.keyboard.press("Meta+Enter");
    expect((await state(tab, "mode")).expanded).toBe("false");
    await tab.keyboard.press("Alt+ArrowDown");
    expect(await state(tab, "mode")).toMatchObject({ expanded: "true", value: "" });
    await tab.keyboard.press("Alt+ArrowDown");
    expect(await state(tab, "mode")).toMatchObject({ expanded: "true", value: "" });
    await tab.keyboard.press("ArrowDown"); await tab.keyboard.press("ArrowDown");
    await tab.keyboard.press("Alt+ArrowUp");
    expect(await state(tab, "mode")).toMatchObject({ expanded: "false", value: "Alpine", focused: true });
    // Alt+ArrowUp on a closed control only opens it, without committing.
    await tab.keyboard.press("Alt+ArrowUp");
    expect(await state(tab, "mode")).toMatchObject({ expanded: "true", value: "Alpine" });
    await tab.keyboard.press("ArrowDown");
    await tab.keyboard.press("Escape");
    expect(await state(tab, "mode")).toMatchObject({ expanded: "false", value: "Alpine", focused: true });
    await tab.keyboard.press("ArrowDown"); await tab.keyboard.press("ArrowDown"); await tab.keyboard.press("ArrowDown");
    await tab.keyboard.press("Tab");
    expect(await state(tab, "mode")).toMatchObject({ expanded: "false", value: "Delta", focused: false });
    // Tab while closed leaves focus handling to the browser.
    await trigger(tab, "named").focus(); await tab.keyboard.press("Tab");
    expect((await state(tab, "named")).expanded).toBe("false");
  });

  it("matches typeahead by prefix, cycles repeated letters and resets after the buffer expires", async () => {
    const tab = await open();
    await trigger(tab, "mode").focus();
    await tab.keyboard.press("a");
    expect(await state(tab, "mode")).toMatchObject({ expanded: "true", activeText: "Alpha" });
    await tab.keyboard.press("l"); await tab.keyboard.press("p"); await tab.keyboard.press("i");
    expect((await state(tab, "mode")).activeText).toBe("Alpine");
    await tab.keyboard.press("z");
    expect((await state(tab, "mode")).activeText).toBe("Alpine");
    await tab.clock.fastForward(800);
    await tab.keyboard.press("b");
    expect((await state(tab, "mode")).activeText).toBe("Beta");
    await tab.clock.fastForward(800);
    await tab.keyboard.press("a"); await tab.keyboard.press("a");
    expect((await state(tab, "mode")).activeText).toBe("Alpine");
    await tab.keyboard.press("a");
    expect((await state(tab, "mode")).activeText).toBe("Alpha");
    await tab.keyboard.press("Enter");
    expect((await state(tab, "mode")).value).toBe("Alpha");
    expect(labels).toContain("Alpha");
  });

  it("ignores keyboard input on a disabled control and refuses to open unusable lists", async () => {
    const tab = await open();
    await tab.evaluate(() => (document.querySelector("#off + .rd-select-trigger") as HTMLElement)
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(await state(tab, "off")).toMatchObject({ expanded: "false", hidden: true });
    expect(await trigger(tab, "off").isDisabled()).toBe(true);
    await trigger(tab, "empty").click();
    expect(await state(tab, "empty")).toMatchObject({ expanded: "false", text: "Choose an option" });
    // Opening a list whose options are all disabled has no active option and cannot commit.
    const unchanged = (await state(tab, "locked")).value;
    await trigger(tab, "locked").focus();
    await tab.keyboard.press("ArrowDown");
    expect(await state(tab, "locked")).toMatchObject({ expanded: "true", activeText: null, activeId: null });
    await tab.keyboard.press("ArrowDown"); await tab.keyboard.press("Home"); await tab.keyboard.press("End");
    await tab.keyboard.press("Enter");
    expect(await state(tab, "locked")).toMatchObject({ expanded: "true", value: unchanged, activeText: null });
    await tab.keyboard.press("n");
    expect((await state(tab, "locked")).activeText).toBeNull();
    await tab.keyboard.press("Escape");
    expect((await state(tab, "locked")).expanded).toBe("false");
  });

  it("highlights on pointer movement, ignores disabled options and commits a click once", async () => {
    const tab = await open();
    await trigger(tab, "mode").click();
    const list = popup(tab, "Release mode");
    await list.getByRole("option", { name: "Beta" }).hover();
    expect((await state(tab, "mode")).activeText).toBe("Beta");
    // Disabled rows do not highlight or commit even if a click reaches them.
    await tab.evaluate(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(item => item.textContent === "Gamma")!;
      row.dispatchEvent(new PointerEvent("pointermove", { bubbles: true })); row.click();
    });
    expect(await state(tab, "mode")).toMatchObject({ activeText: "Beta", expanded: "true", value: "" });
    await tab.evaluate(() => { (window as unknown as { changes: string[] }).changes.length = 0; });
    await list.getByRole("option", { name: "Delta" }).click();
    expect(await state(tab, "mode")).toMatchObject({ value: "Delta", text: "Delta", expanded: "false", focused: true });
    expect(await tab.evaluate(() => (window as unknown as { changes: string[] }).changes)).toEqual(["mode=Delta"]);
    // Clicking the trigger toggles; opening a second select closes the first.
    await trigger(tab, "mode").click(); expect((await state(tab, "mode")).expanded).toBe("true");
    await trigger(tab, "mode").click(); expect((await state(tab, "mode")).expanded).toBe("false");
    await trigger(tab, "mode").click();
    // The open list overlaps later controls, so activate the second trigger without a pointer hit-test or blur.
    await tab.evaluate(() => document.querySelector<HTMLElement>("#named + .rd-select-trigger")!.click());
    expect(await state(tab, "mode")).toMatchObject({ expanded: "false", hidden: true });
    expect((await state(tab, "named")).expanded).toBe("true");
  });

  it("closes on outside press, page scroll, sign-out and route leave but not on scrolling its own list", async () => {
    const tab = await open();
    const reopen = async () => { await trigger(tab, "long").click(); expect((await state(tab, "long")).expanded).toBe("true"); };
    await reopen();
    // Scrolling the list itself (including by keyboard) keeps it open and keeps the active option visible.
    for (let index = 0; index < 20; index++) await tab.keyboard.press("ArrowDown");
    expect((await state(tab, "long")).scrollTop).toBeGreaterThan(0);
    const scrolled = (await state(tab, "long")).scrollTop;
    await tab.evaluate(() => document.querySelector<HTMLElement>('.rd-select-popup[aria-label="Long list"]')!.dispatchEvent(new Event("scroll")));
    expect((await state(tab, "long")).expanded).toBe("true");
    for (let index = 0; index < 20; index++) await tab.keyboard.press("ArrowUp");
    expect((await state(tab, "long")).scrollTop).toBeLessThan(scrolled);
    await tab.evaluate(() => window.scrollTo(0, 120));
    await tab.waitForFunction(() => document.querySelector("#long + .rd-select-trigger")!.getAttribute("aria-expanded") === "false");
    await tab.evaluate(() => window.scrollTo(0, 0));
    await reopen();
    await tab.mouse.click(780, 480);
    expect((await state(tab, "long")).expanded).toBe("false");
    await reopen();
    await tab.evaluate(() => window.dispatchEvent(new Event("commentor-sign-out")));
    expect((await state(tab, "long")).expanded).toBe("false");
    await reopen();
    await tab.evaluate(() => document.dispatchEvent(new Event("rendro:before-route-leave")));
    expect((await state(tab, "long")).expanded).toBe("false");
  });

  it("keeps the list open for scroll events that leave the trigger where the popup was placed", async () => {
    const tab = await open();
    // A scroll applied just before the open (as Playwright's scroll-into-view does) still emits its event a frame later.
    await tab.evaluate(() => {
      const arrived = new Promise<void>(resolve => window.addEventListener("scroll", () => resolve(), { once: true }));
      window.scrollTo(0, 60);
      document.querySelector<HTMLElement>("#long + .rd-select-trigger")!.click();
      (window as unknown as { lateScroll: Promise<void> }).lateScroll = arrived;
    });
    expect((await state(tab, "long")).expanded).toBe("true");
    await tab.evaluate(() => (window as unknown as { lateScroll: Promise<void> }).lateScroll);
    expect(await state(tab, "long")).toMatchObject({ expanded: "true", hidden: false });
    // A real page scroll that does not move a fixed trigger leaves it open and in place.
    await trigger(tab, "bottom").click();
    expect((await state(tab, "bottom")).expanded).toBe("true");
    await tab.evaluate(() => {
      const arrived = new Promise<void>(resolve => window.addEventListener("scroll", () => resolve(), { once: true }));
      window.scrollTo(0, 400);
      return arrived;
    });
    expect(await state(tab, "bottom")).toMatchObject({ expanded: "true", side: "top" });
    // Moving the trigger sideways, or off its anchor at all, still dismisses on the next scroll event.
    await tab.evaluate(() => { document.querySelector<HTMLElement>("#bottom-wrap")!.style.left = "40px"; document.dispatchEvent(new Event("scroll")); });
    expect((await state(tab, "bottom")).expanded).toBe("false");
    await tab.evaluate(() => window.scrollTo(0, 0));
    await trigger(tab, "long").click();
    expect((await state(tab, "long")).expanded).toBe("true");
    await tab.evaluate(() => { document.querySelector<HTMLElement>("#long + .rd-select-trigger")!.style.marginTop = "7px"; document.dispatchEvent(new Event("scroll")); });
    expect((await state(tab, "long")).expanded).toBe("false");
  });

  it("keeps the list inside the viewport: upward near the bottom, repositioned on resize", async () => {
    const tab = await open();
    await trigger(tab, "bottom").click();
    expect(await state(tab, "bottom")).toMatchObject({ expanded: "true", side: "top" });
    const geometry = () => tab.evaluate(() => {
      const list = document.querySelector<HTMLElement>('.rd-select-popup[aria-label="Bottom"]')!.getBoundingClientRect();
      const button = document.querySelector("#bottom + .rd-select-trigger")!.getBoundingClientRect();
      return { listBottom: list.bottom, buttonTop: button.top, listRight: list.right, width: list.width, viewport: innerWidth };
    });
    const before = await geometry();
    expect(before.listBottom).toBeLessThanOrEqual(before.buttonTop);
    await tab.setViewportSize({ width: 300, height: 500 });
    await tab.waitForFunction(() => document.querySelector<HTMLElement>('.rd-select-popup[aria-label="Bottom"]')!.getBoundingClientRect().right <= innerWidth - 8);
    expect((await geometry()).listRight).toBeLessThanOrEqual(292);
    await trigger(tab, "bottom").press("Escape");
    await trigger(tab, "mode").click();
    expect(await state(tab, "mode")).toMatchObject({ side: "bottom" });
  });

  it("re-synchronizes an open list when options change underneath it", async () => {
    const tab = await open();
    await trigger(tab, "long").focus();
    await tab.keyboard.press("End");
    await tab.keyboard.press("ArrowDown"); await tab.keyboard.press("End");
    expect((await state(tab, "long")).activeText).toBe("Item 39");
    await tab.evaluate(() => { const select = document.getElementById("long") as HTMLSelectElement; while (select.options.length > 5) select.remove(5); });
    await tab.waitForFunction(() => document.querySelectorAll('.rd-select-popup[aria-label="Long list"] [role="option"]').length === 5);
    expect((await state(tab, "long")).value).toBe("Item 0");
    expect((await state(tab, "long")).activeText).toBe("Item 0");
    await tab.evaluate(() => { const select = document.getElementById("long") as HTMLSelectElement; select.add(new Option("Late arrival")); });
    await tab.waitForFunction(() => document.querySelectorAll('.rd-select-popup[aria-label="Long list"] [role="option"]').length === 6);
    expect((await state(tab, "long")).expanded).toBe("true");
    await tab.evaluate(() => { const select = document.getElementById("long") as HTMLSelectElement; select.disabled = true; });
    await tab.waitForFunction(() => document.querySelector('#long + .rd-select-trigger')!.getAttribute("aria-expanded") === "false");
    expect(await trigger(tab, "long").isDisabled()).toBe(true);
  });

  it("reports a required native select inline, then clears it on selection or reset", async () => {
    const tab = await open();
    await tab.locator("#submit").click();
    const error = tab.locator("#mode + .rd-select-trigger + .rd-select-validation");
    await error.waitFor({ state: "visible" });
    expect(await error.getAttribute("role")).toBe("alert");
    expect((await error.textContent())!.length).toBeGreaterThan(0);
    expect(await trigger(tab, "mode").getAttribute("aria-invalid")).toBe("true");
    expect(await trigger(tab, "mode").getAttribute("aria-describedby")).toBe(`mode-help ${await error.getAttribute("id")}`);
    expect(await tab.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
    expect((await state(tab, "mode")).focused).toBe(true);
    await trigger(tab, "mode").press("ArrowDown"); await trigger(tab, "mode").press("ArrowDown"); await trigger(tab, "mode").press("Enter");
    await error.waitFor({ state: "hidden" });
    expect(await trigger(tab, "mode").getAttribute("aria-invalid")).toBeNull();
    expect(await trigger(tab, "mode").getAttribute("aria-describedby")).toBe("mode-help");
    await tab.locator("#submit").click();
    await tab.waitForFunction(() => document.body.dataset.submitted === "true");
    // Reset restores the placeholder and hides a stale message.
    await tab.evaluate(() => { document.body.removeAttribute("data-submitted"); (document.getElementById("mode") as HTMLSelectElement).selectedIndex = 0; });
    await tab.locator("#submit").click();
    await error.waitFor({ state: "visible" });
    await tab.locator("#reset").click();
    await error.waitFor({ state: "hidden" });
    await tab.waitForFunction(() => document.querySelector("#mode + .rd-select-trigger .rd-select-value")!.textContent === "Choose a mode");
  });

  it("shows a default message when a valid select is reported invalid without one", async () => {
    const tab = await open();
    await tab.evaluate(() => document.getElementById("named")!.dispatchEvent(new Event("invalid", { cancelable: true })));
    const error = tab.locator("#named + .rd-select-trigger + .rd-select-validation");
    await error.waitFor({ state: "visible" });
    expect(await error.textContent()).toBe("Choose an option.");
    expect((await state(tab, "named")).focused).toBe(true);
    expect(await trigger(tab, "named").getAttribute("aria-invalid")).toBe("true");
  });

  it("focuses the trigger when the native select is focused and restores it when removed", async () => {
    const tab = await open();
    await tab.evaluate(() => (document.getElementById("named") as HTMLSelectElement).focus());
    expect((await state(tab, "named")).focused).toBe(true);
    await tab.evaluate(() => {
      const select = document.getElementById("named")!;
      (window as unknown as { detached: HTMLElement }).detached = select;
      select.remove();
    });
    await tab.waitForFunction(() => !document.querySelector('.rd-select-popup[aria-label="Named choice"]'));
    expect(await tab.evaluate(() => {
      const select = (window as unknown as { detached: HTMLElement }).detached;
      return { tabindex: select.getAttribute("tabindex"), hidden: select.getAttribute("aria-hidden"), enhanced: select.dataset.rdSelect ?? null, native: select.classList.contains("rd-select-native") };
    })).toEqual({ tabindex: "5", hidden: "false", enhanced: null, native: false });
    // A select with no original tabindex/aria-hidden gets them removed again.
    await tab.evaluate(() => {
      const select = document.getElementById("empty")!;
      (window as unknown as { detached: HTMLElement }).detached = select; select.remove();
    });
    await tab.waitForFunction(() => !document.querySelector('.rd-select-popup[aria-label="Empty"]'));
    expect(await tab.evaluate(() => {
      const select = (window as unknown as { detached: HTMLElement }).detached;
      return [select.hasAttribute("tabindex"), select.hasAttribute("aria-hidden")];
    })).toEqual([false, false]);
  });

  it("keeps Escape inside a modal select popup and leaves the dialog open", async () => {
    const tab = await open();
    await tab.evaluate(() => (document.getElementById("dialog") as HTMLDialogElement).showModal());
    expect(await tab.evaluate(() => document.querySelector(".rd-select-popup[aria-label='In dialog']")!.parentElement!.id)).toBe("dialog");
    await trigger(tab, "modal").focus();
    await tab.keyboard.press("ArrowDown"); await tab.keyboard.press("ArrowDown");
    expect((await state(tab, "modal")).expanded).toBe("true");
    await tab.keyboard.press("Escape");
    expect(await state(tab, "modal")).toMatchObject({ expanded: "false", value: "First", focused: true });
    expect(await tab.evaluate(() => (document.getElementById("dialog") as HTMLDialogElement).open)).toBe(true);
    await trigger(tab, "modal").click();
    await tab.evaluate(() => (document.getElementById("dialog") as HTMLDialogElement).close());
    await tab.waitForFunction(() => document.querySelector("#modal + .rd-select-trigger")!.getAttribute("aria-expanded") === "false");
    expect(await tab.evaluate(() => (document.getElementById("dialog") as HTMLDialogElement).open)).toBe(false);
  });
});
