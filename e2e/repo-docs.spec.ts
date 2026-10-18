import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { desktop, signInSeeded } from "./shell-helpers";
import type { RepoFixtures } from "./repo-fixtures";

/**
 * Repository docs read through /r/ (#234): snapshots built by the P3b ingest pipeline from a fake GitHub (global setup),
 * authorized by the real control Worker (#243), whose permission mirror reads that fake GitHub. A public repository is
 * read anonymously; a private one by a granted reader through the capability cookie, with images through the frame's
 * asset ticket. Everyone else gets the same plain 404 as a repository that does not exist, and a membership webhook
 * revokes a reader for their very next view.
 */
test.use({ viewport: desktop });

const repos = (): RepoFixtures => JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
const content = (page: Page) => page.frameLocator("#content-frame");
const heading = (page: Page, name: string) => content(page).getByRole("heading", { name, level: 1 });
const frameUrl = (page: Page) => page.frames().find(frame => frame.name() === "content-frame")?.url() ?? "";
const logo = (page: Page) => content(page).getByRole("img", { name: "Logo" });

async function expectLogoRendered(page: Page) {
  await expect.poll(() => logo(page).evaluate(image => (image as HTMLImageElement).complete ? (image as HTMLImageElement).naturalWidth : 0)).toBe(64);
}

test.beforeEach(({ cspViolations }) => { void cspViolations; });
test.afterEach(({ cspViolations }) => {
  expect(cspViolations.filter(message => !/x-frame-options/i.test(message)), "CSP violations").toEqual([]);
});

test("an anonymous reader browses a public repository: entry page, sidebar titles, links, images and history", async ({ page }) => {
  const { open } = repos();
  const response = await page.goto(`/r/${open.owner}/${open.name}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toBe("private, no-cache");
  // The shell points Chromium at same-origin speculation rules (#245).
  expect(response?.headers()["speculation-rules"]).toBe('"/speculation-rules/repo.json"');
  const rules = await page.request.get("/speculation-rules/repo.json");
  expect(rules.status()).toBe(200);
  expect(rules.headers()["content-type"]).toBe("application/json; charset=utf-8");
  expect(await rules.json()).toMatchObject({ prefetch: [{ source: "document", eagerness: "moderate" }] });
  await expect(heading(page, "Open home")).toBeVisible();
  await expect(page.locator(".tree-item.active .tree-label")).toHaveText("Open home");
  // The branch view keeps its URL; the frame is pinned to the commit the branch served.
  expect(frameUrl(page)).toMatch(new RegExp(`/r/${open.owner}/${open.name}/@${open.commit}/files/docs/index\\.md$`));
  await expectLogoRendered(page);
  await expect(content(page).locator(".markdown-alert-tip")).toContainText("Rendered once, at ingest.");

  // A link inside the rendered page opens through the shell, as a new history entry.
  await content(page).getByRole("link", { name: "guide" }).click();
  await expect(heading(page, "Start here")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/r/${open.owner}/${open.name}\\?doc=docs%2Fguide%2Fstart\\.md$`));
  await expect(page.locator(".tree-item.active .tree-label")).toHaveText("Getting started");
  await page.goBack();
  await expect(heading(page, "Open home")).toBeVisible();

  // The sidebar shows page titles, and selecting one switches the document.
  await page.locator(".tree-link", { hasText: "Advanced" }).click();
  await expect(heading(page, "Advanced")).toBeVisible();
  await expect(content(page).locator("pre code.hljs")).toContainText("answer = 42");
  await expect(page).toHaveURL(/\?doc=docs%2Fguide%2Fadvanced\.md$/);
  // An in-shell switch is measured so the switch budget stays observable (#245).
  expect(await page.evaluate(() => performance.getEntriesByName("rendro:frame-switch").length)).toBeGreaterThan(0);
  // Public reads never set a capability cookie.
  expect((await page.context().cookies()).filter(cookie => cookie.name.includes("rendro-repo"))).toEqual([]);
});

test("a granted reader browses a private repository with a capability cookie and ticketed images; others get a plain 404", async ({ page, secondContext, seed, baseURL }) => {
  const { closed } = repos();
  const url = `/r/${closed.owner}/${closed.name}`;
  await signInSeeded(page.context(), baseURL, seed, "owner");
  expect((await page.goto(url))?.status()).toBe(200);
  await expect(heading(page, "Closed home")).toBeVisible();
  const capability = (await page.context().cookies()).find(cookie => /^(?:__Host-)?rendro-repo\.9002$/.test(cookie.name));
  expect(capability).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  // The opaque frame sends no cookies: its image loads through the ticket in the frame's base URL.
  await expectLogoRendered(page);
  expect(await logo(page).evaluate(image => (image as HTMLImageElement).currentSrc)).toMatch(/\/view\/v1\.[\w-]+\.[\w-]+\/files\/docs\/img\/logo\.svg$/);
  await page.locator(".tree-folder-name", { hasText: "Guide" }).click();
  await page.locator(".tree-link", { hasText: "Getting started" }).click();
  await expect(heading(page, "Start here")).toBeVisible();

  const other = await secondContext.newPage();
  await signInSeeded(secondContext, baseURL, seed, "outsider");
  for (const reader of ["outsider", "anonymous"]) {
    if (reader === "anonymous") await secondContext.clearCookies();
    const denied = await other.goto(url);
    expect(denied?.status(), reader).toBe(404);
    expect(denied?.headers()["cache-control"], reader).toBe("private, no-store");
    await expect(other.getByRole("heading", { name: "Page not found" })).toBeVisible();
    const frame = await other.goto(`${url}/@${closed.commit}/files/docs/index.md`);
    expect(frame?.status(), reader).toBe(404);
  }
});

test("a membership webhook revokes a team reader: allowed, then the next view is a plain 404", async ({ page, seed, baseURL }) => {
  const { team, control } = repos();
  const membership = async (action: "added" | "removed") => (await (await fetch(`${control}/membership/${action}`, { method: "POST" })).json()) as { status: number };
  const url = `/r/${team.owner}/${team.name}`;
  const capability = async () => (await page.context().cookies()).find(cookie => /^(?:__Host-)?rendro-repo\.9003$/.test(cookie.name));
  // Idempotent start: the member is on the team (a retry or another engine may have removed them).
  expect(await membership("added")).toEqual({ status: 202 });
  await signInSeeded(page.context(), baseURL, seed, "member");
  expect((await page.goto(url))?.status()).toBe(200);
  await expect(heading(page, "Team home")).toBeVisible();
  await expectLogoRendered(page);
  expect(await capability()).toBeDefined();

  // GitHub removes them from the team and delivers the webhook: the mirror denies, then the epoch moves.
  expect(await membership("removed")).toEqual({ status: 202 });
  const denied = await page.goto(url);
  expect(denied?.status()).toBe(404);
  expect(denied?.headers()["cache-control"]).toBe("private, no-store");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  expect(await capability()).toBeUndefined();
  expect((await page.goto(`${url}/@${team.commit}/files/docs/index.md`))?.status()).toBe(404);
});
