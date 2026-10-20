/**
 * Lazy tree — sidebar document tree with Material Symbols icons,
 * grid-row animations, active indicator, and border-line indentation.
 */
import { coalesceMessage, createDocumentNavigationGate } from "../viewer/message-limits";
import { createNavigationNotice } from "../viewer/navigation-notice";
import { CONTENT_FRAME_EVENT } from "../viewer/content-frame";
import { replaceViewerFragment, sendDocumentFragment, validFragment } from "../viewer/fragments";
import {
  externalLinkHref,
  isContentFrameSource,
  normalizeLoadedDocumentPath,
  validRelativeDocumentPath,
  validDocumentSearch,
} from "./messages";
import { documentLoadAccessibility } from "./load-state";
import { shouldUseNativeLinkNavigation } from "./navigation";
import { folderTransitionOverride, indicatorTransition } from "./motion";
import { createFramePreloader, framePrefetchUrl, prefetchPermitted, ACTIVE_FRAME_STYLE, BUFFER_FRAME_STYLE, type NetworkInformation } from "./prefetch";
import { retryAfterMs } from "../../shared/retry-after";

type RendroWindow = Window & { RENDRO_INITIAL_DOC?: string; RENDRO_CURRENT_DOC?: string };
const RENDRO_WINDOW = window as RendroWindow;
const TREE_HOST = document.querySelector<HTMLElement>("[data-tree-org]");
const ORG = TREE_HOST?.dataset.treeOrg;
// The reader's URL (a branch view keeps its branch); frames and tree pages load from a pinned base (its commit).
const DOCUMENT_BASE = TREE_HOST?.dataset.documentBase ?? "";
const FRAME_BASE = TREE_HOST?.dataset.frameBase ?? "";
interface TreeNode { name: string; path: string; type: "file" | "folder"; title?: string; size?: number; }
interface TreePageResponse { children: TreeNode[]; isTruncated: boolean; nextStartAfter?: string; }

const TREE = document.getElementById("tree-container") as HTMLElement;

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function relativeDocumentPath(fullPath: string): string {
  if (!ORG || !fullPath.startsWith(`${ORG}/`)) return "";
  return fullPath.slice(ORG.length + 1);
}

function documentFrameUrl(fullPath: string): string {
  return `${FRAME_BASE}/files/${encodePath(relativeDocumentPath(fullPath))}`;
}

function docFromPathname(): string {
  const documentPath = new URLSearchParams(location.search).get("doc");
  return documentPath ? `${ORG}/${documentPath}` : "";
}

let activeEl: HTMLElement | null = null;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// ── instant navigation: hidden-frame prefetch (#245) ──

/** Marks a click-to-swap so tests and the field can measure the in-shell switch. */
const FRAME_SWITCH_MEASURE = "rendro:frame-switch";
const FRAME_SWITCH_START = `${FRAME_SWITCH_MEASURE}:start`;
const FRAME_SWITCH_END = `${FRAME_SWITCH_MEASURE}:end`;

// ── real-user monitoring marks (#282) ──

/** The shell's first document, a link/search/confirmed switch, or back/forward between documents. */
type NavigationKind = "cold" | "switch" | "history";
/** One measure per settled navigation: activation → next paint, with the swap and load offsets in `detail`. */
const NAVIGATION_MEASURE = "rendro:navigation";

interface NavigationTiming {
  kind: NavigationKind;
  loadId: number;
  url: string;
  activation: number;
  swap: number;
  load: number;
  preloaded: boolean;
}

/**
 * Starts the record of one navigation. The activation is the event that asked
 * for it (a click, a key, a frame's message, a popstate), or the shell's own
 * navigation start for the first document. Only clock reads happen on the
 * click path; the measure is written after the paint (`measureNavigation`).
 */
function startNavigationTiming(kind: NavigationKind, loadId: number, url: string): NavigationTiming {
  // `window.event` is the event being dispatched, whichever handler called loadDoc.
  const activation = kind === "cold" ? 0 : window.event?.timeStamp ?? performance.now();
  return { kind, loadId, url, activation, swap: 0, load: 0, preloaded: false };
}

/**
 * Written once the frame has had a paint (call it from an animation frame
 * callback: the next task runs after that frame's rendering); the RUM bundle
 * reads it.
 */
function measureNavigation(timing: NavigationTiming) {
  window.setTimeout(() => {
    const { kind, url, activation, swap, load, preloaded } = timing;
    performance.measure(NAVIGATION_MEASURE, {
      start: activation, end: performance.now(),
      detail: { kind, url, preloaded, swap: swap - activation, load: load - activation },
    });
  }, 0);
}

/**
 * The content area that holds the reader's frame. Preloads live here as hidden
 * siblings so adoption toggles them in place instead of moving a frame, which
 * would discard its browsing context and re-request the document.
 */
function frameHost(): HTMLElement {
  const frame = document.getElementById("content-frame");
  return frame?.parentElement ?? document.body;
}

const framePreloader = createFramePreloader({ host: frameHost });

/** Begin loading the frame document a tree link points at, when the reader's
 * connection allows it and the shell is a repository read path. */
function prefetchFrameLink(href: unknown) {
  if (typeof href !== "string") return;
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (!prefetchPermitted(connection)) return;
  if (!framePrefetchUrl(href, location.href, location.origin)) return;
  const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
  // The reader's current document needs no preload, and re-warming it after
  // adoption would pull the same URL a second time.
  if (frame && frame.getAttribute("src") === href) return;
  framePreloader.warm(href, frame?.getAttribute("sandbox") ?? null);
}

