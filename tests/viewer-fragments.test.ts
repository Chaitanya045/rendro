import { Window as DOMWindow } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { classifyDocumentLink, installDocumentNavigation, installShareFragments } from "@/viewer/navigation";
import { scrollToFragment, validFragment } from "@/viewer/fragments";

const origin = "https://rendro.test";
const base = "/organizations/org/projects/project/docs";
const config = { prefix: `${base}/files/`, ticketBase: `${base}/view/`, documentPath: "guide/page.html" };
const documentURL = origin + config.prefix + config.documentPath;
const ticketURL = origin + `${base}/view/test-ticket/files/` + config.documentPath;

describe("document links with a ticket base", () => {
  it.each([
    ["#details", "guide/page.html", "#details", true],
    ["#", "guide/page.html", "#", true],
    ["page.html#details", "guide/page.html", "#details", true],
    ["page.html#", "guide/page.html", "#", true],
    ["other.html#section", "guide/other.html", "#section", false],
    ["other.html", "guide/other.html", "", false],
    ["#日本語", "guide/page.html", "#%E6%97%A5%E6%9C%AC%E8%AA%9E", true],
    ["other.html#caf%C3%A9", "guide/other.html", "#caf%C3%A9", false],
    [`${config.prefix}guide/page.html#details`, "guide/page.html", "#details", true],
    [`${base}/view/renewed-ticket/files/guide/other.html#details`, "guide/other.html", "#details", false],
  ])("classifies %s without losing its fragment", (href, path, fragment, sameDocument) => {
    expect(classifyDocumentLink(href, ticketURL, documentURL, config)).toEqual({ path, search: "", fragment, sameDocument });
  });

  it.each([
    ["?v=1", "page.html?v=1#details", "?v=1", true],
    ["?v=1", "page.html?v=2#details", "?v=2", false],
    ["?v=1", "page.html#details", "", false],
    ["", "page.html?v=2#details", "?v=2", false],
    ["", "page.html?#details", "", true],
    ["?", "page.html#details", "", true],
    ["?v=1", "#details", "?v=1", true],
    ["?a=1&b=2", "page.html?b=2&a=1#details", "?b=2&a=1", false],
  ])("compares normalized document query %s against %s", (query, href, search, sameDocument) => {
    expect(classifyDocumentLink(href, ticketURL, documentURL + query, config))
      .toEqual({ path: config.documentPath, search, fragment: "#details", sameDocument });
  });

  it.each([`${base}/view/test-ticket/files/`, `${base}/view/test-ticket/files/shared/`, "https://publisher.test/"])("keeps bare hashes local with base %s", baseURI => {
    expect(classifyDocumentLink("#details", new URL(baseURI, origin).href, documentURL, config))
      .toEqual({ path: "guide/page.html", search: "", fragment: "#details", sameDocument: true });
  });

  it.each(["https://external.test/page.html#x", `https://external.test${config.prefix}guide/page.html#x`, "mailto:person@example.test", "/outside.html#x", "https://[invalid", "other%ZZ.html#x", "../%2e%2e/other.html#x"])("leaves external or invalid link %s alone", href => {
    expect(classifyDocumentLink(href, ticketURL, documentURL, config)).toBeNull();
  });

  it("honors publisher bases for non-bare links", () => {
    expect(classifyDocumentLink("page.html#x", origin + `${base}/view/test-ticket/files/shared/`, documentURL, config))
      .toEqual({ path: "shared/page.html", search: "", fragment: "#x", sameDocument: false });
  });
});

