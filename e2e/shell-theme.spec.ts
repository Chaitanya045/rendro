import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { Seed } from "./seed";
import { desktop, mobile, settleFrames, shellReady, signInSeeded } from "./shell-helpers";
import type { RepoFixtures } from "./repo-fixtures";

const snapshot = (page: Page) => page.evaluate(() => {
  const root = document.documentElement;
  const button = document.querySelector<HTMLElement>(".rendro-theme-control");
  return {
    dark: root.classList.contains("dark"), mode: root.dataset.theme, resolved: root.dataset.resolvedTheme,
    stored: (() => { try { return localStorage.getItem("commentor-theme"); } catch { return "unavailable"; } })(),
    label: button?.getAttribute("aria-label") ?? null, title: button?.getAttribute("title") ?? null, rippling: root.classList.contains("rendro-theme-rippling"),
  };
});
const toggle = (page: Page) => page.locator(".rendro-theme-control").first();
const record = () => {
  const w = window as unknown as { themeAtBody?: boolean };
  const note = () => { if (document.body && w.themeAtBody === undefined) w.themeAtBody = document.documentElement.classList.contains("dark"); };
  new MutationObserver(note).observe(document, { childList: true, subtree: true });
};

async function themeCycle(page: Page, context: BrowserContext, baseURL: string | undefined, seed: Seed, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.addInitScript(record);
  await signInSeeded(context, baseURL, seed, "owner");
  // Firefox's automation drops emulated media when a navigation enters a new browsing context group, which every
  // trusted page starts with COOP same-origin (#89); navigations within the group keep it. Enter the group first, so
  // the measured load below starts with the preference already applied.
  await page.goto(`/organizations/${seed.organizationId}`);
  await page.emulateMedia({ colorScheme: "dark" });
  // System preference with nothing stored: dark before the body exists.
  await page.goto(`/organizations/${seed.organizationId}`);
  await shellReady(page);
  expect(await page.evaluate(() => (window as unknown as { themeAtBody?: boolean }).themeAtBody)).toBe(true);
  expect(await snapshot(page)).toMatchObject({ dark: true, mode: "system", resolved: "dark", stored: null, label: "Switch to dark theme", title: "Theme: system" });
  // A saved preference wins over the OS; invalid or absent values fall back to system.
  await page.evaluate(() => localStorage.setItem("commentor-theme", "light"));
  await page.reload();
  expect(await page.evaluate(() => (window as unknown as { themeAtBody?: boolean }).themeAtBody)).toBe(false);
  expect(await snapshot(page)).toMatchObject({ dark: false, mode: "light", resolved: "light" });
  await page.evaluate(() => localStorage.setItem("commentor-theme", "purple"));
  await page.reload();
  expect(await snapshot(page)).toMatchObject({ dark: true, mode: "system", resolved: "dark" });
  await page.evaluate(() => localStorage.removeItem("commentor-theme"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await shellReady(page);

  // The control cycles through the three meanings and persists each choice.
  const steps = [
    { dark: true, mode: "dark", stored: "dark", label: "Switch to light theme", title: "Theme: dark" },
    { dark: false, mode: "light", stored: "light", label: "Switch to system theme", title: "Theme: light" },
    { dark: false, mode: "system", stored: "system", label: "Switch to dark theme", title: "Theme: system" },
  ];
  for (const step of steps) {
    await toggle(page).click();
    await expect.poll(async () => (await snapshot(page)).mode).toBe(step.mode);
    await expect.poll(async () => (await snapshot(page)).rippling).toBe(false);
    expect(await snapshot(page)).toMatchObject(step);
  }
  // Latest choice survives client navigation, reload and other shells (auth page, landing page).
  await toggle(page).click();
  await expect.poll(async () => (await snapshot(page)).dark).toBe(true);
  if (viewport.width > 400) {
    await page.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
    await expect(page).toHaveURL(/\/people$/);
  }
  expect(await snapshot(page)).toMatchObject({ dark: true, mode: "dark" });
  await page.reload();
  expect(await snapshot(page)).toMatchObject({ dark: true, mode: "dark", label: "Switch to light theme" });
  await page.goto("/account/security");
  expect(await snapshot(page), "account shell").toMatchObject({ dark: true, mode: "dark", stored: "dark" });
  // The repository viewer shell reads the same preference key.
  const { open } = JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
  await page.goto(`/r/${open.owner}/${open.name}`);
  await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "Open home", level: 1 })).toBeVisible();
  expect(await snapshot(page), "viewer shell").toMatchObject({ dark: true, mode: "dark" });
  await context.clearCookies();
  for (const path of ["/sign-in", "/"]) {
    await page.goto(path);
    expect(await snapshot(page), path).toMatchObject({ dark: true, mode: "dark", resolved: "dark", stored: "dark" });
  }
}

