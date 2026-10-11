import AxeBuilder from "@axe-core/playwright";
import { getRequestListener } from "@hono/node-server";
import type { User } from "better-auth/types";
import { build } from "esbuild";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { faviconAssets } from "@/routes/favicon";
import { securityHeaders } from "@/middleware/security-headers";
import organizationPages from "@/routes/organization-pages";
import { managementPagesSource } from "../scripts/management-pages-source";
import { managementAccessFixture } from "./fixtures/management-access";
import { browserStep, createBrowserHarness, waitForSettled } from "./helpers/browser";

const harness = createBrowserHarness();
const user = { id: "user-a", name: "Owner", email: "owner@example.test" } as User;
const organizationName = `Acme & <img src=x onerror="alert(1)"> 'Partners'`;
const organization = {
  id: "org-a", name: organizationName, slug: "acme",
  members: [{ id: "member-a", userId: user.id, role: "owner", user }], teams: [],
};

beforeAll(async () => {
  const access = managementAccessFixture(organization, user);
  // The page guard fetches Convex on the server before any browser API requests.
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) =>
    Promise.resolve(access(input) ?? new Response(null, { status: 404 }))));
  // Build source in memory so this suite also runs before build:assets in clean CI.
  const assets = new Map<string, string>();
  for (const [path, entry] of [
    ["/management-query.js", "src/management-query/browser.ts"],
    ["/select.js", "src/ui/select-browser.ts"],
  ]) {
    const bundle = await browserStep(`bundle ${path}`, () => build({
      entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser",
    }));
    assets.set(path, bundle.outputFiles[0].text);
  }
  assets.set("/management-pages.js", managementPagesSource());
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", securityHeaders);
  app.use("*", async (c, next) => { c.set("user", user); await next(); });
  for (const [path, body] of assets) app.get(path, c => c.body(body, 200, { "Content-Type": "text/javascript" }));
  for (const [path, contentType] of Object.entries(faviconAssets)) {
    const body = await readFile(`public${path}`);
    app.get(path, c => c.body(body, 200, { "Content-Type": contentType }));
  }
  app.get("/api/auth/organization/get-full-organization", c => c.json(organization));
  app.get("/api/auth/organization/list", c => c.json([organization]));
  app.get("/api/auth/organization/list-invitations", c => c.json([]));
  app.get("/api/rendro/management/access", c => access(c.req.raw)!);
  app.get("/api/rendro/projects", c => c.json({ projects: [] }));
  app.get("/api/rendro/management/recent-deployment", c => c.json({ deployment: null }));
  app.route("/", organizationPages);
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((request, response) => {
    void listener(request, response).catch(error => response.destroy(error as Error));
  });
});

afterAll(() => { vi.unstubAllGlobals(); });

it.each([375, 768, 1440])("exposes the org name in accessibility snapshots and passes axe at %spx", async width => {
  const page = await harness.newPage({ viewport: { width, height: 900 } });
  const cspViolations: string[] = [];
  const pageErrors: string[] = [];
  await page.exposeFunction("recordCspViolation", (directive: string) => { cspViolations.push(directive); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", event => {
      (window as unknown as { recordCspViolation: (value: string) => void }).recordCspViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => { if (response.status() >= 400) pageErrors.push(`${response.status()} ${response.url()}`); });
  // Keep font fetching deterministic and offline, matching the CSP browser suite.
  await page.route(url => url.hostname === "fonts.googleapis.com", route => route.fulfill({ contentType: "text/css", body: "" }));
  const response = await browserStep("load organization overview", () => page.goto(harness.origin + "/organizations/org-a"));
  expect(response?.status()).toBe(200);
  const nonce = response!.headers()["content-security-policy"].match(/'nonce-([^']+)'/)![1];
  expect(await page.locator("script:not([src])").evaluateAll((elements, expected) => elements.every(element => (element as HTMLElement).nonce === expected), nonce)).toBe(true);
  expect(await page.locator("style").evaluateAll(elements => elements.find(element => element.textContent?.includes(".cp-org-name"))?.nonce)).toBe(nonce);
  await browserStep("finish overview hydration", () => page.getByText("No deployment has been committed yet.", { exact: true }).waitFor()).catch(async error => { throw new Error(JSON.stringify({ pageErrors, cspViolations, snapshot: await page.locator("body").ariaSnapshot() }), { cause: error }); });

  const trigger = page.locator("#cp-org-switcher");
  const label = trigger.locator("[data-org-name]");
  expect(await label.textContent()).toBe(organizationName);
  expect(await label.locator("img").count()).toBe(0);
  const expectedName = `${organizationName} , switch organization`;
  // ariaSnapshot computes the accessible name using the browser's rendered DOM.
  expect(await trigger.ariaSnapshot()).toContain(`button ${JSON.stringify(expectedName)}`);
  expect(await label.evaluate(element => getComputedStyle(element).display)).not.toBe("none");
  expect(await label.evaluate(element => getComputedStyle(element).position)).toBe(width <= 520 ? "absolute" : "static");
  await waitForSettled(page);
  // The font CSS is an empty fixture; do not let axe refetch it via CSP-blocked connect-src.
  const overviewAxe = await browserStep("axe overview audit", () => new AxeBuilder({ page }).options({ preload: false }).analyze());
  expect(overviewAxe.violations).toEqual([]);

  await trigger.click();
  await browserStep("load switcher menu", () => page.getByRole("menuitem", { name: organizationName, exact: true }).waitFor());
  expect(await trigger.ariaSnapshot()).toContain(`button ${JSON.stringify(expectedName)} [expanded]`);
  await page.keyboard.press("Escape");
  expect(await trigger.getAttribute("aria-expanded")).toBe("false");

  if (width <= 760) {
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Organization navigation" });
    const drawerSwitcher = drawer.locator(".cp-drawer-org");
    expect(await drawerSwitcher.ariaSnapshot()).toContain(`link ${JSON.stringify(`${organizationName} Switch organization`)}`);
    expect(await drawerSwitcher.locator("img").count()).toBe(0);
    await waitForSettled(page);
    const drawerAxe = await browserStep("axe expanded drawer audit", () => new AxeBuilder({ page }).options({ preload: false }).analyze());
    expect(drawerAxe.violations).toEqual([]);
    await drawer.getByRole("button", { name: "Close navigation" }).click();
    expect(await trigger.ariaSnapshot()).toContain(`button ${JSON.stringify(expectedName)}`);
  }
  expect(pageErrors).toEqual([]);
  expect(cspViolations).toEqual([]);
});

it("serves every favicon linked by the production shell", async () => {
  const page = await harness.newPage();
  for (const [path, contentType] of Object.entries(faviconAssets)) {
    const response = await page.request.get(harness.origin + path);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe(contentType);
    expect(await response.body()).toEqual(await readFile(`public${path}`));
  }
});
