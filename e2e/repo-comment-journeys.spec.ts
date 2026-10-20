import type { Page } from "@playwright/test";
import { test, expect } from "./actor-fixtures";
import { addReply, anchorOn, card, convexCallWith, createThread, journeyDoc, open, openDrawer, pauseClock, pin, repoIds, repos, sessionToken, threadsAs, ui, writeThread } from "./comment-helpers";
import { desktop } from "./shell-helpers";

/**
 * The comment widget's journeys on repository docs (#302, ported from the project-document specs #286 removed), on the
 * real Worker and the local Convex. Every person is a fresh account in a context of their own, and every test comments on
 * a page of its own (`journeyDoc`), so tests stay independent across retries and shards. Final state is asserted in the
 * widget (DOM, ARIA, announced toasts), on the server (re-read with the person's own session) and in another reader's
 * open page.
 */
test.use({ viewport: desktop });

test.beforeEach(({ cspViolations }) => { void cspViolations; });
test.afterEach(({ cspViolations }) => {
  expect(cspViolations.filter(message => !/x-frame-options/i.test(message)), "CSP violations").toEqual([]);
});

const toast = (page: Page, role: "status" | "alert") => ui(page).locator(`.toast[role="${role}"]`);
const count = (page: Page) => ui(page).locator(".content-head .count");

test("a deleted comment can be undone within its window and is then removed for good", async ({ actor, secondContext }) => {
  test.setTimeout(180_000);
  const { comments } = repos();
  const doc = await journeyDoc("undo");
  const scope = { repoId: repoIds.comments, path: doc.path };
  const author = await actor("undo");
  // Only the test moves the clock while it matters: the five-second undo window and the toast's exit run on it.
  await author.page.clock.install();
  await open(author.page, comments, doc.path, doc.commit);
  const token = await sessionToken(author.page);
  await createThread(token, scope, "Gone soon", await anchorOn(author.page, "quick brown"));
  const staysId = await createThread(token, scope, "Stays", await anchorOn(author.page, "second paragraph"));
  const reader = await secondContext.newPage();
  await open(reader, comments, doc.path, doc.commit);
  const me = ui(author.page), they = ui(reader);
  await expect(pin(author.page, "Gone soon")).toBeVisible();
  await expect(pin(author.page, "Stays")).toBeVisible();
  await expect(they.getByTestId("commentor-pin")).toHaveCount(2);
  await pauseClock(author.page);

  // Delete hides the comment locally with an announced Undo; nothing is written, the other reader still sees it.
  await pin(author.page, "Gone soon").click();
  await me.getByTestId("commentor-thread-bubble").getByTestId("commentor-delete-btn").click();
  await expect(me.getByTestId("commentor-pin")).toHaveCount(1);
  await author.page.clock.runFor(200);
  await expect(me.getByTestId("commentor-thread-bubble")).toHaveCount(0);
  const deleted = toast(author.page, "status");
  await expect(deleted).toContainText("Comment deleted.");
  expect((await threadsAs(token, scope)).map(thread => thread.body).sort()).toEqual(["Gone soon", "Stays"]);
  await expect(they.getByTestId("commentor-pin")).toHaveCount(2);

  // Undo restores it, and the window passing afterwards removes nothing.
  await deleted.getByRole("button", { name: "Undo" }).click();
  await expect(me.getByTestId("commentor-pin")).toHaveCount(2);
  await expect(toast(author.page, "status").last()).toContainText("Deletion undone.");
  await author.page.clock.fastForward(6000);
  await author.page.clock.runFor(200);
  expect(await threadsAs(token, scope)).toHaveLength(2);
  await expect(they.getByTestId("commentor-pin")).toHaveCount(2);

  // Deleting again and letting the window pass commits exactly once; the other reader's page drops it live.
  await pin(author.page, "Gone soon").click();
  await me.getByTestId("commentor-thread-bubble").getByTestId("commentor-delete-btn").click();
  await author.page.clock.fastForward(5000);
  await author.page.clock.resume();
  await expect.poll(async () => (await threadsAs(token, scope)).map(thread => thread.body)).toEqual(["Stays"]);
  await expect(me.getByTestId("commentor-pin")).toHaveCount(1);
  await expect(they.getByTestId("commentor-pin")).toHaveCount(1);
  await expect(count(reader)).toHaveAttribute("aria-label", "1 active comment");
  expect((await threadsAs(undefined, scope))[0]._id).toBe(staysId);
  // A deleted thread is gone for a reader who arrives later, too.
  await open(reader, comments, doc.path, doc.commit);
  await expect(pin(reader, "Stays")).toBeVisible();
  await expect(they.getByTestId("commentor-pin")).toHaveCount(1);
});

