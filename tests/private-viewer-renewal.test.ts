import { Window as DOMWindow, type HTMLLinkElement as DOMLinkElement, type HTMLStyleElement as DOMStyleElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewerUpdateNotice } from "@/viewer/markup";
import { installViewerFrame, installViewerParent, updateViewerActiveDeployment } from "@/viewer/client";

const origin = "https://rendro.test";
const base = "/organizations/org-a/projects/project-a/docs";
const prefix = `${base}/view/initial/files/`;
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

function frameFixture() {
  const win = new DOMWindow({ url: `${origin}${base}/files/guide/index.html`, settings: {
    disableCSSFileLoading: true, disableJavaScriptFileLoading: true,
  } });
  windows.push(win);
  // Happy DOM synchronously emits an error for disabled CSS loading. Suppress
  // its synthetic network events; each test controls completion explicitly.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- explicitly called with the link receiver below
  const dispatch = win.HTMLLinkElement.prototype.dispatchEvent;
  let completing = false;
  vi.spyOn(win.HTMLLinkElement.prototype, "dispatchEvent").mockImplementation(function (this: DOMLinkElement, event) {
    return completing ? dispatch.call(this, event) : true;
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- explicitly called with the style receiver below
  const dispatchStyle = win.HTMLStyleElement.prototype.dispatchEvent;
  vi.spyOn(win.HTMLStyleElement.prototype, "dispatchEvent").mockImplementation(function (this: DOMStyleElement, event) {
    return completing ? dispatchStyle.call(this, event) : true;
  });
  const settleSheet = (link: DOMLinkElement | DOMStyleElement, type: "load" | "error") => {
    completing = true;
    try { link.dispatchEvent(new win.Event(type)); }
    finally { completing = false; }
  };
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
  const host = { ...bus, location: win.location, document: win.document, parent, setInterval: globalThis.setInterval } as unknown as Window;
  installViewerFrame({ base, prefix, manifestKey: "release/manifest.json", deploymentId: "release" }, host);
  const renew = (next: string) => {
    const request = parent.postMessage.mock.lastCall![0];
    bus.emit("message", { source: parent, origin, data: { type: "viewer-renewed", requestId: request.requestId, prefix: next } });
  };
  return { win, bus, parent, renew, settleSheet };
}

describe("deployment identification origin", () => {
  it.each(["https://publisher.test/assets/", "/outside-project/"])("ignores publisher base %s when choosing the parent", href => {
    const win = new DOMWindow({ url: `${origin}${base}/files/guide.html` });
    windows.push(win);
    win.document.write(`<base href="${href}">`);
    const bus = events();
    const parent = { postMessage: vi.fn() };
    const host = { ...bus, location: win.location, document: win.document, parent } as unknown as Window;
    installViewerFrame({ base, prefix, manifestKey: "release/manifest.json", deploymentId: "release" }, host);
    bus.emit("load");
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "viewer-loaded", deploymentId: "release" }, origin);
    parent.postMessage.mockClear();
    for (const [source, eventOrigin] of [[{}, origin], [parent, "https://publisher.test"], [parent, "null"]]) {
      bus.emit("message", { source, origin: eventOrigin, data: { type: "viewer-identify" } });
    }
    expect(parent.postMessage).not.toHaveBeenCalled();
    bus.emit("message", { source: parent, origin, data: { type: "viewer-identify" } });
    expect(parent.postMessage).toHaveBeenCalledOnce();
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "viewer-loaded", deploymentId: "release" }, origin);
  });
});

