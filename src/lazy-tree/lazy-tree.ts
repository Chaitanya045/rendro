/**
 * Lazy tree — sidebar document tree with Material Symbols icons,
 * max-height animations, active indicator, and border-line indentation.
 */
import { coalesceMessage, createDocumentNavigationGate } from "../viewer/message-limits";
import { createNavigationConfirmation, type DocumentNavigationTarget } from "../viewer/navigation-confirmation";
import { replaceViewerFragment, sendDocumentFragment, validFragment } from "../viewer/fragments";
import {
  isContentFrameSource,
  normalizeLoadedDocumentPath,
  validRelativeDocumentPath,
  validDocumentSearch,
} from "./messages";
import { documentLoadAccessibility } from "./load-state";
import { emptyTreeAction, shouldUseNativeLinkNavigation } from "./navigation";
import { folderTransitionOverride, indicatorTransition } from "./motion";

type RendroWindow = Window & { RENDRO_INITIAL_DOC?: string; RENDRO_CURRENT_DOC?: string };
const RENDRO_WINDOW = window as RendroWindow;
const TREE_HOST = document.querySelector<HTMLElement>("[data-tree-org]");
const ORG = TREE_HOST?.dataset.treeOrg;
const DOCUMENT_BASE = TREE_HOST?.dataset.documentBase ?? "";
interface TreeNode { name: string; path: string; type: "file" | "folder"; size?: number; }
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

function docUrl(fullPath: string): string {
  if (DOCUMENT_BASE) {
    const url = new URL(DOCUMENT_BASE, location.origin);
    url.searchParams.set("doc", relativeDocumentPath(fullPath));
    return `${url.pathname}${url.search}`;
  }
  return `/docs/${encodePath(fullPath)}`;
}

function documentFrameUrl(fullPath: string): string {
  return DOCUMENT_BASE
    ? `${DOCUMENT_BASE}/files/${encodePath(relativeDocumentPath(fullPath))}`
    : `/legacy-view/${encodeURIComponent(ORG ?? "")}/files/${encodePath(relativeDocumentPath(fullPath))}`;
}

function docFromPathname(): string {
  if (!ORG) return "";
  if (DOCUMENT_BASE) {
    const documentPath = new URLSearchParams(location.search).get("doc");
    return documentPath ? `${ORG}/${documentPath}` : "";
  }
  if (!location.pathname.startsWith("/docs/")) return "";
  const rawPath = location.pathname.slice("/docs/".length);
  const key = rawPath.split("/").map(decodeURIComponent).join("/");
  if (key === ORG) return "";
  return key.startsWith(`${ORG}/`) ? key : "";
}

let activeEl: HTMLElement | null = null;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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

