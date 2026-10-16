import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./shell-fixtures";
import type { Pool } from "./shell-fixtures";
import { api, desktop, heading, holdFirst, mobile, provision, settleFrames, shellReady, signInSeeded } from "./shell-helpers";

const hostileName = `Zed <b>bold</b> & "co"`;
const poolNames = ["Alpha", "Beta", "Gamma", "Gadget", hostileName];

test.describe("mobile management drawer", () => {
  test.use({ viewport: mobile });

  test("mobile drawer opens modally, traps focus and closes by control, scrim, Escape and route selection", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    await page.goto(base);
    await shellReady(page);
    const menu = page.getByRole("button", { name: "Open navigation", exact: true });
    const nav = page.locator("#cp-navigation");
    const state = () => page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>("#cp-navigation")!;
      return {
        expanded: document.querySelector("#cp-menu")!.getAttribute("aria-expanded"),
        role: sidebar.getAttribute("role"), modal: sidebar.getAttribute("aria-modal"), label: sidebar.getAttribute("aria-label"),
        hidden: sidebar.getAttribute("aria-hidden"), inert: sidebar.inert,
        topbarInert: document.querySelector<HTMLElement>(".cp-topbar")!.inert, mainInert: document.querySelector<HTMLElement>(".cp-main")!.inert,
        overflow: getComputedStyle(document.body).overflow, open: document.body.classList.contains("nav-open"),
        inside: sidebar.contains(document.activeElement),
      };
    });
    const closed = { expanded: "false", role: "complementary", modal: null, label: "Workspace navigation", hidden: "true", inert: true, topbarInert: false, mainInert: false, open: false };
    expect(await state()).toMatchObject(closed);
    expect(await state()).toMatchObject({ overflow: expect.not.stringMatching(/^hidden$/) });
    const overflowFree = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await overflowFree();

    const openDrawer = async () => {
      await menu.click();
      await expect(nav).toHaveAttribute("aria-modal", "true");
    };
    await openDrawer();
    expect(await state()).toMatchObject({ expanded: "true", role: "dialog", modal: "true", label: "Organization navigation", hidden: "false", inert: false, topbarInert: true, mainInert: true, overflow: "hidden", open: true, inside: true });
    await expect(page.locator("#cp-nav-close")).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Organization navigation" })).toBeVisible();
    // Organization context lives in the drawer; documentation stays hidden outside a deployed project.
    await expect(nav.locator(".cp-drawer-org")).toContainText("E2E primary");
    await expect(nav.locator(".cp-drawer-org")).toContainText("Switch organization");
    await expect(nav.locator(".cp-drawer-org")).toHaveAttribute("href", "/organizations?choose=1");
    await expect(nav.locator("[data-cp-open-docs]")).toBeHidden();
    await overflowFree();

    // Focus is contained: forward and backward traversal never leaves the dialog.
    const order: string[] = [];
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press("Tab");
      expect((await state()).inside, `forward ${index}`).toBe(true);
      order.push(await page.evaluate(() => document.activeElement?.textContent?.replace(/\s+/g, " ").trim() ?? ""));
    }
    expect(new Set(order).size).toBeGreaterThan(5);
    await page.locator("#cp-nav-close").focus();
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toContain("API keys");
    await page.keyboard.press("Tab");
    await expect(page.locator("#cp-nav-close")).toBeFocused();

    // Close control returns focus to the trigger and restores the page.
    await page.locator("#cp-nav-close").click();
    expect(await state()).toMatchObject({ ...closed, inside: false });
    await expect(menu).toBeFocused();
    // Escape.
    await openDrawer();
    await page.keyboard.press("Escape");
    expect(await state()).toMatchObject(closed);
    await expect(menu).toBeFocused();
    // Scrim.
    await openDrawer();
    await page.mouse.click(mobile.width - 8, mobile.height / 2);
    expect(await state()).toMatchObject(closed);
    await expect(menu).toBeFocused();
    // Selecting a route closes the drawer and swaps the page in place.
    await openDrawer();
    await nav.getByRole("link", { name: "People", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/people$`));
    await expect(heading(page)).toHaveText("People");
    expect(await state()).toMatchObject({ expanded: "false", inert: true, mainInert: false, open: false });
    await overflowFree();

    // 320px keeps the same containment without horizontal overflow, with the drawer open.
    await page.setViewportSize({ width: 320, height: 640 });
    await openDrawer();
    await overflowFree();
    await page.keyboard.press("Escape");
    await overflowFree();
  });

  test("resizing to desktop reconciles drawer inertness and modal semantics", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    await page.goto(`/organizations/${seed.organizationId}`);
    await shellReady(page);
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const snapshot = () => page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>("#cp-navigation")!;
      return {
        role: sidebar.getAttribute("role"), modal: sidebar.getAttribute("aria-modal"), label: sidebar.getAttribute("aria-label"), hidden: sidebar.getAttribute("aria-hidden"),
        inert: sidebar.inert, topbarInert: document.querySelector<HTMLElement>(".cp-topbar")!.inert, mainInert: document.querySelector<HTMLElement>(".cp-main")!.inert,
        visible: sidebar.getBoundingClientRect().width > 0 && getComputedStyle(sidebar).visibility === "visible",
      };
    });
    expect(await snapshot()).toMatchObject({ role: "dialog", modal: "true", inert: false, topbarInert: true, mainInert: true });
    await page.setViewportSize(desktop);
    await expect.poll(snapshot).toMatchObject({ role: "complementary", modal: null, label: "Workspace navigation", hidden: null, inert: false, topbarInert: false, mainInert: false, visible: true });
    // The open state is retained and reconciled again when the layout returns to mobile.
    await page.setViewportSize(mobile);
    await expect.poll(snapshot).toMatchObject({ role: "dialog", inert: false, mainInert: true });
    await page.keyboard.press("Escape");
    await expect.poll(snapshot).toMatchObject({ role: "complementary", inert: true, mainInert: false });
  });
});

test.describe("account menu", () => {
  test("account menu toggles, dismisses and launches account security at both viewports", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    for (const viewport of [desktop, mobile]) {
      await page.setViewportSize(viewport);
      await page.goto(base);
      await shellReady(page);
      const avatar = page.locator("#cp-avatar");
      const menu = page.locator("#cp-account-menu");
      const closed = async () => {
        await expect(avatar).toHaveAttribute("aria-expanded", "false");
        await expect(menu).toBeHidden();
        expect(await menu.evaluate((element: HTMLElement) => ({ inert: element.inert, hidden: element.getAttribute("aria-hidden") }))).toEqual({ inert: true, hidden: "true" });
      };
      await closed();
      await avatar.click();
      await expect(avatar).toHaveAttribute("aria-expanded", "true");
      await expect(menu).toBeVisible();
      expect(await menu.evaluate((element: HTMLElement) => ({ inert: element.inert, hidden: element.getAttribute("aria-hidden") }))).toEqual({ inert: false, hidden: "false" });
      await expect(menu.locator(".cp-account-email")).toHaveText("owner@example.test");
      // Reachable, inside the viewport, with large enough touch targets on mobile.
      for (const target of [menu.getByRole("link", { name: "Account security" }), menu.getByRole("button", { name: "Sign out" })]) {
        const box = (await target.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        if (viewport.width < 400) expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
      }
      await page.keyboard.press("Tab");
      await expect(menu.getByRole("link", { name: "Account security" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(menu.getByRole("button", { name: "Sign out" })).toBeFocused();
      // Toggle, outside click (no focus capture) and Escape (focus returns to the avatar).
      await avatar.click();
      await closed();
      await avatar.click();
      await page.mouse.click(viewport.width / 2, viewport.height - 30);
      await closed();
      await avatar.click();
      await page.keyboard.press("Escape");
      await closed();
      await expect(avatar).toBeFocused();
    }
    await page.locator("#cp-avatar").click();
    await page.locator("#cp-account-menu").getByRole("link", { name: "Account security" }).click();
    await expect(page).toHaveURL(/\/account\/security$/);
    await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeVisible();
  });

  test("opening the organization switcher closes the account menu and sign-out elsewhere closes overlays", async ({ page }, info) => {
    await page.setViewportSize(desktop);
    const workspace = await provision(page, `overlay-${info.project.name}`, { organizations: ["Alpha", "Beta"] });
    await page.goto(`/organizations/${workspace.organizations[0].id}`);
    await shellReady(page);
    const avatar = page.locator("#cp-avatar");
    const switcher = page.locator("button#cp-org-switcher");
    await avatar.click();
    await expect(avatar).toHaveAttribute("aria-expanded", "true");
    await switcher.click();
    await expect(switcher).toHaveAttribute("aria-expanded", "true");
    await expect(avatar).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#cp-account-menu")).toBeHidden();
    // The reverse direction: choosing the account menu dismisses the organization menu.
    await avatar.click();
    await expect(avatar).toHaveAttribute("aria-expanded", "true");
    await expect(switcher).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#cp-org-menu")).toBeHidden();

    // Sign out in another tab of the same browser: the surviving tab closes its overlays.
    const other = await page.context().newPage();
    await other.goto("/account/security");
    await other.getByRole("button", { name: "Sign out" }).first().click();
    await expect(other.getByRole("heading", { name: "You're signed out" })).toBeVisible();
    await expect(avatar).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#cp-account-menu")).toBeHidden();
  });
});

async function open(page: Page) {
  const trigger = page.locator("button#cp-org-switcher");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return trigger;
}

async function switcherMenu(page: Page, pool: Pool, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const alpha = pool.organizations[0];
  const lists: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/auth/organization/list") lists.push(request.url()); });
  // The chooser reads the list first; the switcher in the next document reuses that fresh tab cache.
  await page.goto("/organizations?choose=1");
  await expect(page.locator(".organization-card")).toHaveCount(poolNames.length);
  expect(lists).toHaveLength(1);
  await page.goto(`/organizations/${alpha.id}`);
  await shellReady(page);
  const trigger = page.locator("button#cp-org-switcher");
  if (viewport.width < 400) await expect(trigger.locator("[data-org-name]")).toHaveText("Alpha");
  // The enhanced control exposes a menu relationship; nothing was read yet.
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-controls", "cp-org-menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#cp-org-menu")).toBeHidden();

  await open(page);
  const menu = page.locator("#cp-org-menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(menu.locator(".cp-org-menu-name")).toHaveText(poolNames);
  await expect(items.last()).toHaveText("Manage organizations");
  await expect(items).toHaveCount(poolNames.length + 1);
  await expect(menu.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(menu.locator('[aria-current="true"]')).toContainText("Alpha");
  await expect(menu.locator('[aria-current="true"] .cp-org-menu-check')).toHaveText("check");
  await expect(menu.getByRole("menuitem", { name: "Manage organizations" })).toHaveAttribute("href", "/organizations?choose=1");
  // The current organization receives focus first; hostile names remain plain text.
  await expect(menu.locator('[aria-current="true"]')).toBeFocused();
  expect(await menu.locator("img, b").count()).toBe(0);
  await expect(menu.getByRole("menuitem", { name: hostileName, exact: true })).toBeVisible();
  // Fresh cached data: neither the first open nor a reopen asks the backend again.
  expect(lists).toHaveLength(1);
  // Only sanitized display fields are kept in tab storage.
  const stored = await page.evaluate(() => {
    const keys = new Set<string>();
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") {
        if ("name" in value) Object.keys(value).forEach(key => keys.add(key));
        Object.values(value).forEach(visit);
      }
    };
    let entries = 0;
    for (const raw of Object.values(sessionStorage)) {
      if (typeof raw !== "string" || !raw.includes("Gadget")) continue;
      entries++;
      try { visit(JSON.parse(raw)); } catch { /* not JSON */ }
    }
    return { entries, keys: [...keys].sort() };
  });
  expect(stored.entries).toBeGreaterThan(0);
  expect(stored.keys.every(key => ["id", "name", "slug"].includes(key)), stored.keys.join(",")).toBe(true);
  // Popover geometry stays inside the visual viewport.
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const axe = await new AxeBuilder({ page }).options({ preload: false }).include("#cp-org-menu").analyze();
  expect(axe.violations).toEqual([]);

  // Closing and reopening rebuilds the menu from the cache without a second read.
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeHidden();
  await trigger.click();
  await expect(items).toHaveCount(poolNames.length + 1);
  expect(lists).toHaveLength(1);
}

test.describe("organization switcher", () => {
  test("switcher upgrades to a lazily loaded menu, marks the current organization and reopens from cache at 1440", async ({ page, switcherPool }) => {
    await switcherMenu(page, switcherPool, desktop);
  });

  test("switcher upgrades to a lazily loaded menu, marks the current organization and reopens from cache at 375", async ({ page, switcherPool }) => {
    await switcherMenu(page, switcherPool, mobile);
  });

  test("switcher keyboard navigation, typeahead and dismissal paths", async ({ page, switcherPool }) => {
    await page.setViewportSize(desktop);
    const [alpha, beta] = switcherPool.organizations;
    await page.goto(`/organizations/${alpha.id}/people`);
    await shellReady(page);
    const trigger = page.locator("button#cp-org-switcher");
    const menu = page.locator("#cp-org-menu");
    const focusedText = () => page.evaluate(() => document.activeElement?.textContent?.replace(/\s+/g, " ").trim() ?? "");
    // ArrowDown opens and focuses the current organization; ArrowUp wraps to the footer link.
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await expect(menu.locator('[aria-current="true"]')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    expect(await focusedText()).toContain("Beta");
    await page.keyboard.press("End");
    expect(await focusedText()).toBe("Manage organizations");
    await page.keyboard.press("ArrowDown");
    expect(await focusedText()).toContain("Alpha");
    await page.keyboard.press("ArrowUp");
    expect(await focusedText()).toBe("Manage organizations");
    await page.keyboard.press("Home");
    expect(await focusedText()).toContain("Alpha");
    // Typeahead is case-insensitive and cumulative within 700ms: "g" → Gamma, "ga","gad" → Gadget.
    await page.keyboard.press("g");
    expect(await focusedText()).toContain("Gamma");
    await page.keyboard.type("ad", { delay: 20 });
    expect(await focusedText()).toContain("Gadget");
    // Escape closes and returns focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    // Pointer outside, focus departure and route leave all dismiss without selecting.
    await trigger.click();
    await expect(menu).toBeVisible();
    await heading(page).click();
    await expect(menu).toBeHidden();
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.locator("#cp-avatar").focus();
    await expect(menu).toBeHidden();
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.locator(".cp-nav").getByRole("link", { name: "Teams", exact: true }).evaluate((link: HTMLElement) => link.click());
    await expect(page).toHaveURL(new RegExp(`${alpha.id}/teams$`));
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    // Space activates the focused organization and keeps the current section.
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    expect(await focusedText()).toContain("Beta");
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(new RegExp(`/organizations/${beta.id}/teams$`));
    await shellReady(page);
    await expect(trigger.locator("[data-org-name]")).toHaveText("Beta");
  });

  test("switcher optimistic label hands off across the full navigation and a failed load can be retried", async ({ page, context, switcherPool }) => {
    await page.setViewportSize(desktop);
    const [alpha, beta] = switcherPool.organizations;
    // A project route falls back to the destination organization's Projects list.
    await page.goto(`/organizations/${alpha.id}`);
    await shellReady(page);
    const created = await api<{ project?: { _id: string } }>(page, "/api/rendro/projects", { organizationId: alpha.id, name: "Switcher docs", slug: "switcher-docs" });
    expect([201, 409]).toContain(created.status);
    const listed = await api<{ projects: Array<{ _id: string; slug: string }> }>(page, `/api/rendro/projects?organizationId=${alpha.id}`);
    const project = listed.body.projects.find(candidate => candidate.slug === "switcher-docs")!;
    await page.goto(`/organizations/${alpha.id}/projects/${project._id}`);
    await shellReady(page);
    await open(page);
    await page.locator("#cp-org-menu").getByRole("menuitem", { name: "Beta", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${beta.id}/projects$`));
    await expect(heading(page)).toHaveText("Projects");

    await page.goto(`/organizations/${alpha.id}/settings`);
    await shellReady(page);
    const trigger = page.locator("button#cp-org-switcher");
    // Choosing the current organization only closes the menu.
    await open(page);
    const documents: string[] = [];
    page.on("request", request => { if (request.resourceType() === "document" && request.frame() === page.mainFrame()) documents.push(new URL(request.url()).pathname); });
    await page.locator("#cp-org-menu").getByRole("menuitem", { name: "Alpha", exact: true }).click();
    await expect(page.locator("#cp-org-menu")).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(documents).toEqual([]);

    // The label, mark, busy state and one-use hint are applied synchronously on selection, before
    // the destination document exists. Record them from the departing document.
    await open(page);
    await page.evaluate(() => {
      const label = document.querySelector("#cp-org-switcher [data-org-name]")!;
      new MutationObserver(() => {
        const switcher = document.querySelector("#cp-org-switcher")!;
        const seen = JSON.parse(localStorage.getItem("probe-label") ?? "[]") as unknown[];
        seen.push({ name: label.textContent, mark: switcher.querySelector("[data-org-mark]")?.textContent, busy: switcher.getAttribute("aria-busy"),
          disabled: switcher.getAttribute("aria-disabled"), hint: JSON.parse(sessionStorage.getItem("rendro-org-navigation-label") ?? "null") as unknown });
        localStorage.setItem("probe-label", JSON.stringify(seen));
      }).observe(label, { childList: true, characterData: true, subtree: true });
    });
    await page.locator("#cp-org-menu").getByRole("menuitem", { name: "Beta", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${beta.id}/settings$`));
    await shellReady(page);
    const seen = await page.evaluate(() => { const value = JSON.parse(localStorage.getItem("probe-label") ?? "[]") as Array<{ name: string; mark: string; busy: string; disabled: string; hint: { name: string; organizationId: string; createdAt: number } | null }>; localStorage.removeItem("probe-label"); return value; });
    expect(seen[0]).toMatchObject({ name: "Beta", mark: "B", busy: "true", disabled: "true", hint: { name: "Beta", organizationId: beta.id } });
    expect(Date.now() - seen[0].hint!.createdAt).toBeLessThan(60_000);
    await expect(trigger.locator("[data-org-name]")).toHaveText("Beta");
    await expect(trigger).not.toHaveAttribute("aria-busy", "true");
    // The hint is consumed exactly once by the destination document.
    expect(await page.evaluate(() => sessionStorage.getItem("rendro-org-navigation-label"))).toBeNull();
    expect(documents).toContain(`/organizations/${beta.id}/settings`);

    // Failure → recoverable message and Try again; the same tab then lists organizations.
    const fresh = await context.newPage();
    await fresh.setViewportSize(desktop);
    let fail = true;
    await fresh.route("**/api/auth/organization/list", async route => {
      if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) });
      else await route.continue();
    });
    await fresh.goto(`/organizations/${alpha.id}`);
    await shellReady(fresh);
    await fresh.locator("button#cp-org-switcher").click();
    const menu = fresh.locator("#cp-org-menu");
    await expect(menu.getByRole("status")).toHaveText("Unable to load organizations.");
    const retry = menu.getByRole("menuitem", { name: "Try again" });
    await expect(retry).toBeFocused();
    fail = false;
    await retry.click();
    await expect(menu.getByRole("menuitem", { name: "Beta", exact: true })).toBeVisible();
    await expect(menu.getByRole("status")).toBeHidden();
    await fresh.close();

    // Empty membership list.
    const empty = await context.newPage();
    await empty.setViewportSize(desktop);
    await empty.route("**/api/auth/organization/list", route => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
    await empty.goto(`/organizations/${alpha.id}`);
    await shellReady(empty);
    await empty.locator("button#cp-org-switcher").click();
    await expect(empty.locator("#cp-org-menu").getByRole("status")).toHaveText("No organizations yet.");
    await empty.close();
  });

  test("a late list response after close and reopen does not duplicate or replace the menu", async ({ page, switcherPool }) => {
    await page.setViewportSize(desktop);
    await page.goto(`/organizations/${switcherPool.organizations[0].id}`);
    await shellReady(page);
    // The tab cache is cold after a fresh context, so the first open reads the list.
    const hold = await holdFirst(page, "**/api/auth/organization/list");
    const count = poolNames.length + 1;
    try {
      const trigger = await open(page);
      await expect.poll(() => hold.held()).toBe(1);
      await expect(page.locator("#cp-org-menu").getByRole("status")).toHaveText("Loading organizations…");
      await trigger.click();
      await expect(page.locator("#cp-org-menu")).toBeHidden();
      await trigger.click();
      // The shared requester deduplicates the pending read: still loading, no stale items yet.
      await expect(page.locator("#cp-org-menu").getByRole("status")).toHaveText("Loading organizations…");
      await expect(page.locator("#cp-org-menu").getByRole("menuitem")).toHaveCount(1);
      hold.release();
      await expect(page.locator("#cp-org-menu").getByRole("menuitem")).toHaveCount(count);
      await hold.delivered();
      await settleFrames(page);
      await expect(page.locator("#cp-org-menu").getByRole("menuitem")).toHaveCount(count);
      await expect(page.locator("#cp-org-menu").getByRole("status")).toBeHidden();
    } finally {
      await hold.close();
    }
  });
});
