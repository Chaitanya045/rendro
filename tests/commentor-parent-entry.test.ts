// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => vi.fn());
vi.mock("../src/commentor/parent-host", () => ({ bootCommentorParentHost: boot }));

const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];

async function load(readyState: DocumentReadyState) {
  vi.resetModules();
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    listeners.push([type, listener]);
    add(type, listener, options);
  });
  Object.defineProperty(document, "readyState", { value: readyState, configurable: true });
  await import("../src/commentor/parent-entry");
}
const pageshow = (persisted: boolean) => window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));

afterEach(() => {
  for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
  vi.restoreAllMocks();
  boot.mockReset();
  Reflect.deleteProperty(document, "readyState");
});

describe("comment parent entry point", () => {
  it("mounts a loaded page at once, unmounts on pagehide and remounts a restored page against its loaded frame", async () => {
    const dispose = vi.fn();
    boot.mockReturnValue(dispose);
    await load("complete");
    expect(boot).toHaveBeenCalledWith(false);
    window.dispatchEvent(new Event("pagehide"));
    expect(dispose).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pagehide"));
    expect(dispose).toHaveBeenCalledTimes(1);
    pageshow(false);
    expect(boot).toHaveBeenCalledTimes(1);
    pageshow(true);
    expect(boot).toHaveBeenLastCalledWith(true);
    pageshow(true);
    expect(boot).toHaveBeenCalledTimes(2);
  });

  it("waits for the document to finish loading, and mounts only once when the host declines to start", async () => {
    boot.mockReturnValue(null);
    await load("loading");
    expect(boot).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(boot).toHaveBeenCalledWith(false);
    pageshow(true);
    expect(boot).toHaveBeenCalledTimes(2);
  });
});
