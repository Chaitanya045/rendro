import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { desktop, mobile, signInSeeded } from "./shell-helpers";
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

/** Pages hydrate data after they load (the security page lists sign-in methods); judge the layout once it has settled. */
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
const signedInPaths = ["/home", "/account/security"];

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
    const widths = await ligatureWidths(page, ["close", "folder_open", "edit_document", "mark_email_read"]);
    for (const width of widths) expect(width).toBeCloseTo(20, 0);
    // Without the font the same names are several times wider; that is what the blocked test contains.
    const [fallback] = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.cssText = 'position:absolute;white-space:nowrap;font:400 20px "No Such Family",sans-serif';
      probe.textContent = "edit_document";
      document.body.append(probe);
      return [probe.getBoundingClientRect().width];
    });
    expect(fallback).toBeGreaterThan(100);
  });

  test("signed-in pages and the document shell use only self-hosted fonts and decorative icons", async ({ page, context, baseURL, seed }) => {
    test.setTimeout(120_000);
    await signInSeeded(context, baseURL, seed, "owner");
    const tracked = trackFonts(page);
    for (const path of signedInPaths) {
      const response = await page.goto(path);
      expect(response?.headers()["content-security-policy"], path).not.toMatch(fontCdn);
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
  const withoutSafety = ":where(.material-symbols-outlined){width:auto!important;overflow:visible!important;white-space:normal!important}";

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
      for (const path of signedInPaths) {
        await page.goto(path);
          expect(await settledOverflows(page), `${path} (${name})`).toEqual([]);
      }
    });
  }

  test("the overflow check detects the failure it guards against", async ({ page }) => {
    await blockFonts(page);
    // The repository shell's toolbar icons are ligature names in a fallback font: only the icon box keeps them inside.
    const { open } = JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
    await page.goto(`/r/${open.owner}/${open.name}`);
    await expect(page.locator("#shell-toggle")).toBeVisible();
    expect(await overflows(page)).toEqual([]);
    // The page's policy admits only nonced styles: the override carries the document's nonce.
    await page.evaluate(css => {
      const style = document.createElement("style");
      style.nonce = document.querySelector<HTMLStyleElement>("style[nonce]")?.nonce ?? "";
      style.textContent = css;
      document.head.append(style);
    }, withoutSafety);
    expect((await overflows(page)).length).toBeGreaterThan(0);
  });
});
