import { Window as DOMWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installViewerFrame, installViewerParent } from "@/viewer/client";

const origin = "https://rendro.test";
const base = "/organizations/org-a/projects/project-a/docs";
const prefix = `${base}/view/initial/files/`;
const windows: DOMWindow[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function events() {
  const handlers = new Map<string, (event: unknown) => void>();
  return {
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
    emit: (type: string, event: unknown = {}) => handlers.get(type)?.(event),
  };
}

function frameFixture() {
  const win = new DOMWindow({ url: `${origin}${base}/files/guide/index.html`, settings: {
    disableCSSFileLoading: true, disableJavaScriptFileLoading: true,
  } });
  windows.push(win);
  win.document.write(`<html><head><base data-rendro-viewer href="${origin}${prefix}guide/index.html">
    <link rel="stylesheet" href="assets/site.css">
    <style>.image{background:url(${prefix}guide/assets/image.png)}</style></head>
    <body><img src="assets/image.png" srcset="assets/small.png 1x, assets/large.png 2x">
    <img id="external" src="https://publisher.test/image.png">
    <div style="background:url(${prefix}guide/assets/image.png)"></div>
    <div id="unchanged" style="filter:url(#id); --data:url(data:image/png;base64,AAAA); --blob:url(blob:https://rendro.test/id); --absolute:url(https://publisher.test/a.png); --protocol:url(//publisher.test/a.png); --ticket:url(${origin}${prefix}hardcoded.png)"></div>
    <textarea>Comment draft</textarea></body></html>`);
  const bus = events();
  const parent = { postMessage: vi.fn() };
  const host = { ...bus, document: win.document, parent, setInterval: globalThis.setInterval } as unknown as Window;
  installViewerFrame({ base, prefix, manifestKey: "release/manifest.json" }, host);
  const renew = (next: string) => {
    const request = parent.postMessage.mock.lastCall![0];
    bus.emit("message", { source: parent, origin, data: { type: "viewer-renewed", requestId: request.requestId, prefix: next } });
  };
  return { win, bus, parent, renew };
}

describe("private viewer renewal", () => {
  it("refreshes resource URLs over multiple lifetimes without replacing the document or drafts", () => {
    vi.useFakeTimers();
    const { win, parent, renew } = frameFixture();
    const draft = win.document.querySelector("textarea")!;
    const unchanged = win.document.querySelector("#unchanged")!.getAttribute("style");
    vi.advanceTimersByTime(4 * 60_000);
    expect(parent.postMessage).not.toHaveBeenCalled();
    for (const ticket of ["renewed", "renewed-again", "still-open"]) {
      vi.advanceTimersByTime(5 * 60_000);
      expect(parent.postMessage.mock.lastCall![1]).toBe(origin);
      const next = `${base}/view/${ticket}/files/`;
      renew(next);
      expect(win.document.baseURI).toBe(`${origin}${next}guide/index.html`);
      expect(win.document.querySelector("link")!.href).toBe(`${origin}${next}guide/assets/site.css`);
      expect(win.document.querySelector("img")!.src).toBe(`${origin}${next}guide/assets/image.png`);
      expect(win.document.querySelector("img")!.srcset).toContain(`${next}guide/assets/large.png 2x`);
      expect(win.document.querySelector("style")!.textContent).toContain(next);
      expect(win.document.querySelector("div")!.getAttribute("style")).toContain(next);
      expect(win.document.querySelector("#external")!.getAttribute("src")).toBe("https://publisher.test/image.png");
      expect(win.document.querySelector("#unchanged")!.getAttribute("style")).toBe(unchanged);
      expect(win.document.querySelector("textarea")).toBe(draft);
      expect(draft.value).toBe("Comment draft");
    }
  });

  it("recovers after tab suspension and ignores forged, stale, or out-of-scope renewal messages", () => {
    vi.useFakeTimers();
    const { win, bus, parent, renew } = frameFixture();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    bus.emit("focus");
    const request = parent.postMessage.mock.lastCall![0];
    const data = { type: "viewer-renewed", requestId: request.requestId, prefix: `${base}/view/fresh/files/` };
    for (const message of [
      { source: {}, origin, data },
      { source: parent, origin: "https://other.test", data },
      { source: parent, origin, data: { ...data, requestId: "stale" } },
      { source: parent, origin, data: { ...data, prefix: "/organizations/other/view/fresh/files/" } },
    ]) bus.emit("message", message);
    expect(win.document.baseURI).toContain(prefix);
    renew(data.prefix);
    expect(win.document.baseURI).toContain(data.prefix);
    bus.emit("focus");
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });

  it("retries resource errors with bounded requests", () => {
    vi.useFakeTimers();
    const { win, parent } = frameFixture();
    win.document.dispatchEvent(new win.Event("error"));
    win.document.dispatchEvent(new win.Event("error"));
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31_000);
    win.document.dispatchEvent(new win.Event("error"));
    expect(parent.postMessage).toHaveBeenCalledTimes(2);
  });

  it("allows only the current opaque frame to request cookie-authenticated renewal", async () => {
    const bus = events();
    const source = { postMessage: vi.fn() };
    const frame = { src: `${origin}${base}/files/guide/index.html`, contentWindow: source };
    const fetch = vi.fn().mockResolvedValue(Response.json({ prefix: `${base}/view/fresh/files/` }));
    const host = { ...bus, document: { getElementById: () => frame }, location: new URL(origin), fetch } as unknown as Window;
    installViewerParent({ base }, host);
    const data = { type: "viewer-renew", requestId: "request-1", manifestKey: "release/manifest.json" };
    bus.emit("message", { source: {}, origin: "null", data });
    bus.emit("message", { source, origin, data });
    expect(fetch).not.toHaveBeenCalled();
    bus.emit("message", { source, origin: "null", data });
    await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(`${base}/viewer-ticket?manifestKey=release%2Fmanifest.json`, expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(source.postMessage).toHaveBeenCalledWith({ type: "viewer-renewed", requestId: "request-1", prefix: `${base}/view/fresh/files/` }, "*");

    source.postMessage.mockClear();
    fetch.mockResolvedValue(new Response(null, { status: 401 }));
    bus.emit("message", { source, origin: "null", data });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(source.postMessage).not.toHaveBeenCalled();

    let resolve!: (response: Response) => void;
    fetch.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    bus.emit("message", { source, origin: "null", data });
    frame.src = `${origin}${base}/files/other.html`;
    resolve(Response.json({ prefix: `${base}/view/fresh/files/` }));
    await new Promise(done => setTimeout(done, 0));
    expect(source.postMessage).not.toHaveBeenCalled();
  });
});
