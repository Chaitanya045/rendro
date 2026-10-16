import { beforeAll, describe, expect, it } from "vitest";
import { defaultDocument, docPath, useCommentLab } from "./helpers/comment-lab";

const commentLab = useCommentLab();
beforeAll(() => commentLab.start());

const heading = { kind: "element", path: ["main", "h1"] };
const richDocument = defaultDocument.replace('<ul id="list">', `<div id="box" style="width:120px;height:40px;background:#ddd"></div>
<span id="ghost" style="font-size:0">ghost</span><p id="invisible" style="visibility:hidden">Hidden words</p>
<svg width="120" height="30"><text id="svgtext" x="0" y="20">Chart label</text></svg><ul id="list">`)
  .replace("</body>", '<script>const second=document.getElementById("second");second.insertBefore(document.createTextNode(""),second.lastChild)</script></body>');

describe("anchor shapes", () => {
  it("labels, orders and highlights anchors of every shape without inventing rectangles", async () => {
    const lab = await commentLab.open({ document: richDocument });
    const now = Date.now();
    await lab.ready([
      { _id: "box", anchor: { kind: "element", path: ["main", "#box"] }, _creationTime: now - 5_000 },
      { _id: "svg", anchor: { kind: "element", path: ["main", "svg", "text"] }, _creationTime: now - 90_000 },
      { _id: "hidden", anchor: { kind: "element", path: ["main", "#invisible"] }, _creationTime: now - 3 * 3_600_000 },
      { _id: "ghost", anchor: { kind: "text-range", quote: "ghost", path: ["main", "#ghost"], startOffset: 0, endOffset: 5 }, _creationTime: now - 2 * 86_400_000 },
      { _id: "partial", anchor: { kind: "text-range", quote: "bold paragraph", path: ["main", "#second"], startOffset: 0, endOffset: 0 } },
      { _id: "nopath", anchor: { kind: "element", path: [] } },
    ]);
    await lab.openDrawer();
    const card = (id: string) => lab.ui.locator(`.drawer-thread[data-thread-id="${id}"]`);
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(6);
    // Oldest first, each with a compact age.
    expect(await lab.ui.locator(".drawer-thread").evaluateAll(cards => cards.map(item => item.getAttribute("data-thread-id")))).toEqual(["ghost", "hidden", "svg", "partial", "nopath", "box"]);
    const ages = await lab.ui.locator(".drawer-thread .when").allInnerTexts();
    // Seconds drift with a loaded host; the coarser units have wide margins.
    expect(ages.slice(0, 5)).toEqual(["2d", "3h", "2m", "1m", "1m"]);
    expect(ages[5]).toMatch(/^([5-9]|[1-3]\d)s$/);
    expect(await card("box").locator(".locate-link").innerText()).toBe("Locate element");
    expect(await card("hidden").locator(".locate-link").count()).toBe(1);
    expect(await card("svg").locator(".quote-text").innerText()).toBe("Chart label");
    expect(await card("partial").locator(".quote-text").innerText()).toBe("bold paragraph");
    expect(await card("ghost").evaluate(item => item.classList.contains("is-orphan"))).toBe(true);
    expect(await card("nopath").evaluate(item => item.classList.contains("is-orphan"))).toBe(true);
    // A text anchor with a zero-size layout box and an element with no text still highlight sensibly.
    const segments = (id: string) => card(id).hover().then(() => lab.ui.locator(".anchor-highlight-segment").evaluateAll(all => all.map(segment => [(segment as HTMLElement).style.width, (segment as HTMLElement).style.height])));
    expect(await segments("box")).toEqual([["126px", "46px"]]);
    expect((await segments("partial")).length).toBe(1);
    expect(await segments("ghost")).toEqual([]);
    expect(await segments("svg")).toHaveLength(1);
    // Composer labels mirror the same shapes.
    await lab.tid("commentor-panel-btn").click();
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("box")!.click());
    expect(await lab.tid("commentor-composer").locator(".anchor-label").innerText()).toBe("On: element");
  });

  it("finds a commented quote even when its path is stale, falling back to the whole page", async () => {
    const lab = await commentLab.open({ document: defaultDocument.replace(/<main>|<\/main>/g, "\n  ") });
    await lab.ready([{ _id: "stale", anchor: { kind: "text-range", quote: "Footer\ntext", path: ["main", "gone"], startOffset: 0, endOffset: 11 } }]);
    await lab.openDrawer();
    await lab.ui.locator(".drawer-thread .quote").click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("stale");
    expect(await lab.doc(() => window.scrollY)).toBeGreaterThan(500);
  });

  it("keeps tall bubbles on screen when there is room neither above nor below", async () => {
    const lab = await commentLab.open({ height: 320 });
    const replies = Array.from({ length: 3 }, (_, index) => ({ _id: `r${index}`, _creationTime: Date.now(), authorName: "Grace", authorEmail: "g@example.test", body: `Reply ${index}`, canDelete: false }));
    await lab.ready([{ _id: "tall", anchor: { kind: "element", path: ["main", "#second"] }, body: "A tall thread", replies }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.pins().first().click();
    const box = await lab.tid("commentor-thread-bubble").boundingBox();
    // Too tall to fit anywhere, it is pinned to the top margin rather than pushed off screen.
    expect(box!.height).toBeGreaterThan(320 - 16);
    expect(box!.y).toBe(8);
  });

  it("opens above the anchor when only the space above fits", async () => {
    const lab = await commentLab.open({ height: 700 });
    await lab.ready([{ _id: "low", anchor: { kind: "element", path: ["main", "#footer"] } }]);
    await lab.doc(() => { const footer = document.getElementById("footer")!; footer.scrollIntoView(); window.scrollBy(0, 560); });
    await expect.poll(() => lab.pins().first().evaluate(pin => (pin as HTMLElement).style.display)).toBe("");
    await lab.pins().first().click();
    const pin = (await lab.pins().first().boundingBox())!;
    const bubble = (await lab.tid("commentor-thread-bubble").boundingBox())!;
    expect(bubble.y + bubble.height).toBeLessThanOrEqual(pin.y + 1);
  });
});

describe("authoring edge cases", () => {
  it("refuses a second post while one is unconfirmed and keeps the countdown dismissible and recoverable", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready();
    await lab.host(l => { l.holds = ["thread.create"]; });
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill("First");
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("second")!.click());
    await expect.poll(() => lab.ui.locator('.toast[role="status"]').innerText()).toBe("Still waiting for confirmation of your comment.");
    await lab.host(l => { l.holds = []; l.settle(0, { kind: "quota", retryAfter: 5000 }); });
    const quota = lab.ui.locator(".comment-quota");
    await expect.poll(() => quota.innerText()).toContain("try again in 5 seconds");
    await quota.getByRole("button", { name: "Dismiss" }).click();
    expect(await quota.isHidden()).toBe(true);
    await expect.poll(() => lab.focused()).toBe("commentor-composer-textarea");
    await lab.page.keyboard.press("Enter");
    await expect.poll(() => quota.isVisible()).toBe(true);
    expect((await lab.calls).filter(call => call.method === "thread.create")).toHaveLength(1);
    // Just after the quota ends but before the control refreshes, Enter is still held back.
    await lab.page.clock.setSystemTime(Date.now() + 6_000);
    await lab.page.keyboard.press("Enter");
    expect((await lab.calls).filter(call => call.method === "thread.create")).toHaveLength(1);
    await lab.page.clock.fastForward(1_000);
    await expect.poll(() => lab.tid("commentor-composer-post").isDisabled()).toBe(false);
    await lab.page.keyboard.press("Enter");
    await expect.poll(() => lab.pins().count()).toBe(1);
  });

  it("does not reopen a saved draft for a read-only document", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill("Saved while writable");
    await expect.poll(() => lab.page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("commentor-operations:")).length)).toBe(1);
    commentLab.setCanWrite(false);
    await lab.host(() => { (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow!.location.reload(); });
    await expect.poll(() => lab.tid("commentor-comment-btn").isDisabled()).toBe(true);
    await expect.poll(() => lab.host(l => l.subscriptions)).toBeGreaterThanOrEqual(2);
    expect(await lab.tid("commentor-composer").count()).toBe(0);
    commentLab.setCanWrite(true);
  });

  it("offers selection comments only for real, visible text outside the widget", async () => {
    const lab = await commentLab.open({ document: richDocument });
    await lab.page.clock.install();
    await lab.ready();
    const action = lab.tid("commentor-selection-action");
    // A selection of the whole document has no element ancestor, and zero-size text is not commentable.
    await lab.doc(() => { window.focus(); const range = document.createRange(); range.selectNode(document.documentElement); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
    await lab.tick();
    await lab.page.clock.runFor(100);
    expect(await action.getAttribute("data-state")).toBe("closed");
    await lab.doc(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById("ghost")!); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
    await lab.tick();
    await lab.page.clock.runFor(100);
    expect(await action.getAttribute("data-state")).toBe("closed");
    // Reselecting during the fade-out keeps the control visible instead of hiding it afterwards.
    await lab.select("#intro", 0, 5);
    await lab.tick();
    await lab.page.clock.runFor(100);
    expect(await action.getAttribute("data-state")).toBe("open");
    await lab.page.keyboard.press("Escape");
    expect(await action.getAttribute("data-state")).toBe("closed");
    await lab.doc(() => { const range = document.createRange(); const text = document.getElementById("intro")!.firstChild!; range.setStart(text, 1); range.setEnd(text, 6); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
    await lab.tick();
    await lab.page.clock.runFor(40);
    expect(await action.getAttribute("data-state")).toBe("open");
    await lab.page.clock.runFor(200);
    expect(await action.evaluate(el => (el as HTMLElement).hidden)).toBe(false);
  });
});

describe("live updates", () => {
  it("keeps reply focus and caret in the drawer across updates, drops it when the thread leaves and closes the open bubble", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }, { _id: "t2", anchor: heading }]);
    await lab.openDrawer();
    const input = lab.ui.locator('.drawer-thread[data-thread-id="t1"] [data-testid="commentor-reply-input"]');
    await input.fill("caret test");
    await input.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(2, 5); });
    await lab.host(l => l.publish());
    await expect.poll(() => lab.ui.locator('[data-testid="commentor-reply-input"]:focus').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([2, 5]);
    await input.evaluate((el: HTMLTextAreaElement) => el.focus());
    await lab.host(l => { l.threads = l.threads.filter(thread => thread._id !== "t1"); l.publish(); });
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(1);
    await lab.pins().first().click();
    await lab.host(l => { l.threads = []; l.publish(); });
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(0);
  });

  it("keeps a thread hidden while its deletion is pending, even if another update arrives", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready([{ _id: "t1", anchor: heading }, { _id: "t2", anchor: heading }]);
    await lab.openDrawer();
    await lab.ui.locator('.drawer-thread[data-thread-id="t1"] [data-testid="commentor-delete-btn"]').click();
    await lab.host(l => l.publish());
    expect(await lab.ui.locator(".drawer-thread").count()).toBe(1);
    await lab.page.clock.fastForward(5_000);
    await expect.poll(() => lab.host(l => l.threads.map(thread => thread._id))).toEqual(["t2"]);
  });

  it("shows a first page that arrives still loading, and reply pages as they stream in", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.host(l => {
      l.replyLoading = true;
      l.pagination = { canLoadMore: true, loading: true };
      l.threads = [l.thread({ _id: "t1", anchor: { kind: "element", path: ["main", "h1"] }, repliesHasMore: true })];
      l.olderReplies = { t1: [l.reply({ _id: "old", body: "Older reply" })] };
      (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow!.location.reload();
    });
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.openDrawer();
    expect(await lab.tid("commentor-load-older-threads").innerText()).toBe("Loading older comments…");
    await lab.host(l => { l.pagination = { canLoadMore: false, loading: false }; l.publish(); });
    await lab.ui.locator('[data-testid="commentor-load-older-replies"]').click();
    await expect.poll(() => lab.host(l => l.replySubscriptions())).toBe(1);
    // The first reply page arrives empty and still loading: the reader keeps what they have.
    await expect.poll(() => lab.ui.locator('.drawer-thread [data-testid="commentor-load-older-replies"]').innerText()).toBe("Loading older replies…");
    await lab.host(l => { l.replyLoading = false; l.publishReplies("t1", [], true, true); });
    expect(await lab.ui.locator('.drawer-thread [data-testid="commentor-load-older-replies"]').innerText()).toBe("Loading older replies…");
    await lab.host(l => l.publishReplies("t1", [l.reply({ body: "Streamed reply" })], false, false));
    await expect.poll(() => lab.ui.locator(".drawer-thread .reply").allInnerTexts()).toEqual([expect.stringContaining("Streamed reply")]);
    await lab.host(l => l.publishReplies("t1", [l.reply({ body: "Settled reply" })], false, false));
    await expect.poll(() => lab.ui.locator(".drawer-thread .reply").allInnerTexts()).toEqual([expect.stringContaining("Settled reply")]);
  });

  it("repositions pins and an open bubble on bursts of scroll events", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: { kind: "element", path: ["main", "#second"] } }]);
    await lab.pins().first().click();
    await lab.tid("commentor-thread-bubble").locator('[data-testid="commentor-resolve-btn"]').click();
    await expect.poll(() => lab.pins().count()).toBe(0);
    // The resolved thread's bubble stays open with no pin to follow.
    await lab.doc(() => { window.dispatchEvent(new Event("scroll")); window.dispatchEvent(new Event("scroll")); window.scrollBy(0, 5); });
    await lab.doc(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await lab.tid("commentor-thread-bubble").count()).toBe(1);
  });
});