function prefetchFromEvent(event: Event) {
  if (!(event.target instanceof HTMLElement)) return;
  const link = event.target.closest<HTMLAnchorElement>("a.tree-link[target='content-frame']");
  if (link) prefetchFrameLink(link.getAttribute("href"));
}

// ── active indicator ──

function updateIndicator(el: HTMLElement, animate = true) {
  const indicator = document.getElementById("active-indicator");
  if (!indicator || !TREE) return;
  activeEl = el;

  let visible = true;
  let cur: HTMLElement | null = el.parentElement;
  while (cur && cur !== TREE) {
    if (cur.classList.contains("tree-folder") && !cur.classList.contains("open")) { visible = false; break; }
    cur = cur.parentElement;
  }
  if (!visible) { indicator.style.opacity = "0"; return; }

  const transform = `translate(${el.offsetLeft}px, ${el.offsetTop}px)`;
  indicator.style.transition = indicatorTransition(animate, reducedMotion());
  indicator.style.opacity = "1";
  indicator.style.transform = transform;
}

function refreshIndicator(animate = false) {
  if (!activeEl) return;
  // The selection is never cleared once set, so it is still present next frame.
  requestAnimationFrame(() => updateIndicator(activeEl as HTMLElement, animate));
}

// ── fold icon toggle ──

// A closed folder's rows are hidden visually and, with `inert`, from Tab and assistive technology.
const FOLDER_CONTENT = ":scope > .tree-folder-collapse > .tree-folder-content";

function setFolderOpen(folder: HTMLElement, open: boolean) {
  folder.classList.toggle("open", open);
  const icon = folder.querySelector(":scope > .tree-item .folder-icon");
  if (icon) icon.textContent = open ? "folder_open" : "folder";
  folder.querySelector(":scope > .tree-item")?.setAttribute("aria-expanded", String(open));
  folder.querySelector(":scope > .tree-folder-collapse")?.toggleAttribute("inert", !open);
}

/** The element that animates a folder open and closed; the rows live inside it. */
function folderCollapse(content: HTMLElement): HTMLElement {
  return content.parentElement as HTMLElement;
}

function indexChildItems(content: HTMLElement) {
  let index = 0;
  Array.from(content.children).forEach((row) => {
    if (!(row instanceof HTMLElement) || row.classList.contains("tree-load-more")) return;
    const item = row.classList.contains("tree-item")
      ? row
      : row.querySelector<HTMLElement>(":scope > .tree-item");
    if (!item) return;
    item.style.setProperty("--tree-index", String(Math.min(index, 12)));
    index += 1;
  });
}

// ── expand / collapse ──

// A folder's first page in flight, so a second expand (a newer reveal) can wait for it.
const folderLoads = new WeakMap<HTMLElement, Promise<void>>();

async function expand(folder: HTMLElement) {
  const path = folder.dataset.path;
  if (!path) return;
  const content = folder.querySelector<HTMLElement>(FOLDER_CONTENT);
  if (!content) return;
  folderCollapse(content).style.transition = folderTransitionOverride(reducedMotion());

  if (folder.classList.contains("loading")) return folderLoads.get(folder);

  if (folder.classList.contains("loaded")) {
    indexChildItems(content);
    setFolderOpen(folder, true);
    if (activeEl) updateIndicator(activeEl);
    return;
  }

  folder.classList.add("loading");
  folder.setAttribute("aria-busy", "true");
  const load = (async () => {
    try {
      await loadPage(folder, path, content, undefined);
      indexChildItems(content);
      folder.classList.add("loaded");
      setFolderOpen(folder, true);
      if (activeEl) updateIndicator(activeEl);
    } catch {
      content.innerHTML = `<div class="tree-error" role="alert">Failed to load folder. <button class="load-more-btn folder-retry-btn" type="button">Retry</button></div>`;
      setFolderOpen(folder, true);
    } finally {
      folder.classList.remove("loading");
      folder.removeAttribute("aria-busy");
    }
  })();
  folderLoads.set(folder, load);
  return load;
}

/** One directory page of the repository's sidebar (#90). Folders are fetched
 * only when expanded, and only page by page. */
async function scopedPage(path: string, cursor?: string): Promise<TreePageResponse> {
  const root = `${ORG}/`;
  if (!path.startsWith(root)) return { children: [], isTruncated: false };
  const url = new URL(`${FRAME_BASE}/tree`, location.origin);
  url.searchParams.set("dir", path.slice(root.length));
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(`${url.pathname}${url.search}`);
  if (!response.ok) throw new Error(`${response.status}`);
  const result = await response.json() as { children?: unknown; cursor?: unknown };
  if (!Array.isArray(result.children)) throw new Error("Invalid document tree");
  const children = result.children.map((child: unknown): TreeNode => {
    const { name, type, title } = (child ?? {}) as { name?: unknown; type?: unknown; title?: unknown };
    if (typeof name !== "string" || !name || name.includes("/") || name === "." || name === ".."
      || (type !== "file" && type !== "folder")) throw new Error("Invalid document tree");
    // An optional display title (repository sidebars); the name stays the path segment.
    return { name, type, path: `${path}${name}${type === "folder" ? "/" : ""}`, ...(typeof title === "string" && title ? { title } : {}) };
  });
  const next = typeof result.cursor === "string" && result.cursor ? result.cursor : undefined;
  return { children, isTruncated: !!next, nextStartAfter: next };
}