test("the Active, Resolved and History views follow each comment's status, from the drawer and from the server", async ({ actor }) => {
  test.setTimeout(180_000);
  const { comments } = repos();
  const doc = await journeyDoc("filters");
  const scope = { repoId: repoIds.comments, path: doc.path };
  const author = await actor("filters");
  const { page } = author;
  await open(page, comments, doc.path, doc.commit);
  const token = await sessionToken(page);
  const anchor = await anchorOn(page, "quick brown");
  await createThread(token, scope, "Active one", anchor);
  const second = await createThread(token, scope, "Active two", anchor);
  const resolved = await createThread(token, scope, "Resolved one", anchor);
  const archived = await createThread(token, scope, "Archived one", anchor);
  expect((await writeThread(token, scope, "resolve", resolved, { resolved: true })).ok).toBe(true);
  expect((await writeThread(token, scope, "archive", archived, { archived: true })).ok).toBe(true);
  const me = ui(page);
  const tabs = me.getByRole("tab");
  const list = me.getByTestId("commentor-drawer-list");
  const bodies = me.locator(".drawer-thread .thread-view > .body");
  await expect(me.getByTestId("commentor-pin")).toHaveCount(2);
  await openDrawer(page);

  // Views carry live counts; Active is the default and shows only active, unarchived threads.
  await expect(tabs).toHaveText(["Active2", "Resolved1", "History1"]);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(list).toHaveAttribute("aria-label", "Active comments");
  await expect(bodies).toHaveText(["Active one", "Active two"]);
  await expect(count(page)).toHaveAttribute("aria-label", "2 active comments");

  // Arrow keys move through the views and select them; Home returns.
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(list).toHaveAttribute("aria-label", "Resolved comments");
  await expect(bodies).toHaveText(["Resolved one"]);
  await page.keyboard.press("End");
  await expect(list).toHaveAttribute("aria-label", "History comments");
  await expect(bodies).toHaveText(["Archived one"]);
  await page.keyboard.press("Home");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

  // Resolving from the card moves it to Resolved; reopening it there returns it to Active, on the server too.
  await card(page, "Active two").getByTestId("commentor-resolve-btn").click();
  await expect(tabs).toHaveText(["Active1", "Resolved2", "History1"]);
  await expect(bodies).toHaveText(["Active one"]);
  await expect.poll(async () => (await threadsAs(token, scope)).find(thread => thread._id === second)?.resolved).toBe(true);
  await tabs.nth(1).click();
  await expect(bodies).toHaveText(["Active two", "Resolved one"]);
  await card(page, "Active two").getByTestId("commentor-resolve-btn").click();
  await expect(tabs).toHaveText(["Active2", "Resolved1", "History1"]);
  await expect(bodies).toHaveText(["Resolved one"]);
  await expect.poll(async () => (await threadsAs(token, scope)).find(thread => thread._id === second)?.resolved).toBe(false);

  // Archiving from the card moves it from Active to History; restoring it from the server brings it back live.
  await tabs.first().click();
  await card(page, "Active two").getByTestId("commentor-archive-btn").click();
  await expect(tabs).toHaveText(["Active1", "Resolved1", "History2"]);
  await expect(bodies).toHaveText(["Active one"]);
  await expect.poll(async () => (await threadsAs(token, scope)).find(thread => thread._id === second)?.archived).toBe(true);
  expect((await writeThread(token, scope, "archive", second, { archived: false })).ok).toBe(true);
  await expect(tabs).toHaveText(["Active2", "Resolved1", "History1"]);

  // Reopening and restoring from the server move threads between the views without a reload; an empty view says so.
  expect((await writeThread(token, scope, "resolve", resolved, { resolved: false })).ok).toBe(true);
  await expect(tabs).toHaveText(["Active3", "Resolved0", "History1"]);
  expect((await writeThread(token, scope, "archive", archived, { archived: false })).ok).toBe(true);
  await expect(tabs).toHaveText(["Active4", "Resolved0", "History0"]);
  await expect(me.getByTestId("commentor-pin")).toHaveCount(4);
  await tabs.nth(1).click();
  await expect(me.locator(".empty strong")).toHaveText("No resolved comments");
  await tabs.nth(2).click();
  await expect(me.locator(".empty strong")).toHaveText("No archived comments");
});