describe("dock input edge cases", () => {
  it("moves along a vertical edge with the keyboard and survives overlapping pointer drags", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.page.evaluate(() => { localStorage.setItem("commentor-dock", "right"); localStorage.setItem("commentor-dock-offset", "200"); });
    await lab.page.reload();
    await lab.ready();
    const dock = lab.tid("commentor-dock");
    const top = () => dock.evaluate(el => parseFloat((el as HTMLElement).style.top));
    const grip = lab.tid("commentor-toolbar-grip");
    await grip.focus();
    await lab.page.keyboard.press("ArrowUp");
    expect(await top()).toBe(176);
    await lab.page.keyboard.press("ArrowRight");
    await lab.page.keyboard.press("ArrowDown");
    expect(await top()).toBe(200);
    await lab.page.keyboard.press("Home");
    expect(await top()).toBe(16);
    await lab.page.keyboard.press("End");
    const height = await dock.evaluate(el => (el as HTMLElement).offsetHeight);
    expect(await top()).toBe(800 - height - 16);
    // A second pointer pressing while one is dragging does not strand the first pointer's listeners.
    await grip.evaluate(el => {
      const down = (pointerId: number) => el.dispatchEvent(new PointerEvent("pointerdown", { pointerId, button: 0, bubbles: true, clientX: 10, clientY: 10 }));
      down(1);
      down(2);
      document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2 }));
      document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 50, clientY: 50 }));
      document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });
    expect(await dock.getAttribute("class")).not.toContain("dragging");
  });

  it("lets nothing through a disabled Comment control and ignores a stray activation", async () => {
    const lab = await commentLab.open({ canWrite: false });
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.tid("commentor-comment-btn").evaluate(el => (el as HTMLButtonElement).click());
    await lab.tid("commentor-comment-btn").evaluate(el => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(await lab.tid("commentor-comment-hint").count()).toBe(0);
    expect(await lab.tid("commentor-composer").count()).toBe(0);
  });

  it("starts without a parent shell and stays inert until one speaks", async () => {
    const lab = await commentLab.open();
    const page = await commentLab.harness.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(`${commentLab.harness.origin}${docPath}`);
    const dock = page.locator('[data-testid="commentor-dock"]');
    await dock.waitFor({ state: "attached" });
    expect(await page.locator('[data-testid="commentor-comment-btn"]').isDisabled()).toBe(true);
    expect(await page.locator('[data-testid="commentor-pin"]').count()).toBe(0);
    await lab.page.close();
    await page.close();
  });
});

