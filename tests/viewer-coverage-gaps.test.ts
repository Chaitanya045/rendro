import { Window as DOMWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managementLabel } from "@/ui/management-ui";
import { externalLinkHref, isContentFrameSource, normalizeLoadedDocumentPath, validDocumentSearch } from "@/lazy-tree/messages";
import { replaceViewerFragment, sendDocumentFragment } from "@/viewer/fragments";
import { createMessageRateLimit } from "@/viewer/message-limits";
import { installViewerFrame, installViewerParent, showViewerUpdateNotice } from "@/viewer/client";
import { classifyDocumentLink, installDocumentNavigation } from "@/viewer/navigation";

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

  it("accepts only an absolute http(s) address on another origin as an external link", () => {
    const own = "https://rendro.test";
    const base = `${own}/organizations/o/projects/p/docs/files/index.html`;
    expect(externalLinkHref("https://other.test/a?b=1#c", base, own)).toBe("https://other.test/a?b=1#c");
    expect(externalLinkHref("http://other.test", base, own)).toBe("http://other.test/");
    expect(externalLinkHref("//other.test/x", base, own)).toBe("https://other.test/x");
    expect(externalLinkHref("https://rendro.test:8443/x", base, own)).toBe("https://rendro.test:8443/x");
    for (const value of ["/organizations", "files/other.html", "https://rendro.test/x", "mailto:a@other.test", "javascript:alert(1)",
      "data:text/html,x", "ftp://other.test/", "https://", "http://[", 1, null, undefined, `https://other.test/${"x".repeat(2048)}`]) {
      expect(externalLinkHref(value, base, own), String(value)).toBeNull();
    }
    // Short as written, long once resolved: the bound applies to what would be shown.
    expect(externalLinkHref("//other.test/\u00e9".padEnd(700, "\u00e9"), base, own)).toBeNull();
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
    showViewerUpdateNotice(win as unknown as Window, "Reload this document to continue.");
    expect((win.document.getElementById("viewer-update-notice") as unknown as HTMLElement).hidden).toBe(false);
    showViewerUpdateNotice(createWindow(origin) as unknown as Window, "Reload this document to continue.");
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
    expect(() => { f.bus.emit("load", { target: {} }); f.bus.emit("load", { target: f.frame }); }).not.toThrow();
    const shown = parentFixture();
    shown.notice.hidden = false;
    shown.bus.emit("load", { target: {} });
    expect(shown.notice.hidden).toBe(false);
    shown.bus.emit("load", { target: shown.frame });
    expect(shown.notice.hidden).toBe(true);
  });

  it("does not run when the shell has no content frame", () => {
    const bus = events();
    const win = createWindow(origin);
    const host = { ...bus, document: win.document, location: { href: origin, origin } } as unknown as Window;
    installViewerParent({ base }, host);
    bus.emit("load", { target: {} });
    bus.emit("message", { source: {}, origin: "null", data: { type: "viewer-renew", requestId: "r", manifestKey: "m" } });
  });

  describe("renewing a frame's ticket", () => {
    const ask = (f: ReturnType<typeof parentFixture>) => f.bus.emit("message", { source: f.source, origin: "null", data: { type: "viewer-renew", requestId: "r", manifestKey: "m" } });
    const settled = () => new Promise(resolve => setTimeout(resolve, 0));

    it("hands the frame a fresh prefix of its own repository", async () => {
      const f = parentFixture();
      f.fetch.mockResolvedValue(Response.json({ prefix: `${base}/view/fresh/files/` }));
      ask(f);
      await vi.waitFor(() => expect(f.source.postMessage).toHaveBeenCalledWith({ type: "viewer-renewed", requestId: "r", prefix: `${base}/view/fresh/files/` }, "*"));
      expect(f.fetch).toHaveBeenCalledWith(`${base}/viewer-ticket?manifestKey=m`, expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    });

    it.each([
      ["a refused renewal", () => new Response(null, { status: 404 }), () => {}],
      ["a prefix outside the repository", () => Response.json({ prefix: "/r/other/repo/view/x/files/" }), () => {}],
      ["an answer for a frame that has moved on", () => Response.json({ prefix: `${base}/view/fresh/files/` }), (f: ReturnType<typeof parentFixture>) => { f.frame.src = `${origin}${base}/files/guide/other.html`; }],
      ["an answer after the frame reloaded", () => Response.json({ prefix: `${base}/view/fresh/files/` }), (f: ReturnType<typeof parentFixture>) => { f.bus.emit("load", { target: f.frame }); }],
    ])("gives the frame nothing for %s", async (_name, answer, meanwhile) => {
      const f = parentFixture();
      let reply!: (response: Response) => void;
      f.fetch.mockReturnValue(new Promise<Response>(resolve => { reply = resolve; }));
      ask(f);
      meanwhile(f);
      reply(answer());
      await settled(); await settled();
      expect(f.source.postMessage).not.toHaveBeenCalled();
    });
  });

  it.each([["another origin", "https://publisher.test/organizations/org/projects/project/docs/files/a.html"],
    ["another path", `${origin}/elsewhere/files/a.html`]])("ignores bridge messages while the frame shows %s", (_name, src) => {
    const f = parentFixture({ src });
    f.bus.emit("message", { source: f.source, origin: "null", data: { type: "viewer-renew", requestId: "r", manifestKey: "m" } });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.source.postMessage).not.toHaveBeenCalled();
  });
});