async function loadPage(folder: HTMLElement, path: string, content: HTMLElement, startAfter?: string) {
  const data = await scopedPage(path, startAfter);
  // The tree container itself holds the root's later pages.
  const childDepth = folder === TREE ? 0 : parseInt(folder.dataset.depth || "0") + 1;
  const children = data.children;
  const existingPaths = new Set(
    Array.from(content.querySelectorAll<HTMLElement>("[data-path]"))
      .map((el) => el.dataset.path)
      .filter((value): value is string => Boolean(value)),
  );
  // Directory pages name folders with their trailing slash, as the rows' data-path does.
  const freshChildren = children.filter((child) => !existingPaths.has(child.path));
  const existingTreeItems = new Set(content.querySelectorAll<HTMLElement>(".tree-item"));
  content.querySelector(":scope > .tree-load-more")?.remove();
  const rows = renderRows(freshChildren, childDepth);
  content.insertAdjacentHTML("beforeend", rows);
  startTreeEntrance(
    Array.from(content.querySelectorAll<HTMLElement>(".tree-item")).filter((item) => !existingTreeItems.has(item)),
  );
  indexChildItems(content);

  setNextPage(folder, content, data);

  if (activeEl) updateIndicator(activeEl);
}

function setNextPage(folder: HTMLElement, content: HTMLElement, data: TreePageResponse) {
  if (data.isTruncated && data.nextStartAfter) {
    folder.dataset.nextStartAfter = data.nextStartAfter;
    content.insertAdjacentHTML("beforeend",
      `<div class="tree-load-more"><button class="load-more-btn">Load more...</button></div>`);
  } else {
    delete folder.dataset.nextStartAfter;
  }
}

/** The tree container is the root folder and holds its own rows. */
function folderContent(folder: HTMLElement): HTMLElement | null {
  return folder === TREE ? TREE : folder.querySelector<HTMLElement>(FOLDER_CONTENT);
}

function collapse(folder: HTMLElement) {
  const content = folderContent(folder);
  if (content) folderCollapse(content).style.transition = folderTransitionOverride(reducedMotion());
  setFolderOpen(folder, false);
  if (activeEl) updateIndicator(activeEl);
}

// ── rendering ──

function renderFile(node: TreeNode): string {
  const fp = documentFrameUrl(node.path);
  return `<div class="tree-item" data-path="${esc(node.path)}">
    <span class="material-symbols-outlined tree-icon" aria-hidden="true">article</span>
    <a href="${esc(fp)}" class="tree-link tree-label" target="content-frame">${esc(node.title ?? node.name.replace(/\.html$/, ""))}</a>
  </div>`;
}

function renderActiveIndicator(): string {
  return `<div class="active-indicator" id="active-indicator" style="opacity:0;transition:none"></div>`;
}

function renderEmptyTree(): string {
  return `<div class="tree-empty">No documents available.</div>`;
}

function startTreeEntrance(items: Iterable<HTMLElement>) {
  if (reducedMotion()) return;
  Array.from(items).forEach((item, index) => {
    const finish = () => {
      item.classList.remove("tree-item-entering");
      item.style.removeProperty("--tree-index");
      item.removeEventListener("animationend", finish);
      item.removeEventListener("animationcancel", finish);
    };
    item.style.setProperty("--tree-index", String(Math.min(index, 12)));
    item.classList.add("tree-item-entering");
    item.addEventListener("animationend", finish);
    item.addEventListener("animationcancel", finish);
  });
}

async function loadRootTree() {
  if (!ORG || !TREE) return;
  TREE.dataset.loadingRoot = "true";
  TREE.setAttribute("aria-busy", "true");
  try {
    const data = await scopedPage(`${ORG}/`);
    const children = data.children;
    TREE.dataset.path = `${ORG}/`;
    TREE.innerHTML = renderActiveIndicator() + (children.length ? renderRows(children, 0) : renderEmptyTree());
    startTreeEntrance(TREE.querySelectorAll<HTMLElement>(".tree-item"));
    // The first page renders at once; later root pages load on request.
    setNextPage(TREE, TREE, data);
    const currentDoc = RENDRO_WINDOW.RENDRO_CURRENT_DOC || RENDRO_WINDOW.RENDRO_INITIAL_DOC || docFromPathname();
    if (currentDoc) syncActiveState(currentDoc);
  } catch {
    TREE.innerHTML = renderActiveIndicator() + `<div class="tree-error" role="alert">Failed to load documents. <button class="load-more-btn tree-root-retry-btn" type="button">Retry</button></div>`;
  } finally {
    delete TREE.dataset.loadingRoot;
    TREE.removeAttribute("aria-busy");
  }
}

function renderFolder(node: TreeNode, depth: number): string {
  const path = node.path;
  return `<div class="tree-folder" data-path="${esc(path)}" data-depth="${depth}">
    <div class="tree-item" role="button" tabindex="0" aria-expanded="false">
      <span class="material-symbols-outlined tree-icon caret-icon" aria-hidden="true">chevron_right</span>
      <span class="material-symbols-outlined tree-icon folder-icon" aria-hidden="true">folder</span>
      <span class="tree-folder-name tree-label">${esc(node.title ?? node.name)}</span>
    </div>
    <div class="tree-folder-collapse" inert><div class="tree-folder-content tree-stack"></div></div>
  </div>`;
}

function renderRows(nodes: TreeNode[], depth: number): string {
  return nodes.map((n) => (n.type === "folder" ? renderFolder(n, depth) : renderFile(n))).join("");
}

// ── event handling ──

