import type { Page } from "@playwright/test";
import { test, expect } from "./shell-fixtures";
import type { Pool } from "./shell-fixtures";
import { clipboard, desktop, fakeClipboard, mobile, shellReady, signInSeeded } from "./shell-helpers";

test.describe("copy feedback", () => {
  test.use({ viewport: desktop });

  test("copy shows busy, Copied and then restores; repeats reset the timer and rejection recovers with guidance", async ({ page, context, baseURL, seed }) => {
    await fakeClipboard(page);
    await page.clock.install();
    await signInSeeded(context, baseURL, seed, "owner");
    // A new key's one-time secret has the shared copy control.
    await page.goto(`/organizations/${seed.organizationId}/api-keys`);
    await shellReady(page);
    await page.locator("#api-key-create").click();
    await page.locator('#key-form [name="name"]').fill(`Copy control ${Date.now().toString(36)}`);
    await page.locator('#key-form button[type="submit"]').click();
    await page.locator("#secret-dialog[open]").waitFor();
    const copy = page.locator("#copy-key");
    await expect(copy).toBeVisible();
    // From here the page clock only moves when the test advances it, so every window below is exact.
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await copy.click();
    await expect(copy).toHaveAttribute("aria-busy", "true");
    await expect(copy).toBeDisabled();
    await page.clock.runFor(250);
    await expect(copy).toHaveText("Copied");
    await expect(copy).not.toHaveAttribute("aria-busy", "true");
    expect((await clipboard(page)).at(-1)).toMatch(/^rnd_live_/);
    // A repeated copy during feedback restarts the 1.5s window instead of racing the first timer.
    await page.clock.runFor(1000);
    await copy.click();
    await page.clock.runFor(250);
    await expect(copy).toHaveText("Copied");
    await page.clock.runFor(1200);
    await expect(copy).toHaveText("Copied");
    await page.clock.runFor(400);
    await expect(copy).toHaveText("Copy key");
    expect(await clipboard(page)).toHaveLength(2);

    // Clipboard denial restores the label and explains the manual fallback in an announced toast.
    await page.evaluate(() => { (window as unknown as { clipboardState: { mode: string } }).clipboardState.mode = "reject"; });
    await copy.click();
    await page.clock.runFor(250);
    await expect(page.locator("#cp-toasts .toast.error")).toHaveText("Unable to copy. Select and copy the key manually.");
    await expect(copy).toHaveText("Copy key");
    await expect(copy).not.toHaveAttribute("aria-busy", "true");
    await expect(copy).toBeEnabled();
    expect(await clipboard(page)).toHaveLength(2);
    await expect(page.locator("#cp-toasts")).toHaveAttribute("aria-live", "polite");

    // Identifier controls: truncation keeps the full value in title and copies the whole identifier.
    await page.locator("#secret-confirmed").check();
    await page.locator("#secret-done").click();
    await page.goto(`/organizations/${seed.organizationId}/projects/${seed.projectId}`);
    await shellReady(page);
    await page.evaluate(() => { (window as unknown as { clipboardState: { mode: string; delay: number } }).clipboardState.mode = "ok"; (window as unknown as { clipboardState: { delay: number } }).clipboardState.delay = 0; });
    const idCopy = page.locator(".cp-id-copy").first();
    const idleLabel = await idCopy.getAttribute("aria-label");
    expect(idleLabel).toMatch(/^Copy /);
    const identifier = page.locator(".cp-id").first();
    expect(await identifier.getAttribute("title")).toBe(seed.projectId);
    await expect(identifier).toHaveText(seed.projectId);
    await idCopy.click();
    await page.clock.runFor(1);
    await expect(idCopy).toHaveAttribute("aria-label", /copied$/);
    expect((await clipboard(page)).at(-1)).toBe(seed.projectId);
    await page.clock.runFor(1500);
    await expect(idCopy).toHaveAttribute("aria-label", idleLabel!);
  });
});

async function controlStates(page: Page, pooled: Pool, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`/organizations/${pooled.organizations[4].id}/teams`);
  await shellReady(page);
  const mobileTargets = viewport.width < 400;
  // Icon-only and shell controls reach the documented sizes.
  for (const selector of ["#cp-avatar", ".rendro-theme-control", ...(mobileTargets ? ["#cp-menu"] : [])]) {
    const box = (await page.locator(selector).first().boundingBox())!;
    expect(Math.round(box.width), selector).toBe(mobileTargets ? 44 : 36);
    expect(Math.round(box.height), selector).toBe(mobileTargets ? 44 : 36);
  }
  const create = page.locator(".cp-page-actions").getByRole("button", { name: "Create team", exact: true });
  const height = Math.round((await create.boundingBox())!.height);
  expect(height).toBeGreaterThanOrEqual(mobileTargets ? 44 : 36);
  expect(height).toBeLessThanOrEqual(mobileTargets ? 48 : 40);

  await create.click();
  const dialog = page.locator("#team-dialog");
  const name = dialog.getByLabel("Team name");
  const submit = dialog.getByRole("button", { name: "Create team", exact: true });
  // Hover changes the surface; keyboard focus shows a visible ring; required fields are announced.
  await expect(name).toBeFocused();
  expect(await name.evaluate(input => (input as HTMLInputElement).required)).toBe(true);
  const idle = await submit.evaluate(button => getComputedStyle(button).backgroundColor);
  await submit.hover();
  await expect.poll(() => submit.evaluate(button => getComputedStyle(button).backgroundColor)).not.toBe(idle);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(name).toBeFocused();
  const ring = await name.evaluate(input => { const style = getComputedStyle(input); return `${style.boxShadow}|${style.borderColor}|${style.outlineStyle}`; });
  expect(ring).not.toBe("none|rgb(212, 212, 216)|none");
  // Invalid submission is blocked natively, focuses the field and exposes it as invalid.
  await submit.click();
  await expect(name).toBeFocused();
  expect(await name.evaluate(input => (input as HTMLInputElement).validity.valueMissing)).toBe(true);
  expect(await name.evaluate(input => input.matches(":invalid"))).toBe(true);
  await expect(dialog).toBeVisible();
  // Long labels and translated validation text stay contained within the dialog.
  await name.fill("A".repeat(80));
  const box = (await dialog.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  // The fixtures stub the icon-font stylesheet, so ligature names such as the close glyph render as fallback text whose
  // width depends on the host's system fonts. Measure containment of the real content, not of that placeholder text.
  await page.addStyleTag({ content: ".dialog-close::before{content:none}" });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const escaping = await dialog.evaluate(element => {
    const edge = element.getBoundingClientRect().right;
    return [...element.querySelectorAll("*")].filter(child => child.getBoundingClientRect().right > edge + 0.5).map(child => child.tagName + "." + child.className);
  });
  expect(escaping).toEqual([]);
  // The error region is announced politely to assistive technology.
  await expect(dialog.locator("#team-error")).toHaveAttribute("role", "alert");
}

test.describe("shared control states", () => {
  test("controls expose hover, focus, pending, invalid states and target sizes at 1440", async ({ page, pooled }) => {
    await controlStates(page, pooled, desktop);
  });

  test("controls expose hover, focus, pending, invalid states and target sizes at 375", async ({ page, pooled }) => {
    await controlStates(page, pooled, mobile);
  });
});
