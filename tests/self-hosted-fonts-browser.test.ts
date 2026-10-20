import { getRequestListener } from "@hono/node-server";
import type * as NodeServer from "@hono/node-server";
import type { Page } from "playwright";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fontManifest } from "@/routes/font-manifest";
import { mockSecurityBackend } from "./fixtures/security-headers";
import { createBrowserHarness } from "./helpers/browser";

vi.mock("@hono/node-server", async importOriginal => ({ ...await importOriginal<typeof NodeServer>(), serve: vi.fn() }));
import { app } from "@/index";

const harness = createBrowserHarness();
beforeAll(async () => {
  const listener = getRequestListener((request, env) => app.fetch(request, env));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});
afterEach(() => { vi.restoreAllMocks(); });

const faces = (page: Page) => page.evaluate(async () => {
  await document.fonts.ready;
  return [...document.fonts].map(face => ({ family: face.family.replaceAll('"', ""), weight: face.weight, status: face.status }));
});
const measure = (page: Page, css: string, text: string) => page.evaluate(({ css, text }) => {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;white-space:nowrap;${css}`;
  probe.textContent = text;
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}, { css, text });

async function open(blocked = false) {
  mockSecurityBackend();
  const page = await harness.newPage();
  const fonts: { path: string; status: number; type: string | null; cache: string | null }[] = [];
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/fonts/")) fonts.push({ path: url.pathname, status: response.status(), type: response.headers()["content-type"] ?? null, cache: response.headers()["cache-control"] ?? null });
  });
  if (blocked) await page.route("**/fonts/*.woff2", route => route.abort());
  const navigation = await page.goto(`${harness.origin}/sign-in`);
  return { page, fonts, navigation: navigation! };
}

describe("self-hosted fonts in Chromium", () => {
  it("serves the hashed fonts as immutable woff2 and applies them", async () => {
    const { page, fonts, navigation } = await open();
    const state = await faces(page);
    expect(state.filter(face => face.status === "error")).toEqual([]);
    expect(state.filter(face => face.status === "loaded").map(face => face.family)).toEqual(expect.arrayContaining(["Inter", "Material Symbols Outlined"]));
    expect(fonts.map(font => font.path).sort()).toEqual([...new Set([`/fonts/${fontManifest.inter.faces[0].file}`, `/fonts/${fontManifest.icons.file}`])].sort());
    for (const font of fonts) expect(font).toMatchObject({ status: 200, type: "font/woff2", cache: "public, max-age=31536000, immutable" });

    const csp = navigation.headers()["content-security-policy"];
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/googleapis|gstatic/);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^Inter,/);
    expect(await page.evaluate(() => document.fonts.check('400 14px Inter') && document.fonts.check('20px "Material Symbols Outlined"'))).toBe(true);
    // Preloads are anonymous-CORS so the later font fetch reuses them rather than downloading twice.
    expect(await page.locator('link[rel=preload][as=font]').evaluateAll(links => links.map(link => [link.getAttribute("type"), link.hasAttribute("crossorigin")]))).toEqual([["font/woff2", true], ["font/woff2", true]]);
  });

  it("renders ligature names as single glyphs and keeps the design's weights", async () => {
    const { page } = await open();
    await faces(page);
    for (const name of ["close", "folder_open", "password"]) expect(await measure(page, 'font:400 20px "Material Symbols Outlined"', name)).toBeCloseTo(20, 0);
    expect(await measure(page, 'font:400 20px "No Such Family",sans-serif', "edit_document")).toBeGreaterThan(100);
    // Four declared weights; others snap to them exactly as they did with Google Fonts' four faces.
    const widths = Object.fromEntries(await Promise.all([400, 500, 600, 650, 700, 800].map(async weight => [weight, await measure(page, `font:${weight} 16px Inter`, "Documentation that ships")])));
    expect(widths[650]).toBe(widths[700]);
    expect(widths[800]).toBe(widths[700]);
    expect(new Set([widths[400], widths[500], widths[600], widths[700]]).size).toBe(4);
  });

  it("keeps icon boxes inside their controls when the fonts never load", async () => {
    const { page, fonts } = await open(true);
    expect(fonts).toEqual([]);
    expect((await faces(page)).some(face => face.status === "loaded")).toBe(false);
    const icons = await page.locator(".material-symbols-outlined").evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => [node.scrollWidth > node.clientWidth, node.getBoundingClientRect().width, parseFloat(getComputedStyle(node).fontSize)]));
    expect(icons.length).toBeGreaterThan(0);
    for (const [clipped, width, size] of icons) {
      expect(width).toBeLessThanOrEqual((size as number) * 2.5);
      expect(clipped).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const buttonOverflow = await page.locator("button, a.button").evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).display !== "inline").map(node => node.outerHTML.slice(0, 80)));
    expect(buttonOverflow).toEqual([]);
  });
});