function setFolderIcon(folder: HTMLElement, open: boolean) {
  const icon = folder.querySelector(":scope > .tree-item .folder-icon");
  if (icon) icon.textContent = open ? "folder_open" : "folder";
  folder.querySelector(":scope > .tree-item")?.setAttribute("aria-expanded", String(open));
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

const PAGE_SIZE = 50;
// A folder's first page in flight, so a second expand (a newer reveal) can wait for it.
const folderLoads = new WeakMap<HTMLElement, Promise<void>>();

async function expand(folder: HTMLElement) {
  const path = folder.dataset.path;
  if (!path) return;
  const content = folder.querySelector<HTMLElement>(":scope > .tree-folder-content");
  if (!content) return;
  content.style.transition = folderTransitionOverride(reducedMotion());

  if (folder.classList.contains("loading")) return folderLoads.get(folder);

  if (folder.classList.contains("loaded")) {
    indexChildItems(content);
    folder.classList.add("open");
    setFolderIcon(folder, true);
    if (activeEl) updateIndicator(activeEl);
    return;
  }

  folder.classList.add("loading");
  folder.setAttribute("aria-busy", "true");
  const load = (async () => {
    try {
      await loadPage(folder, path, content, undefined);
      indexChildItems(content);
      folder.classList.add("loaded", "open");
      setFolderIcon(folder, true);
      if (activeEl) updateIndicator(activeEl);
    } catch {
      content.innerHTML = `<div class="tree-error" role="alert">Failed to load folder. <button class="load-more-btn folder-retry-btn" type="button">Retry</button></div>`;
      folder.classList.add("open");
      setFolderIcon(folder, true);
    } finally {
      folder.classList.remove("loading");
      folder.removeAttribute("aria-busy");
    }
  })();
  folderLoads.set(folder, load);
  return load;
}

/** One directory page of a scoped deployment tree (#90). Folders are fetched
 * only when expanded, and only page by page. */
async function scopedPage(path: string, cursor?: string): Promise<TreePageResponse> {
  const root = `${ORG}/`;
  if (!path.startsWith(root)) return { children: [], isTruncated: false };
  const url = new URL(`${DOCUMENT_BASE}/tree`, location.origin);
  url.searchParams.set("dir", path.slice(root.length));
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(`${url.pathname}${url.search}`);
  if (!response.ok) throw new Error(`${response.status}`);
  const result = await response.json() as { children?: unknown; cursor?: unknown };
  if (!Array.isArray(result.children)) throw new Error("Invalid document tree");
  const children = result.children.map((child: unknown): TreeNode => {
    const { name, type } = (child ?? {}) as { name?: unknown; type?: unknown };
    if (typeof name !== "string" || !name || name.includes("/") || name === "." || name === ".."
      || (type !== "file" && type !== "folder")) throw new Error("Invalid document tree");
    return { name, type, path: `${path}${name}${type === "folder" ? "/" : ""}` };
  });
  const next = typeof result.cursor === "string" && result.cursor ? result.cursor : undefined;
  return { children, isTruncated: !!next, nextStartAfter: next };
}

async function loadPage(folder: HTMLElement, path: string, content: HTMLElement, startAfter?: string) {
  let data: TreePageResponse;
  if (DOCUMENT_BASE) {
    data = await scopedPage(path, startAfter);
  } else {
    const url = `/api/tree/${ORG}?prefix=${encodeURIComponent(path)}&limit=${PAGE_SIZE}${startAfter ? `&startAfter=${encodeURIComponent(startAfter)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    data = await res.json() as TreePageResponse;
  }
  // The tree container itself holds the root's later pages.
  const childDepth = folder === TREE ? 0 : parseInt(folder.dataset.depth || "0") + 1;
  const children = data.children;
  const existingPaths = new Set(
    Array.from(content.querySelectorAll<HTMLElement>("[data-path]"))
      .map((el) => el.dataset.path)
      .filter((value): value is string => Boolean(value)),
  );
  const freshChildren = children.filter((child) => {
    const childPath = child.type === "folder" && !child.path.endsWith("/") ? `${child.path}/` : child.path;
    return !existingPaths.has(childPath);
  });
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
  return folder === TREE ? TREE : folder.querySelector<HTMLElement>(":scope > .tree-folder-content");
}

function collapse(folder: HTMLElement) {
  const content = folder.querySelector<HTMLElement>(":scope > .tree-folder-content");
  if (content) content.style.transition = folderTransitionOverride(reducedMotion());
  folder.classList.remove("open");
  setFolderIcon(folder, false);
  if (activeEl) updateIndicator(activeEl);
}

// ── rendering ──

function renderFile(node: TreeNode): string {
  const fp = documentFrameUrl(node.path);
  return `<div class="tree-item flex items-center gap-2 px-3 py-1.5 rounded-lg text-on-surface-variant cursor-pointer" data-path="${esc(node.path)}">
    <span class="material-symbols-outlined text-[18px] flex-shrink-0" aria-hidden="true">article</span>
    <a href="${esc(fp)}" class="tree-link tree-label flex-1 min-w-0" target="content-frame">${esc(node.name.replace(/\.html$/, ""))}</a>
  </div>`;
}

function renderActiveIndicator(): string {
  return `<div class="active-indicator" id="active-indicator" style="opacity:0;transition:none"></div>`;
}

function renderEmptyTree(): string {
  const state = emptyTreeAction(DOCUMENT_BASE);
  return `<div class="tree-empty">${esc(state.message)}</div>${state.href && state.label
    ? `<div class="tree-empty-create"><a class="load-more-btn" href="${esc(state.href)}">${esc(state.label)}</a></div>`
    : ""}`;
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
    let data: TreePageResponse;
    if (DOCUMENT_BASE) {
      data = await scopedPage(`${ORG}/`);
    } else {
      const res = await fetch(`/api/tree/${ORG}?prefix=${encodeURIComponent(`${ORG}/`)}&limit=1000`);
      if (!res.ok) throw new Error(`${res.status}`);
      data = await res.json() as TreePageResponse;
    }
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
  const path = node.path.endsWith("/") ? node.path : `${node.path}/`;
  return `<div class="tree-folder" data-path="${esc(path)}" data-depth="${depth}">
    <div class="tree-item flex items-center gap-2 px-3 py-1.5 rounded-lg text-on-surface-variant cursor-pointer" role="button" tabindex="0" aria-expanded="false">
      <span class="material-symbols-outlined text-[18px] caret-icon flex-shrink-0" aria-hidden="true">chevron_right</span>
      <span class="material-symbols-outlined text-[18px] folder-icon flex-shrink-0" aria-hidden="true">folder</span>
      <span class="font-body-md tree-label flex-1 min-w-0">${esc(node.name)}</span>
    </div>
    <div class="tree-folder-content ml-4 space-y-0.5 border-l border-outline-variant/30 pl-2"></div>
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
    const content = folder?.querySelector<HTMLElement>(":scope > .tree-folder-content");
    if (folder && content) {
      content.replaceChildren();
      void expand(folder);
    }
    return;
  }

  // The empty tree's "Return to project" link shares the button style only.
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
const navigationConfirmation = createNavigationConfirmation();
let navigationNotice: HTMLElement | undefined;

function clearNavigationNotice() {
  navigationNotice?.remove();
  navigationNotice = undefined;
  navigationConfirmation.reset();
}

function offerDocumentNavigation(fullPath: string, search: string, fragment: string) {
  const target = navigationConfirmation.request({ fullPath, search, fragment });
  if (target) showNavigationConfirmation(target);
}

function showNavigationConfirmation({ fullPath, search, fragment }: DocumentNavigationTarget) {
  const notice = document.createElement("div");
  notice.id = "document-navigation-notice";
  notice.className = "document-navigation-notice";
  const label = document.createElement("p");
  label.id = "document-navigation-destination";
  label.setAttribute("role", "status");
  label.style.cssText = "margin:0 0 8px;overflow-wrap:anywhere;max-height:6em;overflow:auto";
  label.textContent = `Open linked document ${relativeDocumentPath(fullPath)}${search}${fragment}?`;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "load-more-btn";
  open.setAttribute("aria-describedby", label.id);
  open.textContent = "Open linked document";
  open.addEventListener("click", () => {
    loadDoc(fullPath, navigationGate.confirm(), fragment, search);
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "load-more-btn";
  dismiss.textContent = "Dismiss";
  dismiss.style.marginLeft = "12px";
  dismiss.addEventListener("click", () => {
    if (!navigationConfirmation.dismiss()) return;
    const collapsed = document.createElement("div");
    collapsed.id = "document-navigation-review";
    collapsed.className = "document-navigation-notice";
    const review = document.createElement("button");
    review.type = "button";
    review.className = "load-more-btn";
    review.textContent = "Review linked document";
    review.addEventListener("click", () => {
      const target = navigationConfirmation.reopen();
      if (!target) return;
      collapsed.remove();
      showNavigationConfirmation(target);
      // Focus moves only in response to the reader's explicit parent action.
      navigationNotice?.querySelector("button")?.focus();
    });
    collapsed.append(review);
    notice.replaceWith(collapsed);
    navigationNotice = collapsed;
    review.focus();
  });
  notice.append(label, open, dismiss);
  navigationNotice = notice;
  document.body.append(notice);
}

function loadDoc(fullPath: string, pushState: false | "push" | "replace", fragment = "", search = "") {
  clearNavigationNotice();
  const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
  const placeholder = document.getElementById("main-placeholder");
  if (placeholder) placeholder.style.display = "none";

  // Optimistic: keep production tree behavior — selected state changes immediately.
  expectedLoadedPath = fullPath;
  syncActiveState(fullPath);

  activeDocLoadId++;
  if (docLoadTimeout !== undefined) window.clearTimeout(docLoadTimeout);
  showDocLoader(frame);

  if (frame) {
    frame.onload = () => {
      window.clearTimeout(docLoadTimeout);
      hideDocLoader(frame);
      sendDocumentFragment(frame, relativeDocumentPath(fullPath), location.hash);
    };
    frame.onerror = () => {
      window.clearTimeout(docLoadTimeout);
      showDocLoadError(frame);
    };
    docLoadTimeout = window.setTimeout(() => showDocLoadError(frame), 15000);
    const frameUrl = documentFrameUrl(fullPath) + search;
    frame.src = frameUrl;
    // Keep src authoritative for comments/tickets, but replace the pending
    // frame navigation: the shell alone owns document history entries.
    frame.contentWindow?.location.replace(frameUrl);
  }

  if (pushState) {
    const url = new URL(location.href);
    if (DOCUMENT_BASE) {
      url.pathname = DOCUMENT_BASE;
      url.search = "";
      url.searchParams.set("doc", relativeDocumentPath(fullPath));
    } else {
      url.pathname = docUrl(fullPath);
      url.searchParams.delete("doc");
      url.searchParams.delete("dev_user");
    }
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
  const fullPath = `${org}/${relPath}`;
  const parts = relPath.split("/");
  let currentPath = org;
  let parent: HTMLElement = TREE;

  for (let i = 0; i < parts.length - 1; i++) {
    currentPath += "/" + parts[i];
    const folder = await pagedRow<HTMLElement>(parent, `.tree-folder[data-path="${CSS.escape(currentPath)}/"]`);
    if (!folder) break;
    if (!folder.classList.contains("open")) {
      await expand(folder);
      if (!folder.classList.contains("open")) return;
    }
    parent = folder;
  }

  const item = await pagedRow<HTMLElement>(parent, `.tree-item[data-path="${CSS.escape(fullPath)}"]`);
  if (!item || reveal !== latestReveal) return;
  document.querySelectorAll(".tree-item.active").forEach((element) => element.classList.remove("active"));
  item.classList.add("active");
  updateIndicator(item, true);
}

/** Find a row, loading later pages of only its parent folder while the row is
 * beyond the pages shown so far. A failed page leaves the row unrevealed. */
async function pagedRow<T extends HTMLElement>(parent: HTMLElement, selector: string): Promise<T | null> {
  let row = document.querySelector<T>(selector);
  for (let next = parent.dataset.nextStartAfter; !row && next; ) {
    try {
      await loadPage(parent, parent.dataset.path as string, folderContent(parent) as HTMLElement, next);
    } catch {
      return null;
    }
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

function isDocumentMessage(value: unknown): value is { type: string; path: string; search?: unknown; fragment?: unknown } {
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

function init() {
  if (!TREE) return;
  void loadRootTree();
  TREE.addEventListener("click", handleClick);
  TREE.addEventListener("keydown", handleKeydown);

  // Re-sync indicator after folder expand/collapse animations finish
  TREE.addEventListener("transitionend", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.classList.contains("tree-folder-content") && activeEl) {
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
    if (docPath) loadDoc(docPath, false, location.hash, documentSearchFromLocation());
  });

  window.addEventListener("hashchange", () => {
    updateFragment.cancel();
    const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
    const current = RENDRO_WINDOW.RENDRO_CURRENT_DOC;
    if (frame && current) sendDocumentFragment(frame, relativeDocumentPath(current), location.hash);
  });

  const initialDoc = RENDRO_WINDOW.RENDRO_INITIAL_DOC || docFromPathname();
  if (initialDoc) {
    history.replaceState({ ...history.state, docPath: initialDoc }, "", location.href);
    loadDoc(initialDoc, false, location.hash, documentSearchFromLocation());
    return;
  }
  const params = new URLSearchParams(location.search);
  const urlDoc = params.get("doc");
  if (urlDoc) {
    const url = new URL(location.href);
    url.pathname = docUrl(urlDoc);
    url.searchParams.delete("doc");
    url.searchParams.delete("dev_user");
    history.replaceState({ docPath: urlDoc }, "", url);
    loadDoc(urlDoc, false);
    return;
  }
  if (params.has("dev_user")) {
    const url = new URL(location.href);
    url.searchParams.delete("dev_user");
    history.replaceState(history.state, "", url);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
