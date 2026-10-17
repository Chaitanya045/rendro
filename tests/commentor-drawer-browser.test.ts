import { beforeAll, describe, expect, it } from "vitest";
import { waitForSettled } from "./helpers/browser";
import { useCommentLab, type Lab } from "./helpers/comment-lab";

const commentLab = useCommentLab();
beforeAll(() => commentLab.start());

const heading = { kind: "element", path: ["main", "h1"] };
const intro = { kind: "text-range", quote: "lazy dog", path: ["main", "p:nth-of-type(1)"], startOffset: 0, endOffset: 8 };
const footer = { kind: "element", path: ["main", "#footer"] };
const dock = (lab: Lab) => lab.tid("commentor-dock");
const dockBox = (lab: Lab) => dock(lab).evaluate(el => ({ left: parseFloat((el as HTMLElement).style.left), top: parseFloat((el as HTMLElement).style.top), className: (el as HTMLElement).className }));
const scrollY = (lab: Lab) => lab.doc(() => Math.round(window.scrollY));

describe("comments drawer", () => {
  it("lists threads by view with live counts, keyboard-navigable tabs and helpful empty states", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "a1", anchor: heading }, { _id: "a2", anchor: intro }, { _id: "r1", anchor: heading, resolved: true }, { _id: "h1", anchor: heading, archived: true }]);
    await expect.poll(() => lab.pins().count()).toBe(2);
    const drawer = lab.tid("commentor-drawer");
    expect(await drawer.getAttribute("aria-hidden")).toBe("true");
    await lab.openDrawer();
    expect(await drawer.getAttribute("aria-hidden")).toBe("false");
    expect(await lab.ui.locator(".count").getAttribute("aria-label")).toBe("2 active comments");
    const tabs = lab.ui.getByRole("tab");
    expect(await tabs.evaluateAll(all => all.map(tab => tab.textContent))).toEqual(["Active2", "Resolved1", "History1"]);
    expect(await tabs.evaluateAll(all => all.map(tab => tab.getAttribute("aria-selected")))).toEqual(["true", "false", "false"]);
    expect(await lab.ui.locator(".drawer-thread").count()).toBe(2);
    await tabs.first().focus();
    await lab.page.keyboard.press("ArrowRight");
    expect(await lab.tid("commentor-drawer-list").getAttribute("aria-label")).toBe("Resolved comments");
    expect(await lab.focused()).toBeNull();
    expect(await lab.doc(() => document.getElementById("commentor-host")!.shadowRoot!.activeElement?.textContent)).toBe("Resolved1");
    // Pins follow the open view: resolved threads are marked while that view is selected.
    await expect.poll(() => lab.pins().evaluateAll(pins => pins.map(pin => pin.classList.contains("resolved")))).toEqual([true]);
    await lab.page.keyboard.press("End");
    expect(await lab.tid("commentor-drawer-list").getAttribute("aria-label")).toBe("History comments");
    expect(await lab.ui.locator(".drawer-thread").count()).toBe(1);
    await lab.page.keyboard.press("ArrowRight");
    expect(await lab.tid("commentor-drawer-list").getAttribute("aria-label")).toBe("Active comments");
    await lab.page.keyboard.press("ArrowLeft");
    expect(await lab.tid("commentor-drawer-list").getAttribute("aria-label")).toBe("History comments");
    await lab.page.keyboard.press("Home");
    expect(await tabs.first().getAttribute("aria-selected")).toBe("true");
    await lab.page.keyboard.press("ArrowDown");
    expect(await tabs.first().getAttribute("aria-selected")).toBe("true");
    await lab.host(l => l.seed([{ _id: "only", anchor: { kind: "element", path: ["main", "h1"] }, resolved: true }]));
    await expect.poll(() => lab.ui.locator(".count").getAttribute("aria-label")).toBe("0 active comments");
    expect(await lab.ui.locator(".empty strong").innerText()).toBe("No active comments");
    await lab.ui.getByRole("tab", { name: /Resolved/ }).click();
    expect(await lab.ui.locator(".drawer-thread").count()).toBe(1);
    await lab.ui.getByRole("tab", { name: /History/ }).click();
    expect(await lab.ui.locator(".empty strong").innerText()).toBe("No archived comments");
    expect(await lab.ui.locator(".empty span").innerText()).toBe("Threads will appear here when their status changes.");
    expect(await lab.ui.locator(".empty button").count()).toBe(0);
    await lab.ui.getByRole("tab", { name: /Active/ }).click();
    expect(await lab.ui.locator(".empty span").innerText()).toBe("Select text to start a discussion.");
    await lab.ui.getByRole("button", { name: "Start a comment" }).click();
    expect(await lab.tid("commentor-panel-btn").getAttribute("aria-expanded")).toBe("false");
    expect(await lab.tid("commentor-comment-btn").getAttribute("aria-pressed")).toBe("true");
    expect(await lab.focused()).toBe("commentor-comment-btn");
    await lab.openDrawer();
    await lab.tid("commentor-panel-btn").click();
    await expect.poll(() => lab.tid("commentor-drawer").getAttribute("aria-hidden")).toBe("true");
    expect(await lab.tid("commentor-drawer").evaluate(el => (el as HTMLElement).inert)).toBe(true);
  });

  it.each([{ motion: "reduce" as const }, { motion: "no-preference" as const }])("scrolls to a thread's anchor and opens it from its card ($motion motion)", async ({ motion }) => {
    const lab = await commentLab.open({ motion });
    await lab.ready([{ _id: "near", anchor: heading, body: "Near" }, { _id: "far", anchor: footer, body: "Far" }]);
    await lab.openDrawer();
    const cards = lab.ui.locator(".drawer-thread");
    await cards.first().locator(".body").click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("near");
    expect(await scrollY(lab)).toBe(0);
    await cards.nth(1).locator(".body").click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("far");
    expect(await scrollY(lab)).toBeGreaterThan(500);
    const footerBox = await lab.doc(() => { const rect = document.getElementById("footer")!.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; });
    expect(footerBox.top).toBeGreaterThanOrEqual(0);
    expect(footerBox.bottom).toBeLessThanOrEqual(800);
    await lab.tid("commentor-thread-bubble").locator(".thread-close").click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(0);
    // Keyboard activation of the focused card, and the locate controls inside it.
    await lab.doc(() => window.scrollTo(0, 0));
    await cards.nth(1).focus();
    await lab.page.keyboard.press("Enter");
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("far");
    await lab.page.keyboard.press("Escape");
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(0);
    await lab.doc(() => window.scrollTo(0, 0));
    await cards.nth(1).focus();
    await lab.page.keyboard.press(" ");
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("far");
    await cards.first().getByRole("button", { name: "Locate commented text on page" }).click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("near");
    if (motion === "reduce") expect(await scrollY(lab)).toBe(0);
  });

  it("highlights a card's anchor while hovered or focused and keeps it for an open thread", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }, { _id: "t2", anchor: intro }]);
    await lab.openDrawer();
    const highlighted = () => lab.ui.locator(".drawer-thread.is-highlighted").evaluateAll(cards => cards.map(card => card.getAttribute("data-thread-id")));
    const cards = lab.ui.locator(".drawer-thread");
    await cards.first().hover();
    await expect.poll(highlighted).toEqual(["t1"]);
    await cards.nth(1).locator("textarea").focus();
    await expect.poll(highlighted).toEqual(["t2"]);
    await lab.page.mouse.move(900, 600);
    await lab.tid("commentor-panel-btn").focus();
    await expect.poll(highlighted).toEqual([]);
    await cards.first().locator(".body").click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(1);
    await cards.first().hover();
    await lab.page.mouse.move(900, 600);
    expect(await highlighted()).toEqual(["t1"]);
  });

  it("pages older threads and replies on demand and says when more cannot be loaded", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.host(l => {
      l.olderThreads = [l.thread({ _id: "old", body: "Older thread", _creationTime: 1 })];
      l.pagination = { canLoadMore: true, loading: false };
      l.seed([{ _id: "t1", anchor: { kind: "element", path: ["main", "h1"] }, repliesHasMore: true, replies: [l.reply({ _id: "newest", body: "Newest reply" })] }]);
      l.olderReplies = { t1: [l.reply({ _id: "oldest", body: "Oldest reply" })] };
    });
    await lab.openDrawer();
    const olderThreads = lab.tid("commentor-load-older-threads");
    expect(await olderThreads.innerText()).toBe("Load older comments");
    await lab.host(l => { l.loadMoreResult = false; });
    await olderThreads.click();
    await expect.poll(() => lab.ui.locator('.toast[role="alert"]').innerText()).toBe("Could not load older comments.");
    expect(await olderThreads.isDisabled()).toBe(false);
    await lab.host(l => { l.loadMoreResult = true; });
    await olderThreads.click();
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(2);
    expect(await lab.tid("commentor-load-older-threads").count()).toBe(0);
    // Replies: the first request subscribes, the second pages further back.
    const olderReplies = lab.ui.locator('.drawer-thread[data-thread-id="t1"] [data-testid="commentor-load-older-replies"]');
    expect(await olderReplies.innerText()).toBe("Load older replies");
    await lab.host(l => { l.loadMoreResult = false; });
    await olderReplies.click();
    await expect.poll(() => olderReplies.isEnabled()).toBe(true);
    await olderReplies.click();
    await expect.poll(() => lab.ui.locator('.toast[role="alert"]').last().innerText()).toBe("Could not load older replies.");
    await lab.host(l => { l.loadMoreResult = true; });
    await olderReplies.click();
    await expect.poll(() => lab.ui.locator('.drawer-thread[data-thread-id="t1"] .reply').allInnerTexts()).toEqual([expect.stringContaining("Oldest reply"), expect.stringContaining("Newest reply")]);
    expect(await olderReplies.count()).toBe(0);
  });

  it("keeps the current list while the next page loads and shows the loading state", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    await lab.host(l => { l.pagination = { canLoadMore: true, loading: true }; l.threads = []; l.publish(); });
    // An empty first page that is still loading must not wipe what the reader sees.
    expect(await lab.ui.locator(".drawer-thread").count()).toBe(1);
    const older = lab.tid("commentor-load-older-threads");
    expect(await older.innerText()).toBe("Loading older comments…");
    expect(await older.isDisabled()).toBe(true);
    expect(await older.getAttribute("aria-busy")).toBe("true");
    await lab.host(l => { l.pagination = { canLoadMore: false, loading: false }; l.threads = [l.thread({ _id: "t1", anchor: { kind: "element", path: ["main", "h1"] } })]; l.publish(); });
    await expect.poll(() => older.count()).toBe(0);
  });

  it("announces comments that arrive while the reader is away from the end of the list", async () => {
    const lab = await commentLab.open({ height: 600 });
    const many = Array.from({ length: 10 }, (_, index) => ({ _id: `t${index}`, body: `Comment ${index}`, anchor: heading }));
    await lab.ready(many);
    await lab.openDrawer();
    const banner = lab.ui.locator(".new-comments");
    expect(await banner.isHidden()).toBe(true);
    await lab.host(l => { l.threads.push(l.thread({ _id: "late" })); l.publish(); });
    await expect.poll(() => banner.innerText()).toBe("1 new comment");
    await lab.host(l => { l.threads.push(l.thread({ _id: "later" })); l.publish(); });
    await expect.poll(() => banner.innerText()).toBe("2 new comments");
    await banner.click();
    await expect.poll(() => banner.isHidden()).toBe(true);
    await expect.poll(() => lab.tid("commentor-drawer-list").evaluate(list => list.scrollTop + list.clientHeight >= list.scrollHeight - 48)).toBe(true);
    // Scrolling to the end by hand dismisses it too.
    await lab.tid("commentor-drawer-list").evaluate(list => { list.scrollTop = 0; });
    await lab.host(l => { l.threads.push(l.thread({ _id: "last" })); l.publish(); });
    await expect.poll(() => banner.innerText()).toBe("1 new comment");
    await lab.tid("commentor-drawer-list").evaluate(list => { list.scrollTop = list.scrollHeight; });
    await expect.poll(() => banner.isHidden()).toBe(true);
    // Closed or on another tab, nothing is announced beyond the count badge.
    await lab.ui.getByRole("tab", { name: /Resolved/ }).click();
    await lab.tid("commentor-drawer-list").evaluate(list => { list.scrollTop = 0; });
    await lab.host(l => { l.threads.push(l.thread({ _id: "unseen" })); l.publish(); });
    await expect.poll(() => lab.ui.locator(".count").innerText()).toBe("14");
    expect(await banner.isHidden()).toBe(true);
  });

  it("sizes itself as a bottom sheet on a narrow screen", async () => {
    const lab = await commentLab.open({ width: 360, height: 640 });
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    expect(await dock(lab).getAttribute("data-compact-sheet")).toBe("");
    await expect.poll(async () => (await dockBox(lab)).left).toBe(16);
    const box = await dock(lab).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    expect(box!.y + box!.height).toBeLessThanOrEqual(640 - 16 + 1);
    await lab.page.setViewportSize({ width: 800, height: 640 });
    await expect.poll(() => dock(lab).getAttribute("data-compact-sheet")).toBeNull();
    await lab.tid("commentor-panel-btn").click();
    await expect.poll(() => dock(lab).getAttribute("data-expanded")).toBeNull();
  });
});

