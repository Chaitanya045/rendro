// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { whenVisible } from "../src/commentor/visibility";

afterEach(() => Reflect.deleteProperty(document, "visibilityState"));
const show = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("waiting for the tab to be visible", () => {
  it("does not wait while the document is visible", async () => {
    await whenVisible();
    show("visible");
    await whenVisible(document);
  });

  it("settles every waiter once the document is visible again, and not before", async () => {
    show("hidden");
    const settled = vi.fn();
    const waiting = [whenVisible(), whenVisible()].map(wait => wait.then(settled));
    show("hidden");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    show("visible");
    await Promise.all(waiting);
    expect(settled).toHaveBeenCalledTimes(2);
    // The listeners are gone: a later hide and show has nothing left to settle.
    const remove = vi.spyOn(document, "removeEventListener");
    show("hidden");
    show("visible");
    expect(remove).not.toHaveBeenCalled();
  });
});