test("older threads and replies load on demand, and a comment arriving while scrolled away is offered, not forced", async ({ actor }) => {
  test.setTimeout(240_000);
  const { comments } = repos();
  const doc = await journeyDoc("paging");
  const scope = { repoId: repoIds.comments, path: doc.path };
  const author = await actor("paging");
  const helper = await actor("replier");
  await open(author.page, comments, doc.path, doc.commit);
  const token = await sessionToken(author.page);
  const helperToken = await sessionToken(helper.page);
  const anchor = await anchorOn(author.page, "quick brown");
  // One more than a page of threads (twenty), and the newest has one more reply than its ten-reply preview.
  const ids: string[] = [];
  for (let index = 0; index < 21; index += 1) ids.push(await createThread(token, scope, `Thread ${String(index).padStart(2, "0")}`, anchor));
  for (let index = 0; index < 11; index += 1) await addReply(helperToken, scope, ids[20], `Reply ${String(index).padStart(2, "0")}`);
  // Opened again, the page's first comments come as one page, with older ones on request.
  await open(author.page, comments, doc.path, doc.commit);
  const me = ui(author.page);
  await openDrawer(author.page);
  const cards = me.locator(".drawer-thread");
  await expect(cards).toHaveCount(20);
  const olderThreads = me.getByTestId("commentor-load-older-threads");
  await expect(olderThreads).toHaveText("Load older comments");
  // Loading older comments adds them above without moving the card the reader is looking at.
  const list = me.getByTestId("commentor-drawer-list");
  // Every live update rebuilds the list, so the card is looked up by its thread id at read time inside one evaluation:
  // a card element held from an earlier moment can already be detached from the list when the measurement runs.
  const placeOf = (threadId: string) =>
    list.evaluate((element, id) =>
      element.querySelector<HTMLElement>(`.drawer-thread[data-thread-id="${id}"]`)!.getBoundingClientRect().top - element.getBoundingClientRect().top, threadId);
  await list.evaluate(element => { element.scrollTop = 60; });
  const place = await placeOf(ids[1]);
  await olderThreads.evaluate(button => (button as HTMLButtonElement).click());
  await expect(cards).toHaveCount(21);
  // Browsers snap a scroll position to whole pixels, so allow the one pixel of rounding.
  expect(Math.abs(await placeOf(ids[1]) - place)).toBeLessThanOrEqual(1);
  await expect(olderThreads).toHaveCount(0);

  // The newest thread previews its latest ten replies and offers the oldest on demand.
  const newest = me.locator(`.drawer-thread[data-thread-id="${ids[20]}"]`);
  await expect(newest.locator(".reply")).toHaveCount(10);
  const olderReplies = newest.getByTestId("commentor-load-older-replies");
  await expect(olderReplies).toHaveText("Load older replies");
  await olderReplies.click();
  await expect(newest.locator(".reply")).toHaveCount(11);
  await expect(newest.locator(".reply").first()).toContainText("Reply 00");
  await expect(newest.locator(".reply .when")).toHaveCount(11);
  await expect(newest.locator(".reply .when").first()).toHaveText(/^\d+[smhd]$/);
  await expect(olderReplies).toHaveCount(0);

  // Scrolled away from the end, another reader's new comment is announced and revealed on request.
  await list.evaluate(element => { element.scrollTop = 0; });
  await createThread(helperToken, scope, "Late arrival", await anchorOn(author.page, "second paragraph"));
  const banner = me.locator(".new-comments");
  await expect(banner).toHaveText("1 new comment");
  await expect(banner).toHaveAttribute("aria-live", "polite");
  expect(await list.evaluate(element => element.scrollTop)).toBe(0);
  await banner.click();
  await expect(banner).toBeHidden();
  await expect.poll(() => list.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 48)).toBe(true);
  await expect(card(author.page, "Late arrival")).toBeVisible();
});

