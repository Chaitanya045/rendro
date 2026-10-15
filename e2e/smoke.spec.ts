import { test, expect } from "./fixtures";
import { publicationSlug } from "./services";

const publication = `/p/${publicationSlug}`;

test("landing uses a fresh CSP nonce and renders without CSP violations", async ({ page, cspViolations }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your docs should ship with your code.");
  const policy = response?.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy.split(";").find(directive => directive.trim().startsWith("script-src "))).not.toContain("'unsafe-inline'");
  expect(response?.headers()["cache-control"]).toBe("no-store");
  const scriptNonces = await page.locator("script:not([src])").evaluateAll(scripts => scripts.map(script => (script as HTMLScriptElement).nonce));
  expect(scriptNonces.length).toBeGreaterThan(0);
  expect(scriptNonces.every(value => value === nonce)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  expect(cspViolations).toEqual([]);
  const reloaded = await page.reload();
  expect(reloaded?.headers()["content-security-policy"]).not.toContain(`'nonce-${nonce}'`);
  expect(cspViolations).toEqual([]);
});

test("sign-in renders through the Worker", async ({ page, cspViolations }) => {
  const response = await page.goto("/sign-in");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Sign in to Rendro" })).toBeVisible();
  await expect(page.getByLabel("Work email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  expect(cspViolations).toEqual([]);
});

test("publication loads local S3 HTML and SVG inside an opaque document", async ({ page }) => {
  const [document, asset, shell] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`${publication}/files/index.html`)),
    page.waitForResponse(response => response.url().endsWith(`${publication}/files/diagram.svg`)),
    page.goto(publication),
  ]);
  expect(shell?.status()).toBe(200);
  expect(document.status()).toBe(200);
  expect(document.headers()["content-type"]).toContain("text/html");
  expect(document.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
  expect(document.headers()["content-security-policy"]).not.toContain("allow-same-origin");
  expect(document.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  const frame = page.frameLocator("#content-frame");
  await expect(frame.getByRole("heading", { name: "Publication from local storage" })).toBeVisible();
  await expect(frame.locator("body")).toHaveAttribute("data-publisher-ready", "yes");
  expect(await frame.locator("body").evaluate(() => window.origin)).toBe("null");
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toBe("image/svg+xml");
  expect(asset.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(frame.getByAltText("Local diagram")).toHaveJSProperty("naturalWidth", 80);
});

test("direct SVG navigation retains publisher isolation", async ({ page }) => {
  const response = await page.goto(`${publication}/files/diagram.svg`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toBe("image/svg+xml");
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("sandbox");
  expect(policy).not.toContain("allow-same-origin");
  expect(policy).toContain("frame-ancestors 'self'");
  expect(await page.evaluate(() => window.origin)).toBe("null");
});

test("missing assets are empty and untyped; missing documents remain HTML", async ({ page, baseURL }) => {
  await page.goto("/");
  // Browser fetch, so even failures go through the context origin guard.
  for (const path of ["/missing.svg", `${publication}/files/missing.svg`, `${publication}/files/deleted.svg`, "/p/unknown/files/diagram.svg"]) {
    const result = await page.evaluate(async url => {
      const response = await fetch(url);
      return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
    }, `${baseURL}${path}`);
    expect(result, path).toEqual({ status: 404, type: null, body: "" });
  }
  const document = await page.goto(`${publication}/files/missing.html`);
  expect(document?.status()).toBe(404);
  expect(document?.headers()["content-type"]).toContain("text/html");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
