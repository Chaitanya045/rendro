import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./shell-fixtures";
import type { Pool } from "./shell-fixtures";
import { desktop, mobile, shellReady } from "./shell-helpers";

const activeOption = (trigger: Locator) => trigger.evaluate(element => {
  const id = element.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent?.trim() ?? null : null;
});

async function injectProbe(page: Page, style = "") {
  await page.evaluate(css => {
    document.getElementById("probe-form")?.remove();
    const form = document.createElement("form");
    form.id = "probe-form";
    form.style.cssText = css || "padding:12px;display:grid;gap:12px;max-width:360px";
    form.innerHTML = `
      <label>Letters <select class="select" name="letters" id="s-letters">
        <option>Alpha</option><option disabled>Apple</option><option>Avocado</option><option hidden>Hidden</option><option>Banana</option><option>Apricot</option>
        <optgroup label="Locked" disabled><option>Lemon</option></optgroup><optgroup label="Open"><option>Olive</option></optgroup>
      </select></label>
      <label>Required <select class="select" name="req" required id="s-req"><option value="">Pick one</option><option value="a">Value A</option></select></label>
      <label>Multiple <select class="select" multiple id="s-multi"><option>One</option><option>Two</option></select></label>
      <label>Sized <select class="select" size="3" id="s-size"><option>One</option><option>Two</option><option>Three</option></select></label>
      <button type="submit">Submit probe</button><button type="reset">Reset probe</button>`;
    form.addEventListener("submit", event => event.preventDefault());
    document.querySelector(".cp-main")!.append(form);
  }, style);
  await expect(page.locator("#probe-form .rd-select-trigger")).toHaveCount(2);
}

async function modalSelect(page: Page, pooled: Pool, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`/organizations/${pooled.organizations[4].id}/api-keys`);
  await shellReady(page);
  const dialog = page.locator("#key-dialog");
  await page.locator(".cp-page-actions").getByRole("button", { name: "Create API key", exact: true }).click();
  await expect(dialog).toBeVisible();
  const trigger = dialog.getByRole("combobox", { name: "Expiration" });
  const native = dialog.locator("select[name=expiry]");
  await expect(trigger).toHaveText("90 days");
  await expect(native).toHaveJSProperty("value", "90");
  await page.evaluate(() => { (window as unknown as { changes: string[] }).changes = []; document.querySelector("select[name=expiry]")!.addEventListener("change", event => (window as unknown as { changes: string[] }).changes.push((event.target as HTMLSelectElement).value)); });

  // Enter opens with the selected option active; the popup is a child of the modal.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const listbox = dialog.getByRole("listbox", { name: "Expiration" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveText(["30 days", "90 days", "1 year", "Never"]);
  await expect(listbox.getByRole("option", { name: "90 days" })).toHaveAttribute("aria-selected", "true");
  expect(await activeOption(trigger)).toBe("90 days");
  // Layout height, not the animated bounding box, so the entry transition cannot skew it.
  if (viewport.width < 400) expect(await listbox.getByRole("option").first().evaluate(option => (option as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
  // Arrow, Home, End and Page keys move only the highlight.
  await page.keyboard.press("ArrowDown");
  expect(await activeOption(trigger)).toBe("1 year");
  await page.keyboard.press("End");
  expect(await activeOption(trigger)).toBe("Never");
  await page.keyboard.press("ArrowDown");
  expect(await activeOption(trigger)).toBe("Never");
  await page.keyboard.press("Home");
  expect(await activeOption(trigger)).toBe("30 days");
  await page.keyboard.press("PageDown");
  expect(await activeOption(trigger)).toBe("Never");
  await page.keyboard.press("PageUp");
  expect(await activeOption(trigger)).toBe("30 days");
  await expect(native).toHaveJSProperty("value", "90");
  // Escape cancels the pending choice and does not close the enclosing dialog.
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(listbox).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("90 days");
  await expect(native).toHaveJSProperty("value", "90");

  // Typeahead opens and highlights; Enter commits and fires input/change once.
  await page.keyboard.press("n");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(await activeOption(trigger)).toBe("Never");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("Never");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(native).toHaveJSProperty("value", "");
  expect(await page.evaluate(() => (window as unknown as { changes: string[] }).changes)).toEqual([""]);
  await expect(trigger).toBeFocused();
  // Space opens; Tab commits the active option and moves on without trapping focus.
  await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowUp");
  expect(await activeOption(trigger)).toBe("1 year");
  await page.keyboard.press("Tab");
  await expect(trigger).toHaveText("1 year");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).not.toBeFocused();
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { changes: string[] }).changes)).toEqual(["", "365"]);
  // Alt+ArrowDown opens, Alt+ArrowUp commits the active option.
  await trigger.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(trigger).toHaveText("90 days");

  // Pointer: open, choose; open and click outside leaves the value unchanged.
  await trigger.click();
  await listbox.getByRole("option", { name: "30 days" }).click();
  await expect(trigger).toHaveText("30 days");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await dialog.getByRole("heading", { name: "Create API key" }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveText("30 days");
}

