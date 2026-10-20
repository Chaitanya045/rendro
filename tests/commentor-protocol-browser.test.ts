import { beforeAll, describe, expect, it } from "vitest";
import { anchorOn, useCommentLab, type Lab } from "./helpers/comment-lab";

const commentLab = useCommentLab();
beforeAll(() => commentLab.start());

const heading = anchorOn("Quarterly report");
const alert = (lab: Lab) => lab.ui.locator('.toast[role="alert"]').first();
const parentReady = (lab: Lab, ready: Record<string, unknown>) => lab.host((_lab, ready) => {
  (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow!.postMessage({ type: "commentor-parent-ready", ...ready }, "*");
}, ready);
/** A publisher script talking to the parent over the same channel the widget uses. */
const publisherSends = (lab: Lab, messages: unknown[]) => lab.doc(messages => {
  const w = window as unknown as { __responses?: unknown[] };
  if (!w.__responses) {
    w.__responses = [];
    window.addEventListener("message", event => { if (event.source === window.parent && (event.data as { type?: string })?.type === "commentor-parent-response") w.__responses!.push(event.data); });
  }
  for (const message of messages) window.parent.postMessage(message, "*");
}, messages);
const responses = (lab: Lab) => lab.doc(() => (window as unknown as { __responses?: unknown[] }).__responses ?? []);
const request = (requestId: string, method: string, args: unknown = {}) => ({ type: "commentor-parent-request", requestId, method, args });

describe("parent compatibility and recovery", () => {
  it("tells the reader to reload when the parent speaks another protocol, and recovers when it matches", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.openDrawer();
    await lab.tid("commentor-comment-btn").click();
    await parentReady(lab, { protocolVersion: 1, canReloadViewer: true });
    const notice = lab.ui.locator(".content-list .empty");
    await expect.poll(() => notice.locator("p").first().innerText()).toBe("Comments were updated. Reload the page to continue.");
    expect(await notice.getAttribute("role")).toBe("status");
    expect(await lab.tid("commentor-comment-btn").isDisabled()).toBe(true);
    expect(await lab.pins().count()).toBe(0);
    await notice.getByRole("button", { name: "Show reload notice" }).click();
    await expect.poll(() => lab.page.locator("#viewer-update-notice").isVisible()).toBe(true);
    expect(await lab.page.locator("#viewer-update-notice [role=status]").innerText()).toBe("Reload this document to continue.");
    // The parent never navigates on a publisher-controlled request.
    expect(await lab.page.evaluate(() => location.pathname)).toBe("/r/acme/docs");
    await parentReady(lab, { protocolVersion: 1, canReloadViewer: false });
    await expect.poll(() => notice.locator("p").last().innerText()).toBe("Use your browser’s Reload button to reload the full page.");
    expect(await notice.getByRole("button").count()).toBe(0);
    await parentReady(lab, { protocolVersion: 2, parentGeneration: "compatible-again", canReloadViewer: true, userId: "user-a", canWrite: true });
    await expect.poll(() => lab.pins().count()).toBe(1);
    expect(await lab.tid("commentor-comment-btn").isDisabled()).toBe(false);
  });

  it("reports an unknown outcome, without replaying, when the parent is replaced during a post or reply", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.host(l => { l.holds = ["reply.add", "thread.create"]; });
    await lab.pins().first().click();
    const bubble = lab.tid("commentor-thread-bubble");
    await bubble.locator('[data-testid="commentor-reply-input"]').fill("In flight");
    await bubble.locator('[data-testid="commentor-reply-send"]').click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    await parentReady(lab, { protocolVersion: 2, parentGeneration: "replacement-1", userId: "user-a", canWrite: true });
    await expect.poll(() => alert(lab).innerText()).toContain("The outcome is unknown; your change may still be saved.");
    expect(await bubble.locator('[data-testid="commentor-reply-input"]').inputValue()).toBe("In flight");
    expect(await bubble.locator('[data-testid="commentor-reply-send"]').isDisabled()).toBe(false);
    await lab.page.keyboard.press("Escape");
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill("New thread in flight");
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(2);
    await parentReady(lab, { protocolVersion: 2, parentGeneration: "replacement-2", userId: "user-a", canWrite: true });
    await expect.poll(() => lab.ui.locator('.toast[role="alert"]').last().innerText()).toContain("The outcome is unknown");
    expect(await lab.tid("commentor-composer-textarea").inputValue()).toBe("New thread in flight");
    expect((await lab.calls).filter(call => call.method === "thread.create")).toHaveLength(1);
  });

  it("offers the selection chip when write access arrives after a selection, and retracts it when access is revoked", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    const chip = lab.tid("commentor-selection-action");
    // Write access is granted, a selection opens the chip through the usual path…
    await lab.select("#intro", 4, 15);
    await lab.selectionSettled();
    await expect.poll(() => chip.getAttribute("data-state")).toBe("open");
    // …revoking access retracts the live chip…
    await parentReady(lab, { protocolVersion: 1, canReloadViewer: true });
    await expect.poll(() => chip.getAttribute("data-state")).toBe("closed");
    // …and access arriving later re-reads the still-held selection without a new selectionchange,
    // even though scheduleSelectionAction had dropped that selection while unwritable.
    await parentReady(lab, { protocolVersion: 2, parentGeneration: "compatible-again", canReloadViewer: true, userId: "user-a", canWrite: true });
    await lab.selectionSettled();
    await expect.poll(() => chip.getAttribute("data-state")).toBe("open");
    expect(await chip.evaluate(el => (el as HTMLElement).hidden)).toBe(false);
    // Without write access a fresh selection must not offer an unwritable comment…
    await parentReady(lab, { protocolVersion: 1, canReloadViewer: true });
    await lab.select("#intro", 10, 15);
    await lab.selectionSettled();
    await expect.poll(() => chip.getAttribute("data-state")).toBe("closed");
    // …and is again picked up when access returns; the chip stays usable.
    await parentReady(lab, { protocolVersion: 2, parentGeneration: "compatible-twice", canReloadViewer: true, userId: "user-a", canWrite: true });
    await lab.selectionSettled();
    await expect.poll(() => chip.getAttribute("data-state")).toBe("open");
    await chip.click();
    await expect.poll(() => lab.tid("commentor-composer-textarea").count()).toBe(1);
  });

  it("leaves the retracted chip retracted when a compatibility message repeats the same access", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    const chip = lab.tid("commentor-selection-action");
    await lab.select("#intro", 4, 15);
    await lab.selectionSettled();
    await expect.poll(() => chip.getAttribute("data-state")).toBe("open");
    await lab.doc(() => window.dispatchEvent(new Event("scroll")));
    await lab.tick();
    // A repeat of an already-known access level must not resurrect the retracted chip.
    await parentReady(lab, { protocolVersion: 2, parentGeneration: "same-access-again", canReloadViewer: true, userId: "user-a", canWrite: true });
    await lab.tick();
    expect(await chip.getAttribute("data-state")).toBe("closed");
  });

  it("keeps an unconfirmed post across a reload, reuses its identity on resubmit and settles when the server shows it", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.host(l => { l.holds = ["thread.create"]; });
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill("Unconfirmed");
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    await lab.host(() => { (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow!.location.reload(); });
    await expect.poll(() => alert(lab).innerText()).toContain("The outcome is unknown");
    await expect.poll(() => lab.tid("commentor-composer-textarea").inputValue()).toBe("Unconfirmed");
    // Editing the unconfirmed text is refused; resubmitting it as written is safe.
    await lab.tid("commentor-composer-textarea").fill("Unconfirmed, edited");
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.ui.locator('.toast[role="alert"]').last().innerText()).toBe("Your previous comment is still unconfirmed. Resubmit the original draft before editing it.");
    await lab.host(l => { l.holds = []; });
    await lab.tid("commentor-composer-textarea").fill("Unconfirmed");
    await lab.tid("commentor-composer-post").click();
    // Saved, not just shown as sending (#284).
    await expect.poll(() => lab.ui.locator('[data-testid="commentor-pin"]:not(.is-sending)').count()).toBe(1);
    const creates = (await lab.calls).filter(call => call.method === "thread.create");
    expect(creates).toHaveLength(2);
    expect(creates[1].args.clientOperationId).toBe(creates[0].args.clientOperationId);
    // The abandoned acknowledgement from the first connection cannot retire anything.
    await lab.host(l => l.settle(0));
    const state = await lab.page.evaluate(() => (Object.values(sessionStorage) as string[]).filter(value => value.includes('"operations"')).map(value => JSON.parse(value) as { operations: object; drafts: object }));
    expect(state.every(entry => Object.keys(entry.operations).length === 0 && Object.keys(entry.drafts).length === 0)).toBe(true);
  });

  it("offers Refresh for a slow change, keeps its guard and settles when the result finally arrives", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.pins().first().click();
    await lab.host(l => { l.holds = ["thread.resolve"]; });
    await lab.tid("commentor-resolve-btn").first().click();
    await lab.page.clock.fastForward(60_001);
    const status = lab.ui.locator('.toast[role="status"]');
    await expect.poll(() => status.innerText()).toContain("Still waiting for confirmation. Your change is pending");
    const subscriptions = await lab.host(l => l.subscriptions);
    await status.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => lab.host(l => l.subscriptions)).toBe(subscriptions + 1);
    // The refreshed list keeps the pending action disabled and does not replay it.
    expect(await lab.tid("commentor-thread-bubble").locator('[data-testid="commentor-resolve-btn"]').isDisabled()).toBe(true);
    await lab.host(l => l.settle(0));
    await expect.poll(() => lab.tid("commentor-thread-bubble").locator(".resolved").count()).toBe(1);
    expect((await lab.calls).filter(call => call.method === "thread.resolve")).toHaveLength(1);
    // With the host gone, a refresh times out and says the change is still pending.
    await lab.host(l => { l.holds = ["thread.archive"]; });
    await lab.tid("commentor-thread-bubble").locator('[data-testid="commentor-archive-btn"]').click();
    await lab.page.clock.fastForward(60_001);
    await lab.host(l => l.host!.dispose());
    await lab.ui.locator('.toast:has-text("Still waiting") button').last().click();
    await lab.page.clock.fastForward(10_001);
    await expect.poll(() => alert(lab).innerText()).toBe("Comments could not be refreshed. Still waiting for confirmation.");
  });

  it("starts over for a different signed-in reader", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.openDrawer();
    await lab.pins().first().click();
    await lab.tid("commentor-thread-bubble").locator('[data-testid="commentor-reply-input"]').fill("Private draft");
    await lab.host(l => { l.threads = []; l.host!.setUserId("user-b"); });
    await expect.poll(() => lab.tid("commentor-panel-btn").getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(0);
    expect(await lab.pins().count()).toBe(0);
    expect(await lab.page.evaluate(() => sessionStorage.getItem("commentor-recovery-user"))).toBe("user-b");
    expect(await lab.page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("commentor-operations:")))).toEqual([]);
  });

  it("lets a reader who is not signed in read a repository's comments, but never write", async () => {
    const lab = await commentLab.open({ user: "" });
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    expect(await lab.tid("commentor-comment-btn").isDisabled()).toBe(true);
    await lab.select("#intro", 4, 15);
    await lab.selectionSettled();
    expect(await lab.tid("commentor-selection-action").getAttribute("data-state")).toBe("closed");
    expect(await lab.calls).toEqual([]);
  });
});