describe("fragment targets and bridge data", () => {
  it.each([undefined, null, {}, 1, "no-hash", "#" + "x".repeat(4096)])("rejects invalid or unbounded fragment %s", value => {
    expect(validFragment(value)).toBe(false);
  });

  it("matches decoded literal IDs, then anchor names, then the top fallback", async () => {
    const win = new DOMWindow({ url: documentURL });
    const host = win as unknown as Window;
    try {
      for (const id of ["日本語", "café", 'x"][onclick="bad', "%ZZ", "top"]) {
        const element = win.document.createElement("h2");
        element.id = id;
        win.document.body.append(element);
        const scroll = vi.spyOn(element, "scrollIntoView");
        scrollToFragment("#" + encodeURIComponent(id), host);
        expect(scroll).toHaveBeenCalledOnce();
      }
      const anchor = win.document.createElement("a");
      anchor.setAttribute("name", "legacy");
      win.document.body.append(anchor);
      const named = vi.spyOn(anchor, "scrollIntoView");
      scrollToFragment("#legacy", host);
      expect(named).toHaveBeenCalledOnce();
      const id = win.document.createElement("h2");
      id.id = "legacy";
      win.document.body.append(id);
      const byId = vi.spyOn(id, "scrollIntoView");
      scrollToFragment("#legacy", host);
      expect(byId).toHaveBeenCalledOnce();
      expect(named).toHaveBeenCalledOnce();
      const emptyAnchor = win.document.createElement("a");
      emptyAnchor.setAttribute("name", "");
      win.document.body.append(emptyAnchor);
      const emptyScroll = vi.spyOn(emptyAnchor, "scrollIntoView");
      const top = vi.spyOn(win, "scrollTo");
      scrollToFragment("#missing", host);
      scrollToFragment("", host);
      expect(top).not.toHaveBeenCalled();
      scrollToFragment("#", host);
      scrollToFragment("#ToP", host);
      expect(top).toHaveBeenCalledTimes(2);
      expect(emptyScroll).not.toHaveBeenCalled();
    } finally { await win.happyDOM.close(); }
  });

  it("ignores prevented/widget clicks and validates the parent source, origin and path", async () => {
    const win = new DOMWindow({ url: documentURL });
    try {
      win.document.body.innerHTML = '<h2 id="details">Details</h2><a href="#details">Link</a><div id="commentor-host"><a href="#details">Comment anchor</a></div>';
      const scroll = vi.spyOn(win.document.getElementById("details")!, "scrollIntoView");
      installDocumentNavigation(config, win as unknown as Window);
      const link = win.document.querySelector("a")!;
      link.addEventListener("click", event => event.preventDefault());
      link.click();
      (win.document.querySelector("#commentor-host a") as unknown as HTMLAnchorElement).click();
      const data = { type: "doc-fragment", path: config.documentPath, fragment: "#details" };
      for (const event of [
        { data, source: null, origin },
        { data, source: win.parent, origin: "https://attacker.test" },
        { data: { ...data, path: "another.html" }, source: win.parent, origin },
        { data: { ...data, fragment: {} }, source: win.parent, origin },
      ]) win.dispatchEvent(new win.MessageEvent("message", event));
      expect(scroll).not.toHaveBeenCalled();
      win.dispatchEvent(new win.MessageEvent("message", { data, source: win.parent, origin }));
      expect(scroll).toHaveBeenCalledOnce();
    } finally { await win.happyDOM.close(); }
  });
});

describe("share fragment restoration", () => {
  it("discards an oversized initial fragment while restoring a bounded document query", async () => {
    const win = new DOMWindow({ url: origin + "/s/fixture#" + "x".repeat(4096) });
    try {
      win.document.body.innerHTML = '<iframe id="content-frame"></iframe>';
      const frame = win.document.querySelector("iframe")!;
      win.history.replaceState({ preserved: true }, "", win.location.href);
      installShareFragments(config, win as unknown as Window);
      win.dispatchEvent(new win.MessageEvent("message", {
        data: { type: "doc-loaded", path: config.documentPath, search: "?v=2", fragment: "#section" },
        source: frame.contentWindow as DOMWindow, origin: "null",
      }));
      expect(win.location.hash).toBe("#section");
      expect(new URL(win.location.href).searchParams.get("docQuery")).toBe("?v=2");
      expect(win.history.state).toEqual({ preserved: true });
    } finally { await win.happyDOM.close(); }
  });

  it.each(["popstate", "doc-fragment"])("discards a pending initial deep link after %s", async action => {
    const win = new DOMWindow({ url: origin + "/s/fixture#old" });
    try {
      win.document.body.innerHTML = '<iframe id="content-frame"></iframe>';
      const frame = win.document.querySelector("iframe")!;
      installShareFragments(config, win as unknown as Window);
      const report = (type: string, fragment: string) => win.dispatchEvent(new win.MessageEvent("message", {
        data: { type, path: config.documentPath, search: "", fragment }, source: frame.contentWindow as DOMWindow, origin: "null",
      }));
      if (action === "popstate") win.dispatchEvent(new win.PopStateEvent("popstate"));
      else report("doc-fragment", "#details");
      report("doc-loaded", "#details");
      expect(win.location.hash).toBe("#details");
      // Happy DOM emits hashchange for replaceState; drain it before the next report.
      await new Promise(resolve => setTimeout(resolve, 0));
      report("doc-loaded", "#section");
      await vi.waitFor(() => expect(win.location.hash).toBe("#section"));
      await new Promise(resolve => setTimeout(resolve, 0));
      report("doc-loaded", "");
      await vi.waitFor(() => expect(win.location.hash).toBe(""));
    } finally { await win.happyDOM.close(); }
  });
});
