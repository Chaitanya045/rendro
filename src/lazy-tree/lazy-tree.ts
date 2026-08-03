/**
 * Lazy tree — matches design.html spec with Material Symbols icons,
 * max-height animations, active indicator, and border-line indentation.
 */
type RendroWindow = Window & { RENDRO_INITIAL_DOC?: string; RENDRO_CURRENT_DOC?: string };
const RENDRO_WINDOW = window as RendroWindow;
const TREE_HOST = document.querySelector<HTMLElement>("[data-tree-org]");
const ORG = TREE_HOST?.dataset.treeOrg;
const PUBLICATION_BASE = TREE_HOST?.dataset.publicationBase ?? "";
interface TreeNode { name: string; path: string; type: "file" | "folder"; size?: number; }
interface TreePageResponse { children: TreeNode[]; isTruncated: boolean; nextStartAfter?: string; }
interface Publication {
  slug: string;
  sourcePrefix: string;
  title: string;
  entryFile: string;
  url: string;
}

let publications: Publication[] = [];
let publicationDialog: HTMLDialogElement | null = null;
let publicDocuments: string[] | null = null;

const TREE = document.getElementById("tree-container") as HTMLElement;

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function relativePublicPath(fullPath: string): string {
  if (!ORG || !fullPath.startsWith(`${ORG}/`)) return "";
  return fullPath.slice(ORG.length + 1);
}

function docUrl(fullPath: string): string {
  if (PUBLICATION_BASE) {
    const url = new URL(PUBLICATION_BASE, location.origin);
    url.searchParams.set("doc", relativePublicPath(fullPath));
    return `${url.pathname}${url.search}`;
  }
  return `/docs/${encodePath(fullPath)}`;
}

function documentFrameUrl(fullPath: string): string {
  return PUBLICATION_BASE
    ? `${PUBLICATION_BASE}/files/${encodePath(relativePublicPath(fullPath))}`
    : `/files/${encodePath(fullPath)}`;
}

