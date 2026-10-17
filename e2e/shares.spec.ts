import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, confirmDialog, failOnce, join, toasts } from "./org-fixtures";
import { holdRequest } from "./auth-helpers";
import { api, clipboard, fakeClipboard } from "./shell-helpers";
import { createKey, html, openManagement, pushSite, svg } from "./project-helpers";

const SEVEN_DAYS = 7 * 86_400_000;
type Grant = { _id: string; documentPath: string; assetPaths?: string[]; expiresAt: number; revokedAt?: number; deploymentId: string; tokenHash?: string };

const site = (heading = "Shared guide") => ({
  "index.html": html("Home"),
  "guide/page.html": html(heading, '<img src="mark.svg" alt="Mark"><p><a href="other.html">Other guide</a></p>', '<link rel="stylesheet" href="style.css">'),
  "guide/other.html": html("Other guide"),
  "guide/style.css": "h1{color:rgb(1,2,3)}",
  "guide/mark.svg": svg,
  "guide/unreferenced.svg": svg,
  "secret/notes.html": html("Secret notes"),
});
const listShares = async (page: Page, organizationId: string, projectId: string) =>
  (await api<{ shares: Grant[] }>(page, `/api/rendro/shares?organizationId=${organizationId}&projectId=${projectId}`)).body.shares;
const shareRow = (page: Page, text: string | RegExp) => page.locator("#share-list tr", { hasText: text });
const shareStatus = (page: Page, text: string | RegExp) => shareRow(page, text).locator("td[data-label=Status] .badge");
const tokenOf = (url: string) => new URL(url).pathname.split("/")[2];

/** What an anonymous recipient gets for a share URL: the shell, then the document and its assets, then anything else. */
async function recipientStatuses(context: BrowserContext, token: string, paths: string[]) {
  const result: Record<string, number> = { shell: (await context.request.get(`/s/${token}`)).status() };
  for (const path of paths) result[path] = (await context.request.get(`/s/${token}/files/${path}`)).status();
  return result;
}