function handleClick(e: Event) {
  if (!(e.target instanceof HTMLElement)) return;
  const target = e.target;

  const rootRetry = target.closest<HTMLButtonElement>(".tree-root-retry-btn");
  if (rootRetry) {
    e.preventDefault();
    rootRetry.disabled = true;
    void loadRootTree();
    return;
  }

  const folderRetry = target.closest<HTMLButtonElement>(".folder-retry-btn");
  if (folderRetry) {
    e.preventDefault();
    const folder = folderRetry.closest<HTMLElement>(".tree-folder");
    const content = folder?.querySelector<HTMLElement>(FOLDER_CONTENT);
    if (folder && content) {
      content.replaceChildren();
      void expand(folder);
    }
    return;
  }

  const loadMoreBtn = target.closest<HTMLButtonElement>("button.load-more-btn");
  if (loadMoreBtn) {
    e.preventDefault();
    const folder = loadMoreBtn.closest<HTMLElement>(".tree-folder") ?? TREE;
    const path = folder.dataset.path;
    const content = folderContent(folder);
    const next = folder.dataset.nextStartAfter;
    if (path && content && next) {
      loadMoreBtn.textContent = "Loading…";
      loadMoreBtn.disabled = true;
      loadMoreBtn.setAttribute("aria-busy", "true");
      void loadPage(folder, path, content, next).catch(() => {
        if (!loadMoreBtn.isConnected) return;
        loadMoreBtn.textContent = "Retry";
        loadMoreBtn.disabled = false;
        loadMoreBtn.removeAttribute("aria-busy");
      });
    }
    return;
  }

  const item = target.closest<HTMLElement>(".tree-item");
  if (!item) return;

  const link = target.closest<HTMLAnchorElement>("a.tree-link");
  if (link && e instanceof MouseEvent && shouldUseNativeLinkNavigation(e)) return;

  const folder = item.parentElement?.classList.contains("tree-folder") ? item.parentElement : null;
  if (folder) {
    e.preventDefault();
    if (folder.classList.contains("open")) collapse(folder);
    else void expand(folder);
    return;
  }

  const path = item.dataset.path;
  if (path) {
    e.preventDefault();
    loadDoc(path, navigationGate.confirm());
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (!(e.target instanceof HTMLElement)) return;
  const folderItem = e.target.closest<HTMLElement>(".tree-folder > .tree-item");
  if (!folderItem) return;
  e.preventDefault();
  folderItem.click();
}

// ── doc loading with history ──
let activeDocLoadId = 0;
let expectedLoadedPath: string | null = null;
let docLoadTimeout: number | undefined;
let docLoadClearTimer: number | undefined;
let docLoadStartedAt = 0;
const DOC_LOAD_MIN_VISIBLE_MS = 520;

function announceDocumentState(message: string, assertive = false) {
  let status = document.getElementById("document-load-status");
  if (!status) {
    status = document.createElement("div");
    status.id = "document-load-status";
    status.setAttribute("role", "status");
    status.style.cssText = "position:fixed;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
    document.body.append(status);
  }
  status.setAttribute("aria-live", assertive ? "assertive" : "polite");
  status.textContent = message;
}

function clearDocLoadingState() {
  document.documentElement.classList.remove("doc-loading", "doc-loading-error");
}

function showDocLoader(frame: HTMLIFrameElement | null) {
  if (docLoadClearTimer !== undefined) window.clearTimeout(docLoadClearTimer);
  docLoadStartedAt = performance.now();
  document.documentElement.classList.add("doc-loading");
  document.documentElement.classList.remove("doc-loading-error");
  const accessibility = documentLoadAccessibility("loading");
  announceDocumentState(accessibility.message, accessibility.assertive);
  if (frame) {frame.style.display = "block";frame.setAttribute("aria-busy", String(accessibility.busy));}
}

function showDocLoadError(frame: HTMLIFrameElement) {
  if (docLoadClearTimer !== undefined) window.clearTimeout(docLoadClearTimer);
  document.documentElement.classList.remove("doc-loading");
  document.documentElement.classList.add("doc-loading-error");
  const accessibility = documentLoadAccessibility("error");
  frame.removeAttribute("aria-busy");
  announceDocumentState(accessibility.message, accessibility.assertive);
}

// Every loadDoc replaces the frame handlers and clears the pending timers, so
// a callback that still runs always belongs to the latest load.
function hideDocLoader(frame: HTMLIFrameElement) {
  const remaining = Math.max(0, DOC_LOAD_MIN_VISIBLE_MS - (performance.now() - docLoadStartedAt));
  if (remaining > 0) {
    docLoadClearTimer = window.setTimeout(clearDocLoadingState, remaining);
  } else {
    clearDocLoadingState();
  }
  frame.style.display = "block";
  const accessibility = documentLoadAccessibility("loaded");
  frame.removeAttribute("aria-busy");
  announceDocumentState(accessibility.message, accessibility.assertive);
}

// The shell's own query selects the document. Keep publisher queries in a
// separate parameter so names like "doc" cannot alter the authorized path.
function documentSearchFromLocation(): string {
  const search = new URLSearchParams(location.search).get("docQuery") ?? "";
  return validDocumentSearch(search) ? search : "";
}

const navigationGate = createDocumentNavigationGate();
// Activation propagates out of the opaque document frame, but its input events
// do not. Reserve all parent input before any control handles it, including
// pointerup/touchend for non-mouse activation and click for assistive input.
// https://html.spec.whatwg.org/multipage/interaction.html#activation-triggering-input-event
// These passive observers must not interfere with controls or sign-out teardown.
for (const type of ["pointerdown", "pointerup", "mousedown", "keydown", "touchend", "click"]) {
  window.addEventListener(type, event => {
    if (event.isTrusted) navigationGate.reserveParentInput();
  }, { capture: true, passive: true });
}
const navigationNotice = createNavigationNotice({
  describe: ({ fullPath, search, fragment, href }) => href
    ? { question: `Open external link ${href}?`, open: "Open external link", review: "Review external link" }
    : { question: `Open linked document ${relativeDocumentPath(fullPath)}${search}${fragment}?`, open: "Open linked document", review: "Review linked document" },
  open: ({ fullPath, search, fragment, href }) => {
    if (!href) {
      loadDoc(fullPath, navigationGate.confirm(), fragment, search);
      return;
    }
    // The document stays where it is; the other site gets a new tab with no handle back to this one.
    navigationNotice.clear();
    window.open(href, "_blank", "noopener,noreferrer");
  },
});

function offerDocumentNavigation(fullPath: string, search: string, fragment: string) {
  navigationNotice.offer({ fullPath, search, fragment });
}

function offerExternalLink(href: string) {
  navigationNotice.offer({ fullPath: "", search: "", fragment: "", href });
}

function markFrameSwitch() {
  performance.mark(FRAME_SWITCH_END);
  performance.measure(FRAME_SWITCH_MEASURE, FRAME_SWITCH_START, FRAME_SWITCH_END);
}

/** Reveal a preloaded sibling frame in the reader's cell, keeping the browsing
 * context and rendered document it already has. Both frames stay children of the
 * content area throughout — only visibility and identity change — because moving
 * an iframe discards its browsing context. The switch runs inside a same-document
 * view transition so the old and new documents cross-fade instead of flashing,
 * unless the reader prefers reduced motion. */
function adoptPreloadedFrame(preloaded: HTMLIFrameElement, current: HTMLIFrameElement, timing: NavigationTiming, fullPath: string) {
  const { loadId } = timing;
  const className = current.className;
  const title = current.getAttribute("title") ?? "Document content";
  const reveal = () => {
    // Drop the shared identity first: two frames must never both be the target
    // `content-frame` at once, or a link click could navigate the wrong one.
    current.removeAttribute("name");
    current.removeAttribute("id");
    // A buffer is the pool's: its old load handlers must not settle (or measure) a later navigation when it is reused.
    current.onload = null;
    current.onerror = null;
    current.setAttribute("aria-hidden", "true");
    current.tabIndex = -1;
    current.style.cssText = BUFFER_FRAME_STYLE;
    preloaded.id = "content-frame";
    preloaded.name = "content-frame";
    preloaded.className = className;
    preloaded.setAttribute("title", title);
    preloaded.removeAttribute("aria-hidden");
    delete preloaded.dataset.preload;
    preloaded.tabIndex = 0;
    preloaded.setAttribute("aria-busy", "true");
    preloaded.style.cssText = ACTIVE_FRAME_STYLE;
    // Shell scripts holding the frame element (the comment host, #254) follow the reader's new frame.
    window.dispatchEvent(new CustomEvent(CONTENT_FRAME_EVENT, { detail: preloaded }));
    // The preload had already loaded: its swap is its load.
    timing.swap = timing.load = performance.now();
    timing.preloaded = true;
  };
  // The document is already rendered, so settling waits only for the reveal.
  const settle = () => {
    if (loadId !== activeDocLoadId) return;
    hideDocLoader(preloaded);
    sendDocumentFragment(preloaded, relativeDocumentPath(fullPath), location.hash);
    markFrameSwitch();
    measureNavigation(timing);
  };
  const startViewTransition = (document as Document & {
    startViewTransition?: (update: () => void) => { updateCallbackDone: Promise<unknown> };
  }).startViewTransition;
  if (reducedMotion() || typeof startViewTransition !== "function") {
    reveal();
    requestAnimationFrame(settle);
  } else {
    // The transition may run the update callback on a later frame, so wait for it
    // before hiding the loader; otherwise the loader would clear before the reveal
    // reapplies aria-busy.
    const transition = startViewTransition.call(document, reveal);
    void transition.updateCallbackDone.then(() => requestAnimationFrame(settle), () => requestAnimationFrame(settle));
  }
}

function loadDoc(fullPath: string, pushState: false | "push" | "replace", fragment = "", search = "", kind: NavigationKind = "switch") {
  navigationNotice.clear();
  const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
  const placeholder = document.getElementById("main-placeholder");
  if (placeholder) placeholder.style.display = "none";

  // Optimistic: keep production tree behavior — selected state changes immediately.
  expectedLoadedPath = fullPath;
  syncActiveState(fullPath);

  activeDocLoadId++;
  const loadId = activeDocLoadId;
  if (docLoadTimeout !== undefined) window.clearTimeout(docLoadTimeout);
  showDocLoader(frame);

  const frameUrl = documentFrameUrl(fullPath) + search;
  performance.mark(FRAME_SWITCH_START);
  const timing = startNavigationTiming(kind, loadId, frameUrl);
  const preloaded = frame ? framePreloader.take(frameUrl) : null;

  if (frame && preloaded) {
    adoptPreloadedFrame(preloaded, frame, timing, fullPath);
  } else if (frame) {
    frame.onload = () => {
      timing.load = performance.now();
      window.clearTimeout(docLoadTimeout);
      hideDocLoader(frame);
      sendDocumentFragment(frame, relativeDocumentPath(fullPath), location.hash);
      markFrameSwitch();
      requestAnimationFrame(() => measureNavigation(timing));
    };
    frame.onerror = () => {
      window.clearTimeout(docLoadTimeout);
      showDocLoadError(frame);
    };
    docLoadTimeout = window.setTimeout(() => showDocLoadError(frame), 15000);
    frame.src = frameUrl;
    // Keep src authoritative for comments/tickets, but replace the pending
    // frame navigation: the shell alone owns document history entries.
    frame.contentWindow?.location.replace(frameUrl);
    timing.swap = performance.now();
  }

  if (pushState) {
    const url = new URL(location.href);
    url.pathname = DOCUMENT_BASE;
    url.search = "";
    url.searchParams.set("doc", relativeDocumentPath(fullPath));
    if (search) url.searchParams.set("docQuery", search);
    else url.searchParams.delete("docQuery");
    url.hash = fragment;
    history[pushState === "replace" ? "replaceState" : "pushState"]({ docPath: fullPath }, "", url);
  }
}

// Reveals overlap while folders load; only the newest may mark its row.
let latestReveal = 0;

async function navigateToDoc(org: string, relPath: string) {
  const reveal = ++latestReveal;
  const live = () => reveal === latestReveal;
  const fullPath = `${org}/${relPath}`;
  const parts = relPath.split("/");
  let currentPath = org;
  let parent: HTMLElement = TREE;

  for (let i = 0; i < parts.length - 1; i++) {
    currentPath += "/" + parts[i];
    const folder = await pagedRow<HTMLElement>(parent, `.tree-folder[data-path="${CSS.escape(currentPath)}/"]`, live);
    // Newest-wins (#169): a superseded reveal stops at once, leaving the
    // folders, pages and selection to the navigation the reader asked for last.
    if (reveal !== latestReveal) return;
    if (!folder) break;
    if (!folder.classList.contains("open")) {
      await expand(folder);
      if (reveal !== latestReveal) return;
      if (!folder.classList.contains("open")) return;
    }
    parent = folder;
  }

  const item = await pagedRow<HTMLElement>(parent, `.tree-item[data-path="${CSS.escape(fullPath)}"]`, live);
  if (!item || reveal !== latestReveal) return;
  document.querySelectorAll(".tree-item.active").forEach((element) => element.classList.remove("active"));
  item.classList.add("active");
  updateIndicator(item, true);
}

/** Find a row, loading later pages of only its parent folder while the row is
 * beyond the pages shown so far. A failed page leaves the row unrevealed, and
 * so does a `live` check that stops holding after an awaited page returns. */
async function pagedRow<T extends HTMLElement>(parent: HTMLElement, selector: string, live: () => boolean): Promise<T | null> {
  let row = document.querySelector<T>(selector);
  for (let next = parent.dataset.nextStartAfter; !row && next; ) {
    try {
      await loadPage(parent, parent.dataset.path as string, folderContent(parent) as HTMLElement, next);
    } catch {
      return null;
    }
    if (!live()) return null;
    row = document.querySelector<T>(selector);
    // A repeated cursor would never reach the row.
    next = parent.dataset.nextStartAfter === next ? undefined : parent.dataset.nextStartAfter;
  }
  return row;
}

// Sync tree active state without reloading iframe (for doc-loaded messages)
function syncActiveState(fullPath: string) {
  RENDRO_WINDOW.RENDRO_CURRENT_DOC = fullPath;
  // Always expand ancestors first (no-op if already open)
  if (!ORG) return;
  const relPath = fullPath.startsWith(`${ORG}/`) ? fullPath.slice(ORG.length + 1) : fullPath;
  void navigateToDoc(ORG, relPath);
}

function reconcileLoadedDocument(fullPath: string): void {
  // A load report is an acknowledgement, never authority to navigate or fetch
  // tree data. The shell already selected and scoped the document in loadDoc.
  if (fullPath === expectedLoadedPath) expectedLoadedPath = null;
}

function isDocumentMessage(value: unknown): value is { type: string; path: string; search?: unknown; fragment?: unknown; href?: unknown } {
  if (!value || typeof value !== "object") return false;
  return "type" in value
    && typeof value.type === "string"
    && "path" in value
    && typeof value.path === "string";
}

function documentPathFromHistory(value: unknown): string {
  return value && typeof value === "object" && "docPath" in value && typeof value.docPath === "string"
    ? value.docPath
    : "";
}

// ── repository search (#251) ──

const SEARCH_LIMIT = 20;
const SEARCH_MIN_TERMS = 3;
const SEARCH_DEBOUNCE_MS = 200;
// FTS5 snippet() wraps each matched run in these control characters; the body
// text is stripped of them, so they are unambiguous and split to build <mark>.
// eslint-disable-next-line no-control-regex -- these two code points are snippet markers by construction.
const SNIPPET_MARKER = /[\u0002\u0003]/;

interface SearchItem { path: string; slug: string; title: string; snippet: string }

function isSearchItem(value: unknown): value is SearchItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.path === "string" && typeof item.slug === "string"
    && typeof item.title === "string" && typeof item.snippet === "string";
}

