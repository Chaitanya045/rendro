import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { desktop, mobile, provision, signInSeeded } from "./shell-helpers";
import type { RepoFixtures } from "./repo-fixtures";

/** The public repository the read path serves (#234), pinned to the commit its frames are served at. */
const open = () => (JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures).open;
const repo = () => `/r/${open().owner}/${open().name}`;
const pinned = () => `${repo()}/@${open().commit}`;

async function notFound(page: Page, cspViolations: string[], viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const response = await page.goto("/definitely-missing/page");
  expect(response?.status()).toBe(404);
  expect(response?.headers()["content-type"]).toContain("text/html");
  expect(response?.headers()["cache-control"]).toMatch(/no-store/);
  const policy = response?.headers()["content-security-policy"] ?? "";
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(policy).toContain("frame-ancestors");
  // Every inline script and style the error page ships carries the response nonce.
  expect(await page.locator("script:not([src]), style").evaluateAll((nodes, expected) => nodes.every(node => (node as HTMLElement).nonce === expected), nonce)).toBe(true);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.locator(".eyebrow")).toHaveText("Error 404");
  await expect(page.locator(".path")).toHaveText("/definitely-missing/page");
  await expect(page.locator("a.brand")).toBeVisible();
  expect(cspViolations).toEqual([]);
  // Recovery link leaves the error page for a usable destination.
  await page.getByRole("link", { name: "Go to Rendro" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible();
  // Go back returns to the previous document when one exists.
  await page.goto("/definitely-missing/other");
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("direct entry", () => {
  test.use({ viewport: desktop });

  test("authenticated root, home and repository URLs load without a server error", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const statuses: number[] = [];
    page.on("response", response => { if (response.request().resourceType() === "document" && response.request().frame() === page.mainFrame()) statuses.push(response.status()); });
    // The signed-in root redirects to the home.
    await page.goto("/");
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole("heading", { name: "Welcome, E2E owner", level: 1 })).toBeVisible();
    await expect(page.locator("body")).toContainText("owner@example.test");
    await page.goto(repo());
    await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "Open home", level: 1 })).toBeVisible();
    expect(statuses.every(status => status < 400 || [301, 302, 303, 307].includes(status)), JSON.stringify(statuses)).toBe(true);
    expect(statuses).not.toContain(503);
  });

  test("an anonymous home redirects to sign-in and preserves the destination", async ({ page }) => {
    await page.goto("/home");
    await expect(page).toHaveURL(/\/sign-in\?/);
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/home");
    await expect(page.getByRole("heading", { name: "Sign in to Rendro" })).toBeVisible();
  });
});

/** The signed-in home of a fresh user: its account, the `/r/` explainer, Account security and Sign out. */
async function signedInHome(page: Page, cspViolations: string[], viewport: { width: number; height: number }, label: string) {
  await page.setViewportSize(viewport);
  const user = await provision(page, label);
  await page.goto("/home");
  await expect(page.getByRole("heading", { name: /^Welcome, Shell / })).toBeVisible();
  await expect(page.locator("body")).toContainText(user.email);
  const open = page.getByRole("region", { name: "Open a repository's documentation" });
  await expect(open).toContainText("/r/{owner}/{repo}");
  await expect(open).toContainText("/r/acme/handbook");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("link", { name: "Account security" }).click();
  await expect(page).toHaveURL(/\/account\/security$/);
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(page).toHaveURL(/\/home$/);

  // The page's own sign-out tears the session down in place.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "You're signed out", level: 1 })).toBeVisible();
  await page.goto("/home");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fhome$/);
  expect(cspViolations).toEqual([]);
}

test.describe("signed-in home", () => {
  test("explains how to open a repository, links to account security and signs out at 1440", async ({ page, cspViolations }, info) => {
    await signedInHome(page, cspViolations, desktop, `home-1440-${info.project.name}`);
  });

  test("explains how to open a repository, links to account security and signs out at 375", async ({ page, cspViolations }, info) => {
    await signedInHome(page, cspViolations, mobile, `home-375-${info.project.name}`);
  });
});

test.describe("error surfaces", () => {
  test("standalone not-found page renders under the nonce policy and recovers by link and Go back at 1440", async ({ page, cspViolations }) => {
    await notFound(page, cspViolations, desktop);
  });

  test("standalone not-found page renders under the nonce policy and recovers by link and Go back at 375", async ({ page, cspViolations }) => {
    await notFound(page, cspViolations, mobile);
  });

  test("a missing document inside the viewer frame hides the wordmark and recovers in the top window", async ({ page }) => {
    await page.setViewportSize(desktop);
    await page.goto("/sign-in");
    await page.evaluate(path => {
      const frame = document.createElement("iframe");
      frame.id = "error-frame"; frame.src = path; frame.style.cssText = "width:800px;height:600px";
      document.body.append(frame);
    }, `${pinned()}/files/docs/missing.md`);
    const frame = page.frameLocator("#error-frame");
    await expect(frame.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(frame.locator("html")).toHaveClass(/framed/);
    await expect(frame.locator("a.brand")).toBeHidden();
    const recovery = frame.getByRole("link", { name: "Go to Rendro" });
    await expect(recovery).toHaveAttribute("target", "_top");
    await recovery.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#error-frame")).toHaveCount(0);
  });

  test("asset errors stay plain and error pages are never cached", async ({ page, baseURL }) => {
    await page.goto("/sign-in");
    for (const path of ["/missing-image.png", `${pinned()}/files/docs/img/nothing.svg`, "/r/nobody/nothing/files/a.css"]) {
      const result = await page.evaluate(async url => {
        const response = await fetch(url);
        return { status: response.status, type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), body: await response.text() };
      }, `${baseURL}${path}`);
      expect(result.status, path).toBe(404);
      expect(result.type, path).toBeNull();
      expect(result.body, path).toBe("");
      expect(result.cache ?? "", path).toMatch(/no-store/);
    }
    const document = await page.request.get(`${pinned()}/files/docs/missing.md`, { headers: { Accept: "text/html" } });
    expect(document.status()).toBe(404);
    expect(document.headers()["cache-control"]).toMatch(/no-store/);
    expect(document.headers()["content-type"]).toContain("text/html");
  });
});
