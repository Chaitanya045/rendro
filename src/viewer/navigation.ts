import { coalesceMessage } from "./message-limits";
import { externalLinkHref, validDocumentSearch, validRelativeDocumentPath } from "../lazy-tree/messages";
import { shouldUseNativeLinkNavigation } from "../lazy-tree/navigation";
import { replaceViewerFragment, scrollToFragment, sendDocumentFragment, validFragment } from "./fragments";

interface FragmentMessage { type?: unknown; path?: unknown; search?: unknown; fragment?: unknown }

export interface DocumentNavigationConfig {
  prefix: string;
  documentPath: string;
  loadedPath?: string;
  ticketBase?: string;
  legacyPrefix?: string;
  singleDocument?: boolean;
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
    let prefix = config.legacyPrefix && url.pathname.startsWith(config.legacyPrefix) ? config.legacyPrefix : config.prefix;
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

export function installDocumentNavigation(config: DocumentNavigationConfig, host: Window = window): void {
  const doc = host.document;
  const origin = host.location.origin;
  host.addEventListener("message", (event: MessageEvent<FragmentMessage>) => {
    if (event.source !== host.parent || event.origin !== origin || event.data?.type !== "doc-fragment"
      || event.data.path !== config.documentPath || !validFragment(event.data.fragment)) return;
    // Native share history belongs to the iframe. Keep its URL authoritative
    // even for fragment-only clicks and the initial shell deep link.
    if (config.singleDocument) replaceViewerFragment(event.data.fragment, host);
    scrollToFragment(event.data.fragment, host);
  });
  function loaded() {
    if (host.parent !== host) host.parent.postMessage({ type: "doc-loaded", path: config.loadedPath ?? config.documentPath,
      search: host.location.search, fragment: host.location.hash }, origin);
  }
  if (config.singleDocument) {
    // Report the destination after native navigation/restoration, never while
    // still on the outgoing history entry. Wait for layout-affecting resources.
    if (doc.readyState === "complete") loaded();
    else host.addEventListener("load", loaded, { once: true });
    host.addEventListener("pageshow", event => { if (event.persisted) loaded(); });
    host.addEventListener("popstate", loaded);
  } else if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", loaded, { once: true });
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
      // The frame cannot load another site, so a plain click would do nothing the reader can see. The parent asks first
      // and opens it in a new tab. Shares and standalone documents keep their native navigation.
      const external = !config.singleDocument && host.parent !== host ? externalLinkHref(href, doc.baseURI, origin) : null;
      if (external) {
        event.preventDefault();
        host.parent.postMessage({ type: "doc-external", path: config.documentPath, href: external }, origin);
      }
      return;
    }
    if (!validDocumentSearch(link.search)) { event.preventDefault(); return; }
    if (config.singleDocument && !link.sameDocument) {
      // Shares retain native document navigation and server-enforced grant scope.
      // The destination reports its own fragment once it has loaded.
      return;
    }
    event.preventDefault();
    if (!validFragment(link.fragment)) return;
    if (link.sameDocument) {
      scrollToFragment(link.fragment, host);
      if (host.parent !== host) {
        if (config.singleDocument) replaceViewerFragment(link.fragment, host);
        host.parent.postMessage({ type: "doc-fragment", path: link.path, fragment: link.fragment }, origin);
      }
      // Resolve against the actual document, never the ticket/publisher base.
      // Native hash history restores standalone documents on reload and Back.
      else host.location.hash = link.fragment;
      return;
    }
    if (host.parent === host) { host.location.href = anchor.href; return; }
    host.parent.postMessage({ type: "doc-navigate", path: link.path, search: link.search, fragment: link.fragment }, origin);
  });
}

/** Single-document shares have no tree; their grant still cannot open other HTML. */
export function installShareFragments(config: DocumentNavigationConfig, host: Window = window): void {
  const frame = host.document.getElementById("content-frame") as HTMLIFrameElement | null;
  if (!frame) return;
  // Only the first document inherits a shell deep link. Later native loads and
  // Back/Forward own their fragment, reported by the opaque iframe bridge.
  let initialFragment: string | undefined = host.location.hash || undefined;
  const send = () => sendDocumentFragment(frame, config.documentPath, host.location.hash);
  host.addEventListener("popstate", () => { initialFragment = undefined; update.cancel(); });
  host.addEventListener("hashchange", () => {
    update.cancel();
    if (initialFragment !== undefined) initialFragment = host.location.hash;
    send();
  });
  const update = coalesceMessage((data: FragmentMessage) => {
    if (data.type === "doc-loaded" && validFragment(data.fragment) && validDocumentSearch(data.search)) {
      // The iframe owns native history. Replace only after its destination loads;
      // changing the outgoing shell entry would corrupt Back/Forward restoration.
      // Query bytes are nested data, never part of the grant path or token.
      const url = new URL(host.location.href);
      url.searchParams.set("doc", config.documentPath);
      if (data.search) url.searchParams.set("docQuery", data.search);
      else url.searchParams.delete("docQuery");
      url.hash = validFragment(initialFragment) ? initialFragment : data.fragment;
      if (url.href !== host.location.href) host.history.replaceState(host.history.state, "", url);
      initialFragment = undefined;
      send();
    }
    if (data.type === "doc-fragment" && validFragment(data.fragment)) {
      initialFragment = undefined;
      replaceViewerFragment(data.fragment, host);
    }
  }, host);
  host.addEventListener("message", (event: MessageEvent<FragmentMessage>) => {
    if (event.source !== frame.contentWindow || event.origin !== "null" || event.data?.path !== config.documentPath
      || !validFragment(event.data.fragment)) return;
    if (event.data.type === "doc-fragment" || (event.data.type === "doc-loaded" && validDocumentSearch(event.data.search))) {
      update(event.data);
    }
  });
}
