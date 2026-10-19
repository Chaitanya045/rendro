import type { Page, Route } from "@playwright/test";
import { expect } from "../fixtures";
import { failOnce } from "../org-fixtures";
import { injectFault } from "../faults";
import { holdFirst, pageSettled, signInSeeded } from "../shell-helpers";
import { content } from "../viewer-fixtures";
import { READINESS_HEADER, renderPreparingPage } from "../../src/repo-read/preparing";
import type { VisualState } from "./state";
import type { Width } from "./states";
import { longTitle } from "./visual-repo-docs";

/**
 * Every rendered situation of the baselines: family → state. A cell opens the page for that
 * family in the viewport/theme the caller owns, drives overlays that belong to the state, waits
 * on explicit readiness (skeletons, cards, menus, the content frame), and hands back a close()
 * that unwinds any held request before the next cell navigates.
 */

/** `widths` narrows or extends the default 375/768/1440 of the baselines (a card page is the same at 768 and 1440; the shell is also read at 320). */
export type Cell = { family: string; state: string; widths?: Width[] };
/** `verify` re-asserts, after settling, that the state the cell opened is still on screen (a scan of a lost overlay would be vacuous). */
export type Rendered = { close: () => Promise<void>; verify?: () => Promise<void> };

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
  const rendered = (verify?: () => Promise<void>): Rendered => ({ verify, close: async () => { for (const close of closers.splice(0).reverse()) await close(); } });
  try {
    switch (family) {
      case "landing": {
        await page.goto("/");
        await expect(page.locator("main")).toBeVisible();
        // Reduced motion is emulated by every cell: the page must not hold anything back for a reveal (#268).
        await expect(page.locator("html.motion-ready")).toHaveCount(0);
        expect(await page.locator("[data-reveal], [data-reveal-item]").evaluateAll(items => items.map(item => getComputedStyle(item).opacity))).not.toContain("0");
        const section = ({ workflow: "#workflow", product: "#product", security: "#security" } as Record<string, string | undefined>)[state];
        if (section) {
          await page.locator(section).evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
          // The sticky header keeps a section's heading below the top edge, and the last section cannot reach it on a short page:
          // it is placed once it is within the header's height of the top or the page is scrolled to its end.
          await expect.poll(() => page.locator(section).evaluate(element => element.getBoundingClientRect().top <= 120 || window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1)).toBe(true);
        }
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
        // The list arrives after the button: a shot taken on the skeleton once became a baseline on a loaded host.
        await expect(page.locator("#key-list code.cell-secondary").first()).toBeVisible();
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
        if (state !== "drawer") return await openThreadState(page, visual, state, closers, rendered);
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
      case "repo":
        return await openRepo(page, visual, state, closers, rendered);
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

/** The shell's tree is a closed drawer below the desktop breakpoint; the search panel and the tree live in it. */
async function openTreeDrawer(page: Page) {
  const drawer = page.locator("#mobile-tree-toggle");
  if (await drawer.isVisible()) await drawer.click();
}

/** Every image of the rendered page decoded: a shot must not race an asset that arrives through the frame's ticket. */
async function pageImagesLoaded(page: Page) {
  await expect.poll(() => repoContent(page).locator("img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
}

/** The visual-docs repository (public, fixed Markdown), only provisioned in the visual runs. */
function visualRepo(visual: VisualState) {
  const repo = visual.repos().visual;
  if (!repo) throw new Error("The visual repository is missing: run through e2e/visual.config.ts");
  return repo;
}

async function openRepo(page: Page, visual: VisualState, state: string, closers: Array<() => Promise<void>>, rendered: (verify?: () => Promise<void>) => Rendered): Promise<Rendered> {
  const repositories = visual.repos();
  const open = repositories.open;
  const docs = visualRepo(visual);
  const base = `/r/${docs.owner}/${docs.name}`;
  const frameHeading = (name: string) => repoContent(page).getByRole("heading", { level: 1, name });
  switch (state) {
    case "not-found": {
      await page.goto(`/r/${repositories.closed.owner}/${repositories.closed.name}`);
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
      return rendered();
    }
    case "denied": {
      // A signed-in reader without access gets the same plain 404 as a repository that does not exist.
      await signInSeeded(page.context(), origin(), visual.seedOwner, "outsider");
      await page.goto(`/r/${repositories.closed.owner}/${repositories.closed.name}`);
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
      return rendered();
    }
    case "unavailable": {
      // The session lookup fails, so the reader cannot be checked: the retryable 503 page, never a 404.
      await signInSeeded(page.context(), origin(), visual.seedOwner, "owner");
      const end = await injectFault({ origin: "convex", includes: ["/get-session"], status: 503 });
      closers.push(end);
      await page.goto(`/r/${repositories.closed.owner}/${repositories.closed.name}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      return rendered();
    }
    case "preparing":
    case "prepare-failed": {
      // The e2e Worker has no ingest coordinator, so the first-view state is served at the browser boundary with the product's
      // own renderer (src/repo-read/preparing.ts); the Worker's route and poll are covered by the workerd first-view test.
      const preparing = state === "preparing";
      const body = renderPreparingPage(preparing ? "preparing" : "failed", 5);
      const glob = `**${base}`;
      const handler = (route: Route) => route.fulfill({
        status: preparing ? 200 : 503, contentType: "text/html; charset=utf-8", body,
        headers: { [READINESS_HEADER]: preparing ? "preparing" : "failed", "Cache-Control": "private, no-store", "Retry-After": "5" },
      });
      await page.route(glob, handler);
      closers.push(() => page.unroute(glob, handler));
      await page.goto(base);
      await expect(page.locator(`main[data-readiness="${preparing ? "preparing" : "failed"}"]`)).toBeVisible();
      return rendered();
    }
    case "private": {
      await signInSeeded(page.context(), origin(), visual.seedOwner, "owner");
      const closed = repositories.closed;
      await page.goto(`/r/${closed.owner}/${closed.name}`);
      await expect(frameHeading("Closed home")).toBeVisible();
      await pageImagesLoaded(page);
      // The widget enables commenting once the reader's grant is known: a shot on a slow host caught the dimmed button.
      await expect(repoContent(page).getByTestId("commentor-comment-btn")).toBeEnabled();
      return rendered();
    }
    case "markdown": {
      await page.goto(`${base}?doc=${encodeURIComponent("docs/guide/deep/nested/topic.md")}`);
      await expect(frameHeading("Nested topic")).toBeVisible();
      await expect(repoContent(page).locator("pre code.hljs").first()).toBeVisible();
      await expect(repoContent(page).locator("table")).toHaveCount(1);
      return rendered();
    }
    case "long-title": {
      await page.goto(`${base}?doc=${encodeURIComponent("docs/long-title.md")}`);
      await expect(frameHeading(longTitle)).toBeVisible();
      await expect(page.locator(".tree-item.active .tree-label")).toHaveText(longTitle);
      return rendered();
    }
    case "large": {
      // A deep link into the middle of a long page: the frame scrolls to a fixed section.
      await page.goto(`${base}?doc=${encodeURIComponent("docs/large.md")}#user-content-section-120`);
      await expect(frameHeading("Large reference")).toBeVisible();
      // The shell may swap in its preloaded frame while this runs: a lost context is simply asked again.
      await expect.poll(() => repoContent(page).locator("#user-content-section-120").evaluate(element => Math.round(element.getBoundingClientRect().top)).catch(() => Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(24);
      return rendered();
    }
    case "tree-expanded": {
      await page.goto(base);
      await expect(frameHeading("Visual home")).toBeVisible();
      await openTreeDrawer(page);
      for (const folder of ["Guide", "Deep", "Nested", "Reference"]) {
        const row = page.locator(".tree-folder > .tree-item", { has: page.locator(".tree-folder-name", { hasText: new RegExp(`^${folder}$`) }) });
        await row.click();
        await expect(row).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator(".tree-folder.loading")).toHaveCount(0);
      }
      return rendered();
    }
    case "doc-error": {
      // The page links to a document that no longer exists: the shell asks for it and the frame says so.
      await page.goto(base);
      await expect(frameHeading("Visual home")).toBeVisible();
      await repoContent(page).getByRole("link", { name: "link to a page that was removed" }).click();
      await expect(repoContent(page).getByRole("heading", { name: "Page not found" })).toBeVisible();
      return rendered();
    }
    case "link-confirm": {
      // A link to another site is never followed: the shell shows the exact address and waits for the reader.
      await page.goto(base);
      await expect(frameHeading("Visual home")).toBeVisible();
      await repoContent(page).getByRole("link", { name: "external changelog" }).click();
      const notice = page.locator("#document-navigation-notice");
      await expect(notice).toBeVisible();
      await expect(page.locator("#document-navigation-destination")).toContainText("https://example.com/changelog");
      return rendered(() => expect(notice).toBeVisible());
    }
    case "home":
    case "search":
    case "search-empty":
    case "search-error":
    case "search-limited": {
      await page.goto(`/r/${open.owner}/${open.name}`);
      await expect(repoContent(page).getByRole("heading", { level: 1, name: "Open home" })).toBeVisible();
      if (state === "home") return rendered();
      // The search panel lives in the sidebar, a closed drawer below the desktop breakpoint.
      await openTreeDrawer(page);
      const input = page.locator("#repo-search-input");
      await input.click();
      await expect(input).toBeFocused();
      if (state === "search") {
        await input.fill("back");
        await expect(page.locator("#repo-search-results .repo-search-item").first()).toBeVisible();
        return rendered();
      }
      if (state === "search-empty") {
        await input.fill("zzzzqqqq");
        await expect(page.locator("#repo-search-results .repo-search-message")).toContainText("No results for");
        return rendered();
      }
      // Failure at the network boundary: the shell shows one message and a Retry, whatever the status.
      const limited = state === "search-limited";
      const glob = "**/search?q=*";
      const handler = (route: Route) => route.fulfill(limited
        ? { status: 429, contentType: "application/json", headers: { "Retry-After": "30", "Cache-Control": "private, no-store" }, body: JSON.stringify({ error: "Too many requests. Please retry later.", code: "rate_limited" }) }
        : { status: 500, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify({ error: "Search is unavailable" }) });
      await page.route(glob, handler);
      closers.push(() => page.unroute(glob, handler));
      await input.fill("back");
      await expect(page.locator("#repo-search-results .repo-search-message")).toContainText("Search failed.");
      return rendered();
    }
    default:
      throw new Error(`Unknown visual state repo/${state}`);
  }
}

type CommentSocket = { rejectWrites(on: boolean): void; blackhole(on: boolean): void };
const commentSockets = new WeakMap<Page, CommentSocket>();

/**
 * The page's Convex socket, routed once per page. Nothing a state does may reach the seeded backend: while `blackhole` is on
 * the page's messages never leave (a connection that stays silent), and while `rejectWrites` is on every mutation is answered
 * here with the server's own public refusal, so error states render without writing data or spending the writer's allowance.
 */
async function commentSocket(page: Page): Promise<CommentSocket> {
  const existing = commentSockets.get(page);
  if (existing) return existing;
  const convex = process.env.RENDRO_E2E_CONVEX?.replace("http:", "ws:");
  if (!convex) throw new Error("Missing local Convex origin");
  let blackholed = false;
  let refuse = false;
  await page.routeWebSocket(url => url.origin === convex, ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => {
      if (blackholed) return;
      if (refuse && typeof message === "string") {
        const frame = JSON.parse(message) as { type?: string; requestId?: number };
        if (frame.type === "Mutation") {
          ws.send(JSON.stringify({ type: "MutationResponse", requestId: frame.requestId, success: false, result: "Forbidden", logLines: [], errorData: { code: "forbidden", message: "Forbidden" } }));
          return;
        }
      }
      server.send(message);
    });
    server.onMessage(message => ws.send(message));
  });
  const socket: CommentSocket = { rejectWrites: on => { refuse = on; }, blackhole: on => { blackholed = on; } };
  commentSockets.set(page, socket);
  return socket;
}

/**
 * Thread states of the comment widget (#268) on a page of their own, so the drawer baseline keeps its threads: an active
 * thread with a reply and a resolved one. Nothing is ever committed: the widget's long timers (a deletion's undo window,
 * the toast lifetime) are stretched so a state cannot lapse between the settle and the shot, and the close undoes the deletion.
 */
async function openThreadState(page: Page, visual: VisualState, state: string, closers: Array<() => Promise<void>>, rendered: (verify?: () => Promise<void>) => Rendered): Promise<Rendered> {
  const socket = await commentSocket(page);
  closers.push(async () => { socket.rejectWrites(false); socket.blackhole(false); await page.evaluate(() => sessionStorage.clear()).catch(() => undefined); });
  await page.goto(`${visual.crown.docs}?doc=guide%2Fadvanced.html`);
  await expect(content(page).getByRole("heading", { level: 1, name: "Advanced" })).toBeVisible();
  await expect(page.locator("#tree-container .tree-item.active")).toHaveCount(1);
  const ui = widgetUi(page);
  await expect(ui.getByTestId("commentor-dock")).toBeAttached();
  await expect(ui.locator('[data-testid="commentor-load-older-threads"][aria-busy="true"]')).toHaveCount(0);
  await expect(ui.getByTestId("commentor-comment-btn")).toBeEnabled();
  await ui.getByTestId("commentor-panel-btn").press("Enter");
  await expect(ui.getByTestId("commentor-drawer")).toHaveAttribute("aria-hidden", "false");
  const retry = ui.locator(".drawer-thread", { hasText: "Confirm the retry budget before release" });
  if (state === "resolved") {
    await ui.getByRole("tab", { name: /Resolved/ }).click();
    await expect(ui.locator(".drawer-thread", { hasText: "Rename the endpoint section" })).toBeVisible();
    return rendered();
  }
  await expect(retry).toBeVisible();
  if (state === "reply" || state === "offline" || state === "refused") {
    const input = retry.getByTestId("commentor-reply-input");
    await input.fill("Thanks, I will check the budget");
    if (state === "reply") return rendered();
    if (state === "offline") {
      // The request leaves, but no answer ever reaches the page: the send stays pending with the draft kept.
      socket.blackhole(true);
      await retry.getByTestId("commentor-reply-send").click();
      await expect(retry.getByTestId("commentor-reply-send")).toHaveText("Sending…");
      return rendered();
    }
    // The server refuses the write with its public error; the reader keeps the draft and is told why.
    socket.rejectWrites(true);
    await retry.getByTestId("commentor-reply-send").click();
    await expect(ui.locator('.toast[role="alert"]')).toBeVisible();
    return rendered();
  }
  if (state === "deleted") {
    // Stretch the widget's timers first: the deletion commits after its undo window and the toast closes on its own.
    await content(page).locator("body").evaluate(() => {
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => timeout(handler, delay !== undefined && delay >= 3000 ? 2_147_483_647 : delay, ...args)) as typeof window.setTimeout;
    });
    await retry.getByTestId("commentor-delete-btn").press("Enter");
    const undo = ui.locator(".toast").getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    closers.push(async () => { if (await undo.count()) await undo.click().catch(() => undefined); });
    return rendered();
  }
  throw new Error(`Unknown visual state comments/${state}`);
}
