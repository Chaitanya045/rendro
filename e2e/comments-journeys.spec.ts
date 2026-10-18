import { test, expect, join } from "./org-fixtures";
import { addReply, commentSite, createThread, heading, intro, openDocument, pauseClock, startSelectionComment, threadsOf, widget, writeThread } from "./comment-helpers";

/**
 * Comment journeys on the real Worker, local Convex and the sandboxed publisher frame (#115). Every person is an
 * independent browser context. Final state is asserted in the widget (DOM, ARIA, focus, announced toasts), on the
 * server (re-read with the person's own session) and in a second person's open document.
 */
const toast = (page: Parameters<typeof widget>[0], role: "status" | "alert") => widget(page).locator(`.toast[role="${role}"]`);
const count = (page: Parameters<typeof widget>[0]) => widget(page).locator(".content-head .count");
const focusedTestId = (page: Parameters<typeof widget>[0]) =>
  page.frames().find(frame => frame !== page.mainFrame())!.evaluate(() => document.getElementById("commentor-host")!.shadowRoot!.activeElement?.getAttribute("data-testid") ?? null);

test.describe("authoring", () => {
  test("a text selection and a clicked element become comments that a teammate sees arrive", async ({ actor }) => {
    test.setTimeout(180_000);
    const site = await commentSite(actor, "author");
    const author = site.owner;
    const reader = await actor("reader");
    await join(author, site.organizationId, reader, "member");
    await openDocument(reader.page, site);
    await openDocument(author.page, site);
    const me = widget(author.page), they = widget(reader.page);
    await expect(me.getByTestId("commentor-selection-action")).toHaveAttribute("data-state", "closed");

    // Select a word with the pointer: the chip offers to comment on exactly that text.
    const chip = me.getByTestId("commentor-selection-action");
    const quote = await startSelectionComment(author.page);
    expect(quote).not.toBe("");
    await expect(chip).toHaveAttribute("aria-label", "Comment on selected text");
    const composer = me.getByTestId("commentor-composer");
    await expect(composer).toHaveAttribute("role", "dialog");
    await expect(composer.locator(".anchor-label")).toHaveText(`On: “${quote}”`);
    const textarea = me.getByTestId("commentor-composer-textarea");

    // Empty and whitespace-only text is ignored and Shift+Enter is a newline; plain Enter posts.
    await author.page.keyboard.press("Enter");
    await expect(composer).toBeVisible();
    await textarea.fill("   ");
    await author.page.keyboard.press("Enter");
    await expect(composer).toBeVisible();
    await expect(textarea).toBeFocused();
    expect(await threadsOf(author.page, site)).toHaveLength(0);
    await textarea.fill("Needs a citation");
    await author.page.keyboard.press("Shift+Enter");
    await author.page.keyboard.type("and a date");
    await expect(textarea).toHaveValue("Needs a citation\nand a date");
    await author.page.keyboard.press("Enter");
    await expect(composer).toHaveCount(0);
    await expect.poll(() => focusedTestId(author.page)).toBe("commentor-comment-btn");
    const pin = me.getByTestId("commentor-pin");
    await expect(pin).toHaveCount(1);
    await expect(pin).toHaveAttribute("aria-label", `Thread 1 by ${author.name}`);
    await expect(count(author.page)).toHaveAttribute("aria-label", "1 active comment");

    // The server holds one thread anchored to the selected text, and the teammate's open document received it.
    const [first] = await threadsOf(author.page, site);
    expect(first).toMatchObject({ body: "Needs a citation\nand a date", resolved: false, archived: false, anchor: { kind: "text-range", quote } });
    await expect(they.getByTestId("commentor-pin")).toHaveCount(1);
    await expect(count(reader.page)).toHaveAttribute("aria-label", "1 active comment");

    // Comment mode: Escape cancels, a click on empty space explains, a click on an element opens the composer for it.
    const comment = me.getByTestId("commentor-comment-btn");
    await comment.click();
    await expect(comment).toHaveAttribute("aria-pressed", "true");
    await expect(me.getByTestId("commentor-comment-hint")).toHaveText("Click an element (or select text first) — Esc to cancel");
    await author.page.keyboard.press("Escape");
    await expect(comment).toHaveAttribute("aria-pressed", "false");
    await expect(me.getByTestId("commentor-comment-hint")).toHaveCount(0);
    await comment.click();
    await me.locator("#second").click();
    await expect(composer.locator(".anchor-label")).toHaveText("On: “Second paragraph for element comments.”");
    await textarea.fill("Pin this paragraph");
    await me.getByTestId("commentor-composer-post").click();
    await expect(composer).toHaveCount(0);
    await expect(pin).toHaveCount(2);
    await expect(pin.nth(1)).toHaveAttribute("aria-label", `Thread 2 by ${author.name}`);
    const threads = await threadsOf(author.page, site);
    expect(threads.map(thread => thread.body).sort()).toEqual(["Needs a citation\nand a date", "Pin this paragraph"]);
    expect(threads.find(thread => thread.body === "Pin this paragraph")?.anchor).toMatchObject({ kind: "element" });
    await expect(they.getByTestId("commentor-pin")).toHaveCount(2);

    // Closing a composer without posting returns focus to the control that opened it and stores nothing.
    await comment.click();
    await me.locator("#title").click();
    await expect(textarea).toBeFocused();
    await author.page.keyboard.press("Escape");
    await expect(composer).toHaveCount(0);
    // With no selection to return to, focus lands on the dock's Comments control.
    await expect.poll(() => focusedTestId(author.page)).toBe("commentor-panel-btn");
    expect(await threadsOf(author.page, site)).toHaveLength(2);
  });

  test("replies, resolving and reopening reach a teammate's open document and the server", async ({ actor }) => {
    test.setTimeout(180_000);
    const site = await commentSite(actor, "triage");
    const author = site.owner;
    const reader = await actor("triager");
    await join(author, site.organizationId, reader, "member");
    const threadId = await createThread(author.page, site, "Please clarify this heading", heading);
    await openDocument(author.page, site);
    await openDocument(reader.page, site);
    const me = widget(author.page), they = widget(reader.page);
    await expect(they.getByTestId("commentor-pin")).toHaveCount(1);

    // The teammate opens the pin's bubble and replies with Enter; the author sees the reply arrive.
    await they.getByTestId("commentor-pin").click();
    const bubble = they.getByTestId("commentor-thread-bubble");
    await expect(bubble).toHaveAttribute("role", "dialog");
    await expect(bubble).toHaveAttribute("aria-label", `Thread by ${author.name}`);
    const input = bubble.getByTestId("commentor-reply-input");
    await input.click();
    await reader.page.keyboard.type("Line one");
    await reader.page.keyboard.press("Shift+Enter");
    await reader.page.keyboard.type("line two");
    await expect(input).toHaveValue("Line one\nline two");
    await reader.page.keyboard.press("Enter");
    await expect(bubble.locator(".reply")).toHaveCount(1);
    await expect(input).toHaveValue("");
    await expect(bubble.getByTestId("commentor-reply-send")).toHaveText("Reply");
    await expect.poll(() => focusedTestId(reader.page)).toBe("commentor-reply-input");
    await expect.poll(async () => (await threadsOf(author.page, site))[0].replies.map(reply => reply.body)).toEqual(["Line one\nline two"]);
    await me.getByTestId("commentor-panel-btn").click();
    await expect(me.locator(".drawer-thread .reply")).toHaveCount(1);
    await expect(me.locator(".drawer-thread .reply")).toContainText("Line one");

    // Anyone in the organization may triage: the teammate resolves it. It leaves Active for Resolved in both documents.
    const resolve = bubble.getByTestId("commentor-resolve-btn");
    await expect(resolve).toHaveAttribute("aria-label", `Resolve comment by ${author.name}`);
    await resolve.click();
    await expect(bubble.locator(".head .resolved")).toHaveText("Resolved");
    await expect(bubble.getByTestId("commentor-resolve-btn")).toHaveAttribute("aria-label", `Reopen comment by ${author.name}`);
    expect((await threadsOf(author.page, site))[0]).toMatchObject({ _id: threadId, resolved: true });
    await expect(count(author.page)).toHaveAttribute("aria-label", "0 active comments");
    await expect(me.getByRole("tab", { name: /Resolved/ }).locator(".filter-count")).toHaveText("1");
    await expect(me.getByRole("tab", { name: /Active/ }).locator(".filter-count")).toHaveText("0");
    await expect(me.locator(".drawer-thread")).toHaveCount(0);
    await expect(me.locator(".empty strong")).toHaveText("No active comments");
    await me.getByRole("tab", { name: /Resolved/ }).click();
    await expect(me.locator(".drawer-thread")).toHaveCount(1);

    // The author reopens it from the Resolved view: it returns to Active for both people and on the server.
    await me.getByTestId("commentor-resolve-btn").click();
    await expect(me.locator(".drawer-thread")).toHaveCount(0);
    await expect(me.locator(".empty strong")).toHaveText("No resolved comments");
    await expect(me.getByRole("tab", { name: /Active/ }).locator(".filter-count")).toHaveText("1");
    await expect(count(reader.page)).toHaveAttribute("aria-label", "1 active comment");
    expect((await threadsOf(reader.page, site))[0]).toMatchObject({ _id: threadId, resolved: false });

    // A reply removes only itself: the author deletes the teammate's reply (owner may delete anyone's), the thread stays.
    await me.getByRole("tab", { name: /Active/ }).click();
    await expect(me.locator(".drawer-thread .reply")).toHaveCount(1);
    await me.locator(".drawer-thread .reply").getByTestId("commentor-delete-reply-btn").click();
    await expect(me.locator(".drawer-thread .reply")).toHaveCount(0);
    await expect(me.locator(".drawer-thread")).toHaveCount(1);
    await expect(bubble.locator(".reply")).toHaveCount(0);
    expect((await threadsOf(author.page, site))[0].replies).toEqual([]);
    expect(await addReply(author.page, site, threadId, "Owner follow-up")).toBeTruthy();
    await expect(bubble.locator(".reply")).toHaveCount(1);
  });

  test("a deleted comment can be undone within its window and is then removed for good", async ({ actor }) => {
    test.setTimeout(180_000);
    const site = await commentSite(actor, "delete");
    const author = site.owner;
    const reader = await actor("observer");
    await join(author, site.organizationId, reader, "member");
    await createThread(author.page, site, "Gone soon", heading);
    const staysId = await createThread(author.page, site, "Stays", intro);
    // Only the test moves the clock: the five-second undo window and the toast's exit run on it.
    await author.page.clock.install();
    await openDocument(reader.page, site);
    await openDocument(author.page, site);
    await expect(widget(author.page).getByTestId("commentor-pin")).toHaveCount(2);
    await pauseClock(author.page);
    const me = widget(author.page), they = widget(reader.page);
    await expect(they.getByTestId("commentor-pin")).toHaveCount(2);

    // Delete hides the comment locally with an announced Undo; nothing is written, the teammate still sees it.
    await me.getByTestId("commentor-pin").first().click();
    await me.getByTestId("commentor-thread-bubble").getByTestId("commentor-delete-btn").click();
    await expect(me.getByTestId("commentor-pin")).toHaveCount(1);
    await author.page.clock.runFor(200);
    await expect(me.getByTestId("commentor-thread-bubble")).toHaveCount(0);
    const deleted = toast(author.page, "status");
    await expect(deleted).toContainText("Comment deleted.");
    expect(await threadsOf(author.page, site)).toHaveLength(2);
    await expect(they.getByTestId("commentor-pin")).toHaveCount(2);

    // Undo restores it, and the window passing afterwards removes nothing.
    await deleted.getByRole("button", { name: "Undo" }).click();
    await expect(me.getByTestId("commentor-pin")).toHaveCount(2);
    await expect(toast(author.page, "status").last()).toContainText("Deletion undone.");
    await author.page.clock.fastForward(6000);
    await author.page.clock.runFor(200);
    expect(await threadsOf(author.page, site)).toHaveLength(2);
    await expect(they.getByTestId("commentor-pin")).toHaveCount(2);

    // Deleting again and letting the window pass commits exactly once; the teammate's document drops it live.
    await me.getByTestId("commentor-pin").first().click();
    await me.getByTestId("commentor-thread-bubble").getByTestId("commentor-delete-btn").click();
    await author.page.clock.fastForward(5000);
    await expect.poll(async () => (await threadsOf(author.page, site)).map(thread => thread.body)).toEqual(["Stays"]);
    await expect(me.getByTestId("commentor-pin")).toHaveCount(1);
    await expect(they.getByTestId("commentor-pin")).toHaveCount(1);
    await expect(count(reader.page)).toHaveAttribute("aria-label", "1 active comment");
    expect((await threadsOf(reader.page, site))[0]._id).toBe(staysId);
    // A deleted thread is gone for a reader who arrives later, too.
    await reader.page.reload();
    await expect(widget(reader.page).getByTestId("commentor-pin")).toHaveCount(1);
  });
});

