import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { comment, open, repos, ui, unique } from "./comment-helpers";
import { githubSignInLogin } from "./repo-fixtures";
import { desktop } from "./shell-helpers";

/**
 * GitHub sign-in (#338) on the real Worker, the local Convex and the real control Worker, against the harness's fake
 * GitHub: Convex's code exchange and user reads terminate in the identity fixture, and the browser's visit to GitHub's
 * authorize page is a consent page served here, as GitHub would show it.
 */
test.use({ viewport: desktop });

test.beforeEach(({ cspViolations }) => { void cspViolations; });
test.afterEach(({ cspViolations }) => {
  expect(cspViolations.filter(message => !/x-frame-options/i.test(message)), "CSP violations").toEqual([]);
});

/**
 * GitHub's authorize page, as the reader sees it: a consent page whose one link carries `login`'s decision back to the
 * Worker's callback (a code, or a denial). The reader follows it with a click, a top-level navigation as on GitHub, so
 * every engine runs it (WebKit cannot fulfill an intercepted request with a redirect).
 */
async function githubConsent(page: Page, login: string, decision: "approve" | "deny" = "approve") {
  await page.route("https://github.com/login/oauth/authorize**", async route => {
    const params = new URL(route.request().url()).searchParams;
    params.set("as", login);
    params.set("decision", decision);
    const response = await fetch(`${repos().control}/github/authorize?${params}`);
    expect(response.status).toBe(200);
    const { location } = await response.json() as { location: string };
    const href = location.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Authorize Rendro</title><a href="${href}">${decision === "approve" ? "Authorize Rendro" : "Cancel"}</a>` });
  });
  return async () => {
    await page.waitForURL("https://github.com/login/oauth/authorize**");
    await page.getByRole("link", { name: decision === "approve" ? "Authorize Rendro" : "Cancel" }).click();
  };
}

/** A page of the private repository of its own, so a repetition or a retry starts with no comments on it. */
async function privatePage(label: string) {
  const path = `docs/journeys/${label}-${randomBytes(4).toString("hex")}.md`;
  const response = await fetch(`${repos().control}/commit/comments-private`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes: { [path]: "# Journey\n\n## Notes\n\nOnly collaborators read this.\n" } }),
  });
  expect(response.status).toBe(200);
  return { path, commit: (await response.json() as { commit: string }).commit };
}

test("a reader signs in with GitHub, finds their private repository on the home, opens its docs and comments on them", async ({ page }, info) => {
  test.setTimeout(120_000);
  const login = githubSignInLogin(info.project.name);
  const consent = await githubConsent(page, login);
  await page.goto("/sign-in?returnTo=%2Fhome");
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
  await consent();
  await page.waitForURL(url => url.pathname === "/home");
  await expect(page.getByText(`${login}@example.test`)).toBeVisible();
  // The control Worker now holds the reader's GitHub tokens: the home lists what GitHub lets them read (#338),
  // the two private repositories they collaborate on and none of the others, and each opens its docs.
  const { commentsPrivate, closed } = repos();
  const listed = page.getByRole("region", { name: "Your repositories" }).getByRole("listitem");
  await expect(listed).toHaveCount(2);
  // closed-docs carries a last push (the fixture's), so it comes first; comment-private has none.
  await expect(listed.getByRole("link")).toHaveText([`${closed.owner}/${closed.name}PrivateUpdated Oct 1, 2026`, `${commentsPrivate.owner}/${commentsPrivate.name}Private`]);
  await page.getByRole("link", { name: `${commentsPrivate.owner}/${commentsPrivate.name}` }).click();
  await page.waitForURL(url => url.pathname === `/r/${commentsPrivate.owner}/${commentsPrivate.name}`);
  await expect(page.locator("#content-frame")).toBeAttached();
  const doc = await privatePage("github");
  await open(page, commentsPrivate, doc.path, doc.commit);
  await expect(ui(page).getByText("Only collaborators read this.")).toBeVisible();
  await comment(page, "Only collaborators", unique("Signed in with GitHub"));
});

test("a reader who cancels on GitHub returns to the sign-in page, signed out", async ({ page }, info) => {
  const consent = await githubConsent(page, githubSignInLogin(info.project.name), "deny");
  await page.goto("/sign-in?returnTo=%2Fhome");
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
  await consent();
  await page.waitForURL(url => url.pathname === "/sign-in" && url.searchParams.get("error") === "access_denied");
  await expect(page.locator("#github-error")).toHaveText("Sign-in was canceled. Try again or sign in with your email and password.");
  await page.goto("/home");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fhome$/);
});
