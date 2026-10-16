import { Window as DOMWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managementLabel } from "@/ui/management-ui";
import { isContentFrameSource, normalizeLoadedDocumentPath, validDocumentSearch } from "@/lazy-tree/messages";
import { replaceViewerFragment, sendDocumentFragment } from "@/viewer/fragments";
import { createMessageRateLimit } from "@/viewer/message-limits";
import { createStylesheetRenewer } from "@/viewer/stylesheets";
import { installViewerFrame, installViewerParent, showViewerUpdateNotice } from "@/viewer/client";
import { classifyDocumentLink, installDocumentNavigation, installShareFragments } from "@/viewer/navigation";

const origin = "https://rendro.test";
const base = "/organizations/org/projects/project/docs";
const prefix = `${base}/view/initial/files/`;
const windows: DOMWindow[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const win of windows.splice(0)) await win.happyDOM.close();
});
function createWindow(url: string, html = "") {
  const win = new DOMWindow({ url }); windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}
function events() {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  return {
    addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => handlers.set(type, [...(handlers.get(type) ?? []), handler])),
    emit: (type: string, event: unknown = {}) => handlers.get(type)?.forEach(handler => handler(event)),
  };
}

describe("shared labels and message validators", () => {
  it.each([[null, ""], [undefined, ""], ["", ""], ["needs_review", "Needs Review"]])("labels %s defensively", (value, label) => {
    expect(managementLabel("status", value)).toBe(label);
  });

  it("rejects loaded paths that escape their namespace and ignores foreign frame sources", () => {
    expect(normalizeLoadedDocumentPath("org/../secret.html", "org")).toBeNull();
    expect(normalizeLoadedDocumentPath("org/guide//page.html", "org")).toBeNull();
    expect(normalizeLoadedDocumentPath("org/guide/page.html", "org")).toBe("org/guide/page.html");
    expect(normalizeLoadedDocumentPath("guide/page.html", "org")).toBe("org/guide/page.html");
    const content = {} as WindowProxy;
    expect(isContentFrameSource(content, content)).toBe(true);
    expect(isContentFrameSource(content, null)).toBe(false);
    expect(isContentFrameSource(null, null)).toBe(false);
    expect(validDocumentSearch("?a=1")).toBe(true);
    for (const value of ["?a#b", "?a\nb", "a=1", 1, "?" + "x".repeat(4096)]) expect(validDocumentSearch(value)).toBe(false);
  });

  it("rate-limits with the page clock by default", () => {
    const now = vi.spyOn(performance, "now");
    const allow = createMessageRateLimit(100);
    now.mockReturnValue(1000); expect(allow()).toBe(true);
    now.mockReturnValue(1099); expect(allow()).toBe(false);
    now.mockReturnValue(1100); expect(allow()).toBe(true);
  });

  it("ignores invalid fragments instead of rewriting history or messaging the frame", () => {
    const win = createWindow(`${origin}/s/fixture#kept`);
    const replace = vi.spyOn(win.history, "replaceState");
    replaceViewerFragment("no-hash", win as unknown as Window);
    replaceViewerFragment("#" + "x".repeat(4096), win as unknown as Window);
    expect(replace).not.toHaveBeenCalled(); expect(win.location.hash).toBe("#kept");
    const postMessage = vi.fn();
    const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;
    sendDocumentFragment(frame, "guide/page.html", "no-hash");
    sendDocumentFragment(frame, "guide/page.html", "#" + "x".repeat(4096));
    expect(postMessage).not.toHaveBeenCalled();
    sendDocumentFragment(frame, "guide/page.html", "#ok");
    expect(postMessage).toHaveBeenCalledWith({ type: "doc-fragment", path: "guide/page.html", fragment: "#ok" }, "*");
  });
});

