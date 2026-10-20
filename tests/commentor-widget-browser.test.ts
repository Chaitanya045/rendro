import { beforeAll, describe, expect, it } from "vitest";
import { anchorOn, useCommentLab, type Lab } from "./helpers/comment-lab";

const commentLab = useCommentLab();
beforeAll(() => commentLab.start());

const heading = anchorOn("Quarterly report");
const intro = anchorOn("lazy dog and keeps running");

async function openBubble(lab: Lab, index = 0) {
  await lab.pins().nth(index).click();
  await lab.tid("commentor-thread-bubble").waitFor();
  return lab.tid("commentor-thread-bubble");
}
const lastCall = async (lab: Lab) => (await lab.calls).at(-1)!;
const toastText = (lab: Lab) => lab.ui.locator('.toast[role="alert"]');

describe("pins and anchors", () => {
  it("places numbered pins at their anchors and opens, toggles and closes the thread bubble", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", body: "First", anchor: heading }, { _id: "t2", body: "Second", anchor: intro, resolved: true }, { _id: "t3", body: "Third", anchor: intro }]);
    await expect.poll(() => lab.pins().count()).toBe(2);
    expect(await lab.pins().nth(1).getAttribute("aria-label")).toBe("Thread 2 by Ada");
    // A pin sits at the start of its quote: here the heading's text.
    const title = await lab.doc(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector("h1")!); const rect = range.getClientRects()[0]; return { left: rect.left, top: rect.top }; });
    const position = await lab.pins().first().evaluate(pin => ({ left: parseFloat((pin as HTMLElement).style.left), top: parseFloat((pin as HTMLElement).style.top) }));
    expect(position).toEqual({ left: title.left - 10, top: title.top - 26 });
    const bubble = await openBubble(lab);
    expect(await bubble.getAttribute("role")).toBe("dialog");
    expect(await bubble.getAttribute("aria-label")).toBe("Thread by Ada");
    expect(await bubble.innerText()).toContain("First");
    expect(await lab.pins().first().getAttribute("aria-pressed")).toBe("true");
    // The open bubble covers the neighbouring pin, so deliver the click directly.
    await lab.pins().nth(1).dispatchEvent("click");
    expect(await lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("t3");
    expect(await lab.pins().first().getAttribute("aria-pressed")).toBe("false");
    await lab.pins().nth(1).dispatchEvent("click");
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(0);
    // Clicking the page closes an open bubble too; Escape returns focus to the pin.
    await lab.pins().first().click();
    await lab.doc(() => document.getElementById("second")!.click());
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(0);
    await lab.pins().first().click();
    await lab.page.keyboard.press("Escape");
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(0);
    expect(await lab.focused()).toBe("commentor-pin");
  });

  it("anchors by quote across element boundaries, and hides pins whose anchor is gone or off screen", async () => {
    const lab = await commentLab.open();
    await lab.ready([
      { _id: "wrapped", anchor: anchorOn("Second bold paragraph") },
      { _id: "separate", anchor: anchorOn("AlphaBeta") },
      { _id: "exact", anchor: anchorOn("Footer text") },
      { _id: "blank", anchor: anchorOn("   ") },
      { _id: "absent", anchor: anchorOn("not in the document") },
      { _id: "gone", anchor: anchorOn("Quarterly report", "gone") },
    ]);
    const shown = () => lab.pins().evaluateAll(pins => pins.map(pin => [pin.getAttribute("data-thread-id"), (pin as HTMLElement).style.display]));
    await expect.poll(shown).toEqual([["wrapped", ""], ["separate", ""], ["exact", "none"], ["blank", "none"], ["absent", "none"], ["gone", "none"]]);
    await lab.doc(() => document.getElementById("footer")!.scrollIntoView({ block: "center" }));
    await expect.poll(shown).toEqual([["wrapped", "none"], ["separate", "none"], ["exact", ""], ["blank", "none"], ["absent", "none"], ["gone", "none"]]);
    await lab.openDrawer();
    const cards = lab.ui.locator(".drawer-thread");
    expect(await cards.evaluateAll(all => all.map(card => card.classList.contains("is-orphan")))).toEqual([false, false, false, true, true, true]);
    expect(await cards.nth(5).innerText()).toContain("Anchor no longer found");
    // Without a quote to show, an orphan offers only a locate link.
    await cards.nth(3).locator(".locate-link").click();
    await expect.poll(() => toastText(lab).innerText()).toBe("This comment’s anchor is no longer available.");
    await cards.nth(4).locator(".quote").click();
    await expect.poll(() => toastText(lab).count()).toBe(2);
  });

  it("highlights each wrapped line of a hovered thread's anchor and clears it on leave", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "wrap", anchor: anchorOn("quick brown fox jumps over the lazy dog and keeps running across the open field") }, { _id: "head", anchor: heading }]);
    const highlight = lab.ui.locator(".anchor-highlight");
    await lab.pins().first().hover();
    await expect.poll(() => highlight.getAttribute("data-visible")).toBe("");
    expect(await highlight.locator(".anchor-highlight-segment").count()).toBeGreaterThan(1);
    expect(await lab.ui.locator('[data-thread-id="wrap"].is-highlighted').count()).toBeGreaterThan(0);
    await lab.page.mouse.move(900, 700);
    await expect.poll(() => highlight.getAttribute("data-visible")).toBeNull();
    await lab.pins().nth(1).focus();
    await expect.poll(() => highlight.locator(".anchor-highlight-segment").count()).toBe(1);
    await lab.pins().nth(1).blur();
    await expect.poll(() => highlight.getAttribute("data-visible")).toBeNull();
  });

  it("follows the page on scroll and resize", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "footer", anchor: anchorOn("Footer text far below") }]);
    await lab.doc(() => document.getElementById("footer")!.scrollIntoView({ block: "center" }));
    await expect.poll(() => lab.pins().first().evaluate(pin => (pin as HTMLElement).style.display)).toBe("");
    const bubble = await openBubble(lab);
    await lab.doc(() => window.scrollBy(0, 40));
    const footerTop = () => lab.doc(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById("footer")!); return range.getClientRects()[0].top; });
    await expect.poll(async () => await lab.pins().first().evaluate(pin => parseFloat((pin as HTMLElement).style.top))).toBe(await footerTop() - 26);
    expect(await bubble.isVisible()).toBe(true);
    await lab.page.setViewportSize({ width: 600, height: 700 });
    await expect.poll(() => bubble.evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(600);
  });
});

