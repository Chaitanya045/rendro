import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { desktop, mobile, shellReady, signInSeeded } from "./shell-helpers";
import type { RepoFixtures } from "./repo-fixtures";

const fontCdn = /fonts\.(?:googleapis|gstatic)\.com/;
const iconFont = "Material Symbols Outlined";

/** Every font request and response the page makes, to prove what is (not) fetched and how it is cached. */
function trackFonts(page: Page) {
  const origins = new Set<string>();
  const responses: { path: string; status: number; type: string | null; cache: string | null }[] = [];
  page.on("request", request => origins.add(new URL(request.url()).origin));
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/fonts/")) {
      responses.push({ path: url.pathname, status: response.status(), type: response.headers()["content-type"] ?? null, cache: response.headers()["cache-control"] ?? null });
    }
  });
  return { origins, responses };
}

const faces = (page: Page) => page.evaluate(async () => {
  await document.fonts.ready;
  return [...document.fonts].map(face => ({ family: face.family.replaceAll('"', ""), status: face.status }));
});

/** Width of a ligature name in the icon font: one em with the real font, several without it. */
const ligatureWidths = (page: Page, names: string[]) => page.evaluate(({ names, family }) => names.map(name => {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:400 20px "${family}"`;
  probe.textContent = name;
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}), { names, family: iconFont });

/** Controls whose content spills out of their own box, and pages that scroll sideways. */
const overflows = (page: Page) => page.evaluate(() => {
  const found: string[] = [];
  const label = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).join(".")}` : ""}`;
  for (const element of document.querySelectorAll<HTMLElement>("button, a, summary, select, label, [role=button], [role=menuitem], [role=option], .material-symbols-outlined")) {
    if (!element.getClientRects().length) continue;
    const style = getComputedStyle(element);
    // Icon boxes clip their own ligature text by design; what matters is that nothing else is pushed out.
    if (!element.matches(".material-symbols-outlined") && style.display !== "inline" && !/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1) {
      found.push(`${label(element)} scrolls ${element.scrollWidth}>${element.clientWidth}`);
    }
    const box = element.getBoundingClientRect();
    for (const child of element.children) {
      const rect = child.getBoundingClientRect();
      if (rect.width > 2 && (rect.left < box.left - 2 || rect.right > box.right + 2)) found.push(`${label(child)} leaves ${label(element)}`);
    }
  }
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) {
    const rect = dialog.getBoundingClientRect();
    if (rect.left < 0 || rect.right > innerWidth) found.push(`${label(dialog)} leaves the viewport`);
  }
  if (document.documentElement.scrollWidth > innerWidth) found.push(`page scrolls sideways ${document.documentElement.scrollWidth}>${innerWidth}`);
  return found;
});

/** Management pages hydrate data after the shell is ready; judge the layout once it has settled. */
const settledOverflows = async (page: Page) => {
  let last: string[] = [];
  // On timeout the caller's assertion reports the remaining violations in full.
  await expect.poll(async () => (last = await overflows(page)).length).toBe(0).catch(() => undefined);
  return last;
};

/** Icon text must be decorative: aria-hidden itself or inside an aria-hidden ancestor. */
const exposedIcons = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".material-symbols-outlined")]
  .filter(icon => !icon.closest('[aria-hidden="true"]')).map(icon => icon.outerHTML.slice(0, 120)));

const publicPaths = ["/", "/sign-in", "/sign-up", "/forgot-password", "/no-such-page"];
const managementPaths = (organization: string, project: string) => [
  `/organizations/${organization}`, `/organizations/${organization}/projects`, `/organizations/${organization}/people`,
  `/organizations/${organization}/teams`, `/organizations/${organization}/settings`, `/organizations/${organization}/api-keys`,
  `/organizations/${organization}/projects/${project}`, "/account/security",
];

test.describe("self-hosted fonts", () => {
  test.use({ viewport: desktop });

  test("public pages render real icons from same-origin immutable fonts with no font CDN", async ({ page }) => {
    const tracked = trackFonts(page);
    for (const path of publicPaths) {
      const response = await page.goto(path);
      const csp = response?.headers()["content-security-policy"] ?? "";
      expect(csp, path).not.toMatch(fontCdn);
      expect(csp.match(/font-src [^;]+/)?.[0], path).toBe("font-src 'self'");
      expect(await page.content(), path).not.toMatch(fontCdn);
      const state = await faces(page);
      expect(state.filter(face => face.status === "error"), `${path} font errors`).toEqual([]);
      expect(state.some(face => face.family === "Inter" && face.status === "loaded"), `${path} Inter`).toBe(true);
      const icons = await page.locator(".material-symbols-outlined").count();
      expect(state.some(face => face.family === iconFont && face.status === "loaded"), `${path} icon font`).toBe(icons > 0);
      expect(await overflows(page), path).toEqual([]);
      expect(await exposedIcons(page), path).toEqual([]);
    }
    expect([...tracked.origins].filter(origin => origin !== new URL(page.url()).origin)).toEqual([]);
    expect(tracked.responses.length).toBeGreaterThan(0);
    for (const response of tracked.responses) {
      expect(response).toMatchObject({ status: 200, type: "font/woff2", cache: "public, max-age=31536000, immutable" });
    }
  });

  test("the loaded icon font turns ligature names into single glyphs", async ({ page }) => {
    await page.goto("/sign-in");
    await faces(page);
    const widths = await ligatureWidths(page, ["close", "unfold_more", "space_dashboard", "mark_email_read"]);
    for (const width of widths) expect(width).toBeCloseTo(20, 0);
    // Without the font the same names are several times wider; that is what the blocked test contains.
    const [fallback] = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.cssText = 'position:absolute;white-space:nowrap;font:400 20px "No Such Family",sans-serif';
      probe.textContent = "unfold_more";
      document.body.append(probe);
      return [probe.getBoundingClientRect().width];
    });
    expect(fallback).toBeGreaterThan(100);
  });

  test("management pages and the document shell use only self-hosted fonts and decorative icons", async ({ page, context, baseURL, seed }) => {
    test.setTimeout(120_000);
    await signInSeeded(context, baseURL, seed, "owner");
    const tracked = trackFonts(page);
    for (const path of managementPaths(seed.organizationId, seed.projectId)) {
      const response = await page.goto(path);
      expect(response?.headers()["content-security-policy"], path).not.toMatch(fontCdn);
      if (path.startsWith("/organizations")) await shellReady(page);
      const state = await faces(page);
      expect(state.filter(face => face.status === "error"), `${path} font errors`).toEqual([]);
      expect(state.some(face => face.family === iconFont && face.status === "loaded"), `${path} icon font`).toBe(true);
      expect(await ligatureWidths(page, ["close"]), path).toEqual([expect.closeTo(20, 0)]);
      expect(await overflows(page), path).toEqual([]);
      expect(await exposedIcons(page), path).toEqual([]);
    }
    // The repository shell (tree rows, share/theme controls) loads the same fonts with its own weights.
    const { open } = JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
    await page.goto(`/r/${open.owner}/${open.name}`);
    await expect(page.locator(".tree-item").first()).toBeVisible();
    expect((await faces(page)).some(face => face.family === iconFont && face.status === "loaded")).toBe(true);
    expect(await exposedIcons(page)).toEqual([]);
    expect(await page.locator(".tree-item .material-symbols-outlined").evaluateAll(icons => icons.every(icon => icon.scrollWidth <= icon.clientWidth))).toBe(true);
    expect([...tracked.origins].filter(origin => origin !== new URL(page.url()).origin)).toEqual([]);
    for (const response of tracked.responses) expect(response).toMatchObject({ status: 200, type: "font/woff2", cache: "public, max-age=31536000, immutable" });
  });
});

test.describe("layout without the icon font", () => {
  const blockFonts = (page: Page) => page.route("**/fonts/*.woff2", route => route.abort("blockedbyclient"));
  const withoutSafety = ":where(.material-symbols-outlined){width:auto!important;overflow:visible!important;white-space:normal!important}.dialog-close::before{width:auto!important;overflow:visible!important}";

  for (const [name, viewport] of [["desktop", desktop], ["mobile", mobile]] as const) {
    test(`no control overflows its box with every font blocked (${name})`, async ({ page, context, baseURL, seed }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport);
      await blockFonts(page);
      for (const path of publicPaths) {
        await page.goto(path);
        expect((await faces(page)).some(face => face.status === "loaded"), `${path} nothing may load`).toBe(false);
        expect(await settledOverflows(page), `${path} (${name})`).toEqual([]);
      }
      await signInSeeded(context, baseURL, seed, "owner");
      for (const path of managementPaths(seed.organizationId, seed.projectId)) {
        await page.goto(path);
        if (path.startsWith("/organizations")) await shellReady(page);
        expect(await settledOverflows(page), `${path} (${name})`).toEqual([]);
      }
    });
  }

  test("form dialogs keep their close button inside with the icon font blocked", async ({ page, context, baseURL, seed }) => {
    test.setTimeout(120_000);
    await blockFonts(page);
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    for (const [path, trigger, dialog] of [["teams", "Create team", "#team-dialog"], ["people", "Invite people", "#invite-dialog"], ["projects", "Create project", "#project-dialog"], ["api-keys", "Create API key", "#key-dialog"]] as const) {
      await page.goto(`${base}/${path}`);
      await shellReady(page);
      await page.locator(".cp-page-actions").getByRole("button", { name: trigger, exact: true }).click();
      await expect(page.locator(dialog)).toBeVisible();
      expect(await overflows(page), path).toEqual([]);
      const close = page.locator(`${dialog} .dialog-close`);
      const [box, parent] = [(await close.boundingBox())!, (await page.locator(dialog).boundingBox())!];
      expect(box.width, path).toBeLessThanOrEqual(44);
      expect(box.x + box.width, path).toBeLessThanOrEqual(parent.x + parent.width + 1);
      expect(await close.evaluate(button => button.scrollWidth <= button.clientWidth)).toBe(true);
    }
  });

  test("the overflow check detects the failure it guards against", async ({ page, context, baseURL, seed }) => {
    await blockFonts(page);
    await signInSeeded(context, baseURL, seed, "owner");
    await page.goto(`/organizations/${seed.organizationId}/teams`);
    await shellReady(page);
    await page.locator(".cp-page-actions").getByRole("button", { name: "Create team", exact: true }).click();
    await expect(page.locator("#team-dialog")).toBeVisible();
    expect(await overflows(page)).toEqual([]);
    await page.addStyleTag({ content: withoutSafety });
    expect((await overflows(page)).length).toBeGreaterThan(0);
  });
});