test.describe("custom selects in a management dialog", () => {
  test("select keyboard, typeahead, Tab commit and Escape work inside a modal at 1440px", async ({ page, pooled }) => {
    await modalSelect(page, pooled, desktop);
  });

  test("select keyboard, typeahead, Tab commit and Escape work inside a modal at 375px", async ({ page, pooled }) => {
    await modalSelect(page, pooled, mobile);
  });
});

test.describe("select behavior on a management page", () => {
  test.use({ viewport: desktop });

  test("disabled options and groups are skipped, repeated letters cycle and native controls stay native", async ({ page, pooled }) => {
    await page.clock.install();
    await page.goto(`/organizations/${pooled.organizations[4].id}/settings`);
    await shellReady(page);
    await injectProbe(page);
    const trigger = page.locator("#probe-form").getByRole("combobox", { name: "Letters" });
    await expect(trigger).toHaveText("Alpha");
    // Native multiple and listbox-size controls are never replaced.
    await expect(page.locator("#s-multi")).not.toHaveAttribute("data-rd-select", "true");
    await expect(page.locator("#s-size")).not.toHaveAttribute("data-rd-select", "true");
    await expect(page.locator("#probe-form .rd-select-trigger")).toHaveCount(2);

    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const options = page.locator("#probe-form ~ .rd-select-popup, .rd-select-popup").locator("[role=option]");
    const listbox = page.getByRole("listbox", { name: "Letters" });
    await expect(listbox.getByRole("option", { name: "Apple" })).toHaveAttribute("aria-disabled", "true");
    await expect(listbox.getByRole("option", { name: "Lemon" })).toHaveAttribute("aria-disabled", "true");
    await expect(listbox.locator(".rd-select-group")).toHaveText(["Locked", "Open"]);
    await expect(listbox.locator("[role=option][hidden]")).toHaveCount(1);
    expect(await options.count()).toBeGreaterThan(0);
    // Selected option is Alpha; disabled "Apple" and hidden items are skipped.
    await page.keyboard.press("ArrowDown");
    expect(await activeOption(trigger)).toBe("Avocado");
    await page.keyboard.press("ArrowDown");
    expect(await activeOption(trigger)).toBe("Banana");
    await page.keyboard.press("End");
    expect(await activeOption(trigger)).toBe("Olive");
    await page.keyboard.press("Home");
    expect(await activeOption(trigger)).toBe("Alpha");
    // Repeated letters cycle through the matching enabled options.
    await page.keyboard.press("a");
    expect(await activeOption(trigger)).toBe("Avocado");
    await page.keyboard.press("a");
    expect(await activeOption(trigger)).toBe("Apricot");
    await page.keyboard.press("a");
    expect(await activeOption(trigger)).toBe("Alpha");
    // A longer prefix inside the window narrows instead of cycling.
    await page.keyboard.press("Escape");
    // Let the 700ms typeahead window lapse on the page clock, not the wall clock.
    await page.clock.fastForward(800);
    await page.keyboard.type("apr", { delay: 20 });
    expect(await activeOption(trigger)).toBe("Apricot");
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveText("Apricot");
    // A disabled option can never be committed.
    await trigger.click();
    await page.evaluate(() => (document.querySelector('[role=option][aria-disabled=true]') as HTMLElement).click());
    await expect(trigger).toHaveText("Apricot");
    // Only one popup is open at a time.
    const second = page.locator("#probe-form").getByRole("combobox", { name: "Required" });
    await second.click();
    await expect(second).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('.rd-select-trigger[aria-expanded="true"]')).toHaveCount(1);
  });

  test("select reflects programmatic changes, async options, reset, validation and removal", async ({ page, pooled }) => {
    await page.goto(`/organizations/${pooled.organizations[4].id}/settings`);
    await shellReady(page);
    const baseline = await page.locator(".rd-select-popup").count();
    await injectProbe(page);
    expect(await page.locator(".rd-select-popup").count()).toBe(baseline + 2);
    const letters = page.locator("#probe-form").getByRole("combobox", { name: "Letters" });
    const required = page.locator("#probe-form").getByRole("combobox", { name: "Required" });
    // Property writes by existing controllers.
    await page.evaluate(() => { (document.getElementById("s-letters") as HTMLSelectElement).value = "Banana"; });
    await expect(letters).toHaveText("Banana");
    await page.evaluate(() => { (document.getElementById("s-letters") as HTMLSelectElement).selectedIndex = 2; });
    await expect(letters).toHaveText("Avocado");
    await page.evaluate(() => { (document.getElementById("s-letters") as HTMLSelectElement).disabled = true; });
    await expect(letters).toBeDisabled();
    await page.evaluate(() => { (document.getElementById("s-letters") as HTMLSelectElement).disabled = false; });
    await expect(letters).toBeEnabled();
    // Unchanged writes cause no observer churn on the trigger.
    const churn = await page.evaluate(async () => {
      const select = document.getElementById("s-letters") as HTMLSelectElement;
      const trigger = select.nextElementSibling as HTMLElement;
      let records = 0;
      const observer = new MutationObserver(list => { records += list.length; });
      observer.observe(trigger, { attributes: true, childList: true, subtree: true, characterData: true });
      for (let index = 0; index < 200; index++) {
        const [value, selectedIndex, disabled] = [select.value, select.selectedIndex, select.disabled];
        select.value = value; select.selectedIndex = selectedIndex; select.disabled = disabled;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      observer.disconnect();
      return records;
    });
    expect(churn).toBe(0);
    // Async options appear in the popup.
    await page.evaluate(() => { const option = document.createElement("option"); option.textContent = "Zucchini"; document.getElementById("s-letters")!.append(option); });
    await letters.click();
    await expect(page.getByRole("listbox", { name: "Letters" }).getByRole("option", { name: "Zucchini" })).toBeVisible();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(letters).toHaveText("Zucchini");
    // Controllers reset forms programmatically; the trigger follows the restored default.
    await page.evaluate(() => (document.getElementById("probe-form") as HTMLFormElement).reset());
    await expect(letters).toHaveText("Alpha");
    // Required validation is routed to the visible trigger and announced.
    await page.getByRole("button", { name: "Submit probe" }).click();
    await expect(required).toBeFocused();
    await expect(required).toHaveAttribute("aria-invalid", "true");
    await expect(required).toHaveAttribute("aria-required", "true");
    const message = required.locator("xpath=following-sibling::*[1]");
    await expect(message).toHaveAttribute("role", "alert");
    await expect(message).toBeVisible();
    await expect(message).not.toBeEmpty();
    await required.click();
    await page.getByRole("listbox", { name: "Required" }).getByRole("option", { name: "Value A" }).click();
    await expect(required).not.toHaveAttribute("aria-invalid", "true");
    await expect(message).toBeHidden();
    // Removing the controls disposes their triggers and popups cleanly; reinsertion enhances again.
    await page.evaluate(() => { (window as unknown as { saved: Element }).saved = document.getElementById("probe-form")!; document.getElementById("probe-form")!.remove(); });
    await expect.poll(() => page.locator(".rd-select-popup").count()).toBe(baseline);
    await page.evaluate(() => document.querySelector(".cp-main")!.append((window as unknown as { saved: Element }).saved));
    await expect(page.locator("#probe-form .rd-select-trigger")).toHaveCount(2);
  });

  // Product bug (reported with this slice): the reset listener schedules its refresh in a microtask,
  // which runs before the browser restores the control when the user activates a Reset button.
  // Programmatic form.reset() (used by every current controller) refreshes correctly, tested above.
  test.fail("enhanced select follows a user-activated native Reset button (known bug)", async ({ page, pooled }) => {
    await page.goto(`/organizations/${pooled.organizations[4].id}/settings`);
    await shellReady(page);
    await page.evaluate(() => {
      const form = document.createElement("form");
      form.id = "reset-probe";
      form.innerHTML = '<label>Choice <select class="select" id="reset-select"><option>Alpha</option><option>Beta</option></select></label><button type="reset">Reset probe</button>';
      document.querySelector(".cp-main")!.append(form);
    });
    const trigger = page.locator("#reset-probe .rd-select-trigger");
    await trigger.click();
    await page.getByRole("listbox", { name: "Choice" }).getByRole("option", { name: "Beta" }).click();
    await expect(trigger).toHaveText("Beta");
    await page.getByRole("button", { name: "Reset probe" }).click();
    await expect(page.locator("#reset-select")).toHaveValue("Alpha");
    await expect(trigger).toHaveText("Alpha", { timeout: 3000 });
  });

  test("select popup flips near the viewport edge, clamps to the right edge and repositions on resize", async ({ page, pooled }) => {
    await page.goto(`/organizations/${pooled.organizations[4].id}/settings`);
    await shellReady(page);
    await injectProbe(page, "position:fixed;top:calc(100vh - 70px);right:0;width:140px;padding:0;display:grid;gap:0;z-index:5;background:white");
    const trigger = page.locator("#probe-form").getByRole("combobox", { name: "Letters" });
    await trigger.click();
    const popup = page.getByRole("listbox", { name: "Letters" });
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute("data-side", "top");
    const check = async () => {
      const t = (await trigger.boundingBox())!;
      const p = (await popup.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(p.y + p.height).toBeLessThanOrEqual(t.y + 1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeGreaterThanOrEqual(8 - 1);
      expect(p.x + p.width).toBeLessThanOrEqual(viewport.width - 8 + 1);
      expect(p.width).toBeGreaterThanOrEqual(155);
    };
    await check();
    await page.setViewportSize({ width: 700, height: 500 });
    await expect(popup).toBeVisible();
    await check();
  });

  test("select popup closes on outside pointer, scroll, blur, dialog close, route leave and sign-out", async ({ page, pooled }) => {
    const base = `/organizations/${pooled.organizations[4].id}`;
    await page.goto(`${base}/settings`);
    await shellReady(page);
    await injectProbe(page);
    await page.evaluate(() => { const spacer = document.createElement("div"); spacer.id = "probe-spacer"; spacer.style.height = "2400px"; document.querySelector(".cp-main")!.append(spacer); });
    const trigger = page.locator("#probe-form").getByRole("combobox", { name: "Letters" });
    const expanded = () => expect(trigger).toHaveAttribute("aria-expanded", "true");
    const collapsed = () => expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click(); await expanded();
    await page.mouse.click(700, 500); await collapsed();
    await expect(trigger).toHaveText("Alpha");
    await trigger.click(); await expanded();
    await page.mouse.wheel(0, 300); await collapsed();
    await trigger.click(); await expanded();
    await page.locator("#probe-form").getByRole("button", { name: "Submit probe" }).focus(); await collapsed();
    await trigger.click(); await expanded();
    await page.locator(".cp-nav").getByRole("link", { name: "Teams", exact: true }).evaluate((link: HTMLElement) => link.click());
    await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
    // Sign-out event closes an open popup.
    await injectProbe(page);
    // Smooth wheel scrolling keeps emitting scroll events after the first one; wait until the offset has
    // stopped changing for several frames so a late event cannot close the popup under test.
    await page.evaluate(() => { document.getElementById("probe-spacer")?.remove(); window.scrollTo(0, 0); });
    await page.evaluate(() => new Promise<void>(resolve => {
      let last = -1, stable = 0;
      const frame = () => {
        if (window.scrollY === last) stable++; else { stable = 0; last = window.scrollY; }
        if (stable >= 5) resolve(); else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const again = page.locator("#probe-form").getByRole("combobox", { name: "Letters" });
    await again.click();
    await expect(again).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() => window.dispatchEvent(new Event("commentor-sign-out")));
    await expect(page.locator('.rd-select-trigger[aria-expanded="true"]')).toHaveCount(0);
    await expect(page.locator(".rd-select-popup:not([hidden])")).toHaveCount(0);
    // Closing the owning dialog closes the popup.
    await page.goto(`${base}/api-keys`);
    await shellReady(page);
    await page.locator(".cp-page-actions").getByRole("button", { name: "Create API key", exact: true }).click();
    const expiry = page.locator('#key-dialog button.rd-select-trigger[aria-label="Expiration"]');
    await expiry.click();
    await expect(expiry).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() => (document.getElementById("key-dialog") as HTMLDialogElement).close());
    await expect(expiry).toHaveAttribute("aria-expanded", "false");
  });
});