describe("authoring", () => {
  it("posts a comment on selected text, focuses the toolbar again and shows the new pin", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    const action = lab.tid("commentor-selection-action");
    expect(await action.getAttribute("data-state")).toBe("closed");
    await lab.select("#intro", 4, 15);
    await expect.poll(() => action.getAttribute("data-state")).toBe("open");
    expect(await action.getAttribute("aria-label")).toBe("Comment on selected text");
    await action.click();
    const composer = lab.tid("commentor-composer");
    expect(await composer.getAttribute("role")).toBe("dialog");
    expect(await composer.locator(".anchor-label").innerText()).toBe("On: “quick brown”");
    await expect.poll(() => lab.tid("commentor-composer-textarea").evaluate(el => el === (el.getRootNode() as ShadowRoot).activeElement)).toBe(true);
    await lab.tid("commentor-composer-textarea").fill("Needs a citation");
    // Shift+Enter is a newline; an empty comment is ignored before anything is sent.
    await lab.page.keyboard.press("Shift+Enter");
    expect((await lab.calls).length).toBe(0);
    await lab.tid("commentor-composer-textarea").fill("   ");
    await lab.page.keyboard.press("Enter");
    expect((await lab.calls).length).toBe(0);
    await lab.tid("commentor-composer-textarea").fill("Needs a citation");
    await lab.page.keyboard.press("Enter");
    await expect.poll(() => lab.tid("commentor-composer").count()).toBe(0);
    expect(await lastCall(lab)).toMatchObject({ method: "thread.create", args: { body: "Needs a citation", anchor: { kind: "repo-text", headingSlug: "title", exact: "quick brown" } } });
    await expect.poll(() => lab.pins().count()).toBe(1);
    expect(await lab.pins().first().getAttribute("aria-label")).toBe("Thread 1 by Me");
    await expect.poll(() => lab.focused()).toBe("commentor-comment-btn");
  });

  it("comments on a clicked element's text, and clicking empty space or pressing Escape cancels", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    const button = lab.tid("commentor-comment-btn");
    await button.click();
    expect(await button.getAttribute("aria-pressed")).toBe("true");
    expect(await lab.tid("commentor-comment-hint").innerText()).toBe("Click an element (or select text first) — Esc to cancel");
    await lab.page.keyboard.press("Escape");
    expect(await button.getAttribute("aria-pressed")).toBe("false");
    expect(await lab.tid("commentor-comment-hint").count()).toBe(0);
    await button.click();
    await lab.page.mouse.click(900, 300);
    await expect.poll(() => lab.ui.locator('.toast[role="status"]').innerText()).toBe("Click an element or select text to comment.");
    expect(await button.getAttribute("aria-pressed")).toBe("false");
    await button.click();
    await lab.doc(() => document.getElementById("second")!.click());
    const composer = lab.tid("commentor-composer");
    expect(await composer.locator(".anchor-label").innerText()).toBe("On: “Second bold paragraph with spaced text.”");
    await lab.tid("commentor-composer-textarea").fill("Element comment");
    await lab.tid("commentor-composer-post").click();
    // Saved, not just shown as sending (#284): only then has the write reached the backend.
    await expect.poll(() => lab.ui.locator('[data-testid="commentor-pin"]:not(.is-sending)').count()).toBe(1);
    expect(await lastCall(lab)).toMatchObject({ method: "thread.create", args: { anchor: { kind: "repo-text", headingSlug: "title", exact: "Second bold paragraph   with   spaced text." } } });
    // An element without text has nothing to quote: the reader is asked to select text instead.
    await button.click();
    await lab.doc(() => (document.querySelector("main > div") as HTMLElement).click());
    await expect.poll(() => lab.ui.locator('.toast[role="status"]').last().innerText()).toBe("Select some text to comment on.");
    // No composer opens (the posted one may still be finishing its closing transition).
    expect(await lab.ui.locator('[data-testid="commentor-composer"][data-state="open"]').count()).toBe(0);
    await button.click();
    await lab.doc(() => document.getElementById("publisher-button")!.click());
    await lab.tid("commentor-composer-cancel").click();
    await expect.poll(() => composer.count()).toBe(0);
    // Without a selection invoker, focus returns to the dock's Comments control.
    await expect.poll(() => lab.focused()).toBe("commentor-panel-btn");
    // Escape closes an open composer as well.
    await button.click();
    await lab.doc(() => document.getElementById("second")!.click());
    await lab.tid("commentor-composer-textarea").waitFor();
    await lab.page.keyboard.press("Escape");
    await expect.poll(() => composer.count()).toBe(0);
  });

  it("shows the reader's own thread at once as sending, and the live echo replaces it without a duplicate (#284)", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("second")!.click());
    await lab.tid("commentor-composer-textarea").fill("Optimistic comment");
    await lab.host(l => { l.holds = ["thread.create"]; });
    await lab.tid("commentor-composer-post").click();
    // Within a frame of the click, before the request reaches the backend: the composer is gone, the thread is here.
    const sending = lab.ui.locator(".drawer-thread.is-sending");
    await expect.poll(() => sending.count()).toBe(1);
    await expect.poll(() => lab.tid("commentor-composer").count()).toBe(0);
    expect(await sending.getAttribute("aria-busy")).toBe("true");
    expect(await sending.getByTestId("commentor-sending").innerText()).toBe("Sending…");
    expect(await sending.innerText()).toContain("Optimistic comment");
    // It has no ID yet: nothing to resolve, archive, delete or reply to.
    expect(await sending.locator('[data-testid="commentor-resolve-btn"], [data-testid="commentor-delete-btn"], [data-testid="commentor-reply-input"]').count()).toBe(0);
    expect(await lab.pins().count()).toBe(2);
    expect(await lab.pins().nth(1).getAttribute("aria-label")).toBe("Thread 2 by You, sending");
    expect(await lab.pins().nth(1).getAttribute("class")).toContain("is-sending");
    // The live page carries it (published before the acknowledgement, as Convex does): one thread, the real one.
    await lab.release();
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(2);
    expect(await sending.count()).toBe(0);
    expect(await lab.ui.locator(".drawer-thread", { hasText: "Optimistic comment" }).getAttribute("data-thread-id")).toMatch(/^thread-/);
    const create = (await lab.calls).filter(call => call.method === "thread.create");
    expect(create).toHaveLength(1);
    expect(create[0].args.clientOperationId).toEqual(expect.any(String));
  });

  it("rolls a failed post back, keeps the draft in the reopened composer and retries the same operation (#284)", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.openDrawer();
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill("Held comment");
    await lab.host(l => { l.holds = ["thread.create"]; });
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.ui.locator(".drawer-thread.is-sending").count()).toBe(1);
    await lab.release({ kind: "convex", code: "forbidden" });
    await expect.poll(() => toastText(lab).innerText()).toBe("You do not have permission to change this comment.");
    expect(await lab.ui.locator(".drawer-thread").count()).toBe(0);
    const post = lab.tid("commentor-composer-post");
    expect(await lab.tid("commentor-composer-textarea").inputValue()).toBe("Held comment");
    expect(await post.innerText()).toBe("Post");
    expect(await post.getAttribute("aria-busy")).toBeNull();
    await expect.poll(() => lab.focused()).toBe("commentor-composer-textarea");
    // An unknown failure keeps the operation: Post retries it under the same clientOperationId.
    await lab.host(l => { l.failures = { "thread.create": { kind: "plain" } }; });
    await post.click();
    await expect.poll(() => toastText(lab).last().innerText()).toBe("Could not post comment. Try again.");
    expect(await lab.tid("commentor-composer-textarea").inputValue()).toBe("Held comment");
    await lab.host(l => { l.failures = {}; });
    await post.click();
    await expect.poll(() => lab.pins().count()).toBe(1);
    await expect.poll(() => lab.tid("commentor-composer").count()).toBe(0);
    const ids = (await lab.calls).filter(call => call.method === "thread.create").map(call => call.args.clientOperationId);
    expect(ids).toHaveLength(3);
    expect(ids[2]).toBe(ids[1]);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("sends a double submit once and shows one optimistic thread (#284)", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.openDrawer();
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    const textarea = lab.tid("commentor-composer-textarea");
    await textarea.fill("Only once");
    await lab.host(l => { l.holds = ["thread.create"]; });
    // Enter twice and a click, in one task: the first submit locks the composer before the second runs.
    await textarea.evaluate(element => {
      const enter = () => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
      enter();
      enter();
      (element.getRootNode() as ShadowRoot).querySelector<HTMLButtonElement>('[data-testid="commentor-composer-post"]')?.click();
    });
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    expect(await lab.ui.locator(".drawer-thread.is-sending").count()).toBe(1);
    // A second composer waits for the first post's outcome.
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("second")!.click());
    await expect.poll(() => lab.ui.locator(".toast", { hasText: "Still waiting for confirmation of your comment." }).count()).toBe(1);
    await expect.poll(() => lab.tid("commentor-composer").count()).toBe(0);
    await lab.release();
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(1);
    expect((await lab.calls).filter(call => call.method === "thread.create")).toHaveLength(1);
  });

  it("shows the reader's own reply at once, rolls a failure back into the input, and dedupes the echo (#284)", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    const bubble = await openBubble(lab);
    const input = bubble.locator('[data-testid="commentor-reply-input"]');
    await input.fill("Optimistic reply");
    await lab.host(l => { l.holds = ["reply.add"]; });
    await bubble.locator('[data-testid="commentor-reply-send"]').click();
    const sending = bubble.locator(".reply.is-sending");
    await expect.poll(() => sending.count()).toBe(1);
    expect(await sending.getAttribute("aria-busy")).toBe("true");
    expect(await sending.innerText()).toContain("Optimistic reply");
    expect(await sending.getByTestId("commentor-sending").innerText()).toBe("Sending…");
    // The text moved into the list; the input stays locked until the outcome.
    expect(await bubble.locator('[data-testid="commentor-reply-input"]').inputValue()).toBe("");
    expect(await bubble.locator('[data-testid="commentor-reply-input"]').isDisabled()).toBe(true);
    await lab.release({ kind: "plain" });
    await expect.poll(() => toastText(lab).innerText()).toBe("Could not post reply.");
    expect(await bubble.locator(".reply").count()).toBe(0);
    await expect.poll(() => bubble.locator('[data-testid="commentor-reply-input"]').inputValue()).toBe("Optimistic reply");
    expect(await bubble.locator('[data-testid="commentor-reply-input"]').isDisabled()).toBe(false);
    // Retried: the echo replaces the optimistic reply, so it is there once.
    await lab.host(l => { l.holds = ["reply.add"]; });
    await bubble.locator('[data-testid="commentor-reply-send"]').click();
    await expect.poll(() => sending.count()).toBe(1);
    await lab.release();
    await expect.poll(() => bubble.locator(".reply:not(.is-sending)").count()).toBe(1);
    expect(await bubble.locator(".reply").count()).toBe(1);
    const replies = (await lab.calls).filter(call => call.method === "reply.add");
    expect(replies.map(call => call.args.clientOperationId)).toEqual([replies[0].args.clientOperationId, replies[0].args.clientOperationId]);
  });

  it("keeps an open optimistic thread open as the echo replaces it, and keeps a sending reply across other live pages (#284)", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: intro }]);
    await lab.openDrawer();
    await lab.host(l => { l.holds = ["reply.add", "thread.create"]; });
    // A reply is sending while unrelated live pages arrive: it stays until its own echo.
    const other = lab.ui.locator('.drawer-thread[data-thread-id="t1"]');
    await other.locator('[data-testid="commentor-reply-input"]').fill("Still sending");
    await other.locator('[data-testid="commentor-reply-send"]').click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    await lab.host(l => l.publish());
    await expect.poll(() => other.locator(".reply.is-sending").count()).toBe(1);
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill("Watch me");
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(2);
    await expect.poll(() => lab.tid("commentor-composer").count()).toBe(0);
    await lab.ui.locator(".pin.is-sending").click();
    const bubble = lab.tid("commentor-thread-bubble");
    await expect.poll(() => bubble.getByTestId("commentor-sending").count()).toBe(1);
    expect(await bubble.getAttribute("data-thread-id")).toMatch(/^sending-/);
    // The thread's echo: the open bubble follows it to the real thread.
    await lab.host(l => l.settle(1));
    await expect.poll(() => bubble.getAttribute("data-thread-id")).toMatch(/^thread-/);
    expect(await bubble.getByTestId("commentor-sending").count()).toBe(0);
    expect(await bubble.innerText()).toContain("Watch me");
    await lab.host(l => l.settle(0));
    await expect.poll(() => other.locator(".reply:not(.is-sending)").count()).toBe(1);
    expect(await other.locator(".reply").count()).toBe(1);
  });

  it("takes nothing back on screen when the reader changes while their writes are sending (#284)", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    await lab.host(l => { l.holds = ["thread.create", "reply.add"]; });
    const card = lab.ui.locator('.drawer-thread[data-thread-id="t1"]');
    await card.locator('[data-testid="commentor-reply-input"]').fill("Mine");
    await card.locator('[data-testid="commentor-reply-send"]').click();
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("second")!.click());
    await lab.tid("commentor-composer-textarea").fill("Also mine");
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(2);
    await lab.host(l => l.host!.setUserId("user-b"));
    // Another reader's view: neither optimistic item, and no composer brought back with the old reader's draft.
    await expect.poll(() => lab.ui.locator(".is-sending").count()).toBe(0);
    await expect.poll(() => toastText(lab).count()).toBeGreaterThan(0);
    expect(await lab.tid("commentor-composer").count()).toBe(0);
  });

  it("closes a composer reopened after an unknown outcome once the echo shows the post was saved (#284)", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill("Did it save?");
    await lab.host(l => { l.holds = ["thread.create"]; });
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    // The parent is replaced before the acknowledgement: the outcome is unknown, so the draft comes back.
    await lab.host(() => {
      (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow!.postMessage({
        type: "commentor-parent-ready", protocolVersion: 2, parentGeneration: "replacement", canReloadViewer: true, userId: "user-a",
      }, "*");
    });
    await expect.poll(() => lab.tid("commentor-composer-textarea").inputValue()).toBe("Did it save?");
    expect(await lab.ui.locator(".is-sending").count()).toBe(0);
    // It had been saved: the echo carries its operation, which settles the draft and closes the composer.
    await lab.host(l => { l.holds = []; l.settle(0); });
    await expect.poll(() => lab.tid("commentor-composer").count()).toBe(0);
    await expect.poll(() => lab.pins().count()).toBe(1);
  });

  it("explains a rate limit with a countdown, then lets the reader post again", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready();
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill("Too soon");
    await lab.host(l => { l.failures = { "thread.create": { kind: "quota", retryAfter: 2000 } }; });
    await lab.tid("commentor-composer-post").click();
    const quota = lab.ui.locator(".comment-quota");
    await expect.poll(() => quota.innerText()).toContain("Too many comments right now; try again in 2 seconds.");
    expect(await lab.tid("commentor-composer-post").isDisabled()).toBe(true);
    await lab.host(l => { l.failures = {}; });
    await lab.page.clock.fastForward(2500);
    await expect.poll(() => lab.tid("commentor-composer-post").isDisabled()).toBe(false);
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.pins().count()).toBe(1);
  });

  it("restores an unsent draft after the document reloads and clears it once posted", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill("Half-written thought");
    await expect.poll(() => lab.page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("commentor-operations:")).length)).toBe(1);
    await lab.page.reload();
    await lab.ready();
    await expect.poll(() => lab.tid("commentor-composer-textarea").inputValue()).toBe("Half-written thought");
    expect(await lab.tid("commentor-composer").locator(".anchor-label").innerText()).toBe("On: “Quarterly report”");
    await lab.tid("commentor-composer-post").click();
    // The pin shows at once as sending (#284); the stored draft clears once the post is saved.
    await expect.poll(() => lab.ui.locator('[data-testid="commentor-pin"]:not(.is-sending)').count()).toBe(1);
    const stored = () => lab.page.evaluate(() => (Object.entries(sessionStorage) as Array<[string, string]>).filter(([key]) => key.startsWith("commentor-operations:")).map(([, value]) => JSON.parse(value) as { operations: object; drafts: object }));
    await expect.poll(async () => (await stored())[0].drafts).toEqual({});
    expect((await stored())[0].operations).toEqual({});
    // A reload after the confirmed post never brings the posted text back as a draft.
    await lab.page.reload();
    await lab.ready([{ _id: "posted", anchor: heading, body: "Half-written thought" }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    expect(await lab.tid("commentor-composer").count()).toBe(0);
    expect((await stored()).every(entry => Object.keys(entry.drafts).length === 0 && Object.keys(entry.operations).length === 0)).toBe(true);
  });
});