describe("drawer details", () => {
  const panel = (lab: Lab) => lab.tid("commentor-panel-btn");

  it("survives a re-open during the collapse animation, an open-and-close within one frame and a reset mid-animation", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await panel(lab).click();
    await panel(lab).click();
    await panel(lab).click();
    expect(await panel(lab).getAttribute("aria-expanded")).toBe("true");
    await lab.page.clock.runFor(400);
    await lab.doc(() => {
      const button = document.getElementById("commentor-host")!.shadowRoot!.querySelector<HTMLButtonElement>('[data-testid="commentor-panel-btn"]')!;
      button.click();
      button.click();
      button.click();
    });
    await lab.page.clock.runFor(100);
    expect(await panel(lab).getAttribute("aria-expanded")).toBe("false");
    await panel(lab).click();
    await panel(lab).click();
    // Let the collapse finish on the clock first: whether a reset beats the timer must not decide that it runs.
    await lab.page.clock.runFor(400);
    await expect.poll(() => lab.tid("commentor-drawer").evaluate(el => (el as HTMLElement).style.height)).toBe("");
    await panel(lab).click();
    await panel(lab).click();
    await expect.poll(() => lab.tid("commentor-drawer").evaluate(el => (el as HTMLElement).style.height)).toBe("0px");
    await lab.host(l => l.host!.setUserId("user-b"));
    // The reset collapses at once, without waiting for the pending animation timer.
    await expect.poll(() => lab.tid("commentor-drawer").evaluate(el => (el as HTMLElement).style.height)).toBe("");
    await lab.page.clock.runFor(400);
    expect(await panel(lab).getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores controls inside a card when the card itself is activated, and ignores a card whose thread moved on before it opened", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    const card = lab.ui.locator(".drawer-thread").first();
    await card.locator('[data-testid="commentor-reply-input"]').click();
    expect(await lab.tid("commentor-thread-bubble").count()).toBe(0);
    // Hold animation frames so the reveal can be overtaken by a live update.
    await lab.doc(() => {
      const queue: FrameRequestCallback[] = [];
      Object.assign(window, { frames: queue, requestAnimationFrame: (callback: FrameRequestCallback) => queue.push(callback) });
    });
    await card.locator(".body").click();
    await lab.host(l => { l.threads[0].resolved = true; l.publish(); });
    await expect.poll(() => lab.pins().count()).toBe(0);
    await lab.doc(() => { const queue = (window as unknown as { frames: FrameRequestCallback[] }).frames; for (const callback of queue.splice(0)) callback(0); });
    expect(await lab.tid("commentor-thread-bubble").count()).toBe(0);
  });

  it("opens a thread even when the page cannot be scrolled or measured the usual way", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "far", anchor: { kind: "element", path: ["main", "#footer"] } }, { _id: "tall", anchor: { kind: "element", path: ["main", "div"] } }]);
    await lab.openDrawer();
    const cards = lab.ui.locator(".drawer-thread");
    // The tall spacer is centred already: nothing to scroll even though it is partly off screen.
    await lab.doc(() => { const spacer = document.querySelector("main > div")!.getBoundingClientRect(); window.scrollTo(0, window.scrollY + spacer.top + spacer.height / 2 - 400); });
    const before = await scrollY(lab);
    await cards.nth(1).locator(".body").click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("tall");
    expect(await scrollY(lab)).toBe(before);
    // No scrolling element at all: the thread still opens where it is.
    await lab.doc(() => { Object.defineProperty(document, "scrollingElement", { value: null, configurable: true }); window.scrollTo(0, 0); });
    await cards.nth(0).locator(".body").click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("far");
    expect(await scrollY(lab)).toBe(0);
    // A zero client height falls back to the window height.
    await lab.doc(() => { Object.defineProperty(document, "scrollingElement", { value: document.documentElement, configurable: true }); Object.defineProperty(document.documentElement, "clientHeight", { value: 0, configurable: true }); });
    await cards.nth(0).locator(".body").click();
    await expect.poll(() => scrollY(lab)).toBeGreaterThan(500);
  });

  it.each([{ motion: "reduce" as const }, { motion: "no-preference" as const }])("does not announce arrivals when the list is short, and scrolls to the newest on request ($motion motion)", async ({ motion }) => {
    const lab = await commentLab.open({ motion, canWrite: false });
    await lab.ready([{ _id: "t0", anchor: heading }]);
    await lab.openDrawer();
    await waitForSettled(lab.frame);
    await lab.host(l => { l.threads.push(l.thread({ _id: "t1" })); l.publish(); });
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(2);
    // With animation the panel is still growing when the arrival is measured, so only the settled case is exact.
    if (motion === "reduce") expect(await lab.ui.locator(".new-comments").getAttribute("hidden")).not.toBeNull();
    await lab.host(l => { for (let index = 2; index < 12; index++) l.threads.push(l.thread({ _id: `t${index}` })); l.publish(); });
    await lab.tid("commentor-drawer-list").evaluate(list => { list.scrollTop = 0; });
    await lab.host(l => { l.threads.push(l.thread({ _id: "newest" })); l.publish(); });
    await lab.ui.locator(".new-comments").click();
    await expect.poll(() => lab.tid("commentor-drawer-list").evaluate(list => list.scrollTop + list.clientHeight >= list.scrollHeight - 48)).toBe(true);
  });

  it("skips a tooltip whose target left the screen, and restores a description it replaced", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    const tip = lab.tid("commentor-tip");
    await lab.pins().first().hover();
    await lab.pins().first().evaluate(pin => { (pin as HTMLElement).style.top = "-500px"; });
    await lab.page.clock.runFor(200);
    expect(await tip.getAttribute("data-state")).toBe("closed");
    const button = lab.tid("commentor-comment-btn");
    await button.evaluate(el => el.setAttribute("aria-describedby", "existing-note"));
    await button.hover();
    await lab.page.clock.runFor(200);
    expect(await button.getAttribute("aria-describedby")).toBe("existing-note commentor-tooltip");
    await lab.page.mouse.move(600, 100);
    await lab.page.clock.runFor(10);
    expect(await button.getAttribute("aria-describedby")).toBe("existing-note");
  });

  it("does nothing when a busy page control is activated anyway", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, repliesHasMore: true }]);
    await lab.openDrawer();
    await lab.host(l => { l.pagination = { canLoadMore: false, loading: true }; l.publish(); });
    const older = lab.tid("commentor-load-older-threads");
    await expect.poll(() => older.isDisabled()).toBe(true);
    await older.dispatchEvent("click");
    await lab.host(l => { l.pagination = { canLoadMore: true, loading: false }; l.loadMoreResult = true; l.publish(); });
    expect((await lab.host(l => l.calls)).length).toBe(0);
    const replies = lab.tid("commentor-load-older-replies").first();
    await replies.click();
    await expect.poll(() => lab.host(l => l.replySubscriptions())).toBe(1);
    await lab.host(l => l.publishReplies("t1", [], true, true));
    await expect.poll(() => lab.tid("commentor-load-older-replies").first().isDisabled()).toBe(true);
    await lab.tid("commentor-load-older-replies").first().dispatchEvent("click");
    expect(await lab.host(l => l.replySubscriptions())).toBe(1);
  });
});

