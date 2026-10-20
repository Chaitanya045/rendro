import { beforeAll, describe, expect, it } from "vitest";
import { anchorOn, useCommentLab, type Lab } from "./helpers/comment-lab";

// Editing one's own thread or reply (#287) in the real widget, transport and host, with only Convex replaced.
const commentLab = useCommentLab();
beforeAll(() => commentLab.start());

const heading = anchorOn("Quarterly report");
const intro = anchorOn("lazy dog and keeps running");
const toastText = (lab: Lab) => lab.ui.locator('.toast[role="alert"]');
const live = (lab: Lab) => lab.tid("commentor-live");
const card = (lab: Lab, id = "t1") => lab.ui.locator(`.drawer-thread[data-thread-id="${id}"]`);
const editCalls = async (lab: Lab, method = "thread.edit") => (await lab.calls).filter(call => call.method === method);

async function openBubble(lab: Lab) {
  await lab.pins().first().click();
  await lab.tid("commentor-thread-bubble").waitFor();
  return lab.tid("commentor-thread-bubble");
}

describe("editing a thread", () => {
  it("edits inline with focus in and out, shows the text at once as saving, and the echo brings the edited marker", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Frist draft", canEdit: true }]);
    await lab.openDrawer();
    const edit = card(lab).getByTestId("commentor-edit-btn");
    expect(await edit.getAttribute("aria-label")).toBe("Edit comment by Ada");
    await edit.click();
    const input = card(lab).getByTestId("commentor-edit-input");
    await expect.poll(() => lab.focused()).toBe("commentor-edit-input");
    expect(await input.inputValue()).toBe("Frist draft");
    expect(await input.getAttribute("aria-label")).toBe("Edit comment by Ada");
    expect(await lab.doc(() => {
      const root = document.getElementById("commentor-host")!.shadowRoot!;
      const textarea = root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-edit-input"]')!;
      return [textarea.selectionStart, root.getElementById(textarea.getAttribute("aria-describedby")!)?.textContent];
    })).toEqual([11, "Enter or Ctrl+Enter to save · Shift+Enter for a new line · Esc to cancel"]);
    await expect.poll(() => live(lab).innerText()).toBe("Editing your comment.");
    expect(await card(lab).locator(".thread-view > .body").count()).toBe(0);
    await input.fill("First draft");
    await lab.host(l => { l.holds = ["thread.edit"]; });
    await input.press("Enter");
    // At once, before the request reaches the backend: the editor is gone, the new text is here, marked as saving.
    await expect.poll(() => card(lab).getByTestId("commentor-saving").count()).toBe(1);
    expect(await card(lab).getByTestId("commentor-saving").innerText()).toBe("Saving…");
    expect(await card(lab).locator(".thread-view > .body").innerText()).toBe("First draft");
    expect(await card(lab).getAttribute("aria-busy")).toBe("true");
    expect(await card(lab).getAttribute("class")).toContain("is-sending");
    expect(await card(lab).getByTestId("commentor-edit-input").count()).toBe(0);
    await expect.poll(() => lab.focused()).toBe("commentor-edit-btn");
    expect(await edit.getAttribute("aria-disabled")).toBe("true");
    // Edit while saving does nothing (aria-disabled keeps it focusable, so the click is forced).
    await edit.click({ force: true });
    expect(await card(lab).getByTestId("commentor-edit-input").count()).toBe(0);
    expect(await card(lab).getByTestId("commentor-edited").count()).toBe(0);
    // The live page carries the edit (published before the acknowledgement, as Convex does).
    await lab.release();
    await expect.poll(() => card(lab).getByTestId("commentor-saving").count()).toBe(0);
    // The echo and the acknowledgement rebuild the list; focus stays on the comment's Edit.
    await expect.poll(() => lab.focused()).toBe("commentor-edit-btn");
    const marker = card(lab).getByTestId("commentor-edited");
    expect(await marker.innerText()).toBe("edited");
    expect(await marker.getAttribute("role")).toBe("note");
    expect(await marker.getAttribute("aria-label")).toMatch(/^Edited \S.+\d/);
    expect(await marker.getAttribute("title")).toBe(await marker.getAttribute("aria-label"));
    expect(await card(lab).locator(".thread-view > .body").innerText()).toBe("First draft");
    expect(await card(lab).getAttribute("aria-busy")).toBeNull();
    expect(await edit.getAttribute("aria-disabled")).toBeNull();
    await expect.poll(() => live(lab).innerText()).toBe("Edit saved.");
    const calls = await editCalls(lab);
    expect(calls).toEqual([{ method: "thread.edit", args: { threadId: "t1", body: "First draft", clientOperationId: expect.any(String), expectedAuthorId: "user-a" } }]);
    // The stored draft and operation are gone once the edit is saved.
    const stored = await lab.page.evaluate(() => (Object.entries(sessionStorage) as Array<[string, string]>)
      .filter(([key]) => key.startsWith("commentor-operations:")).map(([, value]) => JSON.parse(value) as { operations: object; drafts: object }));
    expect(stored.every(entry => Object.keys(entry.drafts).length === 0 && Object.keys(entry.operations).length === 0)).toBe(true);
  });

  it("rolls a failed edit back, reopens the editor with the reader's text, and retries an unknown outcome as the same operation", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Original", canEdit: true }]);
    const bubble = await openBubble(lab);
    await bubble.getByTestId("commentor-edit-btn").click();
    const input = bubble.getByTestId("commentor-edit-input");
    await input.fill("My edit");
    await lab.host(l => { l.holds = ["thread.edit"]; });
    await bubble.getByTestId("commentor-edit-save").click();
    await expect.poll(() => bubble.getByTestId("commentor-saving").count()).toBe(1);
    expect(await bubble.locator(".thread-view > .body").innerText()).toBe("My edit");
    expect(await bubble.locator(".thread-view").getAttribute("aria-busy")).toBe("true");
    await lab.release({ kind: "convex", code: "forbidden" });
    await expect.poll(() => toastText(lab).innerText()).toBe("You do not have permission to change this comment.");
    // Rolled back: the comment shows its text again nowhere but in the reopened editor, which keeps the reader's.
    await expect.poll(() => bubble.getByTestId("commentor-edit-input").inputValue()).toBe("My edit");
    expect(await bubble.getByTestId("commentor-saving").count()).toBe(0);
    expect(await bubble.getByTestId("commentor-edited").count()).toBe(0);
    await expect.poll(() => lab.focused()).toBe("commentor-edit-input");
    expect(await bubble.getByTestId("commentor-edit-input").isDisabled()).toBe(false);
    expect(await lab.host(l => l.threads[0].body)).toBe("Original");
    // An unknown failure keeps the operation: Save retries it under the same clientOperationId.
    await lab.host(l => { l.failures = { "thread.edit": { kind: "plain" } }; });
    await bubble.getByTestId("commentor-edit-save").click();
    await expect.poll(() => toastText(lab).last().innerText()).toBe("Could not save your edit.");
    expect(await bubble.getByTestId("commentor-edit-input").inputValue()).toBe("My edit");
    // Changing the text of an unconfirmed edit is refused until it is resubmitted unchanged.
    await bubble.getByTestId("commentor-edit-input").fill("Another edit");
    await bubble.getByTestId("commentor-edit-save").click();
    await expect.poll(() => toastText(lab).last().innerText()).toBe("Your previous comment is still unconfirmed. Resubmit the original draft before editing it.");
    expect(await bubble.getByTestId("commentor-edit-input").inputValue()).toBe("Another edit");
    await lab.host(l => { l.failures = {}; });
    await bubble.getByTestId("commentor-edit-input").fill("My edit");
    await bubble.getByTestId("commentor-edit-save").click();
    await expect.poll(() => bubble.locator(".thread-view > .body").innerText()).toBe("My edit");
    await expect.poll(() => bubble.getByTestId("commentor-edited").count()).toBe(1);
    const ids = (await editCalls(lab)).map(call => call.args.clientOperationId);
    expect(ids).toHaveLength(3);
    expect(ids[2]).toBe(ids[1]);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("keeps a saving edit across other live pages, and shows it saved when the acknowledgement comes before the echo", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Before", canEdit: true }, { _id: "t2", anchor: intro, body: "Unrelated" }]);
    await lab.openDrawer();
    await card(lab).getByTestId("commentor-edit-btn").click();
    await card(lab).getByTestId("commentor-edit-input").fill("After");
    await lab.host(l => { l.holds = ["thread.edit"]; l.publishOnMutate = false; });
    await card(lab).getByTestId("commentor-edit-save").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    // A live page without the edit leaves it shown, still saving.
    await lab.host(l => { l.threads[1].body = "Unrelated, changed"; l.publish(); });
    await expect.poll(() => card(lab, "t2").locator(".thread-view > .body").innerText()).toBe("Unrelated, changed");
    expect(await card(lab).locator(".thread-view > .body").innerText()).toBe("After");
    expect(await card(lab).getByTestId("commentor-saving").count()).toBe(1);
    // Acknowledged before any live page carries it: no longer saving, the new text stays until the echo.
    await lab.release();
    await expect.poll(() => card(lab).getByTestId("commentor-saving").count()).toBe(0);
    expect(await card(lab).locator(".thread-view > .body").innerText()).toBe("After");
    expect(await card(lab).getByTestId("commentor-edited").count()).toBe(0);
    await expect.poll(() => live(lab).innerText()).toBe("Edit saved.");
    await lab.host(l => { l.publishOnMutate = true; l.publish(); });
    await expect.poll(() => card(lab).getByTestId("commentor-edited").count()).toBe(1);
    expect(await card(lab).locator(".thread-view > .body").innerText()).toBe("After");
  });

  it("saves a double submit once, and Ctrl+Enter saves while Shift+Enter adds a line", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Once", canEdit: true }]);
    await lab.openDrawer();
    await card(lab).getByTestId("commentor-edit-btn").click();
    const input = card(lab).getByTestId("commentor-edit-input");
    await input.fill("Only once");
    await lab.host(l => { l.holds = ["thread.edit"]; });
    // Enter twice and a click, in one task: the first submit closes the editor before the second runs.
    await input.evaluate(element => {
      const enter = () => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
      enter();
      enter();
      (element.getRootNode() as ShadowRoot).querySelector<HTMLButtonElement>('[data-testid="commentor-edit-save"]')?.click();
    });
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    await lab.release();
    await expect.poll(() => card(lab).getByTestId("commentor-edited").count()).toBe(1);
    expect(await editCalls(lab)).toHaveLength(1);
    await card(lab).getByTestId("commentor-edit-btn").click();
    await input.press("End");
    await input.press("Shift+Enter");
    await input.pressSequentially("second line");
    expect(await input.inputValue()).toBe("Only once\nsecond line");
    await input.press("Control+Enter");
    await expect.poll(() => card(lab).locator(".thread-view > .body").innerText()).toBe("Only once\nsecond line");
    await expect.poll(async () => (await editCalls(lab)).map(call => call.args.body)).toEqual(["Only once", "Only once\nsecond line"]);
  });

  it("cancels with Escape or Cancel, keeping the open bubble and the comment's text, and saves nothing unchanged", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Keep me", canEdit: true }]);
    const bubble = await openBubble(lab);
    await bubble.getByTestId("commentor-edit-btn").click();
    await bubble.getByTestId("commentor-edit-input").fill("Throw away");
    await bubble.getByTestId("commentor-edit-input").press("Escape");
    // Only the edit ends: the bubble stays, with the comment's own text and focus back on its Edit.
    await expect.poll(() => bubble.getByTestId("commentor-edit-input").count()).toBe(0);
    expect(await lab.tid("commentor-thread-bubble").count()).toBe(1);
    expect(await bubble.locator(".thread-view > .body").innerText()).toBe("Keep me");
    await expect.poll(() => lab.focused()).toBe("commentor-edit-btn");
    await expect.poll(() => live(lab).innerText()).toBe("Edit cancelled.");
    // The discarded text is not kept: the editor opens with the comment's text again.
    await bubble.getByTestId("commentor-edit-btn").click();
    expect(await bubble.getByTestId("commentor-edit-input").inputValue()).toBe("Keep me");
    await bubble.getByTestId("commentor-edit-input").fill("Throw away too");
    await bubble.getByTestId("commentor-edit-cancel").click();
    await expect.poll(() => bubble.getByTestId("commentor-edit-input").count()).toBe(0);
    await expect.poll(() => lab.focused()).toBe("commentor-edit-btn");
    // The text again, or only blanks, writes nothing.
    await bubble.getByTestId("commentor-edit-btn").click();
    await bubble.getByTestId("commentor-edit-input").fill("   ");
    await bubble.getByTestId("commentor-edit-save").click();
    expect(await bubble.getByTestId("commentor-edit-input").count()).toBe(1);
    await bubble.getByTestId("commentor-edit-input").fill(" Keep me ");
    await bubble.getByTestId("commentor-edit-save").click();
    await expect.poll(() => bubble.getByTestId("commentor-edit-input").count()).toBe(0);
    await expect.poll(() => live(lab).innerText()).toContain("No changes to save.");
    expect(await bubble.getByTestId("commentor-edited").count()).toBe(0);
    expect(await editCalls(lab)).toEqual([]);
  });

  it("keeps an unsaved edit across live pages and a reload of the document, then discards it with the edit", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Draft me", canEdit: true }, { _id: "t2", anchor: intro, body: "Other" }]);
    await lab.openDrawer();
    await card(lab).getByTestId("commentor-edit-btn").click();
    const input = card(lab).getByTestId("commentor-edit-input");
    await input.fill("Draft me, carefully");
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 5));
    // Another live page rebuilds the list: the editor keeps its text, focus and caret.
    await lab.host(l => { l.threads[1].body = "Other, changed"; l.publish(); });
    await expect.poll(() => card(lab, "t2").locator(".thread-view > .body").innerText()).toBe("Other, changed");
    await expect.poll(() => lab.focused()).toBe("commentor-edit-input");
    expect(await input.inputValue()).toBe("Draft me, carefully");
    expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([3, 5]);
    // The draft outlives a reload, and the next Edit opens with it.
    await lab.page.reload();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Draft me", canEdit: true }]);
    await lab.openDrawer();
    expect(await card(lab).getByTestId("commentor-edit-input").count()).toBe(0);
    await card(lab).getByTestId("commentor-edit-btn").click();
    expect(await card(lab).getByTestId("commentor-edit-input").inputValue()).toBe("Draft me, carefully");
    await card(lab).getByTestId("commentor-edit-input").press("Escape");
    await card(lab).getByTestId("commentor-edit-btn").click();
    expect(await card(lab).getByTestId("commentor-edit-input").inputValue()).toBe("Draft me");
    // A comment deleted while it is edited takes its editor with it.
    await lab.host(l => { l.threads = []; l.publish(); });
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(0);
    await lab.host(l => { l.threads = [l.thread({ _id: "t1", anchor: l.anchorOn("Quarterly report"), body: "Back", canEdit: true })]; l.publish(); });
    await expect.poll(() => card(lab).locator(".thread-view > .body").innerText()).toBe("Back");
    expect(await card(lab).getByTestId("commentor-edit-input").count()).toBe(0);
  });

  it("explains a rate limit with a countdown and keeps the edit text, then saves", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Slow down", canEdit: true }]);
    await lab.openDrawer();
    await card(lab).getByTestId("commentor-edit-btn").click();
    await card(lab).getByTestId("commentor-edit-input").fill("Too soon");
    await lab.host(l => { l.failures = { "thread.edit": { kind: "quota", retryAfter: 2000 } }; });
    await card(lab).getByTestId("commentor-edit-save").click();
    const quota = lab.ui.locator(".comment-quota");
    await expect.poll(() => quota.innerText()).toContain("Too many comments right now; try again in 2 seconds.");
    expect(await card(lab).getByTestId("commentor-edit-input").inputValue()).toBe("Too soon");
    expect(await card(lab).getByTestId("commentor-edit-save").isDisabled()).toBe(true);
    // Enter during the wait shows the reason again instead of saving.
    await quota.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(() => lab.focused()).toBe("commentor-edit-input");
    await card(lab).getByTestId("commentor-edit-input").press("Enter");
    expect(await quota.isVisible()).toBe(true);
    await lab.host(l => { l.failures = {}; });
    await lab.page.clock.fastForward(2500);
    await expect.poll(() => card(lab).getByTestId("commentor-edit-save").isDisabled()).toBe(false);
    await card(lab).getByTestId("commentor-edit-save").click();
    await expect.poll(() => card(lab).getByTestId("commentor-edited").count()).toBe(1);
    expect((await editCalls(lab)).map(call => call.args.body)).toEqual(["Too soon", "Too soon"]);
  });
});

