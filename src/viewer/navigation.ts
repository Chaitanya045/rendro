import { validRelativeDocumentPath } from "../lazy-tree/messages";
import { shouldUseNativeLinkNavigation } from "../lazy-tree/navigation";
import { replaceViewerFragment, scrollToFragment, sendDocumentFragment, validFragment } from "./fragments";

interface FragmentMessage { type?: unknown; path?: unknown; fragment?: unknown }

export interface DocumentNavigationConfig {
  prefix: string;
  documentPath: string;
  loadedPath?: string;
  ticketBase?: string;
  singleDocument?: boolean;
}

export function classifyDocumentLink(href: string, baseURI: string, documentURL: string, config: DocumentNavigationConfig): {
  path: string; fragment: string; sameDocument: boolean;
} | null {
  // A bare hash always refers to this document, even when the ticket/publisher
  // base points at a different URL or directory. Never navigate to that base.
  if (href.trim().startsWith("#")) {
    const fragment = new URL(href.trim(), documentURL).hash || "#";
    return { path: config.documentPath, fragment, sameDocument: true };
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
    return { path, fragment, sameDocument: path === config.documentPath && fragment !== "" };
  } catch { return null; }
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
    if (host.parent !== host) host.parent.postMessage({ type: "doc-loaded", path: config.loadedPath ?? config.documentPath }, origin);
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", loaded, { once: true });
  else loaded();
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
    if (!link || (config.singleDocument && !link.sameDocument)) return;
    event.preventDefault();
    if (!validFragment(link.fragment)) return;
    if (link.sameDocument) {
      scrollToFragment(link.fragment, host);
      if (host.parent !== host) host.parent.postMessage({ type: "doc-fragment", path: link.path, fragment: link.fragment }, origin);
      return;
    }
    if (host.parent === host) { host.location.href = anchor.href; return; }
    host.parent.postMessage({ type: "doc-navigate", path: link.path, fragment: link.fragment }, origin);
  });
}

/** Single-document shares have no tree; their grant still cannot open other HTML. */
export function installShareFragments(config: DocumentNavigationConfig, host: Window = window): void {
  const frame = host.document.getElementById("content-frame") as HTMLIFrameElement | null;
  if (!frame) return;
  const send = () => sendDocumentFragment(frame, config.documentPath, host.location.hash);
  frame.addEventListener("load", send);
  host.addEventListener("hashchange", send);
  host.addEventListener("message", (event: MessageEvent<FragmentMessage>) => {
    if (event.source !== frame.contentWindow || event.origin !== "null" || event.data?.path !== config.documentPath) return;
    if (event.data.type === "doc-loaded") send();
    if (event.data.type === "doc-fragment" && validFragment(event.data.fragment)) replaceViewerFragment(event.data.fragment, host);
  });
}