function docFromPathname(): string {
  if (!ORG) return "";
  if (PUBLICATION_BASE) {
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
  indicator.style.transition = animate
    ? "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease"
    : "none";
  indicator.style.opacity = "1";
  indicator.style.transform = transform;
}

function refreshIndicator(animate = false) {
  if (!activeEl) return;
  requestAnimationFrame(() => {
    if (!activeEl) return;
    updateIndicator(activeEl, animate);
  });
}

// ── fold icon toggle ──

function setFolderIcon(folder: HTMLElement, open: boolean) {
  const icon = folder.querySelector(":scope > .tree-item .folder-icon") as HTMLElement | null;
  if (icon) icon.textContent = open ? "folder_open" : "folder";
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

async function expand(folder: HTMLElement) {
  const path = folder.dataset.path;
  if (!path) return;
  const content = folder.querySelector(":scope > .tree-folder-content") as HTMLElement | null;
  if (!content) return;

  if (folder.classList.contains("loading")) return;

  if (folder.classList.contains("loaded")) {
    indexChildItems(content);
    folder.classList.add("open");
    setFolderIcon(folder, true);
    if (activeEl) updateIndicator(activeEl);
    return;
  }

  folder.classList.add("loading");
  try {
    await loadPage(folder, path, content, undefined);
    indexChildItems(content);
    folder.classList.add("loaded", "open");
    setFolderIcon(folder, true);
    if (activeEl) updateIndicator(activeEl);
  } catch {
    content.innerHTML = `<div class="tree-error">Failed to load</div>`;
  } finally {
    folder.classList.remove("loading");
  }
}

async function ensurePublicDocuments(): Promise<void> {
  if (!PUBLICATION_BASE || publicDocuments) return;
  const response = await fetch(`${PUBLICATION_BASE}/tree`);
  if (!response.ok) throw new Error(`${response.status}`);
  const result = await response.json() as { documents?: unknown };
  if (!Array.isArray(result.documents) || !result.documents.every((path) => typeof path === "string")) {
    throw new Error("Invalid public document tree");
  }
  publicDocuments = result.documents;
}

function publicChildren(path: string): TreeNode[] {
  if (!ORG || !publicDocuments || !path.startsWith(`${ORG}/`)) return [];
  const relativePrefix = path.slice(ORG.length + 1);
  const children = new Map<string, TreeNode>();
  for (const documentPath of publicDocuments) {
    if (!documentPath.startsWith(relativePrefix)) continue;
    const remainder = documentPath.slice(relativePrefix.length);
    if (!remainder) continue;
    const separator = remainder.indexOf("/");
    const name = separator === -1 ? remainder : remainder.slice(0, separator);
    const type: TreeNode["type"] = separator === -1 ? "file" : "folder";
    const childPath = `${ORG}/${relativePrefix}${name}${type === "folder" ? "/" : ""}`;
    children.set(`${type}:${name}`, { name, path: childPath, type });
  }
  return Array.from(children.values()).sort((left, right) =>
    left.type === right.type ? left.name.localeCompare(right.name) : left.type === "folder" ? -1 : 1
  );
}

async function loadPage(folder: HTMLElement, path: string, content: HTMLElement, startAfter?: string) {
  let data: TreePageResponse;
  if (PUBLICATION_BASE) {
    await ensurePublicDocuments();
    data = { children: publicChildren(path), isTruncated: false };
  } else {
    const url = `/api/tree/${ORG}?prefix=${encodeURIComponent(path)}&limit=${PAGE_SIZE}${startAfter ? `&startAfter=${encodeURIComponent(startAfter)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    data = await res.json() as TreePageResponse;
  }
  const childDepth = parseInt(folder.dataset.depth || "0") + 1;
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
  content.querySelector(":scope > .tree-load-more")?.remove();
  const rows = renderRows(freshChildren, childDepth);
  content.insertAdjacentHTML("beforeend", rows);
  indexChildItems(content);
  markPublicationButtons();

  if (data.isTruncated && data.nextStartAfter) {
    folder.dataset.nextStartAfter = data.nextStartAfter;
    content.insertAdjacentHTML("beforeend",
      `<div class="tree-load-more"><button class="load-more-btn">Load more...</button></div>`);
  } else {
    delete folder.dataset.nextStartAfter;
  }

  if (activeEl) updateIndicator(activeEl);
}

function collapse(folder: HTMLElement) {
  folder.classList.remove("open");
  setFolderIcon(folder, false);
  if (activeEl) updateIndicator(activeEl);
}

// ── rendering ──

function renderFile(node: TreeNode): string {
  const fp = `/files/${node.path}`;
  return `<div class="tree-item flex items-center gap-2 px-3 py-1.5 rounded-lg text-on-surface-variant cursor-pointer" data-path="${esc(node.path)}">
    <span class="material-symbols-outlined text-[18px] flex-shrink-0">article</span>
    <a href="${esc(fp)}" class="tree-link flex-1 min-w-0" target="content-frame">${esc(node.name.replace(/\.html$/, ""))}</a>
  </div>`;
}

function renderActiveIndicator(): string {
  return `<div class="active-indicator" id="active-indicator" style="opacity:0;transition:none"></div>`;
}

function renderEmptyTree(): string {
  const org = ORG ? esc(ORG) : "";
  return `<div class="tree-empty">No documents yet.</div>
  <form method="post" action="/api/orgs" class="tree-empty-create">
    <input type="hidden" name="org" value="${org}">
    <input type="hidden" name="displayName" value="${org}">
    <button type="submit" class="load-more-btn">Create org</button>
  </form>`;
}

function publicationFor(path: string): Publication | undefined {
  return publications.find((publication) => publication.sourcePrefix === path);
}

function markPublicationButtons() {
  TREE.querySelectorAll<HTMLButtonElement>(".publication-action").forEach((button) => {
    const published = Boolean(button.dataset.publicationPath && publicationFor(button.dataset.publicationPath));
    button.classList.toggle("published", published);
    button.setAttribute("aria-pressed", String(published));
    button.title = published ? "Manage public access" : "Publish folder";
  });
}

async function refreshPublications(): Promise<void> {
  const response = await fetch("/api/publications");
  if (!response.ok) throw new Error(await response.text() || "Could not load publications");
  const result = await response.json() as { publications: Publication[] };
  publications = result.publications;
  markPublicationButtons();
}

function setPublicationMessage(message: string, isError = false) {
  const output = publicationDialog?.querySelector<HTMLElement>("#publication-message");
  if (!output) return;
  output.textContent = message;
  output.classList.toggle("error", isError);
}

function setPublicationBusy(busy: boolean) {
  publicationDialog?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((element) => {
    element.disabled = busy;
  });
}

function currentPublicationPath(): string {
  return publicationDialog?.dataset.path ?? "";
}

function showPublication(publication?: Publication) {
  const link = publicationDialog?.querySelector<HTMLAnchorElement>("#publication-link");
  const unpublish = publicationDialog?.querySelector<HTMLButtonElement>("#publication-unpublish");
  if (link) {
    link.hidden = !publication;
    link.href = publication?.url ?? "#";
  }
  if (unpublish) unpublish.hidden = !publication;
}

function defaultPublicationSlug(path: string): string {
  const name = path.replace(/\/+$/, "").split("/").at(-1) ?? "docs";
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "docs";
}

async function publishFromDialog(): Promise<void> {
  const path = currentPublicationPath();
  const slug = publicationDialog?.querySelector<HTMLInputElement>("#publication-slug");
  const title = publicationDialog?.querySelector<HTMLInputElement>("#publication-title");
  const entry = publicationDialog?.querySelector<HTMLInputElement>("#publication-entry");
  if (!path || !slug || !title || !entry) return;
  setPublicationBusy(true);
  setPublicationMessage("Publishing…");
  try {
    const response = await fetch("/api/publications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcePrefix: path,
        slug: slug.value.trim(),
        title: title.value.trim(),
        entryFile: entry.value.trim(),
      }),
    });
    if (!response.ok) throw new Error(await response.text() || "Could not publish folder");
    const publication = await response.json() as Publication;
    await refreshPublications();
    showPublication(publication);
    setPublicationMessage("Published. Future uploads inside this folder stay public.");
  } catch (error) {
    setPublicationMessage(error instanceof Error ? error.message : "Could not publish folder", true);
  } finally {
    setPublicationBusy(false);
  }
}