describe("parent hardening", () => {
  it("answers only well-formed, in-scope requests from its own document frame", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    const before = (await lab.calls).length;
    await publisherSends(lab, [
      "plain text", null, 42, { type: "something-else" },
      request("", "thread.remove"), request("x".repeat(161), "thread.remove"), request("unknown-method", "database.drop"),
      { type: "commentor-parent-request", requestId: 7, method: "subscribe", args: {} },
      request("other-doc", "subscribe", { documentPath: "other.html" }),
      request("foreign-thread", "thread.resolve", { threadId: "someone-elses-thread", resolved: true }),
      request("bad-body", "thread.create", { body: "x".repeat(10_001), anchor: heading }),
      request("bad-anchor", "thread.create", { body: "ok", anchor: { kind: "element", path: ["main"] } }),
      request("bad-reply", "reply.add", { threadId: "t1", body: "   " }),
      request("bad-draft", "draft.save", { key: "not-a-thread", draft: { body: "x" } }),
      request("bad-key", "operation.complete", { key: "k".repeat(300), clientOperationId: "id" }),
      request("more-replies", "replies.more", { threadId: "someone-elses-thread" }),
    ]);
    await expect.poll(async () => (await responses(lab) as Array<{ requestId: string }>).length).toBe(8);
    const byId = Object.fromEntries((await responses(lab) as Array<{ requestId: string; ok: boolean; error?: string; rejected?: boolean }>).map(response => [response.requestId, response]));
    expect(byId["other-doc"]).toMatchObject({ ok: false, error: "Comment scope is unavailable" });
    for (const id of ["foreign-thread", "bad-body", "bad-anchor", "bad-reply", "more-replies"]) {
      expect(byId[id], id).toMatchObject({ ok: false, error: "Comment operation is outside this document", rejected: true });
    }
    for (const id of ["bad-draft", "bad-key"]) expect(byId[id], id).toMatchObject({ ok: false, error: "Comment recovery state could not be saved" });
    expect((await lab.calls).length).toBe(before);
    expect(await lab.host(l => l.threads.map(thread => thread._id))).toEqual(["t1"]);
  });

  it("ignores messages from windows other than its document frame and requests before a subscription", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    // Another window (here the shell itself) cannot speak for the document.
    await lab.host(() => { window.postMessage({ type: "commentor-parent-request", requestId: "outsider", method: "thread.remove", args: { threadId: "t1" } }, "*"); });
    await lab.host(() => { window.postMessage({ type: "commentor-viewer-reload" }, "*"); });
    expect(await lab.page.locator("#viewer-update-notice").isHidden()).toBe(true);
    // A publisher "reload" request only raises the parent's own notice.
    await publisherSends(lab, [{ type: "commentor-viewer-reload" }]);
    await expect.poll(() => lab.page.locator("#viewer-update-notice").isVisible()).toBe(true);
    // After a navigation the previous subscription is gone and writes are refused until it is renewed.
    await lab.host(() => { (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow!.postMessage({ type: "commentor-parent-ready", protocolVersion: 2, parentGeneration: "other-generation", userId: "user-a" }, "*"); });
    expect((await lab.calls).filter(call => call.method === "thread.remove")).toHaveLength(0);
  });

  it("bounds how fast a document can drive subscriptions and writes", async () => {
    const lab = await commentLab.open();
    const threads = Array.from({ length: 25 }, (_, index) => ({ _id: `t${index}`, anchor: heading }));
    await lab.ready(threads);
    await publisherSends(lab, Array.from({ length: 40 }, (_, index) => request(`sub-${index}`, "subscribe", { documentPath: "index.html" })));
    await expect.poll(() => lab.host(l => l.subscriptions)).toBeGreaterThanOrEqual(15);
    expect(await lab.host(l => l.subscriptions)).toBeLessThan(25);
    // Restore a fresh host with a full budget, then exceed the cap on writes held open by the backend.
    const fresh = await commentLab.open();
    await fresh.ready(threads);
    await fresh.host(l => { l.holds = ["thread.resolve"]; });
    await publisherSends(fresh, threads.map((thread, index) => request(`resolve-${index}`, "thread.resolve", { threadId: thread._id, resolved: true, clientOperationId: `op-${index}` })));
    await expect.poll(() => fresh.host(l => l.held.length)).toBeGreaterThanOrEqual(10);
    expect(await fresh.host(l => l.held.length)).toBeLessThanOrEqual(20);
  });

  it("drops results that arrive after the document navigated away, and serves the next document's scope", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.host(l => { l.holds = ["thread.resolve"]; });
    await lab.pins().first().click();
    await lab.tid("commentor-thread-bubble").locator('[data-testid="commentor-resolve-btn"]').click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    await lab.host(() => { (document.getElementById("content-frame") as HTMLIFrameElement).src = "/r/acme/docs/files/other.html"; });
    await expect.poll(() => lab.doc(() => location.pathname)).toMatch(/other\.html$/);
    await lab.host(l => l.settle(0));
    // The operation stays recorded for a safe retry instead of being retired by a stale acknowledgement.
    const operations = await lab.page.evaluate(() => (Object.values(sessionStorage) as string[]).flatMap(value => value.includes('"operations"') ? [Object.keys((JSON.parse(value) as { operations: object }).operations).length] : []));
    expect(operations.some(count => count === 1)).toBe(true);
    await expect.poll(() => lab.host(l => l.subscriptions)).toBeGreaterThanOrEqual(2);
    await lab.ui.locator('[data-testid="commentor-dock"]').waitFor({ state: "attached" });
    expect(await lab.doc(() => document.querySelector("h1")?.textContent)).toBe("Quarterly report");
  });

  it("stops serving and releases its subscriptions when torn down", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.openDrawer();
    await lab.host(l => { l.olderReplies = { t1: [] }; });
    const unsubscribed = await lab.host(l => l.unsubscribed);
    await lab.host(l => l.host!.dispose());
    expect(await lab.host(l => l.unsubscribed)).toBe(unsubscribed + 1);
    await publisherSends(lab, [request("after-dispose", "subscribe", { documentPath: "index.html" })]);
    expect(await responses(lab)).toEqual([]);
  });

  it("releases a thread's reply subscription when the thread leaves, and ignores late reply pages for it", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, repliesHasMore: true }, { _id: "t2", anchor: heading }]);
    await lab.host(l => { l.olderReplies = { t1: [l.reply({ _id: "old", body: "Old" })] }; });
    await lab.openDrawer();
    await lab.ui.locator('.drawer-thread[data-thread-id="t1"] [data-testid="commentor-load-older-replies"]').click();
    await expect.poll(() => lab.host(l => l.replySubscriptions())).toBe(1);
    await lab.host(l => { const late = l.reply({ body: "Late page" }); l.threads = l.threads.filter(thread => thread._id !== "t1"); l.publish(); l.publishReplies("t1", [late]); });
    await expect.poll(() => lab.host(l => l.replySubscriptions())).toBe(0);
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(1);
    expect(await lab.ui.locator(".drawer-thread").innerText()).not.toContain("Late page");
  });
});
