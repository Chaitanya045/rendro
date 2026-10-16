import type { Page } from "@playwright/test";
import { test, expect } from "./shell-fixtures";
import { holdRequest } from "./auth-helpers";
import { api, desktop, heading, mobile, shellReady } from "./shell-helpers";

const forms = [
  { path: "teams", trigger: "Create team", dialog: "#team-dialog" },
  { path: "people", trigger: "Invite people", dialog: "#invite-dialog" },
  { path: "projects", trigger: "Create project", dialog: "#project-dialog" },
  { path: "api-keys", trigger: "Create API key", dialog: "#key-dialog" },
] as const;

/** Native modal containment: focus is in the dialog, or has left the page for browser UI; never in the page behind. */
const containedInDialog = (page: Page, selector: string) => page.evaluate(id => {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement || document.querySelector(id)!.contains(active);
}, selector);
const insideDialog = (page: Page, selector: string) => page.evaluate(id => document.querySelector(id)!.contains(document.activeElement), selector);

test.describe("form dialogs", () => {
  test("form dialogs contain focus and close by Close, Cancel, Escape and backdrop at both viewports", async ({ page, pooled }) => {
    test.setTimeout(120_000);
    const base = `/organizations/${pooled.organizations[4].id}`;
    for (const viewport of [desktop, mobile]) {
      await page.setViewportSize(viewport);
      for (const form of forms) {
        await page.goto(`${base}/${form.path}`);
        await shellReady(page);
        const trigger = page.locator(".cp-page-actions").getByRole("button", { name: form.trigger, exact: true });
        const dialog = page.locator(form.dialog);
        await expect(trigger).toBeEnabled();
        await expect(dialog.locator("input:not([type=checkbox])").first()).toBeEnabled();
        const open = async () => {
          await trigger.click();
          await expect(dialog).toBeVisible();
          expect(await dialog.evaluate(element => element.matches(":modal"))).toBe(true);
        };
        const closedAndFocused = async () => {
          await expect(dialog).toBeHidden();
          await expect(trigger).toBeFocused();
        };

        // Native focus containment in both directions, with the page behind it unreachable.
        await open();
        expect(await insideDialog(page, form.dialog), `${form.path} initial focus`).toBe(true);
        for (let index = 0; index < 14; index++) {
          await page.keyboard.press("Tab");
          expect(await containedInDialog(page, form.dialog), `${form.path} Tab ${index}`).toBe(true);
        }
        for (let index = 0; index < 4; index++) {
          await page.keyboard.press("Shift+Tab");
          expect(await containedInDialog(page, form.dialog), `${form.path} Shift+Tab ${index}`).toBe(true);
        }
        // Fits the viewport; mobile footers stack with the primary action first.
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        const cancel = (await dialog.locator(".dialog-footer").getByRole("button", { name: "Cancel", exact: true }).boundingBox())!;
        const primary = (await dialog.locator(".dialog-footer .button.primary").boundingBox())!;
        if (viewport.width < 400) {
          expect(primary.y).toBeLessThan(cancel.y);
          expect(Math.round(cancel.width)).toBeGreaterThan(viewport.width * 0.6);
        } else {
          expect(cancel.x).toBeLessThan(primary.x);
          expect(Math.abs(cancel.y - primary.y)).toBeLessThan(4);
        }

        await page.keyboard.press("Escape");
        await closedAndFocused();
        await open();
        await dialog.locator(".dialog-close").click();
        await closedAndFocused();
        await open();
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await closedAndFocused();
        await open();
        await page.mouse.click(2, 2);
        await closedAndFocused();
        // The page is still mounted and usable behind the dismissed dialog.
        await expect(heading(page)).toBeVisible();
      }
    }
  });

  test("a pending write blocks every dismissal and a failed write keeps the entered values for retry", async ({ page, pooled }, info) => {
    await page.setViewportSize(desktop);
    const base = `/organizations/${pooled.organizations[5].id}`;
    const draft = `Retained draft ${info.project.name}`;
    await page.goto(`${base}/teams`);
    await shellReady(page);
    const trigger = page.locator(".cp-page-actions").getByRole("button", { name: "Create team", exact: true });
    const dialog = page.locator("#team-dialog");
    await expect(dialog.getByLabel("Team name")).toBeEnabled();
    const hold = await holdRequest(page, "/api/auth/organization/create-team");
    try {
      await trigger.click();
      await dialog.getByLabel("Team name").fill(draft);
      await dialog.getByRole("button", { name: "Create team", exact: true }).click();
      await expect.poll(() => hold.count()).toBe(1);
      await expect(dialog.locator("button[type=submit]")).toHaveAttribute("aria-busy", "true");
      // Cancel, Close, Escape and the backdrop are inert while the write is pending.
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.locator(".dialog-close").click();
      await page.keyboard.press("Escape");
      await page.mouse.click(2, 2);
      await expect(dialog).toBeVisible();
      hold.release(true);
      await expect(dialog.locator("#team-error")).toContainText("Service unavailable");
      // Failure: still open, not busy, values retained, retry creates exactly one team.
      await expect(dialog.locator("button[type=submit]")).not.toHaveAttribute("aria-busy", "true");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Team name")).toHaveValue(draft);
    } finally {
      await hold.close();
    }
    await dialog.getByRole("button", { name: "Create team", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: draft })).toHaveCount(1);
    // Reopening starts clean after success.
    await trigger.click();
    await expect(dialog.getByLabel("Team name")).toHaveValue("");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
  });
});