test.describe("theme runtime", () => {
  test("theme initializes before paint and cycles system, dark, light, system at 1440", async ({ page, context, baseURL, seed }) => {
    await themeCycle(page, context, baseURL, seed, desktop);
  });

  test("theme initializes before paint and cycles system, dark, light, system at 375", async ({ page, context, baseURL, seed }) => {
    await themeCycle(page, context, baseURL, seed, mobile);
  });

  test("OS preference changes and another tab's choice synchronize mounted and passive pages", async ({ page, context }) => {
    await page.setViewportSize(desktop);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/sign-in");
    expect(await snapshot(page)).toMatchObject({ dark: false, mode: "system", resolved: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => (await snapshot(page)).dark).toBe(true);
    await expect.poll(async () => (await snapshot(page)).resolved).toBe("dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(async () => (await snapshot(page)).dark).toBe(false);

    // A passive page (no theme control) follows OS changes and storage events as well.
    const passive = await context.newPage();
    await passive.emulateMedia({ colorScheme: "light" });
    await passive.goto("/definitely-missing-page");
    await expect(passive.getByRole("heading", { name: "Page not found" })).toBeVisible();
    expect(await passive.locator(".rendro-theme-control").count()).toBe(0);
    expect(await snapshot(passive)).toMatchObject({ dark: false, mode: "system" });
    await passive.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => (await snapshot(passive)).dark).toBe(true);
    await passive.emulateMedia({ colorScheme: "light" });
    await expect.poll(async () => (await snapshot(passive)).dark).toBe(false);

    // Another tab changes the saved preference; both the mounted and the passive page adopt it.
    await toggle(page).click();
    await expect.poll(async () => (await snapshot(page)).mode).toBe("dark");
    await expect.poll(async () => (await snapshot(passive)).mode).toBe("dark");
    expect(await snapshot(passive)).toMatchObject({ dark: true, resolved: "dark" });
    const third = await context.newPage();
    await third.goto("/sign-in");
    await toggle(third).click();
    await expect.poll(async () => (await snapshot(third)).mode).toBe("light");
    await expect.poll(async () => (await snapshot(page)).mode).toBe("light");
    expect(await snapshot(page)).toMatchObject({ dark: false, label: "Switch to system theme", title: "Theme: light" });
    await expect.poll(async () => (await snapshot(passive)).mode).toBe("light");
    // OS changes no longer move a pinned theme.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => matchMedia("(prefers-color-scheme: dark)").matches);
    await settleFrames(page);
    expect(await snapshot(page)).toMatchObject({ dark: false, mode: "light" });
    await third.close();
    await passive.close();
  });

  test("rapid switches keep the latest intent and animation failures or reduced motion switch directly", async ({ page }) => {
    await page.setViewportSize(desktop);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await page.goto("/sign-in");
    const click = (times: number) => page.evaluate(count => {
      const button = document.querySelector<HTMLElement>(".rendro-theme-control")!;
      for (let index = 0; index < count; index++) button.click();
      return localStorage.getItem("commentor-theme");
    }, times);
    // The preference is saved synchronously, before any snapshot commits or the page navigates.
    expect(await click(1)).toBe("dark");
    await expect.poll(async () => (await snapshot(page)).dark).toBe(true);
    // Three rapid activations cycle intended modes (dark → light → system → dark) without losing one.
    expect(await click(3)).toBe("dark");
    await expect.poll(async () => (await snapshot(page)).mode).toBe("dark");
    await expect.poll(async () => (await snapshot(page)).rippling).toBe(false);
    expect(await click(2)).toBe("system");
    await expect.poll(async () => (await snapshot(page)).mode).toBe("system");
    expect(await snapshot(page)).toMatchObject({ dark: false, stored: "system", label: "Switch to dark theme" });

    // Unsupported View Transitions, a throwing snapshot and rejected promises all switch directly.
    for (const [name, install] of [
      ["unsupported", () => { (document as unknown as { startViewTransition?: unknown }).startViewTransition = undefined; }],
      ["throws", () => { (document as unknown as { startViewTransition: () => never }).startViewTransition = () => { throw new Error("snapshot rejected"); }; }],
      ["rejects", () => {
        (document as unknown as { startViewTransition: () => unknown }).startViewTransition = () => {
          const failure = () => { const promise = Promise.reject(new Error("animation failed")); promise.catch(() => undefined); return promise; };
          return { ready: failure(), updateCallbackDone: failure(), finished: failure(), skipTransition() {} };
        };
      }],
    ] as const) {
      await page.goto("/sign-in");
      await page.evaluate(() => localStorage.removeItem("commentor-theme"));
      await page.reload();
      await page.evaluate(install);
      await click(1);
      await expect.poll(async () => (await snapshot(page)).dark, { message: name }).toBe(true);
      expect(await snapshot(page), name).toMatchObject({ mode: "dark", stored: "dark", rippling: false });
    }

    // Reduced motion applies the new theme synchronously, never entering the ripple.
    await page.goto("/sign-in");
    await page.evaluate(() => localStorage.removeItem("commentor-theme"));
    await page.reload();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const immediate = await page.evaluate(() => {
      document.querySelector<HTMLElement>(".rendro-theme-control")!.click();
      const root = document.documentElement;
      return { dark: root.classList.contains("dark"), rippling: root.classList.contains("rendro-theme-rippling") };
    });
    expect(immediate).toEqual({ dark: true, rippling: false });
  });

  test("unavailable preference storage keeps the control usable and the latest theme follows navigation", async ({ page, context, baseURL, seed }) => {
    await page.setViewportSize(desktop);
    await page.emulateMedia({ colorScheme: "light" });
    const blocked = await context.newPage();
    await blocked.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    });
    const errors: string[] = [];
    blocked.on("pageerror", error => errors.push(error.message));
    await blocked.goto("/sign-in");
    expect(await snapshot(blocked)).toMatchObject({ dark: false, mode: "system", stored: "unavailable" });
    await toggle(blocked).click();
    await expect.poll(async () => (await snapshot(blocked)).mode).toBe("dark");
    expect(await snapshot(blocked)).toMatchObject({ dark: true, label: "Switch to light theme" });
    await toggle(blocked).click();
    await expect.poll(async () => (await snapshot(blocked)).mode).toBe("light");
    expect(errors).toEqual([]);
    await blocked.close();

    // Full navigation and history traversal retain the latest saved choice.
    await signInSeeded(context, baseURL, seed, "owner");
    await page.goto(`/organizations/${seed.organizationId}/settings`);
    await shellReady(page);
    await toggle(page).click();
    await expect.poll(async () => (await snapshot(page)).mode).toBe("dark");
    await page.goto("/account/security");
    expect(await snapshot(page)).toMatchObject({ dark: true, mode: "dark" });
    await toggle(page).click();
    await expect.poll(async () => (await snapshot(page)).mode).toBe("light");
    await page.goBack();
    await expect(page).toHaveURL(/\/settings$/);
    await expect.poll(async () => (await snapshot(page)).mode).toBe("light");
    expect(await snapshot(page)).toMatchObject({ dark: false, stored: "light" });
    await page.goForward();
    await expect(page).toHaveURL(/\/account\/security$/);
    await expect.poll(async () => (await snapshot(page)).mode).toBe("light");
  });
});