describe("stylesheet renewal teardown", () => {
  const style = (win: DOMWindow, css: string) => {
    const element = win.document.createElement("style");
    element.textContent = css; win.document.head.append(element);
    return element as unknown as HTMLStyleElement;
  };
  const importing = ".a{background:url(old.png)}@import url(base.css);";
  const replace = (css: string) => css.replaceAll("old.png", "new.png");

  it.each(["removed", "retargeted"])("never resurrects a sheet %s by publisher script while its replacement loads", action => {
    vi.useFakeTimers();
    const win = createWindow(origin);
    const sheet = style(win, importing);
    const renew = createStylesheetRenewer();
    renew(sheet, replace);
    const pending = win.document.head.querySelectorAll("style");
    expect(pending).toHaveLength(2);
    if (action === "removed") sheet.remove(); else sheet.textContent = ".publisher{color:red}";
    vi.advanceTimersByTime(30_000);
    expect(win.document.head.querySelectorAll("style")).toHaveLength(action === "removed" ? 0 : 1);
    if (action === "retargeted") expect(win.document.head.querySelector("style")!.textContent).toBe(".publisher{color:red}");
    // The abandoned sheet starts from its current value, not stale retry state.
    if (action === "retargeted") {
      renew(sheet, css => css + "/*x*/");
      expect(sheet.textContent).toBe(".publisher{color:red}/*x*/");
    }
  });

  it("ignores a link without an href", () => {
    const win = createWindow(origin);
    const link = win.document.createElement("link");
    link.rel = "stylesheet"; win.document.head.append(link);
    const rewrite = vi.fn(() => "never");
    createStylesheetRenewer()(link as unknown as HTMLLinkElement, rewrite);
    expect(rewrite).not.toHaveBeenCalled();
    expect(win.document.head.querySelectorAll("link")).toHaveLength(1);
  });
});

