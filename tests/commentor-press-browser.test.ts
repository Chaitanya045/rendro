import type { Locator } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import { waitForSettled } from "./helpers/browser";
import { anchorOn, useCommentLab, type Lab } from "./helpers/comment-lab";

const commentLab = useCommentLab();
beforeAll(() => commentLab.start());

const heading = anchorOn("Quarterly report");
const intro = anchorOn("lazy dog");
const card = (lab: Lab, id: string) => lab.ui.locator(`.drawer-thread[data-thread-id="${id}"]`);
const toast = (lab: Lab) => lab.ui.locator('.toast[role="status"]');

/**
 * The widget as a maintainer's page sees a write that another reader (or another tab) made: the data changes behind the
 * page's back and the subscription delivers it. Resolves once the document has received the update and the widget has
 * handled it, so the test knows the page met it, wherever the reader's press was by then.
 */
async function liveUpdate(lab: Lab, change: { add?: Array<{ _id: string; anchor?: unknown }>; remove?: string[] }, carries: string) {
  const delivered = lab.doc(id => new Promise<void>(resolve => {
    addEventListener("message", function seen(event: MessageEvent) {
      const threads = (event.data as { threads?: Array<{ _id: string }> } | null)?.threads;
      if (!threads?.some(thread => thread._id === id)) return;
      removeEventListener("message", seen);
      resolve();
    });
  }), carries);
  await lab.host((lab, change) => {
    lab.threads = lab.threads.filter(thread => !change.remove.includes(thread._id)).concat(change.add.map(thread => lab.thread(thread)));
    lab.publish();
  }, { add: change.add ?? [], remove: change.remove ?? [] });
  await delivered;
  await waitForSettled(lab.frame);
}

