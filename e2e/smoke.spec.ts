import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";
import type { RepoFixtures } from "./repo-fixtures";

/** The public repository the read path serves (#234); its frames are opaque documents like any publisher page. */
const open = () => (JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures).open;
const repo = () => `/r/${open().owner}/${open().name}`;
const pinned = () => `${repo()}/@${open().commit}`;

test("landing uses a fresh CSP nonce and renders without CSP violations", async ({ page, cspViolations }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Docs straight from your GitHub repository.");
  const policy = response?.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy.split(";").find(directive => directive.trim().startsWith("script-src "))).not.toContain("'unsafe-inline'");
  expect(response?.headers()["cache-control"]).toBe("private, no-store");
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

test("a repository document loads inside an opaque frame with its SVG", async ({ page }) => {
  const [document, asset, shell] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`${pinned()}/files/docs/index.md`)),
    page.waitForResponse(response => response.url().endsWith("/files/docs/img/logo.svg")),
    page.goto(repo()),
  ]);
  expect(shell?.status()).toBe(200);
  expect(document.status()).toBe(200);
  expect(document.headers()["content-type"]).toContain("text/html");
  expect(document.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
  expect(document.headers()["content-security-policy"]).not.toContain("allow-same-origin");
  expect(document.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  const frame = page.frameLocator("#content-frame");
  await expect(frame.getByRole("heading", { name: "Open home", level: 1 })).toBeVisible();
  expect(await frame.locator("body").evaluate(() => window.origin)).toBe("null");
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toBe("image/svg+xml");
  expect(asset.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(frame.getByAltText("Logo")).toHaveJSProperty("naturalWidth", 64);
});

test("direct SVG navigation retains document isolation", async ({ page }) => {
  const response = await page.goto(`${pinned()}/files/docs/img/logo.svg`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toBe("image/svg+xml");
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("sandbox");
  expect(policy).not.toContain("allow-same-origin");
  expect(await page.evaluate(() => window.origin)).toBe("null");
});

test("missing assets are empty and untyped; missing documents remain HTML", async ({ page, baseURL }) => {
  await page.goto("/");
  // Browser fetch, so even failures go through the context origin guard.
  for (const path of ["/missing.svg", `${pinned()}/files/docs/img/missing.svg`, "/r/nobody/nothing/files/docs/img/logo.svg"]) {
    const result = await page.evaluate(async url => {
      const response = await fetch(url);
      return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
    }, `${baseURL}${path}`);
    expect(result, path).toEqual({ status: 404, type: null, body: "" });
  }
  const document = await page.goto(`${pinned()}/files/docs/missing.md`);
  expect(document?.status()).toBe(404);
  expect(document?.headers()["content-type"]).toContain("text/html");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