function searchItems(payload: unknown): SearchItem[] {
  if (!payload || typeof payload !== "object") return [];
  const results = (payload as { results?: unknown }).results;
  return Array.isArray(results) ? results.filter(isSearchItem) : [];
}

/** Wires the in-sidebar search control to the pinned `/search` endpoint. */
function initSearch(root: HTMLElement): void {
  const formEl = root.querySelector<HTMLFormElement>(".repo-search-field");
  const inputEl = root.querySelector<HTMLInputElement>(".repo-search-input");
  const clear = root.querySelector<HTMLButtonElement>(".repo-search-clear");
  const panelEl = root.querySelector<HTMLElement>(".repo-search-results");
  const statusEl = root.querySelector<HTMLElement>(".repo-search-status");
  if (!formEl || !inputEl || !panelEl || !statusEl || !ORG || !FRAME_BASE) return;
  const form: HTMLFormElement = formEl;
  const input: HTMLInputElement = inputEl;
  const panel: HTMLElement = panelEl;
  const status: HTMLElement = statusEl;
  root.hidden = false;

  let items: SearchItem[] = [];
  let active = -1;
  let timer: number | undefined;
  let controller: AbortController | null = null;
  let requestId = 0;
  let countdown: number | undefined;

  const announce = (message: string) => { status.textContent = message; };
  const setExpanded = (open: boolean) => input.setAttribute("aria-expanded", String(open));

  // The panel carries the listbox role only while it holds options: a role=listbox
  // with a single message ("no results", an error) tells screen readers about an
  // empty listbox (#270), so while a message shows the role and the combobox's
  // aria-controls are dropped, and both come back with the next result set.
  const setListbox = (on: boolean) => {
    if (on) {
      panel.setAttribute("role", "listbox");
      panel.setAttribute("aria-label", "Search results");
      input.setAttribute("aria-controls", panel.id);
    } else {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-label");
      input.removeAttribute("aria-controls");
    }
  };
  const stopCountdown = () => {
    if (countdown !== undefined) window.clearInterval(countdown);
    countdown = undefined;
  };

  function closePanel() {
    stopCountdown();
    panel.hidden = true;
    panel.replaceChildren();
    setExpanded(false);
    input.removeAttribute("aria-activedescendant");
    items = [];
    active = -1;
  }

  function message(text: string): Text {
    stopCountdown();
    const node = document.createElement("div");
    node.className = "repo-search-message";
    const label = document.createTextNode(text);
    node.append(label);
    setListbox(false);
    setExpanded(false);
    input.removeAttribute("aria-activedescendant");
    panel.replaceChildren(node);
    panel.hidden = false;
    return label;
  }

  function retryMessage(text: string, retry: () => void): { label: Text; button: HTMLButtonElement } {
    const label = message(text);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Retry";
    button.addEventListener("click", retry);
    label.after(button);
    return { label, button };
  }

  /**
   * A 429 answer names its wait in Retry-After: say so, and keep Retry disabled
   * until it elapses (#270). The visible countdown updates every second; the
   * live region announces the wait once, and again when searching may resume —
   * the same cadence as the share quota's notice.
   */
  function rateLimited(delayMs: number, query: string) {
    const until = Date.now() + delayMs;
    const text = (left: number) => (left ? `Too many searches — try again in ${left} s` : "Too many searches.");
    const seconds = Math.ceil(delayMs / 1000);
    const { label, button } = retryMessage(text(seconds), () => void run(query));
    button.disabled = delayMs > 0;
    announce(seconds ? `Too many searches — try again in ${seconds} seconds` : "Too many searches.");
    if (delayMs > 0) {
      countdown = window.setInterval(() => {
        const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        label.textContent = text(left);
        if (left === 0) {
          stopCountdown();
          button.disabled = false;
          announce("You can search again now.");
        }
      }, 1000);
    }
  }

  function snippetNode(snippet: string): HTMLElement {
    const span = document.createElement("span");
    span.className = "repo-search-item-snippet";
    // Even segments are plain text; odd segments were wrapped by snippet().
    snippet.split(SNIPPET_MARKER).forEach((segment, index) => {
      if (segment === "") return;
      if (index % 2 === 1) {
        const mark = document.createElement("mark");
        mark.textContent = segment;
        span.append(mark);
      } else {
        span.append(document.createTextNode(segment));
      }
    });
    return span;
  }

  function option(item: SearchItem, index: number): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "repo-search-item";
    button.id = `repo-search-option-${index}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    button.dataset.index = String(index);
    const path = document.createElement("span");
    path.className = "repo-search-item-path";
    path.textContent = item.slug ? `${item.path}#${item.slug}` : item.path;
    const title = document.createElement("span");
    title.className = "repo-search-item-title";
    title.textContent = item.title || item.path.slice(item.path.lastIndexOf("/") + 1);
    button.append(path, title, snippetNode(item.snippet));
    button.addEventListener("click", () => activate(index));
    return button;
  }

  function setActive(index: number) {
    active = index;
    const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>(".repo-search-item"));
    buttons.forEach((button, at) => {
      const on = at === index;
      button.dataset.active = String(on);
      button.setAttribute("aria-selected", String(on));
    });
    input.setAttribute("aria-activedescendant", `repo-search-option-${index}`);
    buttons[index]?.scrollIntoView({ block: "nearest" });
  }

  function activate(index: number) {
    const item = items[index];
    closePanel();
    input.value = "";
    if (clear) clear.hidden = true;
    announce("");
    // Same in-shell navigation a tree click performs: the shell owns history.
    loadDoc(`${ORG}/${item.path}`, "push", item.slug ? `#${item.slug}` : "");
  }

  async function run(query: string) {
    const trimmed = query.trim();
    if (trimmed.length < SEARCH_MIN_TERMS) {
      closePanel();
      announce(trimmed ? `Enter at least ${SEARCH_MIN_TERMS} characters to search` : "");
      return;
    }
    const id = ++requestId;
    controller?.abort();
    controller = new AbortController();
    announce("Searching…");
    // One measure per request, so the query budget stays observable.
    performance.mark("rendro:repo-search-request");
    try {
      const url = `${FRAME_BASE}/search?q=${encodeURIComponent(trimmed)}&limit=${SEARCH_LIMIT}`;
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 429) {
        // No supersession check: nothing awaits since fetch, and a newer query aborts this one.
        rateLimited(retryAfterMs(response.headers.get("Retry-After")), trimmed);
        return;
      }
      if (!response.ok) throw new Error(`${response.status}`);
      const found = searchItems(await response.json());
      items = found;
      if (!found.length) {
        message(`No results for “${trimmed}”`);
        announce(`No results for ${trimmed}`);
        return;
      }
      stopCountdown();
      setListbox(true);
      panel.replaceChildren(...found.map(option));
      panel.hidden = false;
      setExpanded(true);
      setActive(0);
      announce(`${found.length} result${found.length === 1 ? "" : "s"}`);
    } catch {
      // A request a newer query aborted, or that answered after it, never shows an error.
      if (id !== requestId) return;
      retryMessage("Search failed.", () => void run(trimmed));
      announce("Search failed");
    }
  }

  input.addEventListener("input", () => {
    if (clear) clear.hidden = input.value === "";
    if (timer !== undefined) window.clearTimeout(timer);
    const value = input.value;
    timer = window.setTimeout(() => void run(value), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && items.length) {
      event.preventDefault();
      setActive(active + 1 >= items.length ? 0 : active + 1);
    } else if (event.key === "ArrowUp" && items.length) {
      event.preventDefault();
      setActive(active - 1 < 0 ? items.length - 1 : active - 1);
    } else if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      closePanel();
    }
    // Enter is left to the form's submit handler, which prevents the default
    // navigation and activates the selected option when any results are shown.
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // Options are rendered with the first active; the panel only shows them when results exist.
    if (items.length) activate(active);
  });
  clear?.addEventListener("click", () => {
    if (timer !== undefined) window.clearTimeout(timer);
    input.value = "";
    clear.hidden = true;
    closePanel();
    announce("");
    input.focus();
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !root.contains(event.target)) closePanel();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
}

