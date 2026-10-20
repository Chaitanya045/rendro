import { newTabLinkHref, validDocumentSearch, validRelativeDocumentPath } from "../lazy-tree/messages";
import { shouldUseNativeLinkNavigation } from "../lazy-tree/navigation";
import { scrollToFragment, validFragment } from "./fragments";

interface FragmentMessage { type?: unknown; path?: unknown; search?: unknown; fragment?: unknown }

export interface DocumentNavigationConfig {
  prefix: string;
  documentPath: string;
  ticketBase?: string;
}

export function classifyDocumentLink(href: string, baseURI: string, documentURL: string, config: DocumentNavigationConfig): {
  path: string; search: string; fragment: string; sameDocument: boolean;
} | null {
  // A bare hash always refers to this document, even when the ticket/publisher
  // base points at a different URL or directory. Never navigate to that base.
  if (href.trim().startsWith("#")) {
    const fragment = new URL(href.trim(), documentURL).hash || "#";
    return { path: config.documentPath, search: new URL(documentURL).search, fragment, sameDocument: true };
  }
  try {
    const url = new URL(href, baseURI);
    if (url.origin !== new URL(documentURL).origin) return null;
    let prefix = config.prefix;
    if (!url.pathname.startsWith(prefix)) {
      if (!config.ticketBase || !url.pathname.startsWith(config.ticketBase)) return null;
      const rest = url.pathname.slice(config.ticketBase.length);
      const ticket = /^[-\w.]+\/files\//.exec(rest);
      if (!ticket) return null;
      prefix = config.ticketBase + ticket[0];
    }
    const path = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    if (!validRelativeDocumentPath(path)) return null;
    const fragment = url.hash || (url.href.includes("#") ? "#" : "");
    // URL.search normalizes absent and empty queries to "". Keep all other
    // query bytes/order: publisher code may give them distinct meanings.
    return { path, search: url.search, fragment,
      sameDocument: path === config.documentPath && url.search === new URL(documentURL).search && fragment !== "" };
  } catch { return null; }
}

/** What the frame's own response took, as its Server-Timing and Navigation Timing tell it (#282). */
export interface DocumentResponseTiming {
  /** The document's own address (path and query), so the shell can match the report to its navigation. */
  url: string;
  tier?: string;
  server?: number;
  response: number;
}

/**
 * Only the document can read its Server-Timing: an opaque-origin frame never
 * exposes it to the shell's resource timing, whatever `Timing-Allow-Origin`
 * says. So the frame reports it with its `doc-loaded` announcement, for the
 * shell's real-user monitoring. Numbers and a tier name only.
 */
export function documentResponseTiming(host: Window): DocumentResponseTiming | undefined {
  const entry = host.performance?.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!entry) return undefined;
  const named = (name: string) => entry.serverTiming.find(timing => timing.name === name);
  return {
    url: host.location.pathname + host.location.search,
    tier: named("cache")?.description, server: named("total")?.duration, response: entry.responseEnd - entry.startTime,
  };
}

export function installDocumentNavigation(config: DocumentNavigationConfig, host: Window = window): void {
  const doc = host.document;
  const origin = host.location.origin;
  host.addEventListener("message", (event: MessageEvent<FragmentMessage>) => {
    if (event.source !== host.parent || event.origin !== origin || event.data?.type !== "doc-fragment"
      || event.data.path !== config.documentPath || !validFragment(event.data.fragment)) return;
    scrollToFragment(event.data.fragment, host);
  });
  function loaded() {
    if (host.parent !== host) host.parent.postMessage({ type: "doc-loaded", path: config.documentPath,
      search: host.location.search, fragment: host.location.hash, timing: documentResponseTiming(host) }, origin);
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", loaded, { once: true });
  else loaded();
  // A press in this frame never reaches the shell's own handlers, and not every engine reports the shell losing focus.
  // Tell the shell, so its open menus close; the message carries nothing and changes nothing else.
  if (host.parent !== host) {
    doc.addEventListener("pointerdown", () => host.parent.postMessage({ type: "doc-pointer", path: config.documentPath }, origin),
      { capture: true, passive: true });
  }
  doc.addEventListener("click", event => {
    if (event.defaultPrevented || shouldUseNativeLinkNavigation(event)) return;
    // Comment UI lives in a shadow root; leave its own anchoring/handlers alone.
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a");
    if (!anchor || anchor.closest("#commentor-host") || anchor.hasAttribute("download")
      || (anchor.target && anchor.target !== "_self" && anchor.target !== "content-frame")) return;
    const href = anchor.getAttribute("href");
    if (href === null) return;
    const link = classifyDocumentLink(href, doc.baseURI, host.location.href, config);
    if (!link) {
      // Only the shell loads documents into this frame (#296). Another site cannot load here, and a page of this one
      // that is not a repository document must not: no web link navigates the frame. The parent asks first and opens
      // either in a new tab (one too long to show is dropped). Standalone documents keep their native navigation.
      if (host.parent === host || (anchor.protocol !== "http:" && anchor.protocol !== "https:")) return;
      event.preventDefault();
      const external = newTabLinkHref(href, doc.baseURI);
      if (external) host.parent.postMessage({ type: "doc-external", path: config.documentPath, href: external }, origin);
      return;
    }
    if (!validDocumentSearch(link.search)) { event.preventDefault(); return; }
    event.preventDefault();
    if (!validFragment(link.fragment)) return;
    if (link.sameDocument) {
      scrollToFragment(link.fragment, host);
      if (host.parent !== host) host.parent.postMessage({ type: "doc-fragment", path: link.path, fragment: link.fragment }, origin);
      // Resolve against the actual document, never the ticket/publisher base.
      // Native hash history restores standalone documents on reload and Back.
      else host.location.hash = link.fragment;
      return;
    }
    if (host.parent === host) { host.location.href = anchor.href; return; }
    host.parent.postMessage({ type: "doc-navigate", path: link.path, search: link.search, fragment: link.fragment }, origin);
  });
}