describe("thread actions and permissions", () => {
  it("resolves and reopens, archives and unarchives, with accessible pending state and failures", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", body: "Fix me", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    const bubble = await openBubble(lab);
    const resolve = bubble.locator('[data-testid="commentor-resolve-btn"]');
    expect(await resolve.getAttribute("aria-label")).toBe("Resolve comment by Ada");
    await lab.host(l => { l.holds = ["thread.resolve"]; });
    await resolve.click();
    await expect.poll(() => resolve.getAttribute("aria-label")).toBe("Resolve comment by Ada in progress");
    expect(await resolve.getAttribute("aria-busy")).toBe("true");
    expect(await resolve.isDisabled()).toBe(true);
    await lab.release();
    await expect.poll(() => bubble.locator(".head .resolved").innerText()).toBe("Resolved");
    expect(await bubble.locator('[data-testid="commentor-resolve-btn"]').getAttribute("aria-label")).toBe("Reopen comment by Ada");
    expect(await lastCall(lab)).toMatchObject({ method: "thread.resolve", args: { threadId: "t1", resolved: true } });
    expect(await lab.pins().count()).toBe(0);
    await lab.host(l => { l.failures = { "thread.resolve": { kind: "convex", code: "not_found" } }; });
    await bubble.locator('[data-testid="commentor-resolve-btn"]').click();
    await expect.poll(() => toastText(lab).innerText()).toBe("This comment is unavailable. Reload the document.");
    await lab.host(l => { l.failures = {}; });
    await bubble.locator('[data-testid="commentor-resolve-btn"]').click();
    await expect.poll(() => lab.pins().count()).toBe(1);
    expect(await lastCall(lab)).toMatchObject({ args: { resolved: false } });
    await bubble.locator('[data-testid="commentor-archive-btn"]').click();
    await expect.poll(() => lab.pins().count()).toBe(0);
    expect(await bubble.locator(".archived-badge").innerText()).toBe("Archived");
    expect(await bubble.locator('[data-testid="commentor-archive-btn"]').getAttribute("aria-label")).toBe("Unarchive comment by Ada");
    await bubble.locator('[data-testid="commentor-archive-btn"]').click();
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.host(l => { l.failures = { "thread.archive": { kind: "plain" } }; });
    await bubble.locator('[data-testid="commentor-archive-btn"]').click();
    await expect.poll(() => toastText(lab).last().innerText()).toBe("Could not archive comment.");
  });

  it("shows a write as pending before the host holds it, and release waits for the host to receive it", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", body: "Fix me", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    const bubble = await openBubble(lab);
    const resolve = bubble.locator('[data-testid="commentor-resolve-btn"]');
    // A slow host: the request reaches it long after the widget showed its pending state.
    await lab.host(l => { const original = l.mutate.bind(l); l.mutate = (method, args) => new Promise(done => setTimeout(done, 300)).then(() => original(method, args)); l.holds = ["thread.resolve"]; });
    await resolve.click();
    await expect.poll(() => resolve.getAttribute("aria-busy")).toBe("true");
    expect(await lab.host(l => l.held.length)).toBe(0);
    await lab.release();
    await expect.poll(() => bubble.locator(".head .resolved").innerText()).toBe("Resolved");
    expect(await lab.host(l => l.held.length)).toBe(0);
  });

  it("offers Delete and Archive only where the server allows them, and nothing to read-only viewers", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "mine", anchor: heading, canDelete: true }, { _id: "theirs", anchor: intro, canDelete: false, replies: [
      { _id: "r1", _creationTime: Date.now(), authorName: "Grace", authorEmail: "g@example.test", body: "Mine", canDelete: true },
      { _id: "r2", _creationTime: Date.now(), authorName: "Linus", authorEmail: "l@example.test", body: "Theirs", canDelete: false }] }]);
    await expect.poll(() => lab.pins().count()).toBe(2);
    const bubble = await openBubble(lab, 1);
    expect(await bubble.locator('[data-testid="commentor-resolve-btn"]').count()).toBe(1);
    expect(await bubble.locator('[data-testid="commentor-archive-btn"], [data-testid="commentor-delete-btn"]').count()).toBe(0);
    expect(await bubble.locator('[data-testid="commentor-delete-reply-btn"]').count()).toBe(1);
    expect(await bubble.locator(".reply", { hasText: "Theirs" }).locator("button").count()).toBe(0);
    await openBubble(lab, 0);
    expect(await lab.tid("commentor-thread-bubble").locator('[data-testid="commentor-archive-btn"], [data-testid="commentor-delete-btn"]').count()).toBe(2);

    const viewer = await commentLab.open({ canWrite: false });
    await viewer.ready([{ _id: "mine", anchor: heading }]);
    await expect.poll(() => viewer.pins().count()).toBe(1);
    expect(await viewer.tid("commentor-comment-btn").isDisabled()).toBe(true);
    const readOnly = await openBubble(viewer);
    expect(await readOnly.locator("button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")))).toEqual(["Close thread", "Locate commented text on page"]);
    expect(await readOnly.locator("textarea").count()).toBe(0);
    await viewer.select("#intro", 0, 9);
    await viewer.page.keyboard.press("Control+c");
    expect(await viewer.tid("commentor-selection-action").getAttribute("data-state")).toBe("closed");
  });

  it("deletes after an undo window and rolls back with an explanation when the delete fails", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready([{ _id: "t1", body: "Gone soon", anchor: heading }, { _id: "t2", body: "Stays", anchor: intro }]);
    await expect.poll(() => lab.pins().count()).toBe(2);
    // The undo window and its toast last 5s of clock time and a closed toast leaves 150ms later: only the test moves the clock.
    await lab.pauseClock();
    await openBubble(lab);
    const deleteButton = lab.tid("commentor-thread-bubble").locator('[data-testid="commentor-delete-btn"]');
    await deleteButton.click();
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.page.clock.runFor(200);
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(0);
    const status = lab.ui.locator('.toast[role="status"]');
    expect(await status.innerText()).toContain("Comment deleted.");
    await status.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => lab.pins().count()).toBe(2);
    await expect.poll(() => status.last().innerText()).toContain("Deletion undone.");
    await lab.page.clock.fastForward(6000);
    await lab.page.clock.runFor(200);
    expect((await lab.calls).filter(call => call.method === "thread.remove")).toHaveLength(0);
    // A second delete commits when the window passes and the thread leaves for good.
    await openBubble(lab);
    await deleteButton.click();
    await lab.page.clock.fastForward(5000);
    await expect.poll(async () => (await lab.calls).filter(call => call.method === "thread.remove").length).toBe(1);
    expect(await lastCall(lab)).toMatchObject({ method: "thread.remove", args: { threadId: "t1" } });
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.page.clock.runFor(200);
    // Undo after the commit started explains that it is too late.
    await openBubble(lab);
    await lab.host(l => { l.holds = ["thread.remove"]; });
    await deleteButton.click();
    await lab.page.clock.fastForward(5000);
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    await lab.ui.locator('.toast:has-text("Comment deleted.") button').last().dispatchEvent("click");
    await expect.poll(() => lab.ui.locator(".toast").last().innerText()).toBe("Deletion is already in progress.");
    await lab.host(l => { l.holds = []; l.settle(0, { kind: "convex", code: "forbidden" }); });
    await expect.poll(() => toastText(lab).innerText()).toBe("You do not have permission to change this comment.");
    await expect.poll(() => lab.pins().count()).toBe(1);
  });

  it("restores a thread whose delete failed for an unknown reason", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.host(l => { l.failures = { "thread.remove": { kind: "plain" } }; });
    await lab.openDrawer();
    await lab.tid("commentor-delete-btn").click();
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(0);
    await lab.page.clock.fastForward(5000);
    await expect.poll(() => toastText(lab).innerText()).toBe("Could not delete comment.");
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(1);
  });
});

