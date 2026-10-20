import { test, expect, join } from "./org-fixtures";
import { ageRecord, login, session, signout } from "./auth-helpers";
import { password } from "./seed";
import { commentSite, convexSocket, createThread, heading, intro, openDocument, publish, startSelectionComment, storedDrafts, storedOperations, threadsOf, widget, commentDoc } from "./comment-helpers";

/**
 * Losing the session, the connection or the document under a comment (#115). The parent shell owns the realtime
 * connection and the durable recovery state; the sandboxed widget holds nothing it could keep across a reload. Server
 * state is re-read with a person's own session, and a second person's open document shows what the server holds.
 */
const outcomeUnknown = "The comment connection was replaced before confirmation. The outcome is unknown; your change may still be saved. Resubmitting this action is safe; it will reuse the original operation.";

test.describe("session loss", () => {
  test("a draft survives signing out in another tab and returns after signing back in, but never appears for another account", async ({ actor }) => {
    test.setTimeout(240_000);
    const site = await commentSite(actor, "session");
    const owner = site.owner;
    const other = await actor("someone");
    await join(owner, site.organizationId, other, "member");
    const ui = widget(owner.page);
    await openDocument(owner.page, site);
    await startSelectionComment(owner.page);
    await ui.getByTestId("commentor-composer-textarea").fill("Unsent thought");
    await expect.poll(() => storedDrafts(owner.page)).toEqual(["Unsent thought"]);

    // Another tab signs out: the viewer replaces itself with the signed-out notice and its comment surface is gone.
    const tab = await owner.context.newPage();
    await tab.goto("/account/security");
    await signout(tab);
    await expect(owner.page.locator("#rendro-signed-out")).toBeVisible();
    await expect(owner.page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
    await expect(owner.page.locator("#content-frame")).toBeHidden();
    await expect(owner.page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    await expect(owner.page.locator("html")).toHaveAttribute("data-rendro-signed-out", "true");
    // Nothing was posted, and the draft stays in the tab's user-bound storage rather than being sent anywhere.
    expect(await storedDrafts(owner.page)).toEqual(["Unsent thought"]);
    await tab.close();

    // Signing back in as the same person restores the composer with the same text on the same selection.
    const documentUrl = `${site.docs}?doc=index.html`;
    await login(owner.page, owner.email, password, true, documentUrl);
    await expect(owner.page).toHaveURL(new RegExp(`${site.docs}\\?doc=index\\.html$`));
    await expect(ui.getByTestId("commentor-composer-textarea")).toHaveValue("Unsent thought");
    await expect(ui.getByTestId("commentor-composer").locator(".anchor-label")).toContainText("On: “");
    expect(await threadsOf(other.page, site)).toHaveLength(0);
    await ui.getByTestId("commentor-composer-post").click();
    await expect(ui.getByTestId("commentor-composer")).toHaveCount(0);
    // The composer closes at once (#284); the post is saved a round trip later.
    await expect.poll(async () => (await threadsOf(other.page, site)).map(thread => thread.body)).toEqual(["Unsent thought"]);
    await expect.poll(() => storedDrafts(owner.page)).toEqual([]);

    // A second draft, then a different account signs in on the same tab: the first person's draft is gone for good.
    await startSelectionComment(owner.page);
    await ui.getByTestId("commentor-composer-textarea").fill("Private to the owner");
    await expect.poll(() => storedDrafts(owner.page)).toEqual(["Private to the owner"]);
    const second = await owner.context.newPage();
    await second.goto("/account/security");
    await signout(second);
    await second.close();
    await expect(owner.page.locator("#rendro-signed-out")).toBeVisible();
    await login(owner.page, other.email, password, true, documentUrl);
    await expect(owner.page).toHaveURL(new RegExp(`${site.docs}\\?doc=index\\.html$`));
    await expect(ui.getByTestId("commentor-pin")).toHaveCount(1);
    await expect(ui.getByTestId("commentor-composer")).toHaveCount(0);
    expect(await storedDrafts(owner.page)).toEqual([]);
    expect(await owner.page.evaluate(() => JSON.stringify({ ...sessionStorage }))).not.toContain("Private to the owner");
    expect(await owner.page.evaluate(() => document.body.innerText)).not.toContain("Private to the owner");
  });

  test("a revoked session is noticed when the page regains focus, and the draft returns once the person signs in again", async ({ actor }) => {
    test.setTimeout(240_000);
    const site = await commentSite(actor, "revoked");
    const owner = site.owner;
    const ui = widget(owner.page);
    await openDocument(owner.page, site);
    await startSelectionComment(owner.page);
    await ui.getByTestId("commentor-composer-textarea").fill("Written as the session expired");
    await expect.poll(() => storedDrafts(owner.page)).toEqual(["Written as the session expired"]);

    // The backend revokes the session; no tab signed out, so nothing is broadcast. Focus is what finds out.
    const identity = await session(owner.page);
    await ageRecord("session", "_id", identity?.sessionId ?? "", { expiresAt: Date.now() - 1000 });
    await owner.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(owner.page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
    await expect(owner.page.locator("#content-frame")).toBeHidden();
    expect(await session(owner.page)).toBeNull();
    expect((await owner.page.request.get("/api/auth/convex/token")).ok()).toBe(false);
    expect(await storedDrafts(owner.page)).toEqual(["Written as the session expired"]);

    await login(owner.page, owner.email, password, true, `${site.docs}?doc=index.html`);
    await expect(ui.getByTestId("commentor-composer-textarea")).toHaveValue("Written as the session expired");
    await ui.getByTestId("commentor-composer-post").click();
    await expect(ui.getByTestId("commentor-composer")).toHaveCount(0);
    await expect.poll(async () => (await threadsOf(owner.page, site)).map(thread => thread.body)).toEqual(["Written as the session expired"]);
  });
});

test.describe("connection loss", () => {
  test("a connection replaced mid-mutation reports an unknown outcome, and resubmitting is idempotent", async ({ actor }) => {
    test.setTimeout(240_000);
    const site = await commentSite(actor, "lost");
    const owner = site.owner;
    const reader = await actor("watcher");
    await join(owner, site.organizationId, reader, "member");
    const socket = await convexSocket(owner.page);
    await openDocument(reader.page, site);
    await openDocument(owner.page, site);
    const ui = widget(owner.page);
    await startSelectionComment(owner.page);
    await ui.getByTestId("commentor-composer-textarea").fill("Survives a lost response");

    // The request reaches the server, but its answer (and every later update) never reaches this page.
    socket.blackhole(true);
    await ui.getByTestId("commentor-composer-post").click();
    // Optimistic (#284): the owner's thread shows at once, marked as sending, and stays so with no answer.
    await expect(ui.locator('[data-testid="commentor-pin"].is-sending')).toHaveCount(1);
    await expect.poll(async () => (await threadsOf(reader.page, site)).map(thread => thread.body)).toEqual(["Survives a lost response"]);
    const [committed] = await threadsOf(reader.page, site);
    await expect(widget(reader.page).getByTestId("commentor-pin")).toHaveCount(1);
    await expect(ui.locator('[data-testid="commentor-pin"]:not(.is-sending)')).toHaveCount(0);
    expect(await storedOperations(owner.page)).toEqual([expect.objectContaining({ method: "thread.create", clientOperationId: expect.any(String) })]);

    // The page (and with it the connection) is replaced before any confirmation: the reader is told, honestly, that the
    // outcome is unknown. The tab's session storage carries the operation across.
    await owner.page.reload();
    const alert = ui.locator('.toast[role="alert"]');
    await expect(alert).toHaveText(new RegExp(outcomeUnknown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(ui.getByTestId("commentor-composer-textarea")).toHaveValue("Survives a lost response");
    const [operation] = await storedOperations(owner.page);
    expect(operation.clientOperationId).toBe(committed.clientOperationId);

    // Resubmitting while still offline reuses the original operation; reconnecting delivers both sends to the server.
    await ui.getByTestId("commentor-composer-post").click();
    await expect(ui.locator('[data-testid="commentor-pin"].is-sending')).toHaveCount(1);
    socket.blackhole(false);
    await socket.drop();
    await expect(ui.getByTestId("commentor-composer")).toHaveCount(0);
    await expect(ui.locator('[data-testid="commentor-pin"]:not(.is-sending)')).toHaveCount(1);
    await expect(ui.locator('[data-testid="commentor-pin"]')).toHaveCount(1);
    const after = await threadsOf(reader.page, site);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ _id: committed._id, body: "Survives a lost response", clientOperationId: operation.clientOperationId });
    await expect(widget(reader.page).getByTestId("commentor-pin")).toHaveCount(1);
    await expect.poll(() => storedOperations(owner.page)).toEqual([]);
    expect(await storedDrafts(owner.page)).toEqual([]);
  });
});

test.describe("redeploy", () => {
  test("anchors that the new document no longer has are shown as orphaned, and the comments stay usable", async ({ actor }) => {
    test.setTimeout(240_000);
    const site = await commentSite(actor, "orphans");
    const owner = site.owner;
    const reader = await actor("rereader");
    await join(owner, site.organizationId, reader, "member");
    const textual = await createThread(owner.page, site, "About the sentence", intro);
    await createThread(owner.page, site, "About the second paragraph", { kind: "element", path: ["main", "p:nth-of-type(2)"] });
    await createThread(owner.page, site, "About the title", heading);
    await openDocument(reader.page, site);
    const ui = widget(reader.page);
    await expect(ui.getByTestId("commentor-pin")).toHaveCount(3);
    const notice = reader.page.locator("#viewer-update-notice");
    await expect(notice).toBeHidden();

    // The owner publishes a revision that rewrites the first paragraph and drops the second.
    await publish(site, { "index.html": commentDoc().replace(/<p id="intro">.*?<\/p><p id="second">.*?<\/p>/, '<p id="intro">An entirely new introduction.</p>') });
    await expect(notice).toBeVisible();
    await expect(notice.locator('[role="status"]')).toHaveText("A newer version of this document was published.");
    await notice.getByRole("button", { name: "Reload" }).click();
    await expect(reader.page.frameLocator("#content-frame").getByText("An entirely new introduction.")).toBeVisible();

    // Only the comment whose anchor still exists keeps a pin; the others are listed as orphaned and say so.
    // Pins of orphaned threads stay in the DOM but are not displayed.
    const shown = ui.getByTestId("commentor-pin").filter({ visible: true });
    await expect(shown).toHaveCount(1);
    await expect(shown).toHaveAttribute("aria-label", `Thread 3 by ${owner.name}`);
    await expect(ui.getByTestId("commentor-pin")).toHaveCount(3);
    await ui.getByTestId("commentor-panel-btn").click();
    const cards = ui.locator(".drawer-thread");
    await expect(cards).toHaveCount(3);
    await expect(ui.locator(".drawer-thread.is-orphan")).toHaveCount(2);
    await expect(ui.locator(".drawer-thread.is-orphan")).toContainText(["Anchor no longer found", "Anchor no longer found"]);
    await expect(cards.filter({ hasText: "About the title" })).not.toHaveClass(/is-orphan/);

    // Locating an orphan explains itself politely instead of failing silently.
    await cards.filter({ hasText: "About the sentence" }).locator(".quote").click();
    await expect(ui.locator('.toast[role="alert"]')).toHaveText("This comment’s anchor is no longer available.");
    // The comment itself is intact: it can be answered and resolved, and the server records both.
    await cards.filter({ hasText: "About the sentence" }).getByTestId("commentor-reply-input").fill("Still relevant?");
    await cards.filter({ hasText: "About the sentence" }).getByTestId("commentor-reply-send").click();
    await expect(cards.filter({ hasText: "About the sentence" }).locator(".reply:not(.is-sending)")).toHaveCount(1);
    await cards.filter({ hasText: "About the sentence" }).getByTestId("commentor-resolve-btn").click();
    await expect(cards).toHaveCount(2);
    const [stored] = (await threadsOf(owner.page, site)).filter(thread => thread._id === textual);
    expect(stored).toMatchObject({ resolved: true, replies: [expect.objectContaining({ body: "Still relevant?" })] });
  });
});
