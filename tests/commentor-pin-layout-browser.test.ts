import { beforeAll, describe, expect, it } from "vitest";
import { anchorOn, defaultDocument, useCommentLab, type Lab } from "./helpers/comment-lab";

const commentLab = useCommentLab();
beforeAll(() => commentLab.start());

const footerBlock = /<div style="height:1600px"><\/div><p id="footer">Footer text far below<\/p>/;
/** `count` stacked rows of `rowHeight`px the anchors below can name (and a tall tail so the page scrolls). */
const rowsDocument = (count: number, rowHeight: number) => defaultDocument.replace(footerBlock,
  Array.from({ length: count }, (_, index) => `<p class="row" style="margin:0;height:${rowHeight}px;overflow:hidden;font-size:${Math.min(rowHeight, 12)}px;line-height:${rowHeight}px">Row ${index} text</p>`).join("")
  + '<div style="height:3000px"></div>');
/** Row `index`'s text, found by its quote alone or (rowQuote) by its quote and the text after it. */
const rowAnchor = (index: number) => anchorOn(`Row ${index} text`);
const rowQuote = (index: number) => ({ ...anchorOn(`Row ${index} text`), suffix: `Row ${index + 1}` });
/** A row's quote under a heading the page does not have: orphaned. */
const goneAnchor = (index: number) => anchorOn(`Row ${index} text`, `gone-${index}`);

/** Layouts the browser ran while `action` ran: a read that follows a write adds one to the frame's own. */
async function layoutsDuring(lab: Lab, action: () => Promise<void>) {
  const cdp = await lab.page.context().newCDPSession(lab.page);
  try {
    await cdp.send("Performance.enable");
    const layouts = async () => (await cdp.send("Performance.getMetrics")).metrics.find(metric => metric.name === "LayoutCount")!.value;
    const before = await layouts();
    await action();
    return await layouts() - before;
  } finally {
    await cdp.detach();
  }
}
/**
 * Pause the widget's timers (tooltip, drawer collapse, selection action) while leaving animation
 * frames real. A timer that happens to come due can force a layout inside the frames a test
 * measures; with the clock paused it waits for the test instead. Playwright's clock fakes
 * requestAnimationFrame too, so the real one is handed back: the pin pass must still run in the
 * same real frame as the scroll that scheduled it.
 */
async function pauseTimers(lab: Lab) {
  await lab.doc(() => {
    const g = globalThis as unknown as { realRaf: typeof requestAnimationFrame; realCancelRaf: typeof cancelAnimationFrame };
    g.realRaf = window.requestAnimationFrame;
    g.realCancelRaf = window.cancelAnimationFrame;
  });
  await lab.page.clock.install();
  await lab.pauseClock();
  await lab.doc(() => {
    const g = globalThis as unknown as { realRaf: typeof requestAnimationFrame; realCancelRaf: typeof cancelAnimationFrame };
    window.requestAnimationFrame = g.realRaf;
    window.cancelAnimationFrame = g.realCancelRaf;
  });
}
/** Scroll by `delta` and wait until the widget's frame for it has run. */
const scrollFrame = (lab: Lab, delta: number) => lab.doc(delta => new Promise<void>(resolve => {
  window.scrollBy(0, delta);
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
}), delta);
const pinBoxes = (lab: Lab) => lab.pins().evaluateAll(pins => pins.map(pin => ({
  id: pin.getAttribute("data-thread-id"), display: (pin as HTMLElement).style.display, orphan: pin.classList.contains("orphan"),
  left: parseFloat((pin as HTMLElement).style.left), top: parseFloat((pin as HTMLElement).style.top),
})));
/** Where the pin of a row anchor belongs: at the start of the row's text. */
const expectedPin = (lab: Lab, index: number) => lab.doc(index => {
  const row = document.querySelectorAll("main > p")[index + 2];
  const range = document.createRange();
  range.selectNodeContents(row);
  const rect = range.getClientRects()[0];
  return { left: Math.max(8, Math.min(innerWidth - 30, rect.left - 10)), top: Math.max(8, Math.min(innerHeight - 30, rect.top - 26)), visible: rect.top >= 0 && rect.top <= innerHeight };
}, index);