function init() {
  if (!TREE) return;
  const search = document.querySelector<HTMLElement>("[data-repo-search]");
  if (search) initSearch(search);
  void loadRootTree();
  TREE.addEventListener("click", handleClick);
  TREE.addEventListener("keydown", handleKeydown);
  // Hovering or tabbing to a document row preloads its frame.
  TREE.addEventListener("pointerover", prefetchFromEvent);
  TREE.addEventListener("focusin", prefetchFromEvent);

  // Re-sync indicator after folder expand/collapse animations finish
  TREE.addEventListener("transitionend", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.classList.contains("tree-folder-collapse") && activeEl) {
      updateIndicator(activeEl);
    }
  });
  TREE.closest(".sidebar-tree")?.addEventListener("scroll", () => refreshIndicator(false), { passive: true });
  window.addEventListener("resize", () => refreshIndicator(false));
  document.addEventListener("rendro:shell-layout", () => refreshIndicator(false));
  document.addEventListener("transitionend", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (
      (event.target.classList.contains("sidebar") || event.target.classList.contains("sidebar-resizer"))
      && activeEl
    ) refreshIndicator(false);
  });
  // This shell survives iframe replacement. Never recreate its gate on load.
  window.setInterval(navigationGate.observe, 100);
  const updateFragment = coalesceMessage((update: { path: string; fragment: string; loadId: number }) => {
    if (update.loadId === activeDocLoadId && update.path === RENDRO_WINDOW.RENDRO_CURRENT_DOC) {
      replaceViewerFragment(update.fragment);
    }
  });
  window.addEventListener("message", (event) => {
    // A hidden preload announcing itself is ready, and its messages are not the
    // reader's frame's. Consume them before the content-frame checks.
    if (framePreloader.ready(event.source)) return;
    const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
    if (!isContentFrameSource(event.source, frame?.contentWindow ?? null)) return;
    if (event.origin !== (frame?.hasAttribute("sandbox") ? "null" : location.origin)) return;
    if (!isDocumentMessage(event.data)) return;
    if (event.data.type === "doc-fragment") {
      if (!ORG || `${ORG}/${event.data.path}` !== RENDRO_WINDOW.RENDRO_CURRENT_DOC
        || !validFragment(event.data.fragment)) return;
      updateFragment({ path: `${ORG}/${event.data.path}`, fragment: event.data.fragment, loadId: activeDocLoadId });
    }
    if (event.data.type === "doc-navigate") {
      if (!ORG || !validRelativeDocumentPath(event.data.path)) return;
      const fragment = event.data.fragment === undefined ? "" : event.data.fragment;
      const search = event.data.search === undefined ? "" : event.data.search;
      if (!validFragment(fragment) || !validDocumentSearch(search)) return;
      const fullPath = `${ORG}/${event.data.path}`;
      const targetUrl = new URL(location.href);
      targetUrl.hash = fragment;
      const target = JSON.stringify([fullPath, search, targetUrl.hash]);
      const current = JSON.stringify([RENDRO_WINDOW.RENDRO_CURRENT_DOC, documentSearchFromLocation(), location.hash]);
      const action = navigationGate.request(target, current);
      if (action === "confirm") offerDocumentNavigation(fullPath, search, fragment);
      else if (action) loadDoc(fullPath, action, fragment, search);
    }
    if (event.data.type === "doc-external") {
      // Never navigates or opens anything by itself: the reader confirms the exact address shown.
      const href = externalLinkHref(event.data.href, location.href, location.origin);
      if (href) offerExternalLink(href);
    }
    if (event.data.type === "doc-loaded") {
      if (!ORG) return;
      const loadedPath = normalizeLoadedDocumentPath(event.data.path, ORG);
      if (loadedPath) reconcileLoadedDocument(loadedPath);
    }
  });

  // Browser back/forward
  window.addEventListener("popstate", (event) => {
    navigationGate.suspend();
    const docPath = documentPathFromHistory(event.state) || docFromPathname();
    if (docPath) loadDoc(docPath, false, location.hash, documentSearchFromLocation(), "history");
  });

  window.addEventListener("hashchange", () => {
    updateFragment.cancel();
    const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
    const current = RENDRO_WINDOW.RENDRO_CURRENT_DOC;
    if (frame && current) sendDocumentFragment(frame, relativeDocumentPath(current), location.hash);
  });

  // The shell always names the document it opens with (the entry page by default).
  const initialDoc = RENDRO_WINDOW.RENDRO_INITIAL_DOC || docFromPathname();
  if (initialDoc) {
    history.replaceState({ ...history.state, docPath: initialDoc }, "", location.href);
    loadDoc(initialDoc, false, location.hash, documentSearchFromLocation(), "cold");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