test.describe("drawer", () => {
  test("filters and the collapsible drawer follow the comments' status", async ({ actor }) => {
    test.setTimeout(180_000);
    const site = await commentSite(actor, "drawer");
    const { page } = site.owner;
    await createThread(page, site, "Active one", heading);
    const second = await createThread(page, site, "Active two", intro);
    const resolved = await createThread(page, site, "Resolved one", heading);
    const archived = await createThread(page, site, "Archived one", heading);
    expect((await writeThread(page, site, "resolve", resolved, { resolved: true })).ok).toBe(true);
    expect((await writeThread(page, site, "archive", archived, { archived: true })).ok).toBe(true);
    await openDocument(page, site);
    const ui = widget(page);
    const panel = ui.getByTestId("commentor-panel-btn");
    const drawer = ui.getByTestId("commentor-drawer");
    const tabs = ui.getByRole("tab");

    // Collapsed: the drawer is hidden from assistive technology and inert; the toolbar button says so.
    await expect(panel).toHaveAttribute("aria-expanded", "false");
    await expect(drawer).toHaveAttribute("aria-hidden", "true");
    await expect(drawer).toHaveJSProperty("inert", true);
    await expect(ui.getByTestId("commentor-pin")).toHaveCount(2);
    await panel.click();
    await expect(panel).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).toHaveAttribute("aria-hidden", "false");
    await expect(drawer).toHaveJSProperty("inert", false);

    // Views carry live counts; Active is the default and shows only active, unarchived threads.
    await expect(tabs).toHaveText(["Active2", "Resolved1", "History1"]);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect(ui.getByTestId("commentor-drawer-list")).toHaveAttribute("aria-label", "Active comments");
    await expect(ui.locator(".drawer-thread .body")).toHaveText(["Active one", "Active two"]);
    await expect(ui.locator(".content-head .count")).toHaveAttribute("aria-label", "2 active comments");

    // Arrow keys move through the views and select them; Home returns.
    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1)).toBeFocused();
    await expect(ui.getByTestId("commentor-drawer-list")).toHaveAttribute("aria-label", "Resolved comments");
    await expect(ui.locator(".drawer-thread .body")).toHaveText(["Resolved one"]);
    await page.keyboard.press("End");
    await expect(ui.getByTestId("commentor-drawer-list")).toHaveAttribute("aria-label", "History comments");
    await expect(ui.locator(".drawer-thread .body")).toHaveText(["Archived one"]);
    await page.keyboard.press("Home");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

    // Archiving from the card moves it from Active to History; restoring it from the server brings it back live.
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await ui.locator(".drawer-thread", { hasText: "Active two" }).getByTestId("commentor-archive-btn").click();
    await expect(tabs).toHaveText(["Active1", "Resolved1", "History2"]);
    await expect(ui.locator(".drawer-thread .body")).toHaveText(["Active one"]);
    expect((await threadsOf(page, site)).find(thread => thread._id === second)).toMatchObject({ archived: true });
    expect((await writeThread(page, site, "archive", second, { archived: false })).ok).toBe(true);
    await expect(tabs).toHaveText(["Active2", "Resolved1", "History1"]);

    // Reopening the resolved thread from the server moves it between the views without a reload.
    expect((await writeThread(page, site, "resolve", resolved, { resolved: false })).ok).toBe(true);
    await expect(tabs).toHaveText(["Active3", "Resolved0", "History1"]);
    expect((await writeThread(page, site, "archive", archived, { archived: false })).ok).toBe(true);
    await expect(tabs).toHaveText(["Active4", "Resolved0", "History0"]);
    await tabs.nth(2).click();
    await expect(ui.locator(".empty strong")).toHaveText("No archived comments");

    // Collapsing hides the drawer again and keeps focus on the control.
    await panel.click();
    await expect(panel).toHaveAttribute("aria-expanded", "false");
    await expect(drawer).toHaveAttribute("aria-hidden", "true");
    await expect(drawer).toHaveJSProperty("inert", true);
    await expect(panel).toBeFocused();

    // Expanded again, the drawer opens beside the dock and stays inside the viewport.
    const viewport = page.viewportSize()!;
    await panel.click();
    await expect(panel).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).toHaveAttribute("aria-hidden", "false");
    await expect.poll(async () => {
      const box = (await drawer.boundingBox())!;
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
    }).toBe(true);
  });

  test("older threads and replies load on demand, and a remote arrival while scrolled away offers the new comment", async ({ actor }) => {
    test.setTimeout(240_000);
    const site = await commentSite(actor, "paging");
    const author = site.owner;
    const helper = await actor("replier");
    await join(author, site.organizationId, helper, "member");
    // One more than a page of threads, written by the owner; the most-replied thread has more than the ten-reply preview.
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) ids.push(await createThread(author.page, site, `Thread ${String(index).padStart(2, "0")}`, heading));
    for (let index = 0; index < 11; index += 1) await addReply(helper.page, site, ids[20], `Reply ${String(index).padStart(2, "0")}`);
    await openDocument(author.page, site);
    const ui = widget(author.page);
    await ui.getByTestId("commentor-panel-btn").click();
    const cards = ui.locator(".drawer-thread");
    await expect(cards).toHaveCount(20);
    const olderThreads = ui.getByTestId("commentor-load-older-threads");
    await expect(olderThreads).toHaveText("Load older comments");
    // Loading older comments adds them above without moving the card the reader is looking at.
    const list = ui.getByTestId("commentor-drawer-list");
    const first = ui.locator(`.drawer-thread[data-thread-id="${ids[1]}"]`);
    await list.evaluate(element => { element.scrollTop = 60; });
    const place = await first.evaluate(card => card.getBoundingClientRect().top - card.parentElement!.getBoundingClientRect().top);
    await olderThreads.evaluate(button => (button as HTMLButtonElement).click());
    await expect(cards).toHaveCount(21);
    // Browsers snap a scroll position to whole pixels, so allow the one pixel of rounding.
    const after = await first.evaluate(card => card.getBoundingClientRect().top - card.parentElement!.getBoundingClientRect().top);
    expect(Math.abs(after - place)).toBeLessThanOrEqual(1);
    await expect(olderThreads).toHaveCount(0);

    // The newest thread previews its latest ten replies and offers the oldest on demand.
    const newest = ui.locator(`.drawer-thread[data-thread-id="${ids[20]}"]`);
    await expect(newest.locator(".reply")).toHaveCount(10);
    const olderReplies = newest.getByTestId("commentor-load-older-replies");
    await expect(olderReplies).toHaveText("Load older replies");
    await olderReplies.click();
    await expect(newest.locator(".reply")).toHaveCount(11);
    await expect(newest.locator(".reply").first()).toContainText("Reply 00");
    // Each reply shows how long ago it was written, like the thread above it.
    await expect(newest.locator(".reply .when")).toHaveCount(11);
    await expect(newest.locator(".reply .when").first()).toHaveText(/^\d+[smhd]$/);
    await expect(newest.locator(".reply").first()).toHaveText(/^.+ \d+[smhd] Reply 00$/);
    await expect(olderReplies).toHaveCount(0);

    // Scrolled away from the end, a teammate's new comment is announced and revealed on request, not forced.
    await list.evaluate(element => { element.scrollTop = 0; });
    await createThread(helper.page, site, "Late arrival", intro);
    const banner = ui.locator(".new-comments");
    await expect(banner).toHaveText("1 new comment");
    await expect(banner).toHaveAttribute("aria-live", "polite");
    expect(await list.evaluate(element => element.scrollTop)).toBe(0);
    await banner.click();
    await expect(banner).toBeHidden();
    await expect.poll(() => list.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 48)).toBe(true);
  });
});
