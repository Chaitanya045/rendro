import { Window as DOMWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installViewerFrame } from "@/viewer/client";

const origin = "https://rendro.test";
const base = "/organizations/org-a/projects/project-a/docs";
const prefix = `${base}/view/initial/files/`;
const minute = 60_000;
const windows: DOMWindow[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function events() {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  return {
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, [...(handlers.get(type) ?? []), handler]),
    emit: (type: string, event: unknown = {}) => handlers.get(type)?.forEach(handler => handler(event)),
  };
}

/** A renewal client in a document that is `visible` or hidden to begin with. */
function viewer(initially: "visible" | "hidden" = "visible") {
  vi.useFakeTimers();
  const win = new DOMWindow({ url: `${origin}${base}/files/guide/index.html`, settings: { disableCSSFileLoading: true } });
  windows.push(win);
  win.document.write(`<html><head><base data-rendro-viewer href="${origin}${prefix}guide/index.html"></head><body><img src="assets/a.png"></body></html>`);
  const bus = events();
  const parent = { postMessage: vi.fn() };
  const setInterval = vi.fn(globalThis.setInterval);
  const clearInterval = vi.fn(globalThis.clearInterval);
  const host = { ...bus, location: win.location, document: win.document, parent, setInterval, clearInterval } as unknown as Window;
  const show = (state: "visible" | "hidden") => {
    Object.defineProperty(win.document, "visibilityState", { configurable: true, value: state });
    win.document.dispatchEvent(new win.Event("visibilitychange"));
  };
  Object.defineProperty(win.document, "visibilityState", { configurable: true, value: initially });
  installViewerFrame({ base, prefix, manifestKey: "release/manifest.json", deploymentId: "release" }, host);
  let tickets = 0;
  const requests = () => parent.postMessage.mock.calls.filter(([message]) => message.type === "viewer-renew").length;
  /** The trusted parent answers the latest request, so the next one is due five minutes after it. */
  const respond = () => {
    const request = parent.postMessage.mock.lastCall![0];
    bus.emit("message", { source: parent, origin, data: { type: "viewer-renewed", requestId: request.requestId, prefix: `${base}/view/t${++tickets}/files/` } });
  };
  /** Let `time` pass a minute at a time, answering every renewal request the page makes. */
  const pass = (time: number) => {
    for (let elapsed = 0; elapsed < time; elapsed += minute) {
      vi.advanceTimersByTime(minute);
      if (parent.postMessage.mock.calls.length > tickets) respond();
    }
  };
  return { win, bus, parent, show, requests, respond, pass, setInterval, clearInterval };
}

describe("viewer renewal in a hidden tab", () => {
  it("renews nothing for an hour hidden, against twelve requests visible, then renews once on return", () => {
    const visibleHour = viewer();
    visibleHour.pass(60 * minute);
    expect(visibleHour.requests()).toBe(12);
    const hiddenHour = viewer();
    hiddenHour.show("hidden");
    hiddenHour.pass(60 * minute);
    expect(hiddenHour.requests()).toBe(0);
    // The whole hour's heartbeat is gone, not just ignored.
    expect(hiddenHour.clearInterval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    hiddenHour.show("visible");
    expect(hiddenHour.requests()).toBe(1);
    expect(hiddenHour.parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "viewer-renew", manifestKey: "release/manifest.json" }), origin);
    // The ticket is expired by the time the tab returns, so the renewal is not left to the next tick.
    hiddenHour.respond();
    expect(hiddenHour.win.document.querySelector("img")!.getAttribute("src")).toContain("/view/t1/files/");
    hiddenHour.pass(4 * minute);
    expect(hiddenHour.requests()).toBe(1);
    hiddenHour.pass(minute);
    expect(hiddenHour.requests()).toBe(2);
  });

  it("returns without a renewal while the ticket is still fresh, and keeps the heartbeat from then on", () => {
    const f = viewer();
    f.pass(minute);
    f.show("hidden");
    vi.advanceTimersByTime(2 * minute);
    f.show("visible");
    expect(f.requests()).toBe(0);
    f.pass(minute);
    expect(f.requests()).toBe(0);
    // Five minutes after the page loaded.
    f.pass(minute);
    expect(f.requests()).toBe(1);
  });

  it("keeps a single heartbeat however often the tab is hidden and shown", () => {
    const f = viewer();
    for (let cycle = 0; cycle < 5; cycle++) { f.show("hidden"); f.show("visible"); }
    expect(vi.getTimerCount()).toBe(1);
    expect(f.setInterval).toHaveBeenCalledTimes(6);
    expect(f.clearInterval).toHaveBeenCalledTimes(5);
    // Showing a visible tab again changes nothing.
    f.show("visible");
    expect(f.setInterval).toHaveBeenCalledTimes(6);
    f.pass(60 * minute);
    expect(f.requests()).toBe(12);
  });

  it("starts no heartbeat in a tab that opens hidden, until it is shown", () => {
    const f = viewer("hidden");
    expect(f.setInterval).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60 * minute);
    expect(f.requests()).toBe(0);
    f.show("visible");
    expect(f.setInterval).toHaveBeenCalledTimes(1);
    expect(f.requests()).toBe(1);
  });

  it("holds page show and focus renewals for the return, and retries a failed resource then even though the ticket is fresh", () => {
    const f = viewer();
    f.show("hidden");
    vi.advanceTimersByTime(6 * minute);
    f.bus.emit("pageshow");
    f.bus.emit("focus");
    f.win.document.dispatchEvent(new f.win.Event("error"));
    expect(f.requests()).toBe(0);
    f.show("visible");
    expect(f.requests()).toBe(1);
    f.respond();
    // Hidden again straight after a renewal: the failure that was held is not carried over.
    f.show("hidden");
    f.show("visible");
    expect(f.requests()).toBe(1);
    f.show("hidden");
    f.win.document.dispatchEvent(new f.win.Event("error"));
    vi.advanceTimersByTime(40_000);
    f.show("visible");
    expect(f.requests()).toBe(2);
    f.respond();
    // A resource error while visible renews at once, as before.
    vi.advanceTimersByTime(40_000);
    f.win.document.dispatchEvent(new f.win.Event("error"));
    expect(f.requests()).toBe(3);
  });

  it("still waits out the thirty second request spacing on return", () => {
    const f = viewer();
    f.show("hidden");
    vi.advanceTimersByTime(6 * minute);
    f.show("visible");
    expect(f.requests()).toBe(1);
    f.show("hidden");
    f.show("visible");
    f.show("hidden");
    f.show("visible");
    expect(f.requests()).toBe(1);
  });
});