describe("editing a reply, and who may edit", () => {
  it("edits the author's own reply optimistically, and offers Edit on nothing else", async () => {
    const lab = await commentLab.open();
    await lab.ready([
      { _id: "t1", anchor: heading, body: "Theirs", canDelete: false, replies: [
        { _id: "r1", _creationTime: 1, authorName: "Grace", authorEmail: "", body: "Their reply", canDelete: false },
        { _id: "r2", _creationTime: 2, authorName: "Me", authorEmail: "", body: "My reply", canDelete: true, canEdit: true },
      ] },
    ]);
    const bubble = await openBubble(lab);
    expect(await bubble.getByTestId("commentor-edit-btn").count()).toBe(0);
    const edits = bubble.getByTestId("commentor-edit-reply-btn");
    expect(await edits.count()).toBe(1);
    expect(await edits.getAttribute("aria-label")).toBe("Edit reply by Me");
    await edits.click();
    const input = bubble.getByTestId("commentor-edit-input");
    await expect.poll(() => lab.focused()).toBe("commentor-edit-input");
    expect(await input.inputValue()).toBe("My reply");
    expect(await input.getAttribute("aria-label")).toBe("Edit reply by Me");
    await expect.poll(() => live(lab).innerText()).toBe("Editing your reply.");
    await input.fill("My reply, fixed");
    await lab.host(l => { l.holds = ["reply.edit"]; });
    await input.press("Enter");
    const saving = bubble.locator(".reply.is-sending");
    await expect.poll(() => saving.count()).toBe(1);
    expect(await saving.getAttribute("aria-busy")).toBe("true");
    expect(await saving.innerText()).toContain("My reply, fixed");
    expect(await saving.getByTestId("commentor-saving").innerText()).toBe("Saving…");
    await expect.poll(() => lab.focused()).toBe("commentor-edit-reply-btn");
    // A failure takes it back into the editor; the retry is saved and marked.
    await lab.release({ kind: "convex", code: "not_found" });
    await expect.poll(() => toastText(lab).innerText()).toBe("This comment is unavailable. Reload the document.");
    await expect.poll(() => input.inputValue()).toBe("My reply, fixed");
    expect(await bubble.locator(".reply", { hasText: "My reply" }).getByTestId("commentor-edited").count()).toBe(0);
    await input.press("Control+Enter");
    await expect.poll(() => bubble.locator(".reply").nth(1).getByTestId("commentor-edited").count()).toBe(1);
    expect(await bubble.locator(".reply").nth(1).innerText()).toContain("My reply, fixed");
    expect(await bubble.locator(".reply.is-sending").count()).toBe(0);
    const calls = await editCalls(lab, "reply.edit");
    expect(calls.map(call => [call.args.threadId, call.args.replyId, call.args.body])).toEqual([["t1", "r2", "My reply, fixed"], ["t1", "r2", "My reply, fixed"]]);
    // A reply still sending has no ID to edit.
    await lab.host(l => { l.holds = ["reply.add"]; });
    await bubble.getByTestId("commentor-reply-input").fill("Brand new");
    await bubble.getByTestId("commentor-reply-send").click();
    await expect.poll(() => bubble.locator(".reply.is-sending").count()).toBe(1);
    expect(await bubble.locator(".reply.is-sending").getByTestId("commentor-edit-reply-btn").count()).toBe(0);
    await lab.release();
  });

  it("offers no Edit to a reader who may not write, or under a shell that does not carry edits", async () => {
    const readonly = await commentLab.open({ canWrite: false });
    await readonly.ready([{ _id: "t1", anchor: heading, canEdit: true, replies: [{ _id: "r1", _creationTime: 1, authorName: "Me", authorEmail: "", body: "Mine", canEdit: true }] }]);
    await readonly.openDrawer();
    expect(await card(readonly).locator('[data-testid="commentor-edit-btn"], [data-testid="commentor-edit-reply-btn"]').count()).toBe(0);
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, canEdit: true }]);
    await lab.openDrawer();
    await card(lab).getByTestId("commentor-edit-btn").click();
    expect(await card(lab).getByTestId("commentor-edit-input").count()).toBe(1);
    // A shell loaded before edits says nothing of them: the widget offers none, and drops an open editor.
    await lab.host(() => {
      const frame = document.querySelector<HTMLIFrameElement>("#content-frame")!;
      frame.contentWindow!.postMessage({ type: "commentor-parent-ready", protocolVersion: 2, parentGeneration: "older-shell", userId: "user-a", canWrite: true }, "*");
    });
    await expect.poll(() => card(lab).getByTestId("commentor-edit-btn").count()).toBe(0);
    expect(await card(lab).getByTestId("commentor-edit-input").count()).toBe(0);
  });

  it("shows another reader's edit live, without disturbing what this reader is typing", async () => {
    const lab = await commentLab.open();
    await lab.ready([
      { _id: "t1", anchor: heading, body: "Before", replies: [{ _id: "r1", _creationTime: 1, authorName: "Grace", authorEmail: "", body: "Reply before" }] },
      { _id: "t2", anchor: intro, body: "Mine to answer" },
    ]);
    await lab.openDrawer();
    const reply = card(lab, "t2").getByTestId("commentor-reply-input");
    await reply.fill("Typing here");
    // The author edits elsewhere: the live page brings the new text and the marker to this reader's open page.
    await lab.host(l => {
      Object.assign(l.threads[0], { body: "After", editedAt: Date.now() - 5_000, editOperationId: "their-op" });
      l.threads[0].replies = [{ ...l.threads[0].replies[0], body: "Reply after", editedAt: Date.now() }];
      l.publish();
    });
    await expect.poll(() => card(lab).locator(".thread-view > .body").innerText()).toBe("After");
    expect(await card(lab).locator(".thread-view > .head").getByTestId("commentor-edited").count()).toBe(1);
    expect(await card(lab).locator(".reply").innerText()).toContain("Reply after");
    expect(await card(lab).locator(".reply").getByTestId("commentor-edited").count()).toBe(1);
    // Nobody else's comment is this reader's to edit.
    expect(await card(lab).locator('[data-testid="commentor-edit-btn"], [data-testid="commentor-edit-reply-btn"]').count()).toBe(0);
    await expect.poll(() => lab.focused()).toBe("commentor-reply-input");
    expect(await reply.inputValue()).toBe("Typing here");
  });

  it("takes nothing back on screen when the reader changes while an edit is saving", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Mine", canEdit: true }]);
    await lab.openDrawer();
    await card(lab).getByTestId("commentor-edit-btn").click();
    await card(lab).getByTestId("commentor-edit-input").fill("Mine, edited");
    await lab.host(l => { l.holds = ["thread.edit"]; });
    await card(lab).getByTestId("commentor-edit-save").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    await lab.host(l => l.host!.setUserId("user-b"));
    await expect.poll(() => lab.ui.locator('[data-testid="commentor-saving"]').count()).toBe(0);
    // Another reader's view: no editor brought back with the old reader's text.
    await lab.host(l => l.publish());
    await expect.poll(() => card(lab).locator(".thread-view > .body").innerText()).toBe("Mine");
    expect(await lab.tid("commentor-edit-input").count()).toBe(0);
  });
});
