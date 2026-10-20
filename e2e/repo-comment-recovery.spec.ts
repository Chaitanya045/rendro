import type { Page } from "@playwright/test";
import { test, expect } from "./org-fixtures";
import { ageRecord, login, session, signout } from "./auth-helpers";
import { password } from "./seed";
import { journeyDoc, open, pin, publicThreads, repos, startComment, storedDrafts, ui } from "./comment-helpers";
import { desktop } from "./shell-helpers";

/**
 * Losing the session under a comment on a repository doc (#302, ported from the project-document recovery spec #286
 * removed). The shell owns the realtime connection and the drafts (sessionStorage, bound to the signed-in person); the
 * sandboxed widget holds nothing it could keep across a reload. The repository is public, so a reader who loses the
 * session keeps reading it and its comments, and only writing ends.
 */
test.use({ viewport: desktop });

test.beforeEach(({ cspViolations }) => { void cspViolations; });
test.afterEach(({ cspViolations }) => {
  expect(cspViolations.filter(message => !/x-frame-options/i.test(message)), "CSP violations").toEqual([]);
});

const pageUrl = (doc: { path: string; commit: string }) => {
  const { comments } = repos();
  return `/r/${comments.owner}/${comments.name}/@${doc.commit}?doc=${encodeURIComponent(doc.path)}`;
};
const atPage = (doc: { path: string; commit: string }) => new RegExp(`${pageUrl(doc).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** Comments ended for the signed-out reader: no composer, no way to start one, and the page itself still readable. */
async function writingEnded(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-rendro-signed-out", "true");
  await expect(ui(page).getByTestId("commentor-composer")).toHaveCount(0);
  await expect(ui(page).getByTestId("commentor-comment-btn")).toBeDisabled();
  await expect(ui(page).getByRole("heading", { name: "Journey", exact: true })).toBeVisible();
}

test("a draft survives signing out in another tab and returns after signing back in, but never appears for another account", async ({ actor }) => {
  test.setTimeout(240_000);
  const { comments } = repos();
  const doc = await journeyDoc("session");
  const owner = await actor("session");
  const other = await actor("someone");
  const me = ui(owner.page);
  const textarea = me.getByTestId("commentor-composer-textarea");
  await open(owner.page, comments, doc.path, doc.commit);
  await startComment(owner.page, "quick brown");
  await textarea.fill("Unsent thought");
  await expect.poll(() => storedDrafts(owner.page)).toEqual(["Unsent thought"]);

  // Another tab signs out: writing ends here at once. Nothing was posted, and the draft stays in the tab's user-bound
  // storage rather than being sent anywhere.
  const tab = await owner.context.newPage();
  await tab.goto("/account/security");
  await signout(tab);
  await tab.close();
  await writingEnded(owner.page);
  expect(await storedDrafts(owner.page)).toEqual(["Unsent thought"]);
  expect(await publicThreads(doc.path)).toEqual([]);

  // Signing back in as the same person returns to the page with the composer, the same text on the same quote.
  await login(owner.page, owner.email, password, true, pageUrl(doc));
  await expect(owner.page).toHaveURL(atPage(doc));
  await expect(textarea).toHaveValue("Unsent thought");
  await expect(me.getByTestId("commentor-composer").locator(".anchor-label")).toContainText("quick brown");
  await me.getByTestId("commentor-composer-post").click();
  await expect(me.getByTestId("commentor-composer")).toHaveCount(0);
  await expect(pin(owner.page, "Unsent thought")).toBeVisible();
  await expect.poll(async () => (await publicThreads(doc.path)).map(thread => thread.body)).toEqual(["Unsent thought"]);
  await expect.poll(() => storedDrafts(owner.page)).toEqual([]);

  // A second draft, then a different account signs in on the same tab: the first person's draft is gone for good.
  await startComment(owner.page, "lazy dog");
  await textarea.fill("Private to the owner");
  await expect.poll(() => storedDrafts(owner.page)).toEqual(["Private to the owner"]);
  const second = await owner.context.newPage();
  await second.goto("/account/security");
  await signout(second);
  await second.close();
  await writingEnded(owner.page);
  await login(owner.page, other.email, password, true, pageUrl(doc));
  await expect(owner.page).toHaveURL(atPage(doc));
  await expect(pin(owner.page, "Unsent thought")).toBeVisible();
  await expect(me.getByTestId("commentor-comment-btn")).toBeEnabled();
  await expect(me.getByTestId("commentor-composer")).toHaveCount(0);
  expect(await storedDrafts(owner.page)).toEqual([]);
  expect(await owner.page.evaluate(() => JSON.stringify({ ...sessionStorage }))).not.toContain("Private to the owner");
  expect(await me.locator("body").innerText()).not.toContain("Private to the owner");
});

test("a revoked session is noticed when the page regains focus, and the draft returns once the person signs in again", async ({ actor }) => {
  test.setTimeout(240_000);
  const { comments } = repos();
  const doc = await journeyDoc("revoked");
  const owner = await actor("revoked");
  const me = ui(owner.page);
  const textarea = me.getByTestId("commentor-composer-textarea");
  await open(owner.page, comments, doc.path, doc.commit);
  await startComment(owner.page, "quick brown");
  await textarea.fill("Written as the session expired");
  await expect.poll(() => storedDrafts(owner.page)).toEqual(["Written as the session expired"]);

  // The backend revokes the session; no tab signed out, so nothing is broadcast. Focus is what finds out.
  const identity = await session(owner.page);
  await ageRecord("session", "_id", identity?.sessionId ?? "", { expiresAt: Date.now() - 1000 });
  await owner.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await writingEnded(owner.page);
  expect(await session(owner.page)).toBeNull();
  expect((await owner.page.request.get("/api/auth/convex/token")).ok()).toBe(false);
  expect(await storedDrafts(owner.page)).toEqual(["Written as the session expired"]);

  await login(owner.page, owner.email, password, true, pageUrl(doc));
  await expect(owner.page).toHaveURL(atPage(doc));
  await expect(textarea).toHaveValue("Written as the session expired");
  await me.getByTestId("commentor-composer-post").click();
  await expect(me.getByTestId("commentor-composer")).toHaveCount(0);
  await expect.poll(async () => (await publicThreads(doc.path)).map(thread => thread.body)).toEqual(["Written as the session expired"]);
});