describe("viewer parent shell edge cases", () => {
  const frameSrc = `${origin}${base}/files/guide/index.html`;
  function parentFixture(options: { notice?: boolean; src?: string } = {}) {
    const win = createWindow(origin, options.notice === false ? "" : '<aside id="viewer-update-notice" hidden><span role="status"></span><button type="button">Reload</button></aside>');
    const source = { postMessage: vi.fn() };
    const frame = { dataset: {} as Record<string, string>, src: options.src ?? frameSrc, contentWindow: source };
    const bus = events();
    const fetch = vi.fn(), reload = vi.fn();
    const host = { ...bus, document: { getElementById: (id: string) => id === "content-frame" ? frame : win.document.getElementById(id) },
      location: { href: origin, origin, reload }, fetch } as unknown as Window;
    installViewerParent({ base }, host);
    source.postMessage.mockClear();
    return { win, bus, frame, source, fetch, reload, notice: win.document.getElementById("viewer-update-notice") as unknown as HTMLElement };
  }

  it("shows an update notice that has no status region", () => {
    const win = createWindow(origin, '<aside id="viewer-update-notice" hidden></aside>');
    showViewerUpdateNotice(win as unknown as Window);
    expect((win.document.getElementById("viewer-update-notice") as unknown as HTMLElement).hidden).toBe(false);
    showViewerUpdateNotice(createWindow(origin) as unknown as Window);
  });

  it("does not reload from a hidden or already-activated notice", () => {
    const f = parentFixture();
    const button = f.notice.querySelector("button")!;
    button.click();
    expect(f.reload).not.toHaveBeenCalled();
    f.notice.hidden = false;
    button.click();
    expect(f.reload).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    // A disabled button never dispatches clicks, but a synthetic one is still ignored.
    button.dispatchEvent(new f.win.MouseEvent("click") as unknown as Event);
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it("tolerates shells without a notice and ignores loads from other elements", () => {
    const f = parentFixture({ notice: false });
    f.frame.dataset.loadedDeployment = "old";
    f.bus.emit("load", { target: {} });
    expect(f.frame.dataset.loadedDeployment).toBe("old");
    f.bus.emit("load", { target: f.frame });
    expect(f.frame.dataset.loadedDeployment).toBeUndefined();
  });

  it("does not run when the shell has no content frame", () => {
    const bus = events();
    const win = createWindow(origin);
    const host = { ...bus, document: win.document, location: { href: origin, origin } } as unknown as Window;
    installViewerParent({ base }, host);
    bus.emit("load", { target: {} });
    bus.emit("message", { source: {}, origin: "null", data: { type: "viewer-loaded", deploymentId: "x" } });
  });

  it.each([["another origin", "https://publisher.test/organizations/org/projects/project/docs/files/a.html"],
    ["another path", `${origin}/elsewhere/files/a.html`]])("ignores bridge messages while the frame shows %s", (_name, src) => {
    const f = parentFixture({ src });
    f.bus.emit("message", { source: f.source, origin: "null", data: { type: "viewer-loaded", deploymentId: "x" } });
    f.bus.emit("message", { source: f.source, origin: "null", data: { type: "viewer-renew", requestId: "r", manifestKey: "m" } });
    expect(f.frame.dataset.loadedDeployment).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.source.postMessage).not.toHaveBeenCalled();
  });
});

describe("viewer frame edge cases", () => {
  const config = { base, prefix, manifestKey: "release/manifest.json", deploymentId: "release" };
  function frameFixture(html: string) {
    const win = new DOMWindow({ url: `${origin}${base}/files/guide/index.html`, settings: { disableCSSFileLoading: true } });
    windows.push(win);
    win.document.write(`<html><head><base data-rendro-viewer href="${origin}${prefix}guide/index.html"></head><body>${html}</body></html>`);
    const bus = events();
    const parent = { postMessage: vi.fn() };
    const host = { ...bus, location: win.location, document: win.document, parent, setInterval: globalThis.setInterval } as unknown as Window;
    installViewerFrame(config, host);
    const renew = (next: string) => bus.emit("message", { source: parent, origin,
      data: { type: "viewer-renewed", requestId: parent.postMessage.mock.lastCall![0].requestId, prefix: next } });
    return { win, bus, parent, renew };
  }

  it("keeps fragment-only and out-of-scope resource URLs, and renews the rest", () => {
    vi.useFakeTimers();
    const f = frameFixture(`<img id="sprite" src="#sprite"><img id="outside" src="/outside/a.png">
      <div id="styled" style="background:url(/outside/b.png),url(assets/c.png)"></div>`);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    f.bus.emit("focus");
    const next = `${base}/view/fresh/files/`;
    f.renew(next);
    expect(f.win.document.getElementById("sprite")!.getAttribute("src")).toBe("#sprite");
    expect(f.win.document.getElementById("outside")!.getAttribute("src")).toBe("/outside/a.png");
    const style = f.win.document.getElementById("styled")!.getAttribute("style")!;
    expect(style).toContain("url(/outside/b.png)");
    expect(style).toContain(`${next}guide/assets/c.png`);
  });

  it("does not ask for renewal while the tab is hidden", () => {
    vi.useFakeTimers();
    const f = frameFixture("");
    vi.setSystemTime(Date.now() + 16 * 60_000);
    Object.defineProperty(f.win.document, "hidden", { configurable: true, value: true });
    f.win.document.dispatchEvent(new f.win.Event("visibilitychange"));
    expect(f.parent.postMessage).not.toHaveBeenCalled();
    Object.defineProperty(f.win.document, "hidden", { configurable: true, value: false });
    f.win.document.dispatchEvent(new f.win.Event("visibilitychange"));
    expect(f.parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "viewer-renew" }), origin);
  });
});

