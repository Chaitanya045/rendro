import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { desktop, mobile } from "./shell-helpers";

/** The shared field and button states, on the auth forms that carry them (#286: they were proved on a management dialog). */
const background = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).backgroundColor);

async function controlStates(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto("/sign-up");
  const mobileTargets = viewport.width <= 760;
  // Icon-only and form controls reach the documented sizes: 36px icon buttons, 44px targets on a phone and for fields and buttons.
  const theme = (await page.locator(".rendro-theme-control").first().boundingBox())!;
  expect(Math.round(theme.width)).toBe(mobileTargets ? 44 : 36);
  expect(Math.round(theme.height)).toBe(mobileTargets ? 44 : 36);
  const form = page.locator("#auth-form");
  const submit = form.getByRole("button", { name: "Create account", exact: true });
  const name = form.getByLabel("Full name", { exact: true });
  for (const control of [submit, name]) {
    const height = Math.round((await control.boundingBox())!.height);
    expect(height).toBeGreaterThanOrEqual(44);
    expect(height).toBeLessThanOrEqual(48);
  }

  // Hover changes the surface; keyboard focus shows a visible ring; required fields are announced.
  expect(await name.evaluate(input => (input as HTMLInputElement).required)).toBe(true);
  const idle = await background(submit);
  await submit.hover();
  await expect.poll(() => background(submit)).not.toBe(idle);
  await name.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(name).toBeFocused();
  await expect.poll(() => name.evaluate(input => getComputedStyle(input).boxShadow)).not.toBe("none");

  // An invalid submission is held, focuses the field and exposes it as invalid in the announced error region.
  await submit.click();
  await expect(name).toBeFocused();
  expect(await name.evaluate(input => (input as HTMLInputElement).validity.valueMissing)).toBe(true);
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(form.locator("#form-error")).toHaveAttribute("role", "alert");
  await expect(form.locator("#form-error")).not.toBeEmpty();

  // Long values and the browser's validation text stay inside the card.
  await name.fill("A".repeat(80));
  await form.getByLabel("Work email", { exact: true }).fill("not-an-email");
  await submit.click();
  await expect(form.locator("#form-error")).toContainText("valid email");
  const card = page.locator(".card").first();
  const box = (await card.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const escaping = await card.evaluate(element => {
    const edge = element.getBoundingClientRect().right;
    return [...element.querySelectorAll("*")].filter(child => child.getBoundingClientRect().right > edge + 0.5).map(child => `${child.tagName}.${child.className}`);
  });
  expect(escaping).toEqual([]);
}

test.describe("shared control states", () => {
  test("controls expose hover, focus, invalid states and target sizes at 1440", async ({ page }) => {
    await controlStates(page, desktop);
  });

  test("controls expose hover, focus, invalid states and target sizes at 375", async ({ page }) => {
    await controlStates(page, mobile);
  });
});
