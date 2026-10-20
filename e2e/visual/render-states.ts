import type { FrameLocator, Page, Route } from "@playwright/test";
import { expect } from "../fixtures";
import { injectFault } from "../faults";
import { signInSeeded } from "../shell-helpers";
import { content } from "../viewer-fixtures";
import { READINESS_HEADER, renderPreparingPage } from "../../src/repo-read/preparing";
import type { VisualState } from "./state";
import { longTitle } from "./visual-repo-docs";

/**
 * Every rendered situation of the baselines: family → state. A cell opens the page for that
 * family in the viewport/theme the caller owns, drives overlays that belong to the state, waits
 * on explicit readiness (skeletons, cards, menus, the content frame), and hands back a close()
 * that unwinds any held request before the next cell navigates.
 */

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
  const opened = await openCell(page, visual, family, state);
  try {
    // The shell keeps its loading shimmer on the active row for a minimum time after a document arrives (#276): a shot
    // inside that window caught it on one run and not the next. Only the held load is meant to show it.
    if (!(family === "viewer" && state === "loading")) await expect(page.locator("html.doc-loading")).toHaveCount(0);
  } catch (error) {
    await opened.close().catch(() => undefined);
    throw error;
  }
  return opened;
}

async function openCell(page: Page, visual: VisualState, family: string, state: string): Promise<Rendered> {
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
      case "sign-in":
      case "sign-up":
      case "forgot-password":
      case "reset-password":
      case "verify-email":
      case "security":
      case "not-found":
        return await openAuth(page, visual, family, state, closers, rendered);
      case "home": {
        await page.context().addCookies(visual.crown.cookies);
        await page.goto("/home");
        await expect(page.getByRole("heading", { name: "Welcome, Crown Turner", level: 1 })).toBeVisible();
        return rendered();
      }
      case "viewer": {
        await page.context().addCookies(visual.crown.cookies);
        if (state === "loading") {
          // An in-shell load held at the browser boundary (the initial document cannot be held:
          // the page's load event would wait for the opaque frame). The held page request leaves
          // the shell in its deterministic loading state with the previous document shown.
          await page.goto(`${visual.docs}?doc=${encodeURIComponent("docs/reference/config.md")}`);
          await viewerReady(page, "Configuration", 1);
          // config.md carries a seeded thread, so its pin shows the comment subscription has answered before the switch (#276).
          const hold = await holdDocument(page, "docs/reference/errors.md");
          closers.push(() => hold.close());
          // Below the desktop breakpoint the tree is a drawer; choosing a document closes it.
          const drawer = page.locator("#mobile-tree-toggle");
          if (await drawer.isVisible()) await drawer.click();
          await page.locator('.tree-item[data-path$="/reference/errors.md"] a.tree-link').click();
          await expect.poll(async () => (await classes(page)).includes("doc-loading")).toBe(true);
          return rendered();
        }
        await page.goto(`${visual.docs}?doc=${encodeURIComponent("docs/reference/errors.md")}`);
        await viewerReady(page, "Errors", 2);
        if (state === "menu") {
          // The secondary actions live in More on a phone; the cell is phone-only.
          await page.locator("#mobile-more-btn").click();
          await expect(page.locator("#mobile-more-menu")).toBeVisible();
        }
        return rendered();
      }
      case "comments": {
        await page.context().addCookies(visual.crown.cookies);
        if (state !== "drawer") return await openThreadState(page, visual, state, closers, rendered);
        await page.goto(`${visual.docs}?doc=${encodeURIComponent("docs/reference/errors.md")}`);
        await viewerReady(page, "Errors", 2);
        await expect(widgetUi(page).getByTestId("commentor-dock")).toBeAttached();
        // Keyboard activation instead of a pointer click: the widget's hover tooltip must not
        // appear in the baseline (it would depend on capture timing, not on the page itself).
        await widgetUi(page).getByTestId("commentor-panel-btn").press("Enter");
        await expect(widgetUi(page).getByTestId("commentor-drawer")).toHaveAttribute("aria-hidden", "false");
        await liveComments(page);
        await remeasureDrawer(page);
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
  // race the subscription and alternate between pinned and unpinned documents. Only the two seeded
  // reference pages carry threads; other pages of the repository render none.
  await expect(widgetUi(page).getByTestId("commentor-pin")).toHaveCount(pins);
}

/**
 * The first comments come from the read path's first-page snapshot (#284), which the live page then replaces. Only the live
 * page carries the reader's Archive and Delete actions and settles the list's paging, so a shot taken before it arrived
 * showed the snapshot on one run and the live page on the next (#276).
 */
async function liveComments(page: Page) {
  const ui = widgetUi(page);
  await expect(ui.locator('[data-testid="commentor-load-older-threads"][aria-busy="true"]')).toHaveCount(0);
  await expect(ui.locator(".drawer-thread").first().getByTestId("commentor-delete-btn")).toBeVisible();
}

/**
 * The open drawer sizes itself to its list when it opens and when a page re-renders it, not when the frame's own layout
 * settles later; its tabs are taller below the widget's 760px breakpoint, and one run kept a drawer 8px taller than the next
 * (#276). Once the frame's fonts are in, a resize makes it measure the list as it is, as the reader's next window resize
 * would, until two measures agree.
 */
async function remeasureDrawer(page: Page) {
  await content(page).locator("body").evaluate(async () => {
    await document.fonts.ready;
    const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const drawer = () => document.getElementById("commentor-host")?.shadowRoot?.querySelector<HTMLElement>('[data-testid="commentor-drawer"]')?.style.height ?? "";
    for (let attempt = 0, last = ""; attempt < 5; attempt++) {
      window.dispatchEvent(new Event("resize"));
      await frames();
      if (drawer() === last) return;
      last = drawer();
    }
  });
}

/**
 * Chromium draws the widget's toast region into the page at first and moves it onto a layer of its own some seconds later,
 * and the two paths blend the pill's antialiased outline one level apart: a fast run shot one, a slow run the other (#276).
 * The cell puts the region on its own layer from the start, so every run shoots the same path; nothing it shows changes.
 */
async function layerToasts(ui: FrameLocator) {
  await ui.locator(".toast-region").evaluate(region => { (region as HTMLElement).style.willChange = "transform"; });
}

/** Holds the document's own opaque request at the browser boundary, exactly like the viewer specs. */
async function holdDocument(page: Page, file: string) {
  return await holdRequest(page, `**/files/${file}`);
}

/** Holds every request matching `glob` at the browser boundary until close(); `held` settles once the page has sent one. */
async function holdRequest(page: Page, glob: string) {
  const pending: Route[] = [];
  let holding = true;
  let arrived = () => {};
  const held = new Promise<void>(resolve => { arrived = resolve; });
  const handler = async (route: Route) => {
    if (!holding) { await route.continue().catch(() => undefined); return; }
    pending.push(route);
    arrived();
  };
  await page.route(glob, handler);
  return {
    held,
    close: async () => {
      holding = false;
      for (const route of pending.splice(0)) await route.continue().catch(() => undefined);
      await page.unroute(glob, handler);
    },
  };
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

/**
 * The visual repository's home, its row selected. A click into the page before the shell's first reveal has marked the row
 * supersedes that reveal (newest wins), so the row stayed unselected on one run and selected on the next (#276).
 */
async function openVisualHome(page: Page, base: string) {
  await page.goto(base);
  await expect(repoContent(page).getByRole("heading", { level: 1, name: "Visual home" })).toBeVisible();
  await expect(page.locator(".tree-item.active .tree-label")).toHaveText("Visual home");
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
      // The real response carries the trusted-page COOP (#89); without it Firefox leaves the browsing context group and drops the emulated theme.
      const handler = (route: Route) => route.fulfill({
        status: preparing ? 200 : 503, contentType: "text/html; charset=utf-8", body,
        headers: { [READINESS_HEADER]: preparing ? "preparing" : "failed", "Cache-Control": "private, no-store", "Retry-After": "5", "Cross-Origin-Opener-Policy": "same-origin" },
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
      await openVisualHome(page, base);
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
      await openVisualHome(page, base);
      await repoContent(page).getByRole("link", { name: "link to a page that was removed" }).click();
      await expect(repoContent(page).getByRole("heading", { name: "Page not found" })).toBeVisible();
      return rendered();
    }
    case "link-confirm": {
      // A link to another site is never followed: the shell shows the exact address and waits for the reader.
      await openVisualHome(page, base);
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
      // Failure at the network boundary: the shell shows one message, or the wait a rate limit names.
      const limited = state === "search-limited";
      const glob = "**/search?q=*";
      const handler = (route: Route) => route.fulfill(limited
        ? { status: 429, contentType: "application/json", headers: { "Retry-After": "30", "Cache-Control": "private, no-store" }, body: JSON.stringify({ error: "Too many requests. Please retry later.", code: "rate_limited" }) }
        : { status: 500, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify({ error: "Search is unavailable" }) });
      await page.route(glob, handler);
      closers.push(() => page.unroute(glob, handler));
      await input.fill("back");
      await expect(page.locator("#repo-search-results .repo-search-message")).toContainText(limited ? "Too many searches — try again in 30 s" : "Search failed.");
      return rendered();
    }
    default:
      throw new Error(`Unknown visual state repo/${state}`);
  }
}

/** The text the auth cells type: an address and passwords no seeded account uses. */
const reader = "reader@example.test";
const typedPassword = "Visual typed password 1";

/** Better Auth's own refusals, exactly as its routes send them. */
const invalidCredentials = { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" };
const tooManyRequests = { message: "Too many requests. Please try again later." };
/** An account from the retired Google sign-in (#286): it has no password, so the page offers to add one. */
const legacyAccounts = [{ id: "visual-legacy", providerId: "google", accountId: "visual-legacy", userId: "visual-legacy-user", scopes: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }];

/** One callback code per fixed recovery message of /sign-in?error=, the unknown one included. */
const oauthCodes: Record<string, string | undefined> = {
  "oauth-access-denied": "access_denied",
  "oauth-state-mismatch": "state_mismatch",
  "oauth-account-not-linked": "account_not_linked",
  "oauth-unknown": "server_error",
};

/**
 * Answers one of the page's own auth requests at the browser boundary with the server's public response (#319). An error
 * state then renders without reaching the seeded backend: no attempt counts against its limiter, and no account changes.
 */
async function answerAuth(page: Page, path: string, status: number, body: unknown, closers: Array<() => Promise<void>>) {
  const glob = `**/api/auth/${path}`;
  const handler = (route: Route) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  await page.route(glob, handler);
  closers.push(() => page.unroute(glob, handler));
}

/** Submits an auth form from its last field, as a keyboard user would: no pointer rests on a button in the shot. */
async function submitFrom(page: Page, field: string) {
  await page.locator(field).press("Enter");
}

/** The account and auth pages (#319): sign-in and sign-up errors, account recovery, email verification, account security and the 404. */
async function openAuth(page: Page, visual: VisualState, family: string, state: string, closers: Array<() => Promise<void>>, rendered: () => Rendered): Promise<Rendered> {
  const formError = page.locator("#form-error");
  const submit = page.locator("#auth-form button[type=submit]");
  if (family === "sign-in") {
    const code = oauthCodes[state];
    if (code) {
      await page.goto(`/sign-in?error=${code}`);
      await expect(formError).not.toBeEmpty();
      return rendered();
    }
    if (state === "invalid-credentials" || state === "rate-limited") {
      const limited = state === "rate-limited";
      await answerAuth(page, "sign-in/email", limited ? 429 : 401, limited ? tooManyRequests : invalidCredentials, closers);
    }
    await page.goto("/sign-in");
    await expect(page.locator("#email")).toBeVisible();
    if (state === "default") return rendered();
    if (state === "validation") {
      await page.locator("#email").fill("reader.example.test");
      await submitFrom(page, "#email");
      await expect(formError).toHaveText("Enter a valid email address.");
      await expect(page.locator("#email")).toBeFocused();
      return rendered();
    }
    if (state !== "invalid-credentials" && state !== "rate-limited") throw new Error(`Unknown visual state sign-in/${state}`);
    await page.locator("#email").fill(reader);
    await page.locator("#password").fill(typedPassword);
    await submitFrom(page, "#password");
    await expect(formError).toHaveText(state === "rate-limited" ? tooManyRequests.message : invalidCredentials.message);
    await expect(submit).toBeEnabled();
    return rendered();
  }
  if (family === "sign-up") {
    if (state === "rate-limited") await answerAuth(page, "sign-up/email", 429, tooManyRequests, closers);
    await page.goto("/sign-up");
    await expect(page.locator("#name")).toBeVisible();
    if (state === "default") return rendered();
    await page.locator("#name").fill("Visual Reader");
    await page.locator("#email").fill(reader);
    if (state === "validation") {
      // The length limit only applies to a typed value, so the short password is typed key by key.
      await page.locator("#password").pressSequentially("too short");
      await submitFrom(page, "#password");
      await expect(formError).toHaveText("Use at least 15 characters.");
      await expect(page.locator("#password")).toBeFocused();
      return rendered();
    }
    if (state !== "rate-limited") throw new Error(`Unknown visual state sign-up/${state}`);
    await page.locator("#password").fill(typedPassword);
    await submitFrom(page, "#password");
    await expect(formError).toHaveText(tooManyRequests.message);
    await expect(submit).toBeEnabled();
    return rendered();
  }
  if (family === "forgot-password") {
    if (state === "sent") await answerAuth(page, "request-password-reset", 200, { status: true }, closers);
    if (state === "error") await answerAuth(page, "request-password-reset", 500, { message: "Internal Server Error" }, closers);
    await page.goto("/forgot-password");
    await expect(page.locator("#email")).toBeVisible();
    if (state === "default") return rendered();
    if (state !== "sent" && state !== "error") throw new Error(`Unknown visual state forgot-password/${state}`);
    await page.locator("#email").fill(reader);
    await submitFrom(page, "#email");
    await expect(page.locator("#form-message")).toHaveText(state === "sent" ? "If an account exists for that email, a reset link is on its way." : "We couldn't send that email. Please try again.");
    await expect(submit).toBeEnabled();
    return rendered();
  }
  if (family === "reset-password") {
    if (state === "form") {
      await page.goto("/reset-password?token=visual-reset-token");
      await expect(page.locator("#confirmPassword")).toBeVisible();
      return rendered();
    }
    if (state !== "invalid") throw new Error(`Unknown visual state reset-password/${state}`);
    // Better Auth sends an invalid or expired link back here with an error code and no token.
    await page.goto("/reset-password?error=INVALID_TOKEN");
    await expect(page.getByRole("heading", { level: 1, name: "Reset link unavailable" })).toBeVisible();
    return rendered();
  }
  if (family === "verify-email") {
    if (state === "verified") {
      await page.goto("/verify-email?verified=1");
      await expect(page.getByRole("heading", { level: 1, name: "Email verified" })).toBeVisible();
      return rendered();
    }
    if (state !== "invalid") throw new Error(`Unknown visual state verify-email/${state}`);
    await page.goto("/verify-email?error=invalid_token");
    const heading = page.getByRole("heading", { level: 1, name: "Verification link unavailable" });
    await expect(heading).toBeFocused();
    return rendered();
  }
  if (family === "not-found") {
    const response = await page.goto("/visual-missing-page");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    return rendered();
  }
  if (family !== "security") throw new Error(`Unknown visual family ${family}`);
  // The visual owner's own page. Its password requests never leave the browser, so the account never changes.
  await page.context().addCookies(visual.crown.cookies);
  const methods = page.locator("#method-list");
  if (state === "loading") {
    const hold = await holdRequest(page, "**/api/auth/list-accounts");
    closers.push(() => hold.close());
    await page.goto("/account/security");
    await hold.held;
    await expect(methods).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#security-skeleton")).toBeVisible();
    return rendered();
  }
  const legacy = state === "no-password" || state === "add-mismatch";
  if (legacy) await answerAuth(page, "list-accounts", 200, legacyAccounts, closers);
  if (state === "failure") await answerAuth(page, "list-accounts", 500, { message: "Internal Server Error" }, closers);
  if (state === "change-error") await answerAuth(page, "change-password", 400, { code: "INVALID_PASSWORD", message: "Invalid password" }, closers);
  await page.goto("/account/security");
  await expect(methods).toHaveAttribute("aria-busy", "false");
  if (state === "failure") {
    await expect(methods.locator('[data-method="error"]')).toBeVisible();
    return rendered();
  }
  await expect(methods.locator(`[data-method="${legacy ? "unconfigured" : "configured"}"]`)).toBeVisible();
  await expect(page.locator(legacy ? "#initial-password-section" : "#change-password-section")).toBeVisible();
  if (state === "credential" || state === "no-password") return rendered();
  if (state === "change-error") {
    await page.locator("#currentPassword").fill(typedPassword);
    await page.locator("#newPassword").fill("Visual new password 2");
    await submitFrom(page, "#newPassword");
    await expect(page.locator("#change-error")).toHaveText("Invalid password");
    await expect(page.locator("#change-password-form button[type=submit]")).toBeEnabled();
    return rendered();
  }
  if (state !== "add-mismatch") throw new Error(`Unknown visual state security/${state}`);
  await page.locator("#password").fill("Visual new password 1");
  await page.locator("#confirmPassword").fill("Visual new password 2");
  await submitFrom(page, "#confirmPassword");
  await expect(page.locator("#initial-error")).toHaveText("Passwords do not match.");
  return rendered();
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
async function openThreadState(page: Page, visual: VisualState, state: string, closers: Array<() => Promise<void>>, done: (verify?: () => Promise<void>) => Rendered): Promise<Rendered> {
  const rendered = async () => { await remeasureDrawer(page); return done(); };
  const socket = await commentSocket(page);
  closers.push(async () => { socket.rejectWrites(false); socket.blackhole(false); await page.evaluate(() => sessionStorage.clear()).catch(() => undefined); });
  await page.goto(`${visual.docs}?doc=${encodeURIComponent("docs/reference/config.md")}`);
  await expect(content(page).getByRole("heading", { level: 1, name: "Configuration" })).toBeVisible();
  await expect(page.locator("#tree-container .tree-item.active")).toHaveCount(1);
  const ui = widgetUi(page);
  await expect(ui.getByTestId("commentor-dock")).toBeAttached();
  await expect(ui.getByTestId("commentor-comment-btn")).toBeEnabled();
  await ui.getByTestId("commentor-panel-btn").press("Enter");
  await expect(ui.getByTestId("commentor-drawer")).toHaveAttribute("aria-hidden", "false");
  await liveComments(page);
  const retry = ui.locator(".drawer-thread", { hasText: "Confirm the retry budget before release" });
  if (state === "resolved") {
    await ui.getByRole("tab", { name: /Resolved/ }).click();
    const resolved = ui.locator(".drawer-thread", { hasText: "Rename the branch setting" });
    await expect(resolved).toBeVisible();
    await expect(resolved.getByTestId("commentor-delete-btn")).toBeVisible();
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
    await layerToasts(ui);
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
    // The open drawer keeps the height it measured with the thread in it until a later snapshot happens to re-measure it, so
    // the shot caught either height (#276). Reopening it measures the list as it is now; the toast lives outside the drawer.
    // A programmatic click neither focuses nor hovers the button, so its tooltip stays closed.
    const panel = ui.getByTestId("commentor-panel-btn");
    await panel.evaluate(button => (button as HTMLButtonElement).click());
    await expect(ui.getByTestId("commentor-drawer")).toHaveAttribute("aria-hidden", "true");
    await panel.evaluate(button => (button as HTMLButtonElement).click());
    await expect(ui.getByTestId("commentor-drawer")).toHaveAttribute("aria-hidden", "false");
    await layerToasts(ui);
    closers.push(async () => { if (await undo.count()) await undo.click().catch(() => undefined); });
    return rendered();
  }
  throw new Error(`Unknown visual state comments/${state}`);
}