describe("viewer frame edge cases", () => {
  function frameFixture(html: string, ticket: { issuedAt: number; renewAfter: number } | null = { issuedAt: Date.now(), renewAfter: 150_000 }) {
    const win = new DOMWindow({ url: `${origin}${base}/files/guide/index.html`, settings: { disableCSSFileLoading: true } });
    windows.push(win);
    win.document.write(`<html><head></head><body>${html}</body></html>`);
    const bus = events();
    const parent = { postMessage: vi.fn() };
    const host = { ...bus, location: win.location, document: win.document, parent, setInterval: vi.fn(globalThis.setInterval), clearInterval: globalThis.clearInterval } as unknown as Window;
    installViewerFrame({ base, prefix, manifestKey: "release/manifest.json", ...(ticket ? { ticket } : {}) }, host);
    const renew = (next: string) => bus.emit("message", { source: parent, origin,
      data: { type: "viewer-renewed", requestId: parent.postMessage.mock.lastCall![0].requestId, prefix: next } });
    return { win, bus, parent, renew };
  }

  it("keeps fragment-only and out-of-scope image sources, and renews the ticketed ones", () => {
    vi.useFakeTimers();
    const f = frameFixture(`<img id="sprite" src="#sprite"><img id="outside" src="/outside/a.png"><img id="other" src="https://other.test${prefix}a.png">
      <img id="ticketed" src="${prefix}guide/assets/c.png">`);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    f.bus.emit("focus");
    const next = `${base}/view/fresh/files/`;
    f.renew(next);
    expect(f.win.document.getElementById("sprite")!.getAttribute("src")).toBe("#sprite");
    expect(f.win.document.getElementById("outside")!.getAttribute("src")).toBe("/outside/a.png");
    expect(f.win.document.getElementById("other")!.getAttribute("src")).toBe(`https://other.test${prefix}a.png`);
    expect(f.win.document.getElementById("ticketed")!.getAttribute("src")).toBe(`${origin}${next}guide/assets/c.png`);
  });

  it("installs nothing in a frame that names no ticket (a public repository's)", () => {
    vi.useFakeTimers();
    const f = frameFixture(`<img src="${prefix}a.png">`, null);
    f.bus.emit("focus");
    f.win.document.dispatchEvent(new f.win.Event("error"));
    expect(f.parent.postMessage).not.toHaveBeenCalled();
  });

  it("does not ask for renewal while the tab is hidden", () => {
    vi.useFakeTimers();
    const f = frameFixture("");
    vi.setSystemTime(Date.now() + 16 * 60_000);
    Object.defineProperty(f.win.document, "visibilityState", { configurable: true, value: "hidden" });
    f.win.document.dispatchEvent(new f.win.Event("visibilitychange"));
    expect(f.parent.postMessage).not.toHaveBeenCalled();
    Object.defineProperty(f.win.document, "visibilityState", { configurable: true, value: "visible" });
    f.win.document.dispatchEvent(new f.win.Event("visibilitychange"));
    expect(f.parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "viewer-renew" }), origin);
  });
});

