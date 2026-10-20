/**
 * Instant in-shell navigation (#245): a hidden sibling frame preloads the
 * document the reader is most likely to open next, so a click reveals an
 * already-rendered frame instead of waiting on a fresh request.
 *
 * A shell `fetch()` does not warm the opaque sandboxed document frame: the HTTP
 * cache is partitioned by the frame's opaque origin, so a fetch performed by the
 * shell and the frame's own navigation never share an entry. The prefetch must
 * therefore load a real frame with the content frame's sandbox attribute.
 *
 * Adoption must not move the frame. Moving an iframe to a new parent — even a
 * `replaceWith` in the same task — discards its browsing context in Chromium and
 * re-requests the document. Preloads are therefore kept as absolute, hidden
 * siblings of the content frame and adopted by toggling visibility and identity
 * in place, which leaves the browsing context (and the document already painted
 * in it) untouched.
 *
 * Readiness is the frame's own announcement, not its `load` event: an aborted
 * subframe navigation still fires `load`, on Chromium's error page, so a preload
 * is adopted only once its document has spoken to the shell. See docs/TECHNICAL.md,
 * "In-shell navigation and prefetch".
 */
import { startShellNavigation } from "../viewer/content-frame";

/** The subset of `navigator.connection` this module reads. */
export interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

/** Positioning shared by every frame in the content area: one stacked cell. */
const FRAME_BOX_STYLE = "position:absolute;top:0;left:0;width:100%;height:100%;border:0;background:#fff";
/** A preloading buffer: painted in the layout but not shown. */
export const BUFFER_FRAME_STYLE = `${FRAME_BOX_STYLE};visibility:hidden`;
/** The reader's frame: the same cell, now shown. */
export const ACTIVE_FRAME_STYLE = `${FRAME_BOX_STYLE};visibility:visible`;

/**
 * Preload only when the reader's connection can afford it: a metered or slow
 * connection keeps the plain click-to-load path.
 */
export function prefetchPermitted(connection: NetworkInformation | null | undefined): boolean {
  if (!connection) return true;
  if (connection.saveData) return false;
  return connection.effectiveType !== "slow-2g"
    && connection.effectiveType !== "2g"
    && connection.effectiveType !== "3g";
}

/**
 * The absolute address of the document a tree link points at, or null when the
 * link is not a same-origin http(s) frame document. Fragments never change which
 * document loads, so they are dropped; an oversized address is refused.
 */
export function framePrefetchUrl(href: unknown, base: string, ownOrigin: string): string | null {
  if (typeof href !== "string" || href.length === 0 || href.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== ownOrigin) return null;
  url.hash = "";
  return url.href;
}

export interface FramePreloader {
  /**
   * Start loading `href` in a hidden sibling frame with `sandbox`, the content
   * frame's own sandbox attribute. A repeat of an in-flight href, a non-string or
   * empty href is ignored; a full pool drops its oldest preload.
   */
  warm(href: unknown, sandbox: string | null): void;
  /**
   * Return the ready frame for `href` to reveal in place, or null to load
   * normally. A still-loading or failed preload is cancelled, never adopted.
   * The caller owns the returned frame and switches it into the reader's cell.
   */
  take(href: string): HTMLIFrameElement | null;
  /**
   * Note that the window `source` belongs to a hidden preload. Returns true when
   * a preload matched, so the caller can consume the frame's announcement.
   */
  ready(source: MessageEventSource | null): boolean;
  /** How many preloads the pool is currently holding in flight. */
  readonly size: number;
}

export interface FramePreloaderOptions {
  /**
   * The content area holding the reader's frame. Preloads are appended here as
   * siblings of that frame so adoption never has to move them.
   */
  host: () => HTMLElement;
  /** The newest preloads kept in flight; older ones are discarded. */
  limit?: number;
  createFrame?: () => HTMLIFrameElement;
  /** The window a frame navigates; injected so the pool can be tested without a DOM. */
  windowOf?: (element: HTMLIFrameElement) => MessageEventSource | null;
}

interface Entry {
  href: string;
  element: HTMLIFrameElement;
  ready: boolean;
}

const DEFAULT_LIMIT = 3;

/**
 * A bounded set of hidden frames sitting beside the reader's frame, already
 * loading the documents the reader is likely to open. The pool reuses frames the
 * reader has navigated away from, so it never holds more than `limit` buffers.
 */
export function createFramePreloader(options: FramePreloaderOptions): FramePreloader {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const create = options.createFrame ?? (() => document.createElement("iframe"));
  const windowOf = options.windowOf ?? ((element: HTMLIFrameElement) => element.contentWindow);
  const entries: Entry[] = [];
  // Free a buffer without moving it: clear the load and its preload markers so
  // the frame can pick up a different href, still a sibling of the reader's frame.
  const release = (element: HTMLIFrameElement) => {
    element.removeAttribute("src");
    delete element.dataset.preload;
    delete element.dataset.state;
  };
  const drop = (entry: Entry) => {
    entries.splice(entries.indexOf(entry), 1);
    release(entry.element);
  };
  const acquire = (sandbox: string | null): HTMLIFrameElement => {
    const host = options.host();
    const busy = new Set(entries.map(entry => entry.element));
    const reusable = Array.from(host.querySelectorAll<HTMLIFrameElement>("iframe"))
      .find(element => element.id !== "content-frame" && !busy.has(element));
    const element = reusable ?? create();
    if (!reusable) host.append(element);
    element.setAttribute("aria-hidden", "true");
    element.tabIndex = -1;
    element.style.cssText = BUFFER_FRAME_STYLE;
    if (sandbox) element.setAttribute("sandbox", sandbox);
    else element.removeAttribute("sandbox");
    return element;
  };
  return {
    warm(href, sandbox) {
      if (typeof href !== "string" || href.length === 0) return;
      if (entries.some(entry => entry.href === href)) return;
      if (entries.length >= limit) drop(entries[0]);
      const element = acquire(sandbox);
      // The attribute stays exactly the tree link's href, so an adopted frame is
      // indistinguishable from one the shell navigated itself.
      element.dataset.preload = href;
      entries.push({ href, element, ready: false });
      // A preload is the shell's navigation too: once adopted, the comment host may answer it (#296).
      startShellNavigation(element);
      element.setAttribute("src", href);
    },
    take(href) {
      const index = entries.findIndex(entry => entry.href === href);
      if (index === -1) return null;
      const [entry] = entries.splice(index, 1);
      if (entry.ready) return entry.element;
      // A still-loading or failed preload is cancelled; the click loads normally.
      release(entry.element);
      return null;
    },
    ready(source) {
      if (!source) return false;
      const entry = entries.find(candidate => windowOf(candidate.element) === source);
      if (!entry) return false;
      entry.ready = true;
      entry.element.dataset.state = "ready";
      return true;
    },
    get size() {
      return entries.length;
    },
  };
}