test("an author edits their thread and reply in place, another reader's page follows, and nobody else may edit them", async ({ actor, secondContext }) => {
  test.setTimeout(180_000);
  const { comments } = repos();
  const doc = await journeyDoc("edit");
  const scope = { repoId: repoIds.comments, path: doc.path };
  const author = await actor("editor");
  const other = await actor("bystander");
  await open(author.page, comments, doc.path, doc.commit);
  const token = await sessionToken(author.page);
  const otherToken = await sessionToken(other.page);
  const threadId = await createThread(token, scope, "Frist take", await anchorOn(author.page, "quick brown"));
  const theirReply = await addReply(otherToken, scope, threadId, "Their reply");
  await open(other.page, comments, doc.path, doc.commit);
  const anonymous = await secondContext.newPage();
  await open(anonymous, comments, doc.path, doc.commit);
  // A reply posted after both readers opened reaches them only through their live subscriptions (the first comments
  // came with the page): once they show it, every later change does too.
  const myReply = await addReply(token, scope, threadId, "My reply");
  for (const reader of [other.page, anonymous]) {
    await openDrawer(reader);
    await expect(card(reader, "Their reply").locator(".reply", { hasText: "My reply" })).toBeVisible({ timeout: 30_000 });
  }
  type Edited = { _id: string; body: string; editedAt?: number; canEdit?: boolean; replies: Array<{ _id: string; body: string; editedAt?: number; canEdit?: boolean }> };
  const server = async () => (await threadsAs(token, scope))[0] as unknown as Edited;
  const me = ui(author.page);
  await openDrawer(author.page);
  const mine = card(author.page, "Their reply");
  await expect(mine.getByTestId("commentor-edit-btn")).toHaveCount(1);
  await expect(mine.getByTestId("commentor-edit-reply-btn")).toHaveCount(1);

  // Edit opens the text in place with focus in it; Escape leaves it as it was, with focus back on Edit.
  await mine.getByTestId("commentor-edit-btn").click();
  const input = mine.getByTestId("commentor-edit-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Frist take");
  await input.fill("Not this");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(mine.getByTestId("commentor-edit-btn")).toBeFocused();
  await expect(mine.locator(".thread-view > .body")).toHaveText("Frist take");

  // Saved with Enter: shown at once, then marked edited once the server has it, for the author and for other readers live.
  await mine.getByTestId("commentor-edit-btn").click();
  await input.fill("First take");
  await input.press("Enter");
  await expect(mine.locator(".thread-view > .body")).toHaveText("First take");
  await expect(mine.locator(".thread-view > .head").getByTestId("commentor-edited")).toHaveAttribute("aria-label", /^Edited /);
  await expect(mine.getByTestId("commentor-saving")).toHaveCount(0);
  await expect(mine.getByTestId("commentor-edit-btn")).toBeFocused();
  await expect(me.getByTestId("commentor-live")).toHaveText("Edit saved.");
  expect(await server()).toMatchObject({ body: "First take", editedAt: expect.any(Number), canEdit: true });
  for (const reader of [other.page, anonymous]) {
    await expect(card(reader, "Their reply").locator(".thread-view > .body")).toHaveText("First take");
    await expect(card(reader, "Their reply").locator(".thread-view > .head").getByTestId("commentor-edited")).toBeVisible();
  }

  // The author's reply, with Ctrl+Enter.
  const replyEdit = mine.getByTestId("commentor-edit-reply-btn");
  await replyEdit.click();
  await expect(input).toHaveValue("My reply");
  await input.fill("My reply, corrected");
  await input.press("Control+Enter");
  await expect(mine.locator(".reply", { hasText: "My reply, corrected" }).getByTestId("commentor-edited")).toBeVisible();
  await expect(replyEdit).toBeFocused();
  await expect.poll(async () => (await server()).replies.find(reply => reply._id === myReply)?.body).toBe("My reply, corrected");
  await expect(card(other.page, "Their reply").locator(".reply", { hasText: "My reply, corrected" }).getByTestId("commentor-edited")).toBeVisible();

  // Another signed-in reader may edit only their own reply; an anonymous reader nothing.
  const theirs = card(other.page, "Their reply");
  await expect(theirs.getByTestId("commentor-edit-btn")).toHaveCount(0);
  await expect(theirs.getByTestId("commentor-edit-reply-btn")).toHaveCount(1);
  await expect(theirs.locator(".reply", { hasText: "Their reply" }).getByTestId("commentor-edit-reply-btn")).toHaveCount(1);
  await expect(card(anonymous, "Their reply").locator('[data-testid="commentor-edit-btn"], [data-testid="commentor-edit-reply-btn"]')).toHaveCount(0);

  // The same edits forged against Convex are refused as the other writes are; nothing changes.
  const forged = [
    ["thread by another reader", await convexCallWith(otherToken, "mutation", "repoComments:editThread", { ...scope, threadId, body: "Hijacked" }), "forbidden"],
    ["reply by another reader", await convexCallWith(otherToken, "mutation", "repoComments:editReply", { ...scope, threadId, replyId: myReply, body: "Hijacked" }), "forbidden"],
    ["their reply by the author", await convexCallWith(token, "mutation", "repoComments:editReply", { ...scope, threadId, replyId: theirReply, body: "Hijacked" }), "forbidden"],
    ["thread anonymously", await convexCallWith(undefined, "mutation", "repoComments:editThread", { ...scope, threadId, body: "Hijacked" }), "unauthenticated"],
    ["another page's thread", await convexCallWith(token, "mutation", "repoComments:editThread", { ...scope, path: "docs/guide.md", threadId, body: "Hijacked" }), "not_found"],
  ] as const;
  for (const [label, result, code] of forged) expect(result, label).toMatchObject({ ok: false, code });
  const after = await server();
  expect([after.body, ...after.replies.map(reply => reply.body)]).toEqual(["First take", "Their reply", "My reply, corrected"]);
  expect(after.replies.find(reply => reply._id === theirReply)?.editedAt).toBeUndefined();
});
