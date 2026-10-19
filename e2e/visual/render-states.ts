import type { Page, Route } from "@playwright/test";
import { expect } from "../fixtures";
import { failOnce } from "../org-fixtures";
import { holdFirst, pageSettled, signInSeeded } from "../shell-helpers";
import { content } from "../viewer-fixtures";
import type { VisualState } from "./state";

/**
 * Every rendered situation of the baselines: family → state. A cell opens the page for that
 * family in the viewport/theme the caller owns, drives overlays that belong to the state, waits
 * on explicit readiness (skeletons, cards, menus, the content frame), and hands back a close()
 * that unwinds any held request before the next cell navigates.
 */

export type Cell = { family: string; state: string };
export type Rendered = { close: () => Promise<void> };

const origin = () => {
  const value = process.env.RENDRO_E2E_ORIGIN;
  if (!value) throw new Error("Missing local Worker origin");
  return value;
};
const repoContent = (page: Page) => page.frameLocator("#content-frame");
const widgetUi = (page: Page) => content(page);
const classes = (page: Page) => page.evaluate(() => [...document.documentElement.classList]);

export async function openState(page: Page, visual: VisualState, family: string, state: string): Promise<Rendered> {
  const closers: Array<() => Promise<void>> = [];
  const rendered = (): Rendered => ({ close: async () => { for (const close of closers.splice(0).reverse()) await close(); } });
  try {
    switch (family) {
      case "landing": {
        await page.goto("/");
        await expect(page.locator("main")).toBeVisible();
        return rendered();
      }
      case "sign-in": {
        await page.goto("/sign-in");
        await expect(page.locator("#email")).toBeVisible();
        return rendered();
      }
      case "sign-up": {
        await page.goto("/sign-up");
        await expect(page.locator("#name")).toBeVisible();
        return rendered();
      }
      case "account-menu": {
        await signInSeeded(page.context(), origin(), visual.seedOwner, "owner");
        await page.goto(`/organizations/${visual.seedOwner.organizationId}`);
        await pageSettled(page);
        await page.locator("#cp-avatar").click();
        await expect(page.locator("#cp-account-menu")).toBeVisible();
        return rendered();
      }
      case "org": {
        await page.context().addCookies(visual.crown.cookies);
        await page.goto(`/organizations/${visual.crown.organizationId}`);
        await pageSettled(page);
        await expect(page.locator("#workspace-checklist .checklist-row").first()).toBeVisible();
        return rendered();
      }
      case "projects": {
        await page.context().addCookies(visual.crown.cookies);
        const organizationId = state === "empty" ? visual.vaultOrganizationId : visual.crown.organizationId;
        const path = `/organizations/${organizationId}/projects`;
        if (state === "loading") {
          const hold = await holdFirst(page, "**/api/rendro/projects?*");
          closers.push(() => hold.close());
          await page.goto(path);
          await expect(page.locator(".loading-view[aria-busy=true]")).toHaveCount(1);
          return rendered();
        }
        if (state === "error") {
          const outage = await failOnce(page, "**/api/rendro/projects?*", "Projects are unavailable right now");
          closers.push(() => outage.close());
          await page.goto(path);
          await expect(page.getByRole("heading", { name: "Unable to load projects", level: 2 })).toBeVisible();
          return rendered();
        }
        await page.goto(path);
        await pageSettled(page);
        if (state === "empty") {
          await expect(page.locator("#project-list")).toContainText("Create project");
          return rendered();
        }
        await expect(page.locator(".project-row").first()).toBeVisible();
        if (state === "dialog") {
          const create = page.locator("#project-create");
          await expect(create).toBeEnabled();
          await create.click();
          await expect(page.locator("#project-dialog")).toBeVisible();
        }
        return rendered();
      }
      case "project": {
        await page.context().addCookies(visual.crown.cookies);
        const path = `/organizations/${visual.crown.organizationId}/projects/${visual.crown.projectId}`;
        if (state === "loading") {
          const hold = await holdFirst(page, "**/api/rendro/deployments?*");
          closers.push(() => hold.close());
          await page.goto(`${path}/deployments`);
          await expect(page.locator(".loading-view[aria-busy=true]").first()).toBeVisible();
          return rendered();
        }
        await page.goto(`${path}/deployments`);
        await pageSettled(page);
        await expect(page.locator("#deployment-list tr.deployment-row").first()).toBeVisible();
        return rendered();
      }
      case "teams": {
        await page.context().addCookies(visual.crown.cookies);
        const path = `/organizations/${visual.crown.organizationId}/teams`;
        await page.goto(path);
        await pageSettled(page);
        await expect(page.locator(".team-card").first()).toBeVisible();
        return rendered();
      }
      case "keys": {
        await page.context().addCookies(visual.crown.cookies);
        const path = `/organizations/${visual.crown.organizationId}/api-keys`;
        await page.goto(path);
        await pageSettled(page);
        await expect(page.locator("#api-key-create")).toBeVisible();
        return rendered();
      }
      case "viewer": {
        await page.context().addCookies(visual.crown.cookies);
        if (state === "loading") {
          // An in-shell load held at the browser boundary (the initial document cannot be held:
          // the page's load event would wait for the opaque frame). The held index.html request
          // leaves the shell in its deterministic loading state with the previous document shown.
          await page.goto(`${visual.crown.docs}?doc=${encodeURIComponent("guide/start.html")}`);
          await viewerReady(page, "Getting started");
          const hold = await holdDocument(page, "index.html");
          closers.push(() => hold.close());
          // Below the desktop breakpoint the tree is a drawer; choosing a document closes it.
          const drawer = page.locator("#mobile-tree-toggle");
          if (await drawer.isVisible()) await drawer.click();
          await page.locator('.tree-item[data-path$="/index.html"] a.tree-link').click();
          await expect.poll(async () => (await classes(page)).includes("doc-loading")).toBe(true);
          return rendered();
        }
        await page.goto(`${visual.crown.docs}?doc=index.html`);
        await viewerReady(page, "Crown platform overview", 2);
        if (state === "menu") {
          const more = page.locator("#mobile-more-btn");
          if (await more.isVisible()) {
            await more.click();
            await expect(page.locator("#mobile-more-menu")).toBeVisible();
          } else {
            await page.locator("#avatar-btn").click();
            await expect(page.locator("#avatar-menu")).toBeVisible();
          }
        }
        return rendered();
      }
      case "comments": {
        await page.context().addCookies(visual.crown.cookies);
        await page.goto(`${visual.crown.docs}?doc=index.html`);
        await viewerReady(page, "Crown platform overview", 2);
        await expect(widgetUi(page).getByTestId("commentor-dock")).toBeAttached();
        await expect(widgetUi(page).locator('[data-testid="commentor-load-older-threads"][aria-busy="true"]')).toHaveCount(0);
        // Keyboard activation instead of a pointer click: the widget's hover tooltip must not
        // appear in the baseline (it would depend on capture timing, not on the page itself).
        await widgetUi(page).getByTestId("commentor-panel-btn").press("Enter");
        await expect(widgetUi(page).getByTestId("commentor-drawer")).toHaveAttribute("aria-hidden", "false");
        return rendered();
      }
      case "repo": {
        const repositories = visual.repos();
        if (state === "not-found") {
          await page.goto(`/r/${repositories.closed.owner}/${repositories.closed.name}`);
          await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
          return rendered();
        }
        await page.goto(`/r/${repositories.open.owner}/${repositories.open.name}`);
        await expect(repoContent(page).getByRole("heading", { level: 1, name: "Open home" })).toBeVisible();
        if (state === "search") {
          // The search panel lives in the sidebar, a closed drawer below the desktop breakpoint.
          const drawer = page.locator("#mobile-tree-toggle");
          if (await drawer.isVisible()) await drawer.click();
          await page.locator("#repo-search-input").click();
          await expect(page.locator("#repo-search-input")).toBeFocused();
          await page.locator("#repo-search-input").fill("back");
          await expect(page.locator("#repo-search-results .repo-search-item").first()).toBeVisible();
        }
        return rendered();
      }
      default:
        throw new Error(`Unknown visual family ${family}`);
    }
  } catch (error) {
    for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
    throw error;
  }
}