describe("document navigation edge cases", () => {
  const config = { prefix: `${base}/files/`, ticketBase: `${base}/view/`, documentPath: "guide/page.html" };
  const documentURL = origin + config.prefix + config.documentPath;
  function fixture(html: string, options: { standalone?: boolean; singleDocument?: boolean; readyState?: DocumentReadyState } = {}) {
    const win = createWindow(documentURL, html);
    const bus = events();
    const parent = { postMessage: vi.fn() };
    const location = { href: documentURL, origin, search: "", hash: "" };
    const host: Record<string, unknown> = { ...bus, document: win.document, location };
    host.parent = options.standalone ? host : parent;
    if (options.readyState) Object.defineProperty(win.document, "readyState", { configurable: true, value: options.readyState });
    installDocumentNavigation({ ...config, singleDocument: options.singleDocument }, host as unknown as Window);
    return { win, bus, parent, location };
  }
  const click = (win: DOMWindow, selector: string) => {
    const event = new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    win.document.querySelector(selector)!.dispatchEvent(event);
    return event;
  };

  it("ignores guessed paths with empty segments", () => {
    expect(classifyDocumentLink(`${config.prefix}guide//page.html`, documentURL, documentURL, config)).toBeNull();
  });

  it.each([
    ["_blank", '<a id="l" target="_blank" href="other.html">x</a>'],
    ["a named window", '<a id="l" target="elsewhere" href="other.html">x</a>'],
    ["a download", '<a id="l" download href="other.html">x</a>'],
    ["an anchor with no href", '<a id="l" name="target">x</a>'],
    ["an external link", '<a id="l" href="https://external.test/page.html">x</a>'],
  ])("leaves %s to the browser", (_name, html) => {
    const f = fixture(html);
    const event = click(f.win, "#l");
    expect(event.defaultPrevented).toBe(false);
    expect(f.parent.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "doc-navigate" }), origin);
  });

  it.each(["_self", "content-frame"])("routes a %s target through the shell", target => {
    const f = fixture(`<a id="l" target="${target}" href="other.html#top">x</a>`);
    expect(click(f.win, "#l").defaultPrevented).toBe(true);
    expect(f.parent.postMessage).toHaveBeenCalledWith({ type: "doc-navigate", path: "guide/other.html", search: "", fragment: "#top" }, origin);
  });

  it("swallows a link whose fragment is unbounded without messaging the shell", () => {
    const f = fixture(`<a id="l" href="other.html#${"x".repeat(4096)}">x</a>`);
    f.parent.postMessage.mockClear();
    expect(click(f.win, "#l").defaultPrevented).toBe(true);
    expect(f.parent.postMessage).not.toHaveBeenCalled();
  });

  it("navigates a standalone document itself instead of messaging a shell", () => {
    const f = fixture('<a id="l" href="other.html#top">x</a>', { standalone: true });
    expect(click(f.win, "#l").defaultPrevented).toBe(true);
    expect(f.location.href).toBe(`${origin}${config.prefix}guide/other.html#top`);
  });

  it("reports a single-document destination immediately when loading already finished and after history restores", () => {
    const f = fixture("", { singleDocument: true, readyState: "complete" });
    expect(f.parent.postMessage).toHaveBeenCalledOnce();
    expect(f.parent.postMessage).toHaveBeenCalledWith({ type: "doc-loaded", path: "guide/page.html", search: "", fragment: "" }, origin);
    f.bus.emit("pageshow", { persisted: false });
    expect(f.parent.postMessage).toHaveBeenCalledOnce();
    f.bus.emit("pageshow", { persisted: true });
    expect(f.parent.postMessage).toHaveBeenCalledTimes(2);
    f.bus.emit("popstate");
    expect(f.parent.postMessage).toHaveBeenCalledTimes(3);
  });

  it("does nothing when a share shell has no content frame", () => {
    const win = createWindow(`${origin}/s/fixture`);
    const bus = events();
    installShareFragments({ ...config, singleDocument: true }, { ...bus, document: win.document, location: win.location } as unknown as Window);
    expect(bus.addEventListener).not.toHaveBeenCalled();
  });

  it("lets the shell's own hash override the first reported fragment and then own it", async () => {
    const win = createWindow(`${origin}/s/fixture#old`, '<iframe id="content-frame"></iframe>');
    const frame = win.document.querySelector("iframe")!;
    const send = vi.spyOn(frame.contentWindow as DOMWindow, "postMessage");
    installShareFragments({ ...config, singleDocument: true }, win as unknown as Window);
    win.location.hash = "#new";
    await win.happyDOM.whenAsyncComplete();
    expect(send).toHaveBeenCalledWith({ type: "doc-fragment", path: config.documentPath, fragment: "#new" }, "*");
    win.dispatchEvent(new win.MessageEvent("message", {
      data: { type: "doc-loaded", path: config.documentPath, search: "", fragment: "#reported" },
      source: frame.contentWindow as DOMWindow, origin: "null",
    }));
    expect(win.location.hash).toBe("#new");
  });
});