describe("dock placement", () => {
  it("moves with the keyboard along its edge and remembers where it was left", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    const grip = lab.tid("commentor-toolbar-grip");
    expect(await grip.getAttribute("aria-keyshortcuts")).toBe("ArrowLeft ArrowRight ArrowUp ArrowDown Home End");
    await grip.focus();
    const start = await dockBox(lab);
    expect(start.className).toBe("dock dock-bottom");
    await lab.page.keyboard.press("ArrowRight");
    expect((await dockBox(lab)).left).toBe(start.left + 24);
    await lab.page.keyboard.press("ArrowLeft");
    await lab.page.keyboard.press("ArrowUp");
    expect((await dockBox(lab)).left).toBe(start.left);
    await lab.page.keyboard.press("Home");
    expect((await dockBox(lab)).left).toBe(16);
    await lab.page.keyboard.press("End");
    const width = await dock(lab).evaluate(el => (el as HTMLElement).offsetWidth);
    expect((await dockBox(lab)).left).toBe(1024 - width - 16);
    await lab.page.keyboard.press("Tab");
    await lab.page.keyboard.press("Shift+Tab");
    await lab.openDrawer();
    await grip.focus();
    await lab.page.keyboard.press("ArrowLeft");
    expect(await dock(lab).getAttribute("data-expanded")).toBeNull();
    await lab.page.reload();
    await lab.ready();
    await expect.poll(async () => (await dockBox(lab)).left).toBe(1024 - width - 16 - 24);
  });

  it("drags to the nearest edge, snaps there and keeps the drawer usable on every edge", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    const grip = lab.tid("commentor-toolbar-grip");
    const drag = async (to: { x: number; y: number }) => {
      const box = (await grip.boundingBox())!;
      await lab.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await lab.page.mouse.down();
      await lab.page.mouse.move(to.x, to.y, { steps: 4 });
      expect((await dockBox(lab)).className).toContain("dragging");
      // Pointers other than the dragging one do not move the dock.
      await lab.doc(() => document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 99, clientX: 5, clientY: 5 })));
      await lab.page.mouse.up();
    };
    await drag({ x: 300, y: 30 });
    await expect.poll(async () => (await dockBox(lab)).className).toBe("dock dock-top");
    expect((await dockBox(lab)).top).toBe(16);
    await lab.openDrawer();
    await drag({ x: 30, y: 400 });
    await expect.poll(async () => (await dockBox(lab)).className).toBe("dock dock-left");
    expect((await dockBox(lab)).left).toBe(16);
    expect(await dock(lab).getAttribute("data-expanded")).toBeNull();
    await grip.focus();
    await lab.page.keyboard.press("ArrowLeft");
    const before = (await dockBox(lab)).top;
    await lab.page.keyboard.press("ArrowDown");
    expect((await dockBox(lab)).top).toBe(before + 24);
    await lab.openDrawer();
    await expect.poll(() => lab.tid("commentor-drawer").evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(300);
    await lab.page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(() => dock(lab).evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(700);
    await lab.tid("commentor-panel-btn").click();
    await drag({ x: 990, y: 300 });
    await expect.poll(async () => (await dockBox(lab)).className).toBe("dock dock-right");
    await lab.openDrawer();
    await expect.poll(() => dock(lab).evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(900);
    expect(await lab.page.evaluate(() => [localStorage.getItem("commentor-dock")])).toEqual(["right"]);
    // Only the primary button starts a drag.
    const box = (await grip.boundingBox())!;
    await lab.page.mouse.move(box.x + 5, box.y + 5);
    await lab.page.mouse.down({ button: "right" });
    expect((await dockBox(lab)).className).not.toContain("dragging");
    await lab.page.mouse.up({ button: "right" });
  });

  it("ignores invalid saved placement and falls back to the bottom edge", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.page.evaluate(() => { localStorage.setItem("commentor-dock", "diagonal"); localStorage.setItem("commentor-dock-offset", "not-a-number"); });
    await lab.page.reload();
    await lab.ready();
    expect((await dockBox(lab)).className).toBe("dock dock-bottom");
    await lab.page.evaluate(() => { localStorage.setItem("commentor-dock", "left"); localStorage.setItem("commentor-dock-offset", "120"); });
    await lab.page.reload();
    await lab.ready();
    expect(await dockBox(lab)).toMatchObject({ className: "dock dock-left", left: 16, top: 120 });
  });

  it("works in a sandboxed document that cannot persist placement", async () => {
    const lab = await commentLab.open({ sandbox: true });
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    expect(await lab.doc(() => { try { return localStorage.length >= 0; } catch { return "blocked"; } })).toBe("blocked");
    const grip = lab.tid("commentor-toolbar-grip");
    await grip.focus();
    await lab.page.keyboard.press("ArrowRight");
    expect((await dockBox(lab)).className).toBe("dock dock-bottom");
  });
});