async function viewerReady(page: Page, title: string, pins = 0) {
  await expect(content(page).getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.locator("#tree-container .tree-item.active")).toHaveCount(1);
  // The comment subscription is part of the render: the pins must have arrived, or a capture can
  // race the subscription and alternate between pinned and unpinned documents. Only the indexed
  // document carries threads; other pages of the site render none.
  await expect(widgetUi(page).getByTestId("commentor-pin")).toHaveCount(pins);
}

/** Holds the document's own opaque request at the browser boundary, exactly like the viewer specs. */
async function holdDocument(page: Page, file: string) {
  const glob = `**/files/${file}`;
  const pending: Route[] = [];
  let holding = true;
  const handler = async (route: Route) => {
    if (!holding) { await route.continue().catch(() => undefined); return; }
    pending.push(route);
  };
  await page.route(glob, handler);
  return {
    close: async () => {
      holding = false;
      for (const route of pending.splice(0)) await route.continue().catch(() => undefined);
      await page.unroute(glob, handler);
    },
  };
}
/** Text that varies per run in length or content (the seeded site's temporary directory, the pushed commit): rewritten to a
 * fixed string before the shot, because a mask keeps the varying layout (a wrapped path changes every row's height). The
 * functional e2e specs assert the real values. */
export async function pinVolatileText(page: Page, family: string, state: string): Promise<void> {
  const pins: Array<[string, string]> = [];
  if (family === "project" && state !== "loading") pins.push([".deployment-row td:nth-child(2) strong", "/workspace/docs-site"], [".deployment-row td:nth-child(2) .cell-secondary", "Source provenance"]);
  if ((family === "org" || family === "account-menu") && state !== "loading") pins.push(["#recent-deployment .cell-secondary", "Commit 0123456789ab"]);
  // The recent-deployment card loads after the page settles: pin only once its row has rendered.
  for (const [selector] of pins) await page.locator(selector).first().waitFor({ state: "attached" });
  await page.evaluate(entries => {
    for (const [selector, text] of entries) for (const node of document.querySelectorAll(selector)) node.textContent = text;
  }, pins);
}

/** Regions whose text is intentionally run-specific (server ids, the seeded key prefix, the
 * local loopback endpoint): masked in the baseline instead of pinned, asserted by name in the
 * functional e2e specs. */
export function maskFor(family: string, state: string): string[] {
  // The deployments row opens with the server's creation time (to the second) and the run's
  // deployment id (its Source cell is pinned instead, see pinVolatileText); the
  // CLI panel (also rendered while the history is loading) carries the run's organization/project
  // ids and loopback port. All are asserted by the functional specs.
  if (family === "project" && state === "loading") return [".command code"];
  if (family === "project") return [".deployment-row td:nth-child(1)", ".command code"];
  if (family === "keys") return ["#key-list code.cell-secondary"];
  return [];
}