test.describe("destructive confirmation", () => {
  test("shared confirmation inserts text safely, defaults to Cancel and restores focus on Escape, Cancel and backdrop", async ({ page, pooled }, info) => {
    const alpha = pooled.organizations[6];
    await page.goto(`/organizations/${alpha.id}`);
    const hostile = `Docs <img src=x onerror=window.__pwned=1> team ${info.project.name}`;
    expect((await api(page, "/api/auth/organization/create-team", { name: hostile, organizationId: alpha.id })).status).toBe(200);
    for (const viewport of [desktop, mobile]) {
      await page.setViewportSize(viewport);
      await page.goto(`/organizations/${alpha.id}/teams`);
      await shellReady(page);
      const remove = page.locator(".team-card", { has: page.getByRole("heading", { name: hostile }) }).getByRole("button", { name: "Remove team", exact: true });
      await expect(remove).toBeVisible();
      const dialog = page.locator("#cp-confirm-dialog");
      const reopen = async () => {
        await remove.click();
        await expect(dialog).toBeVisible();
        await expect(dialog.locator("[data-confirm-cancel]")).toBeFocused();
      };
      await reopen();
      // Safe insertion and action-specific wording; accept is an explicit destructive control.
      await expect(dialog.locator("#cp-confirm-title")).toHaveText("Remove team?");
      await expect(dialog.locator("#cp-confirm-message")).toHaveText(`“${hostile}” will be deleted. Organization members keep their access.`);
      await expect(dialog.locator("[data-confirm-accept]")).toHaveText("Remove team");
      await expect(dialog.locator("[data-confirm-accept]")).toHaveClass(/destructive/);
      expect(await dialog.locator("img").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
      expect(await dialog.evaluate(element => element.matches(":modal"))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(remove).toBeFocused();
      await reopen();
      await dialog.locator("[data-confirm-cancel]").click();
      await expect(dialog).toBeHidden();
      await expect(remove).toBeFocused();
      await reopen();
      await page.mouse.click(2, 2);
      await expect(dialog).toBeHidden();
      await expect(remove).toBeFocused();
      // Nothing was removed by dismissals.
      await expect(page.getByRole("heading", { name: hostile })).toHaveCount(1);
    }
  });

  test("shared confirmation accepts, reuses one dialog across pages and shows stacked toasts that expire", async ({ page, pooled }, info) => {
    await page.setViewportSize(desktop);
    const alpha = pooled.organizations[7];
    await page.goto(`/organizations/${alpha.id}`);
    const names = [`First ${info.project.name}`, `Second ${info.project.name}`];
    for (const name of names) expect((await api(page, "/api/auth/organization/create-team", { name, organizationId: alpha.id })).status).toBe(200);
    const key = await api<{ keyId?: string }>(page, "/api/rendro/credentials", { organizationId: alpha.id, name: `Disposable key ${info.project.name}`, scopes: ["docs:read"] });
    expect(key.status).toBe(201);
    await page.goto(`/organizations/${alpha.id}/teams`);
    await shellReady(page);
    const removeButton = (name: string) => page.locator(".team-card", { has: page.getByRole("heading", { name, exact: true }) }).getByRole("button", { name: "Remove team", exact: true });
    await expect(removeButton(names[0])).toBeVisible();
    await expect(removeButton(names[1])).toBeVisible();
    await page.evaluate(() => { (document.querySelector("#cp-toasts") as HTMLElement).dataset.pristine = "yes"; });
    const confirm = page.locator("#cp-confirm-dialog");

    // Two quick confirmed removals: both succeed and their toasts overlap in the live region.
    await expect(page.locator("#cp-toasts")).toHaveAttribute("aria-live", "polite");
    for (const name of names) {
      await removeButton(name).click();
      await expect(confirm.locator("[data-confirm-cancel]")).toBeFocused();
      await confirm.locator("[data-confirm-accept]").click();
      await expect(confirm).toBeHidden();
      // The accept control never keeps a busy state between uses.
      await expect(confirm.locator("[aria-busy=true]")).toHaveCount(0);
      // The list refresh that follows the removal finishes before the next card is used, so the
      // next click cannot land on a card that is being replaced.
      await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
    }
    const toasts = page.locator("#cp-toasts .toast");
    await expect(toasts).toHaveText(["Team removed.", "Team removed."]);
    await expect(toasts.first()).toHaveClass(/visible/);
    // Timed dismissal.
    await expect(toasts).toHaveCount(0, { timeout: 9000 });
    await expect(page.locator("#cp-toasts")).toHaveAttribute("data-pristine", "yes");

    // The same confirmation element serves another page and revokes the key on accept.
    await page.evaluate(() => { (document.querySelector("#cp-confirm-dialog") as HTMLElement & { reusedMarker?: string }).reusedMarker = "same"; });
    await page.locator(".cp-nav").getByRole("link", { name: "API keys", exact: true }).click();
    await expect(page.getByRole("row", { name: new RegExp(`Disposable key ${info.project.name}`) })).toContainText("Active");
    // Shared vocabulary: scopes and statuses use their labels rather than raw identifiers.
    await expect(page.getByRole("row", { name: new RegExp(`Disposable key ${info.project.name}`) })).toContainText("Read deployments");
    await expect(page.getByRole("row", { name: new RegExp(`Disposable key ${info.project.name}`) })).not.toContainText("docs:read");
    const revoke = page.getByRole("row", { name: new RegExp(`Disposable key ${info.project.name}`) }).locator("button", { hasText: "Revoke" });
    await revoke.click();
    await expect(confirm.locator("#cp-confirm-title")).toHaveText("Revoke API key?");
    expect(await confirm.evaluate((element: HTMLElement & { reusedMarker?: string }) => element.reusedMarker)).toBe("same");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("row", { name: new RegExp(`Disposable key ${info.project.name}`) })).toContainText("Active");
    await revoke.click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(page.getByRole("row", { name: new RegExp(`Disposable key ${info.project.name}`) })).toContainText("Revoked");
  });
});

test.describe("confirmation edge cases and server text", () => {
  test.use({ viewport: desktop });

  test("a second confirmation cancels the first and a missing modal API falls back to a native prompt", async ({ page, pooled }) => {
    await page.goto(`/organizations/${pooled.organizations[6].id}/teams`);
    await shellReady(page);
    type Confirm = (options: { title: string; message: string }) => Promise<boolean>;
    const overlapped = await page.evaluate(async () => {
      const ui = (window as unknown as { RendroUI: { confirm: Confirm } }).RendroUI;
      const first = ui.confirm({ title: "First?", message: "first" });
      const second = ui.confirm({ title: "Second?", message: "second" });
      const firstResult = await first;
      const title = document.querySelector("#cp-confirm-title")?.textContent;
      document.querySelector<HTMLElement>("[data-confirm-cancel]")?.click();
      return { firstResult, title, secondResult: await second };
    });
    expect(overlapped).toEqual({ firstResult: false, title: "Second?", secondResult: false });
    const prompts: string[] = [];
    page.once("dialog", dialog => { prompts.push(`${dialog.type()}:${dialog.message()}`); void dialog.accept(); });
    const native = await page.evaluate(async () => {
      const ui = (window as unknown as { RendroUI: { confirm: Confirm } }).RendroUI;
      (HTMLDialogElement.prototype as { showModal?: unknown }).showModal = undefined;
      return ui.confirm({ title: "Native?", message: "fallback" });
    });
    expect(native).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("confirm:Native?");
  });

  test("server error text is inserted as text, never as markup", async ({ page, pooled }) => {
    await page.goto(`/organizations/${pooled.organizations[5].id}/teams`);
    await shellReady(page);
    const hostile = "<img src=x onerror=window.__pwned=1>Team refused";
    await page.route("**/api/auth/organization/create-team", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: hostile }) }));
    await page.locator(".cp-page-actions").getByRole("button", { name: "Create team", exact: true }).click();
    const dialog = page.locator("#team-dialog");
    await dialog.getByLabel("Team name").fill("Refused team");
    await dialog.getByRole("button", { name: "Create team", exact: true }).click();
    await expect(dialog.locator("#team-error")).toHaveText(hostile);
    expect(await dialog.locator("#team-error img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(dialog).toBeVisible();
  });
});