test.describe("private shares", () => {
  test("a share made from a document opens for an anonymous recipient, stays within the document and its assets, and revoking it ends access", async ({ actor, secondContext, baseURL }) => {
    test.setTimeout(150_000);
    const owner = await actor("share", { organizations: ["Share Org"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    const { rawKey } = await createKey(page, organization.id, project);
    await pushSite(baseURL, organization.id, project, rawKey, site(), "share-v1");
    await fakeClipboard(page);
    const docs = `/organizations/${organization.id}/projects/${project}/docs`;

    // Nothing is shared yet: the list says so and points at the documentation.
    await openManagement(page, `${docs.replace("/docs", "/shares")}`);
    await expect(page.getByRole("heading", { name: "Private shares", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No private shares yet", level: 2 })).toBeVisible();
    await expect(page.getByText("Open a document and create a revocable share from the document toolbar.")).toBeVisible();
    await expect(page.locator("#share-list").getByRole("link", { name: "Browse documentation", exact: true })).toHaveAttribute("href", docs);
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Private shares", exact: true })).toHaveAttribute("aria-current", "page");

    // Create from the document toolbar: one click copies a seven-day link for exactly that document.
    await page.goto(`${docs}?doc=guide/page.html`);
    const frame = page.frameLocator("#content-frame");
    await expect(frame.getByRole("heading", { name: "Shared guide" })).toBeVisible();
    const share = page.getByRole("button", { name: "Share document", exact: true });
    await share.click();
    await expect(page.getByRole("button", { name: "Share link copied!", exact: true })).toBeVisible();
    await expect.poll(async () => (await clipboard(page)).length).toBe(1);
    const shareUrl = (await clipboard(page))[0];
    const token = tokenOf(shareUrl);
    expect(shareUrl).toBe(`${baseURL}/s/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [grant] = await listShares(page, organization.id, project);
    expect(grant).toMatchObject({ documentPath: "guide/page.html" });
    expect([...grant.assetPaths!].sort()).toEqual(["guide/mark.svg", "guide/style.css"]);
    expect(Math.abs(grant.expiresAt - (Date.now() + SEVEN_DAYS))).toBeLessThan(5 * 60_000);
    expect(grant.revokedAt).toBeUndefined();
    // The list never carries the link itself.
    expect(JSON.stringify(await listShares(page, organization.id, project))).not.toContain(token);

    // The recipient is anonymous: the shell, the one document, its stylesheet and image.
    const recipient = await secondContext.newPage();
    const response = await recipient.goto(shareUrl);
    expect(response!.status()).toBe(200);
    expect(response!.headers()["cache-control"]).toBe("private, no-store");
    expect(response!.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(response!.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(recipient).toHaveTitle("Share Org docs — Shared via Rendro");
    await expect(recipient.locator(".expiry")).toHaveText(`Expires ${new Date(grant.expiresAt).toISOString().slice(0, 10)}`);
    const shared = recipient.frameLocator("#content-frame");
    await expect(shared.getByRole("heading", { name: "Shared guide" })).toBeVisible();
    await expect(shared.getByRole("heading", { name: "Shared guide" })).toHaveCSS("color", "rgb(1, 2, 3)");
    await expect(shared.getByRole("img", { name: "Mark" })).toHaveJSProperty("naturalWidth", 8);
    await expect(recipient.locator("#cp-org-switcher, [data-comment-toolbar], .commentor-toolbar")).toHaveCount(0);

    // Scope: the document and its referenced assets only. Sibling documents, unreferenced files, other folders,
    // another document by query and a changed token are all 404, never another file.
    expect(await recipientStatuses(secondContext, token, ["guide/page.html", "guide/style.css", "guide/mark.svg", "guide/other.html", "guide/unreferenced.svg", "secret/notes.html", "index.html", "guide/missing.html"]))
      .toEqual({ shell: 200, "guide/page.html": 200, "guide/style.css": 200, "guide/mark.svg": 200, "guide/other.html": 404, "guide/unreferenced.svg": 404, "secret/notes.html": 404, "index.html": 404, "guide/missing.html": 404 });
    expect((await secondContext.request.get(`/s/${token}?doc=guide/other.html`)).status()).toBe(404);
    expect((await secondContext.request.get(`/s/${token}?doc=guide/page.html`)).status()).toBe(200);
    expect((await secondContext.request.get(`/s/${token}/files/guide/..%2Fsecret/notes.html`)).status()).toBeGreaterThanOrEqual(400);
    const altered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(await recipientStatuses(secondContext, altered, ["guide/page.html"])).toEqual({ shell: 404, "guide/page.html": 404 });
    expect((await secondContext.request.get(`/s/${"x".repeat(43)}`)).status()).toBe(404);

    // A later deployment does not change what was shared: the link is pinned to the release it was made from.
    await pushSite(baseURL, organization.id, project, rawKey, site("Shared guide, next release"), "share-v2");
    await recipient.reload();
    await expect(recipient.frameLocator("#content-frame").getByRole("heading", { name: "Shared guide", exact: true })).toBeVisible();
    await expect(recipient.frameLocator("#content-frame").getByText("next release")).toHaveCount(0);

    // The management list shows the grant without the link, as Active with its deployment and expiry.
    await openManagement(page, `/organizations/${organization.id}/projects/${project}/shares`);
    const row = shareRow(page, "guide/page.html");
    await expect(row).toHaveCount(1);
    await expect(row.locator("td[data-label=Document]")).toHaveText("guide/page.html");
    await expect(row.locator("td[data-label=Deployment] .cp-id")).toHaveText(grant.deploymentId);
    await expect(row.locator("td[data-label=Expires]")).toHaveText(await page.evaluate(time => new Date(time).toLocaleString(), grant.expiresAt));
    await expect(shareStatus(page, "guide/page.html")).toHaveText("Active");
    await expect(shareStatus(page, "guide/page.html")).toHaveClass(/success/);
    expect(await page.locator("#share-list").textContent()).not.toContain(token);
    await expect(page.locator("#share-access-note")).toBeHidden();

    // Revoke: dismissing leaves the link working; confirming ends it on the recipient's very next request.
    const revoke = row.getByRole("button", { name: "Revoke", exact: true });
    await revoke.click();
    const confirm = confirmDialog(page);
    await expect(confirm.locator("#cp-confirm-title")).toHaveText("Revoke private share?");
    await expect(confirm.locator("#cp-confirm-message")).toHaveText("The link to guide/page.html will stop resolving immediately.");
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(revoke).toBeFocused();
    await expect(shareStatus(page, "guide/page.html")).toHaveText("Active");
    expect((await secondContext.request.get(`/s/${token}`)).status()).toBe(200);
    // A failed revocation says so, leaves the share active and the link working, and can be retried.
    const hold = await holdRequest(page, "/api/rendro/shares/revoke");
    try {
      await revoke.click();
      await confirm.locator("[data-confirm-accept]").click();
      await expect(revoke).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => hold.count()).toBe(1);
      hold.release(true);
      await expect(toasts(page).filter({ hasText: "Service unavailable. Please try again." })).toHaveCount(1);
    } finally {
      await hold.close();
    }
    await expect(revoke).toBeEnabled();
    await expect(shareStatus(page, "guide/page.html")).toHaveText("Active");
    expect((await secondContext.request.get(`/s/${token}`)).status()).toBe(200);
    await revoke.click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(toasts(page).filter({ hasText: "Private share revoked." })).toHaveCount(1);
    await expect(shareStatus(page, "guide/page.html")).toHaveText("Revoked");
    await expect(shareStatus(page, "guide/page.html")).toHaveClass(/danger/);
    await expect(shareRow(page, "guide/page.html").getByRole("button")).toHaveCount(0);
    expect(await recipientStatuses(secondContext, token, ["guide/page.html", "guide/style.css", "guide/mark.svg"])).toEqual({ shell: 404, "guide/page.html": 404, "guide/style.css": 404, "guide/mark.svg": 404 });
    const gone = await recipient.goto(shareUrl);
    expect(gone!.status()).toBe(404);
    await expect(recipient.getByText("Page not found")).toBeVisible();
    await expect(recipient.locator("#content-frame")).toHaveCount(0);
    expect((await listShares(page, organization.id, project))[0].revokedAt).toBeGreaterThan(0);
    // Revoking twice is harmless; a revoked link cannot come back, and a new share is independent of it.
    expect((await api(page, "/api/rendro/shares/revoke", { organizationId: organization.id, grantId: grant._id })).status).toBe(200);
    expect((await secondContext.request.get(`/s/${token}`)).status()).toBe(404);
  });

  test("expiry: short-lived links stop at their time, the list tells the states apart, and invalid shares are refused", async ({ actor, secondContext, baseURL }) => {
    test.setTimeout(150_000);
    const owner = await actor("share-expiry", { organizations: ["Share Expiry"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    const create = (data: object) => api<{ grant?: Grant; token?: string; url?: string; error?: string }>(page, "/api/rendro/shares", { organizationId: organization.id, projectId: project, documentPath: "guide/page.html", expiresInSeconds: 3600, ...data });

    // The list read can fail: the page says so and recovers with Try again.
    const outage = await failOnce(page, "**/api/rendro/shares?*", "Share list unavailable");
    await page.goto(`/organizations/${organization.id}/projects/${project}/shares`);
    await expect(page.getByRole("heading", { name: "Unable to load private shares", level: 2 })).toBeVisible();
    await expect(page.locator("#share-list .empty p")).toHaveText("Share list unavailable");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No private shares yet", level: 2 })).toBeVisible();
    expect(outage.failures()).toBe(1);
    await outage.close();

    // No deployment yet: there is nothing to share, and the list explains how to get started.
    const early = await create({});
    expect(early.status).toBe(404);
    expect(early.body.error).toBe("Share requires an available deployment");
    await openManagement(page, `/organizations/${organization.id}/projects/${project}/shares`);
    await expect(page.getByText("Private shares are created from documentation after the first deployment.")).toBeVisible();
    await expect(page.locator("#share-list").getByRole("link", { name: "View deployments", exact: true })).toHaveAttribute("href", `/organizations/${organization.id}/projects/${project}/deployments`);
    await expect(page.locator("#share-browse-docs")).toBeHidden();

    const { rawKey } = await createKey(page, organization.id, project);
    await pushSite(baseURL, organization.id, project, rawKey, site(), "share-expiry");

    // Everything the server refuses, each leaving no grant behind.
    const refused: Array<[string, object, number]> = [
      ["shorter than a minute", { expiresInSeconds: 59 }, 400],
      ["longer than thirty days", { expiresInSeconds: 30 * 86_400 + 1 }, 400],
      ["a non-numeric lifetime", { expiresInSeconds: "3600" }, 400],
      ["a path outside the deployment", { documentPath: "../guide/page.html" }, 400],
      ["an absolute path", { documentPath: "/guide/page.html" }, 400],
      ["a missing document", { documentPath: "guide/nothing.html" }, 400],
      ["a stylesheet as the document", { documentPath: "guide/style.css" }, 400],
      ["a project that does not exist", { projectId: "k".repeat(32) }, 404],
    ];
    for (const [label, extra, status] of refused) {
      const response = await create(extra);
      expect([status, 400, 404], label).toContain(response.status);
      expect(response.status, label).toBeGreaterThanOrEqual(400);
    }
    expect(await listShares(page, organization.id, project)).toEqual([]);

    // A one-minute link, an hour-long link and a week-long link; all open now.
    const minute = await create({ expiresInSeconds: 60 });
    const hour = await create({ expiresInSeconds: 3600 });
    const week = await create({ expiresInSeconds: 7 * 86_400, documentPath: "guide/other.html" });
    for (const made of [minute, hour, week]) expect(made.status, JSON.stringify(made.body)).toBe(201);
    const tokens = { minute: minute.body.token!, hour: hour.body.token!, week: week.body.token! };
    for (const token of Object.values(tokens)) expect((await secondContext.request.get(`/s/${token}`)).status()).toBe(200);

    await openManagement(page, `/organizations/${organization.id}/projects/${project}/shares`);
    await expect(page.locator("#share-list tr")).toHaveCount(3);
    await expect(shareStatus(page, "guide/other.html")).toHaveText("Active");
    // Under a day left is "Expiring" (the one-minute link may already have lapsed on a slow host, so it is checked after expiry).
    const hourRow = page.locator("#share-list tr").nth(1);
    await expect(hourRow.locator("td[data-label=Status] .badge")).toHaveText("Expiring");
    await expect(hourRow.locator(".badge.warning")).toHaveCount(1);

    // Reaching the expiry time ends access on the very next request, while the other links keep working.
    await expect.poll(async () => (await secondContext.request.get(`/s/${tokens.minute}`)).status(), { timeout: 100_000, intervals: [1000, 2000] }).toBe(404);
    expect(await recipientStatuses(secondContext, tokens.minute, ["guide/page.html", "guide/style.css"])).toEqual({ shell: 404, "guide/page.html": 404, "guide/style.css": 404 });
    expect((await secondContext.request.get(`/s/${tokens.hour}`)).status()).toBe(200);
    expect((await secondContext.request.get(`/s/${tokens.week}`)).status()).toBe(200);
    await openManagement(page, `/organizations/${organization.id}/projects/${project}/shares`);
    const expired = page.locator("#share-list tr", { has: page.locator(".badge.danger") });
    await expect(expired).toHaveCount(1);
    await expect(expired.locator("td[data-label=Status] .badge")).toHaveText("Expired");
    // An expired link has nothing left to revoke; the live ones can still be.
    await expect(expired.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(2);
    // Revoked and expired are different states: revoking the hour link leaves two non-active rows.
    await page.locator("#share-list tr").nth(1).getByRole("button", { name: "Revoke" }).click();
    await confirmDialog(page).locator("[data-confirm-accept]").click();
    await expect(page.locator("#share-list td[data-label=Status] .badge")).toHaveText(["Active", "Revoked", "Expired"]);
    expect((await secondContext.request.get(`/s/${tokens.hour}`)).status()).toBe(404);
    expect((await secondContext.request.get(`/s/${tokens.week}`)).status()).toBe(200);
  });

  test("owner, admin, member and outsider: who creates, sees and revokes shares", async ({ actor, secondContext, baseURL }) => {
    test.setTimeout(150_000);
    const owner = await actor("share-owner", { organizations: ["Share Roles"], project: true });
    const admin = await actor("share-admin");
    const member = await actor("share-member");
    const outsider = await actor("share-outsider", { organizations: ["Share Elsewhere"], project: true });
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    await join(owner, organization.id, admin, "admin");
    await join(owner, organization.id, member, "member");
    const { rawKey } = await createKey(owner.page, organization.id, project);
    await pushSite(baseURL, organization.id, project, rawKey, site(), "share-roles");
    const docs = `/organizations/${organization.id}/projects/${project}/docs?doc=guide/page.html`;
    const shares = `/organizations/${organization.id}/projects/${project}/shares`;

    // A member can create a share from documentation (copying a working link), but cannot revoke it.
    await fakeClipboard(member.page);
    await member.page.goto(docs);
    await expect(member.page.frameLocator("#content-frame").getByRole("heading", { name: "Shared guide" })).toBeVisible();
    await member.page.getByRole("button", { name: "Share document", exact: true }).click();
    await expect(member.page.getByRole("button", { name: "Share link copied!", exact: true })).toBeVisible();
    await expect.poll(async () => (await clipboard(member.page)).length).toBe(1);
    const memberToken = tokenOf((await clipboard(member.page))[0]);
    expect((await secondContext.request.get(`/s/${memberToken}`)).status()).toBe(200);
    await openManagement(member.page, shares);
    await expect(member.page.locator("#share-access-note")).toHaveText("You can view private-share history and create links from documentation. Only owners and admins can revoke links.");
    await expect(shareStatus(member.page, "guide/page.html")).toHaveText("Active");
    await expect(shareRow(member.page, "guide/page.html").locator("td[data-label=Action]")).toHaveText("Owner/admin only");
    await expect(member.page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
    const [grant] = await listShares(owner.page, organization.id, project);
    expect((await api(member.page, "/api/rendro/shares/revoke", { organizationId: organization.id, grantId: grant._id })).status).toBe(403);
    expect((await secondContext.request.get(`/s/${memberToken}`)).status()).toBe(200);

    // The owner sees the same list and note-free page; an admin revokes the member's share and it ends at once.
    await openManagement(owner.page, shares);
    await expect(owner.page.locator("#share-access-note")).toBeHidden();
    await expect(shareRow(owner.page, "guide/page.html").getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
    await openManagement(admin.page, shares);
    await expect(admin.page.locator("#share-access-note")).toBeHidden();
    await shareRow(admin.page, "guide/page.html").getByRole("button", { name: "Revoke", exact: true }).click();
    await confirmDialog(admin.page).locator("[data-confirm-accept]").click();
    await expect(shareStatus(admin.page, "guide/page.html")).toHaveText("Revoked");
    expect((await secondContext.request.get(`/s/${memberToken}`)).status()).toBe(404);

    // An outsider cannot create, list or revoke shares of this organization and has no page for them.
    const created = await api<{ token: string }>(owner.page, "/api/rendro/shares", { organizationId: organization.id, projectId: project, documentPath: "guide/page.html", expiresInSeconds: 3600 });
    expect(created.status).toBe(201);
    const denied = await outsider.page.goto(shares);
    expect(denied!.status()).toBe(404);
    await expect(outsider.page.getByText("Page not found")).toBeVisible();
    expect((await api(outsider.page, `/api/rendro/shares?organizationId=${organization.id}&projectId=${project}`)).status).toBe(403);
    expect((await api(outsider.page, "/api/rendro/shares", { organizationId: organization.id, projectId: project, documentPath: "guide/page.html", expiresInSeconds: 3600 })).status).toBe(403);
    const live = (await listShares(owner.page, organization.id, project)).find(entry => !entry.revokedAt)!;
    expect((await api(outsider.page, "/api/rendro/shares/revoke", { organizationId: organization.id, grantId: live._id })).status).toBe(403);
    // Naming their own organization does not let them revoke someone else's grant, and the grant of another organization cannot be created for this project.
    expect((await api(outsider.page, "/api/rendro/shares/revoke", { organizationId: outsider.organizations[0].id, grantId: live._id })).status).toBeGreaterThanOrEqual(400);
    expect((await api(outsider.page, "/api/rendro/shares", { organizationId: outsider.organizations[0].id, projectId: project, documentPath: "guide/page.html", expiresInSeconds: 3600 })).status).toBeGreaterThanOrEqual(400);
    expect((await secondContext.request.get(`/s/${created.body.token}`)).status()).toBe(200);
    expect((await listShares(owner.page, organization.id, project)).filter(entry => !entry.revokedAt)).toHaveLength(1);

    // Anonymous visitors cannot create or list shares and are sent to sign in for the page.
    const visitor = await secondContext.newPage();
    await visitor.goto(shares);
    await expect(visitor).toHaveURL(`/sign-in?returnTo=${encodeURIComponent(shares)}`);
    const anonymous = await api(visitor, "/api/rendro/shares", { organizationId: organization.id, projectId: project, documentPath: "guide/page.html", expiresInSeconds: 3600 });
    expect([401, 403]).toContain(anonymous.status);
    expect([401, 403]).toContain((await api(visitor, `/api/rendro/shares?organizationId=${organization.id}&projectId=${project}`)).status);
  });
});