describe("batched pin layout", () => {
  it.each([10, 100, 500])("runs one layout per frame with %i pins on screen, however they are anchored", async count => {
    // 1px rows put every anchor in the viewport, the worst case for a read after each write.
    const lab = await commentLab.open({ document: rowsDocument(count, 1) });
    await lab.ready(Array.from({ length: count }, (_, index) => ({ _id: `t${index}`, anchor: index % 10 === 9 ? goneAnchor(index) : index % 5 === 4 ? rowQuote(index) : rowAnchor(index) })));
    await expect.poll(() => lab.pins().count()).toBe(count);
    const frames = 8;
    // Scrolling does not dirty layout; only the pin writes do, so a frame costs exactly its own layout.
    const layouts = await layoutsDuring(lab, async () => { for (let frame = 0; frame < frames; frame++) await scrollFrame(lab, 3); });
    expect(layouts).toBe(frames);
    const boxes = await pinBoxes(lab);
    expect(boxes.filter(box => box.display === "none").length).toBe(count / 10);
    expect(boxes.filter(box => box.orphan).length).toBe(count / 10);
  }, 120_000);

  it("keeps a thread bubble on its pin without a second layout, through hide and reveal", async () => {
    const lab = await commentLab.open({ document: rowsDocument(40, 48), height: 700 });
    await lab.ready(Array.from({ length: 40 }, (_, index) => ({ _id: `t${index}`, anchor: rowAnchor(index) })));
    await expect.poll(() => lab.pins().count()).toBe(40);
    await lab.pins().first().click();
    const bubble = lab.tid("commentor-thread-bubble");
    await bubble.waitFor();
    // Leave the pin so its tooltip and hover styling cannot add layouts to the frames measured below.
    await lab.page.mouse.move(1000, 10);
    await expect.poll(() => lab.tid("commentor-tip").getAttribute("data-state")).toBe("closed");
    await scrollFrame(lab, 0);
    const bubbleBelowPin = () => lab.ui.locator("[data-testid='commentor-pin'][aria-pressed='true']").evaluate(pin => {
      const root = pin.getRootNode() as ShadowRoot;
      const rect = pin.getBoundingClientRect();
      const box = (root.querySelector("[data-testid='commentor-thread-bubble']") as HTMLElement);
      return { bubbleTop: parseFloat(box.style.top), pinBottom: rect.bottom, pinLeft: rect.left, bubbleLeft: parseFloat(box.style.left), shown: (pin as HTMLElement).style.display !== "none" };
    });
    const startsAt = await bubbleBelowPin();
    expect(startsAt.bubbleTop).toBeCloseTo(startsAt.pinBottom + 8, 1);
    // Shown before and after: the pin's new box is derived, not read, so the frame needs no extra layout.
    expect(await layoutsDuring(lab, () => scrollFrame(lab, 10))).toBe(1);
    const moved = await bubbleBelowPin();
    expect(moved.bubbleTop).toBeCloseTo(moved.pinBottom + 8, 1);
    expect(moved.bubbleTop).toBeCloseTo(startsAt.bubbleTop - 10, 1);
    // Out of the viewport: the pin is hidden, and the bubble keeps the top-left corner it had before.
    await scrollFrame(lab, 1000);
    expect(await lab.pins().first().evaluate(pin => (pin as HTMLElement).style.display)).toBe("none");
    expect(await bubble.evaluate(box => [box.style.left, box.style.top])).toEqual(["8px", "8px"]);
    // Back on screen: a pin that was hidden has no earlier box to shift, so this frame reads it once.
    expect(await layoutsDuring(lab, () => scrollFrame(lab, -1000))).toBe(2);
    expect(await lab.pins().first().evaluate(pin => (pin as HTMLElement).style.display)).toBe("");
    const returned = await bubbleBelowPin();
    expect(returned.bubbleTop).toBeCloseTo(returned.pinBottom + 8, 1);
    expect(returned.bubbleLeft).toBeCloseTo(Math.max(8, returned.pinLeft), 1);
  });

  it("leaves an open bubble where it is when its anchor disappears or its thread has no pin", async () => {
    const lab = await commentLab.open({ document: rowsDocument(20, 48), height: 700 });
    await lab.ready([{ _id: "title", anchor: anchorOn("Quarterly report") }, { _id: "row", anchor: rowAnchor(2) }]);
    await expect.poll(() => lab.pins().count()).toBe(2);
    await lab.pins().first().click();
    const bubble = lab.tid("commentor-thread-bubble");
    await bubble.waitFor();
    const placed = () => bubble.evaluate(box => [box.style.left, box.style.top]);
    // The anchor is removed from the page: its pin is hidden as an orphan, and nothing is left to attach the bubble to.
    await lab.doc(() => document.querySelector("h1")!.remove());
    await expect.poll(() => lab.pins().first().evaluate(pin => pin.classList.contains("orphan"))).toBe(true);
    await expect.poll(placed).toEqual(["8px", "8px"]);
    // The thread is resolved elsewhere: the active list drops its pin while the bubble stays open.
    await lab.host(l => { l.threads[0].resolved = true; l.publish(); });
    await expect.poll(() => lab.pins().count()).toBe(1);
    expect(await bubble.count()).toBe(1);
    await scrollFrame(lab, 30);
    expect(await placed()).toEqual(["8px", "8px"]);
    expect(await lab.pins().first().getAttribute("data-thread-id")).toBe("row");
  });

  it("places quoted, contextual and missing anchors after a scroll, a resize and an update", async () => {
    const lab = await commentLab.open({ document: rowsDocument(60, 48), height: 600 });
    await lab.ready([{ _id: "row", anchor: rowAnchor(3) }, { _id: "quote", anchor: rowQuote(5) }, { _id: "missing", anchor: anchorOn("Quarterly report", "gone") }, { _id: "far", anchor: rowAnchor(50) }]);
    await expect.poll(() => lab.pins().count()).toBe(4);
    const check = async (label: string) => {
      const boxes = await pinBoxes(lab);
      for (const [pin, row] of [[boxes[0], 3], [boxes[1], 5], [boxes[3], 50]] as const) {
        const expected = await expectedPin(lab, row);
        if (expected.visible) expect({ display: pin.display, left: pin.left, top: pin.top }, `${label} row ${row}`).toEqual({ display: "", left: expected.left, top: expected.top });
        else expect(pin.display, `${label} row ${row}`).toBe("none");
      }
      expect({ display: boxes[2].display, orphan: boxes[2].orphan }, label).toEqual({ display: "none", orphan: true });
    };
    await check("initial");
    await scrollFrame(lab, 130);
    await check("scrolled");
    await scrollFrame(lab, 2400);
    await check("far");
    await lab.page.setViewportSize({ width: 700, height: 900 });
    await expect.poll(async () => (await pinBoxes(lab)).map(box => box.display)).toEqual(["none", "none", "none", ""]);
    await check("resized");
    // A thread update rebuilds the pins, each placed in the same pass.
    await lab.host(l => { l.threads.push(l.thread({ _id: "fresh", anchor: l.anchorOn("Row 49 text") })); l.publish(); });
    await expect.poll(() => lab.pins().count()).toBe(5);
    const fresh = (await pinBoxes(lab)).at(-1)!;
    const expected = await expectedPin(lab, 49);
    expect({ left: fresh.left, top: fresh.top }).toEqual({ left: expected.left, top: expected.top });
    expect(fresh.display).toBe("");
  });

  it("follows content that reflows without a scroll or resize", async () => {
    const lab = await commentLab.open({ document: rowsDocument(20, 48), height: 600 });
    await lab.ready([{ _id: "row", anchor: rowAnchor(4) }]);
    await expect.poll(async () => (await pinBoxes(lab))[0]?.display).toBe("");
    const before = (await pinBoxes(lab))[0].top;
    // The way a late image or webfont moves everything below it.
    await lab.doc(() => { document.querySelector("h1")!.style.paddingBottom = "60px"; });
    await expect.poll(async () => (await pinBoxes(lab))[0].top).toBe(before + 60);
    expect((await pinBoxes(lab))[0].top).toBe((await expectedPin(lab, 4)).top);
  });

  it("follows the highlighted anchor in the same pass", async () => {
    const lab = await commentLab.open({ document: rowsDocument(20, 48), height: 600 });
    await lab.ready([{ _id: "row", anchor: rowAnchor(4) }, { _id: "quote", anchor: rowQuote(6) }]);
    await expect.poll(() => lab.pins().count()).toBe(2);
    await pauseTimers(lab);
    await lab.openDrawer();
    // The card's hover highlights the anchor without the pin's delayed tooltip.
    await lab.ui.locator(".drawer-thread").first().dispatchEvent("pointerenter");
    await scrollFrame(lab, 0);
    const segment = lab.ui.locator(".anchor-highlight-segment");
    await expect.poll(() => segment.count()).toBe(1);
    const top = () => segment.evaluate(el => parseFloat((el as HTMLElement).style.top));
    const start = await top();
    expect(await layoutsDuring(lab, () => scrollFrame(lab, 12))).toBe(1);
    expect(await top()).toBe(start - 12);
    await scrollFrame(lab, 1500);
    await expect.poll(() => segment.count()).toBe(0);
  });

  it("keeps pins placed and orphans hidden while the drawer opens and closes, on every dock edge", async () => {
    const lab = await commentLab.open({ document: rowsDocument(30, 48), height: 700 });
    await lab.ready([]);
    for (const edge of ["bottom", "top", "left", "right"]) {
      await lab.page.evaluate(edge => { localStorage.setItem("commentor-dock", edge); localStorage.setItem("commentor-dock-offset", "100"); }, edge);
      await lab.page.reload();
      await lab.ready([{ _id: "row", anchor: rowAnchor(4) }, { _id: "gone", anchor: anchorOn("Quarterly report", "gone") }, { _id: "quote", anchor: rowQuote(8) }]);
      await expect.poll(() => lab.pins().count()).toBe(3);
      const settled = async () => {
        const boxes = await pinBoxes(lab);
        const [row, quote] = [await expectedPin(lab, 4), await expectedPin(lab, 8)];
        expect(boxes.map(box => [box.display, box.orphan]), edge).toEqual([[row.visible ? "" : "none", false], ["none", true], [quote.visible ? "" : "none", false]]);
        if (row.visible) expect([boxes[0].left, boxes[0].top], edge).toEqual([row.left, row.top]);
        if (quote.visible) expect([boxes[2].left, boxes[2].top], edge).toEqual([quote.left, quote.top]);
      };
      await settled();
      await lab.openDrawer();
      await settled();
      await scrollFrame(lab, 40);
      await settled();
      await lab.tid("commentor-panel-btn").click();
      await expect.poll(() => lab.tid("commentor-panel-btn").getAttribute("aria-expanded")).toBe("false");
      await settled();
    }
  });

  it("leaves nothing behind when the document navigates away", async () => {
    const lab = await commentLab.open({ document: rowsDocument(10, 48) });
    const errors: string[] = [];
    lab.page.on("pageerror", error => errors.push(error.message));
    await lab.ready([{ _id: "row", anchor: rowAnchor(2) }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    // Queue a frame, then replace the document before it can run.
    await lab.doc(() => { window.scrollBy(0, 5); location.reload(); });
    await lab.page.waitForLoadState("load");
    await lab.ready([{ _id: "row", anchor: rowAnchor(2) }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    const expected = await expectedPin(lab, 2);
    expect((await pinBoxes(lab))[0]).toMatchObject({ left: expected.left, top: expected.top });
    expect(errors).toEqual([]);
  });
});