describe("document navigation edge cases", () => {
  const config = { prefix: `${base}/files/`, ticketBase: `${base}/view/`, documentPath: "guide/page.html" };
  const documentURL = origin + config.prefix + config.documentPath;
  function fixture(html: string, options: { standalone?: boolean; readyState?: DocumentReadyState } = {}) {
    const win = createWindow(documentURL, html);
    const bus = events();
    const parent = { postMessage: vi.fn() };
    const location = { href: documentURL, origin, search: "", hash: "" };
    const host: Record<string, unknown> = { ...bus, document: win.document, location };
    host.parent = options.standalone ? host : parent;
    if (options.readyState) Object.defineProperty(win.document, "readyState", { configurable: true, value: options.readyState });
    installDocumentNavigation(config, host as unknown as Window);
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
  ])("leaves %s to the browser", (_name, html) => {
    const f = fixture(html);
    const event = click(f.win, "#l");
    expect(event.defaultPrevented).toBe(false);
    expect(f.parent.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "doc-navigate" }), origin);
  });

  it.each([
    ["a link", '<a id="l" href="https://external.test/page.html?q=1#top">x</a>', "https://external.test/page.html?q=1#top", {}],
    ["a protocol-relative link", '<a id="l" href="//external.test/a b">x</a>', "https://external.test/a%20b", {}],
    ["a link that targets the frame", '<a id="l" target="_self" href="http://external.test:8080/">x</a>', "http://external.test:8080/", {}],
  ])("hands %s to another site to the shell instead of loading it in the frame", (_name, html, href, options) => {
    const f = fixture(html, options);
    expect(click(f.win, "#l").defaultPrevented).toBe(true);
    expect(f.parent.postMessage).toHaveBeenCalledWith({ type: "doc-external", path: config.documentPath, href }, origin);
    expect(f.parent.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "doc-navigate" }), origin);
  });

  it.each([
    ["a mail link", '<a id="l" href="mailto:someone@external.test">x</a>', {}],
    ["a script URL", '<a id="l" href="javascript:void(0)">x</a>', {}],
    ["a link on the viewer origin outside the document scope", `<a id="l" href="${origin}/organizations">x</a>`, {}],
    ["a link too long to confirm", `<a id="l" href="https://external.test/${"x".repeat(2100)}">x</a>`, {}],
    ["a link in a standalone document", '<a id="l" href="https://external.test/page.html">x</a>', { standalone: true }],
  ])("leaves %s to the browser", (_name, html, options) => {
    const f = fixture(html, options);
    expect(click(f.win, "#l").defaultPrevented).toBe(false);
    expect(f.parent.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "doc-external" }), origin);
  });

  it("tells the shell about a press inside the document, and a standalone document has no shell to tell", () => {
    const f = fixture('<p id="p">text</p>');
    f.parent.postMessage.mockClear();
    f.win.document.getElementById("p")!.dispatchEvent(new f.win.MouseEvent("pointerdown", { bubbles: true }));
    expect(f.parent.postMessage).toHaveBeenCalledWith({ type: "doc-pointer", path: config.documentPath }, origin);
    const standalone = fixture('<p id="p">text</p>', { standalone: true });
    standalone.win.document.getElementById("p")!.dispatchEvent(new standalone.win.MouseEvent("pointerdown", { bubbles: true }));
    expect(standalone.parent.postMessage).not.toHaveBeenCalled();
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

  it("swallows a link whose query is unbounded without messaging the shell", () => {
    const f = fixture(`<a id="l" href="other.html?${"q".repeat(4096)}">x</a>`);
    f.parent.postMessage.mockClear();
    expect(click(f.win, "#l").defaultPrevented).toBe(true);
    expect(f.parent.postMessage).not.toHaveBeenCalled();
  });

  it("keeps a standalone document's own fragment link in its native hash history", () => {
    const f = fixture('<a id="l" href="#later">x</a><h2 id="later">Later</h2>', { standalone: true });
    expect(click(f.win, "#l").defaultPrevented).toBe(true);
    expect(f.location.hash).toBe("#later");
    expect(f.parent.postMessage).not.toHaveBeenCalled();
  });

  it("navigates a standalone document itself instead of messaging a shell", () => {
    const f = fixture('<a id="l" href="other.html#top">x</a>', { standalone: true });
    expect(click(f.win, "#l").defaultPrevented).toBe(true);
    expect(f.location.href).toBe(`${origin}${config.prefix}guide/other.html#top`);
  });

  it("reports its destination to the shell once parsed, or at once when parsing already finished", () => {
    const parsing = fixture("", { readyState: "loading" });
    expect(parsing.parent.postMessage).not.toHaveBeenCalled();
    parsing.win.document.dispatchEvent(new parsing.win.Event("DOMContentLoaded"));
    expect(parsing.parent.postMessage).toHaveBeenCalledWith({ type: "doc-loaded", path: "guide/page.html", search: "", fragment: "" }, origin);
    const parsed = fixture("", { readyState: "complete" });
    expect(parsed.parent.postMessage).toHaveBeenCalledOnce();
  });
});