describe("replies", () => {
  it("replies with Enter, keeps Shift+Enter as a newline, and removes only deletable replies", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, replies: [{ _id: "r1", _creationTime: Date.now(), authorName: "Grace", authorEmail: "g@example.test", body: "First reply", canDelete: true }] }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    const bubble = await openBubble(lab);
    const input = bubble.locator('[data-testid="commentor-reply-input"]');
    expect(await input.getAttribute("aria-describedby")).toBe("commentor-reply-help-t1");
    await input.click();
    await lab.page.keyboard.type("Line one");
    await lab.page.keyboard.press("Shift+Enter");
    await lab.page.keyboard.type("line two");
    expect(await input.inputValue()).toBe("Line one\nline two");
    // Drafts survive a live update that re-renders the bubble, with focus and caret kept.
    await input.evaluate(el => el.setAttribute("data-before-update", ""));
    await lab.host(l => l.publish());
    const replacement = bubble.locator('[data-testid="commentor-reply-input"]:not([data-before-update])');
    await expect.poll(() => replacement.evaluate(el => el === (el.getRootNode() as ShadowRoot).activeElement)).toBe(true);
    expect(await replacement.inputValue()).toBe("Line one\nline two");
    await lab.host(l => { l.holds = ["reply.add"]; });
    await lab.page.keyboard.press("Enter");
    const send = bubble.locator('[data-testid="commentor-reply-send"]');
    await expect.poll(() => send.innerText()).toBe("Sending…");
    expect(await send.getAttribute("aria-busy")).not.toBeNull();
    expect(await input.isDisabled()).toBe(true);
    await lab.release();
    await expect.poll(() => bubble.locator(".reply").count()).toBe(2);
    expect(await input.inputValue()).toBe("");
    expect(await send.innerText()).toBe("Reply");
    expect(await lastCall(lab)).toMatchObject({ method: "reply.add", args: { threadId: "t1", body: "Line one\nline two" } });
    await expect.poll(() => lab.focused()).toBe("commentor-reply-input");
    await input.fill("  ");
    await lab.page.keyboard.press("Enter");
    expect((await lab.calls).filter(call => call.method === "reply.add")).toHaveLength(1);
    await bubble.locator(".reply", { hasText: "First reply" }).locator('[data-testid="commentor-delete-reply-btn"]').click();
    await expect.poll(() => bubble.locator(".reply").count()).toBe(1);
    expect(await lastCall(lab)).toMatchObject({ method: "reply.remove", args: { threadId: "t1", replyId: "r1" } });
  });

  it("keeps the reply draft on a rejected reply and explains it", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    const bubble = await openBubble(lab);
    const input = bubble.locator('[data-testid="commentor-reply-input"]');
    await input.fill("Will fail");
    await lab.host(l => { l.failures = { "reply.add": { kind: "convex", code: "invalid_input" } }; });
    await bubble.locator('[data-testid="commentor-reply-send"]').click();
    await expect.poll(() => toastText(lab).innerText()).toBe("Check your comment and try again.");
    expect(await input.inputValue()).toBe("Will fail");
    await lab.host(l => { l.failures = { "reply.add": { kind: "plain" } }; });
    await bubble.locator('[data-testid="commentor-reply-send"]').click();
    await expect.poll(() => toastText(lab).last().innerText()).toBe("Could not post reply.");
    await lab.host(l => { l.failures = { "reply.add": { kind: "quota", retryAfter: 4000 } }; });
    await bubble.locator('[data-testid="commentor-reply-send"]').click();
    await expect.poll(() => lab.ui.locator(".comment-quota").innerText()).toContain("try again in 4 seconds");
    expect(await bubble.locator('[data-testid="commentor-reply-send"]').isDisabled()).toBe(true);
  });
});