describe("tooltips, selection and appearance", () => {
  it("describes controls on hover and focus, flips below when there is no room and hides on scroll", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    const tip = lab.tid("commentor-tip");
    const button = lab.tid("commentor-comment-btn");
    await button.hover();
    await expect.poll(() => tip.getAttribute("data-state")).toBe("open");
    expect(await tip.innerText()).toBe("Comment (select text, or click then click an element)");
    expect(await button.getAttribute("aria-describedby")).toBe("commentor-tooltip");
    const above = await tip.evaluate(el => el.getBoundingClientRect().bottom) <= (await button.boundingBox())!.y;
    expect(above).toBe(true);
    await lab.page.mouse.move(600, 100);
    await expect.poll(() => tip.getAttribute("data-state")).toBe("closed");
    expect(await button.getAttribute("aria-describedby")).toBeNull();
    await lab.pins().first().hover();
    await expect.poll(() => tip.getAttribute("data-state")).toBe("open");
    expect(await tip.innerText()).toBe("Ada: Body of t1");
    await lab.page.mouse.move(600, 100);
    await lab.tid("commentor-toolbar-grip").focus();
    await lab.page.keyboard.press("Tab");
    await expect.poll(() => tip.getAttribute("data-state")).toBe("open");
    await lab.doc(() => window.scrollBy(0, 50));
    await expect.poll(() => tip.getAttribute("data-state")).toBe("closed");
    // Moving the dock to the top leaves no room above, so the tip appears below.
    await lab.page.keyboard.press("Shift+Tab");
    const grip = (await lab.tid("commentor-toolbar-grip").boundingBox())!;
    await lab.page.mouse.move(grip.x + 5, grip.y + 5);
    await lab.page.mouse.down();
    await lab.page.mouse.move(400, 20, { steps: 3 });
    await lab.page.mouse.up();
    await expect.poll(async () => (await dockBox(lab)).className).toBe("dock dock-top");
    // A scroll suppresses tips for 120ms of real time and a hover inside that window is ignored for good, so outwait it.
    await lab.page.waitForTimeout(200);
    await button.hover();
    await expect.poll(() => tip.getAttribute("data-state")).toBe("open");
    expect(await tip.evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThan((await button.boundingBox())!.y);
    await lab.page.keyboard.press("Escape");
    expect(await tip.getAttribute("data-state")).toBe("closed");
  });

  it("opens the composer from a selection with the Comment control, and only for real selections", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    const action = lab.tid("commentor-selection-action");
    await lab.select("#intro", 0, 3);
    await expect.poll(() => action.getAttribute("data-state")).toBe("open");
    await lab.page.keyboard.press("Escape");
    await expect.poll(() => action.getAttribute("data-state")).toBe("closed");
    await expect.poll(() => action.evaluate(el => (el as HTMLElement).hidden)).toBe(true);
    // The dismissed selection stays dismissed until it changes.
    await lab.doc(() => document.dispatchEvent(new Event("selectionchange")));
    await lab.select("#intro", 0, 3);
    await lab.select("#intro", 0, 9);
    await expect.poll(() => action.getAttribute("data-state")).toBe("open");
    await lab.doc(() => window.scrollBy(0, 10));
    await expect.poll(() => action.getAttribute("data-state")).toBe("closed");
    await lab.tid("commentor-comment-btn").click();
    await expect.poll(() => lab.tid("commentor-composer").count()).toBe(1);
    expect(await lab.tid("commentor-composer").locator(".anchor-label").innerText()).toBe("On: “The quick”");
    // A thread bubble keeps the action away while it is open; whitespace never offers it.
    await lab.tid("commentor-composer-cancel").click();
    await lab.pins().first().click();
    await lab.select("#second", 0, 3);
    await lab.doc(() => document.dispatchEvent(new Event("selectionchange")));
    await expect.poll(() => action.getAttribute("data-state")).toBe("closed");
    await lab.doc(() => window.getSelection()!.removeAllRanges());
    await lab.doc(() => { const s = document.getElementById("second")!.lastChild as Text; const r = document.createRange(); r.setStart(s, 0); r.setEnd(s, 0); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
    await lab.doc(() => { const host = document.getElementById("commentor-host")!; const r = document.createRange(); r.selectNodeContents(host); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
    expect(await action.getAttribute("data-state")).toBe("closed");
  });

  it("follows the parent's theme and ignores messages from anywhere else", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    const host = lab.page.frameLocator("#content-frame").locator("#commentor-host");
    const classes = () => host.evaluate(el => (el as HTMLElement).className);
    const send = (data: unknown) => lab.host((_lab, data) => (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow!.postMessage(data, "*"), data);
    await send({ type: "rendro-theme", theme: "dark" });
    await expect.poll(classes).toBe("dark");
    await send({ type: "rendro-theme", theme: "light" });
    await expect.poll(classes).toBe("light");
    await send({ type: "rendro-theme", theme: "sepia" });
    await send({ type: "rendro-theme" });
    await send({ type: "other", theme: "dark" });
    await send("dark");
    await send(null);
    await lab.doc(() => window.postMessage({ type: "rendro-theme", theme: "dark" }, "*"));
    await send({ type: "rendro-theme", theme: "system" });
    await expect.poll(classes).toBe("");
    await lab.page.evaluate(() => localStorage.setItem("commentor-theme", "dark"));
    await expect.poll(classes).toBe("dark");
    await lab.page.evaluate(() => localStorage.setItem("unrelated", "x"));
    expect(await classes()).toBe("dark");
  });

  it("keeps notifications readable for their duration and removes them afterwards", async () => {
    const lab = await commentLab.open();
    await lab.page.clock.install();
    await lab.ready();
    await lab.tid("commentor-comment-btn").click();
    await lab.page.mouse.click(900, 300);
    const status = lab.ui.locator('.toast[role="status"]');
    await expect.poll(() => status.count()).toBe(1);
    expect(await status.getAttribute("aria-live")).toBe("polite");
    await lab.page.clock.fastForward(3100);
    await expect.poll(() => status.count()).toBe(0);
    await expect.poll(() => lab.ui.locator(".toast-region").count()).toBe(0);
    await lab.host(l => l.fail(new Error("private subscription detail")));
    const alert = lab.ui.locator('.toast[role="alert"]');
    // Backend diagnostics never reach the reader.
    await expect.poll(() => alert.innerText()).toBe("Comments could not be loaded");
    expect(await alert.getAttribute("aria-live")).toBe("assertive");
    await lab.page.clock.fastForward(6100);
    await expect.poll(() => alert.count()).toBe(0);
  });
});