async function centre(target: Locator) {
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function pressOn(lab: Lab, target: Locator, button: "left" | "right" = "left") {
  const { x, y } = await centre(target);
  await lab.page.mouse.move(x, y);
  await lab.page.mouse.down({ button });
}
const methods = async (lab: Lab) => (await lab.calls).map(call => `${call.method}:${String(call.args.threadId)}`);

describe("a press that a live update meets (#350)", () => {
  it("keeps a drawer button pressed while the list is rebuilt, then shows the newest state", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }, { _id: "t2", anchor: intro }]);
    await lab.openDrawer();
    await waitForSettled(lab.frame);
    await pressOn(lab, card(lab, "t1").getByTestId("commentor-delete-btn"));
    await liveUpdate(lab, { add: [{ _id: "t3", anchor: intro }] }, "t3");
    await liveUpdate(lab, { add: [{ _id: "t4", anchor: intro }], remove: ["t3"] }, "t4");
    // The press is not over: the list the reader pressed in is still the one on screen.
    expect(await card(lab, "t3").count() + await card(lab, "t4").count()).toBe(0);
    await lab.page.mouse.up();
    // The click arrived: the undoable delete began.
    await expect.poll(() => toast(lab).innerText()).toContain("Comment deleted.");
    // And the update that waited was applied afterwards, as the newest state: t3 came and went before it was ever shown.
    await expect.poll(() => card(lab, "t4").count()).toBe(1);
    expect(await card(lab, "t3").count()).toBe(0);
    expect(await card(lab, "t1").count()).toBe(0);
    // Updates are applied at once again.
    await liveUpdate(lab, { add: [{ _id: "t5", anchor: intro }] }, "t5");
    expect(await card(lab, "t5").count()).toBe(1);
  });

  it("keeps a button of the open bubble pressed while the bubble is rebuilt", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.pins().first().click();
    const bubble = lab.tid("commentor-thread-bubble");
    await bubble.waitFor();
    await waitForSettled(lab.frame);
    await pressOn(lab, bubble.getByTestId("commentor-resolve-btn"));
    await liveUpdate(lab, { add: [{ _id: "t2", anchor: intro }] }, "t2");
    expect(await lab.pins().evaluateAll(pins => pins.map(pin => pin.getAttribute("data-thread-id")))).toEqual(["t1"]);
    await lab.page.mouse.up();
    await expect.poll(() => methods(lab)).toEqual(["thread.resolve:t1"]);
    // The held update is shown after the click: t1 left the active pins when it was resolved, and t2 arrived.
    await expect.poll(() => lab.pins().evaluateAll(pins => pins.map(pin => pin.getAttribute("data-thread-id")))).toEqual(["t2"]);
  });

  it("keeps a pin pressed while the pins are rebuilt, so releasing it opens its bubble", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await pressOn(lab, lab.pins().first());
    await liveUpdate(lab, { add: [{ _id: "t2", anchor: intro }] }, "t2");
    expect(await lab.pins().count()).toBe(1);
    await lab.page.mouse.up();
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("t1");
    await expect.poll(() => lab.pins().count()).toBe(2);
  });

  it("keeps a focused button through a held Space, until it is released", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    await waitForSettled(lab.frame);
    await card(lab, "t1").getByTestId("commentor-archive-btn").focus();
    await lab.page.keyboard.down(" ");
    // A held key repeats; only its first press begins the hold.
    await lab.page.keyboard.down(" ");
    await liveUpdate(lab, { add: [{ _id: "t2", anchor: intro }] }, "t2");
    expect(await card(lab, "t2").count()).toBe(0);
    await lab.page.keyboard.up(" ");
    await expect.poll(() => methods(lab)).toEqual(["thread.archive:t1"]);
    await expect.poll(() => card(lab, "t2").count()).toBe(1);
  });

  it("does not hold updates for a press outside the rebuilt regions, a secondary button, or a key that does not click", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    await waitForSettled(lab.frame);
    // The tabs are not rebuilt.
    await pressOn(lab, lab.ui.getByRole("tab", { name: /Resolved/ }));
    await liveUpdate(lab, { add: [{ _id: "t2", anchor: intro }] }, "t2");
    await expect.poll(() => card(lab, "t2").count()).toBe(1);
    await lab.page.mouse.up();
    // A secondary button opens a menu rather than clicking.
    await lab.ui.getByRole("tab", { name: /Active/ }).click();
    await pressOn(lab, card(lab, "t1").getByTestId("commentor-delete-btn"), "right");
    await liveUpdate(lab, { add: [{ _id: "t3", anchor: intro }] }, "t3");
    await expect.poll(() => card(lab, "t3").count()).toBe(1);
    await lab.page.mouse.up({ button: "right" });
    // Typing a space in a field is not a button press, and another key's release changes nothing.
    await card(lab, "t1").getByTestId("commentor-reply-input").focus();
    await lab.page.keyboard.down(" ");
    await liveUpdate(lab, { add: [{ _id: "t4", anchor: intro }] }, "t4");
    await expect.poll(() => card(lab, "t4").count()).toBe(1);
    await lab.page.keyboard.up(" ");
    await lab.page.keyboard.press("a");
    expect(await methods(lab)).toEqual([]);
    // Space on a button outside the rebuilt regions holds nothing either.
    await lab.ui.getByRole("tab", { name: /Resolved/ }).focus();
    await lab.page.keyboard.down(" ");
    await liveUpdate(lab, { add: [{ _id: "t5", anchor: intro }] }, "t5");
    await lab.page.keyboard.up(" ");
    await expect.poll(() => lab.tid("commentor-drawer-list").getAttribute("aria-label")).toBe("Resolved comments");
  });

  it("does not let a press that never ends freeze updates", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    await waitForSettled(lab.frame);
    await pressOn(lab, card(lab, "t1").getByTestId("commentor-delete-btn"));
    await liveUpdate(lab, { add: [{ _id: "t2", anchor: intro }] }, "t2");
    expect(await card(lab, "t2").count()).toBe(0);
    // The release never comes; the update is shown after a moment all the same.
    await expect.poll(() => card(lab, "t2").count(), { timeout: 6_000 }).toBe(1);
    await lab.page.mouse.up();
  });

  it("applies a held rebuild when the window loses focus mid-press", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await lab.openDrawer();
    await waitForSettled(lab.frame);
    await pressOn(lab, card(lab, "t1").getByTestId("commentor-delete-btn"));
    await liveUpdate(lab, { add: [{ _id: "t2", anchor: intro }] }, "t2");
    expect(await card(lab, "t2").count()).toBe(0);
    await lab.doc(() => window.dispatchEvent(new Event("blur")));
    await expect.poll(() => card(lab, "t2").count()).toBe(1);
    await lab.page.mouse.up();
  });
});