async function unpublishFromDialog(): Promise<void> {
  const path = currentPublicationPath();
  const publication = publicationFor(path);
  if (!publication) return;
  setPublicationBusy(true);
  setPublicationMessage("Removing public access…");
  try {
    const response = await fetch(`/api/publications/${encodeURIComponent(publication.slug)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text() || "Could not remove public access");
    await refreshPublications();
    showPublication();
    setPublicationMessage("Public access removed. The uploaded files remain private.");
  } catch (error) {
    setPublicationMessage(error instanceof Error ? error.message : "Could not remove public access", true);
  } finally {
    setPublicationBusy(false);
  }
}

function ensurePublicationDialog(): HTMLDialogElement {
  if (publicationDialog) return publicationDialog;
  publicationDialog = document.createElement("dialog");
  publicationDialog.className = "publication-dialog";
  publicationDialog.setAttribute("aria-labelledby", "publication-dialog-title");
  publicationDialog.innerHTML = `<form class="publication-form">
    <div class="publication-heading">
      <span class="material-symbols-outlined" aria-hidden="true">public</span>
      <div><p class="publication-eyebrow">Public access</p><h2 id="publication-dialog-title">Publish folder</h2></div>
    </div>
    <p class="publication-copy">Anyone with the public URL can read HTML documents inside this folder. Sibling folders stay private.</p>
    <label for="publication-title">Title</label>
    <input id="publication-title" name="title" required>
    <label for="publication-slug">Public URL slug</label>
    <div class="publication-input-prefix"><span>/public/${esc(ORG ?? "")}/</span><input id="publication-slug" name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*"></div>
    <label for="publication-entry">Landing document</label>
    <input id="publication-entry" name="entry" required placeholder="index.html">
    <p id="publication-message" class="publication-message" role="status" aria-live="polite"></p>
    <div class="publication-actions">
      <a id="publication-link" class="publication-link" target="_blank" rel="noopener" hidden>Open public docs</a>
      <button id="publication-unpublish" class="publication-unpublish" type="button" hidden>Unpublish</button>
      <span class="publication-action-spacer"></span>
      <button class="publication-cancel" type="button">Cancel</button>
      <button class="publication-submit" type="submit">Publish folder</button>
    </div>
  </form>`;
  document.body.append(publicationDialog);
  publicationDialog.querySelector(".publication-cancel")?.addEventListener("click", () => publicationDialog?.close());
  publicationDialog.querySelector(".publication-unpublish")?.addEventListener("click", () => { void unpublishFromDialog(); });
  publicationDialog.querySelector(".publication-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void publishFromDialog();
  });
  publicationDialog.addEventListener("click", (event) => {
    if (event.target === publicationDialog) publicationDialog?.close();
  });
  return publicationDialog;
}

async function openPublicationDialog(path: string, folderName: string): Promise<void> {
  const dialog = ensurePublicationDialog();
  dialog.dataset.path = path;
  const heading = dialog.querySelector<HTMLElement>("#publication-dialog-title");
  const slug = dialog.querySelector<HTMLInputElement>("#publication-slug");
  const title = dialog.querySelector<HTMLInputElement>("#publication-title");
  const entry = dialog.querySelector<HTMLInputElement>("#publication-entry");
  if (heading) heading.textContent = folderName;
  setPublicationMessage("Loading publication status…");
  showPublication();
  dialog.showModal();
  try {
    await refreshPublications();
    const publication = publicationFor(path);
    if (slug) slug.value = publication?.slug ?? defaultPublicationSlug(path);
    if (title) title.value = publication?.title ?? folderName;
    if (entry) entry.value = publication?.entryFile ?? "index.html";
    showPublication(publication);
    setPublicationMessage(publication
      ? "This folder is public. New uploads inside it appear automatically."
      : "This folder is private.");
    slug?.focus();
  } catch (error) {
    setPublicationMessage(error instanceof Error ? error.message : "Could not load publication status", true);
  }
}

function startTreeEntrance(scope: ParentNode = TREE) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  document.documentElement.classList.add("tree-entering");
  scope.querySelectorAll<HTMLElement>(".tree-item").forEach((el, i) => {
    el.style.setProperty("--tree-index", String(Math.min(i, 12)));
  });
}

async function loadRootTree() {
  if (!ORG || !TREE) return;
  TREE.dataset.loadingRoot = "true";
  try {
    let children: TreeNode[];
    if (PUBLICATION_BASE) {
      await ensurePublicDocuments();
      children = publicChildren(`${ORG}/`);
    } else {
      const res = await fetch(`/api/tree/${ORG}?prefix=${encodeURIComponent(`${ORG}/`)}&limit=1000`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json() as TreePageResponse;
      children = data.children;
    }
    TREE.innerHTML = renderActiveIndicator() + (children.length ? renderRows(children, 0) : renderEmptyTree());
    startTreeEntrance(TREE);
    if (!PUBLICATION_BASE) void refreshPublications().catch(() => undefined);
    const currentDoc = RENDRO_WINDOW.RENDRO_CURRENT_DOC || RENDRO_WINDOW.RENDRO_INITIAL_DOC || docFromPathname();
    if (currentDoc) syncActiveState(currentDoc);
  } catch {
    TREE.innerHTML = renderActiveIndicator() + `<div class="tree-error">Failed to load documents</div>`;
  } finally {
    delete TREE.dataset.loadingRoot;
  }
}

function renderFolder(node: TreeNode, depth: number): string {
  const path = node.path.endsWith("/") ? node.path : `${node.path}/`;
  const publicationAction = PUBLICATION_BASE ? "" : `<button class="publication-action" type="button" data-publication-path="${esc(path)}" aria-label="Public access for ${esc(node.name)}" aria-pressed="false" title="Publish folder"><span class="material-symbols-outlined" aria-hidden="true">public</span></button>`;
  return `<div class="tree-folder" data-path="${esc(path)}" data-depth="${depth}">
    <div class="tree-item flex items-center gap-2 px-3 py-1.5 rounded-lg text-on-surface-variant cursor-pointer">
      <span class="material-symbols-outlined text-[18px] caret-icon flex-shrink-0">chevron_right</span>
      <span class="material-symbols-outlined text-[18px] folder-icon flex-shrink-0">folder</span>
      <span class="font-body-md flex-1 min-w-0">${esc(node.name)}</span>
      ${publicationAction}
    </div>
    <div class="tree-folder-content ml-4 space-y-0.5 border-l border-outline-variant/30 pl-2"></div>
  </div>`;
}

function renderRows(nodes: TreeNode[], depth: number): string {
  return nodes.map((n) => (n.type === "folder" ? renderFolder(n, depth) : renderFile(n))).join("");
}

// ── event handling ──

function handleClick(e: Event) {
  const target = e.target as HTMLElement;
  const publicationAction = target.closest<HTMLButtonElement>(".publication-action");
  if (publicationAction) {
    e.preventDefault();
    e.stopPropagation();
    const folder = publicationAction.closest<HTMLElement>(".tree-folder");
    const path = publicationAction.dataset.publicationPath;
    const name = folder?.querySelector<HTMLElement>(":scope > .tree-item > .font-body-md")?.textContent?.trim();
    if (path && name) void openPublicationDialog(path, name);
    return;
  }

  // Load-more button
  const loadMoreBtn = target.closest(".load-more-btn") as HTMLButtonElement | null;
  if (loadMoreBtn) {
    e.preventDefault();
    const folder = loadMoreBtn.closest(".tree-folder") as HTMLElement | null;
    if (folder) {
      const path = folder.dataset.path!;
      const content = folder.querySelector(":scope > .tree-folder-content") as HTMLElement | null;
      const next = folder.dataset.nextStartAfter;
      if (path && content && next) {
        loadMoreBtn.textContent = "Loading...";
        loadMoreBtn.disabled = true;
        loadPage(folder, path, content, next);
      }
    }
    return;
  }

  const item = target.closest(".tree-item") as HTMLElement | null;
  if (!item) return;

  const folder = item.parentElement?.classList.contains("tree-folder") ? item.parentElement as HTMLElement : null;
  if (folder) {
    e.preventDefault();
    folder.classList.contains("open") ? collapse(folder) : expand(folder);
    return;
  }

  if (item.dataset.path) {
    e.preventDefault();
    loadDoc(item.dataset.path, true);
  }
}

// ── doc loading with history ──
let activeDocLoadId = 0;
let docLoadTimeout: number | undefined;
let docLoadClearTimer: number | undefined;
let docLoadStartedAt = 0;
const DOC_LOAD_MIN_VISIBLE_MS = 520;


function clearDocLoadingState() {
  document.documentElement.classList.remove("doc-loading", "doc-loading-error");
}

function showDocLoader(frame: HTMLIFrameElement | null) {
  if (docLoadClearTimer !== undefined) window.clearTimeout(docLoadClearTimer);
  docLoadStartedAt = performance.now();
  document.documentElement.classList.add("doc-loading");
  document.documentElement.classList.remove("doc-loading-error");
  if (frame) frame.style.display = "block";
}

function showDocLoadError() {
  if (docLoadClearTimer !== undefined) window.clearTimeout(docLoadClearTimer);
  document.documentElement.classList.remove("doc-loading");
  document.documentElement.classList.add("doc-loading-error");
}

function hideDocLoader(frame: HTMLIFrameElement | null, loadId: number) {
  const remaining = Math.max(0, DOC_LOAD_MIN_VISIBLE_MS - (performance.now() - docLoadStartedAt));
  const clear = () => {
    if (loadId === activeDocLoadId) clearDocLoadingState();
  };
  if (remaining > 0) {
    docLoadClearTimer = window.setTimeout(clear, remaining);
  } else {
    clear();
  }
  if (frame) frame.style.display = "block";
}

function loadDoc(fullPath: string, pushState: boolean) {
  const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
  const placeholder = document.getElementById("main-placeholder");
  if (placeholder) placeholder.style.display = "none";

  // Optimistic: keep production tree behavior — selected state changes immediately.
  syncActiveState(fullPath);

  const loadId = ++activeDocLoadId;
  if (docLoadTimeout !== undefined) window.clearTimeout(docLoadTimeout);
  showDocLoader(frame);

  if (frame) {
    frame.onload = () => {
      if (loadId !== activeDocLoadId) return;
      if (docLoadTimeout !== undefined) window.clearTimeout(docLoadTimeout);
      hideDocLoader(frame, loadId);
    };
    frame.onerror = () => {
      if (loadId !== activeDocLoadId) return;
      if (docLoadTimeout !== undefined) window.clearTimeout(docLoadTimeout);
      showDocLoadError();
    };
    docLoadTimeout = window.setTimeout(() => {
      if (loadId === activeDocLoadId) showDocLoadError();
    }, 15000);
    frame.src = documentFrameUrl(fullPath);
  }

  if (pushState) {
    const url = new URL(location.href);
    if (PUBLICATION_BASE) {
      url.pathname = PUBLICATION_BASE;
      url.search = "";
      url.searchParams.set("doc", relativePublicPath(fullPath));
    } else {
      url.pathname = docUrl(fullPath);
      url.searchParams.delete("doc");
      url.searchParams.delete("dev_user");
    }
    history.pushState({ docPath: fullPath }, "", url);
  }
}

async function navigateToDoc(relPath: string) {
  const fullPath = `${ORG}/${relPath}`;
  const parts = relPath.split("/");
  let currentPath = ORG!;

  // Expand each ancestor level iteratively — re-query DOM after each expansion
  for (let i = 0; i < parts.length - 1; i++) {
    currentPath += "/" + parts[i];
    const folder = document.querySelector(`.tree-folder[data-path="${CSS.escape(currentPath)}/"]`) as HTMLElement | null;
    if (!folder) break; // can't go deeper if parent doesn't exist yet
    if (!folder.classList.contains("open")) {
      await expand(folder);
      await new Promise<void>((resolve) => {
        const check = () => {
          if (folder.classList.contains("open")) resolve();
          else setTimeout(check, 50);
        };
        check();
      });
    }
  }

  // Now activate the item
  const item = document.querySelector(`.tree-item[data-path="${CSS.escape(fullPath)}"]`) as HTMLElement | null;
  if (!item) return;
  document.querySelectorAll(".tree-item.active").forEach((el) => el.classList.remove("active"));
  item.classList.add("active");
  updateIndicator(item, true);
}

// Sync tree active state without reloading iframe (for doc-loaded messages)
function syncActiveState(fullPath: string) {
  RENDRO_WINDOW.RENDRO_CURRENT_DOC = fullPath;
  // Always expand ancestors first (no-op if already open)
  const relPath = fullPath.startsWith(`${ORG}/`) ? fullPath.slice(ORG!.length + 1) : fullPath;
  navigateToDoc(relPath);
}

function init() {
  if (!TREE) return;
  void loadRootTree();
  TREE.addEventListener("click", handleClick);

  // Re-sync indicator after folder expand/collapse animations finish
  TREE.addEventListener("transitionend", (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("tree-folder-content") && activeEl) {
      updateIndicator(activeEl);
    }
  });
  TREE.closest(".sidebar-tree")?.addEventListener("scroll", () => refreshIndicator(false), { passive: true });
  window.addEventListener("resize", () => refreshIndicator(false));
  document.addEventListener("rendro:shell-layout", () => refreshIndicator(false));
  document.addEventListener("transitionend", (e) => {
    const target = e.target as HTMLElement;
    if ((target.classList.contains("sidebar") || target.classList.contains("sidebar-resizer")) && activeEl) {
      refreshIndicator(false);
    }
  });
  window.addEventListener("message", (e) => {
    if (!e.data || typeof e.data.path !== "string") return;
    const { type, path } = e.data as { type: string; path: string };
    if (type === "doc-navigate") {
      // path is relative (e.g., "onboarding/welcome.html") — load with full path
      loadDoc(`${ORG}/${path}`, true);
    }
    if (type === "doc-loaded") {
      // path is full (e.g., "gmail/index.html") — just sync tree state, don't reload iframe
      syncActiveState(path);
    }
  });

  // Browser back/forward
  window.addEventListener("popstate", (e) => {
    const docPath = e.state?.docPath || docFromPathname();
    if (docPath) loadDoc(docPath, false);
  });

  const initialDoc = RENDRO_WINDOW.RENDRO_INITIAL_DOC || docFromPathname();
  if (initialDoc) {
    loadDoc(initialDoc, false);
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