describe("starting up", () => {
  it.each([
    { name: "no configuration", config: null },
    { name: "no document scope", config: { documentPath: "index.html", transport: "parent" } },
    { name: "no file for a direct legacy client", config: { convexUrl: "http://unused.test", orgSlug: "example" } },
  ])("reports $name instead of starting", async ({ config }) => {
    commentLab.setConfig(config);
    try {
      const messages: string[] = [];
      const page = await commentLab.harness.newPage({ viewport: { width: 800, height: 600 } });
      page.on("console", message => { if (message.type() === "error") messages.push(message.text()); });
      await page.goto(`${commentLab.harness.origin}${docPath}`);
      await expect.poll(() => messages).toEqual(["[commentor] not started — configure a legacy organization/file or project document scope"]);
      expect(await page.locator("#commentor-host").count()).toBe(0);
    } finally {
      commentLab.setConfig(undefined);
    }
  });

  it("starts from a script that runs while the page is still loading", async () => {
    commentLab.setDeferred(false);
    try {
      const lab = await commentLab.open();
      await lab.ready([{ _id: "t1", anchor: heading }]);
      await expect.poll(() => lab.pins().count()).toBe(1);
    } finally {
      commentLab.setDeferred(true);
    }
  });
});

describe("ordering of acknowledgements and snapshots", () => {
  it("clears a sent reply when its acknowledgement beats the snapshot, and ignores a repeated delete", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    await lab.host(l => { l.publishOnMutate = false; });
    const card = lab.ui.locator('.drawer-thread[data-thread-id="t1"]');
    await card.locator('[data-testid="commentor-reply-input"]').fill("Ack first");
    await card.locator('[data-testid="commentor-reply-send"]').click();
    await expect.poll(async () => (await lab.calls).length).toBe(1);
    await expect.poll(() => card.locator('[data-testid="commentor-reply-input"]').inputValue()).toBe("");
    expect(await card.locator(".reply").count()).toBe(0);
    await lab.host(l => l.publish());
    await expect.poll(() => card.locator(".reply").count()).toBe(1);
    await lab.page.clock.install();
    await card.locator('[data-testid="commentor-delete-btn"]').evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    expect(await lab.ui.locator(".toast", { hasText: "Comment deleted." }).count()).toBe(1);
  });

  it("opens a located thread once when the scroll end and the fallback timer both fire", async () => {
    const lab = await commentLab.open({ motion: "no-preference" });
    await lab.page.clock.install();
    await lab.ready([{ _id: "far", anchor: { kind: "element", path: ["main", "#footer"] } }]);
    await lab.openDrawer();
    await lab.ui.locator(".drawer-thread .body").click();
    await lab.doc(() => window.dispatchEvent(new Event("scrollend")));
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(1);
    await lab.page.clock.runFor(500);
    expect(await lab.tid("commentor-thread-bubble").count()).toBe(1);
  });

  it("keeps the selection control when a fast scroll hides it just before it finishes appearing", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready();
    await lab.doc(() => {
      const queue: FrameRequestCallback[] = [];
      Object.assign(window, { frames: queue, requestAnimationFrame: (callback: FrameRequestCallback) => queue.push(callback) });
    });
    const runFrame = () => lab.doc(() => (window as unknown as { frames: FrameRequestCallback[] }).frames.splice(0).forEach(callback => callback(0)));
    await lab.select("#intro", 0, 5);
    await lab.tick();
    await runFrame();
    await lab.doc(() => window.dispatchEvent(new Event("scroll")));
    await runFrame();
    await lab.page.clock.runFor(300);
    expect(await lab.tid("commentor-selection-action").getAttribute("data-state")).toBe("open");
  });
});