describe("write guards", () => {
  it("ignores a repeated activation of a busy action and keeps a removal's control disabled across live updates", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, replies: [{ _id: "r1", _creationTime: Date.now(), authorName: "Grace", authorEmail: "g@example.test", body: "Mine", canDelete: true }] }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    const bubble = await openBubble(lab);
    await lab.host(l => { l.holds = ["thread.resolve", "reply.remove"]; });
    const resolve = bubble.locator('[data-testid="commentor-resolve-btn"]');
    await resolve.click();
    await expect.poll(() => resolve.isDisabled()).toBe(true);
    await resolve.dispatchEvent("click");
    expect(await lab.host(l => l.held.length)).toBe(1);
    await bubble.locator('[data-testid="commentor-delete-reply-btn"]').click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(2);
    // A live update replaces the buttons; the replacements stay disabled while their writes are outstanding.
    await lab.host(l => l.publish());
    await expect.poll(() => bubble.locator('[data-testid="commentor-delete-reply-btn"]').isDisabled()).toBe(true);
    await expect.poll(() => bubble.locator('[data-testid="commentor-resolve-btn"]').isDisabled()).toBe(true);
    await lab.host(l => { l.holds = []; l.settle(0); l.settle(0); });
    await expect.poll(() => bubble.locator('[data-testid="commentor-resolve-btn"]').isDisabled()).toBe(false);
  });

  it("clears the stored draft when the reply is emptied, and keeps text typed while a reply is sending", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }, { _id: "t2", anchor: heading }]);
    await lab.openDrawer();
    const card = (id: string) => lab.ui.locator(`.drawer-thread[data-thread-id="${id}"]`);
    const input = card("t1").locator('[data-testid="commentor-reply-input"]');
    const drafts = () => lab.page.evaluate(() => (Object.values(sessionStorage) as string[]).flatMap(value => value.includes('"drafts"') ? [Object.keys((JSON.parse(value) as { drafts: object }).drafts)] : []));
    await input.fill("temporary");
    await expect.poll(drafts).toEqual([["t1"]]);
    await input.fill("");
    await expect.poll(drafts).toEqual([[]]);
    await input.fill("send me");
    await lab.host(l => { l.holds = ["reply.add"]; });
    await card("t1").locator('[data-testid="commentor-reply-send"]').click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    // Other threads keep their own reply controls while this one is busy.
    expect(await card("t2").locator('[data-testid="commentor-reply-send"]').isDisabled()).toBe(false);
    await input.evaluate((el: HTMLTextAreaElement) => { el.value = "typed meanwhile"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await lab.host(l => { l.holds = []; l.settle(0); });
    await expect.poll(() => card("t1").locator(".reply").count()).toBe(1);
    expect(await input.inputValue()).toBe("typed meanwhile");
  });

  it("holds a second reply during a quota wait, then focuses the reply box when the notice is dismissed", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    const bubble = await openBubble(lab);
    const input = bubble.locator('[data-testid="commentor-reply-input"]');
    await input.fill("Too soon");
    await lab.host(l => { l.failures = { "reply.add": { kind: "quota", retryAfter: 5000 } }; });
    await bubble.locator('[data-testid="commentor-reply-send"]').click();
    const quota = lab.ui.locator(".comment-quota");
    await expect.poll(() => quota.innerText()).toContain("try again in 5 seconds");
    await quota.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(() => lab.focused()).toBe("commentor-reply-input");
    await lab.page.keyboard.press("Enter");
    await expect.poll(() => quota.isVisible()).toBe(true);
    await lab.page.clock.setSystemTime(Date.now() + 6_000);
    await lab.page.keyboard.press("Enter");
    expect((await lab.calls).filter(call => call.method === "reply.add")).toHaveLength(1);
    await lab.host(l => { l.failures = {}; });
    await lab.page.clock.fastForward(1_000);
    await expect.poll(() => bubble.locator('[data-testid="commentor-reply-send"]').isDisabled()).toBe(false);
    await lab.page.keyboard.press("Enter");
    await expect.poll(() => bubble.locator(".reply").count()).toBe(1);
  });

  it("labels a long selection with a trimmed quote", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.select("#intro");
    await lab.tid("commentor-selection-action").click();
    const label = await lab.tid("commentor-composer").locator(".anchor-label").innerText();
    expect(label.startsWith("On: “The quick brown fox")).toBe(true);
    expect(label.endsWith("…”")).toBe(true);
    expect(label.length).toBe("On: “".length + 60 + "…”".length);
  });
});