describe("private viewer renewal", () => {
  it("refreshes resource URLs over multiple lifetimes without replacing the document or drafts", () => {
    vi.useFakeTimers();
    const { win, parent, renew, settleSheet } = frameFixture();
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
      const links = win.document.querySelectorAll("link");
      expect(links).toHaveLength(2);
      expect(links[1].href).toBe(`${origin}${next}guide/assets/site.css`);
      settleSheet(links[1], "load");
      expect(win.document.querySelectorAll("link")).toHaveLength(1);
      expect(win.document.querySelector("link")).toBe(links[1]);
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

  it("backs off failed stylesheet replacements and retries from the latest ticket", () => {
    vi.useFakeTimers();
    const { win, renew, settleSheet } = frameFixture();
    const original = win.document.querySelector("link")!;
    const attempt = (ticket: string, elapsed: number) => {
      vi.advanceTimersByTime(elapsed);
      win.document.dispatchEvent(new win.Event("error"));
      renew(`${base}/view/${ticket}/files/`);
    };
    attempt("first", 0);
    let links = win.document.querySelectorAll("link");
    expect(links).toHaveLength(2);
    settleSheet(links[1], "error");
    expect(win.document.querySelector("link")).toBe(original);
    attempt("during-backoff", 31_000);
    expect(win.document.querySelectorAll("link")).toHaveLength(1);
    attempt("retry", 31_000);
    links = win.document.querySelectorAll("link");
    expect(links).toHaveLength(2);
    expect(links[1].href).toContain("/view/retry/");
    settleSheet(links[1], "error");
    attempt("longer-backoff", 61_000);
    expect(win.document.querySelectorAll("link")).toHaveLength(1);
    attempt("recovered", 61_000);
    links = win.document.querySelectorAll("link");
    expect(links).toHaveLength(2);
    expect(links[1].href).toContain("/view/recovered/");
    settleSheet(links[1], "load");
    expect(win.document.querySelectorAll("link")).toHaveLength(1);
    expect(original.isConnected).toBe(false);
  });

  it("times out silent inline imports, backs off failures, and recovers with the latest ticket", () => {
    vi.useFakeTimers();
    const { win, renew, settleSheet } = frameFixture();
    const original = win.document.querySelector("style")!;
    original.textContent = String.raw`@\69mport "assets/site.css";`;
    const attempt = (ticket: string, elapsed: number) => {
      vi.advanceTimersByTime(elapsed);
      win.document.dispatchEvent(new win.Event("error"));
      renew(`${base}/view/${ticket}/files/`);
    };
    attempt("first", 0);
    const timedOut = win.document.querySelectorAll("style")[1];
    expect(timedOut.textContent).toContain("/view/first/");
    vi.advanceTimersByTime(30_000);
    expect(win.document.querySelectorAll("style")).toHaveLength(1);
    expect(win.document.querySelector("style")).toBe(original);
    // Late network events from the discarded clone cannot remove the active one.
    settleSheet(timedOut, "load");
    expect(original.isConnected).toBe(true);
    attempt("during-backoff", 1_000);
    expect(win.document.querySelectorAll("style")).toHaveLength(1);
    attempt("retry", 60_000);
    let replacement = win.document.querySelectorAll("style")[1];
    expect(replacement.textContent).toContain("/view/retry/");
    settleSheet(replacement, "error");
    attempt("longer-backoff", 61_000);
    expect(win.document.querySelectorAll("style")).toHaveLength(1);
    attempt("recovered", 61_000);
    replacement = win.document.querySelectorAll("style")[1];
    expect(replacement.textContent).toContain("/view/recovered/");
    settleSheet(replacement, "load");
    expect(win.document.querySelectorAll("style")).toHaveLength(1);
    expect(original.isConnected).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(replacement.isConnected).toBe(true);
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
    const frame = { dataset: {} as Record<string, string>, src: `${origin}${base}/files/guide/index.html`, contentWindow: source };
    const fetch = vi.fn().mockResolvedValue(Response.json({ prefix: `${base}/view/fresh/files/` }));
    const host = { ...bus, document: { getElementById: (id: string) => id === "content-frame" ? frame : null }, location: new URL(origin), fetch } as unknown as Window;
    installViewerParent({ base }, host);
    expect(source.postMessage).toHaveBeenCalledWith({ type: "viewer-identify" }, "*");
    source.postMessage.mockClear();
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

describe("deployment update notice", () => {
  function fixture() {
    const win = new DOMWindow({ url: origin });
    windows.push(win);
    win.document.write(viewerUpdateNotice());
    const bus = events();
    const source = { postMessage: vi.fn() };
    const frame = { dataset: {} as Record<string, string>, src: `${origin}${base}/files/guide/index.html`, contentWindow: source };
    const notice = win.document.querySelector("aside")!;
    const fetch = vi.fn();
    const reload = vi.fn();
    const host = { ...bus, document: { getElementById: (id: string) => id === "content-frame" ? frame : notice },
      location: { href: origin, origin, reload }, fetch } as unknown as Window;
    installViewerParent({ base }, host);
    expect(source.postMessage).toHaveBeenCalledWith({ type: "viewer-identify" }, "*");
    source.postMessage.mockClear();
    const request = () => bus.emit("message", { source, origin: "null", data: {
      type: "viewer-renew", requestId: "renew", manifestKey: "release/manifest.json",
    } });
    return { win, bus, frame, notice, fetch, reload, request, host, source };
  }

  it.each(["before", "after"])("compares a subscription update %s the frame reports its actual manifest", order => {
    const f = fixture();
    const loaded = (deploymentId: string, source = f.source, eventOrigin = "null") => f.bus.emit("message", {
      source, origin: eventOrigin, data: { type: "viewer-loaded", deploymentId },
    });
    if (order === "before") updateViewerActiveDeployment("new", f.host);
    loaded("old", { postMessage: vi.fn() });
    loaded("old", f.source, origin);
    expect(f.frame.dataset.loadedDeployment).toBeUndefined();
    loaded("old");
    if (order === "after") updateViewerActiveDeployment("new", f.host);
    expect(f.notice.hidden).toBe(false);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
    f.bus.emit("load", { target: f.frame });
    loaded("new");
    expect(f.notice.hidden).toBe(true);
    // A failed subscription cannot reuse an old authorized result on navigation.
    updateViewerActiveDeployment(null, f.host);
    f.bus.emit("load", { target: f.frame });
    loaded("another");
    expect(f.notice.hidden).toBe(true);
  });

  it("announces only the exact superseded signal and reloads only on user action", async () => {
    const f = fixture();
    for (const [status, body] of [[401, {}], [404, {}], [503, {}], [409, { code: "unknown" }], [200, { code: "deployment_superseded" }]] as const) {
      f.fetch.mockResolvedValue(Response.json(body, { status }));
      f.request();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(f.notice.hidden).toBe(true);
    }
    f.fetch.mockResolvedValue(Response.json({ code: "deployment_superseded" }, { status: 409 }));
    f.request();
    await vi.waitFor(() => expect(f.notice.hidden).toBe(false));
    expect(f.notice.querySelector('[role="status"]')!.textContent).toBe("A newer version of this document was published.");
    expect(f.reload).not.toHaveBeenCalled();
    f.notice.querySelector("button")!.click();
    f.notice.querySelector("button")!.click();
    expect(f.reload).toHaveBeenCalledOnce();
    f.bus.emit("load", { target: f.frame });
    expect(f.notice.hidden).toBe(true);
  });

  it.each(["different path", "same path reload"])("ignores a superseded reply after %s", async navigation => {
    const f = fixture();
    let resolve!: (response: Response) => void;
    f.fetch.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    f.request();
    if (navigation === "different path") f.frame.src = `${origin}${base}/files/other.html`;
    else f.bus.emit("load", { target: f.frame });
    resolve(Response.json({ code: "deployment_superseded" }, { status: 409 }));
    await new Promise(done => setTimeout(done, 0));
    expect(f.notice.hidden).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
  });
});
